import {
  applicationReviewGuard,
  isGuardedLegacyReviewAction,
  preparationInputGuard,
  recordCopyDigest,
  reviewCaseId,
  stateGuard,
  stateGuardMatches,
  validateRecordStoreContract
} from "./contracts.mjs";
import {
  browserConfirmationWitness,
  verifyBrowserConfirmationAttestation
} from "./browser-confirmation-attestation.mjs";

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

const AUTONOMOUS_EXECUTION_MODE = "autonomous_chrome";
const AUTONOMOUS_NON_MOVABLE_STATES = new Set([
  "queued",
  "claimed",
  "evaluating",
  "generating",
  "filling",
  "submit_started",
  "retryable",
  "ambiguous",
  "blocked",
  "unavailable"
]);
const AUTONOMOUS_CONFIRMATION_FIELDS = [
  "browser_attempt_id",
  "browser_job_digest",
  "browser_form_fingerprint",
  "submission_idempotency_key",
  "submission_started_at",
  "submission_confirmed_at",
  "submission_confirmation_kind",
  "submission_confirmation_reference",
  "submission_confirmation_digest",
  "submission_attestation_key_id",
  "submission_attestation_witness_digest",
  "submission_attestation_signature"
];
const AUTONOMOUS_CONFIRMATION_RECEIPT_FIELDS = [
  "browser_attempt_id",
  "submission_started_at",
  "submission_confirmed_at",
  "submission_confirmation_kind",
  "submission_confirmation_reference",
  "submission_confirmation_digest",
  "submission_attestation_key_id",
  "submission_attestation_witness_digest",
  "submission_attestation_signature"
];

function isAutonomousRecord(record) {
  return record?.execution_mode === AUTONOMOUS_EXECUTION_MODE;
}

function nonemptyBounded(value, maximum = 512) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      text.length <= maximum &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(text)
  );
}

function autonomousConfirmationErrors(record, confirmationTrust) {
  const errors = [];
  if (!isAutonomousRecord(record)) errors.push("execution_mode");
  if (record?.autonomous_decision !== "apply") {
    errors.push("autonomous_decision");
  }
  if (record?.browser_state !== "confirmed") errors.push("browser_state");
  if (record?.user_action) errors.push("user_action");
  for (const field of AUTONOMOUS_CONFIRMATION_FIELDS) {
    if (!nonemptyBounded(record?.[field])) errors.push(field);
  }
  const attestation = {
    algorithm: "ed25519",
    key_id: record?.submission_attestation_key_id,
    witness_digest: record?.submission_attestation_witness_digest,
    signature: record?.submission_attestation_signature
  };
  if (
    !verifyBrowserConfirmationAttestation(
      browserConfirmationWitness(record),
      attestation,
      confirmationTrust ?? {}
    )
  ) {
    errors.push("independent_confirmation_attestation");
  }
  const startedAt = Date.parse(record?.submission_started_at || "");
  const confirmedAt = Date.parse(record?.submission_confirmed_at || "");
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(confirmedAt) ||
    confirmedAt < startedAt
  ) {
    errors.push("submission_timestamps");
  }
  if (
    record?.processing_token ||
    record?.processing_stage ||
    record?.processing_started_at
  ) {
    errors.push("active_processing_claim");
  }
  if (record?.application_pack_status !== "ready") {
    errors.push("application_pack_status");
  }
  if (record?.message_validation_status !== "valid") {
    errors.push("message_validation_status");
  }
  if (!String(record?.generated_message || "").trim()) {
    errors.push("generated_message");
  }
  const profileVersions = [
    record?.profile_version,
    record?.message_profile_version,
    record?.application_pack_profile_version
  ].map((value) => String(value || "").trim());
  if (
    profileVersions.some((value) => !value) ||
    new Set(profileVersions).size !== 1
  ) {
    errors.push("profile_provenance");
  }
  for (const field of [
    "policy_version",
    "message_policy_version",
    "application_pack_policy_version",
    "application_pack_version",
    "coverage_contract_version",
    "message_plan_version"
  ]) {
    if (!String(record?.[field] || "").trim()) errors.push(field);
  }
  return [...new Set(errors)];
}

