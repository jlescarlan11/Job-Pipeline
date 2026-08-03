import {
  applicationReviewGuard,
  stateGuard,
  validateRecordStoreContract
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

function permanentSourceUnavailable(record) {
  if (
    record?.source_availability === "unavailable" ||
    record?.error_category === "source_unavailable"
  ) {
    return true;
  }
  if (record?.pipeline_status !== "error") return false;
  const summary = String(record.error_summary || "");
  return (
    /^\s*(?:404|410)(?:\b|\s*[-:])/u.test(summary) ||
    /\b(?:http|status(?:\s+code)?)\s*[:=-]?\s*(?:404|410)\b/iu.test(
      summary
    )
  );
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

function destinationConflict(actual, destination, reason) {
  if (
    destination === "Scraped Jobs" &&
    (actual.pipeline_status !== "review_needed" ||
      actual.user_action !== "Approve" ||
      actual.processing_token)
  ) {
    return true;
  }
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
  if (
    ["Scraped Jobs", "To Review", "To Apply"].includes(destination) &&
    (actual.applied_at || actual.archived_at || actual.archive_reason)
  ) {
    return true;
  }
  return false;
}

function validExistingDestination(source, actual, destination, reason, schema) {
  if (!actual || destinationConflict(actual, destination, reason)) return false;
  if (validateRecordStoreContract(actual, destination, schema).length > 0) {
    return false;
  }
  if (actual.state_guard !== stateGuard(actual)) return false;
  if (destination === "Scraped Jobs" && actual.user_action !== "Approve") {
    return false;
  }
  if (
    destination === "Scraped Jobs" &&
    (!Number.isFinite(Date.parse(actual.review_approved_at || "")) ||
      actual.review_approval_guard !== applicationReviewGuard(source))
  ) {
    return false;
  }
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
  if (
    destination === "Archive" &&
    reason === "source_unavailable" &&
    (actual.pipeline_status !== "unavailable" ||
      actual.source_availability !== "unavailable" ||
      actual.next_retry_at)
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
    "alert_status",
    "alert_idempotency_key",
    "alert_attempt_count",
    "alert_last_attempt_at",
    "alert_next_retry_at",
    "alert_sent_at",
    "alert_provider_reference",
    "alert_error_category",
    "alert_error_summary",
    "applied_at",
    "archived_at",
    "archive_reason",
    "outcome",
    "outcome_recorded_value",
    "outcome_at",
    "notes",
    "updated_at"
  ]);
  if (destination === "Archive" && reason === "source_unavailable") {
    destinationOwned.add("pipeline_status");
    destinationOwned.add("source_availability");
    destinationOwned.add("next_retry_at");
  }
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
    user_action:
      destination === "Scraped Jobs"
        ? "Approve"
        : existing?.user_action || "",
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
  } else if (destination === "Archive") {
    record.archived_at = existing?.archived_at || source.archived_at || now;
    record.archive_reason = reason;
    record.applied_at = "";
    record.notes = existing ? existing.notes || "" : source.notes || "";
    if (reason === "source_unavailable") {
      record.pipeline_status = "unavailable";
      record.source_availability = "unavailable";
      record.next_retry_at = "";
    }
  } else {
    record.applied_at = "";
    record.archived_at = "";
    record.archive_reason = "";
    record.notes = existing ? existing.notes || "" : source.notes || "";
    if (destination === "Scraped Jobs") {
      record.review_approved_at =
        existing?.review_approved_at || source.review_approved_at || now;
      record.review_approval_note = sanitize(
        existing?.review_approval_note ||
          source.review_approval_note ||
          source.notes,
        1000
      );
      record.review_approval_guard = applicationReviewGuard(source);
    }
  }
  if (existing) {
    for (const field of [
      "user_action",
      "notes",
      "alert_status",
      "alert_idempotency_key",
      "alert_claim_token",
      "alert_attempt_count",
      "alert_last_attempt_at",
      "alert_next_retry_at",
      "alert_sent_at",
      "alert_provider_reference",
      "alert_error_category",
      "alert_error_summary",
      "outcome",
      "outcome_recorded_value",
      "outcome_at"
    ]) {
      if (existing[field] !== undefined && existing[field] !== null) {
        record[field] = existing[field];
      }
    }
  }
  if (["user_applied", "user_skip"].includes(reason)) {
    // An operator terminal action wins over an in-flight or retryable Slack
    // delivery. The destination must never retain `sending` after movement
    // clears the source claim token, otherwise the record fails its own store
    // contract and becomes stranded in To Apply.
    if (["pending", "sending", "retryable_failure"].includes(record.alert_status)) {
      record.alert_status = "suppressed";
      record.alert_error_category = "operator_terminal_action";
      record.alert_error_summary =
        "Slack alert cancelled because the operator completed a terminal queue action.";
    }
    record.alert_claim_token = "";
    record.alert_next_retry_at = "";
  }
  record.state_guard = stateGuard(record);
  return record;
}

