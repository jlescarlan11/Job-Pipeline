const PHASES = new Set(["pre_activation", "post_activation"]);
const ROLES = ["scraper", "evaluator_generator", "alerter_mover"];
const ROUTE_CHECKS = [
  "new_scrape_to_scraped_jobs",
  "rediscovery_preserves_active_owner",
  "generator_reads_scraped_jobs_only",
  "review_needed_to_to_review",
  "ready_to_apply_to_to_apply",
  "automatic_skip_to_archive",
  "approve_to_scraped_jobs",
  "deny_to_archive",
  "i_applied_to_applied_jobs",
  "user_skip_to_archive",
  "invalid_combinations_fail_closed",
  "partial_destination_recovery",
  "ready_alert_from_to_apply_only",
  "ready_alert_idempotent",
  "to_apply_deep_link_verified",
  "no_automatic_submission"
];

function sensitiveTextPresent(value) {
  const serialized = JSON.stringify(value ?? {});
  return /hooks\.slack\.com\/services|bearer\s+[a-z0-9._-]+|api[-_ ]?key\s*[:=]|authorization\s*[:=]|-----begin [a-z ]+private key-----|generated_message|job_description/i.test(
    serialized
  );
}

function requireTrue(object, fields, label, errors) {
  for (const field of fields) {
    if (object?.[field] !== true) {
      errors.push(`${label}.${field} must be true`);
    }
  }
}

function validCommit(value) {
  return /^[a-f0-9]{40}$/i.test(String(value || ""));
}

function safeReference(value) {
  const text = String(value || "");
  return (
    text.length > 0 &&
    text.length <= 200 &&
    !/https?:\/\/|[?&](?:token|signature|sig|key)=/i.test(text)
  );
}