function validAutonomousSkip(record) {
  return Boolean(
    isAutonomousRecord(record) &&
      record?.autonomous_decision === "skip" &&
      record?.browser_state === "skipped" &&
      record?.pipeline_status === "skip" &&
      !record?.user_action &&
      !record?.processing_token &&
      !record?.processing_stage &&
      !record?.processing_started_at &&
      !record?.submission_idempotency_key &&
      !record?.submission_started_at &&
      !record?.submission_confirmed_at &&
      !record?.submission_confirmation_kind &&
      !record?.submission_confirmation_reference &&
      !record?.submission_confirmation_digest &&
      !record?.submission_attestation_key_id &&
      !record?.submission_attestation_witness_digest &&
      !record?.submission_attestation_signature
  );
}

function strongerAutonomousConfirmation(source, actual, confirmationTrust) {
  return Boolean(
    autonomousConfirmationErrors(source, confirmationTrust).length === 0 &&
      autonomousConfirmationErrors(actual, confirmationTrust).length === 0 &&
      actual.execution_mode === source.execution_mode &&
      actual.autonomous_decision === source.autonomous_decision &&
      actual.browser_state === source.browser_state &&
      actual.browser_job_digest === source.browser_job_digest &&
      actual.browser_form_fingerprint === source.browser_form_fingerprint &&
      actual.submission_idempotency_key === source.submission_idempotency_key &&
      source.submission_confirmation_kind === "confirmation_page" &&
      actual.submission_confirmation_kind === "application_history" &&
      Date.parse(actual.submission_confirmed_at) >=
        Date.parse(source.submission_confirmed_at) &&
      (!actual.applied_at ||
        actual.applied_at === actual.submission_confirmed_at)
  );
}

function sameAutonomousConfirmation(source, actual, confirmationTrust) {
  const exact = AUTONOMOUS_CONFIRMATION_FIELDS.every(
    (field) => String(actual?.[field] || "") === String(source?.[field] || "")
  );
  return (
    autonomousConfirmationErrors(source, confirmationTrust).length === 0 &&
    autonomousConfirmationErrors(actual, confirmationTrust).length === 0 &&
    actual.execution_mode === source.execution_mode &&
    actual.autonomous_decision === source.autonomous_decision &&
    actual.browser_state === source.browser_state &&
    (exact || strongerAutonomousConfirmation(source, actual, confirmationTrust)) &&
    actual.applied_at === actual.submission_confirmed_at
  );
}

function conflictingAutonomousConfirmation(source, actual, confirmationTrust) {
  if (!actual) return false;
  if (strongerAutonomousConfirmation(source, actual, confirmationTrust)) {
    return false;
  }
  for (const field of AUTONOMOUS_CONFIRMATION_FIELDS) {
    const actualValue = String(actual?.[field] || "");
    if (actualValue && actualValue !== String(source?.[field] || "")) {
      return true;
    }
  }
  for (const field of [
    "execution_mode",
    "autonomous_decision",
    "browser_state"
  ]) {
    const actualValue = String(actual?.[field] || "");
    if (actualValue && actualValue !== String(source?.[field] || "")) {
      return true;
    }
  }
  return Boolean(
    actual.applied_at && actual.applied_at !== source.submission_confirmed_at
  );
}

