const PHASES = new Set(["pre_activation", "post_activation"]);

function roleMatches(workflow, role) {
  const name = String(workflow?.name || "");
  const nodes = new Set(
    (workflow?.nodes ?? []).map((node) =>
      typeof node === "string" ? node : node?.name
    )
  );
  return (
    role.name_markers.every((marker) => name.includes(marker)) &&
    role.required_node_names.every((nodeName) => nodes.has(nodeName))
  );
}

function sensitiveTextPresent(value) {
  const serialized = JSON.stringify(value ?? {});
  return /hooks\.slack\.com\/services|bearer\s+[a-z0-9._-]+|api[-_ ]?key\s*[:=]|authorization\s*[:=]|-----begin [a-z ]+private key-----/i.test(
    serialized
  );
}

export function validateWorkflowCutoverPolicy(policy) {
  const errors = [];
  const cutover = policy?.workflow_cutover;
  if (cutover?.schema_version !== 2) {
    errors.push("workflow_cutover schema_version must be 2");
  }
  if (cutover?.inventory_scope_required !== "instance_wide") {
    errors.push("cutover inventory scope must be instance_wide");
  }
  if (!Number.isInteger(cutover?.inventory_page_limit) || cutover.inventory_page_limit < 1) {
    errors.push("cutover inventory_page_limit must be a positive integer");
  }
  if (!Array.isArray(cutover?.roles) || cutover.roles.length !== 3) {
    errors.push("cutover must define exactly three replacement roles");
    return errors;
  }
  const expectedRoles = new Set([
    "scraper",
    "evaluator_generator",
    "alerter_mover"
  ]);
  if (
    new Set(cutover.roles.map((role) => role.role)).size !== 3 ||
    cutover.roles.some((role) => !expectedRoles.has(role.role))
  ) {
    errors.push("cutover replacement role names are invalid or duplicated");
  }
  for (const role of cutover.roles) {
    if (
      !Array.isArray(role.name_markers) ||
      role.name_markers.length < 2 ||
      !Array.isArray(role.required_node_names) ||
      role.required_node_names.length < 2
    ) {
      errors.push(`${role.role} requires name and node signatures`);
    }
  }
  if (
    !Array.isArray(cutover.retired_role_markers) ||
    cutover.retired_role_markers.length < 7
  ) {
    errors.push("all seven retired workflow signatures are required");
  }
  return errors;
}

function requireBooleanChecks(checks, names, label, errors) {
  for (const name of names) {
    if (checks?.[name] !== true) {
      errors.push(`${label}.${name} must be true`);
    }
  }
}

const PRE_SMOKE_CHECKS = [
  "blank_setup_zero_rows",
  "setup_rerun_idempotent",
  "no_old_row_import",
  "fixed_window_single_clock",
  "window_start_inclusive",
  "window_end_inclusive",
  "old_listing_excluded",
  "future_listing_excluded",
  "missing_timestamp_excluded",
  "unique_and_duplicate_discovery",
  "ready_route",
  "review_needed_route",
  "approval_route",
  "denial_move",
  "automatic_skip_move",
  "user_skip_move",
  "i_applied_move",
  "empty_queues",
  "source_page_failure",
  "provider_failure",
  "stale_action",
  "destination_write_failure",
  "source_delete_failure",
  "slack_rejection",
  "slack_timeout",
  "repeated_scheduler_runs",
  "safe_recovery",
  "slack_copy_fidelity",
  "links_open_only",
  "no_automatic_submission",
  "secret_scan_clean"
];

const POST_OBSERVATION_CHECKS = [
  "no_out_of_window_jobs",
  "no_duplicate_jobs",
  "no_duplicate_alerts",
  "no_duplicate_applied_rows",
  "no_duplicate_archive_rows",
  "no_stuck_claims",
  "no_old_workbook_writes",
  "old_workbook_unchanged"
];

