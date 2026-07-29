const DAY_MS = 24 * 60 * 60 * 1000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function canonicalTimestampMs(value) {
  if (typeof value !== "string" || value.trim() !== value) return Number.NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

export function validateClaimRetentionPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["claim retention policy must be an object"];
  }
  if (!positiveInteger(policy.schema_version)) {
    errors.push("schema_version must be a positive integer");
  }
  if (!nonEmptyString(policy.policy_version)) {
    errors.push("policy_version must be a non-empty string");
  }
  if (typeof policy.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  if (
    !positiveInteger(policy.retention_days) ||
    policy.retention_days > 3650
  ) {
    errors.push("retention_days must be an integer from 1 through 3650");
  }
  if (!positiveInteger(policy.minimum_rows_before_cleanup)) {
    errors.push("minimum_rows_before_cleanup must be a positive integer");
  }
  if (
    !positiveInteger(policy.maximum_rows_per_cleanup) ||
    policy.maximum_rows_per_cleanup > 5000
  ) {
    errors.push(
      "maximum_rows_per_cleanup must be an integer from 1 through 5000"
    );
  }
  if (
    !Array.isArray(policy.allowed_processing_stages) ||
    policy.allowed_processing_stages.length === 0 ||
    policy.allowed_processing_stages.some((stage) => !nonEmptyString(stage))
  ) {
    errors.push(
      "allowed_processing_stages must be a non-empty array of non-empty strings"
    );
  } else if (
    new Set(policy.allowed_processing_stages.map((stage) => stage.trim()))
      .size !== policy.allowed_processing_stages.length
  ) {
    errors.push("allowed_processing_stages must not contain duplicates");
  }
  return errors;
}

function descendingContiguousRanges(rowNumbers) {
  const ascending = [...rowNumbers].sort((left, right) => left - right);
  const ranges = [];
  for (const rowNumber of ascending) {
    const current = ranges.at(-1);
    if (current && rowNumber === current.end_row_number + 1) {
      current.end_row_number = rowNumber;
      current.end_index = rowNumber;
    } else {
      ranges.push({
        start_row_number: rowNumber,
        end_row_number: rowNumber,
        start_index: rowNumber - 1,
        end_index: rowNumber
      });
    }
  }
  return ranges.sort(
    (left, right) => right.start_row_number - left.start_row_number
  );
}

export function planProcessingClaimRetention(
  rows,
  policy,
  now = new Date().toISOString()
) {
  const policyErrors = validateClaimRetentionPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(
      `Invalid claim retention policy:\n- ${policyErrors.join("\n- ")}`
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error("ProcessingClaims snapshot must be an array");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("claim retention planning time must be a valid timestamp");
  }

  const dataRows = rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).length > 0
  );
  const cutoffMs = nowMs - policy.retention_days * DAY_MS;
  const allowedStages = new Set(
    policy.allowed_processing_stages.map((stage) => stage.trim())
  );
  const rowNumberCounts = new Map();
  for (const row of dataRows) {
    const rowNumber = Number(row.row_number);
    if (Number.isInteger(rowNumber) && rowNumber >= 2) {
      rowNumberCounts.set(
        rowNumber,
        (rowNumberCounts.get(rowNumber) || 0) + 1
      );
    }
  }

  const counts = {
    rows_seen: dataRows.length,
    eligible: 0,
    selected: 0,
    deferred: 0,
    preserved_active_or_recent: 0,
    preserved_malformed: 0,
    preserved_unknown_stage: 0,
    preserved_ambiguous_row_number: 0
  };
  const eligible = [];
  for (const row of dataRows) {
    const rowNumber = Number(row.row_number);
    if (
      !Number.isInteger(rowNumber) ||
      rowNumber < 2 ||
      rowNumberCounts.get(rowNumber) !== 1
    ) {
      counts.preserved_ambiguous_row_number += 1;
      continue;
    }

    const stage = String(row.processing_stage || "").trim();
    if (!allowedStages.has(stage)) {
      counts.preserved_unknown_stage += 1;
      continue;
    }

    const createdAt = canonicalTimestampMs(row.created_at);
    const expiresAt = canonicalTimestampMs(row.expires_at);
    if (
      !nonEmptyString(row.canonical_job_id) ||
      !nonEmptyString(row.processing_token) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt < createdAt
    ) {
      counts.preserved_malformed += 1;
      continue;
    }
    if (expiresAt > cutoffMs) {
      counts.preserved_active_or_recent += 1;
      continue;
    }
    eligible.push({ row_number: rowNumber, expires_at_ms: expiresAt });
  }

  eligible.sort(
    (left, right) =>
      left.expires_at_ms - right.expires_at_ms ||
      left.row_number - right.row_number
  );
  counts.eligible = eligible.length;
  const thresholdReached =
    dataRows.length >= policy.minimum_rows_before_cleanup;
  const selected =
    policy.enabled && thresholdReached
      ? eligible.slice(0, policy.maximum_rows_per_cleanup)
      : [];
  counts.selected = selected.length;
  counts.deferred = eligible.length - selected.length;

  return {
    policy_version: policy.policy_version,
    enabled: policy.enabled,
    threshold_reached: thresholdReached,
    planned_at: new Date(nowMs).toISOString(),
    retention_cutoff_at: new Date(cutoffMs).toISOString(),
    counts,
    selected_row_numbers: selected.map((entry) => entry.row_number),
    delete_ranges: descendingContiguousRanges(
      selected.map((entry) => entry.row_number)
    )
  };
}
