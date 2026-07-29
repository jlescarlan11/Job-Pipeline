import {
  compareRankingPriority,
  mergeOutcomeEvents,
  normalizeLegacyRecord,
  rankingPriorityValue,
  stateGuard,
  validateRecordContract
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";

const OUTCOME_ACTIONS = {
  outcome_no_response: "no_response",
  outcome_replied: "replied",
  outcome_interview: "interview",
  outcome_offer: "offer",
  outcome_rejected: "rejected"
};

const REVIEW_QUEUE_VISIBLE_COLUMNS = [
  "Status",
  "Job title",
  "Company",
  "Score",
  "Reason for review",
  "Generated message",
  "Job link",
  "Action"
];

const REVIEW_QUEUE_HIDDEN_COLUMNS = [
  "canonical_job_id",
  "source_state_guard"
];

function safeReviewText(value, maximum = 500) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(
      /(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function formulaSafeReviewCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function reviewQueueConfiguration(reviewConfig) {
  return reviewConfig?.review_queue || reviewConfig || {};
}

export function validateReviewQueueConfig(reviewConfig, schema) {
  const queue = reviewQueueConfiguration(reviewConfig);
  const errors = [];
  if (!queue || typeof queue !== "object" || Array.isArray(queue)) {
    return ["review_queue must be an object"];
  }
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(queue.version || "")) {
    errors.push("review_queue.version must use YYYY-MM-DD/vN");
  }
  if (queue.sheet !== "Review Queue") {
    errors.push("review_queue.sheet must be Review Queue");
  }
  if (
    JSON.stringify(queue.visible_columns) !==
    JSON.stringify(REVIEW_QUEUE_VISIBLE_COLUMNS)
  ) {
    errors.push("review_queue.visible_columns must match the review contract");
  }
  if (
    JSON.stringify(queue.hidden_columns) !==
    JSON.stringify(REVIEW_QUEUE_HIDDEN_COLUMNS)
  ) {
    errors.push("review_queue.hidden_columns must match the helper contract");
  }
  const expectedFields = [
    ...REVIEW_QUEUE_VISIBLE_COLUMNS,
    ...REVIEW_QUEUE_HIDDEN_COLUMNS
  ];
  if (JSON.stringify(queue.fields) !== JSON.stringify(expectedFields)) {
    errors.push("review_queue.fields must contain visible then hidden columns");
  }
  const expectedActions = {
    "Generate Application": "promote",
    "I Applied": "mark_applied",
    Skip: "mark_skipped"
  };
  if (JSON.stringify(queue.actions) !== JSON.stringify(expectedActions)) {
    errors.push("review_queue.actions must match the friendly action contract");
  }
  if (
    !Array.isArray(queue.statuses) ||
    queue.statuses.length === 0 ||
    queue.statuses.some(
      (status, index, all) =>
        !schema?.pipeline_statuses?.includes(status) ||
        all.indexOf(status) !== index
    )
  ) {
    errors.push("review_queue.statuses must be unique supported statuses");
  }
  for (const command of Object.values(queue.actions || {})) {
    if (!schema?.manual_actions?.includes(command)) {
      errors.push(`review_queue action is unsupported: ${command}`);
    }
  }
  if (
    !Number.isInteger(queue.reason_maximum_length) ||
    queue.reason_maximum_length < 1 ||
    queue.reason_maximum_length > 2000
  ) {
    errors.push("review_queue.reason_maximum_length must be from 1 to 2000");
  }
  return errors;
}

function reviewEvidenceText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value)) {
    return String(value);
  }
  return (
    value.text ||
    value.summary ||
    value.requirement ||
    value.reason ||
    value.classification ||
    ""
  );
}

function reviewEvidenceList(values, maximumItems = 3) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return [
    ...new Set(
      list
        .map(reviewEvidenceText)
        .map((value) => safeReviewText(value, 160))
        .filter(Boolean)
    )
  ]
    .slice(0, maximumItems)
    .join("; ");
}

