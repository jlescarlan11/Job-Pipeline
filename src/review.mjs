import {
  normalizeLegacyRecord,
  stateGuard
} from "./contracts.mjs";

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
    processing_started_at: ""
  };
}

function changed(record) {
  return {
    changed: true,
    valid: true,
    record: { ...record, state_guard: stateGuard(record) }
  };
}

export function applyManualAction(record, schema, now = new Date().toISOString()) {
  const action = String(record.manual_action || "").trim();
  if (!action) return { changed: false, valid: true, record };
  if (!schema.manual_actions.includes(action)) {
    return { changed: false, valid: false, record, error: `unsupported manual action: ${action}` };
  }

  if (action === "promote") {
    if (!["review_required", "unscorable"].includes(record.pipeline_status)) {
      return { changed: false, valid: false, record, error: `promote is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(record),
      pipeline_status: "recommended",
      match_decision: "recommended",
      manual_action: "",
      updated_at: now
    });
  }

  if (action === "regenerate") {
    if (record.pipeline_status !== "ready") {
      return { changed: false, valid: false, record, error: `regenerate is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(record),
      pipeline_status: "recommended",
      manual_action: "",
      updated_at: now
    });
  }

  if (action === "mark_applied") {
    if (record.pipeline_status !== "ready") {
      return { changed: false, valid: false, record, error: `mark_applied is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(record),
      pipeline_status: "applied",
      application_decision: "applied",
      application_decided_at: now,
      manual_action: "",
      updated_at: now
    });
  }

  if (action === "mark_skipped") {
    if (!["ready", "recommended", "review_required", "unscorable"].includes(record.pipeline_status)) {
      return { changed: false, valid: false, record, error: `mark_skipped is invalid from ${record.pipeline_status}` };
    }
    return changed({
      ...clearProcessing(record),
      pipeline_status: "skipped",
      application_decision: "skipped",
      application_decided_at: now,
      manual_action: "",
      updated_at: now
    });
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
    });
  }

  if (action === "clear_outcome") {
    if (record.application_decision !== "applied") {
      return { changed: false, valid: false, record, error: "outcomes require an applied decision" };
    }
    return changed({
      ...record,
      outcome: "",
      outcome_at: now,
      manual_action: "",
      updated_at: now
    });
  }

  const outcome = OUTCOME_ACTIONS[action];
  if (outcome) {
    if (record.application_decision !== "applied") {
      return { changed: false, valid: false, record, error: "outcomes require an applied decision" };
    }
    return changed({
      ...record,
      outcome,
      outcome_at: now,
      manual_action: "",
      updated_at: now
    });
  }

  return { changed: false, valid: false, record, error: `unhandled manual action: ${action}` };
}

export function processReviewActions(activeRows, archiveRows, schema, now = new Date().toISOString()) {
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
      const result = applyManualAction(record, schema, now);
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
      const matchScore = Number(right.match_score || 0) - Number(left.match_score || 0);
      if (matchScore !== 0) return matchScore;
      return Date.parse(right.posted_at || 0) - Date.parse(left.posted_at || 0);
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
