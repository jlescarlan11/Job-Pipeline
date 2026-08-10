export function parseHttpUrl(value, { baseOrigin = "" } = {}) {
  let input = String(value ?? "").trim();
  if (!input) return null;

  if (input.startsWith("/")) {
    const base = parseHttpUrl(baseOrigin);
    if (!base) return null;
    input = `${base.protocol}//${base.hostname}${base.port ? `:${base.port}` : ""}${input}`;
  }

  if (/[\u0000-\u0020\u007f\\]/.test(input)) return null;
  const match = input.match(
    /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i
  );
  if (!match) return null;

  const protocol = `${match[1].toLowerCase()}:`;
  const authority = match[2];
  if (!authority || authority.includes("@") || authority.includes("[")) return null;

  const colonIndex = authority.lastIndexOf(":");
  let hostname = authority;
  let port = "";
  if (colonIndex >= 0) {
    if (authority.indexOf(":") !== colonIndex) return null;
    hostname = authority.slice(0, colonIndex);
    port = authority.slice(colonIndex + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65535) return null;
  }

  hostname = hostname.toLowerCase();
  if (
    hostname.length > 253 ||
    hostname.split(".").some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )
  ) {
    return null;
  }

  const pathname = match[3] || "/";
  const search = match[4] || "";
  const hash = match[5] || "";
  return {
    protocol,
    hostname,
    port,
    pathname,
    search,
    hash,
    username: "",
    password: "",
    href: `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${search}${hash}`
  };
}

export function normalizeCanonicalUrl(value) {
  const parsed = parseHttpUrl(value, {
    baseOrigin: "https://www.onlinejobs.ph"
  });
  if (!parsed) return "";
  if (parsed.port && parsed.port !== "443") return "";
  const hostname =
    parsed.hostname === "www.onlinejobs.ph"
      ? "onlinejobs.ph"
      : parsed.hostname;
  if (hostname !== "onlinejobs.ph") return "";
  const pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!/^\/jobseekers\/job\/[^/]+$/i.test(pathname)) return "";
  return `https://${hostname}${pathname}`;
}

export function extractOnlineJobsId(url) {
  const canonicalUrl = normalizeCanonicalUrl(url);
  if (!canonicalUrl) return "";
  const match = canonicalUrl.match(/\/jobseekers\/job\/[^/]*?(\d+)$/i);
  return match?.[1] ?? "";
}

export function isDailyApplicationLimitFieldName(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const compact = normalized.replaceAll(" ", "");
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  if (!compact) return false;
  if (compact.includes("datebucket")) return true;
  const daily =
    compact.includes("daily") ||
    compact.includes("perday") ||
    compact.includes("eachday") ||
    compact.includes("day") ||
    compact.includes("24hour") ||
    compact.includes("hours24") ||
    compact.includes("24hr") ||
    compact.includes("hrs24") ||
    compact.includes("24h");
  const application =
    compact.includes("application") ||
    compact.includes("apply") ||
    compact.includes("applies") ||
    compact.includes("submission") ||
    compact.includes("submit") ||
    compact.includes("applypoint") ||
    compact.includes("applypoints") ||
    tokens.has("app") ||
    tokens.has("apps");
  // Any day-scoped application/submission control is forbidden. Requiring a
  // particular limiter word lets aliases such as `applications_per_24_hours`
  // or `daily_application_ceiling` silently recreate the same cap.
  return daily && application;
}

export function canonicalJobId(record) {
  const source = String(record.source || "onlinejobs.ph").trim().toLowerCase();
  const sourceJobId = String(record.source_job_id || extractOnlineJobsId(record.canonical_url || record.job_url) || "").trim();
  if (sourceJobId) return `${source}:${sourceJobId}`;
  const canonicalUrl = normalizeCanonicalUrl(record.canonical_url || record.job_url);
  if (!canonicalUrl) return "";
  let hash = 2166136261;
  for (let index = 0; index < canonicalUrl.length; index += 1) {
    hash ^= canonicalUrl.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const digest = (hash >>> 0).toString(16).padStart(8, "0");
  return `${source}:url:${digest}`;
}

function stableContractValue(value) {
  if (Array.isArray(value)) return value.map(stableContractValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableContractValue(value[key])])
    );
  }
  return value;
}

function contractDigest(value) {
  const serialized = JSON.stringify(stableContractValue(value));
  const input = new TextEncoder().encode(serialized);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = input.length * 8;
  const lengthView = new DataView(bytes.buffer);
  lengthView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  lengthView.setUint32(paddedLength - 4, bitLength >>> 0);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const rotateRight = (value, amount) =>
    (value >>> amount) | (value << (32 - amount));
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const view = new DataView(bytes.buffer, offset, 64);
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15];
      const previous2 = schedule[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] =
        (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const upper1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upper1 + choice + constants[index] + schedule[index]) >>> 0;
      const upper0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upper0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