export function validateSegmentedQueueCutoverEvidence(schema, review, evidence) {
  const errors = [];
  const expectedVisible = Object.values(review?.sheets ?? {})
    .filter((sheet) => sheet.visible)
    .map((sheet) => sheet.name);
  const expectedHidden = Object.values(review?.sheets ?? {})
    .filter((sheet) => !sheet.visible)
    .map((sheet) => sheet.name);

  if (evidence?.schema_version !== 1) {
    errors.push("segmented cutover evidence schema_version must be 1");
  }
  if (evidence?.contract_version !== schema?.storage_version) {
    errors.push("segmented cutover contract_version is stale");
  }
  if (!PHASES.has(evidence?.phase)) {
    errors.push("segmented cutover phase is invalid");
  }
  if (!Number.isFinite(Date.parse(evidence?.captured_at || ""))) {
    errors.push("segmented cutover captured_at must be a valid timestamp");
  }
  if (evidence?.environment !== "production") {
    errors.push("segmented cutover evidence must identify production");
  }
  requireTrue(
    evidence?.privacy,
    ["sanitized", "secret_scan_clean"],
    "privacy",
    errors
  );
  for (const field of [
    "credentials_included",
    "private_job_content_included",
    "complete_sheet_rows_included"
  ]) {
    if (evidence?.privacy?.[field] !== false) {
      errors.push(`privacy.${field} must be false`);
    }
  }
  if (sensitiveTextPresent(evidence)) {
    errors.push("segmented cutover evidence contains sensitive material");
  }

  for (const issue of [55, 56, 57]) {
    if (!validCommit(evidence?.release?.[`issue_${issue}_commit`])) {
      errors.push(`release.issue_${issue}_commit must be a full commit SHA`);
    }
  }
  requireTrue(
    evidence?.release,
    [
      "commits_reviewed",
      "build_passed",
      "artifact_drift_clean",
      "configuration_valid",
      "full_suite_passed"
    ],
    "release",
    errors
  );

  if (
    !safeReference(evidence?.backups?.workbook_reference) ||
    !safeReference(evidence?.backups?.workflow_reference) ||
    !/^[a-f0-9]{64}$/i.test(evidence?.backups?.workbook_sha256 || "") ||
    !/^[a-f0-9]{64}$/i.test(evidence?.backups?.workflow_sha256 || "")
  ) {
    errors.push("restorable workbook and workflow backup references and hashes are required");
  }
  requireTrue(
    evidence?.backups,
    ["workbook_restore_verified", "workflow_restore_verified"],
    "backups",
    errors
  );

  if (
    JSON.stringify(evidence?.disposable?.visible_sheets) !==
      JSON.stringify(expectedVisible) ||
    JSON.stringify(evidence?.disposable?.hidden_sheets) !==
      JSON.stringify(expectedHidden)
  ) {
    errors.push("disposable workbook sheet contract is not exact");
  }
  requireTrue(
    evidence?.disposable,
    [
      "business_headers_exact",
      "queue_dropdowns_exact",
      "search_keywords_preserved",
      "setup_rerun_idempotent",
      "planner_repeat_equal",
      "unsafe_planner_rejected",
      "inactive_workflow_smoke_passed"
    ],
    "disposable",
    errors
  );

  if (
    evidence?.quiet_window?.verified !== true ||
    evidence?.quiet_window?.running_or_waiting_executions !== 0 ||
    evidence?.quiet_window?.unexpired_claims !== 0
  ) {
    errors.push("verified quiet window with zero executions and live claims is required");
  }

  if (
    JSON.stringify(evidence?.production?.visible_sheets) !==
      JSON.stringify(expectedVisible) ||
    JSON.stringify(evidence?.production?.hidden_sheets) !==
      JSON.stringify(expectedHidden) ||
    evidence?.production?.legacy_review_queue_present !== false
  ) {
    errors.push("production workbook sheet contract is not exact");
  }
  const before = evidence?.production?.pre_cutover_identity_count;
  const after = evidence?.production?.post_cutover_identity_count;
  const unique = evidence?.production?.unique_post_cutover_identity_count;
  if (
    !Number.isInteger(before) ||
    before < 0 ||
    after !== before ||
    unique !== before ||
    evidence?.production?.duplicate_identity_count !== 0 ||
    evidence?.production?.unexplained_loss_count !== 0
  ) {
    errors.push("production identity reconciliation must prove zero loss and duplication");
  }
  const legacySourceCount = evidence?.production?.legacy_source_identity_count;
  const plannedCounts = evidence?.production?.planned_destination_counts;
  if (
    !Number.isInteger(legacySourceCount) ||
    legacySourceCount < 0 ||
    Object.keys(plannedCounts ?? {}).length !== schema?.business_stores?.length ||
    schema.business_stores.some(
      (store) => !Number.isInteger(plannedCounts?.[store]) || plannedCounts[store] < 0
    ) ||
    schema.business_stores.reduce(
      (total, store) => total + Number(plannedCounts?.[store] || 0),
      0
    ) !== legacySourceCount
  ) {
    errors.push("planned destination counts must reconcile every legacy source identity");
  }
  requireTrue(
    evidence?.production,
    [
      "applied_jobs_preserved",
      "archive_preserved",
      "search_keywords_preserved",
      "audit_fields_preserved",
      "system_evidence_reconciled",
      "route_counts_reconciled",
      "state_action_counts_reconciled"
    ],
    "production",
    errors
  );

  const workflows = Array.isArray(evidence?.workflows) ? evidence.workflows : [];
  if (
    workflows.length !== ROLES.length ||
    new Set(workflows.map((workflow) => workflow.role)).size !== ROLES.length ||
    workflows.some((workflow) => !ROLES.includes(workflow.role))
  ) {
    errors.push("exactly one workflow record for each production role is required");
  }
  for (const role of ROLES) {
    const workflow = workflows.find((candidate) => candidate.role === role);
    if (!workflow) continue;
    if (
      !safeReference(workflow.id) ||
      workflow.updated_in_place !== true ||
      workflow.contract_version !== schema?.storage_version ||
      workflow.configuration_preserved !== true ||
      workflow.role_signature_validated !== true ||
      !/^[a-f0-9]{64}$/i.test(workflow.artifact_sha256 || "")
    ) {
      errors.push(`${role} workflow compatibility evidence is incomplete`);
    }
    const expectedActive = evidence?.phase === "post_activation";
    if (workflow.active !== expectedActive) {
      errors.push(`${role} active state does not match ${evidence?.phase}`);
    }
  }

  requireTrue(evidence?.routes, ROUTE_CHECKS, "routes", errors);
  if (
    evidence?.post_cutover?.leaked_claim_count !== 0 ||
    evidence?.post_cutover?.unexplained_failure_count !== 0
  ) {
    errors.push("post-cutover claim or failure reconciliation is incomplete");
  }
  if (
    evidence?.phase === "post_activation" &&
    evidence?.post_cutover?.observed_schedule_boundaries < 3
  ) {
    errors.push("post-activation schedule observation is incomplete");
  }
  if (
    evidence?.phase === "pre_activation" &&
    evidence?.post_cutover?.observed_schedule_boundaries !== 0
  ) {
    errors.push("pre-activation evidence cannot claim scheduled observations");
  }
  const executionIds = evidence?.post_cutover?.workflow_execution_ids;
  if (
    evidence?.phase === "post_activation" &&
    (!Array.isArray(executionIds) ||
      executionIds.length < 3 ||
      executionIds.length > 20 ||
      executionIds.some((value) => !safeReference(value)))
  ) {
    errors.push("post-activation evidence requires bounded workflow execution IDs");
  }
  if (
    evidence?.phase === "pre_activation" &&
    (!Array.isArray(executionIds) || executionIds.length !== 0)
  ) {
    errors.push("pre-activation evidence cannot contain workflow execution IDs");
  }
  const deviations = evidence?.post_cutover?.known_deviations;
  if (
    !Array.isArray(deviations) ||
    deviations.length > 20 ||
    deviations.some(
      (value) =>
        !String(value || "") ||
        String(value).length > 120 ||
        /https?:\/\/|[\r\n\t]/i.test(String(value))
    )
  ) {
    errors.push("known deviations must be a bounded sanitized category list");
  }
  requireTrue(
    evidence?.rollback,
    [
      "documented",
      "rehearsal_verified",
      "workbook_and_workflows_restored_together",
      "mutually_compatible_restore"
    ],
    "rollback",
    errors
  );
  return errors;
}
