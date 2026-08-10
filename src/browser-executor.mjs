import { createHash } from "node:crypto";

import {
  buildApplicationPack,
  cleanGeneratedMessage,
  evaluateJob,
  validateApplicationPack,
  validateGeneratedMessage
} from "./evaluation.mjs";
import {
  browserJobDigest as contractBrowserJobDigest,
  browserSubmitAuthorizationDigest,
  extractOnlineJobsId,
  normalizeCanonicalUrl,
  stateGuard,
  stateGuardMatches,
  submissionIdempotencyKey as contractSubmissionIdempotencyKey,
  validateRecordStoreContract,
  validateUniqueIdentityAcrossStores
} from "./contracts.mjs";
import {
  createSystemClaim,
  selectWinningSystemClaims
} from "./system-claims.mjs";
import {
  BROWSER_EXECUTOR_PROTOCOL_VERSION,
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  verifyBrowserConfirmationAttestation
} from "./browser-confirmation-attestation.mjs";

export { BROWSER_EXECUTOR_PROTOCOL_VERSION };
export const BROWSER_AUTOMATION_CONTRACT_VERSION = "browser-contract-v1";
export const AUTONOMOUS_SOURCE_STORE = "Scraped Jobs";

const DUE_STATES = new Set(["queued", "retryable"]);
const ACTIVE_PRE_SUBMIT_STATES = new Set([
  "claimed",
  "evaluating",
  "generating",
  "filling"
]);
const SAFE_RESULT_CATEGORIES = new Set([
  "missing_candidate_fact",
  "login_required",
  "challenge",
  "captcha",
  "unexpected_agreement",
  "unsafe_upload",
  "unsupported_external_step",
  "invalid_form",
  "policy_mismatch",
  "unsafe_page_content",
  "posting_unavailable",
  "navigation_failed",
  "transient_browser_failure",
  "submission_uncertain",
  "submission_rejected",
  "confirmation_mismatch",
  "submission_confirmed"
]);
const CONFIRMATION_KINDS = new Set([
  "confirmation_page",
  "application_history"
]);
const SAFE_EVIDENCE_SUMMARIES = Object.freeze(
  Object.fromEntries(
    [...SAFE_RESULT_CATEGORIES].map((category) => [
      category,
      `Browser result: ${category.replaceAll("_", " ")}`
    ])
  )
);
const RESULT_CATEGORIES = Object.freeze({
  retryable: new Set(["navigation_failed", "transient_browser_failure"]),
  blocked: new Set([
    "missing_candidate_fact",
    "login_required",
    "challenge",
    "captcha",
    "unexpected_agreement",
    "unsafe_upload",
    "unsupported_external_step",
    "invalid_form",
    "policy_mismatch",
    "unsafe_page_content",
    "submission_rejected",
    "confirmation_mismatch"
  ]),
  unavailable: new Set(["posting_unavailable"]),
  ambiguous: new Set(["submission_uncertain"]),
  confirmed: new Set(["submission_confirmed"])
});
const CONTEXT_JOB_FIELDS = [
  "source",
  "source_job_id",
  "canonical_job_id",
  "canonical_url",
  "job_title",
  "company",
  "job_description",
  "salary_text",
  "posted_at",
  "source_availability",
  "role_families",
  "matched_keywords"
];
const CLAIM_CONFIRM_FIELDS = [
  "canonical_job_id",
  "record_version",
  "execution_mode",
  "automation_contract_version",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "state_guard",
  "user_action",
  "notes"
];
const SUBMIT_INTENT_CONFIRM_FIELDS = [
  "canonical_job_id",
  "record_version",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "browser_form_fingerprint",
  "submission_idempotency_key",
  "submission_started_at",
  "message_profile_version",
  "message_policy_version",
  "application_pack_version",
  "application_pack_policy_version",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "state_guard"
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value ?? "";
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function requireExactKeys(value, required, optional = [], label = "payload") {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} keys are invalid` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extra.length ? `; unsupported: ${extra.join(", ")}` : ""}`
    );
  }
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(String(value || "")));
}

function requireTimestamp(value, label) {
  if (!validTimestamp(value)) throw new Error(`${label} must be an ISO timestamp`);
  return String(value);
}

