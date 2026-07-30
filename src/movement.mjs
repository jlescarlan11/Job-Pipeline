import {
  stateGuard,
  validateRecordContract
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";

function identityKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function sanitize(value, maximum = 240) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maximum);
}

function indexStore(rows, name) {
  if (!Array.isArray(rows)) throw new Error(`${name} rows must be an array`);
  const index = new Map();
  for (const row of rows) {
    const key = identityKey(row?.canonical_job_id);
    if (!key) throw new Error(`${name} contains a row with invalid identity`);
    if (index.has(key)) {
      throw new Error(`${name} contains an ambiguous duplicate identity`);
    }
    index.set(key, row);
  }
  return index;
}

function completeCopy(expected, actual, schema) {
  if (!actual) return false;
  return schema.fields.every((field) => {
    const expectedValue = expected[field];
    if (
      expectedValue === "" ||
      expectedValue === undefined ||
      expectedValue === null
    ) {
      return true;
    }
    return JSON.stringify(actual[field]) === JSON.stringify(expectedValue);
  });
}

function destinationConflict(actual, destination, reason) {
  if (
    destination === "Applied Jobs" &&
    (actual.archive_reason || actual.archived_at)
  ) {
    return true;
  }
  if (
    destination === "Archive" &&
    ((actual.archive_reason && actual.archive_reason !== reason) ||
      actual.applied_at)
  ) {
    return true;
  }
  return false;
}

function validExistingDestination(source, actual, destination, reason, schema) {
  if (!actual || destinationConflict(actual, destination, reason)) return false;
  if (
    destination === "Applied Jobs" &&
    !Number.isFinite(Date.parse(actual.applied_at || ""))
  ) {
    return false;
  }
  if (
    destination === "Archive" &&
    (!Number.isFinite(Date.parse(actual.archived_at || "")) ||
      actual.archive_reason !== reason)
  ) {
    return false;
  }
  const destinationOwned = new Set([
    "row_number",
    "record_version",
    "state_guard",
    "user_action",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "alert_claim_token",
    "applied_at",
    "archived_at",
    "archive_reason",
    "outcome",
    "outcome_recorded_value",
    "outcome_at",
    "notes",
    "updated_at"
  ]);
  return schema.fields.every((field) => {
    if (destinationOwned.has(field)) return true;
    const sourceValue = source[field];
    if (
      sourceValue === "" ||
      sourceValue === undefined ||
      sourceValue === null
    ) {
      return true;
    }
    return JSON.stringify(actual[field]) === JSON.stringify(sourceValue);
  });
}

function destinationRecord(source, destination, reason, now, existing) {
  const record = {
    ...source,
    row_number: undefined,
    user_action: "",
    processing_stage: "",
    processing_token: "",
    processing_started_at: "",
    alert_claim_token: "",
    record_version:
      Math.max(
        Number(source.record_version || 1),
        Number(existing?.record_version || 0)
      ) + 1,
    updated_at: now
  };
  if (destination === "Applied Jobs") {
    record.applied_at = existing?.applied_at || source.applied_at || now;
    record.archived_at = "";
    record.archive_reason = "";
    record.notes = existing ? existing.notes || "" : source.notes || "";
    record.outcome = existing ? existing.outcome || "" : source.outcome || "";
    record.outcome_recorded_value = existing
      ? existing.outcome_recorded_value || ""
      : record.outcome;
    record.outcome_at = existing
      ? existing.outcome_at || ""
      : source.outcome_at || "";
  } else {
    record.archived_at = existing?.archived_at || source.archived_at || now;
    record.archive_reason = reason;
    record.applied_at = "";
    record.notes = existing ? existing.notes || "" : source.notes || "";
  }
  record.state_guard = stateGuard(record);
  return record;
}

