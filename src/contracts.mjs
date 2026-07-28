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

export function stateGuard(record) {
  const canonicalId = String(record.canonical_job_id || canonicalJobId(record) || "");
  if (!canonicalId) return "";
  const state = [
    canonicalId,
    String(record.pipeline_status || ""),
    String(record.application_decision || ""),
    String(record.first_reviewed_at || ""),
    String(record.apply_points_used || ""),
    String(record.application_message_strategy || ""),
    String(record.outcome || ""),
    JSON.stringify(Array.isArray(record.outcome_events) ? record.outcome_events : [])
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < state.length; index += 1) {
    hash ^= state.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonicalId}|${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
    (schema.pipeline_statuses.includes(legacyStatus) ? legacyStatus : "discovered");
  record.source = String(record.source || "onlinejobs.ph").trim().toLowerCase();
  record.canonical_url = normalizeCanonicalUrl(record.canonical_url || record.job_url);
  record.source_job_id = String(record.source_job_id || extractOnlineJobsId(record.canonical_url) || "");
  record.canonical_job_id = String(record.canonical_job_id || canonicalJobId(record));
  for (const field of schema.string_list_fields ?? ["search_queries", "role_families"]) {
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
  record.alert_attempt_count = Number.isFinite(Number(record.alert_attempt_count))
    ? Number(record.alert_attempt_count)
    : 0;
  record.created_at = record.created_at || now;
  record.updated_at = record.updated_at || now;
  record.source_availability = record.source_availability || "unknown";
  record.profile_version = record.profile_version || "legacy/unknown";
  record.message_profile_version =
    record.message_profile_version ||
    (record.generated_message ? "legacy/unknown" : "");
  record.application_decision =
    record.application_decision ||
    (record.pipeline_status === "applied" ? "applied" : record.pipeline_status === "skipped" ? "skipped" : "");
  record.outcome = record.outcome || "";
  record.manual_action = record.manual_action || "";
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
  if (schema?.schema_version !== 1) errors.push("schema_version must be 1");
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

  const statuses = new Set(schema?.pipeline_statuses ?? []);
  for (const [from, destinations] of Object.entries(schema?.transitions ?? {})) {
    if (!statuses.has(from)) errors.push(`transition source is not a status: ${from}`);
    for (const to of destinations) {
      if (!statuses.has(to)) errors.push(`transition destination is not a status: ${to}`);
    }
  }
  for (const status of statuses) {
    if (!(status in (schema?.transitions ?? {}))) errors.push(`missing transitions for status: ${status}`);
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

export function claimRecord(record, { stage, token, now, leaseMs }) {
  const nowMs = Date.parse(now);
  if (!stage || !token || !Number.isFinite(nowMs) || !Number.isFinite(leaseMs) || leaseMs < 1) {
    throw new Error("stage, token, valid now, and positive leaseMs are required");
  }
  if (record.processing_token && !isStaleClaim(record, nowMs, leaseMs)) {
    return { claimed: false, record };
  }
  return {
    claimed: true,
    record: {
      ...record,
      processing_stage: stage,
      processing_token: token,
      processing_started_at: now,
      updated_at: now
    }
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
  const nowMs = Date.parse(now);
  const validClaims = allClaims.filter((claim) => {
    const createdAt = Date.parse(claim.created_at);
    const expiresAt = Date.parse(claim.expires_at);
    return claim.canonical_job_id && claim.processing_stage && claim.processing_token &&
      Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > nowMs;
  });
  const winners = new Map();
  for (const claim of validClaims) {
    const key = `${claim.canonical_job_id}:${claim.processing_stage}`;
    const current = winners.get(key);
    const claimRow = Number(claim.row_number);
    const currentRow = Number(current?.row_number);
    const bothHaveRows = Number.isFinite(claimRow) && Number.isFinite(currentRow);
    if (
      !current ||
      (bothHaveRows && claimRow < currentRow) ||
      (!bothHaveRows && Date.parse(claim.created_at) < Date.parse(current.created_at)) ||
      (!bothHaveRows &&
        claim.created_at === current.created_at &&
        claim.processing_token < current.processing_token)
    ) {
      winners.set(key, claim);
    }
  }
  return proposedRecords.filter((record) => {
    const key = `${record.canonical_job_id}:${record.work_stage}`;
    return winners.get(key)?.processing_token === record.processing_token;
  });
}
