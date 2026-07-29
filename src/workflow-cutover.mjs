const REQUIRED_ROLES = [
  "scraper",
  "generator",
  "alerter",
  "reviewer",
  "archiver",
  "analytics",
  "recommender"
];
const PRE_ACTIVATION_STATUSES = ["new", "running", "waiting"];
const ALLOWED_PHASES = ["pre_activation", "post_activation"];
const ALLOWED_RESTART_METHODS = ["process_restart"];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function parsedTimestamp(value) {
  if (!nonEmptyString(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function cutover(policy) {
  return policy?.workflow_cutover;
}

function roleDefinitions(policy) {
  return Array.isArray(cutover(policy)?.roles)
    ? cutover(policy).roles
    : [];
}

function workflowNodeNames(workflow) {
  return new Set(
    (Array.isArray(workflow?.nodes) ? workflow.nodes : [])
      .map((node) => normalizedText(node?.name))
      .filter(Boolean)
  );
}

function roleMatches(workflow, definition, pipelineNameMatch) {
  const name = normalizedText(workflow?.name);
  const nodeNames = workflowNodeNames(workflow);
  const requiredNodeNames = Array.isArray(definition?.required_node_names)
    ? definition.required_node_names
    : [];
  const nameMarkers = Array.isArray(definition?.name_markers)
    ? definition.name_markers
    : [];
  const structuralMatch =
    requiredNodeNames.length > 0 &&
    requiredNodeNames.every((nodeName) =>
      nodeNames.has(normalizedText(nodeName))
    );
  const roleNameMatch =
    pipelineNameMatch &&
    nameMarkers.some((marker) =>
      name.includes(normalizedText(marker))
    );
  return structuralMatch || roleNameMatch;
}

function classifyWorkflow(workflow, policy) {
  const name = normalizedText(workflow?.name);
  const pipelineNameMatch = name.includes(
    normalizedText(cutover(policy)?.pipeline_name_marker)
  );
  const matches = roleDefinitions(policy)
    .filter((definition) =>
      roleMatches(workflow, definition, pipelineNameMatch)
    )
    .map((definition) => definition.role);
  return {
    candidate: pipelineNameMatch || matches.length > 0,
    matches
  };
}

function validateInventorySource(source, expectedPath, expectedRecords) {
  const errors = [];
  if (!isObject(source)) return ["inventory source is missing"];
  if (source.endpoint !== expectedPath) {
    errors.push(`inventory endpoint must be ${expectedPath}`);
  }
  if (source.limit !== 250) {
    errors.push("inventory page limit must be 250");
  }
  if (!Number.isInteger(source.pages) || source.pages < 1) {
    errors.push("inventory pages must be a positive integer");
  }
  if (source.pagination_complete !== true) {
    errors.push("inventory pagination must be complete");
  }
  if (source.records !== expectedRecords) {
    errors.push("inventory record count does not match evidence");
  }
  return errors;
}

function validateTargetMap(targets) {
  const errors = [];
  if (!isObject(targets)) return ["cutover targets must be an object"];
  const keys = Object.keys(targets).sort();
  const required = [...REQUIRED_ROLES].sort();
  if (
    keys.length !== required.length ||
    keys.some((key, index) => key !== required[index])
  ) {
    errors.push("cutover targets must contain exactly the seven workflow roles");
  }
  const ids = [];
  for (const role of REQUIRED_ROLES) {
    if (!nonEmptyString(targets[role])) {
      errors.push(`cutover target ${role} must have a workflow ID`);
    } else {
      ids.push(targets[role]);
    }
  }
  if (new Set(ids).size !== ids.length) {
    errors.push("cutover target workflow IDs must be unique");
  }
  return errors;
}

function validRuntimeRestart(restart, capturedAt) {
  const restartAt = parsedTimestamp(restart?.completed_at);
  const readinessAt = parsedTimestamp(restart?.readiness_checked_at);
  return (
    isObject(restart) &&
    ALLOWED_RESTART_METHODS.includes(restart.method) &&
    restart.readiness_recovered === true &&
    restartAt !== undefined &&
    readinessAt !== undefined &&
    capturedAt !== undefined &&
    restartAt <= readinessAt &&
    readinessAt <= capturedAt
  );
}

export function validateWorkflowCutoverPolicy(policy) {
  const errors = [];
  const config = cutover(policy);
  if (!isObject(config)) return ["workflow_cutover policy is required"];
  if (config.schema_version !== 1) {
    errors.push("workflow_cutover schema_version must be 1");
  }
  if (config.public_api_path !== "/api/v1") {
    errors.push("workflow_cutover public_api_path must be /api/v1");
  }
  if (config.inventory_page_limit !== 250) {
    errors.push("workflow_cutover inventory_page_limit must be 250");
  }
  if (config.inventory_scope_required !== "instance_wide") {
    errors.push("workflow_cutover inventory scope must be instance-wide");
  }
  if (config.exclude_pinned_data !== true) {
    errors.push("workflow inventory must exclude pinned data");
  }
  if (!nonEmptyString(config.pipeline_name_marker)) {
    errors.push("workflow_cutover pipeline_name_marker is required");
  }
  if (config.runtime_restart_required !== true) {
    errors.push("workflow cutover must require a runtime restart");
  }
  if (
    !Array.isArray(config.pre_activation_execution_statuses) ||
    config.pre_activation_execution_statuses.length !==
      PRE_ACTIVATION_STATUSES.length ||
    [...config.pre_activation_execution_statuses]
      .sort()
      .some(
        (status, index) =>
          status !== [...PRE_ACTIVATION_STATUSES].sort()[index]
      )
  ) {
    errors.push(
      "workflow cutover must inspect new, running, and waiting executions"
    );
  }
  const definitions = roleDefinitions(policy);
  if (
    definitions.length !== REQUIRED_ROLES.length ||
    new Set(definitions.map((definition) => definition?.role)).size !==
      REQUIRED_ROLES.length ||
    REQUIRED_ROLES.some(
      (role) =>
        !definitions.some((definition) => definition?.role === role)
    )
  ) {
    errors.push("workflow cutover policy must define exactly seven unique roles");
  }
  for (const definition of definitions) {
    if (!REQUIRED_ROLES.includes(definition?.role)) continue;
    if (
      !Array.isArray(definition.name_markers) ||
      definition.name_markers.length < 1 ||
      definition.name_markers.some((marker) => !nonEmptyString(marker))
    ) {
      errors.push(`${definition.role} cutover name markers are invalid`);
    }
    if (
      !Array.isArray(definition.required_node_names) ||
      definition.required_node_names.length < 2 ||
      definition.required_node_names.some(
        (nodeName) => !nonEmptyString(nodeName)
      ) ||
      new Set(definition.required_node_names).size !==
        definition.required_node_names.length
    ) {
      errors.push(`${definition.role} cutover node signature is invalid`);
    }
  }
  return errors;
}

export function validateWorkflowCutoverEvidence(policy, evidence) {
  const errors = validateWorkflowCutoverPolicy(policy);
  if (!isObject(evidence)) return [...errors, "cutover evidence must be an object"];
  if (evidence.schema_version !== 1) {
    errors.push("cutover evidence schema_version must be 1");
  }
  if (!ALLOWED_PHASES.includes(evidence.phase)) {
    errors.push("cutover evidence phase is invalid");
  }
  const capturedAt = parsedTimestamp(evidence.captured_at);
  if (capturedAt === undefined) {
    errors.push("cutover evidence captured_at must be a timestamp");
  }
  errors.push(...validateTargetMap(evidence.targets));
  if (
    evidence.inventory_scope?.instance_wide_workflow_list_confirmed !==
    true
  ) {
    errors.push(
      "cutover evidence must confirm instance-wide workflow-list access"
    );
  }

  const workflows = Array.isArray(evidence.workflows)
    ? evidence.workflows
    : [];
  if (!Array.isArray(evidence.workflows)) {
    errors.push("workflow inventory must be an array");
  }
  errors.push(
    ...validateInventorySource(
      evidence.source?.workflow_inventory,
      "/workflows",
      workflows.length
    )
  );
  if (evidence.source?.workflow_inventory?.exclude_pinned_data !== true) {
    errors.push("workflow inventory must confirm pinned data was excluded");
  }
  if (evidence.source?.public_api_path !== cutover(policy)?.public_api_path) {
    errors.push("workflow inventory Public API path does not match policy");
  }

  const workflowsById = new Map();
  const classified = [];
  for (const workflow of workflows) {
    if (
      !isObject(workflow) ||
      !nonEmptyString(workflow.id) ||
      !nonEmptyString(workflow.name) ||
      typeof workflow.active !== "boolean" ||
      typeof workflow.isArchived !== "boolean" ||
      !Number.isInteger(workflow.triggerCount) ||
      workflow.triggerCount < 0 ||
      !Array.isArray(workflow.nodes) ||
      workflow.nodes.some(
        (node) =>
          !isObject(node) ||
          !nonEmptyString(node.name) ||
          !nonEmptyString(node.type)
      )
    ) {
      errors.push("workflow inventory contains a malformed sanitized record");
      continue;
    }
    if (workflowsById.has(workflow.id)) {
      errors.push(`workflow inventory repeats ID ${workflow.id}`);
      continue;
    }
    workflowsById.set(workflow.id, workflow);
    const classification = classifyWorkflow(workflow, policy);
    if (!classification.candidate) continue;
    if (classification.matches.length !== 1) {
      errors.push(
        `pipeline workflow ${workflow.id} has an unrecognized or ambiguous role`
      );
      continue;
    }
    classified.push({
      ...workflow,
      role: classification.matches[0]
    });
  }

  const targets = isObject(evidence.targets) ? evidence.targets : {};
  for (const role of REQUIRED_ROLES) {
    const targetId = targets[role];
    if (!nonEmptyString(targetId)) continue;
    const target = workflowsById.get(targetId);
    if (!target) {
      errors.push(`cutover target ${role} is missing from the complete inventory`);
      continue;
    }
    if (target.isArchived) {
      errors.push(`cutover target ${role} is archived`);
    }
    const classification = classifyWorkflow(target, policy);
    if (
      classification.matches.length !== 1 ||
      classification.matches[0] !== role
    ) {
      errors.push(`cutover target ${role} does not match its role signature`);
    }
  }

  if (evidence.phase === "pre_activation") {
    if (
      evidence.inventory_scope?.instance_wide_execution_list_confirmed !==
      true
    ) {
      errors.push(
        "pre-activation evidence must confirm instance-wide execution-list access"
      );
    }
    const restart = evidence.runtime_restart;
    if (!validRuntimeRestart(restart, capturedAt)) {
      errors.push(
        "pre-activation evidence requires a completed runtime restart followed by readiness recovery"
      );
    }
    for (const workflow of classified) {
      if (workflow.active) {
        errors.push(
          `pre-activation pipeline workflow ${workflow.id} is still active`
        );
      }
    }
    const executionWorkflowIds = new Set();
    for (const status of PRE_ACTIVATION_STATUSES) {
      const executions = Array.isArray(evidence.executions?.[status])
        ? evidence.executions[status]
        : [];
      if (!Array.isArray(evidence.executions?.[status])) {
        errors.push(`${status} execution inventory must be an array`);
      }
      errors.push(
        ...validateInventorySource(
          evidence.source?.execution_inventories?.[status],
          `/executions?status=${status}`,
          executions.length
        ).map((error) => `${status} ${error}`)
      );
      if (
        evidence.source?.execution_inventories?.[status]?.include_data !==
        false
      ) {
        errors.push(`${status} execution inventory must exclude execution data`);
      }
      for (const execution of executions) {
        if (
          !isObject(execution) ||
          !nonEmptyString(String(execution.id ?? "")) ||
          !nonEmptyString(String(execution.workflowId ?? "")) ||
          execution.status !== status
        ) {
          errors.push(`${status} execution inventory contains a malformed record`);
          continue;
        }
        if (executionWorkflowIds.has(String(execution.id))) {
          errors.push(`execution inventory repeats ID ${execution.id}`);
        }
        executionWorkflowIds.add(String(execution.id));
        if (
          classified.some(
            (workflow) => workflow.id === String(execution.workflowId)
          )
        ) {
          errors.push(
            `pipeline workflow ${execution.workflowId} still has a ${status} execution`
          );
        }
      }
    }
  }

  if (evidence.phase === "post_activation") {
    for (const role of REQUIRED_ROLES) {
      const activeForRole = classified.filter(
        (workflow) => workflow.role === role && workflow.active
      );
      if (
        activeForRole.length !== 1 ||
        activeForRole[0]?.id !== targets[role]
      ) {
        errors.push(
          `post-activation ${role} must have exactly its target workflow active`
        );
      }
      const target = workflowsById.get(targets[role]);
      if (target && target.triggerCount < 1) {
        errors.push(
          `post-activation ${role} target has no registered trigger`
        );
      }
    }
  }
  return errors;
}

function sanitizedWorkflow(workflow) {
  return {
    id: String(workflow?.id ?? ""),
    name: String(workflow?.name ?? ""),
    active: workflow?.active,
    isArchived: workflow?.isArchived === true,
    triggerCount: Number(workflow?.triggerCount ?? 0),
    nodes: (Array.isArray(workflow?.nodes) ? workflow.nodes : []).map(
      (node) => ({
        name: String(node?.name ?? ""),
        type: String(node?.type ?? "")
      })
    )
  };
}

function sanitizedExecution(execution) {
  return {
    id: String(execution?.id ?? ""),
    workflowId: String(execution?.workflowId ?? ""),
    status: String(execution?.status ?? ""),
    startedAt: execution?.startedAt ?? null,
    waitTill: execution?.waitTill ?? null
  };
}

async function fetchAllPages({
  apiBaseUrl,
  apiKey,
  endpoint,
  query,
  fetchImpl
}) {
  const records = [];
  const seenCursors = new Set();
  let cursor;
  let pages = 0;
  do {
    const url = new URL(endpoint.replace(/^\//, ""), apiBaseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      redirect: "error",
      headers: {
        "X-N8N-API-KEY": apiKey
      }
    });
    if (!response?.ok) {
      throw new Error(
        `n8n Public API request failed with status ${response?.status ?? "unknown"}`
      );
    }
    const body = await response.json();
    if (
      !isObject(body) ||
      !Array.isArray(body.data) ||
      !(
        body.nextCursor === null ||
        body.nextCursor === undefined ||
        nonEmptyString(body.nextCursor)
      )
    ) {
      throw new Error("n8n Public API returned an invalid paginated response");
    }
    records.push(...body.data);
    pages += 1;
    if (pages > 100) {
      throw new Error("n8n Public API pagination exceeded 100 pages");
    }
    cursor = body.nextCursor || undefined;
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("n8n Public API repeated a pagination cursor");
      }
      seenCursors.add(cursor);
    }
  } while (cursor);
  return { records, pages };
}

function validateApiBaseUrl(value) {
  if (!nonEmptyString(value)) {
    throw new Error("N8N_PUBLIC_API_URL is required");
  }
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(
      "N8N_PUBLIC_API_URL must use HTTPS or loopback HTTP"
    );
  }
  if (url.username || url.password) {
    throw new Error("N8N_PUBLIC_API_URL must not contain credentials");
  }
  if (!url.pathname.endsWith("/api/v1/")) {
    throw new Error("N8N_PUBLIC_API_URL must end with /api/v1/");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export async function captureWorkflowCutoverEvidence({
  policy,
  phase,
  apiBaseUrl,
  apiKey,
  targetMap,
  fetchImpl = fetch,
  capturedAt = new Date()
}) {
  const policyErrors = validateWorkflowCutoverPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid workflow cutover policy: ${policyErrors.join("; ")}`);
  }
  if (!ALLOWED_PHASES.includes(phase)) {
    throw new Error("cutover phase must be pre_activation or post_activation");
  }
  if (!nonEmptyString(apiKey)) {
    throw new Error("N8N_API_KEY is required");
  }
  const capturedAtMs = capturedAt instanceof Date
    ? capturedAt.getTime()
    : Number.NaN;
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error("cutover capture time is invalid");
  }
  if (targetMap?.schema_version !== 1) {
    throw new Error("cutover target map schema_version must be 1");
  }
  const targetErrors = validateTargetMap(targetMap?.targets);
  if (targetErrors.length > 0) {
    throw new Error(`Invalid cutover target map: ${targetErrors.join("; ")}`);
  }
  if (
    targetMap?.inventory_scope?.instance_wide_workflow_list_confirmed !==
    true ||
    (phase === "pre_activation" &&
      targetMap?.inventory_scope
        ?.instance_wide_execution_list_confirmed !== true)
  ) {
    throw new Error(
      "cutover target map must confirm the required instance-wide inventory scopes"
    );
  }
  if (
    phase === "pre_activation" &&
    !validRuntimeRestart(targetMap?.runtime_restart, capturedAtMs)
  ) {
    throw new Error(
      "cutover target map must record restart and readiness recovery before capture"
    );
  }
  const baseUrl = validateApiBaseUrl(apiBaseUrl);
  const workflowResult = await fetchAllPages({
    apiBaseUrl: baseUrl,
    apiKey,
    endpoint: "workflows",
    query: {
      limit: cutover(policy).inventory_page_limit,
      excludePinnedData: true
    },
    fetchImpl
  });
  const evidence = {
    schema_version: 1,
    phase,
    captured_at: capturedAt.toISOString(),
    source: {
      public_api_path: cutover(policy).public_api_path,
      workflow_inventory: {
        endpoint: "/workflows",
        limit: cutover(policy).inventory_page_limit,
        exclude_pinned_data: true,
        pages: workflowResult.pages,
        records: workflowResult.records.length,
        pagination_complete: true
      }
    },
    runtime_restart: targetMap.runtime_restart,
    inventory_scope: targetMap.inventory_scope,
    targets: targetMap.targets,
    workflows: workflowResult.records.map(sanitizedWorkflow)
  };

  if (phase === "pre_activation") {
    evidence.source.execution_inventories = {};
    evidence.executions = {};
    for (const status of cutover(policy).pre_activation_execution_statuses) {
      const result = await fetchAllPages({
        apiBaseUrl: baseUrl,
        apiKey,
        endpoint: "executions",
        query: {
          status,
          limit: cutover(policy).inventory_page_limit,
          includeData: false
        },
        fetchImpl
      });
      evidence.source.execution_inventories[status] = {
        endpoint: `/executions?status=${status}`,
        limit: cutover(policy).inventory_page_limit,
        pages: result.pages,
        records: result.records.length,
        pagination_complete: true,
        include_data: false
      };
      evidence.executions[status] = result.records.map(sanitizedExecution);
    }
  }
  return evidence;
}
