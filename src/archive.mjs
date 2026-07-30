import {
  mergeOutcomeEvents,
  normalizeLegacyRecord,
  stateGuard
} from "./contracts.mjs";

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function comparableValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {
      // Plain strings, including formatted application messages, remain exact.
    }
  }
  return String(value ?? "");
}

function recordSnapshot(record, schema) {
  return JSON.stringify(
    Object.fromEntries(
      schema.fields.map((field) => [field, comparableValue(record[field])])
    )
  );
}

function archiveMatchesPlanned(current, planned, schema) {
  return schema.fields.every(
    (field) =>
      !hasValue(planned[field]) ||
      comparableValue(current[field]) === comparableValue(planned[field])
  );
}

const ARCHIVE_OWNED_INPUT_FIELDS = new Set([
  "apply_points_input",
  "application_message_strategy_input",
  "manual_action",
  "notes"
]);

const ACTIVE_EXACT_PROCESSING_FIELDS = new Set([
  "processing_stage",
  "processing_commit_guard",
  "processing_token",
  "processing_started_at"
]);

function mergeArchiveRecord(active, existing, schema, now) {
  const merged = {};
  for (const field of schema.fields) {
    if (hasValue(active[field])) merged[field] = active[field];
    if (
      hasValue(existing?.[field]) &&
      (!hasValue(active[field]) ||
        ARCHIVE_OWNED_INPUT_FIELDS.has(field))
    ) {
      merged[field] = existing[field];
    }
    if (
      field.startsWith("alert_") ||
      ACTIVE_EXACT_PROCESSING_FIELDS.has(field)
    ) {
      merged[field] = active[field] ?? "";
    }
  }
  const eventCollections = [
    existing?.outcome_events,
    active.outcome_events
  ].filter(hasValue);
  merged.outcome_events = eventCollections.every(Array.isArray)
    ? mergeOutcomeEvents(existing?.outcome_events, active.outcome_events)
    : existing?.outcome_events ?? active.outcome_events;
  const activeOutcomeAt = Date.parse(active.outcome_at || "");
  const existingOutcomeAt = Date.parse(existing?.outcome_at || "");
  if (
    Number.isFinite(activeOutcomeAt) &&
    (!Number.isFinite(existingOutcomeAt) || activeOutcomeAt > existingOutcomeAt)
  ) {
    merged.outcome = active.outcome;
    merged.outcome_at = active.outcome_at;
  } else if (Number.isFinite(existingOutcomeAt)) {
    merged.outcome = existing.outcome;
    merged.outcome_at = existing.outcome_at;
  }
  const fromStatus =
    existing?.archived_from_status ||
    active.archived_from_status ||
    active.pipeline_status;
  const archived = {
    ...merged,
    source: active.source,
    source_job_id: active.source_job_id,
    canonical_job_id: active.canonical_job_id,
    canonical_url: active.canonical_url,
    pipeline_status: "archived",
    archived_from_status: fromStatus,
    archived_at: existing?.archived_at || now,
    updated_at: now
  };
  return { ...archived, state_guard: stateGuard(archived) };
}

export function archiveRecordIsComplete(record) {
  return Boolean(
    record?.canonical_job_id &&
    record?.canonical_url &&
    record?.pipeline_status === "archived" &&
    record?.archived_from_status &&
    record?.archived_at
  );
}

