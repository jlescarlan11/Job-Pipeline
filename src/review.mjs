import {
  compareRankingPriority,
  mergeOutcomeEvents,
  normalizeLegacyRecord,
  rankingPriorityValue,
  stateGuard,
  validateRecordContract
} from "./contracts.mjs";
import { validateMinuteIntervalSchedule } from "./schedules.mjs";
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

const APPLIED_JOBS_VISIBLE_COLUMNS = [
  "Applied at",
  "Job title",
  "Company",
  "Generated message",
  "Job link",
  "Current outcome",
  "Outcome updated at",
  "Action"
];

const APPLIED_JOBS_HIDDEN_COLUMNS = [
  "canonical_job_id",
  "source_state_guard"
];

const APPLIED_JOBS_ACTIONS = {
  "No Response": "outcome_no_response",
  Replied: "outcome_replied",
  Interview: "outcome_interview",
  Offer: "outcome_offer",
  Rejected: "outcome_rejected",
  "Clear Outcome": "clear_outcome"
};

function safeReviewText(value, maximum = 500) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(
      /(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function formulaSafeReviewCell(value) {
  const text = String(value ?? "");
  const formulaProbe = text
    .normalize("NFKC")
    .replace(/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]*/u, "");
  return /^[=+\-@]/.test(formulaProbe) ? `'${text}` : text;
}

function reviewQueueConfiguration(reviewConfig) {
  return reviewConfig?.review_queue || reviewConfig || {};
}

function appliedJobsConfiguration(reviewConfig) {
  return reviewConfig?.applied_jobs || {};
}

export function validateReviewRuntimeConfig(reviewConfig) {
  const errors = [];
  for (const field of [
    "schedule_minutes",
    "execution_timeout_seconds",
    "projection_claim_lease_ms"
  ]) {
    if (!Number.isInteger(reviewConfig?.[field]) || reviewConfig[field] < 1) {
      errors.push(`${field} must be a positive integer`);
    }
  }
  errors.push(
    ...validateMinuteIntervalSchedule(reviewConfig, "review")
  );
  if (
    Number.isInteger(reviewConfig?.execution_timeout_seconds) &&
    Number.isInteger(reviewConfig?.schedule_minutes) &&
    reviewConfig.execution_timeout_seconds >=
      reviewConfig.schedule_minutes * 60
  ) {
    errors.push("review execution timeout must be shorter than its schedule");
  }
  if (
    Number.isInteger(reviewConfig?.execution_timeout_seconds) &&
    Number.isInteger(reviewConfig?.projection_claim_lease_ms) &&
    reviewConfig.execution_timeout_seconds * 1000 >=
      reviewConfig.projection_claim_lease_ms
  ) {
    errors.push(
      "projection claim lease must outlast the review execution timeout"
    );
  }
  return errors;
}

function validCanonicalIdentity(value) {
  const identity = String(value || "").trim();
  return (
    identity.length > 0 &&
    identity.length <= 128 &&
    /^[a-z0-9.-]+:(?:[a-z0-9._-]+|url:[0-9a-f]{8})$/i.test(identity)
  );
}

function canonicalIdentityKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function verifiedStateGuard(record) {
  const computed = stateGuard(record);
  const persisted = String(record?.state_guard || "").trim();
  return {
    computed,
    valid:
      Boolean(computed) &&
      (!persisted || persisted === computed)
  };
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
  const recovery = queue.generation_recovery;
  if (
    !recovery ||
    !Array.isArray(recovery.statuses) ||
    recovery.statuses.length === 0 ||
    recovery.statuses.some(
      (status, index, all) =>
        !["retryable_error", "terminal_error"].includes(status) ||
        all.indexOf(status) !== index
    ) ||
    recovery.failed_stage !== "generation"
  ) {
    errors.push(
      "review_queue.generation_recovery must define unique error statuses for generation"
    );
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

export function validateAppliedJobsConfig(reviewConfig, schema) {
  const appliedJobs = appliedJobsConfiguration(reviewConfig);
  const errors = [];
  if (
    !appliedJobs ||
    typeof appliedJobs !== "object" ||
    Array.isArray(appliedJobs)
  ) {
    return ["applied_jobs must be an object"];
  }
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(appliedJobs.version || "")) {
    errors.push("applied_jobs.version must use YYYY-MM-DD/vN");
  }
  if (appliedJobs.sheet !== "Applied Jobs") {
    errors.push("applied_jobs.sheet must be Applied Jobs");
  }
  if (
    JSON.stringify(appliedJobs.visible_columns) !==
    JSON.stringify(APPLIED_JOBS_VISIBLE_COLUMNS)
  ) {
    errors.push("applied_jobs.visible_columns must match the applied contract");
  }
  if (
    JSON.stringify(appliedJobs.hidden_columns) !==
    JSON.stringify(APPLIED_JOBS_HIDDEN_COLUMNS)
  ) {
    errors.push("applied_jobs.hidden_columns must match the helper contract");
  }
  const expectedFields = [
    ...APPLIED_JOBS_VISIBLE_COLUMNS,
    ...APPLIED_JOBS_HIDDEN_COLUMNS
  ];
  if (JSON.stringify(appliedJobs.fields) !== JSON.stringify(expectedFields)) {
    errors.push("applied_jobs.fields must contain visible then hidden columns");
  }
  if (appliedJobs.application_decision !== "applied") {
    errors.push("applied_jobs.application_decision must be applied");
  }
  if (
    JSON.stringify(appliedJobs.actions) !==
    JSON.stringify(APPLIED_JOBS_ACTIONS)
  ) {
    errors.push("applied_jobs.actions must match the friendly outcome contract");
  }
  for (const command of Object.values(appliedJobs.actions || {})) {
    if (!schema?.manual_actions?.includes(command)) {
      errors.push(`applied_jobs action is unsupported: ${command}`);
    }
  }
  const expectedSort = [
    { field: "application_decided_at", direction: "desc" },
    { field: "canonical_job_id", direction: "asc" }
  ];
  if (JSON.stringify(appliedJobs.sort) !== JSON.stringify(expectedSort)) {
    errors.push("applied_jobs.sort must use applied time then canonical identity");
  }
  return errors;
}

function isGenerationRecovery(record, reviewConfig) {
  const recovery =
    reviewQueueConfiguration(reviewConfig).generation_recovery || {};
  return (
    recovery.failed_stage === "generation" &&
    record.failed_stage === recovery.failed_stage &&
    (recovery.statuses || []).includes(record.pipeline_status)
  );
}

function generationFailureCause(record) {
  const rawSummary = String(record.error_summary || "");
  const isPackNotReadySummary =
    /application(?:_| )pack.*(?:not ready|must be ready|application_pack_status)/i.test(
      rawSummary
    );
  const isValidationSummary =
    /^(?:message_validation|validation):/i.test(rawSummary);
  const summary = isValidationSummary
    ? safeReviewText(rawSummary, 180)
        .replace(/^message_validation:\s*/i, "")
        .replace(/^validation:\s*/i, "")
    : "";
  const categories = {
    timeout: "The message provider timed out.",
    rate_limit: "The message provider is temporarily rate limited.",
    external_failure: "The message provider is temporarily unavailable.",
    invalid_request: "The message provider rejected the request.",
    application_pack_not_ready:
      "The application pack needs attention before generation.",
    processing_failure: "The generated message did not pass validation."
  };
  const categoryKey = isPackNotReadySummary
    ? "application_pack_not_ready"
    : String(record.error_category || "").trim();
  const category =
    categories[categoryKey] ||
    "Application-message generation failed.";
  return summary ? `${category} ${summary}` : category;
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

export function reasonForReview(
  record,
  reviewConfig,
  now = new Date().toISOString()
) {
  const queue = reviewQueueConfiguration(reviewConfig);
  const maximum = queue.reason_maximum_length || 500;
  const parts = [];
  const warnings = reviewEvidenceList(record.application_warnings);
  const gapDetails = reviewEvidenceList(record.requirement_gap_details);
  const gaps = reviewEvidenceList(record.requirement_gaps);
  const matchReasons = reviewEvidenceList(record.match_reasons);
  const error = safeReviewText(record.error_summary, 180);

  if (isGenerationRecovery(record, reviewConfig)) {
    const attempts = Math.max(Number(record.attempt_count || 0), 0);
    const cause = generationFailureCause(record);
    if (record.pipeline_status === "retryable_error") {
      const retryAt = Date.parse(record.next_retry_at || "");
      const nowMs = Date.parse(now);
      const timing =
        Number.isFinite(retryAt) &&
        Number.isFinite(nowMs) &&
        retryAt <= nowMs
          ? "Automatic retry is due."
          : "Automatic retry is pending.";
      return safeReviewText(
        `Generation attempt ${attempts || 1} needs another try. ${timing} ${cause}`,
        maximum
      );
    }
    const displayAttempts = attempts || 1;
    return safeReviewText(
      `Automatic generation attempts are exhausted after ${displayAttempts} attempt${
        displayAttempts === 1 ? "" : "s"
      }. Choose Generate Application to retry or Skip. ${cause}`,
      maximum
    );
  }

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

function reviewQueueRow(record, reviewConfig, now) {
  const priority = rankingPriorityValue(record);
  const recovery = isGenerationRecovery(record, reviewConfig);
  return {
    Status: record.pipeline_status,
    "Job title": formulaSafeReviewCell(record.job_title),
    Company: formulaSafeReviewCell(record.company),
    Score: priority.source === "missing" ? "" : priority.value,
    "Reason for review": reasonForReview(record, reviewConfig, now),
    "Generated message": recovery
      ? ""
      : formulaSafeReviewCell(record.generated_message),
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
    .filter(
      (record) =>
        queue.statuses.includes(record.pipeline_status) ||
        isGenerationRecovery(record, reviewConfig)
    );
  const identityCounts = new Map();
  for (const record of records) {
    const identity = String(record.canonical_job_id || "").trim();
    if (identity) {
      const key = canonicalIdentityKey(identity);
      identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
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
    if (!validCanonicalIdentity(identity)) {
      invalidRecords.push({
        canonical_job_id: safeReviewText(identity, 128),
        error: "eligible review record has invalid canonical identity"
      });
      return false;
    }
    if (identityCounts.get(canonicalIdentityKey(identity)) !== 1) {
      invalidRecords.push({
        canonical_job_id: safeReviewText(identity, 128),
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
    rows: valid.map((record) =>
      reviewQueueRow(record, reviewConfig, now)
    ),
    invalid_records: invalidRecords
  };
}

function groupSourceRecords(rows, schema, now, location) {
  const groups = new Map();
  const invalid = [];
  const tainted = new Set();
  for (const raw of rows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    const identity = String(record.canonical_job_id || "").trim();
    const entry = { raw, record, location };
    if (!validCanonicalIdentity(identity)) {
      if (record.application_decision === "applied") {
        invalid.push({
          ...entry,
          error: identity
            ? "eligible applied record has invalid canonical identity"
            : "eligible applied record is missing canonical identity"
        });
      }
      continue;
    }
    const guard = verifiedStateGuard(record);
    if (!guard.valid) {
      tainted.add(identity);
      invalid.push({
        ...entry,
        error: "source record has stale state guard"
      });
      continue;
    }
    const entries = groups.get(identity) || [];
    entries.push({
      ...entry,
      record: { ...record, state_guard: guard.computed }
    });
    groups.set(identity, entries);
  }
  return { groups, invalid, tainted };
}

function selectAppliedJobSources(
  activeRows,
  archiveRows,
  schema,
  reviewConfig,
  now
) {
  const appliedJobs = appliedJobsConfiguration(reviewConfig);
  const active = groupSourceRecords(activeRows, schema, now, "active");
  const archive = groupSourceRecords(archiveRows, schema, now, "archive");
  const allInvalid = [
    ...active.invalid,
    ...archive.invalid
  ];
  const invalidRecords = allInvalid
    .filter(
      (entry) =>
        !validCanonicalIdentity(entry.record?.canonical_job_id || "")
    )
    .map((entry) => ({
    location: entry.location,
    canonical_job_id: safeReviewText(
      entry.record?.canonical_job_id || "",
      128
    ),
    error: entry.error
    }));
  const sources = [];
  const identities = new Set([
    ...active.groups.keys(),
    ...archive.groups.keys(),
    ...active.tainted,
    ...archive.tainted
  ]);

  for (const identity of identities) {
    const activeEntries = active.groups.get(identity) || [];
    const archiveEntries = archive.groups.get(identity) || [];
    const invalidEntries = allInvalid.filter(
      (entry) =>
        String(entry.record?.canonical_job_id || "").trim() === identity
    );
    const includesApplied = [
      ...activeEntries,
      ...archiveEntries,
      ...invalidEntries
    ].some(
      (entry) =>
        entry.record.application_decision === appliedJobs.application_decision
    );
    if (!includesApplied) continue;
    if (active.tainted.has(identity) || archive.tainted.has(identity)) {
      invalidRecords.push(
        ...invalidEntries.map((entry) => ({
          location: entry.location,
          canonical_job_id: safeReviewText(identity, 128),
          error: entry.error
        }))
      );
      continue;
    }
    if (activeEntries.length > 1 || archiveEntries.length > 1) {
      invalidRecords.push({
        location: activeEntries.length > 1 ? "active" : "archive",
        canonical_job_id: safeReviewText(identity, 128),
        error: "eligible applied record has duplicate canonical identity"
      });
      continue;
    }
    const authoritative = activeEntries[0] || archiveEntries[0];
    if (
      authoritative?.record.application_decision !==
      appliedJobs.application_decision
    ) {
      continue;
    }
    sources.push(authoritative);
  }

  return { sources, invalid_records: invalidRecords };
}

function appliedJobsTimestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function appliedJobsRow(record) {
  const appliedAt = String(record.application_decided_at || "").trim();
  return {
    "Applied at": Number.isFinite(Date.parse(appliedAt))
      ? formulaSafeReviewCell(appliedAt)
      : "",
    "Job title": formulaSafeReviewCell(record.job_title),
    Company: formulaSafeReviewCell(record.company),
    "Generated message": formulaSafeReviewCell(record.generated_message),
    "Job link": formulaSafeReviewCell(record.canonical_url),
    "Current outcome": formulaSafeReviewCell(record.outcome),
    "Outcome updated at": formulaSafeReviewCell(record.outcome_at),
    Action: "",
    canonical_job_id: record.canonical_job_id,
    source_state_guard: record.state_guard || stateGuard(record)
  };
}

export function buildAppliedJobsProjection(
  activeRows,
  archiveRows,
  schema,
  reviewConfig,
  now = new Date().toISOString()
) {
  const configErrors = validateAppliedJobsConfig(reviewConfig, schema);
  if (configErrors.length > 0) {
    throw new Error(
      `Invalid applied jobs configuration: ${configErrors.join("; ")}`
    );
  }
  const selected = selectAppliedJobSources(
    activeRows,
    archiveRows,
    schema,
    reviewConfig,
    now
  );
  selected.sources.sort((left, right) => {
    const rightApplied = appliedJobsTimestamp(
      right.record.application_decided_at
    );
    const leftApplied = appliedJobsTimestamp(
      left.record.application_decided_at
    );
    if (rightApplied !== leftApplied) {
      return rightApplied > leftApplied ? 1 : -1;
    }
    const leftIdentity = String(left.record.canonical_job_id);
    const rightIdentity = String(right.record.canonical_job_id);
    return leftIdentity < rightIdentity
      ? -1
      : leftIdentity > rightIdentity
        ? 1
        : 0;
  });
  return {
    rows: selected.sources.map(({ record }) => appliedJobsRow(record)),
    invalid_records: selected.invalid_records
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
  const digest = [2166136261, 2246822519, 3266489917, 668265263]
    .map((seed, seedIndex) => {
      let hash = seed >>> 0;
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index) + seedIndex * 131;
        hash = Math.imul(hash, 16777619 + seedIndex * 2);
        hash ^= hash >>> 13;
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
  const execution = safeReviewText(executionId, 48).replace(/[^a-z0-9._-]/gi, "_");
  const identity = String(record.canonical_job_id || "");
  return `commit:review:${identity}:${execution || "manual"}:${digest}`;
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
    const isGenerationFailure =
      record.failed_stage === "generation" &&
      ["retryable_error", "terminal_error"].includes(
        record.pipeline_status
      );
    if (
      ![
        "ready",
        "recommended",
        "review_required",
        "unscorable"
      ].includes(record.pipeline_status) &&
      !isGenerationFailure
    ) {
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
  const activeProjectionUpdates = [];
  const activeProjectionClaims = [];
  const activeQueueUpdates = [];
  const activeQueueClaims = [];
  const activeAppliedUpdates = [];
  const activeAppliedClaims = [];
  const activeDirectUpdates = [];
  const activeDirectClaims = [];
  const archiveClaims = [];
  const archiveUpdates = [];
  const archiveProjectionUpdates = [];
  const archiveProjectionClaims = [];
  const archiveDirectUpdates = [];
  const archiveDirectClaims = [];
  const invalidActions = [];
  const processedQueueActions = [];
  const processedAppliedActions = [];
  const executionId = String(queueContext.executionId || "");
  const queueRows = Array.isArray(queueContext.queueRows)
    ? queueContext.queueRows
    : [];
  const appliedJobsRows = Array.isArray(queueContext.appliedJobsRows)
    ? queueContext.appliedJobsRows
    : [];
  const queueConfig = reviewQueueConfiguration(queueContext.reviewConfig);
  const appliedJobsConfig = appliedJobsConfiguration(queueContext.reviewConfig);
  const configuredQueueActions = queueConfig.actions || {};
  const configuredAppliedActions = appliedJobsConfig.actions || {};
  const queueActionsById = new Map();
  const appliedActionsById = new Map();
  const appliedProjectionIdentityCounts = new Map();
  for (const row of appliedJobsRows) {
    const identity = String(row?.canonical_job_id || "").trim();
    if (!identity) continue;
    appliedProjectionIdentityCounts.set(
      identity,
      (appliedProjectionIdentityCounts.get(identity) || 0) + 1
    );
  }

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
      canonical_job_id: safeReviewText(canonicalJobId, 128),
      manual_action: manualAction || "[unsupported]",
      error
    });
  };

  const projectionName = (location) =>
    location === "review_queue" ? "review queue" : "Applied Jobs";

  const collectProjectionActions = ({
    rows,
    configuredActions,
    location,
    destination
  }) => {
    for (const raw of rows) {
      const label = String(raw?.Action || "").trim();
      if (!label) continue;
      const canonicalJobId = String(raw?.canonical_job_id || "").trim();
      const command = configuredActions[label];
      if (!canonicalJobId) {
        invalidAction({
          location,
          raw,
          manualAction: command,
          error: `${projectionName(location)} action is missing canonical identity`
        });
        continue;
      }
      if (
        location === "applied_jobs" &&
        appliedProjectionIdentityCounts.get(canonicalJobId) !== 1
      ) {
        invalidAction({
          location,
          raw,
          canonicalJobId,
          manualAction: command,
          error: "Applied Jobs action has duplicate projection identity"
        });
        continue;
      }
      if (!command) {
        invalidAction({
          location,
          raw,
          canonicalJobId,
          error: `unsupported ${projectionName(location)} action`
        });
        continue;
      }
      const entries = destination.get(canonicalJobId) || [];
      entries.push({
        raw,
        canonical_job_id: canonicalJobId,
        source_state_guard: String(raw.source_state_guard || "").trim(),
        label,
        command
      });
      destination.set(canonicalJobId, entries);
    }
  };

  collectProjectionActions({
    rows: queueRows,
    configuredActions: configuredQueueActions,
    location: "review_queue",
    destination: queueActionsById
  });
  collectProjectionActions({
    rows: appliedJobsRows,
    configuredActions: configuredAppliedActions,
    location: "applied_jobs",
    destination: appliedActionsById
  });

  const active = activeRows.map((raw) => ({
    raw,
    record: normalizeLegacyRecord(raw, schema, now)
  }));
  const archive = archiveRows.map((raw) => ({
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
  const archiveIdentityCounts = new Map();
  for (const { record } of archive) {
    const identity = String(record.canonical_job_id || "").trim();
    if (identity) {
      archiveIdentityCounts.set(
        identity,
        (archiveIdentityCounts.get(identity) || 0) + 1
      );
    }
  }
  const directActionsByIdentity = (entries) => {
    const actions = new Map();
    for (const entry of entries) {
      const identity = String(entry.record.canonical_job_id || "").trim();
      const action = String(entry.record.manual_action || "").trim();
      if (!identity || !action) continue;
      const matches = actions.get(identity) || [];
      matches.push({ ...entry, action });
      actions.set(identity, matches);
    }
    return actions;
  };
  const activeDirectActions = directActionsByIdentity(active);
  const archiveDirectActions = directActionsByIdentity(archive);
  const consumedQueueIdentities = new Set();
  const consumedAppliedIdentities = new Set();
  const reportedActiveDuplicates = new Set();
  const reportedArchiveDuplicates = new Set();
  const suppressedArchiveDirectIdentities = new Set();

  const rejectEntries = (entries, location, error) => {
    for (const entry of entries) {
      invalidAction({
        location,
        raw: entry.raw,
        canonicalJobId: entry.canonical_job_id,
        manualAction: entry.command,
        error
      });
    }
  };

  const resolveGuardedAction = ({
    entries,
    record,
    location,
    contextualize
  }) => {
    if (entries.length === 0) return { action: "", entries: [] };
    const sourceIdentity = String(record.canonical_job_id || "").trim();
    if (!validCanonicalIdentity(sourceIdentity)) {
      rejectEntries(
        entries,
        location,
        `${projectionName(location)} source has invalid canonical identity`
      );
      return { action: "", entries: [] };
    }
    const sourceGuard = verifiedStateGuard(record);
    if (!sourceGuard.valid) {
      rejectEntries(
        entries,
        location,
        `${projectionName(location)} source state guard integrity mismatch`
      );
      return { action: "", entries: [] };
    }
    const contextualEntries = entries.map((entry) => {
      if (!contextualize) return entry;
      return contextualize(entry);
    });
    const invalidEntries = contextualEntries.filter((entry) => !entry.command);
    for (const entry of invalidEntries) {
      invalidAction({
        location,
        raw: entry.raw,
        canonicalJobId: entry.canonical_job_id,
        error:
          entry.context_error ||
          `unsupported ${projectionName(location)} action`
      });
    }
    const actionableEntries = contextualEntries.filter(
      (entry) => entry.command
    );
    const commands = new Set(
      actionableEntries.map((entry) => entry.command)
    );
    const guards = new Set(
      actionableEntries.map((entry) => entry.source_state_guard)
    );
    if (
      actionableEntries.length === 0 ||
      actionableEntries.length !== entries.length ||
      commands.size !== 1 ||
      guards.size !== 1
    ) {
      rejectEntries(
        actionableEntries,
        location,
        `conflicting ${projectionName(location)} actions`
      );
      return { action: "", entries: [] };
    }
    const projectedGuard = [...guards][0];
    if (!projectedGuard || projectedGuard !== sourceGuard.computed) {
      rejectEntries(
        entries,
        location,
        `stale ${projectionName(location)} action`
      );
      return { action: "", entries: [] };
    }
    return {
      action: [...commands][0],
      entries: actionableEntries
    };
  };

  const planRecordAction = ({
    raw,
    record,
    sourceLocation,
    directAction,
    queueResolution = { action: "", entries: [] },
    appliedResolution = { action: "", entries: [] }
  }) => {
    const identity = String(record.canonical_job_id || "").trim();
    let queueAction = queueResolution.action;
    let appliedAction = appliedResolution.action;

    if (queueAction && appliedAction) {
      rejectEntries(
        queueResolution.entries,
        "review_queue",
        "review queue action conflicts with Applied Jobs action"
      );
      rejectEntries(
        appliedResolution.entries,
        "applied_jobs",
        "Applied Jobs action conflicts with Review Queue action"
      );
      queueAction = "";
      appliedAction = "";
    }

    const projectionAction = queueAction || appliedAction;
    const projectionLocation = queueAction ? "review_queue" : "applied_jobs";
    const projectionEntries = queueAction
      ? queueResolution.entries
      : appliedResolution.entries;
    if (
      directAction &&
      projectionAction &&
      directAction !== projectionAction
    ) {
      rejectEntries(
        projectionEntries,
        projectionLocation,
        `${projectionLocation} action conflicts with ${
          sourceLocation === "active" ? "Sheet1" : "Archive"
        } action`
      );
      queueAction = "";
      appliedAction = "";
    }

    const selectedProjectionAction = queueAction || appliedAction;
    const selectedAction = directAction || selectedProjectionAction;
    if (!selectedAction) return;
    if (!identity) {
      invalidAction({
        location: sourceLocation,
        raw,
        manualAction: schema.manual_actions.includes(selectedAction)
          ? selectedAction
          : undefined,
        error: `${sourceLocation} review action is missing canonical identity`
      });
      return;
    }

    const result = applyManualAction(
      { ...record, manual_action: selectedAction },
      schema,
      now,
      messageSafetyContext
    );
    if (!result.valid) {
      const supportedAction = schema.manual_actions.includes(selectedAction);
      const invalidLocation = directAction
        ? sourceLocation
        : queueAction
          ? "review_queue"
          : "applied_jobs";
      const invalidEntries = queueAction
        ? queueResolution.entries
        : appliedAction
          ? appliedResolution.entries
          : [];
      if (invalidEntries.length > 0) {
        rejectEntries(
          invalidEntries,
          invalidLocation,
          supportedAction ? result.error : "unsupported manual action"
        );
      } else {
        invalidAction({
          location: invalidLocation,
          raw,
          canonicalJobId: identity,
          manualAction: supportedAction ? selectedAction : undefined,
          error: supportedAction ? result.error : "unsupported manual action"
        });
      }
      return;
    }
    if (!result.changed) return;

    const sourceGuard = stateGuard(record);
    const commitGuard = reviewCommitGuard(
      record,
      selectedAction,
      executionId,
      now
    );
    const update = {
      ...result.record,
      state_guard: stateGuard(result.record),
      processing_commit_guard: commitGuard,
      row_number: raw.row_number
    };
    const claim = {
      canonical_job_id: identity,
      state_guard: sourceGuard,
      processing_commit_guard: commitGuard,
      manual_action: directAction || ""
    };
    const projectionOwned = Boolean(selectedProjectionAction && !directAction);
    if (sourceLocation === "active") {
      activeClaims.push(claim);
      activeUpdates.push(update);
      if (projectionOwned) {
        activeProjectionClaims.push(claim);
        activeProjectionUpdates.push(update);
        if (queueAction) {
          activeQueueClaims.push(claim);
          activeQueueUpdates.push(update);
        } else {
          activeAppliedClaims.push(claim);
          activeAppliedUpdates.push(update);
        }
      } else {
        activeDirectClaims.push(claim);
        activeDirectUpdates.push(update);
      }
    } else {
      archiveClaims.push(claim);
      archiveUpdates.push(update);
      if (projectionOwned) {
        archiveProjectionClaims.push(claim);
        archiveProjectionUpdates.push(update);
      } else {
        archiveDirectClaims.push(claim);
        archiveDirectUpdates.push(update);
      }
    }
    if (queueAction) {
      processedQueueActions.push({
        canonical_job_id: identity,
        manual_action: queueAction,
        source_state_guard: sourceGuard,
        processing_commit_guard: commitGuard,
        duplicate_count: queueResolution.entries.length
      });
    }
    if (appliedAction) {
      processedAppliedActions.push({
        canonical_job_id: identity,
        source_location: sourceLocation,
        manual_action: appliedAction,
        source_state_guard: sourceGuard,
        processing_commit_guard: commitGuard,
        duplicate_count: appliedResolution.entries.length
      });
    }
  };

  for (const { raw, record } of active) {
    const identity = String(record.canonical_job_id || "").trim();
    const directAction = String(record.manual_action || "").trim();
    let queueEntries = identity
      ? queueActionsById.get(identity) || []
      : [];

    let appliedEntries = identity
      ? appliedActionsById.get(identity) || []
      : [];
    const archiveDirectEntries = identity
      ? archiveDirectActions.get(identity) || []
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
      if (!reportedActiveDuplicates.has(identity)) {
        rejectEntries(
          queueEntries,
          "review_queue",
          "review queue action has duplicate source identity"
        );
        rejectEntries(
          appliedEntries,
          "applied_jobs",
          "Applied Jobs action has duplicate source identity"
        );
        consumedQueueIdentities.add(identity);
        consumedAppliedIdentities.add(identity);
        reportedActiveDuplicates.add(identity);
      }
      continue;
    }

    if (archiveDirectEntries.length > 0) {
      suppressedArchiveDirectIdentities.add(identity);
      if (queueEntries.length > 0) {
        rejectEntries(
          queueEntries,
          "review_queue",
          "review queue action conflicts with direct Archive action"
        );
        consumedQueueIdentities.add(identity);
        queueEntries = [];
      }
      if (appliedEntries.length > 0) {
        rejectEntries(
          appliedEntries,
          "applied_jobs",
          "Applied Jobs action conflicts with direct Archive action"
        );
        consumedAppliedIdentities.add(identity);
        appliedEntries = [];
      }
      for (const entry of archiveDirectEntries) {
        invalidAction({
          location: "archive",
          raw: entry.raw,
          canonicalJobId: identity,
          manualAction: schema.manual_actions.includes(entry.action)
            ? entry.action
            : undefined,
          error:
            "direct Archive action conflicts with active authoritative source"
        });
      }
    }

    let queueResolution = { action: "", entries: [] };
    if (queueEntries.length > 0) {
      consumedQueueIdentities.add(identity);
      queueResolution = resolveGuardedAction({
        entries: queueEntries,
        record,
        location: "review_queue",
        contextualize: (entry) => {
          if (!isGenerationRecovery(record, queueContext.reviewConfig)) {
            return entry;
          }
          if (entry.label === "Generate Application") {
            return { ...entry, command: "retry" };
          }
          if (entry.label === "Skip") {
            return { ...entry, command: "mark_skipped" };
          }
          return {
            ...entry,
            command: "",
            context_error:
              "I Applied is unavailable until a current validated message is ready"
          };
        }
      });
    }

    let appliedResolution = { action: "", entries: [] };
    if (appliedEntries.length > 0) {
      consumedAppliedIdentities.add(identity);
      if ((archiveIdentityCounts.get(identity) || 0) > 1) {
        rejectEntries(
          appliedEntries,
          "applied_jobs",
          "Applied Jobs action has duplicate source identity"
        );
      } else {
        appliedResolution = resolveGuardedAction({
          entries: appliedEntries,
          record,
          location: "applied_jobs"
        });
      }
    }

    planRecordAction({
      raw,
      record,
      sourceLocation: "active",
      directAction,
      queueResolution,
      appliedResolution
    });
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

  for (const { raw, record } of archive) {
    const identity = String(record.canonical_job_id || "").trim();
    const directAction = String(record.manual_action || "").trim();
    if (identity && suppressedArchiveDirectIdentities.has(identity)) continue;
    const appliedEntries =
      identity && !consumedAppliedIdentities.has(identity)
        ? appliedActionsById.get(identity) || []
        : [];

    if (identity && archiveIdentityCounts.get(identity) > 1) {
      if (directAction) {
        invalidAction({
          location: "archive",
          raw,
          canonicalJobId: identity,
          manualAction: schema.manual_actions.includes(directAction)
            ? directAction
            : undefined,
          error: "archive review action has duplicate canonical identity"
        });
      }
      if (
        appliedEntries.length > 0 &&
        !reportedArchiveDuplicates.has(identity)
      ) {
        rejectEntries(
          appliedEntries,
          "applied_jobs",
          "Applied Jobs action has duplicate source identity"
        );
        consumedAppliedIdentities.add(identity);
        reportedArchiveDuplicates.add(identity);
      }
      continue;
    }

    let appliedResolution = { action: "", entries: [] };
    if (appliedEntries.length > 0) {
      consumedAppliedIdentities.add(identity);
      appliedResolution = resolveGuardedAction({
        entries: appliedEntries,
        record,
        location: "applied_jobs"
      });
    }
    planRecordAction({
      raw,
      record,
      sourceLocation: "archive",
      directAction,
      appliedResolution
    });
  }

  for (const [identity, entries] of appliedActionsById) {
    if (consumedAppliedIdentities.has(identity)) continue;
    rejectEntries(
      entries,
      "applied_jobs",
      "Applied Jobs source record is missing"
    );
  }

  return {
    active_claims: activeClaims,
    active_updates: activeUpdates,
    active_projection_claims: activeProjectionClaims,
    active_projection_updates: activeProjectionUpdates,
    active_queue_claims: activeQueueClaims,
    active_queue_updates: activeQueueUpdates,
    active_applied_claims: activeAppliedClaims,
    active_applied_updates: activeAppliedUpdates,
    active_direct_claims: activeDirectClaims,
    active_direct_updates: activeDirectUpdates,
    archive_claims: archiveClaims,
    archive_updates: archiveUpdates,
    archive_projection_claims: archiveProjectionClaims,
    archive_projection_updates: archiveProjectionUpdates,
    archive_direct_claims: archiveDirectClaims,
    archive_direct_updates: archiveDirectUpdates,
    invalid_actions: invalidActions,
    processed_queue_actions: processedQueueActions,
    processed_applied_actions: processedAppliedActions
  };
}

export function confirmClaimedReviewUpdates(
  plannedUpdates,
  claims,
  freshRows
) {
  const updates = Array.isArray(plannedUpdates) ? plannedUpdates : [];
  const proposedClaims = Array.isArray(claims) ? claims : [];
  const current = (Array.isArray(freshRows) ? freshRows : []).filter(
    (row) => row && typeof row === "object" && !Array.isArray(row)
  );
  return updates.flatMap((update) => {
    const identity = String(update?.canonical_job_id || "").trim();
    const commitGuard = String(
      update?.processing_commit_guard || ""
    ).trim();
    if (!identity || !commitGuard) return [];
    const matchingClaims = proposedClaims.filter(
      (claim) =>
        String(claim?.processing_commit_guard || "").trim() ===
        commitGuard
    );
    const matchingRows = current.filter(
      (row) =>
        String(row?.processing_commit_guard || "").trim() === commitGuard
    );
    if (matchingClaims.length !== 1 || matchingRows.length !== 1) {
      return [];
    }
    const claim = matchingClaims[0];
    const row = matchingRows[0];
    if (
      String(claim.canonical_job_id || "").trim() !== identity ||
      String(row.canonical_job_id || "").trim() !== identity ||
      String(row.state_guard || "").trim() !==
        String(claim.state_guard || "").trim() ||
      String(row.manual_action || "").trim() !==
        String(claim.manual_action || "").trim()
    ) {
      return [];
    }
    return [{ ...update, row_number: row.row_number }];
  });
}

function queueSnapshotKey(row) {
  return [
    row?.row_number,
    String(row?.canonical_job_id || "").trim(),
    String(row?.source_state_guard || "").trim(),
    String(row?.Action || "").trim()
  ].join("\u001f");
}

function projectionActionSnapshot(rows, location = "applied_jobs") {
  const grouped = new Map();
  const invalidRecords = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = String(row?.canonical_job_id || "").trim();
    const action = String(row?.Action || "").trim();
    if (!validCanonicalIdentity(identity)) {
      if (action) {
        invalidRecords.push({
          location,
          canonical_job_id: safeReviewText(identity, 128),
          error: identity
            ? "projection action has invalid canonical identity"
            : "projection action is missing canonical identity"
        });
      }
      continue;
    }
    const entries = grouped.get(identity) || [];
    entries.push({ row, action });
    grouped.set(identity, entries);
  }

  const byIdentity = new Map();
  const duplicates = new Set();
  for (const [identity, entries] of grouped) {
    if (entries.length !== 1) {
      duplicates.add(identity);
      if (entries.some((entry) => entry.action)) {
        invalidRecords.push({
          location,
          canonical_job_id: safeReviewText(identity, 128),
          error: "projection action has duplicate canonical identity"
        });
      }
      continue;
    }
    byIdentity.set(identity, entries[0]);
  }
  return { byIdentity, duplicates, invalid_records: invalidRecords };
}

function projectionActionChanged(previousSnapshot, currentSnapshot, identity) {
  if (
    !validCanonicalIdentity(identity) ||
    previousSnapshot.duplicates.has(identity) ||
    currentSnapshot.duplicates.has(identity)
  ) {
    return false;
  }
  const previous = previousSnapshot.byIdentity.get(identity);
  const current = currentSnapshot.byIdentity.get(identity);
  return Boolean(
    previous &&
      current &&
      current.action &&
      previous.action !== current.action
  );
}

function reviewQueueProjectionMatches(currentRows, desiredRows, fields) {
  if (
    !Array.isArray(currentRows) ||
    !Array.isArray(desiredRows) ||
    !Array.isArray(fields) ||
    fields.length === 0 ||
    currentRows.length !== desiredRows.length
  ) {
    return false;
  }
  return desiredRows.every((desiredRow, index) =>
    fields.every(
      (field) =>
        String(currentRows[index]?.[field] ?? "") ===
        String(desiredRow?.[field] ?? "")
    )
  );
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
  const queueConfig = reviewQueueConfiguration(reviewConfig);
  if (
    reviewQueueProjectionMatches(
      currentQueueRows,
      projection.rows,
      queueConfig.fields
    )
  ) {
    return {
      queue_rows: [],
      delete_rows: [],
      protected_action_count: 0,
      unchanged_row_count: projection.rows.length,
      invalid_records: projection.invalid_records
    };
  }
  const initialActions = new Set(
    initialQueueRows
      .filter((row) => String(row?.Action || "").trim())
      .map(queueSnapshotKey)
  );
  const currentSourceGuards = new Map();
  for (const row of activeRows) {
    const record = normalizeLegacyRecord(row, schema, now);
    const identity = String(record.canonical_job_id || "").trim();
    if (!identity) continue;
    const guards = currentSourceGuards.get(identity) || new Set();
    guards.add(String(record.state_guard || stateGuard(record)));
    currentSourceGuards.set(identity, guards);
  }
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
      currentSourceGuards.get(identity)?.has(sourceGuard);
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
    unchanged_row_count: 0,
    invalid_records: projection.invalid_records
  };
}

export function reconcileAppliedJobs(
  activeRows,
  archiveRows,
  currentAppliedRows,
  initialAppliedRows,
  schema,
  reviewConfig,
  now = new Date().toISOString(),
  _confirmation = {}
) {
  const projection = buildAppliedJobsProjection(
    activeRows,
    archiveRows,
    schema,
    reviewConfig,
    now
  );
  const initialSnapshot = projectionActionSnapshot(initialAppliedRows);
  const currentSnapshot = projectionActionSnapshot(currentAppliedRows);
  const currentSources = new Map(
    selectAppliedJobSources(
      activeRows,
      archiveRows,
      schema,
      reviewConfig,
      now
    ).sources.map(({ record }) => [
      String(record.canonical_job_id || "").trim(),
      record
    ])
  );
  const projectedByIdentity = new Map(
    projection.rows.map((row) => [
      String(row.canonical_job_id || "").trim(),
      row
    ])
  );
  const protectedRows = new Set();
  const protectedIdentities = new Set();
  const rebaseRows = [];
  for (const row of currentAppliedRows) {
    const action = String(row?.Action || "").trim();
    if (!action) continue;
    const identity = String(row.canonical_job_id || "").trim();
    const actionAppearedAfterRead = projectionActionChanged(
      initialSnapshot,
      currentSnapshot,
      identity
    );
    const command = appliedJobsConfiguration(reviewConfig).actions?.[action];
    const currentSource = currentSources.get(identity);
    const sourceWriteConfirmed =
      currentSource &&
      Array.isArray(currentSource.outcome_events) &&
      (command === "clear_outcome"
        ? !currentSource.outcome
        : OUTCOME_ACTIONS[command] === currentSource.outcome);
    if (!actionAppearedAfterRead && sourceWriteConfirmed) continue;
    const rowNumber = Number(row.row_number);
    if (Number.isInteger(rowNumber) && rowNumber > 1) {
      protectedRows.add(rowNumber);
      const projected = projectedByIdentity.get(identity);
      if (
        actionAppearedAfterRead &&
        projected &&
        !currentSnapshot.duplicates.has(identity)
      ) {
        rebaseRows.push({
          ...projected,
          Action: action
        });
      }
    }
    if (identity) protectedIdentities.add(identity);
  }
  const appliedJobs = appliedJobsConfiguration(reviewConfig);
  const clearFields = (appliedJobs.fields || []).filter(
    (field) =>
      !["Action", "canonical_job_id"].includes(field)
  );
  const clearRows = [];
  for (const [identity, entry] of currentSnapshot.byIdentity) {
    if (
      projectedByIdentity.has(identity) ||
      protectedIdentities.has(identity) ||
      entry.action
    ) {
      continue;
    }
    clearRows.push({
      canonical_job_id: identity,
      ...Object.fromEntries(clearFields.map((field) => [field, ""]))
    });
  }
  return {
    applied_rows: projection.rows.filter(
      (row) =>
        !protectedIdentities.has(row.canonical_job_id) &&
        !currentSnapshot.duplicates.has(row.canonical_job_id)
    ),
    desired_rows: projection.rows,
    rebase_rows: rebaseRows,
    clear_rows: clearRows,
    protected_action_count: protectedRows.size,
    invalid_records: [
      ...projection.invalid_records,
      ...initialSnapshot.invalid_records,
      ...currentSnapshot.invalid_records
    ]
  };
}

export function finalizeAppliedJobsCleanup(
  plannedReconciliation,
  previousRows,
  latestRows
) {
  const planned = plannedReconciliation || {};
  const previous = Array.isArray(previousRows) ? previousRows : [];
  const latest = Array.isArray(latestRows) ? latestRows : [];
  const previousSnapshot = projectionActionSnapshot(previous);
  const latestSnapshot = projectionActionSnapshot(latest);
  const desiredByIdentity = new Map(
    [
      ...(planned.applied_rows || []),
      ...(planned.applied_rebase_rows || []),
      ...(planned.applied_desired_rows || [])
    ].map((row) => [String(row?.canonical_job_id || "").trim(), row])
  );
  const protectedIdentities = new Set();
  const ambiguousIdentities = latestSnapshot.duplicates;
  const plannedRebaseByIdentity = new Map(
    (planned.applied_rebase_rows || []).map((row) => [
      String(row?.canonical_job_id || "").trim(),
      row
    ])
  );
  const rebaseRows = new Map();
  for (const row of latest) {
    const action = String(row?.Action || "").trim();
    const identity = String(row?.canonical_job_id || "").trim();
    if (action) {
      if (
        validCanonicalIdentity(identity) &&
        !latestSnapshot.duplicates.has(identity)
      ) {
        protectedIdentities.add(identity);
        const desired = desiredByIdentity.get(identity);
        const plannedRebase = plannedRebaseByIdentity.get(identity);
        const actionChangedSinceReconciliation = projectionActionChanged(
          previousSnapshot,
          latestSnapshot,
          identity
        );
        if (desired && (plannedRebase || actionChangedSinceReconciliation)) {
          rebaseRows.set(identity, {
            ...(plannedRebase || desired),
            Action: action
          });
        }
      }
      continue;
    }
  }
  return {
    ...planned,
    applied_rows: (planned.applied_rows || []).filter(
      (row) =>
        !ambiguousIdentities.has(
          String(row?.canonical_job_id || "").trim()
        )
    ),
    applied_clear_rows: (planned.applied_clear_rows || []).filter(
      (row) => {
        const identity = String(row?.canonical_job_id || "").trim();
        return (
          !ambiguousIdentities.has(identity) &&
          !protectedIdentities.has(identity)
        );
      }
    ),
    applied_rebase_rows: [...rebaseRows.values()],
    applied_last_minute_protected_actions: protectedIdentities.size,
    invalid_records: [
      ...(planned.invalid_records || []),
      ...previousSnapshot.invalid_records,
      ...latestSnapshot.invalid_records
    ]
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
