import {
  mergeOutcomeEvents,
  normalizeLegacyRecord
} from "./contracts.mjs";

const DAY_MS = 86_400_000;
const OUTCOME_METRICS = {
  replied: "reply_rate",
  interview: "interview_rate",
  offer: "offer_rate",
  rejected: "rejection_rate",
  no_response: "no_response_rate"
};
const IMMUTABLE_APPLICATION_FIELDS = [
  "application_qualification_score",
  "application_opportunity_score",
  "application_ranking_confidence",
  "application_scoring_policy_version",
  "application_apply_points_recommendation",
  "application_pack_status_at_apply",
  "application_posting_age_days",
  "application_message_strategy",
  "apply_points_used",
  "application_snapshot_at",
  "application_decided_at"
];

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function validContractValue(value, rule) {
  if (!rule || value === "" || value === undefined || value === null) {
    return false;
  }
  if (rule.type === "enum") return rule.values?.includes(value) === true;
  if (rule.type === "string") {
    return (
      typeof value === "string" &&
      (rule.maximum_length === undefined ||
        value.length <= rule.maximum_length) &&
      (!rule.pattern || new RegExp(rule.pattern).test(value))
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (rule.type === "integer" && !Number.isInteger(value)) return false;
  if (rule.minimum !== undefined && value < rule.minimum) return false;
  if (rule.maximum !== undefined && value > rule.maximum) return false;
  return true;
}

function safeDivide(numerator, denominator, multiplier = 1) {
  return denominator > 0
    ? Math.round((numerator / denominator) * multiplier * 1_000_000) / 1_000_000
    : "";
}

function safeSheetText(value, maximum = 500) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function uniqueStrings(...values) {
  return [
    ...new Set(
      values
        .flat()
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ].sort((left, right) => left.localeCompare(right));
}

function uniqueObjects(values, keyFor) {
  const result = new Map();
  for (const value of values.flat()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const key = keyFor(value);
    if (!key || result.has(key)) continue;
    result.set(key, value);
  }
  return [...result.values()];
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

export function stableSha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const lengthView = new DataView(padded.buffer);
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
  const state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = lengthView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 =
        rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
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
  return [...state]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

function reportId(policy, resultKey) {
  const version = policy.metric_definition_version.replace(/[^a-z0-9]+/gi, "-");
  return `analytics-${version}-${resultKey}`;
}

function validateBands(bands, maximum, name) {
  if (
    !Array.isArray(bands) ||
    bands.length === 0 ||
    bands.some(
      (band) =>
        !/^[a-z0-9_]+$/.test(band?.key ?? "") ||
        typeof band?.label !== "string" ||
        !Number.isFinite(band?.maximum)
    )
  ) {
    return [`${name} are invalid`];
  }
  const errors = [];
  for (let index = 0; index < bands.length; index += 1) {
    if (index > 0 && bands[index].maximum <= bands[index - 1].maximum) {
      errors.push(`${name} must be ordered by increasing maximum`);
      break;
    }
  }
  if (bands.at(-1).maximum < maximum) {
    errors.push(`${name} do not cover the supported maximum`);
  }
  return errors;
}

export function validateAnalyticsPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["analytics policy must be an object"];
  }
  if (policy.schema_version !== 1) {
    errors.push("analytics policy schema_version must be 1");
  }
  for (const field of ["metric_definition_version", "band_version"]) {
    if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(policy[field] ?? "")) {
      errors.push(`${field} must use YYYY-MM-DD/vN`);
    }
  }
  if (!Number.isInteger(policy.schedule_hours) || policy.schedule_hours < 1) {
    errors.push("schedule_hours must be a positive integer");
  }
  if (
    !Number.isInteger(policy.execution_timeout_seconds) ||
    policy.execution_timeout_seconds < 1
  ) {
    errors.push("execution_timeout_seconds must be a positive integer");
  } else if (
    Number.isInteger(policy.schedule_hours) &&
    policy.execution_timeout_seconds >= policy.schedule_hours * 60 * 60
  ) {
    errors.push("execution timeout must be shorter than the analytics schedule");
  }
  try {
    new Intl.DateTimeFormat("en-CA", {
      timeZone: policy.analysis_timezone
    }).format(new Date());
  } catch {
    errors.push("analysis_timezone must be a supported IANA timezone");
  }
  if (policy.analysis_window?.type !== "all_time") {
    errors.push("only the explicit all_time analysis window is supported");
  }
  if (policy.attribution?.policy !== "multi_touch_full_credit") {
    errors.push("attribution policy must be multi_touch_full_credit");
  }
  const expectedNonAdditive = [
    "matched_skill",
    "requirement_gap",
    "role_family",
    "search_query"
  ];
  if (
    JSON.stringify(
      [...(policy.attribution?.non_additive_dimensions ?? [])].sort()
    ) !== JSON.stringify(expectedNonAdditive)
  ) {
    errors.push("non-additive dimensions are incomplete");
  }
  if (
    !Number.isFinite(
      policy.top_ranked?.minimum_application_opportunity_score
    ) ||
    policy.top_ranked.minimum_application_opportunity_score < 0 ||
    policy.top_ranked.minimum_application_opportunity_score > 100
  ) {
    errors.push("top-ranked threshold must be between 0 and 100");
  }
  errors.push(...validateBands(policy.score_bands, 100, "score_bands"));
  errors.push(
    ...validateBands(policy.posting_age_bands, 36500, "posting_age_bands")
  );
  errors.push(
    ...validateBands(policy.salary?.bands, 1_000_000_000, "salary.bands")
  );
  if (
    policy.salary?.currency !== "PHP" ||
    policy.salary?.period !== "month"
  ) {
    errors.push("analytics supports only PHP monthly salary bands");
  }
  const expectedDimensions = [
    "search_query",
    "role_family",
    "qualification_score_band",
    "opportunity_score_band",
    "confidence",
    "matched_skill",
    "requirement_gap",
    "salary_band",
    "posting_age_band",
    "apply_points_used",
    "apply_points_recommendation",
    "message_strategy",
    "instruction_completeness",
    "rank_cohort"
  ];
  if (
    JSON.stringify(policy.dimension_order) !==
    JSON.stringify(expectedDimensions)
  ) {
    errors.push("dimension_order must define every supported dimension once");
  }
  if (
    JSON.stringify(policy.outcomes) !==
    JSON.stringify(["replied", "interview", "offer", "rejected", "no_response"])
  ) {
    errors.push("outcomes must define every explicit supported outcome once");
  }
  for (const [field, expected] of [
    ["detail_fields", 23],
    ["report_fields", 14]
  ]) {
    if (
      !Array.isArray(policy[field]) ||
      policy[field].length !== expected ||
      new Set(policy[field]).size !== policy[field].length
    ) {
      errors.push(`${field} are invalid`);
    }
  }
  for (const field of ["detail_sheet", "reports_sheet"]) {
    if (!String(policy[field] || "").trim()) errors.push(`${field} is required`);
  }
  return errors;
}

function mergeAnalyticsRecords(current, incoming, diagnostics) {
  if (!current) return incoming;
  diagnostics.overlap_records += 1;
  const currentUpdated = timestamp(current.updated_at) ?? Number.NEGATIVE_INFINITY;
  const incomingUpdated = timestamp(incoming.updated_at) ?? Number.NEGATIVE_INFINITY;
  const newer = incomingUpdated >= currentUpdated ? incoming : current;
  const older = newer === incoming ? current : incoming;
  const merged = { ...older };
  for (const [field, value] of Object.entries(newer)) {
    if (hasValue(value)) merged[field] = value;
  }
  merged.search_queries = uniqueStrings(
    current.search_queries,
    incoming.search_queries
  );
  merged.role_families = uniqueStrings(
    current.role_families,
    incoming.role_families
  );
  merged.match_reasons = uniqueStrings(
    current.match_reasons,
    incoming.match_reasons
  );
  merged.requirement_gaps = uniqueStrings(
    current.requirement_gaps,
    incoming.requirement_gaps
  );
  merged.outcome_events = mergeOutcomeEvents(
    current.outcome_events,
    incoming.outcome_events
  );
  merged.requirement_gap_details = uniqueObjects(
    [current.requirement_gap_details, incoming.requirement_gap_details],
    (gap) =>
      `${String(gap.classification || "unknown").trim()}\u001f${String(gap.requirement || "").trim().toLowerCase()}`
  );
  merged.application_warnings = uniqueObjects(
    [current.application_warnings, incoming.application_warnings],
    (warning) =>
      [
        warning.code,
        warning.category,
        warning.instruction_id,
        warning.question_id
      ]
        .map((value) => String(value || "").trim())
        .join("\u001f")
  );
  merged.__analytics_malformed_requirement_gap_details =
    current.__analytics_malformed_requirement_gap_details === true ||
    incoming.__analytics_malformed_requirement_gap_details === true;
  merged.__analytics_malformed_application_warnings =
    current.__analytics_malformed_application_warnings === true ||
    incoming.__analytics_malformed_application_warnings === true;

  const currentOutcomeAt = timestamp(current.outcome_at);
  const incomingOutcomeAt = timestamp(incoming.outcome_at);
  if (
    currentOutcomeAt !== undefined &&
    (incomingOutcomeAt === undefined || currentOutcomeAt > incomingOutcomeAt)
  ) {
    merged.outcome = current.outcome;
    merged.outcome_at = current.outcome_at;
  } else if (incomingOutcomeAt !== undefined) {
    merged.outcome = incoming.outcome;
    merged.outcome_at = incoming.outcome_at;
  }

  const snapshotCandidates = [current, incoming]
    .filter((record) => timestamp(record.application_snapshot_at) !== undefined)
    .sort(
      (left, right) =>
        timestamp(left.application_snapshot_at) -
        timestamp(right.application_snapshot_at)
    );
  if (snapshotCandidates.length > 0) {
    const canonicalSnapshot = snapshotCandidates[0];
    for (const field of IMMUTABLE_APPLICATION_FIELDS) {
      merged[field] =
        snapshotCandidates.find((record) => hasValue(record[field]))?.[field] ??
        canonicalSnapshot[field] ??
        "";
    }
    if (
      snapshotCandidates.length > 1 &&
      IMMUTABLE_APPLICATION_FIELDS.some(
        (field) =>
          hasValue(snapshotCandidates[0][field]) &&
          hasValue(snapshotCandidates[1][field]) &&
          String(snapshotCandidates[0][field]) !==
            String(snapshotCandidates[1][field])
      )
    ) {
      diagnostics.application_snapshot_conflicts += 1;
    }
  }

  const decisions = uniqueStrings(
    current.application_decision,
    incoming.application_decision
  );
  if (decisions.length > 1) {
    diagnostics.application_decision_conflicts += 1;
    const decisionSource = [current, incoming]
      .filter((record) => record.application_decision)
      .sort(
        (left, right) =>
          (timestamp(right.application_decided_at) ??
            timestamp(right.updated_at) ??
            Number.NEGATIVE_INFINITY) -
          (timestamp(left.application_decided_at) ??
            timestamp(left.updated_at) ??
            Number.NEGATIVE_INFINITY)
      )[0];
    merged.application_decision = decisionSource.application_decision;
  }
  return merged;
}

export function deduplicateAnalyticsRecords(
  activeRows,
  archiveRows,
  schema,
  now = new Date().toISOString()
) {
  const records = new Map();
  const diagnostics = {
    input_rows: activeRows.length + archiveRows.length,
    invalid_identity_rows: 0,
    overlap_records: 0,
    application_snapshot_conflicts: 0,
    application_decision_conflicts: 0,
    malformed_outcome_history_rows: 0,
    malformed_requirement_gap_rows: 0,
    malformed_application_warning_rows: 0
  };
  for (const raw of [...activeRows, ...archiveRows]) {
    const normalized = normalizeLegacyRecord(raw, schema, now);
    if (!Array.isArray(normalized.outcome_events)) {
      diagnostics.malformed_outcome_history_rows += 1;
    }
    if (!Array.isArray(normalized.requirement_gap_details)) {
      diagnostics.malformed_requirement_gap_rows += 1;
      normalized.__analytics_malformed_requirement_gap_details = true;
    }
    if (!Array.isArray(normalized.application_warnings)) {
      diagnostics.malformed_application_warning_rows += 1;
      normalized.__analytics_malformed_application_warnings = true;
    }
    if (!normalized.canonical_job_id) {
      diagnostics.invalid_identity_rows += 1;
      continue;
    }
    records.set(
      normalized.canonical_job_id,
      mergeAnalyticsRecords(
        records.get(normalized.canonical_job_id),
        normalized,
        diagnostics
      )
    );
  }
  return {
    records: [...records.values()].sort((left, right) =>
      left.canonical_job_id.localeCompare(right.canonical_job_id)
    ),
    diagnostics
  };
}

function isApplied(record) {
  return (
    record.application_decision === "applied" ||
    (record.pipeline_status === "archived" &&
      record.archived_from_status === "applied")
  );
}

function outcomeSet(record) {
  const outcomes = new Set();
  for (const event of Array.isArray(record.outcome_events)
    ? record.outcome_events
    : []) {
    if (OUTCOME_METRICS[event?.type]) outcomes.add(event.type);
  }
  if (OUTCOME_METRICS[record.outcome]) outcomes.add(record.outcome);
  return outcomes;
}

function bandFor(value, bands) {
  const numeric = safeNumber(value);
  if (numeric === undefined || numeric < 0) {
    return { key: "unknown", label: "Unknown", known: false };
  }
  const band = bands.find((candidate) => numeric <= candidate.maximum);
  return band
    ? { key: band.key, label: band.label, known: true }
    : { key: "unknown", label: "Unknown", known: false };
}

function parseMonthlyPhpSalary(value) {
  const text = String(value || "").normalize("NFKC").slice(0, 2000);
  if (
    !text ||
    !/(?:PHP|₱)/i.test(text) ||
    !/(?:\/\s*month|per month|monthly)/i.test(text) ||
    /\b(?:USD|EUR|GBP|AUD|CAD)\b|US\$/i.test(text)
  ) {
    return undefined;
  }
  const match = text.match(
    /(?:PHP|₱)\s*([\d,.]+)(?:\s*(?:-|to)\s*(?:PHP|₱)?\s*([\d,.]+))?/i
  );
  const amounts = [match?.[1], match?.[2]]
    .filter(Boolean)
    .map((part) => Number(part.replace(/,/g, "")))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return amounts.length > 0
    ? amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length
    : undefined;
}

function matchedSkills(record) {
  const values = (Array.isArray(record.match_reasons)
    ? record.match_reasons
    : []
  )
    .map((reason) => String(reason).match(/^Matched skill:\s*(.+)$/i)?.[1])
    .filter(Boolean);
  if (values.length > 0) return uniqueStrings(values);
  return record.evaluated_at || record.scoring_policy_version ? ["none"] : [];
}

function requirementGaps(record) {
  const structured = Array.isArray(record.requirement_gap_details)
    ? record.requirement_gap_details
        .filter((gap) => gap?.requirement)
        .map(
          (gap) =>
            `${gap.classification || "unknown"}:${String(gap.requirement).trim()}`
        )
    : [];
  if (structured.length > 0) return uniqueStrings(structured);
  const legacy = Array.isArray(record.requirement_gaps)
    ? record.requirement_gaps
    : [];
  if (legacy.length > 0) {
    return uniqueStrings(legacy.map((gap) => `unknown:${gap}`));
  }
  return record.evaluated_at || record.scoring_policy_version ? ["none"] : [];
}

function dimensionValues(record, dimension, policy, schema) {
  if (dimension === "search_query") {
    return uniqueStrings(record.search_queries).map((value) => ({
      key: value,
      label: value,
      known: true
    }));
  }
  if (dimension === "role_family") {
    return uniqueStrings(record.role_families).map((value) => ({
      key: value,
      label: value,
      known: true
    }));
  }
  if (dimension === "qualification_score_band") {
    return [
      bandFor(
        validContractValue(
          record.application_qualification_score,
          schema.field_rules?.application_qualification_score
        )
          ? record.application_qualification_score
          : undefined,
        policy.score_bands
      )
    ];
  }
  if (dimension === "opportunity_score_band") {
    return [
      bandFor(
        validContractValue(
          record.application_opportunity_score,
          schema.field_rules?.application_opportunity_score
        )
          ? record.application_opportunity_score
          : undefined,
        policy.score_bands
      )
    ];
  }
  if (dimension === "confidence") {
    const value = validContractValue(
      record.application_ranking_confidence,
      schema.field_rules?.application_ranking_confidence
    )
      ? record.application_ranking_confidence
      : "";
    return [
      value
        ? { key: value, label: value, known: true }
        : { key: "unknown", label: "Unknown", known: false }
    ];
  }
  if (dimension === "matched_skill") {
    return matchedSkills(record).map((value) => ({
      key: value,
      label: value === "none" ? "No matched skill" : value,
      known: true
    }));
  }
  if (dimension === "requirement_gap") {
    return requirementGaps(record).map((value) => ({
      key: value,
      label: value === "none" ? "No requirement gap" : value,
      known: true
    }));
  }
  if (dimension === "salary_band") {
    return [
      bandFor(
        parseMonthlyPhpSalary(record.salary_text),
        policy.salary.bands
      )
    ];
  }
  if (dimension === "posting_age_band") {
    return [
      bandFor(
        validContractValue(
          record.application_posting_age_days,
          schema.field_rules?.application_posting_age_days
        )
          ? record.application_posting_age_days
          : undefined,
        policy.posting_age_bands
      )
    ];
  }
  if (dimension === "apply_points_used") {
    const points = safeNumber(record.apply_points_used);
    return [
      points !== undefined &&
      validContractValue(points, schema.field_rules?.apply_points_used)
        ? { key: String(points), label: `${points} points`, known: true }
        : { key: "unknown", label: "Unknown", known: false }
    ];
  }
  if (dimension === "apply_points_recommendation") {
    const value = validContractValue(
      record.application_apply_points_recommendation,
      schema.field_rules?.application_apply_points_recommendation
    )
      ? record.application_apply_points_recommendation
      : "";
    return [
      value
        ? { key: value, label: value, known: true }
        : { key: "unknown", label: "Unknown", known: false }
    ];
  }
  if (dimension === "message_strategy") {
    const value = validContractValue(
      record.application_message_strategy,
      schema.field_rules?.application_message_strategy
    )
      ? record.application_message_strategy
      : "";
    return [
      value
        ? { key: value, label: value, known: true }
        : { key: "unknown", label: "Unknown", known: false }
    ];
  }
  if (dimension === "instruction_completeness") {
    const status = validContractValue(
      record.application_pack_status_at_apply,
      schema.field_rules?.application_pack_status_at_apply
    )
      ? record.application_pack_status_at_apply
      : "";
    return [
      status === "ready"
        ? { key: "complete", label: "Instruction complete", known: true }
        : ["review_required", "blocked"].includes(status)
          ? { key: "incomplete", label: "Instruction incomplete", known: true }
          : { key: "unknown", label: "Unknown", known: false }
    ];
  }
  if (dimension === "rank_cohort") {
    const score = validContractValue(
      record.application_opportunity_score,
      schema.field_rules?.application_opportunity_score
    )
      ? record.application_opportunity_score
      : undefined;
    return [
      score === undefined
        ? { key: "unknown", label: "Unknown", known: false }
        : score >= policy.top_ranked.minimum_application_opportunity_score
          ? { key: "top_ranked", label: "Top-ranked", known: true }
          : { key: "lower_ranked", label: "Lower-ranked", known: true }
    ];
  }
  return [];
}

function dayKey(value, timeZone) {
  const parsed = timestamp(value);
  if (parsed === undefined) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(parsed));
}