function classifyQueueRow(sourceSheet, record) {
  if (
    sourceSheet === "Scraped Jobs" &&
    !record.user_action &&
    permanentSourceUnavailable(record)
  ) {
    return { destination: "Archive", reason: "source_unavailable" };
  }
  if (
    sourceSheet === "Scraped Jobs" &&
    record.pipeline_status === "review_needed" &&
    !record.user_action
  ) {
    return { destination: "To Review", reason: "review_needed" };
  }
  if (
    sourceSheet === "Scraped Jobs" &&
    record.pipeline_status === "ready_to_apply" &&
    !record.user_action
  ) {
    return { destination: "To Apply", reason: "ready_to_apply" };
  }
  if (
    sourceSheet === "Scraped Jobs" &&
    record.pipeline_status === "skip" &&
    !record.user_action
  ) {
    return { destination: "Archive", reason: "automatic_skip" };
  }
  if (
    sourceSheet === "To Apply" &&
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "I Applied"
  ) {
    // This action records a manual application that already happened. Message
    // safety still gates outbound Slack alerts, but it must not erase or strand
    // the operator's historical fact after an alert failure or context change.
    return { destination: "Applied Jobs", reason: "user_applied" };
  }
  if (
    sourceSheet === "To Apply" &&
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "Skip"
  ) {
    return { destination: "Archive", reason: "user_skip" };
  }
  if (
    sourceSheet === "To Review" &&
    record.pipeline_status === "review_needed" &&
    record.user_action === "Deny"
  ) {
    return { destination: "Archive", reason: "review_denied" };
  }
  if (
    sourceSheet === "To Review" &&
    record.pipeline_status === "review_needed" &&
    record.user_action === "Approve"
  ) {
    return { destination: "Scraped Jobs", reason: "review_approved" };
  }
  return null;
}

export function planQueueActions(
  stores,
  schema,
  now = new Date().toISOString(),
  messageSafetyContext,
  { movementPerRunCap = Number.POSITIVE_INFINITY } = {}
) {
  const expectedStores = schema?.business_stores ?? [];
  if (
    expectedStores.length !== 5 ||
    expectedStores.some((store) => !Array.isArray(stores?.[store]))
  ) {
    throw new Error(
      "Movement requires Scraped Jobs, To Review, To Apply, Applied Jobs, and Archive rows"
    );
  }
  const indexes = Object.fromEntries(
    expectedStores.map((store) => [store, indexStore(stores[store], store)])
  );
  const canonicalUrlOwners = new Map();
  for (const store of expectedStores) {
    for (const row of stores[store]) {
      const urlKey = identityKey(row?.canonical_url);
      const identity = identityKey(row?.canonical_job_id);
      const previous = canonicalUrlOwners.get(urlKey);
      if (previous && previous.identity !== identity) {
        throw new Error(
          `Movement contains an ambiguous canonical URL in ${previous.store} and ${store}`
        );
      }
      canonicalUrlOwners.set(urlKey, { identity, store });
    }
  }
  const moves = [];
  const rejected = [];
  const candidates = [];
  const sourceOrder = ["Scraped Jobs", "To Review", "To Apply"];
  for (const sourceSheet of sourceOrder) {
    for (const source of stores[sourceSheet]) {
      const contractErrors = validateRecordStoreContract(
        source,
        sourceSheet,
        schema
      );
      if (contractErrors.length > 0) {
        rejected.push({
          canonical_job_id: String(source?.canonical_job_id || ""),
          source_sheet: sourceSheet,
          reason: "invalid_source",
          summary: sanitize(contractErrors.join("; "))
        });
        continue;
      }
      if (String(source?.state_guard || "") !== stateGuard(source)) {
        rejected.push({
          canonical_job_id: String(source?.canonical_job_id || ""),
          source_sheet: sourceSheet,
          reason: "invalid_source",
          summary: "Source state guard does not match the current row"
        });
        continue;
      }
      let classification;
      try {
        classification = classifyQueueRow(sourceSheet, source);
      } catch (error) {
        rejected.push({
          canonical_job_id: String(source?.canonical_job_id || ""),
          source_sheet: sourceSheet,
          reason: "unsafe_action",
          summary: sanitize(error?.message || error)
        });
        continue;
      }
      if (classification) {
        candidates.push({ sourceSheet, source, classification });
      }
    }
  }
  candidates.sort((left, right) => {
    const timestamp = (entry) => {
      const parsed = Date.parse(
        entry.source.updated_at || entry.source.created_at || ""
      );
      return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
    };
    return (
      timestamp(left) - timestamp(right) ||
      sourceOrder.indexOf(left.sourceSheet) -
        sourceOrder.indexOf(right.sourceSheet) ||
      String(left.source.canonical_job_id).localeCompare(
        String(right.source.canonical_job_id)
      )
    );
  });

  for (const { sourceSheet, source, classification } of candidates) {
    const key = identityKey(source.canonical_job_id);
    const existing = indexes[classification.destination].get(key);
    const conflictingStores = expectedStores.filter(
      (store) =>
        store !== sourceSheet &&
        store !== classification.destination &&
        indexes[store].has(key)
    );
    if (conflictingStores.length > 0) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        source_sheet: sourceSheet,
        reason: "identity_conflict",
        summary: `Identity already exists in ${conflictingStores.join(", ")}`
      });
      continue;
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
        source_sheet: sourceSheet,
        reason: "destination_conflict",
        summary: "Existing destination record has conflicting terminal state"
      });
      continue;
    }
    if (moves.length >= movementPerRunCap) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        source_sheet: sourceSheet,
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
    const destinationErrors = validateRecordStoreContract(
      destination,
      classification.destination,
      schema
    );
    if (destinationErrors.length > 0) {
      rejected.push({
        canonical_job_id: source.canonical_job_id,
        source_sheet: sourceSheet,
        reason: "invalid_destination",
        summary: sanitize(destinationErrors.join("; "))
      });
      continue;
    }
    moves.push({
      canonical_job_id: source.canonical_job_id,
      source_sheet: sourceSheet,
      source_row_number: source.row_number,
      source_state_guard: source.state_guard,
      source_record_version: source.record_version,
      source_status: source.pipeline_status,
      source_action: source.user_action,
      source_notes: source.notes || "",
      destination: classification.destination,
      route_reason: classification.reason,
      claim_scope: `${sourceSheet}:${classification.destination}`,
      archive_reason:
        classification.destination === "Archive"
          ? classification.reason
          : "",
      write_required: !existingComplete,
      source_record: { ...source },
      destination_record: destination
    });
  }
  return { moves, rejected };
}