const BROWSER_JOB_DIGEST_FIELDS = [
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

/**
 * Binds autonomous browser work to the material job facts that were
 * discovered. Asynchronous observation timestamps are deliberately excluded,
 * so merely seeing the same posting again cannot manufacture a new job input.
 */
export function browserJobDigest(record) {
  return `job-v1:${contractDigest(
    Object.fromEntries(
      BROWSER_JOB_DIGEST_FIELDS.map((field) => [field, record?.[field] ?? ""])
    )
  )}`;
}

/**
 * Binds a human review approval to the exact application strategy that was
 * visible at review time. Operator notes and timestamps are intentionally not
 * included: neither is authoritative evidence for the generated message.
 */
export function applicationReviewGuard(record) {
  return `review-v1:${contractDigest({
    application_instructions: record?.application_instructions ?? [],
    screening_questions: record?.screening_questions ?? [],
    requirement_coverage: record?.requirement_coverage ?? [],
    application_message_plan: record?.application_message_plan ?? [],
    selected_proof_refs: record?.selected_proof_refs ?? [],
    application_warnings: record?.application_warnings ?? [],
    application_pack_status: record?.application_pack_status ?? "",
    application_pack_version: record?.application_pack_version ?? "",
    application_pack_profile_version:
      record?.application_pack_profile_version ?? "",
    application_pack_policy_version:
      record?.application_pack_policy_version ?? "",
    coverage_contract_version: record?.coverage_contract_version ?? "",
    message_plan_version: record?.message_plan_version ?? ""
  })}`;
}

/**
 * Identifies the material review case without volatile timestamps or operator
 * notes. The same employer requirements, coverage, pack policy, and bounded
 * decision context therefore produce the same case across retries.
 */
export function reviewCaseId(record) {
  return `review-case-v1:${contractDigest({
    application_review_guard: applicationReviewGuard(record),
    decision_reason: record?.decision_reason ?? "",
    required_input: record?.required_input ?? "",
    profile_version: record?.profile_version ?? "",
    policy_version: record?.policy_version ?? ""
  })}`;
}

/**
 * Binds preparation work to stable inputs. Generated output, retry counters,
 * timestamps, and operator notes are deliberately excluded so scheduled runs
 * cannot manufacture new work from unchanged inputs.
 */
export function preparationInputGuard(record) {
  return `prep-v1:${contractDigest({
    canonical_job_id: record?.canonical_job_id ?? canonicalJobId(record ?? {}),
    job_description: record?.job_description ?? "",
    review_case_id: record?.review_case_id ?? "",
    review_decision: record?.review_decision ?? "",
    // The persisted approval guard is an input authorization. Recomputing an
    // application guard from the current pack would make this digest depend on
    // generated preparation output and invalidate it after a legitimate run.
    review_approval_guard: record?.review_approval_guard ?? "",
    profile_version: record?.profile_version ?? "",
    policy_version: record?.policy_version ?? ""
  })}`;
}

/**
 * Produces one stable submission identity for the same canonical job and
 * compatible trusted inputs. Attempt identifiers and timestamps are excluded
 * deliberately so a retry cannot manufacture a second submission authority.
 */
export function submissionIdempotencyKey(record) {
  const values = {
    canonical_job_id: record?.canonical_job_id ?? canonicalJobId(record ?? {}),
    browser_job_digest: record?.browser_job_digest ?? "",
    browser_context_digest: record?.browser_context_digest ?? "",
    browser_form_fingerprint: record?.browser_form_fingerprint ?? "",
    profile_version: record?.profile_version ?? "",
    message_profile_version: record?.message_profile_version ?? "",
    message_policy_version: record?.message_policy_version ?? "",
    application_pack_version: record?.application_pack_version ?? "",
    application_pack_policy_version:
      record?.application_pack_policy_version ?? "",
    automation_contract_version: record?.automation_contract_version ?? ""
  };
  if (Object.values(values).some((value) => !String(value || "").trim())) {
    return "";
  }
  return `submission-v1:${contractDigest(values)}`;
}

const BROWSER_SUBMIT_AUTHORIZATION_FIELDS = [
  "canonical_job_id",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "browser_form_fingerprint",
  "submission_idempotency_key",
  "submission_started_at",
  "message_profile_version",
  "message_policy_version",
  "application_pack_version",
  "application_pack_policy_version"
];

export function browserSubmitAuthorizationDigest(record) {
  return contractDigest(
    Object.fromEntries(
      BROWSER_SUBMIT_AUTHORIZATION_FIELDS.map((field) => [
        field,
        record?.[field] ?? ""
      ])
    )
  );
}

export function recordCopyDigest(record, schema) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  if (fields.length === 0) return "";
  return `copy-v1:${contractDigest(
    Object.fromEntries(fields.map((field) => [field, record?.[field] ?? ""]))
  )}`;
}

export function normalizeUserAction(action, schema) {
  const value = String(action ?? "").trim();
  return schema?.legacy_user_action_mapping?.[value] ?? value;
}

/**
 * Operator-owned Sheet columns are intentionally excluded from the persisted
 * digest. A Google Sheets edit cannot atomically refresh `state_guard`, so
 * guarding these values would make every legitimate action or note look like
 * system-state corruption. Workflows validate the values against the owning
 * store and compare them explicitly at their commit boundaries instead.
 */
export const OPERATOR_EDITABLE_STATE_FIELDS = ["user_action", "outcome", "notes"];
export const ASYNC_DISCOVERY_STATE_FIELDS = [
  "last_seen_at",
  "matched_keywords",
  "updated_at"
];
export const STATE_GUARD_EXCLUDED_FIELDS = [
  "state_guard",
  ...OPERATOR_EDITABLE_STATE_FIELDS,
  ...ASYNC_DISCOVERY_STATE_FIELDS
];

export const STATE_GUARD_FIELDS = [
  "source", "source_job_id", "canonical_job_id", "record_version",
  "canonical_url", "job_title", "company", "job_description", "salary_text",
  "posted_at", "discovered_at",
  "source_availability", "pipeline_status", "decision_reason",
  "required_input", "execution_mode", "automation_contract_version",
  "autonomous_decision", "browser_state", "browser_attempt_id",
  "browser_job_digest", "browser_context_digest", "browser_form_fingerprint",
  "submission_idempotency_key", "submission_started_at",
  "submission_confirmed_at", "submission_confirmation_kind",
  "submission_confirmation_reference", "submission_confirmation_digest",
  "submission_attestation_key_id", "submission_attestation_witness_digest",
  "submission_attestation_signature",
  "browser_block_category", "review_case_id", "review_case_version",
  "review_decision", "review_decided_at", "review_approved_at",
  "review_approval_note", "review_approval_guard", "qualification_score",
  "opportunity_score",
  "ranking_confidence", "match_reasons", "requirement_gaps", "profile_version",
  "policy_version", "evaluated_at", "processing_stage", "processing_token",
  "processing_started_at", "attempt_count", "next_retry_at", "error_category",
  "error_summary", "generated_message", "message_validation_status",
  "message_profile_version", "message_policy_version", "generated_at",
  "application_instructions", "screening_questions", "requirement_coverage",
  "application_message_plan", "selected_proof_refs", "application_warnings",
  "application_pack_status", "application_pack_version",
  "application_pack_profile_version", "application_pack_policy_version",
  "coverage_contract_version", "message_plan_version",
  "application_pack_generated_at", "prep_status", "preparation_version",
  "preparation_input_guard", "preparation_updated_at", "alert_status",
  "alert_idempotency_key",
  "alert_claim_token", "alert_attempt_count", "alert_last_attempt_at",
  "alert_next_retry_at", "alert_sent_at", "alert_provider_reference",
  "alert_error_category", "alert_error_summary", "applied_at", "archived_at",
  "archive_reason", "outcome_recorded_value", "outcome_at",
  "created_at"
];

export const AUTONOMOUS_STATE_GUARD_FIELDS = Object.freeze([
  "execution_mode",
  "automation_contract_version",
  "autonomous_decision",
  "browser_state",
  "browser_attempt_id",
  "browser_job_digest",
  "browser_context_digest",
  "browser_form_fingerprint",
  "submission_idempotency_key",
  "submission_started_at",
  "submission_confirmed_at",
  "submission_confirmation_kind",
  "submission_confirmation_reference",
  "submission_confirmation_digest",
  "submission_attestation_key_id",
  "submission_attestation_witness_digest",
  "submission_attestation_signature",
  "browser_block_category"
]);

export const LEGACY_STATE_GUARD_FIELDS_V4 = STATE_GUARD_FIELDS.filter(
  (field) => !AUTONOMOUS_STATE_GUARD_FIELDS.includes(field)
);