export function permanentSourceUnavailable(record) {
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

function destinationConflict(
  actual,
  destination,
  reason,
  source,
  confirmationTrust
) {
  if (destination === "To Review" && actual.review_decision) return true;
  if (
    destination === "To Apply" &&
    reason === "review_proceeded" &&
    (actual.pipeline_status !== "ready_to_apply" ||
      actual.review_decision !== "proceed")
  ) return true;
  if (
    destination === "Applied Jobs" &&
    (actual.archive_reason || actual.archived_at)
  ) {
    return true;
  }
  if (
    destination === "Applied Jobs" &&
    reason === "autonomous_confirmed" &&
    conflictingAutonomousConfirmation(source, actual, confirmationTrust)
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

function validExistingDestination(
  source,
  actual,
  destination,
  reason,
  schema,
  confirmationTrust
) {
  if (
    !actual ||
    destinationConflict(
      actual,
      destination,
      reason,
      source,
      confirmationTrust
    )
  ) {
    return false;
  }
  if (validateRecordStoreContract(actual, destination, schema).length > 0) {
    return false;
  }
  if (actual.state_guard !== stateGuard(actual)) return false;
  if (destination === "To Review") {
    const expectedCase = reviewCaseId(source);
    if (
      actual.review_case_id !== expectedCase ||
      actual.review_case_version !== "review-case-v1" ||
      actual.review_decision ||
      actual.review_decided_at
    ) return false;
  }
  if (destination === "To Apply" && reason === "review_proceeded") {
    const expectedCase = source.review_case_id || reviewCaseId(source);
    if (
      actual.pipeline_status !== "ready_to_apply" ||
      actual.user_action ||
      actual.review_case_id !== expectedCase ||
      actual.review_case_version !== "review-case-v1" ||
      actual.review_decision !== "proceed" ||
      !Number.isFinite(Date.parse(actual.review_decided_at || "")) ||
      actual.review_approved_at !== actual.review_decided_at ||
      actual.review_approval_guard !== applicationReviewGuard(source) ||
      !Number.isInteger(actual.preparation_version) ||
      actual.preparation_version < 1 ||
      actual.preparation_input_guard !== preparationInputGuard(actual) ||
      !Number.isFinite(Date.parse(actual.preparation_updated_at || ""))
    ) return false;
    if (actual.prep_status !== "pending") {
      const immutableSourceFields = [
        "source",
        "source_job_id",
        "canonical_job_id",
        "canonical_url",
        "job_title",
        "company",
        "job_description",
        "salary_text",
        "posted_at",
        "discovered_at",
        "created_at"
      ];
      return Boolean(
        actual.record_version > source.record_version + 1 &&
          immutableSourceFields.every(
            (field) =>
              JSON.stringify(actual[field] ?? "") ===
              JSON.stringify(source[field] ?? "")
          )
      );
    }
  }
  if (
    destination === "Applied Jobs" &&
    !Number.isFinite(Date.parse(actual.applied_at || ""))
  ) {
    return false;
  }
  if (
    destination === "Applied Jobs" &&
    reason === "autonomous_confirmed" &&
    !sameAutonomousConfirmation(source, actual, confirmationTrust)
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
    reason === "review_rejected" &&
    (actual.review_case_id !== (source.review_case_id || reviewCaseId(source)) ||
      actual.review_case_version !== "review-case-v1" ||
      actual.review_decision !== "reject" ||
      !Number.isFinite(Date.parse(actual.review_decided_at || "")))
  ) return false;
  if (
    destination === "Archive" &&
    reason === "autonomous_skip" &&
    (!validAutonomousSkip(source) ||
      actual.execution_mode !== AUTONOMOUS_EXECUTION_MODE ||
      actual.autonomous_decision !== "skip" ||
      actual.browser_state !== "skipped" ||
      actual.user_action)
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
  if (destination === "To Review") {
    for (const field of [
      "review_case_id",
      "review_case_version",
      "review_decision",
      "review_decided_at",
      "review_approved_at",
      "review_approval_note",
      "review_approval_guard"
    ]) destinationOwned.add(field);
  }
  if (
    destination === "Applied Jobs" &&
    reason === "autonomous_confirmed" &&
    strongerAutonomousConfirmation(source, actual, confirmationTrust)
  ) {
    for (const field of AUTONOMOUS_CONFIRMATION_RECEIPT_FIELDS) {
      destinationOwned.add(field);
    }
  }
  if (destination === "To Apply" && reason === "review_proceeded") {
    for (const field of [
      "pipeline_status",
      "review_case_id",
      "review_case_version",
      "review_decision",
      "review_decided_at",
      "review_approved_at",
      "review_approval_note",
      "review_approval_guard",
      "prep_status",
      "preparation_version",
      "preparation_input_guard",
      "preparation_updated_at",
      "next_retry_at",
      "error_category",
      "error_summary"
    ]) destinationOwned.add(field);
  }
  if (destination === "Archive" && reason === "source_unavailable") {
    destinationOwned.add("pipeline_status");
    destinationOwned.add("source_availability");
    destinationOwned.add("next_retry_at");
  }
  if (destination === "Archive" && reason === "review_rejected") {
    for (const field of [
      "review_case_id",
      "review_case_version",
      "review_decision",
      "review_decided_at"
    ]) destinationOwned.add(field);
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

function destinationRecord(
  source,
  destination,
  reason,
  now,
  existing,
  confirmationTrust
) {
  const preserveStrongerAutonomousConfirmation =
    reason === "autonomous_confirmed" &&
    strongerAutonomousConfirmation(source, existing, confirmationTrust);
  const record = {
    ...source,
    row_number: undefined,
    user_action: existing?.user_action || "",
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
    record.applied_at =
      preserveStrongerAutonomousConfirmation
        ? existing.submission_confirmed_at
        : reason === "autonomous_confirmed"
          ? source.submission_confirmed_at
        : existing?.applied_at || source.applied_at || now;
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
    if (reason === "review_rejected") {
      record.review_case_id = source.review_case_id || reviewCaseId(source);
      record.review_case_version = "review-case-v1";
      record.review_decision = "reject";
      record.review_decided_at = existing?.review_decided_at || now;
    }
  } else {
    record.applied_at = "";
    record.archived_at = "";
    record.archive_reason = "";
    record.notes = existing ? existing.notes || "" : source.notes || "";
    if (destination === "To Review") {
      record.review_case_id = reviewCaseId(source);
      record.review_case_version = "review-case-v1";
      record.review_decision = "";
      record.review_decided_at = "";
      record.review_approved_at = "";
      record.review_approval_note = "";
      record.review_approval_guard = "";
    }
    if (destination === "To Apply" && reason === "review_proceeded") {
      record.pipeline_status = "ready_to_apply";
      record.review_case_id = source.review_case_id || reviewCaseId(source);
      record.review_case_version = "review-case-v1";
      record.review_decision = "proceed";
      record.review_decided_at = existing?.review_decided_at || now;
      record.review_approved_at = record.review_decided_at;
      record.review_approval_note = sanitize(
        existing?.review_approval_note ||
          source.review_approval_note ||
          source.notes,
        1000
      );
      record.review_approval_guard = applicationReviewGuard(source);
      record.prep_status = "pending";
      record.preparation_version = Math.max(
        1,
        Number(source.preparation_version || 0) + 1,
        Number(existing?.preparation_version || 0)
      );
      record.preparation_updated_at =
        existing?.preparation_updated_at || now;
      record.preparation_input_guard = preparationInputGuard(record);
      record.next_retry_at = "";
      record.error_category = "";
      record.error_summary = "";
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
  if (preserveStrongerAutonomousConfirmation) {
    for (const field of AUTONOMOUS_CONFIRMATION_RECEIPT_FIELDS) {
      record[field] = existing[field];
    }
  }
  if (
    [
      "user_applied",
      "user_skip",
      "autonomous_confirmed",
      "autonomous_skip"
    ].includes(reason)
  ) {
    // An operator terminal action wins over an in-flight or retryable Slack
    // delivery. The destination must never retain `sending` after movement
    // clears the source claim token, otherwise the record fails its own store
    // contract and becomes stranded in To Apply.
    if (["pending", "sending", "retryable_failure"].includes(record.alert_status)) {
      record.alert_status = "suppressed";
      const autonomousTerminal = reason.startsWith("autonomous_");
      record.alert_error_category = autonomousTerminal
        ? "autonomous_terminal_state"
        : "operator_terminal_action";
      record.alert_error_summary = autonomousTerminal
        ? "Slack alert cancelled because autonomous execution reached a terminal state."
        : "Slack alert cancelled because the operator completed a terminal queue action.";
    }
    record.alert_claim_token = "";
    record.alert_next_retry_at = "";
  }
  record.state_guard = stateGuard(record);
  return record;
}

function classifyQueueRow(sourceSheet, record, schema, confirmationTrust) {
  if (isAutonomousRecord(record)) {
    if (record.user_action) {
      return {
        suppressed: true,
        reason: "forged_autonomous_action",
        summary: "Autonomous records cannot use legacy manual queue actions"
      };
    }
    if (record.browser_state === "confirmed") {
      const confirmationErrors = autonomousConfirmationErrors(
        record,
        confirmationTrust
      );
      return confirmationErrors.length === 0
        ? { destination: "Applied Jobs", reason: "autonomous_confirmed" }
        : {
            suppressed: true,
            reason: "invalid_autonomous_confirmation",
            summary: `Autonomous confirmation is incomplete: ${confirmationErrors.join(", ")}`
          };
    }
    if (
      record.autonomous_decision === "skip" ||
      record.browser_state === "skipped"
    ) {
      return validAutonomousSkip(record)
        ? { destination: "Archive", reason: "autonomous_skip" }
        : {
            suppressed: true,
            reason: "invalid_autonomous_skip",
            summary: "Autonomous skip evidence is incomplete or contradictory"
          };
    }
    if (
      AUTONOMOUS_NON_MOVABLE_STATES.has(String(record.browser_state || "")) ||
      record.browser_state === ""
    ) {
      return null;
    }
    return {
      suppressed: true,
      reason: "invalid_autonomous_state",
      summary: "Autonomous browser state is unsupported for movement"
    };
  }
  if (
    sourceSheet === "Scraped Jobs" &&
    isGuardedLegacyReviewAction(record, sourceSheet, schema)
  ) {
    return record.user_action === "Proceed"
      ? { destination: "To Apply", reason: "review_proceeded" }
      : { destination: "Archive", reason: "review_rejected" };
  }
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
    const currentCase = reviewCaseId(record);
    if (
      record.review_decision === "proceed" &&
      record.review_case_id === currentCase
    ) {
      return {
        suppressed: true,
        reason: "resolved_review_case_repeated",
        summary:
          "The resolved review case cannot be reopened from unchanged preparation facts"
      };
    }
    if (
      record.review_decision &&
      (!record.review_case_id || record.review_case_id === currentCase)
    ) {
      return {
        suppressed: true,
        reason: "review_reopen_missing_new_case",
        summary:
          "A resolved decision requires a materially different review case before reopening"
      };
    }
    if (
      record.review_decision &&
      (!String(record.decision_reason || "").trim() ||
        !String(record.required_input || "").trim())
    ) {
      return {
        suppressed: true,
        reason: "review_reopen_missing_reason",
        summary:
          "A materially new review case requires an explicit bounded reason and required input"
      };
    }
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
    record.user_action === "Reject"
  ) {
    return { destination: "Archive", reason: "review_rejected" };
  }
  if (
    sourceSheet === "To Review" &&
    record.pipeline_status === "review_needed" &&
    record.user_action === "Proceed"
  ) {
    return { destination: "To Apply", reason: "review_proceeded" };
  }
  return null;
}

export function planQueueActions(
  stores,
  schema,
  now = new Date().toISOString(),
  messageSafetyContext,
  {
    movementPerRunCap = Number.POSITIVE_INFINITY,
    confirmationTrust = messageSafetyContext?.confirmationTrust
  } = {}
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
      if (!stateGuardMatches(source)) {
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
        classification = classifyQueueRow(
          sourceSheet,
          source,
          schema,
          confirmationTrust
        );
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
        if (classification.suppressed) {
          rejected.push({
            canonical_job_id: source.canonical_job_id,
            source_sheet: sourceSheet,
            reason: classification.reason,
            summary: sanitize(classification.summary)
          });
        } else {
          candidates.push({ sourceSheet, source, classification });
        }
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
        classification.reason,
        source,
        confirmationTrust
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
      schema,
      confirmationTrust
    );
    const destination = existingComplete
      ? { ...existing }
      : destinationRecord(
          source,
          classification.destination,
          classification.reason,
          now,
          existing,
          confirmationTrust
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
      source_copy_digest: recordCopyDigest(source, schema),
      source_record_version: source.record_version,
      source_status: source.pipeline_status,
      source_action: source.user_action,
      source_notes: source.notes || "",
      destination: classification.destination,
      route_reason: classification.reason,
      claim_scope: [
        sourceSheet,
        classification.destination,
        ...(classification.reason.startsWith("autonomous_")
          ? [
              classification.reason,
              source.submission_idempotency_key || source.browser_attempt_id
            ]
          : [])
      ]
        .filter(Boolean)
        .join(":"),
      archive_reason:
        classification.destination === "Archive"
          ? classification.reason
          : "",
      write_required: !existingComplete,
      recovery_required: Boolean(existing),
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
  schema,
  confirmationTrust
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
      stateGuardMatches(source) &&
      source.state_guard === plan.source_state_guard &&
      recordCopyDigest(source, schema) === plan.source_copy_digest &&
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
        schema,
        confirmationTrust
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