export function reasonForReview(record, reviewConfig) {
  const queue = reviewQueueConfiguration(reviewConfig);
  const maximum = queue.reason_maximum_length || 500;
  const parts = [];
  const warnings = reviewEvidenceList(record.application_warnings);
  const gapDetails = reviewEvidenceList(record.requirement_gap_details);
  const gaps = reviewEvidenceList(record.requirement_gaps);
  const matchReasons = reviewEvidenceList(record.match_reasons);
  const error = safeReviewText(record.error_summary, 180);

  if (warnings) parts.push(`Warnings: ${warnings}`);
  if (gapDetails || gaps) {
    parts.push(`Needs attention: ${gapDetails || gaps}`);
  }
  if (matchReasons) parts.push(`Evidence: ${matchReasons}`);
  if (error) parts.push(`Recovery context: ${error}`);

  if (parts.length === 0) {
    if (record.pipeline_status === "review_required") {
      parts.push("Review required; no review reason was recorded.");
    } else if (record.pipeline_status === "recommended") {
      parts.push("Recommended; application generation is pending.");
    } else if (record.pipeline_status === "ready") {
      parts.push("Application message is ready for manual review.");
    }
  }
  return safeReviewText(parts.join(" | "), maximum);
}

function reviewQueueRow(record, reviewConfig) {
  const priority = rankingPriorityValue(record);
  return {
    Status: record.pipeline_status,
    "Job title": formulaSafeReviewCell(record.job_title),
    Company: formulaSafeReviewCell(record.company),
    Score: priority.source === "missing" ? "" : priority.value,
    "Reason for review": reasonForReview(record, reviewConfig),
    "Generated message": formulaSafeReviewCell(record.generated_message),
    "Job link": formulaSafeReviewCell(record.canonical_url),
    Action: "",
    canonical_job_id: record.canonical_job_id,
    source_state_guard: record.state_guard || stateGuard(record)
  };
}

export function buildReviewQueueProjection(
  rows,
  schema,
  reviewConfig,
  now = new Date().toISOString()
) {
  const configErrors = validateReviewQueueConfig(reviewConfig, schema);
  if (configErrors.length > 0) {
    throw new Error(`Invalid review queue configuration: ${configErrors.join("; ")}`);
  }
  const queue = reviewQueueConfiguration(reviewConfig);
  const records = rows
    .map((row) => normalizeLegacyRecord(row, schema, now))
    .filter((record) => queue.statuses.includes(record.pipeline_status));
  const identityCounts = new Map();
  for (const record of records) {
    const identity = String(record.canonical_job_id || "").trim();
    if (identity) {
      identityCounts.set(identity, (identityCounts.get(identity) || 0) + 1);
    }
  }
  const invalidRecords = [];
  const valid = records.filter((record) => {
    const identity = String(record.canonical_job_id || "").trim();
    if (!identity) {
      invalidRecords.push({
        canonical_job_id: "",
        error: "eligible review record is missing canonical identity"
      });
      return false;
    }
    if (identityCounts.get(identity) !== 1) {
      invalidRecords.push({
        canonical_job_id: identity,
        error: "eligible review record has duplicate canonical identity"
      });
      return false;
    }
    return true;
  });
  valid.sort((left, right) => {
    const priority = recordPriority(right) - recordPriority(left);
    if (priority !== 0) return priority;
    return compareRankingPriority(left, right);
  });
  return {
    rows: valid.map((record) => reviewQueueRow(record, reviewConfig)),
    invalid_records: invalidRecords
  };
}