// Compatibility is intentionally limited to the immediately preceding
// persisted contract. It lets the guarded workflows claim a freshly reread v3
// row and rewrite it under v4; it does not make old workflow definitions
// compatible with new lifecycle state.
export const LEGACY_STATE_GUARD_FIELDS_V3 = LEGACY_STATE_GUARD_FIELDS_V4.filter(
  (field) =>
    ![
      "review_case_id",
      "review_case_version",
      "review_decision",
      "review_decided_at",
      "prep_status",
      "preparation_version",
      "preparation_input_guard",
      "preparation_updated_at"
    ].includes(field)
);

function stateGuardForFields(record, fields) {
  const canonicalId = String(record.canonical_job_id || canonicalJobId(record) || "");
  if (!canonicalId) return "";
  const guardedRecord = Object.fromEntries(
    fields.map((field) => [field, record?.[field] ?? ""])
  );
  return `${canonicalId}|${contractDigest(guardedRecord)}`;
}

export function stateGuard(record) {
  // A missing top-level field becomes a blank Sheet cell on persistence.
  // Canonicalizing it here keeps digests stable across that round trip.
  return stateGuardForFields(record, STATE_GUARD_FIELDS);
}

export function legacyStateGuardV3(record) {
  return stateGuardForFields(record, LEGACY_STATE_GUARD_FIELDS_V3);
}

export function legacyStateGuardV4(record) {
  return stateGuardForFields(record, LEGACY_STATE_GUARD_FIELDS_V4);
}

export function stateGuardMatches(record) {
  const persisted = String(record?.state_guard || "");
  if (!persisted) return false;
  if (persisted === stateGuard(record)) return true;
  const hasAutonomousLifecycleState =
    record?.execution_mode === "autonomous_chrome" ||
    AUTONOMOUS_STATE_GUARD_FIELDS.some(
      (field) =>
        field !== "execution_mode" && String(record?.[field] ?? "").trim()
    );
  if (hasAutonomousLifecycleState) return false;
  if (persisted === legacyStateGuardV4(record)) return true;
  const hasV4LifecycleState =
    Boolean(
      record?.review_case_id ||
        record?.review_case_version ||
        record?.review_decision ||
        record?.review_decided_at ||
        record?.preparation_input_guard ||
        record?.preparation_updated_at
    ) ||
    Number(record?.preparation_version || 0) > 0 ||
    !["", "preparation_error"].includes(String(record?.prep_status || ""));
  return !hasV4LifecycleState && persisted === legacyStateGuardV3(record);
}

/**
 * Recognizes only the v3 Scraped Jobs review action produced by the retired
 * approval loop. The raw legacy spelling is retained in memory by
 * normalizeLegacyRecord; it is never a persisted v4 field. A new Proceed or
 * Reject value, or any row that already contains v4 lifecycle state, cannot
 * use this compatibility route.
 */
export function isGuardedLegacyReviewAction(record, store, schema) {
  const legacyAction = String(
    record?.compatibility_legacy_user_action || ""
  ).trim();
  const expectedAction = schema?.legacy_user_action_mapping?.[legacyAction];
  const persisted = String(record?.state_guard || "");
  return Boolean(
    store === "Scraped Jobs" &&
      record?.pipeline_status === "review_needed" &&
      ["Approve", "Deny"].includes(legacyAction) &&
      ["Proceed", "Reject"].includes(expectedAction) &&
      record?.user_action === expectedAction &&
      persisted &&
      persisted !== stateGuard(record) &&
      persisted === legacyStateGuardV3(record) &&
      stateGuardMatches(record)
  );
}

export function rankingPriorityValue(record) {
  if (
    typeof record?.opportunity_score === "number" &&
    Number.isFinite(record.opportunity_score)
  ) {
    return {
      value: record.opportunity_score,
      source: "opportunity_score"
    };
  }
  if (typeof record?.match_score === "number" && Number.isFinite(record.match_score)) {
    return {
      value: record.match_score,
      source: "legacy_match_score"
    };
  }
  return { value: 0, source: "missing" };
}

export function compareRankingPriority(left, right) {
  const scoreOrder =
    rankingPriorityValue(right).value - rankingPriorityValue(left).value;
  if (scoreOrder !== 0) return scoreOrder;
  const confidenceOrder =
    ({ high: 3, medium: 2, low: 1 }[right.ranking_confidence] ?? 0) -
    ({ high: 3, medium: 2, low: 1 }[left.ranking_confidence] ?? 0);
  if (confidenceOrder !== 0) return confidenceOrder;
  const timestamp = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const rightPosted = timestamp(right.posted_at);
  const leftPosted = timestamp(left.posted_at);
  if (rightPosted !== leftPosted) return rightPosted - leftPosted;
  const rightCreated = timestamp(right.created_at);
  const leftCreated = timestamp(left.created_at);
  if (rightCreated !== leftCreated) return rightCreated - leftCreated;
  return String(left.canonical_job_id || "").localeCompare(
    String(right.canonical_job_id || "")
  );
}

function parseList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // Legacy sheets may use comma-separated values.
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizeRuleValue(value, rule) {
  if (!rule || value === "" || value === undefined || value === null) return value ?? "";
  if (rule.type === "number" || rule.type === "integer") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (rule.type === "string") return String(value).trim();
  return value;
}

export function mergeOutcomeEvents(...collections) {
  const events = new Map();
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const event of collection) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const id = String(event.id || "").trim();
      if (!id || events.has(id)) continue;
      events.set(id, { ...event, id });
    }
  }
  const timestamp = (value) => {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...events.values()].sort(
    (left, right) =>
      timestamp(left.at) - timestamp(right.at) ||
      String(left.id).localeCompare(String(right.id))
  );
}

