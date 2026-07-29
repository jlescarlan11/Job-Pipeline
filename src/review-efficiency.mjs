function rowsMatch(currentRows, desiredRows, fields) {
  if (
    !Array.isArray(currentRows) ||
    !Array.isArray(desiredRows) ||
    !Array.isArray(fields) ||
    fields.length === 0 ||
    currentRows.length !== desiredRows.length
  ) {
    return false;
  }
  return desiredRows.every((desiredRow, index) =>
    fields.every(
      (field) =>
        String(currentRows[index]?.[field] ?? "") ===
        String(desiredRow?.[field] ?? "")
    )
  );
}

export function projectionRowsMatch(currentRows, desiredRows, fields) {
  return rowsMatch(currentRows, desiredRows, fields);
}

export function reusableFunnelSummary(currentRows, summary, fields) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return undefined;
  }
  const candidates = (Array.isArray(currentRows) ? currentRows : []).filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      String(row.metric_key || "") === String(summary.metric_key || "")
  );
  const comparisonFields = (Array.isArray(fields) ? fields : []).filter(
    (field) => field !== "generated_at"
  );
  return candidates.length === 1 &&
    rowsMatch(candidates, [summary], comparisonFields)
    ? candidates[0]
    : undefined;
}

function countEntries(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function reviewSnapshotStatus({
  processed,
  currentQueueRows,
  desiredQueueRows,
  queueFields,
  currentAppliedRows,
  desiredAppliedRows,
  appliedFields,
  currentDashboardRows,
  dashboardSummary,
  dashboardFields,
  projectionInvalidCount = 0,
  claimRetentionPlan
}) {
  const sourceUpdateCount =
    countEntries(processed?.active_updates) +
    countEntries(processed?.archive_updates);
  const invalidActionCount = countEntries(processed?.invalid_actions);
  const queueCurrent = projectionRowsMatch(
    currentQueueRows,
    desiredQueueRows,
    queueFields
  );
  const appliedCurrent = projectionRowsMatch(
    currentAppliedRows,
    desiredAppliedRows,
    appliedFields
  );
  const dashboardCurrent = Boolean(
    reusableFunnelSummary(
      currentDashboardRows,
      dashboardSummary,
      dashboardFields
    )
  );
  const claimCleanupRequired =
    countEntries(claimRetentionPlan?.delete_ranges) > 0;
  const invalidProjectionCount =
    Number.isInteger(projectionInvalidCount) && projectionInvalidCount > 0
      ? projectionInvalidCount
      : 0;
  return {
    refresh_required:
      sourceUpdateCount > 0 ||
      invalidActionCount > 0 ||
      invalidProjectionCount > 0 ||
      !queueCurrent ||
      !appliedCurrent ||
      !dashboardCurrent ||
      claimCleanupRequired,
    source_update_count: sourceUpdateCount,
    invalid_action_count: invalidActionCount,
    invalid_projection_count: invalidProjectionCount,
    review_queue_current: queueCurrent,
    applied_jobs_current: appliedCurrent,
    dashboard_current: dashboardCurrent,
    claim_cleanup_required: claimCleanupRequired
  };
}