function baseRow(metadata, values = {}) {
  return {
    report_id: metadata.report_id,
    metric_definition_version: metadata.metric_definition_version,
    band_version: metadata.band_version,
    generated_at: metadata.generated_at,
    window_type: metadata.window_type,
    window_start_at: metadata.window_start_at,
    window_end_at: metadata.window_end_at,
    section: safeSheetText(values.section || "overall", 100),
    dimension: safeSheetText(values.dimension || "overall", 100),
    segment_key: safeSheetText(values.segment_key || "all"),
    segment_label: safeSheetText(
      values.segment_label || "All applications"
    ),
    metric_key: safeSheetText(values.metric_key || "", 120),
    numerator: values.numerator ?? "",
    denominator: values.denominator ?? "",
    value: values.value ?? "",
    unit: safeSheetText(values.unit || "count", 80),
    sample_size: values.sample_size ?? "",
    coverage_numerator: values.coverage_numerator ?? "",
    coverage_denominator: values.coverage_denominator ?? "",
    attribution: safeSheetText(values.attribution || "deduplicated", 120),
    non_additive: values.non_additive === true,
    note: safeSheetText(values.note || "", 1000)
  };
}

function conversionRows(metadata, cohort, values, policy) {
  const outcomes = new Map(
    policy.outcomes.map((outcome) => [
      outcome,
      cohort.filter((record) => outcomeSet(record).has(outcome)).length
    ])
  );
  const rows = [
    baseRow(metadata, {
      ...values,
      metric_key: "application_count",
      numerator: cohort.length,
      denominator: cohort.length,
      value: cohort.length,
      sample_size: cohort.length
    })
  ];
  for (const outcome of policy.outcomes) {
    const numerator = outcomes.get(outcome);
    rows.push(
      baseRow(metadata, {
        ...values,
        metric_key: OUTCOME_METRICS[outcome],
        numerator,
        denominator: cohort.length,
        value: safeDivide(numerator, cohort.length),
        unit: "rate",
        sample_size: cohort.length
      })
    );
  }
  return rows;
}