export function normalizeLegacyRecord(input, schema, now = new Date().toISOString()) {
  const record = { ...input };
  for (const [legacy, canonical] of Object.entries(schema.legacy_header_mapping ?? {})) {
    if (record[canonical] === undefined && record[legacy] !== undefined) {
      record[canonical] = record[legacy];
    }
  }

  const legacyStatus = String(record.pipeline_status || "").trim().toLowerCase();
  record.pipeline_status =
    schema.legacy_status_mapping?.[legacyStatus] ||
    (schema.pipeline_statuses.includes(legacyStatus) ? legacyStatus : "new");
  const rawUserAction = String(record.user_action || "").trim();
  record.user_action = normalizeUserAction(rawUserAction, schema);
  record.compatibility_legacy_user_action =
    record.user_action !== rawUserAction ? rawUserAction : "";
  // A blank mode is compatibility data, never autonomous authorization.
  record.execution_mode =
    String(record.execution_mode || "").trim() || "legacy_manual";
  record.source = String(record.source || "onlinejobs.ph").trim().toLowerCase();
  record.canonical_url = normalizeCanonicalUrl(record.canonical_url || record.job_url);
  record.source_job_id = String(record.source_job_id || extractOnlineJobsId(record.canonical_url) || "");
  record.canonical_job_id = String(record.canonical_job_id || canonicalJobId(record));
  for (const field of schema.string_list_fields ?? ["matched_keywords"]) {
    record[field] = parseList(record[field]);
  }
  for (const field of schema.json_array_fields ?? []) {
    record[field] = parseJsonArray(record[field]);
  }
  for (const [field, rule] of Object.entries(schema.field_rules ?? {})) {
    record[field] = normalizeRuleValue(record[field], rule);
  }
  record.attempt_count = Number.isFinite(Number(record.attempt_count))
    ? Number(record.attempt_count)
    : 0;
  record.record_version = Number.isInteger(Number(record.record_version)) && Number(record.record_version) > 0
    ? Number(record.record_version)
    : 1;
  record.alert_attempt_count = Number.isFinite(Number(record.alert_attempt_count))
    ? Number(record.alert_attempt_count)
    : 0;
  record.preparation_version =
    Number.isInteger(Number(record.preparation_version)) &&
    Number(record.preparation_version) >= 0
      ? Number(record.preparation_version)
      : 0;
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;
  record.source_availability = record.source_availability || "active";
  record.profile_version =
    record.profile_version ||
    (schema.schema_version === 1 ? "legacy/unknown" : "");
  record.message_profile_version =
    record.message_profile_version ||
    (schema.schema_version === 1 && record.generated_message
      ? "legacy/unknown"
      : "");
  record.outcome = record.outcome || "";
  record.outcome_recorded_value = record.outcome_recorded_value || "";
  record.user_action = record.user_action || "";
  record.review_case_id = record.review_case_id || "";
  record.review_case_version = record.review_case_version || "";
  record.review_decision = record.review_decision || "";
  record.prep_status =
    record.prep_status ||
    (record.pipeline_status === "ready_to_apply" ? "preparation_error" : "");
  record.preparation_input_guard = record.preparation_input_guard || "";
  record.review_approval_note = record.review_approval_note || "";
  record.review_approval_guard = record.review_approval_guard || "";
  record.alert_claim_token = record.alert_claim_token || "";
  record.state_guard = record.state_guard || stateGuard(record);
  return record;
}

