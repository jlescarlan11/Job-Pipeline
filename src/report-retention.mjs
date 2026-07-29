const REPORT_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

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

function dataRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).length > 0
  );
}

function validRowNumber(value) {
  const rowNumber = Number(value);
  return Number.isInteger(rowNumber) && rowNumber >= 2
    ? rowNumber
    : undefined;
}

function uniqueCounts(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
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

function validateStorePolicy(name, policy) {
  const errors = [];
  const prefix = `${name}.`;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return [`${name} retention policy must be an object`];
  }
  if (
    !positiveInteger(policy.retention_days) ||
    policy.retention_days > 3650
  ) {
    errors.push(`${prefix}retention_days must be an integer from 1 through 3650`);
  }
  if (!positiveInteger(policy.minimum_reports_before_cleanup)) {
    errors.push(
      `${prefix}minimum_reports_before_cleanup must be a positive integer`
    );
  }
  if (!positiveInteger(policy.minimum_complete_reports_to_preserve)) {
    errors.push(
      `${prefix}minimum_complete_reports_to_preserve must be a positive integer`
    );
  }
  if (
    !positiveInteger(policy.maximum_reports_per_cleanup) ||
    policy.maximum_reports_per_cleanup > 100
  ) {
    errors.push(
      `${prefix}maximum_reports_per_cleanup must be an integer from 1 through 100`
    );
  }
  if (
    positiveInteger(policy.minimum_reports_before_cleanup) &&
    positiveInteger(policy.minimum_complete_reports_to_preserve) &&
    policy.minimum_reports_before_cleanup <=
      policy.minimum_complete_reports_to_preserve
  ) {
    errors.push(
      `${prefix}minimum_reports_before_cleanup must exceed the preserved complete-report count`
    );
  }
  if (
    !Array.isArray(policy.allowed_statuses) ||
    policy.allowed_statuses.length === 0 ||
    policy.allowed_statuses.some((status) => !nonEmptyString(status))
  ) {
    errors.push(
      `${prefix}allowed_statuses must be a non-empty array of non-empty strings`
    );
  } else if (
    new Set(policy.allowed_statuses.map((status) => status.trim())).size !==
    policy.allowed_statuses.length
  ) {
    errors.push(`${prefix}allowed_statuses must not contain duplicates`);
  }
  if (!nonEmptyString(policy.claim_identity)) {
    errors.push(`${prefix}claim_identity must be a non-empty string`);
  }
  if (!nonEmptyString(policy.claim_stage)) {
    errors.push(`${prefix}claim_stage must be a non-empty string`);
  }
  if (
    !positiveInteger(policy.claim_lease_ms) ||
    policy.claim_lease_ms > REPORT_RETENTION_DAY_MS
  ) {
    errors.push(`${prefix}claim_lease_ms must be from 1 through 86400000`);
  }
  return errors;
}

export function validateReportRetentionPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["report retention policy must be an object"];
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
  errors.push(...validateStorePolicy("analytics", policy.analytics));
  errors.push(
    ...validateStorePolicy("recommendations", policy.recommendations)
  );
  if (
    nonEmptyString(policy.analytics?.claim_identity) &&
    policy.analytics.claim_identity === policy.recommendations?.claim_identity
  ) {
    errors.push("report-store claim identities must be distinct");
  }
  return errors;
}

function retentionCandidates(
  reportRows,
  storePolicy,
  { reportIdField, now }
) {
  const rows = dataRows(reportRows);
  const nowMs = canonicalTimestampMs(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("report retention planning time must be canonical ISO-8601");
  }
  const cutoffMs =
    nowMs - storePolicy.retention_days * REPORT_RETENTION_DAY_MS;
  const allowedStatuses = new Set(storePolicy.allowed_statuses);
  const idCounts = uniqueCounts(
    rows.map((row) => {
      const id = String(row?.[reportIdField] || "").trim();
      return id || undefined;
    })
  );
  const rowNumberCounts = uniqueCounts(
    rows.map((row) => validRowNumber(row.row_number))
  );
  const validComplete = rows
    .map((row) => ({
      row,
      id: String(row?.[reportIdField] || "").trim(),
      generatedAtMs: canonicalTimestampMs(row?.generated_at)
    }))
    .filter(
      ({ id, generatedAtMs }) =>
        id &&
        idCounts.get(id) === 1 &&
        Number.isFinite(generatedAtMs)
    );
  const preservedCompleteIds = new Set(
    validComplete
      .filter(({ row }) => row.status === "complete")
      .sort(
        (left, right) =>
          right.generatedAtMs - left.generatedAtMs ||
          right.id.localeCompare(left.id)
      )
      .slice(0, storePolicy.minimum_complete_reports_to_preserve)
      .map(({ id }) => id)
  );
  const eligible = [];
  const counts = {
    reports_seen: rows.length,
    eligible: 0,
    selected: 0,
    deferred: 0,
    preserved_recent_or_current: 0,
    preserved_malformed_or_ambiguous: 0,
    preserved_unsupported_status: 0,
    preserved_incomplete_detail: 0
  };
  for (const row of rows) {
    const id = String(row?.[reportIdField] || "").trim();
    const rowNumber = validRowNumber(row.row_number);
    const generatedAtMs = canonicalTimestampMs(row.generated_at);
    const detailRowCount = Number(row.detail_row_count);
    if (
      !id ||
      idCounts.get(id) !== 1 ||
      rowNumber === undefined ||
      rowNumberCounts.get(rowNumber) !== 1 ||
      !Number.isFinite(generatedAtMs) ||
      !Number.isInteger(detailRowCount) ||
      detailRowCount < 0
    ) {
      counts.preserved_malformed_or_ambiguous += 1;
      continue;
    }
    if (!allowedStatuses.has(String(row.status || ""))) {
      counts.preserved_unsupported_status += 1;
      continue;
    }
    if (generatedAtMs >= cutoffMs || preservedCompleteIds.has(id)) {
      counts.preserved_recent_or_current += 1;
      continue;
    }
    eligible.push({
      id,
      report_row_number: rowNumber,
      detail_row_count: detailRowCount,
      generated_at_ms: generatedAtMs
    });
  }
  eligible.sort(
    (left, right) =>
      left.generated_at_ms - right.generated_at_ms ||
      left.id.localeCompare(right.id)
  );
  counts.eligible = eligible.length;
  return {
    rows,
    eligible,
    counts,
    cutoff_at: new Date(cutoffMs).toISOString(),
    threshold_reached:
      rows.length >= storePolicy.minimum_reports_before_cleanup
  };
}