function reviewCommitGuard(record, action, executionId, now) {
  const source = [
    executionId,
    record.canonical_job_id,
    record.state_guard || stateGuard(record),
    action,
    now
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const execution = safeReviewText(executionId, 48).replace(/[^a-z0-9._-]/gi, "_");
  return `commit:review:${execution || "manual"}:${(hash >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function clearProcessing(record) {
  return {
    ...record,
    processing_stage: "",
    processing_token: "",
    processing_commit_guard: "",
    processing_started_at: ""
  };
}

function validationSummary(errors) {
  return errors
    .map((error) => String(error).replace(/:\s.*$/, ""))
    .slice(0, 5)
    .join("; ");
}

function changed(record, schema, original = record) {
  const errors = validateRecordContract(record, schema);
  if (errors.length > 0) {
    return {
      changed: false,
      valid: false,
      record: original,
      error: `review input validation failed: ${validationSummary(errors)}`
    };
  }
  return {
    changed: true,
    valid: true,
    record: { ...record, state_guard: stateGuard(record) }
  };
}

function firstReview(record, now) {
  return {
    ...record,
    first_reviewed_at: record.first_reviewed_at || now
  };
}

function postingAgeDays(postedAt, appliedAt) {
  const postedMs = Date.parse(postedAt || "");
  const appliedMs = Date.parse(appliedAt || "");
  if (
    !Number.isFinite(postedMs) ||
    !Number.isFinite(appliedMs) ||
    postedMs > appliedMs
  ) {
    return "";
  }
  return Math.round(((appliedMs - postedMs) / 86_400_000) * 1_000_000) / 1_000_000;
}

function normalizeApplicationInputs(record, schema) {
  const pointsRaw = record.apply_points_input;
  const pointsMissing =
    pointsRaw === "" || pointsRaw === undefined || pointsRaw === null;
  const points = pointsMissing ? "" : Number(pointsRaw);
  const pointsRule = schema.field_rules?.apply_points_input;
  if (
    !pointsMissing &&
    (!Number.isInteger(points) ||
      points < pointsRule.minimum ||
      points > pointsRule.maximum)
  ) {
    return {
      valid: false,
      error: `apply_points_input must be an integer from ${pointsRule.minimum} to ${pointsRule.maximum}`
    };
  }

  const strategy = String(
    record.application_message_strategy_input || ""
  ).trim();
  const strategyRule =
    schema.field_rules?.application_message_strategy_input;
  if (
    strategy &&
    (strategy.length > strategyRule.maximum_length ||
      !new RegExp(strategyRule.pattern).test(strategy))
  ) {
    return {
      valid: false,
      error:
        "application_message_strategy_input must be a bounded versioned identifier"
    };
  }
  return { valid: true, points, strategy };
}

function snapshotApplication(record, now, inputs) {
  if (record.application_snapshot_at) return record;
  return {
    ...record,
    apply_points_used: inputs.points,
    application_message_strategy: inputs.strategy,
    application_qualification_score:
      record.qualification_score === undefined
        ? ""
        : record.qualification_score,
    application_opportunity_score:
      record.opportunity_score === undefined ? "" : record.opportunity_score,
    application_ranking_confidence: record.ranking_confidence || "",
    application_scoring_policy_version: record.scoring_policy_version || "",
    application_apply_points_recommendation:
      record.apply_points_recommendation || "",
    application_pack_status_at_apply: record.application_pack_status || "",
    application_posting_age_days: postingAgeDays(record.posted_at, now),
    application_snapshot_at: now
  };
}

function eventId(record, type, now, previousOutcome) {
  const source = [
    record.canonical_job_id,
    type,
    now,
    previousOutcome,
    record.outcome_events?.length || 0
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `outcome-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function appendOutcome(record, type, now, correctedOutcome) {
  const event = {
    id: eventId(record, type, now, record.outcome || ""),
    type,
    at: now,
    previous_outcome: record.outcome || ""
  };
  if (type === "correction") event.corrected_outcome = correctedOutcome;
  return mergeOutcomeEvents(record.outcome_events, [event]);
}

function duplicateDecision(record, decision) {
  return (
    record.application_decision === decision &&
    (record.pipeline_status === decision ||
      (record.pipeline_status === "archived" &&
        record.archived_from_status === decision))
  );
}

export function applyManualAction(
  record,
  schema,
  now = new Date().toISOString(),
  messageSafetyContext
) {
  const action = String(record.manual_action || "").trim();
  if (!action) return { changed: false, valid: true, record };
  if (!schema.manual_actions.includes(action)) {
    return { changed: false, valid: false, record, error: `unsupported manual action: ${action}` };
  }

  if (action === "mark_reviewed") {
    return changed(
      {
        ...firstReview(record, now),
        manual_action: "",
        updated_at: now
      },
      schema,
      record
    );
  }

  if (action === "promote") {
    if (!["review_required", "unscorable"].includes(record.pipeline_status)) {
      return { changed: false, valid: false, record, error: `promote is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(firstReview(record, now)),
      pipeline_status: "recommended",
      match_decision: "recommended",
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  if (action === "regenerate") {
    if (record.pipeline_status !== "ready") {
      return { changed: false, valid: false, record, error: `regenerate is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(firstReview(record, now)),
      pipeline_status: "recommended",
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  if (action === "mark_applied") {
    if (duplicateDecision(record, "applied")) {
      return changed(
        {
          ...record,
          apply_points_input: "",
          application_message_strategy_input: "",
          manual_action: "",
          updated_at: now
        },
        schema,
        record
      );
    }
    if (record.pipeline_status !== "ready") {
      return { changed: false, valid: false, record, error: `mark_applied is invalid from ${record.pipeline_status}` };
    }
    const messageSafety = evaluatePersistedMessageSafety(
      record,
      messageSafetyContext
    );
    if (!messageSafety.safe) {
      return {
        changed: false,
        valid: false,
        record,
        error: `message_quarantined: ${messageSafety.reasons.join(",")}`
      };
    }
    const inputs = normalizeApplicationInputs(record, schema);
    if (!inputs.valid) {
      return { changed: false, valid: false, record, error: inputs.error };
    }
    const applied = snapshotApplication(firstReview(record, now), now, inputs);
    return changed({
      ...clearProcessing(applied),
      pipeline_status: "applied",
      application_decision: "applied",
      application_decided_at: now,
      apply_points_input: "",
      application_message_strategy_input: "",
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  if (action === "mark_skipped") {
    if (duplicateDecision(record, "skipped")) {
      return changed(
        {
          ...record,
          apply_points_input: "",
          application_message_strategy_input: "",
          manual_action: "",
          updated_at: now
        },
        schema,
        record
      );
    }
    if (!["ready", "recommended", "review_required", "unscorable"].includes(record.pipeline_status)) {
      return { changed: false, valid: false, record, error: `mark_skipped is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(firstReview(record, now)),
      pipeline_status: "skipped",
      application_decision: "skipped",
      application_decided_at: now,
      apply_points_input: "",
      application_message_strategy_input: "",
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  if (action === "retry") {
    if (!["retryable_error", "terminal_error", "unavailable"].includes(record.pipeline_status)) {
      return { changed: false, valid: false, record, error: `retry is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(record),
      pipeline_status: "retryable_error",
      attempt_count: 0,
      next_retry_at: now,
      error_category: "",
      error_summary: "",
      failed_stage: record.failed_stage || "evaluation",
      source_availability:
        record.pipeline_status === "unavailable" ? "unknown" : record.source_availability,
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  if (action === "clear_outcome") {
    if (record.application_decision !== "applied") {
      return { changed: false, valid: false, record, error: "outcomes require an applied decision" };
    }
    if (!Array.isArray(record.outcome_events)) {
      return {
        changed: false,
        valid: false,
        record,
        error: "outcome history is malformed and requires manual repair"
      };
    }
    if (!record.outcome) {
      return changed(
        {
          ...record,
          manual_action: "",
          updated_at: now
        },
        schema,
        record
      );
    }
    return changed({
      ...record,
      outcome: "",
      outcome_at: now,
      outcome_events: appendOutcome(record, "correction", now, ""),
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  const outcome = OUTCOME_ACTIONS[action];
  if (outcome) {
    if (record.application_decision !== "applied") {
      return { changed: false, valid: false, record, error: "outcomes require an applied decision" };
    }
    if (!Array.isArray(record.outcome_events)) {
      return {
        changed: false,
        valid: false,
        record,
        error: "outcome history is malformed and requires manual repair"
      };
    }
    if (record.outcome === outcome) {
      return changed(
        {
          ...record,
          manual_action: "",
          updated_at: now
        },
        schema,
        record
      );
    }
    return changed({
      ...record,
      outcome,
      outcome_at: now,
      outcome_events: appendOutcome(record, outcome, now),
      manual_action: "",
      updated_at: now
    }, schema, record);
  }

  return { changed: false, valid: false, record, error: `unhandled manual action: ${action}` };
}

export function processReviewActions(
  activeRows,
  archiveRows,
  schema,
  now = new Date().toISOString(),
  messageSafetyContext,
  queueContext = {}
) {
  const activeUpdates = [];
  const activeClaims = [];
  const archiveUpdates = [];
  const invalidActions = [];
  const processedQueueActions = [];
  const executionId = String(queueContext.executionId || "");
  const queueRows = Array.isArray(queueContext.queueRows)
    ? queueContext.queueRows
    : [];
  const queueConfig = reviewQueueConfiguration(queueContext.reviewConfig);
  const configuredActions = queueConfig.actions || {};
  const queueActionsById = new Map();

  const invalidAction = ({
    location,
    raw,
    canonicalJobId,
    manualAction,
    error
  }) => {
    invalidActions.push({
      location,
      row_number: raw?.row_number,
      canonical_job_id: canonicalJobId || "",
      manual_action: manualAction || "[unsupported]",
      error
    });
  };

  for (const raw of queueRows) {
    const label = String(raw?.Action || "").trim();
    if (!label) continue;
    const canonicalJobId = String(raw?.canonical_job_id || "").trim();
    const command = configuredActions[label];
    if (!canonicalJobId) {
      invalidAction({
        location: "review_queue",
        raw,
        manualAction: command,
        error: "review queue action is missing canonical identity"
      });
      continue;
    }
    if (!command) {
      invalidAction({
        location: "review_queue",
        raw,
        canonicalJobId,
        error: "unsupported review queue action"
      });
      continue;
    }
    const entries = queueActionsById.get(canonicalJobId) || [];
    entries.push({
      raw,
      canonical_job_id: canonicalJobId,
      source_state_guard: String(raw.source_state_guard || "").trim(),
      command
    });
    queueActionsById.set(canonicalJobId, entries);
  }

  const active = activeRows.map((raw) => ({
    raw,
    record: normalizeLegacyRecord(raw, schema, now)
  }));
  const activeIdentityCounts = new Map();
  for (const { record } of active) {
    const identity = String(record.canonical_job_id || "").trim();
    if (identity) {
      activeIdentityCounts.set(
        identity,
        (activeIdentityCounts.get(identity) || 0) + 1
      );
    }
  }
  const consumedQueueIdentities = new Set();

  for (const { raw, record } of active) {
    const identity = String(record.canonical_job_id || "").trim();
    const directAction = String(record.manual_action || "").trim();
    const queueEntries = identity
      ? queueActionsById.get(identity) || []
      : [];

    if (identity && activeIdentityCounts.get(identity) > 1) {
      if (directAction) {
        invalidAction({
          location: "active",
          raw,
          canonicalJobId: identity,
          manualAction: schema.manual_actions.includes(directAction)
            ? directAction
            : undefined,
          error: "active review action has duplicate canonical identity"
        });
      }
      if (queueEntries.length > 0 && !consumedQueueIdentities.has(identity)) {
        for (const entry of queueEntries) {
          invalidAction({
            location: "review_queue",
            raw: entry.raw,
            canonicalJobId: identity,
            manualAction: entry.command,
            error: "review queue action has duplicate source identity"
          });
        }
        consumedQueueIdentities.add(identity);
      }
      continue;
    }

    let queueAction = "";
    if (queueEntries.length > 0) {
      consumedQueueIdentities.add(identity);
      const commands = new Set(queueEntries.map((entry) => entry.command));
      const guards = new Set(
        queueEntries.map((entry) => entry.source_state_guard)
      );
      if (commands.size !== 1 || guards.size !== 1) {
        for (const entry of queueEntries) {
          invalidAction({
            location: "review_queue",
            raw: entry.raw,
            canonicalJobId: identity,
            manualAction: entry.command,
            error: "conflicting review queue actions"
          });
        }
      } else {
        const sourceGuard = [...guards][0];
        const currentGuard = String(record.state_guard || stateGuard(record));
        if (!sourceGuard || sourceGuard !== currentGuard) {
          for (const entry of queueEntries) {
            invalidAction({
              location: "review_queue",
              raw: entry.raw,
              canonicalJobId: identity,
              manualAction: entry.command,
              error: "stale review queue action"
            });
          }
        } else {
          queueAction = [...commands][0];
        }
      }
    }

    if (directAction && queueAction && directAction !== queueAction) {
      for (const entry of queueEntries) {
        invalidAction({
          location: "review_queue",
          raw: entry.raw,
          canonicalJobId: identity,
          manualAction: entry.command,
          error: "review queue action conflicts with Sheet1 action"
        });
      }
      queueAction = "";
    }

    const selectedAction = directAction || queueAction;
    if (!selectedAction) continue;
    if (!identity) {
      invalidAction({
        location: "active",
        raw,
        manualAction: schema.manual_actions.includes(selectedAction)
          ? selectedAction
          : undefined,
        error: "active review action is missing canonical identity"
      });
      continue;
    }

    const result = applyManualAction(
      { ...record, manual_action: selectedAction },
      schema,
      now,
      messageSafetyContext
    );
    if (!result.valid) {
      const supportedAction = schema.manual_actions.includes(selectedAction);
      invalidAction({
        location: directAction ? "active" : "review_queue",
        raw: directAction ? raw : queueEntries[0]?.raw,
        canonicalJobId: identity,
        manualAction: supportedAction ? selectedAction : undefined,
        error: supportedAction ? result.error : "unsupported manual action"
      });
      if (directAction && queueAction) {
        for (const entry of queueEntries) {
          invalidAction({
            location: "review_queue",
            raw: entry.raw,
            canonicalJobId: identity,
            manualAction: entry.command,
            error: result.error
          });
        }
      }
      continue;
    }
    if (!result.changed) continue;

    const sourceGuard = String(record.state_guard || stateGuard(record));
    const commitGuard = reviewCommitGuard(
      record,
      selectedAction,
      executionId,
      now
    );
    activeClaims.push({
      canonical_job_id: identity,
      state_guard: sourceGuard,
      processing_commit_guard: commitGuard
    });
    activeUpdates.push({
      ...result.record,
      state_guard: stateGuard(result.record),
      processing_commit_guard: commitGuard,
      row_number: raw.row_number
    });
    if (queueAction) {
      processedQueueActions.push({
        canonical_job_id: identity,
        manual_action: queueAction,
        source_state_guard: sourceGuard,
        processing_commit_guard: commitGuard,
        duplicate_count: queueEntries.length
      });
    }
  }

  for (const [identity, entries] of queueActionsById) {
    if (consumedQueueIdentities.has(identity)) continue;
    for (const entry of entries) {
      invalidAction({
        location: "review_queue",
        raw: entry.raw,
        canonicalJobId: identity,
        manualAction: entry.command,
        error: "review queue source record is missing"
      });
    }
  }

  for (const raw of archiveRows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    if (!record.manual_action) continue;
    const result = applyManualAction(
      record,
      schema,
      now,
      messageSafetyContext
    );
    if (!result.valid) {
      const supportedAction = schema.manual_actions.includes(record.manual_action);
      invalidAction({
        location: "archive",
        raw,
        canonicalJobId: record.canonical_job_id,
        manualAction: supportedAction ? record.manual_action : undefined,
        error: supportedAction ? result.error : "unsupported manual action"
      });
      continue;
    }
    if (!result.changed) continue;
    archiveUpdates.push({
      ...result.record,
      state_guard: stateGuard(result.record),
      row_number: raw.row_number
    });
  }

  return {
    active_claims: activeClaims,
    active_updates: activeUpdates,
    archive_updates: archiveUpdates,
    invalid_actions: invalidActions,
    processed_queue_actions: processedQueueActions
  };
}

function queueSnapshotKey(row) {
  return [
    row?.row_number,
    String(row?.canonical_job_id || "").trim(),
    String(row?.source_state_guard || "").trim(),
    String(row?.Action || "").trim()
  ].join("\u001f");
}

export function reconcileReviewQueue(
  activeRows,
  currentQueueRows,
  initialQueueRows,
  schema,
  reviewConfig,
  now = new Date().toISOString()
) {
  const projection = buildReviewQueueProjection(
    activeRows,
    schema,
    reviewConfig,
    now
  );
  const initialActions = new Set(
    initialQueueRows
      .filter((row) => String(row?.Action || "").trim())
      .map(queueSnapshotKey)
  );
  const currentSourceGuards = new Map(
    activeRows
      .map((row) => normalizeLegacyRecord(row, schema, now))
      .map((record) => [
        String(record.canonical_job_id || "").trim(),
        String(record.state_guard || stateGuard(record))
      ])
      .filter(([identity]) => identity)
  );
  const protectedRows = new Set();
  const protectedIdentities = new Set();
  for (const row of currentQueueRows) {
    const action = String(row?.Action || "").trim();
    if (!action) continue;
    const identity = String(row.canonical_job_id || "").trim();
    const sourceGuard = String(row.source_state_guard || "").trim();
    const actionAppearedAfterRead = !initialActions.has(queueSnapshotKey(row));
    const sourceWriteIsUnconfirmed =
      identity &&
      sourceGuard &&
      currentSourceGuards.get(identity) === sourceGuard;
    if (!actionAppearedAfterRead && !sourceWriteIsUnconfirmed) continue;
    const rowNumber = Number(row.row_number);
    if (Number.isInteger(rowNumber) && rowNumber > 1) {
      protectedRows.add(rowNumber);
    }
    if (identity) protectedIdentities.add(identity);
  }
  const deleteRows = currentQueueRows
    .map((row) => Number(row?.row_number))
    .filter(
      (rowNumber) =>
        Number.isInteger(rowNumber) &&
        rowNumber > 1 &&
        !protectedRows.has(rowNumber)
    )
    .sort((left, right) => right - left)
    .map((rowNumber) => ({ row_number: rowNumber }));
  return {
    queue_rows: projection.rows.filter(
      (row) => !protectedIdentities.has(row.canonical_job_id)
    ),
    delete_rows: deleteRows,
    protected_action_count: protectedRows.size,
    invalid_records: projection.invalid_records
  };
}

function recordPriority(record) {
  const statusPriority = {
    ready: 4,
    recommended: 3,
    review_required: 2,
    retryable_error: 1
  };
  return statusPriority[record.pipeline_status] ?? 0;
}

export function buildReviewQueue(rows, schema, now = new Date().toISOString()) {
  return rows
    .map((row) => normalizeLegacyRecord(row, schema, now))
    .filter((record) =>
      ["ready", "recommended", "review_required", "retryable_error", "unscorable", "unavailable"].includes(
        record.pipeline_status
      )
    )
    .sort((left, right) => {
      const priority = recordPriority(right) - recordPriority(left);
      if (priority !== 0) return priority;
      return compareRankingPriority(left, right);
    });
}

export function buildFunnelSummary(activeRows, archiveRows, schema, now = new Date().toISOString()) {
  const recordsById = new Map();
  for (const raw of [...activeRows, ...archiveRows]) {
    const record = normalizeLegacyRecord(raw, schema, now);
    if (!record.canonical_job_id) continue;
    const current = recordsById.get(record.canonical_job_id);
    if (!current || record.pipeline_status === "archived") {
      recordsById.set(record.canonical_job_id, record);
    }
  }
  const records = [...recordsById.values()];
  const count = (predicate) => records.filter(predicate).length;
  return {
    metric_key: "current",
    generated_at: now,
    total_unique_jobs: records.length,
    discovered: count((record) => record.pipeline_status === "discovered"),
    recommended: count(
      (record) =>
        record.match_decision === "recommended" ||
        ["recommended", "ready", "applied"].includes(record.archived_from_status || record.pipeline_status)
    ),
    review_required: count((record) => record.pipeline_status === "review_required"),
    ready: count(
      (record) =>
        Boolean(record.generated_message) ||
        ["ready", "applied"].includes(record.archived_from_status || record.pipeline_status)
    ),
    applied: count((record) => record.application_decision === "applied"),
    skipped: count((record) => record.application_decision === "skipped"),
    replied: count((record) => record.outcome === "replied"),
    interview: count((record) => record.outcome === "interview"),
    offer: count((record) => record.outcome === "offer"),
    rejected: count((record) => record.outcome === "rejected"),
    retryable_error: count((record) => record.pipeline_status === "retryable_error"),
    terminal_error: count(
      (record) =>
        record.pipeline_status === "terminal_error" ||
        record.archived_from_status === "terminal_error"
    ),
    unavailable: count(
      (record) =>
        record.pipeline_status === "unavailable" ||
        record.archived_from_status === "unavailable"
    )
  };
}