export function validateRecordContract(record, schema) {
  const errors = [];
  const fields = new Set(schema?.fields ?? []);
  for (const [field, rule] of Object.entries(schema?.field_rules ?? {})) {
    if (!fields.has(field)) {
      errors.push(`field rule references unknown field: ${field}`);
      continue;
    }
    const value = record?.[field];
    const missing = value === "" || value === undefined || value === null;
    if (missing) {
      if (rule.nullable === false) errors.push(`${field} is required`);
      continue;
    }
    if (rule.type === "enum") {
      if (!rule.values?.includes(value)) errors.push(`${field} has unsupported value: ${value}`);
      continue;
    }
    if (rule.type === "string") {
      if (typeof value !== "string") {
        errors.push(`${field} must be a string`);
        continue;
      }
      if (
        rule.maximum_length !== undefined &&
        value.length > rule.maximum_length
      ) {
        errors.push(`${field} exceeds its maximum length`);
      }
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
        errors.push(`${field} has an unsupported format`);
      }
      continue;
    }
    const numeric = typeof value === "number" ? value : Number.NaN;
    if (!Number.isFinite(numeric)) {
      errors.push(`${field} must be a ${rule.type}`);
      continue;
    }
    if (rule.type === "integer" && !Number.isInteger(numeric)) {
      errors.push(`${field} must be an integer`);
    }
    if (rule.minimum !== undefined && numeric < rule.minimum) {
      errors.push(`${field} must be at least ${rule.minimum}`);
    }
    if (rule.maximum !== undefined && numeric > rule.maximum) {
      errors.push(`${field} must be at most ${rule.maximum}`);
    }
  }
  for (const field of schema?.string_list_fields ?? []) {
    const value = record?.[field];
    if (value !== undefined && !Array.isArray(value)) errors.push(`${field} must be an array`);
  }
  for (const field of schema?.json_array_fields ?? []) {
    const value = record?.[field];
    if (value !== undefined && !Array.isArray(value)) errors.push(`${field} must be a JSON array`);
    const maximum = schema?.json_field_maximum_characters?.[field];
    if (value !== undefined && Number.isInteger(maximum)) {
      try {
        if (JSON.stringify(value).length > maximum) {
          errors.push(`${field} exceeds ${maximum} serialized characters`);
        }
      } catch {
        errors.push(`${field} must be JSON serializable`);
      }
    }
  }
  if (Array.isArray(record?.outcome_events)) {
    const seen = new Set();
    const allowedTypes = new Set([
      "no_response",
      "replied",
      "interview",
      "offer",
      "rejected",
      "correction"
    ]);
    for (const [index, event] of record.outcome_events.entries()) {
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        errors.push(`outcome_events[${index}] must be an object`);
        continue;
      }
      const id = String(event.id || "");
      if (!id || id.length > 256) {
        errors.push(`outcome_events[${index}].id is invalid`);
      } else if (seen.has(id)) {
        errors.push(`outcome_events contains duplicate id: ${id}`);
      } else {
        seen.add(id);
      }
      if (!allowedTypes.has(event.type)) {
        errors.push(`outcome_events[${index}].type is invalid`);
      }
      if (
        typeof event.at !== "string" ||
        !Number.isFinite(Date.parse(event.at))
      ) {
        errors.push(`outcome_events[${index}].at is invalid`);
      }
      for (const field of ["previous_outcome", "corrected_outcome"]) {
        if (
          event[field] !== undefined &&
          !["", "no_response", "replied", "interview", "offer", "rejected"].includes(
            event[field]
          )
        ) {
          errors.push(`outcome_events[${index}].${field} is invalid`);
        }
      }
    }
  }
  for (const field of schema?.timestamp_fields ?? []) {
    const value = record?.[field];
    if (value === "" || value === undefined || value === null) continue;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      errors.push(`${field} must be a valid timestamp`);
    }
  }
  const canonicalUrl = normalizeCanonicalUrl(record?.canonical_url);
  const expectedIdentity = canonicalJobId(record ?? {});
  if (!canonicalUrl) errors.push("canonical_url is invalid");
  if (!String(record?.source_job_id || "").trim()) {
    errors.push("source_job_id is required");
  }
  if (!expectedIdentity || record?.canonical_job_id !== expectedIdentity) {
    errors.push("canonical_job_id does not match the canonical source identity");
  }
  const allowedActions =
    schema?.actions_by_status?.[record?.pipeline_status] ?? [];
  if (!allowedActions.includes(record?.user_action ?? "")) {
    errors.push("user_action is not supported for pipeline_status");
  }
  const autonomous = record?.execution_mode === "autonomous_chrome";
  const browserState = String(record?.browser_state || "");
  if (autonomous) {
    if (record?.automation_contract_version !== "browser-contract-v1") {
      errors.push("autonomous_chrome requires browser-contract-v1");
    }
    if (record?.user_action) {
      errors.push("autonomous_chrome cannot use a manual user_action");
    }
    if (!(schema?.browser_states ?? []).includes(browserState)) {
      errors.push("autonomous_chrome requires a supported browser_state");
    }
    if (!String(record?.browser_job_digest || "")) {
      errors.push("autonomous_chrome requires browser_job_digest");
    }
    const legacyAuthorizationFields = [
      "review_case_id",
      "review_case_version",
      "review_decision",
      "review_decided_at",
      "review_approved_at",
      "review_approval_note",
      "review_approval_guard",
      "prep_status",
      "preparation_input_guard",
      "preparation_updated_at"
    ];
    if (
      legacyAuthorizationFields.some((field) =>
        String(record?.[field] ?? "").trim()
      ) || Number(record?.preparation_version || 0) > 0
    ) {
      errors.push("autonomous_chrome cannot use legacy review authorization");
    }
    const attemptStates = new Set([
      "claimed",
      "evaluating",
      "generating",
      "filling",
      "submit_started",
      "confirmed",
      "retryable",
      "ambiguous",
      "blocked"
    ]);
    if (attemptStates.has(browserState) && !record?.browser_attempt_id) {
      errors.push(`${browserState} requires browser_attempt_id`);
    }
    const contextStates = new Set([
      "evaluating",
      "generating",
      "filling",
      "submit_started",
      "confirmed",
      "retryable",
      "ambiguous",
      "blocked",
      "unavailable",
      "skipped"
    ]);
    if (contextStates.has(browserState) && !record?.browser_context_digest) {
      errors.push(`${browserState} requires browser_context_digest`);
    }
    if (
      ["generating", "filling", "submit_started", "confirmed", "ambiguous"].includes(
        browserState
      )
    ) {
      if (!record?.browser_form_fingerprint) {
        errors.push(`${browserState} requires browser_form_fingerprint`);
      }
      const expectedSubmissionKey = submissionIdempotencyKey(record);
      if (!expectedSubmissionKey) {
        errors.push(`${browserState} requires complete submission identity inputs`);
      } else if (record?.submission_idempotency_key !== expectedSubmissionKey) {
        errors.push("submission_idempotency_key does not match trusted inputs");
      }
    } else if (record?.submission_idempotency_key) {
      errors.push("submission_idempotency_key is only valid after form inspection");
    }
    const startedState = ["submit_started", "confirmed", "ambiguous"].includes(
      browserState
    );
    if (startedState !== Boolean(record?.submission_started_at)) {
      errors.push(
        startedState
          ? `${browserState} requires submission_started_at`
          : "submission_started_at is only valid after submit intent"
      );
    }
    const confirmationFields = [
      "submission_confirmed_at",
      "submission_confirmation_kind",
      "submission_confirmation_reference",
      "submission_confirmation_digest",
      "submission_attestation_key_id",
      "submission_attestation_witness_digest",
      "submission_attestation_signature"
    ];
    if (browserState === "confirmed") {
      if (record?.autonomous_decision !== "apply") {
        errors.push("confirmed requires autonomous_decision apply");
      }
      for (const field of confirmationFields) {
        if (!String(record?.[field] || "")) {
          errors.push(`confirmed requires ${field}`);
        }
      }
    } else if (
      confirmationFields.some((field) => String(record?.[field] || ""))
    ) {
      errors.push("confirmation evidence is only valid for confirmed state");
    }
    if (browserState === "skipped" && record?.autonomous_decision !== "skip") {
      errors.push("skipped requires autonomous_decision skip");
    }
    if (record?.autonomous_decision === "skip" && browserState !== "skipped") {
      errors.push("autonomous_decision skip requires skipped state");
    }
    if (
      ["generating", "filling", "submit_started", "confirmed", "ambiguous"].includes(
        browserState
      ) && record?.autonomous_decision !== "apply"
    ) {
      errors.push(`${browserState} requires autonomous_decision apply`);
    }
    if (browserState === "blocked" && !record?.browser_block_category) {
      errors.push("blocked requires browser_block_category");
    }
    if (browserState !== "blocked" && record?.browser_block_category) {
      errors.push("browser_block_category is only valid for blocked state");
    }
  } else {
    const forbidden = AUTONOMOUS_STATE_GUARD_FIELDS.filter(
      (field) => field !== "execution_mode"
    );
    if (forbidden.some((field) => String(record?.[field] ?? "").trim())) {
      errors.push("legacy_manual cannot contain autonomous browser authorization");
    }
  }
  const processingToken = String(record?.processing_token || "").trim();
  const processingStage = String(record?.processing_stage || "").trim();
  const processingStartedAt = String(record?.processing_started_at || "").trim();
  const validProcessingStage =
    ["evaluation", "generation"].includes(processingStage) ||
    (autonomous &&
      processingStage === "browser_executor" &&
      [
        "claimed",
        "evaluating",
        "generating",
        "filling",
        "submit_started",
        "confirmed",
        "retryable",
        "ambiguous",
        "blocked",
        "unavailable",
        "skipped"
      ].includes(browserState));
  if (
    processingToken &&
    (!validProcessingStage ||
      !Number.isFinite(Date.parse(processingStartedAt)))
  ) {
    errors.push(
      "processing_token requires a supported stage and valid start time"
    );
  }
  if (!processingToken && processingStartedAt) {
    errors.push("processing_started_at requires processing_token");
  }
  if (!autonomous && record?.pipeline_status === "processing" && !processingToken) {
    errors.push("processing status requires processing_token");
  }
  const alertClaimToken = String(record?.alert_claim_token || "").trim();
  if (record?.alert_status === "sending" && !alertClaimToken) {
    errors.push("sending alert status requires alert_claim_token");
  }
  if (record?.alert_status !== "sending" && alertClaimToken) {
    errors.push("alert_claim_token is only valid while sending");
  }
  const unsafeChecklist =
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
  const requiredInput = String(record?.required_input || "");
  if (
    ["needs_input", "external_steps"].includes(record?.prep_status) &&
    !requiredInput.trim()
  ) {
    errors.push(`${record.prep_status} requires bounded required_input`);
  }
  if (requiredInput && unsafeChecklist.test(requiredInput)) {
    errors.push("required_input contains unsafe control characters");
  }
  const reviewCaseIdValue = String(record?.review_case_id || "");
  const reviewCaseVersion = String(record?.review_case_version || "");
  const reviewDecision = String(record?.review_decision || "");
  const reviewDecidedAt = String(record?.review_decided_at || "");
  if (Boolean(reviewCaseIdValue) !== Boolean(reviewCaseVersion)) {
    errors.push("review_case_id and review_case_version must be set together");
  }
  if (reviewDecision && (!reviewCaseIdValue || !reviewDecidedAt)) {
    errors.push("review_decision requires a review case and decision timestamp");
  }
  if (!reviewDecision && reviewDecidedAt) {
    errors.push("review_decided_at requires review_decision");
  }
  const prepStatus = String(record?.prep_status || "");
  const preparationVersion = Number(record?.preparation_version || 0);
  const preparationGuard = String(record?.preparation_input_guard || "");
  const preparationUpdatedAt = String(record?.preparation_updated_at || "");
  if (!autonomous && record?.pipeline_status === "ready_to_apply" && !prepStatus) {
    errors.push("ready_to_apply requires prep_status");
  }
  if (!autonomous && prepStatus && record?.pipeline_status !== "ready_to_apply") {
    errors.push("prep_status is only valid for ready_to_apply records");
  }
  const legacyPreparationError =
    prepStatus === "preparation_error" && preparationVersion === 0;
  if (prepStatus && !legacyPreparationError) {
    if (!Number.isInteger(preparationVersion) || preparationVersion < 1) {
      errors.push("active preparation state requires preparation_version");
    }
    if (!preparationGuard || !preparationUpdatedAt) {
      errors.push(
        "active preparation state requires an input guard and update timestamp"
      );
    }
  }
  if (prepStatus === "message_ready") {
    for (const [field, value] of Object.entries({
      application_pack_status: record?.application_pack_status,
      generated_message: record?.generated_message,
      message_validation_status: record?.message_validation_status,
      message_profile_version: record?.message_profile_version,
      message_policy_version: record?.message_policy_version,
      application_pack_version: record?.application_pack_version,
      application_pack_profile_version:
        record?.application_pack_profile_version,
      application_pack_policy_version:
        record?.application_pack_policy_version
    })) {
      if (!String(value || "").trim()) {
        errors.push(`message_ready requires ${field}`);
      }
    }
    if (record?.application_pack_status !== "ready") {
      errors.push("message_ready requires a ready application pack");
    }
    if (record?.message_validation_status !== "valid") {
      errors.push("message_ready requires a valid generated message");
    }
  }
  return errors;
}

