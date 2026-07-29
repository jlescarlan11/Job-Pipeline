import {
  normalizeLegacyRecord,
  stateGuard
} from "./contracts.mjs";
import {
  selectWorkCandidates,
  workCandidateDueAt
} from "./evaluation.mjs";

const ACTIVE_ALERT_STATES = new Set([
  "pending",
  "sending",
  "retryable_failure"
]);
const MAXIMUM_MANUAL_ACTION_FINGERPRINTS = 100;
const MINUTE_MS = 60 * 1000;

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ageMinutes(nowMs, dueMs) {
  if (!Number.isFinite(dueMs)) return null;
  return Math.round(Math.max(0, nowMs - dueMs) / MINUTE_MS * 1000) / 1000;
}

function oldestAge(nowMs, timestamps) {
  if (timestamps.length === 0) return null;
  return ageMinutes(nowMs, Math.min(...timestamps));
}

function recordLocator(record) {
  const rowNumber = String(record?.row_number ?? "").trim();
  if (rowNumber) return `row:${rowNumber}`;
  return `id:${String(record?.canonical_job_id || "").trim()}`;
}

function summarizeWorkBacklog(
  activeRows,
  schema,
  now,
  processingLeaseMs
) {
  const nowMs = Date.parse(now);
  const rawByLocator = new Map(
    activeRows.map((raw) => {
      const normalized = normalizeLegacyRecord(raw, schema, now);
      return [recordLocator(normalized), raw];
    })
  );
  const candidates = selectWorkCandidates(activeRows, schema, {
    now,
    maxItems: Math.max(1, activeRows.length),
    leaseMs: processingLeaseMs.generation
  });
  const stageSummary = (stage) => {
    const stageCandidates = candidates.filter(
      (record) => record.work_stage === stage
    );
    const dueTimestamps = stageCandidates
      .map((record) =>
        workCandidateDueAt(
          record,
          stage,
          processingLeaseMs[stage],
          rawByLocator.get(recordLocator(record))
        )
      )
      .filter((value) => Number.isFinite(value) && value <= nowMs);
    return {
      count: stageCandidates.length,
      oldest_minutes: oldestAge(nowMs, dueTimestamps),
      age_unobservable_count:
        stageCandidates.length - dueTimestamps.length
    };
  };
  const generation = stageSummary("generation");
  const evaluation = stageSummary("evaluation");
  return {
    due_generation_count: generation.count,
    oldest_due_generation_minutes: generation.oldest_minutes,
    generation_age_unobservable_count:
      generation.age_unobservable_count,
    due_evaluation_count: evaluation.count,
    oldest_due_evaluation_minutes: evaluation.oldest_minutes,
    evaluation_age_unobservable_count:
      evaluation.age_unobservable_count
  };
}

function alertOrigin(record) {
  return (
    timestamp(record.generated_at) ??
    timestamp(record.alert_last_attempt_at) ??
    timestamp(record.alert_next_retry_at) ??
    timestamp(record.updated_at) ??
    timestamp(record.created_at)
  );
}

function summarizeAlertBacklog(records, nowMs) {
  const pending = records.filter((record) =>
    ACTIVE_ALERT_STATES.has(String(record.alert_status || "").trim())
  );
  const origins = pending
    .map((record) => alertOrigin(record))
    .filter((value) => Number.isFinite(value) && value <= nowMs);
  return {
    pending_alert_count: pending.length,
    oldest_pending_alert_minutes: oldestAge(nowMs, origins),
    pending_alert_age_unobservable_count:
      pending.length - origins.length
  };
}