function dimensionsReport(metadata, applications, policy, schema) {
  const rows = [];
  for (const dimension of policy.dimension_order) {
    const segments = new Map();
    let knownApplications = 0;
    for (const application of applications) {
      let values = dimensionValues(application, dimension, policy, schema);
      if (values.length === 0) {
        values = [{ key: "unknown", label: "Unknown", known: false }];
      }
      if (values.some((value) => value.known)) knownApplications += 1;
      for (const value of values) {
        if (!segments.has(value.key)) {
          segments.set(value.key, { label: value.label, records: [] });
        }
        segments.get(value.key).records.push(application);
      }
    }
    const nonAdditive =
      policy.attribution.non_additive_dimensions.includes(dimension);
    const section = [
      "qualification_score_band",
      "opportunity_score_band"
    ].includes(dimension)
      ? "calibration"
      : ["instruction_completeness", "rank_cohort"].includes(dimension)
        ? "comparison"
        : "conversion";
    rows.push(
      baseRow(metadata, {
        section: "coverage",
        dimension,
        segment_key: "all",
        segment_label: "Known dimension coverage",
        metric_key: "known_application_coverage",
        numerator: knownApplications,
        denominator: applications.length,
        value: safeDivide(knownApplications, applications.length),
        unit: "rate",
        sample_size: applications.length,
        coverage_numerator: knownApplications,
        coverage_denominator: applications.length,
        attribution: nonAdditive
          ? policy.attribution.policy
          : "exclusive",
        non_additive: nonAdditive,
        note: nonAdditive
          ? "Multi-touch full-credit segment totals are non-additive; overall totals count each canonical application once."
          : ""
      })
    );
    for (const [key, segment] of [...segments.entries()].sort(
      ([left], [right]) =>
        (left === "unknown") - (right === "unknown") ||
        left.localeCompare(right)
    )) {
      rows.push(
        ...conversionRows(
          metadata,
          segment.records,
          {
            section,
            dimension,
            segment_key: key,
            segment_label: segment.label,
            attribution: nonAdditive
              ? policy.attribution.policy
              : "exclusive",
            non_additive: nonAdditive,
            note: nonAdditive
              ? "Non-additive multi-touch attribution."
              : ""
          },
          policy
        )
      );
    }
  }
  return rows;
}