export function validateRecordStoreContract(record, store, schema) {
  const errors = validateRecordContract(record, schema);
  const normalizedStore = String(store || "").trim();
  if (!(schema?.business_stores ?? []).includes(normalizedStore)) {
    errors.push(`record store is not authoritative: ${normalizedStore || "(blank)"}`);
    return errors;
  }
  if (record?.execution_mode === "autonomous_chrome") {
    const ownedStates =
      schema?.autonomous_store_browser_states?.[normalizedStore];
    if (!Array.isArray(ownedStates) || !ownedStates.includes(record?.browser_state)) {
      errors.push(
        `${normalizedStore} does not own autonomous browser_state ${
          record?.browser_state || "(blank)"
        }`
      );
    }
  }
  const allowedActions =
    schema?.actions_by_store_status?.[normalizedStore]?.[
      record?.pipeline_status
    ];
  if (!Array.isArray(allowedActions)) {
    errors.push(
      `${normalizedStore} does not own pipeline_status ${
        record?.pipeline_status || "(blank)"
      }`
    );
  } else if (
    !allowedActions.includes(record?.user_action ?? "") &&
    !isGuardedLegacyReviewAction(record, normalizedStore, schema)
  ) {
    errors.push(
      `user_action is not supported for ${normalizedStore}/${
        record?.pipeline_status || "(blank)"
      }`
    );
  }
  return errors;
}

export function applyValidatedRecordUpdate(record, updates, schema) {
  const candidate = { ...record, ...updates };
  const errors = validateRecordContract(candidate, schema);
  if (errors.length > 0) {
    throw new Error(`Invalid record update: ${errors.join("; ")}`);
  }
  return candidate;
}