function boundedSafeText(value, maximum = 240) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(
      /\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi,
      "[redacted]"
    )
    .replace(
      /\b(?:authorization|cookie|password|api[-_ ]?key|token|secret|webhook|private[-_ ]?key)\s*[:=]\s*\S+/gi,
      "[redacted]"
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function assertAutonomous(record) {
  if (record?.execution_mode !== "autonomous_chrome") {
    throw new Error("Browser executor requires explicit autonomous_chrome mode");
  }
  if (
    record?.automation_contract_version !==
    BROWSER_AUTOMATION_CONTRACT_VERSION
  ) {
    throw new Error("Browser executor automation contract is stale or missing");
  }
  if (String(record?.user_action || "").trim()) {
    throw new Error("Autonomous rows cannot carry a manual user action");
  }
}

function requireCurrentGuard(record, label = "record") {
  if (!stateGuardMatches(record)) {
    throw new Error(`${label} state guard is stale`);
  }
}

function nextRecord(record, updates, now) {
  const next = {
    ...record,
    ...updates,
    record_version: Number(record.record_version || 0) + 1,
    updated_at: now
  };
  return { ...next, state_guard: stateGuard(next) };
}

function requireValidProposedRecord(record, schema) {
  const errors = validateRecordStoreContract(
    record,
    AUTONOMOUS_SOURCE_STORE,
    schema
  );
  if (errors.length > 0) {
    throw new Error(`Browser executor proposed an invalid record: ${errors.join("; ")}`);
  }
  return record;
}

function exactFieldMismatches(expected, actual, fields) {
  return fields.filter(
    (field) =>
      JSON.stringify(stableValue(expected?.[field])) !==
      JSON.stringify(stableValue(actual?.[field]))
  );
}

function requireCurrentConfiguration(record, {
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy
}) {
  const mismatches = [];
  if (record.message_profile_version !== profile?.profile_version) {
    mismatches.push("message_profile_version");
  }
  if (record.application_pack_profile_version !== profile?.profile_version) {
    mismatches.push("application_pack_profile_version");
  }
  if (record.message_policy_version !== applicationPolicy?.policy_version) {
    mismatches.push("message_policy_version");
  }
  if (record.application_pack_policy_version !== packPolicy?.policy_version) {
    mismatches.push("application_pack_policy_version");
  }
  if (record.application_pack_version !== packPolicy?.pack_version) {
    mismatches.push("application_pack_version");
  }
  const expectedContextDigest = browserContextDigest({
    record,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (record.browser_context_digest !== expectedContextDigest) {
    mismatches.push("browser_context_digest");
  }
  if (mismatches.length > 0) {
    throw new Error(`Browser authorization configuration is stale: ${mismatches.join(", ")}`);
  }
}

function requireWinningBrowserClaim(record, persistedClaims, now) {
  requireTimestamp(now, "browser authorization now");
  if (
    record.processing_stage !== "browser_executor" ||
    !String(record.processing_token || "").trim() ||
    !validTimestamp(record.processing_started_at)
  ) {
    throw new Error("Browser authorization requires a persisted live claim");
  }
  const matching = (Array.isArray(persistedClaims) ? persistedClaims : []).filter(
    (claim) =>
      claim?.token === record.processing_token &&
      claim?.canonical_job_id === record.canonical_job_id &&
      claim?.stage === "browser_executor" &&
      claim?.created_at === record.processing_started_at
  );
  if (
    matching.length !== 1 ||
    selectWinningSystemClaims(matching, persistedClaims, now).length !== 1
  ) {
    throw new Error("Browser authorization claim is expired, lost, or not the winner");
  }
}

function oneIdentity(rows, canonicalJobId, label) {
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row?.canonical_job_id || "") === canonicalJobId
  );
  if (!canonicalJobId || matches.length !== 1) {
    throw new Error(`${label} identity is missing or ambiguous`);
  }
  return matches[0];
}

function persistedPack(record, pack) {
  return {
    application_instructions: pack.application_instructions,
    screening_questions: pack.screening_questions,
    requirement_coverage: pack.requirement_coverage,
    application_message_plan: [pack.message_plan],
    selected_proof_refs: pack.selected_proof_refs,
    application_warnings: pack.application_warnings,
    application_pack_status: pack.application_pack_status,
    application_pack_version: pack.application_pack_version,
    application_pack_profile_version: pack.application_pack_profile_version,
    application_pack_policy_version: pack.application_pack_policy_version,
    coverage_contract_version: pack.coverage_contract_version,
    message_plan_version: pack.message_plan.version,
    application_pack_generated_at: pack.application_pack_generated_at
  };
}

function boundedContextJob(record, packPolicy = {}) {
  const configured = Number(packPolicy.maximum_description_characters);
  const maximumDescription = Number.isInteger(configured) && configured > 0
    ? Math.min(configured * 2, 100000)
    : 100000;
  return Object.fromEntries(
    CONTEXT_JOB_FIELDS.map((field) => [
      field,
      field === "job_description"
        ? String(record?.[field] ?? "").slice(0, maximumDescription)
        : record?.[field] ?? ""
    ])
  );
}

export function browserJobDigest(record) {
  return contractBrowserJobDigest(record);
}

export function browserContextDigest({
  record,
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy
}) {
  return `context-v1:${digest({
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    automation_contract_version: BROWSER_AUTOMATION_CONTRACT_VERSION,
    job: boundedContextJob(record, packPolicy),
    profile,
    ranking_policy: rankingPolicy,
    application_policy: applicationPolicy,
    pack_policy: packPolicy
  })}`;
}

export function browserFormFingerprint(form, record) {
  requireExactKeys(
    form,
    [
      "origin",
      "page_url",
      "observed_source_job_id",
      "action",
      "method",
      "fields",
      "apply_points",
      "apply_point_options"
    ],
    [],
    "form fingerprint input"
  );
  if (!record || typeof record !== "object") {
    throw new Error("Form fingerprint requires the claimed job record");
  }
  const origin = new URL(String(form.origin));
  const page = new URL(String(form.page_url), origin);
  const action = new URL(String(form.action), origin);
  const allowedHosts = new Set(["onlinejobs.ph", "www.onlinejobs.ph"]);
  const sourceJobId = String(record.source_job_id || "");
  const normalizedPage = normalizeCanonicalUrl(page.href);
  const normalizedRecordPage = normalizeCanonicalUrl(record.canonical_url);
  const actionMatch = action.pathname.match(
    /^\/jobseekers\/job\/([^/]+)\/apply\/?$/i
  );
  const actionSourceJobId = actionMatch?.[1]?.match(/(\d+)$/)?.[1] || "";
  if (
    origin.protocol !== "https:" ||
    !allowedHosts.has(origin.hostname) ||
    page.origin !== origin.origin ||
    action.protocol !== origin.protocol ||
    action.hostname !== origin.hostname ||
    !sourceJobId ||
    String(form.observed_source_job_id) !== sourceJobId ||
    extractOnlineJobsId(normalizedPage) !== sourceJobId ||
    normalizedPage !== normalizedRecordPage ||
    !actionMatch ||
    actionSourceJobId !== sourceJobId
  ) {
    throw new Error("Form must match the claimed OnlineJobs.ph job and application action");
  }
  if (String(form.method).toUpperCase() !== "POST") {
    throw new Error("Application form method must be POST");
  }
  if (!Array.isArray(form.fields) || form.fields.length < 1) {
    throw new Error("Application form must expose a bounded field inventory");
  }
  const fields = form.fields.map((field, index) => {
    requireExactKeys(
      field,
      ["name", "type", "required"],
      ["maximum_length", "options_digest"],
      `form field ${index}`
    );
    const name = String(field.name || "").trim().slice(0, 120);
    const type = String(field.type || "").trim().toLowerCase();
    if (!name || !/^[a-z0-9_.\[\]-]+$/i.test(name)) {
      throw new Error(`Form field ${index} has an invalid name`);
    }
    if (
      ![
        "hidden",
        "text",
        "textarea",
        "select",
        "radio",
        "checkbox",
        "submit"
      ].includes(type)
    ) {
      throw new Error(`Form field ${index} type is unsupported`);
    }
    return {
      name,
      type,
      required: field.required === true,
      maximum_length: Number.isInteger(field.maximum_length)
        ? field.maximum_length
        : "",
      options_digest: String(field.options_digest || "").slice(0, 64)
    };
  });
  if (new Set(fields.map((field) => field.name)).size !== fields.length) {
    throw new Error("Application form contains duplicate field names");
  }
  const messageFields = fields.filter(
    (field) =>
      field.name === "message" &&
      field.type === "textarea" &&
      field.required === true
  );
  const applyPointFields = fields.filter(
    (field) =>
      field.name === "apply_points" &&
      field.type === "select" &&
      field.required === true &&
      /^[a-f0-9]{64}$/.test(field.options_digest)
  );
  const unsupportedRequired = fields.filter(
    (field) =>
      field.required &&
      !["hidden", "submit"].includes(field.type) &&
      !["message", "apply_points"].includes(field.name)
  );
  const applyPointOptions = Array.isArray(form.apply_point_options)
    ? [...form.apply_point_options].sort((left, right) => left - right)
    : [];
  if (
    messageFields.length !== 1 ||
    applyPointFields.length !== 1 ||
    unsupportedRequired.length > 0 ||
    applyPointOptions.length < 1 ||
    new Set(applyPointOptions).size !== applyPointOptions.length ||
    applyPointOptions.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 100
    ) ||
    !Number.isInteger(form.apply_points) ||
    form.apply_points < 1 ||
    form.apply_points > 100 ||
    !applyPointOptions.includes(form.apply_points) ||
    applyPointFields[0]?.options_digest !== digest(applyPointOptions)
  ) {
    throw new Error("Application form fields or live Apply Points are unsupported");
  }
  const normalized = {
    origin: origin.origin,
    page_url: normalizedPage,
    source_job_id: sourceJobId,
    action: `${action.pathname}${action.search}`,
    method: "POST",
    fields: fields.sort((left, right) =>
      `${left.name}:${left.type}`.localeCompare(`${right.name}:${right.type}`)
    ),
    apply_points: form.apply_points,
    apply_point_options: applyPointOptions
  };
  return `form-v1:${digest(normalized)}`;
}