function discoveryAndSkillDemandRows(metadata, records, policy) {
  const rows = [];
  for (const [dimension, field] of [
    ["search_query", "search_queries"],
    ["role_family", "role_families"]
  ]) {
    const segments = new Map();
    for (const record of records) {
      const values = uniqueStrings(record[field]);
      for (const value of values.length > 0 ? values : ["unknown"]) {
        if (!segments.has(value)) segments.set(value, new Set());
        segments.get(value).add(record.canonical_job_id);
      }
    }
    for (const [key, identities] of [...segments.entries()].sort(
      ([left], [right]) =>
        (left === "unknown") - (right === "unknown") ||
        left.localeCompare(right)
    )) {
      rows.push(
        baseRow(metadata, {
          section: "discovery_volume",
          dimension,
          segment_key: key,
          segment_label: key === "unknown" ? "Unknown" : key,
          metric_key: "discovered_job_count",
          numerator: identities.size,
          denominator: records.length,
          value: identities.size,
          unit: "count",
          sample_size: records.length,
          attribution: policy.attribution.policy,
          non_additive: true,
          note:
            "Multi-touch discovery volume is non-additive and is not conversion evidence by itself."
        })
      );
    }
  }

  const promising = records.filter(
    (record) =>
      safeNumber(record.opportunity_score) !== undefined &&
      record.opportunity_score >=
        policy.top_ranked.minimum_application_opportunity_score
  );
  const requests = new Map();
  let evaluatedPromising = 0;
  for (const record of promising) {
    const gapDetails = Array.isArray(record.requirement_gap_details)
      ? record.requirement_gap_details
      : undefined;
    if (
      !record.__analytics_malformed_requirement_gap_details &&
      (record.evaluated_at ||
        record.scoring_policy_version ||
        gapDetails?.length > 0)
    ) {
      evaluatedPromising += 1;
    }
    const requirements = uniqueStrings(
      (gapDetails || [])
        .filter((gap) => gap?.requirement)
        .map((gap) => String(gap.requirement).trim())
    );
    for (const requirement of requirements) {
      if (!requests.has(requirement)) requests.set(requirement, new Set());
      requests.get(requirement).add(record.canonical_job_id);
    }
  }
  rows.push(
    baseRow(metadata, {
      section: "coverage",
      dimension: "missing_requirement",
      segment_key: "all",
      segment_label: "Promising-job gap coverage",
      metric_key: "promising_job_gap_coverage",
      numerator: evaluatedPromising,
      denominator: promising.length,
      value: safeDivide(evaluatedPromising, promising.length),
      unit: "rate",
      sample_size: promising.length,
      coverage_numerator: evaluatedPromising,
      coverage_denominator: promising.length,
      attribution: "deduplicated",
      note:
        "Promising means current opportunity score at or above the configured top-ranked threshold."
    })
  );
  for (const [requirement, identities] of [...requests.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    rows.push(
      baseRow(metadata, {
        section: "skill_demand",
        dimension: "missing_requirement",
        segment_key: requirement,
        segment_label: requirement,
        metric_key: "promising_job_request_count",
        numerator: identities.size,
        denominator: promising.length,
        value: identities.size,
        unit: "count",
        sample_size: promising.length,
        coverage_numerator: evaluatedPromising,
        coverage_denominator: promising.length,
        attribution: "deduplicated",
        note:
          "The deterministic ranker classified this requirement as unsupported by approved profile evidence; this row does not add a skill claim."
      })
    );
  }
  return rows;
}

function meanAndMedian(values) {
  if (values.length === 0) return { mean: "", median: "" };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    mean:
      Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) *
          1_000_000
      ) / 1_000_000,
    median: Math.round(median * 1_000_000) / 1_000_000
  };
}

