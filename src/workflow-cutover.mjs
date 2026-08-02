import { createHash } from "node:crypto";

const PHASES = new Set([
  "pre_deployment",
  "pre_activation",
  "post_activation"
]);

const REQUIRED_EVIDENCE_KEYS = new Set([
  "schema_version",
  "policy_version",
  "deployment_commit",
  "application_compatibility",
  "phase",
  "captured_at",
  "inventory_scope",
  "inventory_complete",
  "workflows",
  "target_workflow_ids",
  "main_workbook",
  "configuration_workbook",
  "old_workbook",
  "backup_assets",
  "compatibility_inventory",
  "verification_runs",
  "deployment_checks",
  "observations",
  "production_record",
  "slack_canary",
  "rollback"
]);

const WORKFLOW_KEYS = new Set([
  "id",
  "name",
  "active",
  "nodes",
  "version_id",
  "active_version_id",
  "updated_at",
  "artifact_digest",
  "timezone",
  "execution_timeout_seconds",
  "schedule_expressions",
  "main_spreadsheet_binding",
  "configuration_spreadsheet_binding",
  "role_signature_matches",
  "retired_signature_match",
  "pipeline_marker_match",
  "pipeline_binding_count",
  "pipeline_binding_kinds",
  "pipeline_surface_digest",
  "google_credential_node_count",
  "google_credential_bound_node_count",
  "google_credential_binding_digest"
]);

const INVENTORY_RECORD_KEYS = new Set([
  "identity_digest",
  "record_version",
  "state_guard_digest",
  "review_digest",
  "application_versions",
  "safe",
  "reason_codes",
  "disposition"
]);

const ALLOWED_INCOMPATIBLE_DISPOSITIONS = new Set([
  "pending",
  "regenerate",
  "return_to_review",
  "quarantine"
]);

