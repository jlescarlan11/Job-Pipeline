import {
  compareRankingPriority,
  mergeOutcomeEvents,
  normalizeLegacyRecord,
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
  messageSafetyContext
) {
  const activeUpdates = [];
  const archiveUpdates = [];
  const invalidActions = [];

  for (const [location, rows] of [
    ["active", activeRows],
    ["archive", archiveRows]
  ]) {
    for (const raw of rows) {
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
        invalidActions.push({
          location,
          row_number: raw.row_number,
          canonical_job_id: record.canonical_job_id,
          manual_action: supportedAction ? record.manual_action : "[unsupported]",
          error: supportedAction ? result.error : "unsupported manual action"
        });
        continue;
      }
      if (!result.changed) continue;
      const update = {
        ...result.record,
        state_guard: stateGuard(result.record),
        row_number: raw.row_number
      };
      if (location === "active") activeUpdates.push(update);
      else archiveUpdates.push(update);
    }
  }

  return {
    active_updates: activeUpdates,
    archive_updates: archiveUpdates,
    invalid_actions: invalidActions
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