export function validateWorkflowCutoverEvidence(policy, evidence) {
  const errors = validateWorkflowCutoverPolicy(policy);
  if (evidence?.schema_version !== 2) {
    errors.push("cutover evidence schema_version must be 2");
  }
  if (evidence?.policy_version !== policy?.policy_version) {
    errors.push("cutover evidence policy_version is stale");
  }
  if (!PHASES.has(evidence?.phase)) {
    errors.push("cutover phase is invalid");
  }
  if (!Number.isFinite(Date.parse(evidence?.captured_at || ""))) {
    errors.push("cutover captured_at must be a valid timestamp");
  }
  if (
    evidence?.inventory_scope !== "instance_wide" ||
    evidence?.inventory_complete !== true ||
    !Array.isArray(evidence?.workflows)
  ) {
    errors.push("complete instance-wide workflow inventory is required");
  }
  if (sensitiveTextPresent(evidence)) {
    errors.push("cutover evidence contains sensitive material");
  }

  const roles = policy?.workflow_cutover?.roles ?? [];
  const targetMap = evidence?.target_workflow_ids ?? {};
  const targetIds = roles.map((role) => String(targetMap[role.role] || ""));
  if (
    targetIds.some((id) => !id) ||
    new Set(targetIds).size !== roles.length
  ) {
    errors.push("target_workflow_ids must identify three unique workflows");
  }
  const ids = new Set();
  for (const workflow of evidence?.workflows ?? []) {
    const id = String(workflow?.id || "");
    if (!id || ids.has(id)) {
      errors.push("workflow inventory contains a missing or duplicate ID");
    }
    ids.add(id);
    if (!Array.isArray(workflow?.nodes)) {
      errors.push(`workflow ${id || "(missing)"} nodes must be an array`);
    }
  }
  for (const role of roles) {
    const matches = (evidence?.workflows ?? []).filter((workflow) =>
      roleMatches(workflow, role)
    );
    if (matches.length !== 1) {
      errors.push(`${role.role} signature must match exactly one workflow`);
      continue;
    }
    const target = matches[0];
    if (String(target.id) !== String(targetMap[role.role])) {
      errors.push(`${role.role} signature does not match its target ID`);
    }
    if (target.spreadsheet_id !== evidence?.fresh_workbook?.id) {
      errors.push(`${role.role} is not bound to the fresh workbook`);
    }
    if (evidence?.phase === "pre_activation" && target.active) {
      errors.push(`${role.role} must remain inactive before activation`);
    }
    if (evidence?.phase === "post_activation" && !target.active) {
      errors.push(`${role.role} must be active after activation`);
    }
  }

  const retiredMarkers = policy?.workflow_cutover?.retired_role_markers ?? [];
  for (const workflow of evidence?.workflows ?? []) {
    if (
      retiredMarkers.some((marker) =>
        String(workflow.name || "").includes(marker)
      ) &&
      workflow.active
    ) {
      errors.push(`retired workflow is active: ${String(workflow.id || "")}`);
    }
  }
  if (evidence?.phase === "post_activation") {
    const activePipeline = (evidence?.workflows ?? []).filter(
      (workflow) =>
        workflow.active &&
        (roles.some((role) => roleMatches(workflow, role)) ||
          retiredMarkers.some((marker) =>
            String(workflow.name || "").includes(marker)
          ))
    );
    if (activePipeline.length !== 3) {
      errors.push("post-activation inventory must have exactly three active pipeline workflows");
    }
  }

  const fresh = evidence?.fresh_workbook;
  const old = evidence?.old_workbook;
  if (!fresh?.id || !old?.id || fresh.id === old.id) {
    errors.push("fresh and old workbook IDs must be present and different");
  }
  if (
    fresh?.verified_empty_before_activation !== true ||
    fresh?.setup_runs < 2 ||
    fresh?.old_rows_imported !== false
  ) {
    errors.push("fresh workbook provisioning evidence is incomplete");
  }
  const sheetRows = fresh?.initial_data_rows ?? {};
  for (const name of ["Review Queue", "Applied Jobs", "Archive"]) {
    if (sheetRows[name] !== 0) {
      errors.push(`fresh workbook ${name} must have zero initial rows`);
    }
  }
  if (
    !old?.backup_id ||
    old?.retained !== true ||
    old?.active_binding_count !== 0
  ) {
    errors.push("old workbook backup/retirement evidence is incomplete");
  }
  if (
    !evidence?.workflow_backup?.reference ||
    evidence?.workflow_backup?.complete !== true
  ) {
    errors.push("workflow backup evidence is incomplete");
  }
  if (
    !evidence?.rollback?.documented ||
    !evidence?.rollback?.verified ||
    !Array.isArray(evidence?.rollback?.prior_workflow_ids) ||
    !evidence?.rollback?.old_workbook_id
  ) {
    errors.push("rollback evidence is incomplete");
  }

  requireBooleanChecks(
    evidence?.smoke,
    PRE_SMOKE_CHECKS,
    "smoke",
    errors
  );
  if (evidence?.phase === "post_activation") {
    requireBooleanChecks(
      evidence?.observations,
      POST_OBSERVATION_CHECKS,
      "observations",
      errors
    );
  }
  return errors;
}

async function fetchWorkflowInventory({
  apiBaseUrl,
  apiKey,
  pageLimit,
  fetchImpl
}) {
  if (!apiBaseUrl || !apiKey) {
    throw new Error("N8N_PUBLIC_API_URL and N8N_API_KEY are required");
  }
  const workflows = [];
  let cursor = "";
  do {
    const url = new URL(
      `${apiBaseUrl.replace(/\/$/, "")}/workflows`
    );
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      headers: { "X-N8N-API-KEY": apiKey }
    });
    if (!response.ok) {
      throw new Error(`n8n workflow inventory request failed with ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) {
      throw new Error("n8n workflow inventory response is malformed");
    }
    workflows.push(...payload.data);
    cursor = String(payload.nextCursor || "");
  } while (cursor);
  return workflows;
}

export async function captureWorkflowCutoverEvidence({
  policy,
  phase,
  apiBaseUrl,
  apiKey,
  targetMap,
  fetchImpl = fetch
}) {
  if (!PHASES.has(phase)) throw new Error("cutover phase is invalid");
  const policyErrors = validateWorkflowCutoverPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid cutover policy: ${policyErrors.join("; ")}`);
  }
  const inventory = await fetchWorkflowInventory({
    apiBaseUrl,
    apiKey,
    pageLimit: policy.workflow_cutover.inventory_page_limit,
    fetchImpl
  });
  const bindings = targetMap?.workflow_bindings ?? {};
  const workflows = inventory.map((workflow) => ({
    id: String(workflow.id || ""),
    name: String(workflow.name || "").slice(0, 200),
    active: Boolean(workflow.active),
    nodes: (workflow.nodes ?? []).map((node) =>
      String(node?.name || "").slice(0, 200)
    ),
    spreadsheet_id: String(bindings[workflow.id]?.spreadsheet_id || "")
  }));
  return {
    schema_version: 2,
    policy_version: policy.policy_version,
    phase,
    captured_at: new Date().toISOString(),
    inventory_scope: "instance_wide",
    inventory_complete: true,
    workflows,
    target_workflow_ids: targetMap?.target_workflow_ids ?? {},
    fresh_workbook: targetMap?.fresh_workbook ?? {},
    old_workbook: targetMap?.old_workbook ?? {},
    workflow_backup: targetMap?.workflow_backup ?? {},
    smoke: targetMap?.smoke ?? {},
    observations: targetMap?.observations ?? {},
    rollback: targetMap?.rollback ?? {}
  };
}
