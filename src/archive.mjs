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

function mergeArchiveRecord(active, existing, schema, now) {
  const merged = {};
  for (const field of schema.fields) {
    if (hasValue(active[field])) merged[field] = active[field];
    if (hasValue(existing?.[field])) merged[field] = existing[field];
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
