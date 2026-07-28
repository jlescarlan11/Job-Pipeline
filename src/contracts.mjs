export function normalizeCanonicalUrl(value) {
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(String(value).trim(), "https://www.onlinejobs.ph");
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return "";
  parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.hostname === "www.onlinejobs.ph") parsed.hostname = "onlinejobs.ph";
  if (parsed.hostname !== "onlinejobs.ph") return "";
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!/^\/jobseekers\/job\/[^/]+$/i.test(parsed.pathname)) return "";
  parsed.port = "";
  return parsed.toString();
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
    String(record.outcome || "")
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < state.length; index += 1) {
    hash ^= state.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonicalId}|${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  record.search_queries = parseList(record.search_queries);
  record.role_families = parseList(record.role_families);
  record.attempt_count = Number.isFinite(Number(record.attempt_count))
    ? Number(record.attempt_count)
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

export function validatePipelineSchema(schema) {
  const errors = [];
  if (schema?.schema_version !== 1) errors.push("schema_version must be 1");
  if (!Array.isArray(schema?.fields) || schema.fields.length === 0) errors.push("fields are required");
  if (!Array.isArray(schema?.pipeline_statuses) || schema.pipeline_statuses.length === 0) {
    errors.push("pipeline_statuses are required");
  }
  const duplicateFields = schema?.fields?.filter((field, index, all) => all.indexOf(field) !== index) ?? [];
  if (duplicateFields.length > 0) errors.push(`duplicate fields: ${[...new Set(duplicateFields)].join(", ")}`);

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