const REQUIRED_BACKUP_KINDS = [
  "workflow_scraper",
  "workflow_evaluator_generator",
  "workflow_alerter_mover",
  "main_workbook",
  "configuration_workbook",
  "old_workbook",
  "n8n_database",
  "alert_receipt_store",
  "runtime_configuration"
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function exactSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function unexpectedKeys(value, allowed, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unsupported field ${key}`);
  }
}

function boundedText(value, maximum = 200) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function opaqueIdentifier(value, maximum = 120) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !privateTextPresent(value)
  );
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value || ""));
}

function validSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
}

function sanitizedNode(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const copy = structuredClone(node);
  delete copy.credentials;
  delete copy.webhookId;
  return copy;
}

export function workflowDeploymentDigest(workflow) {
  const deploymentShape = {
    name: String(workflow?.name || ""),
    nodes: (workflow?.nodes ?? []).map(sanitizedNode),
    connections: workflow?.connections ?? {},
    settings: workflow?.settings ?? {},
    meta: workflow?.meta ?? {}
  };
  return sha256Digest(JSON.stringify(stableValue(deploymentShape)));
}

export function googleCredentialNodeNames(workflow) {
  return (workflow?.nodes ?? [])
    .filter((node) => {
      if (node?.type === "n8n-nodes-base.googleSheets") return true;
      if (node?.type !== "n8n-nodes-base.httpRequest") return false;
      return String(node?.parameters?.url || "").includes("googleapis.com");
    })
    .map((node) => String(node?.name || ""))
    .filter(Boolean)
    .sort();
}

export function safeGoogleCredentialReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length < 1 ||
    keys.some((key) => !["id", "name"].includes(key)) ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id) ||
    (value.name !== undefined &&
      (typeof value.name !== "string" ||
        value.name.length < 1 ||
        value.name.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(value.name))) ||
    privateTextPresent(value)
  ) {
    return null;
  }
  return { id: value.id };
}

function googleCredentialSummary(workflow) {
  const expectedNames = new Set(googleCredentialNodeNames(workflow));
  const references = [];
  let bound = 0;
  for (const node of workflow?.nodes ?? []) {
    if (!expectedNames.has(String(node?.name || ""))) continue;
    const credential = safeGoogleCredentialReference(
      node?.credentials?.googleSheetsOAuth2Api
    );
    const reference = String(credential?.id || credential?.name || "").trim();
    if (!reference) continue;
    bound += 1;
    references.push(reference);
  }
  const uniqueReferences = [...new Set(references)];
  return {
    google_credential_node_count: expectedNames.size,
    google_credential_bound_node_count: bound,
    google_credential_binding_digest:
      uniqueReferences.length === 1 ? sha256Digest(uniqueReferences[0]) : ""
  };
}

function workflowScheduleExpressions(workflow) {
  return (workflow?.nodes ?? [])
    .filter((node) => node?.type === "n8n-nodes-base.scheduleTrigger")
    .flatMap((node) => node?.parameters?.rule?.interval ?? [])
    .map((entry) => String(entry?.expression || "").trim())
    .filter(Boolean)
    .sort();
}

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

function privateTextPresent(value) {
  const serialized = JSON.stringify(value ?? {});
  return /hooks\.slack\.com\/services|bearer\s+[a-z0-9._-]+|api[-_ ]?key\s*[:=]|authorization\s*[:=]|-----begin [a-z ]+private key-----|generated_message|job_description|reviewer_notes?|\b(?:sk(?:-proj|-ant)?-|[spr]k_(?:live|test)_|gsk_|xox[a-z]?[-_]|gh[pousr]_|glpat-|npm_|hf_)[a-z0-9_-]{8,}\b|\b(?:akia|asia)[a-z0-9]{12,}\b|\bAIza[a-z0-9_-]{20,}\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:^|["'\s:])\/(?!\/)[a-z0-9._-]+(?:\/[a-z0-9._ -]+)+|[a-z]:\\\\[^"'\s]+|https?:\/\//i.test(
    serialized
  );
}

function sensitiveTextPresent(value) {
  return privateTextPresent(value);
}

function workflowParameterText(workflow) {
  return JSON.stringify(
    (workflow?.nodes ?? []).map((node) => node?.parameters ?? {})
  );
}

function workflowBindingMode(workflow, environmentName, resolvedValue) {
  const text = workflowParameterText(workflow);
  const environmentPatterns = [
    `$env.${environmentName}`,
    `$env[\"${environmentName}\"]`,
    `$env['${environmentName}']`
  ];
  if (environmentPatterns.some((pattern) => text.includes(pattern))) {
    return "environment";
  }
  if (resolvedValue && text.includes(String(resolvedValue))) return "literal";
  return "none";
}

function unresolvedDynamicDestination(node) {
  const parameters = node?.parameters ?? {};
  const isDynamic = (value) =>
    /\{\{[\s\S]*\$(?:json|input|node|item|items|evaluateExpression|\()/i.test(
      JSON.stringify(value ?? "")
    );
  const isStatic = (value) => {
    const text = JSON.stringify(value ?? "");
    return text.length > 2 && !isDynamic(value) && !/\{\{/.test(text);
  };
  if (node?.type === "n8n-nodes-base.googleSheets") {
    const writeOperations = new Set([
      "append",
      "appendOrUpdate",
      "clear",
      "create",
      "delete",
      "remove",
      "update"
    ]);
    const operation = String(parameters.operation || "read");
    return (
      writeOperations.has(operation) &&
      (!isStatic(parameters.documentId) || !isStatic(parameters.sheetName))
    );
  }
  if (node?.type === "n8n-nodes-base.httpRequest") {
    const method = String(parameters.method || "GET").toUpperCase();
    const url = parameters.url;
    return (
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      String(JSON.stringify(url ?? "")).includes("googleapis.com") &&
      !isStatic(url)
    );
  }
  return false;
}

export function classifyWorkflowForCutover(workflow, policy, environment = {}) {
  const cutover = policy?.workflow_cutover ?? {};
  const text = workflowParameterText(workflow);
  const businessSheets = evidenceContract(policy).business_sheets ?? [];
  const configurationSheets = evidenceContract(policy).configuration_sheets ?? [];
  const bindingMatchers = [
    ["main_workbook", [
      "JOB_PIPELINE_SPREADSHEET_ID",
      environment.JOB_PIPELINE_SPREADSHEET_ID
    ]],
    ["configuration_workbook", [
      "JOB_PIPELINE_CONFIG_SPREADSHEET_ID",
      environment.JOB_PIPELINE_CONFIG_SPREADSHEET_ID
    ]],
    ["old_workbook", [
      "JOB_PIPELINE_OLD_SPREADSHEET_ID",
      environment.JOB_PIPELINE_OLD_SPREADSHEET_ID
    ]],
    ["alert_receipt", ["JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID"]],
    ["groq", ["JOB_PIPELINE_GROQ_API_KEY", "api.groq.com"]],
    ["slack", ["JOB_PIPELINE_SLACK_WEBHOOK_URL", "hooks.slack.com/services"]],
    ["business_sheet", businessSheets],
    ["configuration_sheet", configurationSheets],
    ["onlinejobs", ["onlinejobs.ph"]]
  ];
  const kinds = bindingMatchers
    .filter(([, values]) =>
      values.filter(Boolean).some((value) => text.includes(String(value)))
    )
    .map(([kind]) => kind)
    .sort();
  const approvedUnrelatedDynamicWriters = new Set(
    cutover.approved_unrelated_dynamic_writer_ids ?? []
  );
  if (
    !approvedUnrelatedDynamicWriters.has(String(workflow?.id || "")) &&
    (workflow?.nodes ?? []).some(unresolvedDynamicDestination)
  ) {
    kinds.push("ambiguous_google_writer");
    kinds.sort();
  }
  const nodeNames = (workflow?.nodes ?? []).map((node) => String(node?.name || ""));
  const roleSignatureMatches = (cutover.roles ?? [])
    .filter((role) => roleMatches(workflow, role))
    .map((role) => role.role)
    .sort();
  const retiredSignatureMatch = (cutover.retired_role_markers ?? []).some(
    (marker) => String(workflow?.name || "").includes(marker)
  );
  const pipelineMarkerMatch = String(workflow?.name || "").includes(
    String(cutover.pipeline_name_marker || "")
  );
  return {
    main_spreadsheet_binding: workflowBindingMode(
      workflow,
      "JOB_PIPELINE_SPREADSHEET_ID",
      environment.JOB_PIPELINE_SPREADSHEET_ID
    ),
    configuration_spreadsheet_binding: workflowBindingMode(
      workflow,
      "JOB_PIPELINE_CONFIG_SPREADSHEET_ID",
      environment.JOB_PIPELINE_CONFIG_SPREADSHEET_ID
    ),
    role_signature_matches: roleSignatureMatches,
    retired_signature_match: retiredSignatureMatch,
    pipeline_marker_match: pipelineMarkerMatch,
    pipeline_binding_count: kinds.length,
    pipeline_binding_kinds: kinds,
    pipeline_surface_digest: sha256Digest(
      JSON.stringify(
        stableValue({
          name: String(workflow?.name || ""),
          node_names: nodeNames,
          binding_kinds: kinds,
          role_signature_matches: roleSignatureMatches,
          retired_signature_match: retiredSignatureMatch,
          pipeline_marker_match: pipelineMarkerMatch
        })
      )
    )
  };
}

function requireBooleanChecks(checks, names, label, errors) {
  for (const name of names) {
    if (checks?.[name] !== true) errors.push(`${label}.${name} must be true`);
  }
}

function evidenceContract(policy) {
  return policy?.workflow_cutover?.evidence_contract ?? {};
}

function normalizedApiOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return "";
    }
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

export function validateN8nPublicApiUrl(policy, value) {
  const errors = [];
  let url;
  try {
    url = new URL(value);
  } catch {
    return ["N8N_PUBLIC_API_URL must be a valid URL"];
  }
  if (url.username || url.password || url.search || url.hash) {
    errors.push("N8N_PUBLIC_API_URL must not contain userinfo, query, or fragment");
  }
  const allowedOrigins = policy?.workflow_cutover?.allowed_public_api_origins ?? [];
  if (!allowedOrigins.includes(url.origin)) {
    errors.push("N8N_PUBLIC_API_URL origin is not approved by deployment policy");
  }
  if (url.pathname.replace(/\/$/, "") !== policy?.workflow_cutover?.public_api_path) {
    errors.push("N8N_PUBLIC_API_URL path does not match deployment policy");
  }
  return errors;
}

export function validateWorkflowCutoverPolicy(policy) {
  const errors = [];
  const cutover = policy?.workflow_cutover;
  if (cutover?.schema_version !== 3) {
    errors.push("workflow_cutover schema_version must be 3");
  }
  if (cutover?.deployment_mode !== "in_place_segmented_update") {
    errors.push("cutover deployment_mode must be in_place_segmented_update");
  }
  if (cutover?.inventory_scope_required !== "instance_wide") {
    errors.push("cutover inventory scope must be instance_wide");
  }
  if (!Number.isInteger(cutover?.inventory_page_limit) || cutover.inventory_page_limit < 1) {
    errors.push("cutover inventory_page_limit must be a positive integer");
  }
  if (
    cutover?.public_api_path !== "/api/v1" ||
    !Array.isArray(cutover?.allowed_public_api_origins) ||
    cutover.allowed_public_api_origins.length < 1 ||
    new Set(cutover.allowed_public_api_origins).size !==
      cutover.allowed_public_api_origins.length ||
    cutover.allowed_public_api_origins.some(
      (origin) => normalizedApiOrigin(`${origin}/`) !== origin
    )
  ) {
    errors.push("cutover public API path and approved origins are invalid");
  }
  if (!boundedText(cutover?.pipeline_name_marker, 100)) {
    errors.push("cutover pipeline name marker is required");
  }
  if (
    !Array.isArray(cutover?.approved_unrelated_dynamic_writer_ids) ||
    new Set(cutover.approved_unrelated_dynamic_writer_ids).size !==
      cutover.approved_unrelated_dynamic_writer_ids.length ||
    cutover.approved_unrelated_dynamic_writer_ids.some(
      (id) => !opaqueIdentifier(id, 100)
    )
  ) {
    errors.push("approved unrelated dynamic writer IDs must be an explicit bounded list");
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
  if (
    new Set(cutover.roles.map((role) => role.target_workflow_id)).size !== 3 ||
    cutover.roles.some((role) => !opaqueIdentifier(role.target_workflow_id, 100))
  ) {
    errors.push("cutover target workflow IDs must be three unique bounded values");
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
    if (
      !validSha256(role.artifact_digest) ||
      !Array.isArray(role.schedule_expressions) ||
      role.schedule_expressions.length < 1 ||
      !Number.isInteger(role.execution_timeout_seconds) ||
      role.execution_timeout_seconds < 1 ||
      role.timezone !== "Asia/Manila" ||
      !Number.isInteger(role.google_credential_node_count) ||
      role.google_credential_node_count < 1
    ) {
      errors.push(`${role.role} deployment signature is incomplete`);
    }
  }
  if (
    !Array.isArray(cutover.retired_role_markers) ||
    cutover.retired_role_markers.length < 7
  ) {
    errors.push("all seven retired workflow signatures are required");
  }

  const contract = evidenceContract(policy);
  for (const [field, minimum] of [
    ["business_sheets", 5],
    ["configuration_sheets", 11],
    ["required_backup_kinds", 9],
    ["required_disposable_cases", 12],
    ["required_deployment_checks", 5],
    ["required_post_observations", 8]
  ]) {
    if (
      !Array.isArray(contract[field]) ||
      contract[field].length < minimum ||
      new Set(contract[field]).size !== contract[field].length
    ) {
      errors.push(`cutover evidence contract ${field} is incomplete or duplicated`);
    }
  }
  if (!exactSet(contract.required_backup_kinds, REQUIRED_BACKUP_KINDS)) {
    errors.push("cutover evidence contract must require the exact nine rollback assets");
  }
  if (
    !Number.isInteger(contract.minimum_observation_minutes) ||
    contract.minimum_observation_minutes < 240
  ) {
    errors.push("cutover observation must cover at least 240 minutes");
  }
  return errors;
}

function validateWorkbooks(policy, evidence, errors) {
  const compatibility = policy?.application_compatibility ?? {};
  const contract = evidenceContract(policy);
  const main = evidence?.main_workbook;
  unexpectedKeys(
    main,
    new Set([
      "id",
      "schema_version",
      "storage_version",
      "pipeline_contract_digest",
      "business_sheets",
      "business_headers_exact",
      "system_sheet_hidden"
    ]),
    "main_workbook",
    errors
  );
  if (
    !opaqueIdentifier(main?.id, 200) ||
    main?.schema_version !== compatibility.pipeline_schema_version ||
    main?.storage_version !== compatibility.storage_version ||
    main?.pipeline_contract_digest !== compatibility.pipeline_contract_digest ||
    !exactSet(main?.business_sheets, contract.business_sheets) ||
    main?.business_headers_exact !== true ||
    main?.system_sheet_hidden !== true
  ) {
    errors.push("main workbook segmented contract evidence is incomplete");
  }

  const configuration = evidence?.configuration_workbook;
  unexpectedKeys(
    configuration,
    new Set(["id", "sheets", "headers_exact", "context_valid"]),
    "configuration_workbook",
    errors
  );
  if (
    !opaqueIdentifier(configuration?.id, 200) ||
    !exactSet(configuration?.sheets, contract.configuration_sheets) ||
    configuration?.headers_exact !== true ||
    configuration?.context_valid !== true
  ) {
    errors.push("configuration workbook contract evidence is incomplete");
  }

  const old = evidence?.old_workbook;
  unexpectedKeys(
    old,
    new Set(["id", "retained", "active_binding_count"]),
    "old_workbook",
    errors
  );
  const workbookIds = [main?.id, configuration?.id, old?.id].filter(Boolean);
  if (
    !opaqueIdentifier(old?.id, 200) ||
    old?.retained !== true ||
    old?.active_binding_count !== 0 ||
    workbookIds.length !== 3 ||
    new Set(workbookIds).size !== 3
  ) {
    errors.push("main, configuration, and retained old workbook evidence is unsafe");
  }
}

function validateBackupAssets(policy, evidence, errors) {
  const requiredKinds = evidenceContract(policy).required_backup_kinds ?? [];
  if (!Array.isArray(evidence?.backup_assets)) {
    errors.push("backup_assets must be an array");
    return;
  }
  const kinds = [];
  for (const asset of evidence.backup_assets) {
    unexpectedKeys(
      asset,
      new Set(["kind", "reference", "sha256", "readable", "restore_verified"]),
      "backup asset",
      errors
    );
    kinds.push(asset?.kind);
    if (
      !requiredKinds.includes(asset?.kind) ||
      !opaqueIdentifier(asset?.reference, 300) ||
      !validSha256(asset?.sha256) ||
      asset?.readable !== true ||
      asset?.restore_verified !== true
    ) {
      errors.push(`backup asset ${String(asset?.kind || "(missing)")} is incomplete`);
    }
  }
  if (!exactSet(kinds, requiredKinds)) {
    errors.push("backup assets must cover every required rollback kind exactly once");
  }
}

function validateCompatibilityInventory(policy, evidence, errors) {
  const inventory = evidence?.compatibility_inventory;
  unexpectedKeys(
    inventory,
    new Set([
      "captured_at",
      "total_records",
      "compatible_records",
      "incompatible_records",
      "unhandled_incompatible_records",
      "records"
    ]),
    "compatibility_inventory",
    errors
  );
  if (!validTimestamp(inventory?.captured_at) || !Array.isArray(inventory?.records)) {
    errors.push("compatibility inventory is missing timestamp or records");
    return;
  }
  const identities = new Set();
  let compatible = 0;
  let incompatible = 0;
  let unhandled = 0;
  for (const record of inventory.records) {
    unexpectedKeys(record, INVENTORY_RECORD_KEYS, "compatibility record", errors);
    if (!validSha256(record?.identity_digest) || identities.has(record.identity_digest)) {
      errors.push("compatibility inventory contains missing or duplicate identity digest");
    }
    identities.add(record?.identity_digest);
    if (
      !Number.isInteger(record?.record_version) ||
      record.record_version < 1 ||
      !validSha256(record?.state_guard_digest) ||
      (record?.review_digest && !validSha256(record.review_digest)) ||
      !stableEqual(record?.application_versions, policy.application_compatibility)
    ) {
      errors.push("compatibility record provenance is incomplete or stale");
    }
    if (
      !Array.isArray(record?.reason_codes) ||
      record.reason_codes.length > 30 ||
      record.reason_codes.some(
        (reason) => !/^[a-z0-9_]{1,80}$/.test(String(reason || ""))
      )
    ) {
      errors.push("compatibility record reason codes are invalid or unbounded");
    }
    if (record?.safe === true) {
      compatible += 1;
      if (record.reason_codes.length !== 0 || record.disposition !== "compatible") {
        errors.push("compatible record must have no reasons and disposition compatible");
      }
    } else if (record?.safe === false) {
      incompatible += 1;
      if (
        record.reason_codes.length === 0 ||
        !ALLOWED_INCOMPATIBLE_DISPOSITIONS.has(record.disposition)
      ) {
        errors.push("incompatible record requires reasons and a guarded disposition");
      }
      if (record.disposition === "pending") unhandled += 1;
    } else {
      errors.push("compatibility record safe must be boolean");
    }
  }
  if (
    inventory.total_records !== inventory.records.length ||
    inventory.compatible_records !== compatible ||
    inventory.incompatible_records !== incompatible ||
    inventory.unhandled_incompatible_records !== unhandled
  ) {
    errors.push("compatibility inventory counts are inconsistent");
  }
  if (evidence?.phase !== "pre_deployment" && unhandled !== 0) {
    errors.push("all incompatible unsent records require disposition before activation");
  }
}

function validateVerificationRuns(policy, evidence, errors) {
  const requiredCases = evidenceContract(policy).required_disposable_cases ?? [];
  if (!Array.isArray(evidence?.verification_runs)) {
    errors.push("verification_runs must be an array");
    return;
  }
  const caseIds = [];
  for (const run of evidence.verification_runs) {
    unexpectedKeys(
      run,
      new Set(["case_id", "execution_id", "observed_at", "passed"]),
      "verification run",
      errors
    );
    if (evidence?.phase === "pre_deployment") continue;
    caseIds.push(run?.case_id);
    if (
      !requiredCases.includes(run?.case_id) ||
      !opaqueIdentifier(run?.execution_id, 120) ||
      !validTimestamp(run?.observed_at) ||
      run?.passed !== true
    ) {
      errors.push(`verification run ${String(run?.case_id || "(missing)")} is incomplete`);
    }
  }
  unexpectedKeys(
    evidence?.deployment_checks,
    new Set(evidenceContract(policy).required_deployment_checks ?? []),
    "deployment_checks",
    errors
  );
  if (evidence?.phase === "pre_deployment") return;
  if (!exactSet(caseIds, requiredCases)) {
    errors.push("disposable verification must cover every required case exactly once");
  }
  requireBooleanChecks(
    evidence?.deployment_checks,
    evidenceContract(policy).required_deployment_checks ?? [],
    "deployment_checks",
    errors
  );
}

function validateRollback(policy, evidence, errors) {
  const rollback = evidence?.rollback;
  unexpectedKeys(
    rollback,
    new Set([
      "documented",
      "verified",
      "disable_order",
      "prior_workflow_versions",
      "old_workbook_id"
    ]),
    "rollback",
    errors
  );
  const roles = policy?.workflow_cutover?.roles ?? [];
  const versions = rollback?.prior_workflow_versions;
  if (
    rollback?.documented !== true ||
    rollback?.verified !== true ||
    !stableEqual(rollback?.disable_order, [
      "alerter_mover",
      "evaluator_generator",
      "scraper"
    ]) ||
    !Array.isArray(versions) ||
    versions.length !== roles.length ||
    rollback?.old_workbook_id !== evidence?.old_workbook?.id
  ) {
    errors.push("rollback evidence is incomplete or has an unsafe disable order");
    return;
  }
  const expectedIds = roles.map((role) => role.target_workflow_id);
  const actualIds = [];
  for (const version of versions) {
    unexpectedKeys(
      version,
      new Set(["workflow_id", "version_id"]),
      "rollback workflow version",
      errors
    );
    actualIds.push(version?.workflow_id);
    if (!opaqueIdentifier(version?.version_id, 120)) {
      errors.push("rollback workflow version identifier is missing");
    }
  }
  if (!exactSet(actualIds, expectedIds)) {
    errors.push("rollback workflow versions must cover the three in-place targets");
  }
}

function validatePostActivation(policy, evidence, errors) {
  const observations = evidence?.observations;
  const required = evidenceContract(policy).required_post_observations ?? [];
  unexpectedKeys(
    observations,
    new Set([
      ...required,
      "started_at",
      "completed_at",
      "scheduled_execution_ids"
    ]),
    "observations",
    errors
  );
  const roleNames = (policy?.workflow_cutover?.roles ?? []).map((role) => role.role);
  if (observations?.scheduled_execution_ids !== undefined) {
    unexpectedKeys(
      observations.scheduled_execution_ids,
      new Set(roleNames),
      "observations.scheduled_execution_ids",
      errors
    );
  }

  const production = evidence?.production_record;
  unexpectedKeys(
    production,
    new Set([
      "identity_digest",
      "execution_id",
      "focused_store",
      "contract_complete",
      "coverage_complete",
      "message_provenance_complete",
      "required_input_verified"
    ]),
    "production_record",
    errors
  );
  const slack = evidence?.slack_canary;
  unexpectedKeys(
    slack,
    new Set([
      "identity_digest",
      "execution_id",
      "stored_message_digest",
      "payload_message_digest",
      "receipt_digest",
      "delivery_attempts",
      "automatic_replays",
      "message_safety_passed",
      "links_open_only"
    ]),
    "slack_canary",
    errors
  );
  if (evidence?.phase !== "post_activation") return;
  requireBooleanChecks(observations, required, "observations", errors);
  if (
    !validTimestamp(observations?.started_at) ||
    !validTimestamp(observations?.completed_at) ||
    !validTimestamp(evidence?.captured_at) ||
    Date.parse(observations.completed_at) > Date.parse(evidence.captured_at) ||
    Date.parse(observations.completed_at) - Date.parse(observations.started_at) <
      evidenceContract(policy).minimum_observation_minutes * 60_000
  ) {
    errors.push("post-activation observation window is incomplete or captured prematurely");
  }
  const executionIds = observations?.scheduled_execution_ids;
  if (
    !executionIds ||
    typeof executionIds !== "object" ||
    Array.isArray(executionIds) ||
    !exactSet(Object.keys(executionIds), roleNames) ||
    Object.values(executionIds).some((value) => !opaqueIdentifier(value, 120))
  ) {
    errors.push("post-activation evidence requires one scheduled execution per role");
  }

  if (
    !validSha256(production?.identity_digest) ||
    !opaqueIdentifier(production?.execution_id, 120) ||
    production?.focused_store !== "To Apply" ||
    production?.contract_complete !== true ||
    production?.coverage_complete !== true ||
    production?.message_provenance_complete !== true ||
    production?.required_input_verified !== true
  ) {
    errors.push("bounded production record evidence is incomplete");
  }

  if (
    !validSha256(slack?.identity_digest) ||
    !opaqueIdentifier(slack?.execution_id, 120) ||
    !validSha256(slack?.stored_message_digest) ||
    slack?.payload_message_digest !== slack?.stored_message_digest ||
    !validSha256(slack?.receipt_digest) ||
    slack?.delivery_attempts !== 1 ||
    slack?.automatic_replays !== 0 ||
    slack?.message_safety_passed !== true ||
    slack?.links_open_only !== true
  ) {
    errors.push("Slack canary evidence is incomplete, mismatched, or replayed");
  }
  if (
    production?.identity_digest !== slack?.identity_digest ||
    production?.execution_id !== executionIds?.evaluator_generator ||
    slack?.execution_id !== executionIds?.alerter_mover
  ) {
    errors.push(
      "production record and Slack canary must match one identity and their scheduled role executions"
    );
  }
}

export function validateWorkflowCutoverEvidence(
  policy,
  evidence,
  { expectedDeploymentCommit = "" } = {}
) {
  const errors = validateWorkflowCutoverPolicy(policy);
  unexpectedKeys(evidence, REQUIRED_EVIDENCE_KEYS, "cutover evidence", errors);
  if (evidence?.schema_version !== 3) {
    errors.push("cutover evidence schema_version must be 3");
  }
  if (evidence?.policy_version !== policy?.policy_version) {
    errors.push("cutover evidence policy_version is stale");
  }
  if (!/^[0-9a-f]{40}$/.test(String(evidence?.deployment_commit || ""))) {
    errors.push("cutover evidence requires the exact 40-character deployment commit");
  }
  if (
    expectedDeploymentCommit &&
    evidence?.deployment_commit !== expectedDeploymentCommit
  ) {
    errors.push("cutover evidence deployment commit does not match repository HEAD");
  }
  if (!stableEqual(evidence?.application_compatibility, policy?.application_compatibility)) {
    errors.push("cutover evidence application compatibility unit is stale");
  }
  if (!PHASES.has(evidence?.phase)) errors.push("cutover phase is invalid");
  if (!validTimestamp(evidence?.captured_at)) {
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
    errors.push("cutover evidence contains sensitive or private material");
  }

  const roles = policy?.workflow_cutover?.roles ?? [];
  const targetMap = evidence?.target_workflow_ids ?? {};
  unexpectedKeys(
    targetMap,
    new Set(roles.map((role) => role.role)),
    "target_workflow_ids",
    errors
  );
  const targetIds = roles.map((role) => String(targetMap[role.role] || ""));
  if (
    targetIds.some((id) => !id) ||
    new Set(targetIds).size !== roles.length ||
    roles.some((role) => targetMap[role.role] !== role.target_workflow_id)
  ) {
    errors.push("target_workflow_ids must match the three pinned in-place workflows");
  }
  const ids = new Set();
  const targetWorkflows = [];
  const allowedRoleNames = roles.map((role) => role.role);
  const allowedBindingKinds = new Set([
    "main_workbook",
    "configuration_workbook",
    "old_workbook",
    "alert_receipt",
    "groq",
    "slack",
    "business_sheet",
    "configuration_sheet",
    "onlinejobs",
    "ambiguous_google_writer"
  ]);
  for (const workflow of evidence?.workflows ?? []) {
    unexpectedKeys(workflow, WORKFLOW_KEYS, "workflow inventory entry", errors);
    const id = String(workflow?.id || "");
    if (!opaqueIdentifier(id, 100) || ids.has(id)) {
      errors.push("workflow inventory contains an unsafe, missing, or duplicate ID");
    }
    ids.add(id);
    const isTarget = targetIds.includes(id);
    if (
      !Array.isArray(workflow?.nodes) ||
      workflow.nodes.some((name) => !boundedText(name, 200)) ||
      typeof workflow?.name !== "string" ||
      (isTarget && !boundedText(workflow.name, 200)) ||
      (!isTarget && (workflow.name !== "" || workflow.nodes.length !== 0))
    ) {
      errors.push(`workflow ${id || "(missing)"} retained names are unsafe`);
    }
    if (
      typeof workflow?.active !== "boolean" ||
      !opaqueIdentifier(workflow?.version_id, 120) ||
      (workflow?.active && !opaqueIdentifier(workflow?.active_version_id, 120)) ||
      (workflow?.active_version_id !== "" &&
        !opaqueIdentifier(workflow?.active_version_id, 120)) ||
      !validTimestamp(workflow?.updated_at) ||
      !validSha256(workflow?.artifact_digest)
    ) {
      errors.push(`workflow ${id || "(missing)"} version metadata is unsafe`);
    }
    if (
      !Array.isArray(workflow?.role_signature_matches) ||
      !exactSet(
        workflow.role_signature_matches,
        workflow.role_signature_matches.filter((role) =>
          allowedRoleNames.includes(role)
        )
      ) ||
      typeof workflow?.retired_signature_match !== "boolean" ||
      typeof workflow?.pipeline_marker_match !== "boolean" ||
      !Number.isInteger(workflow?.pipeline_binding_count) ||
      workflow.pipeline_binding_count < 0 ||
      !Array.isArray(workflow?.pipeline_binding_kinds) ||
      workflow.pipeline_binding_count !== workflow.pipeline_binding_kinds.length ||
      !exactSet(
        workflow.pipeline_binding_kinds,
        workflow.pipeline_binding_kinds.filter((kind) =>
          allowedBindingKinds.has(kind)
        )
      ) ||
      !validSha256(workflow?.pipeline_surface_digest) ||
      !["environment", "literal", "none"].includes(
        workflow?.main_spreadsheet_binding
      ) ||
      !["environment", "literal", "none"].includes(
        workflow?.configuration_spreadsheet_binding
      )
    ) {
      errors.push(`workflow ${id || "(missing)"} pipeline classification is invalid`);
    }
  }
  for (const role of roles) {
    const matches = (evidence?.workflows ?? []).filter(
      (workflow) => String(workflow?.id || "") === role.target_workflow_id
    );
    if (matches.length !== 1) {
      errors.push(`${role.role} pinned ID must match exactly one workflow`);
      continue;
    }
    const target = matches[0];
    targetWorkflows.push(target);
    if (
      !roleMatches(target, role) ||
      !stableEqual(target.role_signature_matches, [role.role])
    ) {
      errors.push(`${role.role} pinned target signature is incomplete or ambiguous`);
    }
    if (!opaqueIdentifier(target.version_id, 120) || !validTimestamp(target.updated_at)) {
      errors.push(`${role.role} workflow version evidence is incomplete`);
    }
    if (target.active && !opaqueIdentifier(target.active_version_id, 120)) {
      errors.push(`${role.role} active workflow version evidence is missing`);
    }
    if (
      evidence?.phase === "post_activation" &&
      target.active_version_id !== target.version_id
    ) {
      errors.push(`${role.role} active version does not match the reviewed imported version`);
    }
    if (
      target.timezone !== role.timezone ||
      target.execution_timeout_seconds !== role.execution_timeout_seconds ||
      !stableEqual(target.schedule_expressions, [...role.schedule_expressions].sort())
    ) {
      errors.push(`${role.role} schedule, timeout, or timezone drifted`);
    }
    if (
      target.main_spreadsheet_binding !== "environment" ||
      target.configuration_spreadsheet_binding !== "environment" ||
      target.pipeline_binding_kinds?.includes("old_workbook")
    ) {
      errors.push(`${role.role} workbook bindings are incomplete or stale`);
    }
    if (evidence?.phase !== "pre_deployment" && target.artifact_digest !== role.artifact_digest) {
      errors.push(`${role.role} imported artifact does not match the reviewed commit`);
    }
    if (
      target.google_credential_node_count !== role.google_credential_node_count ||
      target.google_credential_bound_node_count !== role.google_credential_node_count ||
      !validSha256(target.google_credential_binding_digest)
    ) {
      errors.push(`${role.role} Google credential binding is incomplete or ambiguous`);
    }
    if (evidence?.phase === "pre_activation" && target.active) {
      errors.push(`${role.role} must remain inactive before activation`);
    }
    if (
      ["pre_deployment", "post_activation"].includes(evidence?.phase) &&
      !target.active
    ) {
      errors.push(`${role.role} must be active in ${evidence?.phase}`);
    }
  }
  if (
    targetWorkflows.length === roles.length &&
    new Set(targetWorkflows.map((workflow) => workflow.google_credential_binding_digest)).size !== 1
  ) {
    errors.push("all target workflows must use the same Google credential binding");
  }

  for (const workflow of evidence?.workflows ?? []) {
    if (workflow.retired_signature_match && workflow.active) {
      errors.push(`retired workflow is active: ${String(workflow.id || "")}`);
    }
  }
  if (evidence?.phase === "pre_activation") {
    const activePipeline = (evidence?.workflows ?? []).filter(
      (workflow) =>
        workflow.active &&
        (targetIds.includes(String(workflow.id || "")) ||
          (workflow.role_signature_matches ?? []).length > 0 ||
          workflow.retired_signature_match ||
          workflow.pipeline_marker_match ||
          workflow.pipeline_binding_count > 0)
    );
    if (activePipeline.length > 0) {
      errors.push("pre_activation inventory requires every pipeline workflow inactive");
    }
  }
  if (["pre_deployment", "post_activation"].includes(evidence?.phase)) {
    const activePipeline = (evidence?.workflows ?? []).filter(
      (workflow) =>
        workflow.active &&
        (targetIds.includes(String(workflow.id || "")) ||
          (workflow.role_signature_matches ?? []).length > 0 ||
          workflow.retired_signature_match ||
          workflow.pipeline_marker_match ||
          workflow.pipeline_binding_count > 0)
    );
    if (
      activePipeline.length !== 3 ||
      !exactSet(
        activePipeline.map((workflow) => String(workflow.id)),
        targetIds
      )
    ) {
      errors.push(`${evidence.phase} inventory must have exactly three active pipeline workflows`);
    }
  }

  if (evidence?.phase === "pre_deployment" && targetWorkflows.length === roles.length) {
    const priorVersions = new Map(
      (evidence?.rollback?.prior_workflow_versions ?? []).map((entry) => [
        entry?.workflow_id,
        entry?.version_id
      ])
    );
    if (
      targetWorkflows.some(
        (workflow) => priorVersions.get(workflow.id) !== workflow.active_version_id
      )
    ) {
      errors.push("rollback versions must match the pre-deployment active versions");
    }
  }

  validateWorkbooks(policy, evidence, errors);
  validateBackupAssets(policy, evidence, errors);
  validateCompatibilityInventory(policy, evidence, errors);
  validateVerificationRuns(policy, evidence, errors);
  validateRollback(policy, evidence, errors);
  validatePostActivation(policy, evidence, errors);
  return errors;
}

async function fetchWorkflowInventory({ apiBaseUrl, apiKey, pageLimit, fetchImpl }) {
  if (!apiBaseUrl || !apiKey) {
    throw new Error("N8N_PUBLIC_API_URL and N8N_API_KEY are required");
  }
  const workflows = [];
  let cursor = "";
  do {
    const url = new URL(`${apiBaseUrl.replace(/\/$/, "")}/workflows`);
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      headers: { "X-N8N-API-KEY": apiKey },
      redirect: "error"
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
  environment = process.env,
  fetchImpl = fetch
}) {
  if (!PHASES.has(phase)) throw new Error("cutover phase is invalid");
  const policyErrors = validateWorkflowCutoverPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid cutover policy: ${policyErrors.join("; ")}`);
  }
  const apiUrlErrors = validateN8nPublicApiUrl(policy, apiBaseUrl);
  if (apiUrlErrors.length > 0) {
    throw new Error(`Unsafe n8n API URL: ${apiUrlErrors.join("; ")}`);
  }
  const inventory = await fetchWorkflowInventory({
    apiBaseUrl,
    apiKey,
    pageLimit: policy.workflow_cutover.inventory_page_limit,
    fetchImpl
  });
  const targetIds = new Set(
    policy.workflow_cutover.roles.map((role) => role.target_workflow_id)
  );
  const workflows = inventory.map((workflow) => {
    const id = String(workflow.id || "");
    const retainSignature = targetIds.has(id);
    return {
      id,
      name: retainSignature ? String(workflow.name || "").slice(0, 200) : "",
      active: Boolean(workflow.active),
      nodes: retainSignature
        ? (workflow.nodes ?? []).map((node) =>
            String(node?.name || "").slice(0, 200)
          )
        : [],
      version_id: String(workflow.versionId || "").slice(0, 120),
      active_version_id: String(workflow.activeVersionId || "").slice(0, 120),
      updated_at: String(workflow.updatedAt || "").slice(0, 50),
      artifact_digest: workflowDeploymentDigest(workflow),
      timezone: String(workflow?.settings?.timezone || "").slice(0, 80),
      execution_timeout_seconds: Number(workflow?.settings?.executionTimeout),
      schedule_expressions: workflowScheduleExpressions(workflow),
      ...classifyWorkflowForCutover(workflow, policy, environment),
      ...googleCredentialSummary(workflow)
    };
  });
  return {
    schema_version: 3,
    policy_version: policy.policy_version,
    deployment_commit: targetMap?.deployment_commit ?? "",
    application_compatibility: policy.application_compatibility,
    phase,
    captured_at: new Date().toISOString(),
    inventory_scope: "instance_wide",
    inventory_complete: true,
    workflows,
    target_workflow_ids: Object.fromEntries(
      policy.workflow_cutover.roles.map((role) => [role.role, role.target_workflow_id])
    ),
    main_workbook: targetMap?.main_workbook ?? {},
    configuration_workbook: targetMap?.configuration_workbook ?? {},
    old_workbook: targetMap?.old_workbook ?? {},
    backup_assets: targetMap?.backup_assets ?? [],
    compatibility_inventory: targetMap?.compatibility_inventory ?? {},
    verification_runs: targetMap?.verification_runs ?? [],
    deployment_checks: targetMap?.deployment_checks ?? {},
    observations: targetMap?.observations ?? {},
    production_record: targetMap?.production_record ?? {},
    slack_canary: targetMap?.slack_canary ?? {},
    rollback: targetMap?.rollback ?? {}
  };
}