export function reportRetentionCandidateStatus(
  reportRows,
  policy,
  storeName,
  { reportIdField, now = new Date().toISOString() }
) {
  const errors = validateReportRetentionPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid report retention policy:\n- ${errors.join("\n- ")}`);
  }
  const storePolicy = policy[storeName];
  if (!storePolicy) throw new Error(`Unknown report store: ${storeName}`);
  const plan = retentionCandidates(reportRows, storePolicy, {
    reportIdField,
    now
  });
  return {
    policy_version: policy.policy_version,
    store: storeName,
    enabled: policy.enabled,
    threshold_reached: plan.threshold_reached,
    retention_cutoff_at: plan.cutoff_at,
    reports_seen: plan.counts.reports_seen,
    eligible: plan.counts.eligible,
    cleanup_required:
      policy.enabled &&
      plan.threshold_reached &&
      plan.counts.eligible > 0
  };
}

export function planReportRetention(
  reportRows,
  detailRows,
  policy,
  storeName,
  {
    reportIdField,
    detailReportIdField,
    detailIdField,
    now = new Date().toISOString()
  }
) {
  const errors = validateReportRetentionPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid report retention policy:\n- ${errors.join("\n- ")}`);
  }
  const storePolicy = policy[storeName];
  if (!storePolicy) throw new Error(`Unknown report store: ${storeName}`);
  const candidatePlan = retentionCandidates(reportRows, storePolicy, {
    reportIdField,
    now
  });
  const details = dataRows(detailRows);
  const detailRowNumberCounts = uniqueCounts(
    details.map((row) => validRowNumber(row.row_number))
  );
  const detailsByReport = new Map();
  for (const row of details) {
    const reportId = String(row?.[detailReportIdField] || "").trim();
    if (!reportId) continue;
    if (!detailsByReport.has(reportId)) detailsByReport.set(reportId, []);
    detailsByReport.get(reportId).push(row);
  }

  const selected = [];
  for (const candidate of candidatePlan.eligible) {
    if (
      selected.length >= storePolicy.maximum_reports_per_cleanup
    ) {
      break;
    }
    const reportDetails = detailsByReport.get(candidate.id) || [];
    const detailIds = reportDetails.map((row) =>
      String(row?.[detailIdField] || "").trim()
    );
    const uniqueDetailIds = new Set(detailIds);
    const validDetails =
      reportDetails.length === candidate.detail_row_count &&
      detailIds.every(Boolean) &&
      uniqueDetailIds.size === detailIds.length &&
      reportDetails.every((row) => {
        const rowNumber = validRowNumber(row.row_number);
        return (
          rowNumber !== undefined &&
          detailRowNumberCounts.get(rowNumber) === 1
        );
      });
    if (!validDetails) {
      candidatePlan.counts.preserved_incomplete_detail += 1;
      continue;
    }
    selected.push({
      ...candidate,
      detail_row_numbers: reportDetails.map((row) =>
        validRowNumber(row.row_number)
      )
    });
  }

  candidatePlan.counts.selected = selected.length;
  candidatePlan.counts.deferred =
    candidatePlan.counts.eligible -
    selected.length -
    candidatePlan.counts.preserved_incomplete_detail;
  const enabled = policy.enabled && candidatePlan.threshold_reached;
  const committedSelection = enabled ? selected : [];
  return {
    policy_version: policy.policy_version,
    store: storeName,
    enabled: policy.enabled,
    threshold_reached: candidatePlan.threshold_reached,
    planned_at: now,
    retention_cutoff_at: candidatePlan.cutoff_at,
    counts: {
      ...candidatePlan.counts,
      selected: committedSelection.length
    },
    selected_report_ids: committedSelection.map(({ id }) => id),
    report_delete_ranges: descendingContiguousRanges(
      committedSelection.map(({ report_row_number }) => report_row_number)
    ),
    detail_delete_ranges: descendingContiguousRanges(
      committedSelection.flatMap(({ detail_row_numbers }) => detail_row_numbers)
    )
  };
}