export function prepareArchiveCandidates(
  activeRows,
  archiveRows,
  schema,
  {
    now = new Date().toISOString(),
    eligibleStatuses = ["applied", "skipped", "not_recommended", "terminal_error"]
  } = {}
) {
  const allowed = new Set(eligibleStatuses);
  const archiveById = new Map();
  const archiveByUrl = new Map();
  for (const raw of archiveRows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    if (record.canonical_job_id) archiveById.set(record.canonical_job_id, record);
    if (record.canonical_url) archiveByUrl.set(record.canonical_url, record);
  }

  const candidates = [];
  const retained = [];
  for (const raw of activeRows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    if (record.pipeline_status === "retryable_error") {
      retained.push({ record, reason: "retryable_error" });
      continue;
    }
    if (
      record.pipeline_status === "terminal_error" &&
      record.failed_stage === "generation" &&
      !record.application_decision
    ) {
      retained.push({
        record,
        reason: "terminal_generation_requires_review"
      });
      continue;
    }
    if (!allowed.has(record.pipeline_status)) continue;
    if (!record.canonical_job_id || !record.canonical_url || !record.row_number) {
      retained.push({ record, reason: "invalid_identity_or_row" });
      continue;
    }
    const existing =
      archiveById.get(record.canonical_job_id) ||
      archiveByUrl.get(record.canonical_url);
    candidates.push({
      ...record,
      work_stage: "archival",
      source_row_number: Number(record.row_number),
      source_snapshot_at: now,
      source_snapshot: recordSnapshot(record, schema),
      archive_record: mergeArchiveRecord(record, existing, schema, now),
      archive_already_complete: archiveRecordIsComplete(existing)
    });
  }

  return {
    candidates: candidates.sort((left, right) => right.source_row_number - left.source_row_number),
    retained
  };
}

export function prepareArchiveUpserts(
  plannedCandidates,
  freshArchiveRows,
  schema,
  now = new Date().toISOString()
) {
  const planned = Array.isArray(plannedCandidates)
    ? plannedCandidates
    : [];
  const current = (Array.isArray(freshArchiveRows)
    ? freshArchiveRows
    : []
  )
    .filter(
      (row) => row && typeof row === "object" && !Array.isArray(row)
    )
    .map((row) => normalizeLegacyRecord(row, schema, now));
  const upserts = [];
  const rejected = [];
  for (const candidate of planned) {
    const identity = String(candidate?.canonical_job_id || "").trim();
    const canonicalUrl = String(candidate?.canonical_url || "").trim();
    const processingToken = String(
      candidate?.processing_token || ""
    ).trim();
    if (!identity || !canonicalUrl || !processingToken) {
      rejected.push({
        planned: candidate,
        reason: "invalid_archive_upsert_claim"
      });
      continue;
    }
    const matches = current.filter(
      (row) =>
        String(row.canonical_job_id || "").trim() === identity ||
        String(row.canonical_url || "").trim() === canonicalUrl
    );
    if (matches.length > 1) {
      rejected.push({
        planned: candidate,
        reason: "ambiguous_archive_identity"
      });
      continue;
    }
    const archiveRecord = mergeArchiveRecord(
      candidate.archive_record || candidate,
      matches[0],
      schema,
      now
    );
    upserts.push({
      ...archiveRecord,
      source_row_number: candidate.source_row_number,
      archive_claim_token: processingToken
    });
  }
  return { upserts, rejected };
}

export function confirmArchiveDeletions(
  plannedCandidates,
  currentActiveRows,
  currentArchiveRows,
  schema,
  now = new Date().toISOString()
) {
  const currentByRow = new Map();
  for (const raw of currentActiveRows) {
    currentByRow.set(Number(raw.row_number), raw);
  }
  const archiveById = new Map();
  for (const raw of currentArchiveRows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    if (record.canonical_job_id) archiveById.set(record.canonical_job_id, record);
  }

  const confirmed = [];
  const rejected = [];
  for (const planned of plannedCandidates) {
    const currentRaw = currentByRow.get(Number(planned.source_row_number));
    const current = currentRaw
      ? normalizeLegacyRecord(currentRaw, schema, planned.source_snapshot_at || now)
      : undefined;
    const archived = archiveById.get(planned.canonical_job_id);
    if (!current || current.canonical_job_id !== planned.canonical_job_id) {
      rejected.push({ planned, reason: "active_row_identity_changed" });
      continue;
    }
    if (
      planned.source_snapshot &&
      recordSnapshot(current, schema) !== planned.source_snapshot
    ) {
      rejected.push({ planned, reason: "active_record_changed_after_plan" });
      continue;
    }
    if (
      !archiveRecordIsComplete(archived) ||
      !archiveMatchesPlanned(archived, planned.archive_record, schema)
    ) {
      rejected.push({ planned, reason: "archive_copy_not_confirmed" });
      continue;
    }
    confirmed.push({
      row_number: Number(planned.source_row_number),
      canonical_job_id: planned.canonical_job_id
    });
  }
  confirmed.sort((left, right) => right.row_number - left.row_number);
  return { confirmed, rejected };
}