export function validatePipelineSchema(schema) {
  const errors = [];
  if (schema?.schema_version !== 5) errors.push("schema_version must be 5");
  if (!Array.isArray(schema?.fields) || schema.fields.length === 0) errors.push("fields are required");
  if (!Array.isArray(schema?.pipeline_statuses) || schema.pipeline_statuses.length === 0) {
    errors.push("pipeline_statuses are required");
  }
  const duplicateFields = schema?.fields?.filter((field, index, all) => all.indexOf(field) !== index) ?? [];
  if (duplicateFields.length > 0) errors.push(`duplicate fields: ${[...new Set(duplicateFields)].join(", ")}`);
  const fields = new Set(schema?.fields ?? []);
  for (const collection of ["string_list_fields", "json_array_fields", "timestamp_fields"]) {
    if (!Array.isArray(schema?.[collection])) {
      errors.push(`${collection} must be an array`);
      continue;
    }
    for (const field of schema[collection]) {
      if (!fields.has(field)) errors.push(`${collection} references unknown field: ${field}`);
    }
  }
  for (const [field, rule] of Object.entries(schema?.field_rules ?? {})) {
    if (!fields.has(field)) errors.push(`field rule references unknown field: ${field}`);
    if (!["number", "integer", "enum", "string"].includes(rule?.type)) {
      errors.push(`field rule has unsupported type for ${field}`);
    }
    if (rule?.type === "enum" && (!Array.isArray(rule.values) || rule.values.length === 0)) {
      errors.push(`enum field rule requires values for ${field}`);
    }
    if (rule?.type === "string" && rule.pattern) {
      try {
        new RegExp(rule.pattern);
      } catch {
        errors.push(`string field rule has invalid pattern for ${field}`);
      }
    }
  }
  const jsonFieldLimits = schema?.json_field_maximum_characters;
  if (!jsonFieldLimits || typeof jsonFieldLimits !== "object" || Array.isArray(jsonFieldLimits)) {
    errors.push("json_field_maximum_characters must be an object");
  } else {
    for (const field of schema?.json_array_fields ?? []) {
      if (!Number.isInteger(jsonFieldLimits[field]) || jsonFieldLimits[field] < 1) {
        errors.push(`json field maximum is invalid for ${field}`);
      }
    }
    for (const field of Object.keys(jsonFieldLimits)) {
      if (!(schema?.json_array_fields ?? []).includes(field)) {
        errors.push(`json field maximum references non-JSON field: ${field}`);
      }
    }
  }

  const statuses = new Set(schema?.pipeline_statuses ?? []);
  const businessResults = new Set(schema?.business_results ?? []);
  const operationalConditions = new Set(schema?.operational_conditions ?? []);
  if (businessResults.size !== 3 ||
      !["ready_to_apply", "review_needed", "skip"].every((status) => businessResults.has(status))) {
    errors.push("business_results must contain only ready_to_apply, review_needed, and skip");
  }
  if ([...businessResults].some((status) => operationalConditions.has(status))) {
    errors.push("business results and operational conditions must be disjoint");
  }
  if (
    [...businessResults, ...operationalConditions].some(
      (status) => !statuses.has(status)
    ) ||
    statuses.size !== businessResults.size + operationalConditions.size
  ) {
    errors.push("pipeline_statuses must be exactly the business results and operational conditions");
  }
  const actions = new Set(schema?.user_actions ?? []);
  if (
    actions.size !== 5 ||
    !["", "I Applied", "Skip", "Proceed", "Reject"].every((action) =>
      actions.has(action)
    )
  ) {
    errors.push("user_actions must contain only the supported operator actions");
  }
  if (
    JSON.stringify(schema?.legacy_user_action_mapping) !==
    JSON.stringify({ Approve: "Proceed", Deny: "Reject" })
  ) {
    errors.push("legacy_user_action_mapping must normalize Approve and Deny");
  }
  const expectedBrowserStates = [
    "queued",
    "claimed",
    "evaluating",
    "generating",
    "filling",
    "submit_started",
    "confirmed",
    "retryable",
    "ambiguous",
    "blocked",
    "unavailable",
    "skipped"
  ];
  if (
    JSON.stringify(schema?.browser_states) !==
    JSON.stringify(expectedBrowserStates)
  ) {
    errors.push("browser_states must contain the supported ordered lifecycle");
  }
  const browserStateSet = new Set(schema?.browser_states ?? []);
  for (const state of expectedBrowserStates) {
    const destinations = schema?.browser_transitions?.[state];
    if (!Array.isArray(destinations) || destinations.length === 0) {
      errors.push(`missing browser transitions for state: ${state}`);
    } else if (destinations.some((value) => !browserStateSet.has(value))) {
      errors.push(`browser transition contains an unknown state: ${state}`);
    }
  }
  for (const state of Object.keys(schema?.browser_transitions ?? {})) {
    if (!browserStateSet.has(state)) {
      errors.push(`browser transition source is not a state: ${state}`);
    }
  }
  for (const [store, statesForStore] of Object.entries(
    schema?.autonomous_store_browser_states ?? {}
  )) {
    if (!(schema?.business_stores ?? []).includes(store)) {
      errors.push(`autonomous store contract references unknown store: ${store}`);
    }
    if (
      !Array.isArray(statesForStore) ||
      statesForStore.some((state) => !browserStateSet.has(state))
    ) {
      errors.push(`autonomous store contract has invalid states for ${store}`);
    }
  }
  if (
    Object.keys(schema?.autonomous_store_browser_states ?? {}).length !==
    (schema?.business_stores ?? []).length
  ) {
    errors.push("autonomous store contract must cover all business stores");
  }
  const preparationStatuses = new Set(schema?.preparation_statuses ?? []);
  const expectedPreparationStatuses = [
    "",
    "pending",
    "preparing",
    "message_ready",
    "needs_input",
    "external_steps",
    "repair_pending",
    "preparation_error"
  ];
  if (
    preparationStatuses.size !== expectedPreparationStatuses.length ||
    !expectedPreparationStatuses.every((status) =>
      preparationStatuses.has(status)
    )
  ) {
    errors.push("preparation_statuses must contain the supported lifecycle");
  }
  for (const status of expectedPreparationStatuses) {
    const destinations = schema?.preparation_transitions?.[status];
    if (!Array.isArray(destinations) || destinations.length === 0) {
      errors.push(
        `missing preparation transitions for status: ${status || "(blank)"}`
      );
    } else if (
      destinations.some((value) => !preparationStatuses.has(value))
    ) {
      errors.push(
        `preparation transition contains an unknown status: ${
          status || "(blank)"
        }`
      );
    }
  }
  for (const [from, destinations] of Object.entries(schema?.transitions ?? {})) {
    if (!statuses.has(from)) errors.push(`transition source is not a status: ${from}`);
    for (const to of destinations) {
      if (!statuses.has(to)) errors.push(`transition destination is not a status: ${to}`);
    }
  }
  for (const status of statuses) {
    if (!(status in (schema?.transitions ?? {}))) errors.push(`missing transitions for status: ${status}`);
    const supportedActions = schema?.actions_by_status?.[status];
    if (!Array.isArray(supportedActions) || supportedActions.length === 0) {
      errors.push(`missing actions_by_status for status: ${status}`);
    } else if (supportedActions.some((action) => !actions.has(action))) {
      errors.push(`actions_by_status contains an unsupported action for status: ${status}`);
    }
  }
  const expectedStores = [
    "Scraped Jobs",
    "To Review",
    "To Apply",
    "Applied Jobs",
    "Archive"
  ];
  if (
    JSON.stringify(schema?.business_stores) !== JSON.stringify(expectedStores)
  ) {
    errors.push(
      "business_stores must contain the five segmented stores in canonical order"
    );
  }
  const expectedAuthoritativeStores = {
    scraped: "Scraped Jobs",
    review: "To Review",
    apply: "To Apply",
    applied: "Applied Jobs",
    archived: "Archive",
    claims: "_System"
  };
  if (
    JSON.stringify(schema?.authoritative_stores) !==
    JSON.stringify(expectedAuthoritativeStores)
  ) {
    errors.push("authoritative_stores must match the segmented storage contract");
  }
  for (const store of expectedStores) {
    const statusRules = schema?.actions_by_store_status?.[store];
    if (!statusRules || typeof statusRules !== "object") {
      errors.push(`missing actions_by_store_status for store: ${store}`);
      continue;
    }
    for (const [status, storeActions] of Object.entries(statusRules)) {
      if (!statuses.has(status)) {
        errors.push(
          `actions_by_store_status references unknown status for ${store}: ${status}`
        );
        continue;
      }
      if (!Array.isArray(storeActions) || storeActions.length === 0) {
        errors.push(
          `actions_by_store_status requires actions for ${store}/${status}`
        );
        continue;
      }
      const globallyAllowed = new Set(schema?.actions_by_status?.[status] ?? []);
      for (const action of storeActions) {
        if (!actions.has(action) || !globallyAllowed.has(action)) {
          errors.push(
            `actions_by_store_status contains unsupported action for ${store}/${status}`
          );
        }
      }
    }
  }
  return errors;
}