function overallRows(
  metadata,
  records,
  applications,
  policy,
  diagnostics,
  schema
) {
  const rows = conversionRows(
    metadata,
    applications,
    {
      section: "overall",
      dimension: "overall",
      segment_key: "all",
      segment_label: "All applications"
    },
    policy
  );
  for (const outcome of ["replied", "interview", "offer"]) {
    const numerator = applications.filter((record) =>
      outcomeSet(record).has(outcome)
    ).length;
    rows.push(
      baseRow(metadata, {
        metric_key: `${outcome}_per_ten_applications`,
        numerator,
        denominator: applications.length,
        value: safeDivide(numerator, applications.length, 10),
        unit: "per_10_applications",
        sample_size: applications.length
      })
    );
  }
  const applicationsWithExplicitOutcome = applications.filter(
    (record) => outcomeSet(record).size > 0
  ).length;
  rows.push(
    baseRow(metadata, {
      section: "coverage",
      metric_key: "explicit_outcome_application_coverage",
      numerator: applicationsWithExplicitOutcome,
      denominator: applications.length,
      value: safeDivide(
        applicationsWithExplicitOutcome,
        applications.length
      ),
      unit: "rate",
      sample_size: applications.length,
      coverage_numerator: applicationsWithExplicitOutcome,
      coverage_denominator: applications.length,
      note:
        "Applications without an explicit milestone remain in conversion denominators and are not inferred as no response."
    })
  );

  const reviewHours = [];
  let sameDayReviews = 0;
  let invalidReviewTimestamps = 0;
  for (const record of records) {
    if (!record.first_reviewed_at) continue;
    const discovered = timestamp(record.discovered_at);
    const reviewed = timestamp(record.first_reviewed_at);
    if (
      discovered === undefined ||
      reviewed === undefined ||
      reviewed < discovered
    ) {
      invalidReviewTimestamps += 1;
      continue;
    }
    reviewHours.push((reviewed - discovered) / 3_600_000);
    if (
      dayKey(record.discovered_at, policy.analysis_timezone) ===
      dayKey(record.first_reviewed_at, policy.analysis_timezone)
    ) {
      sameDayReviews += 1;
    }
  }
  const reviewStats = meanAndMedian(reviewHours);
  const reviewHoursSum =
    Math.round(
      reviewHours.reduce((sum, hours) => sum + hours, 0) * 1_000_000
    ) / 1_000_000;
  for (const [metricKey, value, numerator] of [
    ["mean_hours_discovery_to_first_review", reviewStats.mean, reviewHoursSum],
    ["median_hours_discovery_to_first_review", reviewStats.median, ""]
  ]) {
    rows.push(
      baseRow(metadata, {
        section: "time_to_action",
        metric_key: metricKey,
        numerator: value === "" ? "" : numerator,
        denominator: reviewHours.length,
        value,
        unit: "hours",
        sample_size: reviewHours.length,
        coverage_numerator: reviewHours.length,
        coverage_denominator: records.length,
        note: `Day boundaries use ${policy.analysis_timezone}.`
      })
    );
  }
  rows.push(
    baseRow(metadata, {
      section: "time_to_action",
      metric_key: "same_day_first_review_rate",
      numerator: sameDayReviews,
      denominator: reviewHours.length,
      value: safeDivide(sameDayReviews, reviewHours.length),
      unit: "rate",
      sample_size: reviewHours.length,
      coverage_numerator: reviewHours.length,
      coverage_denominator: records.length,
      note: `Same calendar day in ${policy.analysis_timezone}; unobservable or invalid pairs are excluded and disclosed.`
    })
  );

  const applicationHours = [];
  let invalidApplicationTimestamps = 0;
  for (const record of applications) {
    const discovered = timestamp(record.discovered_at);
    const applied = timestamp(record.application_decided_at);
    if (
      discovered === undefined ||
      applied === undefined ||
      applied < discovered
    ) {
      invalidApplicationTimestamps += 1;
      continue;
    }
    applicationHours.push((applied - discovered) / 3_600_000);
  }
  const applicationStats = meanAndMedian(applicationHours);
  const applicationHoursSum =
    Math.round(
      applicationHours.reduce((sum, hours) => sum + hours, 0) * 1_000_000
    ) / 1_000_000;
  for (const [metricKey, value, numerator] of [
    [
      "mean_hours_discovery_to_application",
      applicationStats.mean,
      applicationHoursSum
    ],
    ["median_hours_discovery_to_application", applicationStats.median, ""]
  ]) {
    rows.push(
      baseRow(metadata, {
        section: "time_to_action",
        metric_key: metricKey,
        numerator: value === "" ? "" : numerator,
        denominator: applicationHours.length,
        value,
        unit: "hours",
        sample_size: applicationHours.length,
        coverage_numerator: applicationHours.length,
        coverage_denominator: applications.length
      })
    );
  }

  const knownPointApplications = applications.filter(
    (record) =>
      validContractValue(
        record.apply_points_used,
        schema.field_rules?.apply_points_used
      )
  );
  const knownPoints = knownPointApplications.reduce(
    (sum, record) => sum + record.apply_points_used,
    0
  );
  const replyWithKnownPoints = knownPointApplications.filter((record) =>
    outcomeSet(record).has("replied")
  ).length;
  const interviewWithKnownPoints = knownPointApplications.filter((record) =>
    outcomeSet(record).has("interview")
  ).length;
  const knownConfidencePointApplications = knownPointApplications.filter(
    (record) =>
      validContractValue(
        record.application_ranking_confidence,
        schema.field_rules?.application_ranking_confidence
      )
  );
  const knownConfidencePoints = knownConfidencePointApplications.reduce(
    (sum, record) => sum + record.apply_points_used,
    0
  );
  const highConfidencePoints = knownConfidencePointApplications
    .filter(
      (record) => record.application_ranking_confidence === "high"
    )
    .reduce((sum, record) => sum + record.apply_points_used, 0);
  for (const [metricKey, numerator] of [
    ["replies_per_apply_point", replyWithKnownPoints],
    ["interviews_per_apply_point", interviewWithKnownPoints]
  ]) {
    rows.push(
      baseRow(metadata, {
        section: "apply_point_efficiency",
        metric_key: metricKey,
        numerator,
        denominator: knownPoints,
        value: safeDivide(numerator, knownPoints),
        unit: "per_apply_point",
        sample_size: knownPointApplications.length,
        coverage_numerator: knownPointApplications.length,
        coverage_denominator: applications.length,
        note: "Only known positive actual Apply Points contribute to the denominator."
      })
    );
  }
  rows.push(
    baseRow(metadata, {
      section: "apply_point_efficiency",
      metric_key: "high_confidence_points_share",
      numerator: highConfidencePoints,
      denominator: knownConfidencePoints,
      value: safeDivide(highConfidencePoints, knownConfidencePoints),
      unit: "rate",
      sample_size: knownConfidencePointApplications.length,
      coverage_numerator: knownConfidencePointApplications.length,
      coverage_denominator: applications.length,
      note:
        "Only known valid Apply Points with known application-time confidence contribute to this denominator."
    })
  );
  rows.push(
    baseRow(metadata, {
      section: "coverage",
      metric_key: "known_apply_points_application_coverage",
      numerator: knownPointApplications.length,
      denominator: applications.length,
      value: safeDivide(knownPointApplications.length, applications.length),
      unit: "rate",
      sample_size: applications.length,
      coverage_numerator: knownPointApplications.length,
      coverage_denominator: applications.length
    })
  );

  const gapEvaluated = records.filter(
    (record) =>
      !record.__analytics_malformed_requirement_gap_details &&
      (record.evaluated_at ||
        record.scoring_policy_version ||
        (Array.isArray(record.requirement_gap_details) &&
          record.requirement_gap_details.length > 0))
  );
  const hardGapNonApplications = gapEvaluated.filter(
    (record) =>
      !isApplied(record) &&
      Array.isArray(record.requirement_gap_details) &&
      record.requirement_gap_details.some(
        (gap) => gap?.classification === "hard"
      )
  ).length;
  rows.push(
    baseRow(metadata, {
      section: "avoidance",
      dimension: "requirement_gap",
      segment_key: "hard",
      segment_label: "Hard-gap non-applications",
      metric_key: "hard_gap_non_application_count",
      numerator: hardGapNonApplications,
      denominator: gapEvaluated.length,
      value: hardGapNonApplications,
      unit: "count",
      sample_size: gapEvaluated.length,
      coverage_numerator: gapEvaluated.length,
      coverage_denominator: records.length,
      note: "Counts evaluated jobs with a hard gap and no applied decision; it does not infer causality."
    })
  );

  const packsWithStatus = records.filter((record) =>
    !record.__analytics_malformed_application_warnings &&
    Array.isArray(record.application_warnings) &&
    ["ready", "review_required", "blocked"].includes(
      record.application_pack_status
    )
  );
  const blockedByCode = (codes) =>
    records.filter(
      (record) =>
        record.application_pack_status === "blocked" &&
        Array.isArray(record.application_warnings) &&
        record.application_warnings.some((warning) =>
          codes.includes(warning?.code)
        )
    ).length;
  for (const [metricKey, codes, label] of [
    [
      "packs_blocked_missing_instructions",
      ["description_unavailable"],
      "Missing/unavailable instructions"
    ],
    [
      "packs_blocked_unsupported_evidence",
      ["unsupported_required_evidence"],
      "Unsupported required evidence"
    ]
  ]) {
    const count = blockedByCode(codes);
    rows.push(
      baseRow(metadata, {
        section: "pack_blockers",
        dimension: "application_pack",
        segment_key: metricKey,
        segment_label: label,
        metric_key: metricKey,
        numerator: count,
        denominator: packsWithStatus.length,
        value: count,
        unit: "count",
        sample_size: packsWithStatus.length,
        coverage_numerator: packsWithStatus.length,
        coverage_denominator: records.length
      })
    );
  }

  for (const [metricKey, value] of [
    ["input_row_count", diagnostics.input_rows],
    ["deduplicated_record_count", records.length],
    ["active_archive_overlap_count", diagnostics.overlap_records],
    ["invalid_identity_row_count", diagnostics.invalid_identity_rows],
    [
      "application_snapshot_conflict_count",
      diagnostics.application_snapshot_conflicts
    ],
    [
      "application_decision_conflict_count",
      diagnostics.application_decision_conflicts
    ],
    [
      "malformed_outcome_history_row_count",
      diagnostics.malformed_outcome_history_rows
    ],
    [
      "malformed_requirement_gap_row_count",
      diagnostics.malformed_requirement_gap_rows
    ],
    [
      "malformed_application_warning_row_count",
      diagnostics.malformed_application_warning_rows
    ],
    ["invalid_review_timestamp_count", invalidReviewTimestamps],
    ["invalid_application_timestamp_count", invalidApplicationTimestamps]
  ]) {
    rows.push(
      baseRow(metadata, {
        section: "data_quality",
        metric_key: metricKey,
        numerator: value,
        denominator: diagnostics.input_rows,
        value,
        unit: "count",
        sample_size: diagnostics.input_rows
      })
    );
  }
  return rows;
}