export function destinationWrites(plans) {
  return {
    scraped_jobs: plans.moves
      .filter(
        (plan) => plan.destination === "Scraped Jobs" && plan.write_required
      )
      .map((plan) => ({ ...plan.destination_record })),
    to_review: plans.moves
      .filter(
        (plan) => plan.destination === "To Review" && plan.write_required
      )
      .map((plan) => ({ ...plan.destination_record })),
    to_apply: plans.moves
      .filter(
        (plan) => plan.destination === "To Apply" && plan.write_required
      )
      .map((plan) => ({ ...plan.destination_record })),
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
  freshStores,
  schema
) {
  const expectedStores = schema?.business_stores ?? [];
  if (expectedStores.some((store) => !Array.isArray(freshStores?.[store]))) {
    throw new Error("Movement confirmation requires every business store");
  }
  const indexes = Object.fromEntries(
    expectedStores.map((store) => [
      store,
      indexStore(freshStores[store], store)
    ])
  );
  const deletions = [];
  const rejected = [];

  for (const plan of plans.moves) {
    const key = identityKey(plan.canonical_job_id);
    const source = indexes[plan.source_sheet]?.get(key);
    if (!source) {
      // A repeated scheduler run after a successful delete is a no-op.
      continue;
    }
    const sourceUnchanged =
      String(source?.state_guard || "") === stateGuard(source) &&
      source.state_guard === plan.source_state_guard &&
      source.record_version === plan.source_record_version &&
      source.pipeline_status === plan.source_status &&
      source.user_action === plan.source_action &&
      String(source.notes || "") === String(plan.source_notes || "");
    if (!sourceUnchanged) {
      rejected.push({
        canonical_job_id: plan.canonical_job_id,
        reason: "stale_source"
      });
      continue;
    }
    const destination = indexes[plan.destination]?.get(key);
    if (
      !validExistingDestination(
        plan.source_record,
        destination,
        plan.destination,
        plan.route_reason,
        schema
      )
    ) {
      rejected.push({
        canonical_job_id: plan.canonical_job_id,
        reason: "destination_unconfirmed"
      });
      continue;
    }
    deletions.push({
      row_number: source.row_number,
      canonical_job_id: source.canonical_job_id,
      source_sheet: plan.source_sheet,
      destination: plan.destination
    });
  }

  deletions.sort(
    (left, right) =>
      left.source_sheet.localeCompare(right.source_sheet) ||
      right.row_number - left.row_number
  );
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
  const errors = validateRecordStoreContract(
    updated,
    "Applied Jobs",
    schema
  );
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
    const errors = validateRecordStoreContract(
      record,
      "Applied Jobs",
      schema
    );
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
