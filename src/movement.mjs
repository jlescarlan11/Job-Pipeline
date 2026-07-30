import {
  stateGuard,
  validateRecordContract
} from "./contracts.mjs";

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

function safeApplicationReady(record) {
  return (
    record.pipeline_status === "ready_to_apply" &&
    record.application_pack_status === "ready" &&
    record.message_validation_status === "valid" &&
    Boolean(String(record.generated_message || "").trim()) &&
    Boolean(record.message_profile_version) &&
    Boolean(record.message_policy_version) &&
    Boolean(record.application_pack_version) &&
    Boolean(record.application_pack_profile_version) &&
    Boolean(record.application_pack_policy_version)
  );
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

function validExistingDestination(source, actual, destination, reason, schema) {
  if (!actual) return false;
  if (
    destination === "Applied Jobs" &&
    (!Number.isFinite(Date.parse(actual.applied_at || "")) ||
      actual.archive_reason ||
      actual.archived_at)
  ) {
    return false;
  }
  if (
    destination === "Archive" &&
    (!Number.isFinite(Date.parse(actual.archived_at || "")) ||
      actual.archive_reason !== reason ||
      actual.applied_at)
  ) {
    return false;
  }
  const overwritten = new Set([
    "record_version",
    "state_guard",
    "user_action",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "applied_at",
    "archived_at",
    "archive_reason",
    "updated_at"
  ]);
  return schema.fields.every((field) => {
    if (overwritten.has(field)) return true;
    const sourceValue = source[field];
    if (sourceValue === "" || sourceValue === undefined || sourceValue === null) {
      return true;
    }
    return JSON.stringify(actual[field]) === JSON.stringify(sourceValue);
  });
}

function destinationRecord(source, destination, reason, now) {
  const record = {
    ...source,
    row_number: undefined,
    user_action: "",
    processing_stage: "",
    processing_token: "",
    processing_started_at: "",
    record_version: source.record_version + 1,
    updated_at: now
  };
  if (destination === "Applied Jobs") {
    record.applied_at = source.applied_at || now;
    record.archived_at = "";
    record.archive_reason = "";
  } else {
    record.archived_at = source.archived_at || now;
    record.archive_reason = reason;
    record.applied_at = "";
  }
  record.state_guard = stateGuard(record);
  return record;
}

function classifyQueueRow(record) {
  if (record.pipeline_status === "skip" && !record.user_action) {
    return { destination: "Archive", reason: "automatic_skip" };
  }
  if (
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "I Applied"
  ) {
    if (!safeApplicationReady(record)) {
      throw new Error("I Applied rejected because application safety evidence is incomplete");
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
  now = new Date().toISOString()
) {
  const applied = indexStore(appliedRows, "Applied Jobs");
  const archive = indexStore(archiveRows, "Archive");
  indexStore(reviewRows, "Review Queue");

  const moves = [];
  const generationRequests = [];
  for (const source of reviewRows) {
    const contractErrors = validateRecordContract(source, schema);
    if (contractErrors.length > 0) {
      throw new Error(
        `Review Queue action rejected invalid row: ${sanitize(contractErrors.join("; "))}`
      );
    }
    const classification = classifyQueueRow(source);
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

    const destination = destinationRecord(
      source,
      classification.destination,
      classification.reason,
      now
    );
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
      !validExistingDestination(
        source,
        existing,
        classification.destination,
        classification.reason,
        schema
      )
    ) {
      throw new Error("Existing destination record is incomplete or conflicting");
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
      write_required: !existing,
      destination_record: existing ? { ...existing } : destination
    });
  }
  return { moves, generation_requests: generationRequests };
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
