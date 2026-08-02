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
  "required_input", "review_approved_at", "review_approval_note",
  "review_approval_guard", "qualification_score", "opportunity_score",
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
  "application_pack_generated_at", "alert_status", "alert_idempotency_key",
  "alert_claim_token", "alert_attempt_count", "alert_last_attempt_at",
  "alert_next_retry_at", "alert_sent_at", "alert_provider_reference",
  "alert_error_category", "alert_error_summary", "applied_at", "archived_at",
  "archive_reason", "outcome_recorded_value", "outcome_at",
  "created_at"
];

export function stateGuard(record) {
  const canonicalId = String(record.canonical_job_id || canonicalJobId(record) || "");
  if (!canonicalId) return "";
  const guardedRecord = Object.fromEntries(
    // A missing top-level field becomes a blank Sheet cell on persistence.
    // Canonicalizing it here keeps digests stable across that round trip.
    STATE_GUARD_FIELDS.map((field) => [field, record?.[field] ?? ""])
  );
  return `${canonicalId}|${contractDigest(guardedRecord)}`;
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
  const processingToken = String(record?.processing_token || "").trim();
  const processingStage = String(record?.processing_stage || "").trim();
  const processingStartedAt = String(record?.processing_started_at || "").trim();
  if (
    processingToken &&
    (!["evaluation", "generation"].includes(processingStage) ||
      !Number.isFinite(Date.parse(processingStartedAt)))
  ) {
    errors.push(
      "processing_token requires an evaluation/generation stage and valid start time"
    );
  }
  if (!processingToken && processingStartedAt) {
    errors.push("processing_started_at requires processing_token");
  }
  if (record?.pipeline_status === "processing" && !processingToken) {
    errors.push("processing status requires processing_token");
  }
  const alertClaimToken = String(record?.alert_claim_token || "").trim();
  if (record?.alert_status === "sending" && !alertClaimToken) {
    errors.push("sending alert status requires alert_claim_token");
  }
  if (record?.alert_status !== "sending" && alertClaimToken) {
    errors.push("alert_claim_token is only valid while sending");
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
  } else if (!allowedActions.includes(record?.user_action ?? "")) {
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
  if (schema?.schema_version !== 3) errors.push("schema_version must be 3");
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
    !["", "I Applied", "Skip", "Approve", "Deny"].every((action) =>
      actions.has(action)
    )
  ) {
    errors.push("user_actions must contain only the supported operator actions");
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