function classifyQueueRow(record, messageSafetyContext) {
  if (record.pipeline_status === "skip" && !record.user_action) {
    return { destination: "Archive", reason: "automatic_skip" };
  }
  if (
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "I Applied"
  ) {
    const safety = evaluatePersistedMessageSafety(
      record,
      messageSafetyContext
    );
    if (!safety.safe) {
      throw new Error(
        `I Applied rejected by shared message-safety gate: ${sanitize(
          safety.reasons.join(",")
        )}`
      );
    }
    return { destination: "Applied Jobs", reason: "user_applied" };
  }
  if (
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "Skip"
  ) {
    return { destination: "Archive", reason: "user_skip" };
  }
  if (
    record.pipeline_status === "review_needed" &&
    record.user_action === "Deny"
  ) {
    return { destination: "Archive", reason: "review_denied" };
  }
  if (
    record.pipeline_status === "review_needed" &&
    record.user_action === "Approve"
  ) {
    return { generationRequest: true };
  }
  return null;
}

export function planQueueActions(
  reviewRows,
  appliedRows,
  archiveRows,
  schema,
  now = new Date().toISOString(),
  messageSafetyContext,
  { movementPerRunCap = Number.POSITIVE_INFINITY } = {}
) {
  const applied = indexStore(appliedRows, "Applied Jobs");
  const archive = indexStore(archiveRows, "Archive");
  indexStore(reviewRows, "Review Queue");

  const moves = [];
  const generationRequests = [];
  const rejected = [];
  for (const source of reviewRows) {
    const contractErrors = validateRecordContract(source, schema);
    if (contractErrors.length > 0) {
      rejected.push({
        canonical_job_id: String(source?.canonical_job_id || ""),
        reason: "invalid_source",
        summary: sanitize(contractErrors.join("; "))
      });
      continue;
    }
    let classification;
    try {
      classification = classifyQueueRow(source, messageSafetyContext);
    } catch (error) {
      rejected.push({
        canonical_job_id: String(source?.canonical_job_id || ""),
        reason: "unsafe_action",
        summary: sanitize(error?.message || error)
      });
      continue;
    }
    if (!classification) continue;
    if (classification.generationRequest) {
      generationRequests.push({
        canonical_job_id: source.canonical_job_id,
        source_row_number: source.row_number,
        source_state_guard: source.state_guard,
        source_record_version: source.record_version
      });
      continue;
    }

    const key = identityKey(source.canonical_job_id);
    const inApplied = applied.get(key);
    const inArchive = archive.get(key);
    const existing =
      classification.destination === "Applied Jobs" ? inApplied : inArchive;
    const conflicting = classification.destination === "Applied Jobs"
      ? inArchive
      : inApplied;
    if (conflicting) {
      throw new Error("Terminal stores contain a conflicting canonical identity");
    }
    if (
      existing &&
      destinationConflict(
        existing,
        classification.destination,
        classification.reason
      )
    ) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        reason: "destination_conflict",
        summary: "Existing destination record has conflicting terminal state"
      });
      continue;
    }
    if (moves.length >= movementPerRunCap) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        reason: "movement_cap_reached",
        summary: "Movement deferred to a later bounded run"
      });
      continue;
    }
    const existingComplete = validExistingDestination(
      source,
      existing,
      classification.destination,
      classification.reason,
      schema
    );
    const destination = existingComplete
      ? { ...existing }
      : destinationRecord(
          source,
          classification.destination,
          classification.reason,
          now,
          existing
        );
    const destinationErrors = validateRecordContract(destination, schema);
    if (destinationErrors.length > 0) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        reason: "invalid_destination",
        summary: sanitize(destinationErrors.join("; "))
      });
      continue;
    }
    moves.push({
      canonical_job_id: source.canonical_job_id,
      source_row_number: source.row_number,
      source_state_guard: source.state_guard,
      source_record_version: source.record_version,
      source_status: source.pipeline_status,
      source_action: source.user_action,
      destination: classification.destination,
      archive_reason:
        classification.destination === "Archive"
          ? classification.reason
          : "",
      write_required: !existingComplete,
      destination_record: destination
    });
  }
  return { moves, generation_requests: generationRequests, rejected };
}