const ANALYTICS_RESULT_FIELDS = [
  "metric_definition_version",
  "band_version",
  "window_type",
  "window_start_at",
  "section",
  "dimension",
  "segment_key",
  "segment_label",
  "metric_key",
  "numerator",
  "denominator",
  "value",
  "unit",
  "sample_size",
  "coverage_numerator",
  "coverage_denominator",
  "attribution",
  "non_additive",
  "note"
];

export function analyticsResultKey(rows, summary) {
  const canonicalRows = rows.map((row) =>
    ANALYTICS_RESULT_FIELDS.map((field) => row?.[field] ?? "")
  );
  return stableSha256(
    JSON.stringify({
      key_version: "analytics-result/v1",
      analysis_timezone: summary.analysis_timezone,
      record_count: summary.record_count,
      application_count: summary.application_count,
      attribution_policy: summary.attribution_policy,
      warning_summary: summary.warning_summary,
      rows: canonicalRows
    })
  );
}

export function reusableAnalyticsReport(reportRows, completion) {
  const latest = latestCompleteAnalyticsReport(reportRows);
  return latest &&
    latest.report_id === completion.report_id &&
    latest.metric_definition_version === completion.metric_definition_version &&
    latest.band_version === completion.band_version &&
    latest.window_type === completion.window_type &&
    latest.window_start_at === completion.window_start_at &&
    latest.analysis_timezone === completion.analysis_timezone &&
    Number(latest.record_count) === completion.record_count &&
    Number(latest.application_count) === completion.application_count &&
    Number(latest.detail_row_count) === completion.detail_row_count &&
    latest.attribution_policy === completion.attribution_policy &&
    String(latest.warning_summary || "") === completion.warning_summary
    ? latest
    : undefined;
}