export function validateUniqueIdentityAcrossStores(stores, schema, now = new Date().toISOString()) {
  const errors = [];
  const identities = new Map();
  for (const [store, rows] of Object.entries(stores ?? {})) {
    if (!Array.isArray(rows)) {
      errors.push(`${store} rows must be an array`);
      continue;
    }
    for (const [index, raw] of rows.entries()) {
      const record = normalizeLegacyRecord(raw, schema, now);
      const identity = String(record.canonical_job_id || "")
        .normalize("NFKC")
        .toLocaleLowerCase("en-US");
      if (!identity) {
        errors.push(`${store} row ${index + 2} has invalid identity`);
        continue;
      }
      const previous = identities.get(identity);
      if (previous) {
        errors.push(
          `duplicate canonical identity at ${previous.store} row ${previous.row} and ${store} row ${index + 2}`
        );
      } else {
        identities.set(identity, { store, row: index + 2 });
      }
    }
  }
  return errors;
}

export function canTransition(schema, from, to) {
  return (schema.transitions?.[from] ?? []).includes(to);
}

export function canTransitionPreparation(schema, from, to) {
  return (schema.preparation_transitions?.[from ?? ""] ?? []).includes(to ?? "");
}

export function canTransitionBrowser(schema, from, to) {
  return (schema.browser_transitions?.[from ?? ""] ?? []).includes(to ?? "");
}

export function transitionBrowserState(
  record,
  to,
  schema,
  now = new Date().toISOString()
) {
  const from = record?.browser_state;
  if (record?.execution_mode !== "autonomous_chrome") {
    throw new Error("Browser transitions require autonomous_chrome mode");
  }
  if (!canTransitionBrowser(schema, from, to)) {
    throw new Error(`Invalid browser transition: ${from} -> ${to}`);
  }
  const next = { ...record, browser_state: to, updated_at: now };
  const errors = validateRecordContract(next, schema);
  if (errors.length > 0) {
    throw new Error(`Invalid browser transition record: ${errors.join("; ")}`);
  }
  return { ...next, state_guard: stateGuard(next) };
}

export function transitionRecord(record, to, schema, now = new Date().toISOString()) {
  const from = record.pipeline_status;
  if (!canTransition(schema, from, to)) {
    throw new Error(`Invalid pipeline transition: ${from} -> ${to}`);
  }
  const next = {
    ...record,
    pipeline_status: to,
    updated_at: now
  };
  return { ...next, state_guard: stateGuard(next) };
}

export function isStaleClaim(record, nowMs, leaseMs) {
  if (!record.processing_token || !record.processing_started_at) return true;
  const startedAt = Date.parse(record.processing_started_at);
  return !Number.isFinite(startedAt) || nowMs - startedAt >= leaseMs;
}

export function processingCommitGuard(token) {
  const value = String(token || "").trim();
  return value ? `commit:${value}` : "";
}

export function claimRecord(record, { stage, token, now, leaseMs }) {
  const nowMs = Date.parse(now);
  if (!stage || !token || !Number.isFinite(nowMs) || !Number.isFinite(leaseMs) || leaseMs < 1) {
    throw new Error("stage, token, valid now, and positive leaseMs are required");
  }
  if (record.processing_token && !isStaleClaim(record, nowMs, leaseMs)) {
    return { claimed: false, record };
  }
  const claimedRecord = {
    ...record,
    processing_stage: stage,
    processing_token: token,
    processing_commit_guard: processingCommitGuard(token),
    processing_started_at: now,
    updated_at: now
  };
  return {
    claimed: true,
    record: { ...claimedRecord, state_guard: stateGuard(claimedRecord) }
  };
}

export function releaseClaim(record, token, now = new Date().toISOString()) {
  if (record.processing_token && record.processing_token !== token) {
    throw new Error("processing token mismatch");
  }
  const next = {
    ...record,
    processing_stage: "",
    processing_token: "",
    processing_started_at: "",
    updated_at: now
  };
  return { ...next, state_guard: stateGuard(next) };
}

export function createProcessingClaim(record, executionId, now, leaseMs) {
  const token = `${executionId}:${record.canonical_job_id}:${record.work_stage}`;
  return {
    canonical_job_id: record.canonical_job_id,
    processing_stage: record.work_stage,
    processing_token: token,
    created_at: now,
    expires_at: new Date(Date.parse(now) + leaseMs).toISOString()
  };
}

export function chooseWinningClaims(proposedRecords, allClaims, now = new Date().toISOString()) {
  const claimKey = (record) =>
    `${String(record?.canonical_job_id || "")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")}:${String(
      record?.processing_stage || record?.work_stage || ""
    ).trim()}`;
  const nowMs = Date.parse(now);
  const expectedLeaseMsByKey = new Map();
  for (const record of proposedRecords) {
    const claimCreatedAt = Date.parse(
      record?.claim_created_at ?? record?.created_at
    );
    const claimExpiresAt = Date.parse(
      record?.claim_expires_at ?? record?.expires_at
    );
    const leaseMs = claimExpiresAt - claimCreatedAt;
    if (Number.isFinite(leaseMs) && leaseMs > 0) {
      expectedLeaseMsByKey.set(claimKey(record), leaseMs);
    }
  }
  const rowNumberCounts = new Map();
  for (const claim of allClaims) {
    const rowNumber = Number(claim?.row_number);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) continue;
    rowNumberCounts.set(
      rowNumber,
      (rowNumberCounts.get(rowNumber) || 0) + 1
    );
  }
  const validClaims = allClaims.filter((claim) => {
    const createdAt = Date.parse(claim.created_at);
    const expiresAt = Date.parse(claim.expires_at);
    const rowNumber = Number(claim.row_number);
    const expectedLeaseMs = expectedLeaseMsByKey.get(claimKey(claim));
    return (
      claim.canonical_job_id &&
      claim.processing_stage &&
      claim.processing_token &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= nowMs &&
      expiresAt > createdAt &&
      expiresAt > nowMs &&
      (!Number.isFinite(expectedLeaseMs) ||
        expiresAt - createdAt <= expectedLeaseMs) &&
      Number.isInteger(rowNumber) &&
      rowNumber >= 2 &&
      rowNumberCounts.get(rowNumber) === 1
    );
  });
  const winners = new Map();
  for (const claim of validClaims) {
    const key = claimKey(claim);
    const current = winners.get(key);
    const claimRow = Number(claim.row_number);
    if (!current || claimRow < Number(current.row_number)) {
      winners.set(key, claim);
    }
  }
  const emitted = new Set();
  return proposedRecords.filter((record) => {
    const key = claimKey(record);
    if (
      emitted.has(key) ||
      winners.get(key)?.processing_token !== record.processing_token
    ) {
      return false;
    }
    emitted.add(key);
    return true;
  });
}