export function submissionIdempotencyKey(record) {
  const key = contractSubmissionIdempotencyKey(record);
  if (!key) throw new Error("Submission identity is incomplete");
  return key;
}

export function sanitizeBrowserEvidence(input = {}) {
  requireExactKeys(
    input,
    ["category"],
    ["summary", "observed_at", "reference_digest"],
    "browser evidence"
  );
  if (!SAFE_RESULT_CATEGORIES.has(input.category)) {
    throw new Error("Browser evidence category is unsupported");
  }
  return {
    category: input.category,
    // Browser/model prose is untrusted and may contain a job description,
    // generated message, credential, or DOM text. Persist a fixed summary from
    // the trusted category vocabulary instead of trying to redact arbitrary
    // caller content.
    summary: SAFE_EVIDENCE_SUMMARIES[input.category],
    observed_at: input.observed_at
      ? requireTimestamp(input.observed_at, "browser evidence observed_at")
      : "",
    reference_digest: /^[a-f0-9]{64}$/.test(input.reference_digest || "")
      ? input.reference_digest
      : ""
  };
}

export function selectAutonomousCandidates(
  stores,
  schema,
  {
    now = new Date().toISOString(),
    deadline_ms = Number.POSITIVE_INFINITY,
    minimum_headroom_ms = 0
  } = {}
) {
  if (!isPlainObject(stores)) throw new Error("Business stores must be an object");
  const identityErrors = validateUniqueIdentityAcrossStores(stores, schema, now);
  if (identityErrors.length > 0) {
    throw new Error(`Browser selection rejected business stores: ${identityErrors.join("; ")}`);
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Browser selection now is invalid");
  if (
    !Number.isInteger(minimum_headroom_ms) ||
    minimum_headroom_ms < 0 ||
    (Number.isFinite(deadline_ms) && deadline_ms - nowMs < minimum_headroom_ms)
  ) {
    return [];
  }
  const rows = stores[AUTONOMOUS_SOURCE_STORE] ?? [];
  if (!Array.isArray(rows)) throw new Error("Scraped Jobs rows must be an array");
  return rows
    .filter((record) => {
      const errors = validateRecordStoreContract(
        record,
        AUTONOMOUS_SOURCE_STORE,
        schema
      );
      if (errors.length > 0) {
        throw new Error(`Browser selection rejected invalid row: ${errors.join("; ")}`);
      }
      if (record.execution_mode !== "autonomous_chrome") return false;
      if (!DUE_STATES.has(String(record.browser_state || ""))) return false;
      const retryAt = Date.parse(record.browser_next_retry_at || record.next_retry_at || "");
      return !Number.isFinite(retryAt) || retryAt <= nowMs;
    })
    .sort((left, right) => {
      const time = Date.parse(left.created_at || "") - Date.parse(right.created_at || "");
      return time || String(left.canonical_job_id).localeCompare(String(right.canonical_job_id));
    });
}

export function planAutonomousClaim(
  record,
  {
    execution_id,
    now = new Date().toISOString(),
    lease_ms,
    attempt_id
  }
) {
  assertAutonomous(record);
  requireCurrentGuard(record);
  if (!DUE_STATES.has(String(record.browser_state || ""))) {
    throw new Error("Browser claim requires a queued or retryable row");
  }
  if (!String(execution_id || "").trim() || !Number.isInteger(lease_ms) || lease_ms < 1) {
    throw new Error("Browser claim requires execution ID and positive lease");
  }
  requireTimestamp(now, "browser claim now");
  const normalizedAttemptId = String(attempt_id || "").trim() ||
    `attempt-v1:${digest({
      execution_id,
      canonical_job_id: record.canonical_job_id,
      now
    })}`;
  if (!/^attempt-v1:[a-f0-9]{64}$/.test(normalizedAttemptId)) {
    throw new Error("Browser attempt ID is invalid");
  }
  const claim = createSystemClaim({
    stage: "browser_executor",
    canonicalJobId: record.canonical_job_id,
    scope: "application",
    executionId: execution_id,
    now,
    leaseMs: lease_ms
  });
  const proposedRecord = nextRecord(
    record,
    {
      browser_state: "claimed",
      browser_attempt_id: normalizedAttemptId,
      browser_job_digest: browserJobDigest(record),
      processing_stage: "browser_executor",
      processing_token: claim.token,
      processing_started_at: now,
      browser_block_category: "",
      error_category: "",
      error_summary: ""
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    source_store: AUTONOMOUS_SOURCE_STORE,
    expected_source_guard: record.state_guard,
    system_claim: claim,
    proposed_record: proposedRecord,
    confirm_fields: CLAIM_CONFIRM_FIELDS,
    telemetry: {
      event: "claim_planned",
      canonical_job_id: record.canonical_job_id,
      attempt_id: normalizedAttemptId,
      browser_state: "claimed"
    }
  };
}

export function confirmAutonomousClaim(
  plan,
  { persisted_claims, fresh_source_rows, schema, now = new Date().toISOString() },
  configuration
) {
  requireExactKeys(
    plan,
    [
      "protocol_version",
      "source_store",
      "expected_source_guard",
      "system_claim",
      "proposed_record",
      "confirm_fields",
      "telemetry"
    ],
    [],
    "claim plan"
  );
  if (plan.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION) {
    throw new Error("Claim plan protocol is stale");
  }
  const winners = selectWinningSystemClaims(
    [plan.system_claim],
    persisted_claims,
    now
  );
  if (winners.length !== 1) throw new Error("Browser claim did not win contention");
  const persisted = oneIdentity(
    fresh_source_rows,
    plan.proposed_record.canonical_job_id,
    "Browser claim confirmation"
  );
  const mismatches = exactFieldMismatches(
    plan.proposed_record,
    persisted,
    CLAIM_CONFIRM_FIELDS
  );
  if (mismatches.length > 0) {
    throw new Error(`Browser claim persistence mismatch: ${mismatches.join(", ")}`);
  }
  requireCurrentGuard(persisted, "Persisted browser claim");
  const errors = validateRecordStoreContract(persisted, AUTONOMOUS_SOURCE_STORE, schema);
  if (errors.length > 0) throw new Error(`Persisted browser claim is invalid: ${errors.join("; ")}`);
  const contextDigest = browserContextDigest({ record: persisted, ...configuration });
  const evaluating = nextRecord(
    persisted,
    {
      browser_state: "evaluating",
      browser_context_digest: contextDigest
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: evaluating.browser_attempt_id,
    context_digest: contextDigest,
    job_digest: evaluating.browser_job_digest,
    proposed_record: evaluating,
    confirm_fields: CLAIM_CONFIRM_FIELDS,
    job: boundedContextJob(evaluating, configuration.packPolicy),
    profile: configuration.profile,
    ranking_policy: configuration.rankingPolicy,
    application_policy: configuration.applicationPolicy,
    pack_policy: configuration.packPolicy
  };
}

export function validateAutonomousDecision(
  freshRecord,
  decision,
  {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy,
    context_digest,
    form
  },
  now = new Date().toISOString()
) {
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  if (freshRecord.browser_state !== "evaluating") {
    throw new Error("Autonomous decision requires a persisted evaluating row");
  }
  requireExactKeys(
    decision,
    ["protocol_version", "attempt_id", "context_digest", "decision", "reason_code"],
    ["message"],
    "ChatGPT decision"
  );
  if (
    decision.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION ||
    decision.attempt_id !== freshRecord.browser_attempt_id ||
    decision.context_digest !== context_digest ||
    decision.context_digest !== freshRecord.browser_context_digest
  ) {
    throw new Error("ChatGPT decision is not bound to the winning context");
  }
  if (!['apply', 'skip'].includes(decision.decision)) {
    throw new Error("ChatGPT decision must be apply or skip");
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(decision.reason_code || ""))) {
    throw new Error("ChatGPT reason_code must use the bounded code vocabulary");
  }
  const expectedContextDigest = browserContextDigest({
    record: freshRecord,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (context_digest !== expectedContextDigest) {
    throw new Error("Autonomous context changed before decision validation");
  }
  if (freshRecord.browser_job_digest !== browserJobDigest(freshRecord)) {
    throw new Error("Job input changed after the browser claim");
  }
  const evaluation = evaluateJob(freshRecord, profile, rankingPolicy, now);
  if (decision.decision === "skip") {
    if (!["not_recommended", "unavailable"].includes(evaluation.match_decision)) {
      throw new Error("ChatGPT cannot skip an eligible or ambiguous job");
    }
    const skipped = nextRecord(
      freshRecord,
      {
        ...evaluation,
        autonomous_decision: "skip",
        browser_state: "skipped",
        pipeline_status: "skip",
        decision_reason: `autonomous_${evaluation.match_decision}`,
        processing_stage: "",
        processing_token: "",
        processing_started_at: ""
      },
      now
    );
    return {
      outcome: "skip",
      proposed_record: skipped,
      telemetry: {
        event: "autonomous_skip",
        canonical_job_id: skipped.canonical_job_id,
        attempt_id: skipped.browser_attempt_id,
        reason_code: decision.reason_code
      }
    };
  }
  if (evaluation.match_decision !== "recommended") {
    throw new Error("Only deterministically recommended jobs may be applied to");
  }
  const pack = buildApplicationPack(
    { ...freshRecord, ...evaluation, user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const packErrors = validateApplicationPack(pack, profile, packPolicy);
  if (pack.application_pack_status !== "ready" || packErrors.length > 0) {
    throw new Error(`Autonomous application pack is not ready: ${packErrors.join("; ")}`);
  }
  const message = cleanGeneratedMessage(decision.message || "");
  const messageValidation = validateGeneratedMessage(message, {
    job: freshRecord,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (!messageValidation.valid) {
    throw new Error(`ChatGPT message is invalid: ${messageValidation.errors.join("; ")}`);
  }
  const formFingerprint = browserFormFingerprint(form, freshRecord);
  const identityRecord = {
    ...freshRecord,
    ...evaluation,
    ...persistedPack(freshRecord, pack),
    browser_form_fingerprint: formFingerprint,
    generated_message: message,
    message_profile_version: profile.profile_version,
    message_policy_version: applicationPolicy.policy_version
  };
  const idempotencyKey = submissionIdempotencyKey(identityRecord);
  const filling = nextRecord(
    freshRecord,
    {
      ...evaluation,
      ...persistedPack(freshRecord, pack),
      autonomous_decision: "apply",
      browser_state: "generating",
      browser_form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey,
      pipeline_status: "ready_to_apply",
      generated_message: message,
      message_profile_version: profile.profile_version,
      message_policy_version: applicationPolicy.policy_version,
      message_validation_status: "valid",
      generated_at: now,
      processing_stage: "browser_executor",
      error_category: "",
      error_summary: ""
    },
    now
  );
  return {
    outcome: "generate_validated",
    proposed_record: filling,
    telemetry: {
      event: "draft_validated",
      canonical_job_id: filling.canonical_job_id,
      attempt_id: filling.browser_attempt_id,
      message_digest: digest(message),
      pack_digest: digest(persistedPack(freshRecord, pack)),
      form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey
    }
  };
}

export function confirmBrowserReady(
  plannedRecord,
  freshSourceRows,
  { profile, rankingPolicy, applicationPolicy, packPolicy, persistedClaims },
  now = new Date().toISOString()
) {
  const persisted = oneIdentity(
    freshSourceRows,
    plannedRecord?.canonical_job_id,
    "Browser fill authorization"
  );
  const fields = [
    "record_version",
    "browser_state",
    "browser_attempt_id",
    "browser_job_digest",
    "browser_context_digest",
    "generated_message",
    "message_profile_version",
    "message_policy_version",
    "message_validation_status",
    "application_pack_status",
    "application_pack_version",
    "application_pack_policy_version",
    "state_guard",
    "user_action",
    "notes"
  ];
  const mismatches = exactFieldMismatches(plannedRecord, persisted, fields);
  if (mismatches.length > 0) {
    throw new Error(`Browser fill persistence mismatch: ${mismatches.join(", ")}`);
  }
  assertAutonomous(persisted);
  requireCurrentGuard(persisted);
  requireWinningBrowserClaim(persisted, persistedClaims, now);
  requireCurrentConfiguration(persisted, {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (!["generating", "filling"].includes(persisted.browser_state)) {
    throw new Error("Browser fill authorization requires generating or filling state");
  }
  const pack = buildApplicationPack(
    { ...persisted, user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    persisted.application_pack_generated_at
  );
  if (pack.application_pack_status !== "ready") {
    throw new Error("Persisted autonomous pack is no longer ready");
  }
  const validation = validateGeneratedMessage(persisted.generated_message, {
    job: persisted,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (!validation.valid) {
    throw new Error(`Persisted message failed safety: ${validation.errors.join("; ")}`);
  }
  if (persisted.browser_state === "generating") {
    const filling = nextRecord(
      persisted,
      { browser_state: "filling" },
      now
    );
    return {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      proposed_record: filling,
      confirm_fields: fields,
      telemetry: {
        event: "filling_planned",
        canonical_job_id: filling.canonical_job_id,
        attempt_id: filling.browser_attempt_id
      }
    };
  }
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    capability: "fill_application_form",
    attempt_id: persisted.browser_attempt_id,
    canonical_job_id: persisted.canonical_job_id,
    job_digest: persisted.browser_job_digest,
    message: persisted.generated_message,
    message_digest: digest(persisted.generated_message)
  };
}

export function planSubmitIntent(
  freshRecord,
  { form, field_receipts, now = new Date().toISOString() }
) {
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  if (freshRecord.browser_state !== "filling") {
    throw new Error("Submit intent requires filling state");
  }
  if (freshRecord.browser_job_digest !== browserJobDigest(freshRecord)) {
    throw new Error("Job input changed before submit intent");
  }
  const formFingerprint = browserFormFingerprint(form, freshRecord);
  if (formFingerprint !== freshRecord.browser_form_fingerprint) {
    throw new Error("Application form changed after draft validation");
  }
  if (!Array.isArray(field_receipts) || field_receipts.length < 1) {
    throw new Error("Submit intent requires bounded field reread receipts");
  }
  const requiredFields = form.fields
    .filter((field) => field.required && !["hidden", "submit"].includes(field.type))
    .map((field) => field.name);
  const receipts = new Map();
  for (const [index, receipt] of field_receipts.entries()) {
    requireExactKeys(
      receipt,
      ["name", "value_digest"],
      [],
      `field reread receipt ${index}`
    );
    const name = String(receipt.name || "");
    if (
      receipts.has(name) ||
      !requiredFields.includes(name) ||
      !/^[a-f0-9]{64}$/.test(String(receipt.value_digest || ""))
    ) {
      throw new Error("Field reread receipt is duplicate, unexpected, or malformed");
    }
    receipts.set(name, receipt.value_digest);
  }
  const missing = requiredFields.filter((field) => !receipts.has(field));
  if (missing.length > 0) {
    throw new Error(`Required application fields were not reread: ${missing.join(", ")}`);
  }
  const expectedReceipts = new Map([
    ["message", digest(freshRecord.generated_message)],
    ["apply_points", digest(String(form.apply_points))]
  ]);
  for (const field of requiredFields) {
    if (receipts.get(field) !== expectedReceipts.get(field)) {
      throw new Error(`Reread value does not match the authorized ${field} value`);
    }
  }
  const identitySource = {
    ...freshRecord,
    browser_form_fingerprint: formFingerprint
  };
  const idempotencyKey = submissionIdempotencyKey(identitySource);
  if (idempotencyKey !== freshRecord.submission_idempotency_key) {
    throw new Error("Submission identity changed before submit intent");
  }
  const proposedRecord = nextRecord(
    freshRecord,
    {
      browser_state: "submit_started",
      browser_form_fingerprint: formFingerprint,
      submission_idempotency_key: idempotencyKey,
      submission_started_at: now,
      submission_confirmed_at: "",
      submission_confirmation_kind: "",
      submission_confirmation_reference: "",
      submission_confirmation_digest: "",
      submission_attestation_key_id: "",
      submission_attestation_witness_digest: "",
      submission_attestation_signature: ""
    },
    now
  );
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    source_store: AUTONOMOUS_SOURCE_STORE,
    proposed_record: proposedRecord,
    confirm_fields: SUBMIT_INTENT_CONFIRM_FIELDS,
    telemetry: {
      event: "submit_intent_planned",
      canonical_job_id: proposedRecord.canonical_job_id,
      attempt_id: proposedRecord.browser_attempt_id,
      submission_idempotency_key: idempotencyKey,
      form_fingerprint: formFingerprint
    }
  };
}

export function confirmSubmitIntent(
  plan,
  freshSourceRows,
  { persistedClaims, profile, rankingPolicy, applicationPolicy, packPolicy, now }
) {
  if (plan?.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION) {
    throw new Error("Submit intent plan protocol is stale");
  }
  const persisted = oneIdentity(
    freshSourceRows,
    plan?.proposed_record?.canonical_job_id,
    "Submit intent confirmation"
  );
  const mismatches = exactFieldMismatches(
    plan.proposed_record,
    persisted,
    SUBMIT_INTENT_CONFIRM_FIELDS
  );
  if (mismatches.length > 0) {
    throw new Error(`Submit intent persistence mismatch: ${mismatches.join(", ")}`);
  }
  assertAutonomous(persisted);
  requireCurrentGuard(persisted);
  requireWinningBrowserClaim(persisted, persistedClaims, now);
  requireCurrentConfiguration(persisted, {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  if (
    persisted.browser_state !== "submit_started" ||
    persisted.browser_job_digest !== browserJobDigest(persisted) ||
    persisted.submission_idempotency_key !== submissionIdempotencyKey(persisted)
  ) {
    throw new Error("Persisted submit intent is not click-authorizable");
  }
  return {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    capability: "click_application_submit_once",
    canonical_job_id: persisted.canonical_job_id,
    attempt_id: persisted.browser_attempt_id,
    job_digest: persisted.browser_job_digest,
    form_fingerprint: persisted.browser_form_fingerprint,
    submission_idempotency_key: persisted.submission_idempotency_key,
    submit_started_at: persisted.submission_started_at,
    authorization_digest: browserSubmitAuthorizationDigest(persisted)
  };
}

export function commitBrowserResult(
  freshRecord,
  result,
  now = new Date().toISOString(),
  schema,
  confirmationTrust = {}
) {
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  requireExactKeys(
    result,
    [
      "protocol_version",
      "attempt_id",
      "job_digest",
      "result",
      "evidence"
    ],
    [
      "form_fingerprint",
      "submission_idempotency_key",
      "confirmation_kind",
      "confirmation_reference",
      "observed_source_job_id",
      "observed_canonical_url",
      "retry_at",
      "authorization_digest",
      "confirmation_attestation"
    ],
    "browser result"
  );
  if (
    result.protocol_version !== BROWSER_EXECUTOR_PROTOCOL_VERSION ||
    result.attempt_id !== freshRecord.browser_attempt_id ||
    result.job_digest !== freshRecord.browser_job_digest
  ) {
    throw new Error("Browser result identity does not match persisted state");
  }
  const state = String(result.result || "");
  const afterSubmit = ["submit_started", "ambiguous"].includes(freshRecord.browser_state);
  const schemaTransitions = schema?.browser_transitions?.[freshRecord.browser_state];
  if (
    !Array.isArray(schemaTransitions) ||
    !schemaTransitions.includes(state) ||
    (!afterSubmit && !ACTIVE_PRE_SUBMIT_STATES.has(freshRecord.browser_state)) ||
    !RESULT_CATEGORIES[state]
  ) {
    throw new Error("Browser result transition is not allowed from current state");
  }
  const evidence = sanitizeBrowserEvidence(result.evidence);
  if (
    !RESULT_CATEGORIES[state].has(evidence.category) ||
    !evidence.observed_at ||
    Date.parse(evidence.observed_at) > Date.parse(now)
  ) {
    throw new Error("Browser result evidence does not match its lifecycle state");
  }
  if (
    state !== "confirmed" &&
    [
      result.confirmation_kind,
      result.confirmation_reference,
      result.observed_source_job_id,
      result.observed_canonical_url,
      result.confirmation_attestation
    ].some((value) => String(value || "").trim())
  ) {
    throw new Error("Confirmation identity is valid only for a confirmed result");
  }
  const updates = {
    browser_state: state,
    browser_block_category: state === "blocked" ? evidence.category : "",
    error_category: state === "confirmed" ? "" : evidence.category,
    error_summary: state === "confirmed" ? "" : evidence.summary,
    processing_stage: state === "retryable" ? "browser_executor" : "",
    processing_token: "",
    processing_started_at: "",
    next_retry_at: state === "retryable" ? String(result.retry_at || "") : ""
  };
  if (state === "retryable") {
    requireTimestamp(result.retry_at, "browser result retry_at");
    if (Date.parse(result.retry_at) <= Date.parse(now)) {
      throw new Error("browser result retry_at must be in the future");
    }
  } else if (result.retry_at) {
    throw new Error("retry_at is only valid for a retryable browser result");
  }
  if (afterSubmit) {
    if (
      result.form_fingerprint !== freshRecord.browser_form_fingerprint ||
      result.submission_idempotency_key !==
        freshRecord.submission_idempotency_key ||
      result.authorization_digest !== browserSubmitAuthorizationDigest(freshRecord)
    ) {
      throw new Error("Browser result submission identity mismatch");
    }
  } else {
    updates.browser_form_fingerprint = "";
    updates.submission_idempotency_key = "";
  }
  if (state === "confirmed") {
    if (!CONFIRMATION_KINDS.has(result.confirmation_kind)) {
      throw new Error("Submission confirmation kind is unsupported");
    }
    const reference = String(result.confirmation_reference || "").trim();
    const observedPage = normalizeCanonicalUrl(result.observed_canonical_url);
    const expectedPage = normalizeCanonicalUrl(freshRecord.canonical_url);
    if (
      !/^[a-z0-9][a-z0-9._/-]{0,179}$/i.test(reference) ||
      evidence.reference_digest !== digest(reference) ||
      result.observed_source_job_id !== freshRecord.source_job_id ||
      observedPage !== expectedPage ||
      extractOnlineJobsId(observedPage) !== freshRecord.source_job_id ||
      Date.parse(evidence.observed_at) < Date.parse(freshRecord.submission_started_at)
    ) {
      throw new Error("Submission confirmation requires bounded evidence identity");
    }
    const witness = browserConfirmationWitness(freshRecord, result);
    if (
      !verifyBrowserConfirmationAttestation(
        witness,
        result.confirmation_attestation,
        confirmationTrust
      )
    ) {
      throw new Error(
        "Submission confirmation requires a trusted independent adapter attestation"
      );
    }
    Object.assign(updates, {
      submission_confirmed_at: evidence.observed_at,
      submission_confirmation_kind: result.confirmation_kind,
      submission_confirmation_reference: `confirmation-ref-v1:${digest(reference)}`,
      submission_attestation_key_id: result.confirmation_attestation.key_id,
      submission_attestation_witness_digest:
        browserConfirmationWitnessDigest(witness),
      submission_attestation_signature:
        result.confirmation_attestation.signature,
      submission_confirmation_digest: `confirmation-v1:${digest({
        canonical_job_id: freshRecord.canonical_job_id,
        attempt_id: freshRecord.browser_attempt_id,
        job_digest: freshRecord.browser_job_digest,
        form_fingerprint: freshRecord.browser_form_fingerprint,
        idempotency_key: freshRecord.submission_idempotency_key,
        confirmation_kind: result.confirmation_kind,
        observed_source_job_id: result.observed_source_job_id,
        observed_canonical_url: observedPage,
        confirmation_reference: reference,
        reference_digest: evidence.reference_digest,
        attestation_key_id: result.confirmation_attestation.key_id,
        witness_digest: browserConfirmationWitnessDigest(witness),
        confirmed_at: evidence.observed_at
      })}`,
      pipeline_status: "ready_to_apply"
    });
  }
  return requireValidProposedRecord(
    nextRecord(freshRecord, updates, now),
    schema
  );
}

export function recoverBrowserRecord(
  freshRecord,
  { now = new Date().toISOString(), retry_at, evidence },
  schema
) {
  assertAutonomous(freshRecord);
  requireCurrentGuard(freshRecord);
  if (["submit_started", "ambiguous", "confirmed"].includes(freshRecord.browser_state)) {
    throw new Error("Post-submit state requires reconciliation and cannot be retried");
  }
  if (!ACTIVE_PRE_SUBMIT_STATES.has(freshRecord.browser_state)) {
    throw new Error("Browser record is not recoverable");
  }
  const sanitized = sanitizeBrowserEvidence(evidence);
  if (!RESULT_CATEGORIES.retryable.has(sanitized.category)) {
    throw new Error("Browser recovery requires a retryable evidence category");
  }
  if (!sanitized.observed_at || Date.parse(sanitized.observed_at) > Date.parse(now)) {
    throw new Error("Browser recovery requires a current observed_at timestamp");
  }
  requireTimestamp(retry_at, "browser retry_at");
  if (Date.parse(retry_at) <= Date.parse(now)) {
    throw new Error("browser retry_at must be in the future");
  }
  if (!schema?.browser_transitions?.[freshRecord.browser_state]?.includes("retryable")) {
    throw new Error("Browser recovery transition is not allowed by the schema");
  }
  return requireValidProposedRecord(
    nextRecord(
      freshRecord,
      {
        browser_state: "retryable",
        processing_stage: "",
        processing_token: "",
        processing_started_at: "",
        next_retry_at: retry_at,
        browser_form_fingerprint: "",
        submission_idempotency_key: "",
        browser_block_category: "",
        error_category: sanitized.category,
        error_summary: sanitized.summary
      },
      now
    ),
    schema
  );
}