export function buildAnalyticsReport(
  activeRows,
  archiveRows,
  schema,
  policy,
  now = new Date().toISOString(),
  _options = {}
) {
  const policyErrors = validateAnalyticsPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid analytics policy:\n- ${policyErrors.join("\n- ")}`);
  }
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("analytics report timestamp is invalid");
  }
  const { records, diagnostics } = deduplicateAnalyticsRecords(
    activeRows,
    archiveRows,
    schema,
    now
  );
  const applications = records.filter(isApplied);
  const validApplicationTimes = applications
    .map((record) => record.application_decided_at)
    .filter((value) => timestamp(value) !== undefined)
    .sort((left, right) => timestamp(left) - timestamp(right));
  const metadata = {
    report_id: "",
    metric_definition_version: policy.metric_definition_version,
    band_version: policy.band_version,
    generated_at: now,
    window_type: policy.analysis_window.type,
    window_start_at: validApplicationTimes[0] || "",
    window_end_at: now
  };
  const resultRows = [
    ...overallRows(
      metadata,
      records,
      applications,
      policy,
      diagnostics,
      schema
    ),
    ...dimensionsReport(metadata, applications, policy, schema),
    ...discoveryAndSkillDemandRows(metadata, records, policy)
  ];
  const warnings = [];
  if (applications.length === 0) warnings.push("no_applications");
  if (diagnostics.invalid_identity_rows > 0) warnings.push("invalid_identity_rows");
  if (diagnostics.application_snapshot_conflicts > 0) {
    warnings.push("application_snapshot_conflicts");
  }
  if (diagnostics.application_decision_conflicts > 0) {
    warnings.push("application_decision_conflicts");
  }
  if (diagnostics.malformed_outcome_history_rows > 0) {
    warnings.push("malformed_outcome_history_rows");
  }
  if (diagnostics.malformed_requirement_gap_rows > 0) {
    warnings.push("malformed_requirement_gap_rows");
  }
  if (diagnostics.malformed_application_warning_rows > 0) {
    warnings.push("malformed_application_warning_rows");
  }
  metadata.result_key = analyticsResultKey(resultRows, {
    analysis_timezone: policy.analysis_timezone,
    record_count: records.length,
    application_count: applications.length,
    attribution_policy: policy.attribution.policy,
    warning_summary: warnings.join(",")
  });
  metadata.report_id = reportId(policy, metadata.result_key);
  const rows = resultRows.map((row, index) => {
    const completeRow = {
      ...row,
      report_id: metadata.report_id,
      analytics_row_id: `${metadata.report_id}|${String(index + 1).padStart(5, "0")}`
    };
    return Object.fromEntries(
      policy.detail_fields.map((field) => [field, completeRow[field] ?? ""])
    );
  });
  const completion = {
    report_id: metadata.report_id,
    status: "complete",
    metric_definition_version: metadata.metric_definition_version,
    band_version: metadata.band_version,
    generated_at: now,
    window_type: metadata.window_type,
    window_start_at: metadata.window_start_at,
    window_end_at: metadata.window_end_at,
    analysis_timezone: policy.analysis_timezone,
    record_count: records.length,
    application_count: applications.length,
    detail_row_count: rows.length,
    attribution_policy: policy.attribution.policy,
    warning_summary: warnings.join(",")
  };
  return {
    metadata,
    rows,
    completion,
    records,
    diagnostics
  };
}

export function latestCompleteAnalyticsReport(reportRows) {
  return [...reportRows]
    .filter(
      (row) =>
        row?.status === "complete" &&
        row.report_id &&
        timestamp(row.generated_at) !== undefined
    )
    .sort(
      (left, right) =>
        timestamp(right.generated_at) - timestamp(left.generated_at) ||
        String(right.report_id).localeCompare(String(left.report_id))
    )[0];
}