export function destinationWrites(plans) {
  return {
    applied: plans.moves
      .filter(
        (plan) => plan.destination === "Applied Jobs" && plan.write_required
      )
      .map((plan) => ({ ...plan.destination_record })),
    archive: plans.moves
      .filter((plan) => plan.destination === "Archive" && plan.write_required)
      .map((plan) => ({ ...plan.destination_record }))
  };
}

export function confirmMoveDeletions(
  plans,
  freshReviewRows,
  freshAppliedRows,
  freshArchiveRows,
  schema
) {
  const review = indexStore(freshReviewRows, "Review Queue");
  const applied = indexStore(freshAppliedRows, "Applied Jobs");
  const archive = indexStore(freshArchiveRows, "Archive");
  const deletions = [];
  const rejected = [];

  for (const plan of plans.moves) {
    const key = identityKey(plan.canonical_job_id);
    const source = review.get(key);
    if (!source) {
      // A repeated scheduler run after a successful delete is a no-op.
      continue;
    }
    const sourceUnchanged =
      source.row_number === plan.source_row_number &&
      source.state_guard === plan.source_state_guard &&
      source.record_version === plan.source_record_version &&
      source.pipeline_status === plan.source_status &&
      source.user_action === plan.source_action &&
      source.notes === plan.destination_record.notes;
    if (!sourceUnchanged) {
      rejected.push({
        canonical_job_id: plan.canonical_job_id,
        reason: "stale_source"
      });
      continue;
    }
    const destination =
      plan.destination === "Applied Jobs"
        ? applied.get(key)
        : archive.get(key);
    if (!completeCopy(plan.destination_record, destination, schema)) {
      rejected.push({
        canonical_job_id: plan.canonical_job_id,
        reason: "destination_unconfirmed"
      });
      continue;
    }
    deletions.push({
      row_number: source.row_number,
      canonical_job_id: source.canonical_job_id,
      destination: plan.destination
    });
  }

  deletions.sort((left, right) => right.row_number - left.row_number);
  return { deletions, rejected };
}

export function applyOutcomeUpdate(
  appliedRecord,
  outcome,
  expectedStateGuard,
  schema,
  now = new Date().toISOString()
) {
  if (appliedRecord.state_guard !== expectedStateGuard) {
    throw new Error("Outcome update rejected stale Applied Jobs state");
  }
  if (!schema.outcomes.includes(outcome)) {
    throw new Error("Outcome update contains an unsupported value");
  }
  const updated = {
    ...appliedRecord,
    outcome,
    outcome_recorded_value: outcome,
    outcome_at: outcome ? now : "",
    record_version: appliedRecord.record_version + 1,
    updated_at: now
  };
  updated.state_guard = stateGuard(updated);
  const errors = validateRecordContract(updated, schema);
  if (errors.length > 0) {
    throw new Error(`Outcome update failed contract validation: ${sanitize(errors.join("; "))}`);
  }
  return updated;
}

export function planOutcomeUpdates(
  appliedRows,
  schema,
  now = new Date().toISOString()
) {
  indexStore(appliedRows, "Applied Jobs");
  const updates = [];
  const rejected = [];
  for (const record of appliedRows) {
    const errors = validateRecordContract(record, schema);
    if (errors.length > 0) {
      rejected.push({
        canonical_job_id: String(record?.canonical_job_id || ""),
        reason: "invalid_applied_record",
        summary: sanitize(errors.join("; "))
      });
      continue;
    }
    if (
      String(record.outcome || "") ===
      String(record.outcome_recorded_value || "")
    ) {
      continue;
    }
    updates.push(
      applyOutcomeUpdate(
        record,
        String(record.outcome || ""),
        record.state_guard,
        schema,
        now
      )
    );
  }
  return { updates, rejected };
}