function fingerprint(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of String(value)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function sourceActionEntries(records, location) {
  return records.flatMap((record) => {
    const action = String(record.manual_action || "").trim();
    if (!action) return [];
    return [
      [
        location,
        record.canonical_job_id || record.row_number || "",
        stateGuard(record),
        action
      ].join("\u001f")
    ];
  });
}

function projectionActionEntries(rows, location) {
  return rows.flatMap((row) => {
    const action = String(row?.Action || "").trim();
    if (!action) return [];
    return [
      [
        location,
        row.canonical_job_id || row.row_number || "",
        row.source_state_guard || "",
        action
      ].join("\u001f")
    ];
  });
}

function summarizeManualActions({
  activeRecords,
  archiveRecords,
  queueRows,
  appliedJobsRows
}) {
  const entries = [
    ...sourceActionEntries(activeRecords, "active"),
    ...sourceActionEntries(archiveRecords, "archive"),
    ...projectionActionEntries(queueRows, "review_queue"),
    ...projectionActionEntries(appliedJobsRows, "applied_jobs")
  ];
  const allFingerprints = [...new Set(entries.map(fingerprint))].sort();
  const fingerprints = allFingerprints.slice(
    0,
    MAXIMUM_MANUAL_ACTION_FINGERPRINTS
  );
  return {
    manual_action_count: entries.length,
    manual_action_fingerprints: fingerprints,
    manual_action_fingerprints_truncated:
      Math.max(0, allFingerprints.length - fingerprints.length)
  };
}

function summarizeActiveClaims(records, nowMs, processingLeaseMs) {
  let pastLeaseCount = 0;
  let invalidCount = 0;
  const expiredAt = [];
  for (const record of records) {
    const stage = String(record.processing_stage || "").trim();
    const token = String(record.processing_token || "").trim();
    const startedAtText = String(record.processing_started_at || "").trim();
    if (!stage && !token && !startedAtText) continue;
    const leaseMs = Number(processingLeaseMs?.[stage]);
    const startedAt = timestamp(startedAtText);
    if (
      !stage ||
      !token ||
      !startedAtText ||
      !Number.isFinite(leaseMs) ||
      leaseMs < 1 ||
      !Number.isFinite(startedAt) ||
      startedAt > nowMs
    ) {
      invalidCount += 1;
      pastLeaseCount += 1;
      continue;
    }
    const expiresAt = startedAt + leaseMs;
    if (expiresAt <= nowMs) {
      pastLeaseCount += 1;
      expiredAt.push(expiresAt);
    }
  }
  return {
    active_claim_past_lease_count: pastLeaseCount,
    invalid_active_claim_marker_count: invalidCount,
    oldest_active_claim_past_lease_minutes: oldestAge(nowMs, expiredAt)
  };
}

export function summarizeOperationalBacklog(
  {
    activeRows = [],
    archiveRows = [],
    queueRows = [],
    appliedJobsRows = []
  },
  schema,
  {
    now = new Date().toISOString(),
    generationLeaseMs,
    processingLeaseMs = {}
  } = {}
) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("operational backlog summary requires a valid timestamp");
  }
  if (!Number.isFinite(generationLeaseMs) || generationLeaseMs < 1) {
    throw new Error(
      "operational backlog summary requires a positive generation lease"
    );
  }
  const normalizedActive = activeRows.map((row) =>
    normalizeLegacyRecord(row, schema, now)
  );
  const normalizedArchive = archiveRows.map((row) =>
    normalizeLegacyRecord(row, schema, now)
  );
  return {
    ...summarizeWorkBacklog(
      activeRows,
      schema,
      now,
      {
        ...processingLeaseMs,
        generation: generationLeaseMs
      }
    ),
    ...summarizeAlertBacklog(normalizedActive, nowMs),
    ...summarizeManualActions({
      activeRecords: normalizedActive,
      archiveRecords: normalizedArchive,
      queueRows,
      appliedJobsRows
    }),
    ...summarizeActiveClaims(
      [...normalizedActive, ...normalizedArchive],
      nowMs,
      processingLeaseMs
    )
  };
}

export function generatorResultEvent(record, stage) {
  return {
    event: "generator_result",
    timestamp: String(record?.updated_at || "").trim(),
    state_commit_pending: true,
    stage: String(stage || record?.failed_stage || "").trim(),
    status: String(record?.pipeline_status || "").trim(),
    category: String(record?.error_category || "").trim()
  };
}
