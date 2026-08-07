import {
  minuteIntervalExecutionMinutes,
  minuteIntervalScheduleRules,
  validateMinuteIntervalSchedule
} from "./schedules.mjs";
import { scheduledRunsPerWeek, validateRuntimeConfig } from "./runtime.mjs";
import {
  googleCredentialNodeNames,
  validateN8nPublicApiUrl,
  validateWorkflowCutoverPolicy,
  workflowDeploymentDigest
} from "./workflow-cutover.mjs";

const ROLES = ["scraper", "generator", "alerter_mover"];
const WORKFLOW_ROLES = ["scraper", "evaluator_generator", "alerter_mover"];

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

export function pipelineApplicationContractDigest(pipelineSchema) {
  const serialized = JSON.stringify(
    stableValue({
      schema_version: pipelineSchema?.schema_version,
      storage_version: pipelineSchema?.storage_version,
      fields: pipelineSchema?.fields,
      string_list_fields: pipelineSchema?.string_list_fields,
      json_array_fields: pipelineSchema?.json_array_fields,
      json_field_maximum_characters:
        pipelineSchema?.json_field_maximum_characters,
      timestamp_fields: pipelineSchema?.timestamp_fields,
      field_rules: pipelineSchema?.field_rules
    })
  );
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `pipeline-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function scheduledBurstCapacity(configs) {
  const events = [];
  for (const role of ROLES) {
    const config = configs[role];
    const durationMinutes = Math.ceil(config.execution_timeout_seconds / 60);
    for (let day = 0; day < 7; day += 1) {
      for (const minute of minuteIntervalExecutionMinutes(config, role)) {
        const start = day * 1440 + minute;
        events.push({ role, start, end: start + durationMinutes });
      }
    }
  }
  let peak = 0;
  let peakRoles = [];
  for (const event of events) {
    const active = events.filter(
      (candidate) =>
        candidate.start <= event.start && candidate.end > event.start
    );
    if (active.length > peak) {
      peak = active.length;
      peakRoles = active.map((candidate) => candidate.role).sort();
    }
  }
  return {
    maximum_simultaneous_scheduled_executions: peak,
    peak_roles: peakRoles
  };
}

export function deploymentCapacity(configs) {
  const runs = scheduledRunsPerWeek({
    schema_version: 2,
    timezone: "Asia/Manila",
    execution_data: {
      save_successful_production_executions: "none",
      save_failed_production_executions: "all",
      save_execution_progress: false,
      save_manual_executions: true
    },
    google_sheets: {
      read_retry: { max_attempts: 1, backoff_ms: 1 }
    },
    ...configs
  });
  const timeoutWeighted = ROLES.reduce(
    (total, role) =>
      total +
      configs[role].execution_timeout_seconds /
        (configs[role].schedule_minutes * 60),
    0
  );
  return {
    ...scheduledBurstCapacity(configs),
    timeout_weighted_concurrency:
      Math.round(timeoutWeighted * 10000) / 10000,
    scheduled_runs_per_week: Object.values(runs).reduce(
      (total, value) => total + value,
      0
    ),
    runs_by_role: runs
  };
}

export function validateN8nDeploymentPolicy(
  policy,
  {
    runtime,
    searchPlan,
    alertPolicy,
    pipelineSchema,
    candidateProfile,
    applicationPolicy,
    applicationPackPolicy,
    generatedWorkflows
  }
) {
  const errors = [];
  if (policy?.schema_version !== 2) {
    errors.push("deployment policy schema_version must be 2");
  }
  if (policy?.deployment_scope !== "self_hosted_regular") {
    errors.push("deployment scope must be self_hosted_regular");
  }
  const runtimeErrors = validateRuntimeConfig(runtime);
  errors.push(...runtimeErrors.map((error) => `runtime: ${error}`));
  for (const role of ROLES) {
    errors.push(
      ...validateMinuteIntervalSchedule(runtime?.[role], role).map(
        (error) => `${role}: ${error}`
      )
    );
  }
  if (
    searchPlan?.schedule_minutes !== runtime?.scraper?.schedule_minutes ||
    searchPlan?.schedule_offset_minutes !==
      runtime?.scraper?.schedule_offset_minutes ||
    searchPlan?.execution_timeout_seconds !==
      runtime?.scraper?.execution_timeout_seconds ||
    searchPlan?.claim_lease_ms !== runtime?.scraper?.claim_lease_ms
  ) {
    errors.push("search plan runtime bounds must match runtime.scraper");
  }
  if (
    alertPolicy?.schedule_minutes !==
      runtime?.alerter_mover?.schedule_minutes ||
    alertPolicy?.schedule_offset_minutes !==
      runtime?.alerter_mover?.schedule_offset_minutes ||
    alertPolicy?.execution_timeout_seconds !==
      runtime?.alerter_mover?.execution_timeout_seconds ||
    alertPolicy?.claim_lease_ms !==
      runtime?.alerter_mover?.claim_lease_ms ||
    alertPolicy?.per_run_cap !== runtime?.alerter_mover?.alert_per_run_cap
  ) {
    errors.push("alert policy runtime bounds must match runtime.alerter_mover");
  }

  const limit = Number(policy?.environment?.N8N_CONCURRENCY_PRODUCTION_LIMIT);
  if (!positiveInteger(limit) || limit !== policy?.capacity?.production_concurrency_limit) {
    errors.push("production concurrency limit must be a matching positive integer");
  }
  if (Number(policy?.environment?.EXECUTIONS_TIMEOUT) !== 900) {
    errors.push("instance timeout must equal the longest workflow timeout (900)");
  }
  if (
    policy?.environment?.EXECUTIONS_DATA_SAVE_ON_ERROR !== "all" ||
    policy?.environment?.EXECUTIONS_DATA_SAVE_ON_SUCCESS !== "none" ||
    policy?.environment?.EXECUTIONS_DATA_SAVE_ON_PROGRESS !== "false" ||
    policy?.environment?.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS !== "true"
  ) {
    errors.push("execution data settings must retain failures/manual smoke only");
  }
  if (policy?.environment?.EXECUTIONS_DATA_PRUNE !== "true") {
    errors.push("execution pruning must be enabled");
  }

  if (runtimeErrors.length === 0) {
    const capacity = deploymentCapacity({
      scraper: runtime.scraper,
      generator: runtime.generator,
      alerter_mover: runtime.alerter_mover
    });
    if (
      capacity.maximum_simultaneous_scheduled_executions !==
      policy?.capacity?.maximum_simultaneous_scheduled_executions
    ) {
      errors.push("maximum simultaneous scheduled executions is stale");
    }
    if (policy?.capacity?.execution_serialization_mode === "global_single_slot") {
      if (limit !== 1) {
        errors.push("global single-slot serialization requires concurrency limit 1");
      }
      if (
        capacity.maximum_simultaneous_scheduled_executions - limit >
        policy?.capacity?.maximum_queued_scheduled_executions
      ) {
        errors.push("scheduled burst exceeds the serialized execution queue bound");
      }
      if (
        capacity.timeout_weighted_concurrency / limit >
        policy?.capacity?.maximum_utilization_ratio
      ) {
        errors.push("serialized execution utilization exceeds the policy maximum");
      }
    } else if (
      policy?.capacity?.execution_serialization_mode ===
      "bounded_two_slot_with_stabilized_claims"
    ) {
      if (limit !== 2) {
        errors.push("bounded two-slot execution requires concurrency limit 2");
      }
      if (
        capacity.maximum_simultaneous_scheduled_executions - limit >
        policy?.capacity?.maximum_queued_scheduled_executions
      ) {
        errors.push("scheduled burst exceeds the bounded two-slot queue bound");
      }
      if (
        capacity.timeout_weighted_concurrency / limit >
        policy?.capacity?.maximum_utilization_ratio
      ) {
        errors.push("bounded two-slot execution utilization exceeds the policy maximum");
      }
    } else if (
      limit - capacity.maximum_simultaneous_scheduled_executions <
      policy?.capacity?.minimum_scheduled_burst_headroom
    ) {
      errors.push("scheduled burst does not retain required concurrency headroom");
    }
    if (
      Math.abs(
        capacity.timeout_weighted_concurrency -
          policy?.capacity?.timeout_weighted_concurrency
      ) > 0.0001
    ) {
      errors.push("timeout-weighted concurrency is stale");
    }
    if (
      capacity.timeout_weighted_concurrency >
      policy?.capacity?.maximum_timeout_weighted_concurrency
    ) {
      errors.push("timeout-weighted concurrency exceeds the policy maximum");
    }
    if (
      capacity.scheduled_runs_per_week !==
      policy?.execution_retention?.scheduled_runs_per_week
    ) {
      errors.push("scheduled weekly execution count is stale");
    }
    const maximumAgeWeeks =
      policy.execution_retention.maximum_age_hours / (7 * 24);
    if (
      capacity.scheduled_runs_per_week * maximumAgeWeeks !==
      policy.execution_retention.scheduled_failure_count_at_maximum_age
    ) {
      errors.push("worst-case retained failure count is stale");
    }
  }

  if (
    Number(policy?.environment?.EXECUTIONS_DATA_MAX_AGE) !==
      policy?.execution_retention?.maximum_age_hours ||
    Number(policy?.environment?.EXECUTIONS_DATA_PRUNE_MAX_COUNT) !==
      policy?.execution_retention?.maximum_count
  ) {
    errors.push("execution retention environment and policy must match");
  }
  if (
    policy?.execution_retention?.scheduled_failure_count_at_maximum_age >
    policy?.execution_retention?.maximum_count
  ) {
    errors.push("prune count cannot hold the maximum-age all-failure case");
  }
  if (
    policy?.monitoring?.metrics_internal_only !== true ||
    policy?.environment?.N8N_METRICS !== "true" ||
    policy?.environment?.N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL !== "true"
  ) {
    errors.push("internal workflow-labelled metrics are required");
  }
  const expectedEvents = new Set([
    "discovery_run",
    "generator_result",
    "movement_plan",
    "movement_confirmation",
    "alert_selection",
    "alert_delivery"
  ]);
  if (
    !Array.isArray(policy?.monitoring?.required_events) ||
    policy.monitoring.required_events.length !== expectedEvents.size ||
    policy.monitoring.required_events.some((event) => !expectedEvents.has(event))
  ) {
    errors.push("monitoring required events must cover all three workflows");
  }

  const roles = policy?.workflow_cutover?.roles ?? [];
  errors.push(
    ...validateWorkflowCutoverPolicy(policy).map(
      (error) => `workflow cutover: ${error}`
    )
  );
  if (
    roles.length !== 3 ||
    new Set(roles.map((entry) => entry.role)).size !== 3 ||
    !WORKFLOW_ROLES.every((role) => roles.some((entry) => entry.role === role))
  ) {
    errors.push("cutover policy must define exactly the three replacement roles");
  }
  for (const role of roles) {
    const runtimeRole =
      role.role === "evaluator_generator" ? "generator" : role.role;
    const runtimeConfig = runtime?.[runtimeRole];
    const expectedSchedule = runtimeConfig
      ? minuteIntervalScheduleRules(runtimeConfig, runtimeRole)
          .map((entry) => entry.expression)
          .sort()
      : [];
    if (
      role.execution_timeout_seconds !== runtimeConfig?.execution_timeout_seconds ||
      role.timezone !== runtime?.timezone ||
      JSON.stringify([...(role.schedule_expressions ?? [])].sort()) !==
        JSON.stringify(expectedSchedule)
    ) {
      errors.push(`${role.role} cutover runtime signature is stale`);
    }
    const matches = (generatedWorkflows ?? []).filter((workflow) => {
      const nodeNames = new Set((workflow?.nodes ?? []).map((node) => node?.name));
      return (
        role.name_markers.every((marker) =>
          String(workflow?.name || "").includes(marker)
        ) &&
        role.required_node_names.every((name) => nodeNames.has(name))
      );
    });
    if (matches.length !== 1) {
      errors.push(`${role.role} generated artifact signature must match exactly once`);
      continue;
    }
    const workflow = matches[0];
    if (
      workflow.active !== false ||
      role.artifact_digest !== workflowDeploymentDigest(workflow) ||
      role.google_credential_node_count !==
        googleCredentialNodeNames(workflow).length
    ) {
      errors.push(`${role.role} cutover artifact signature is stale`);
    }
    if (role.role === "alerter_mover") {
      if (
        workflow?.meta?.businessRowRelocationMode !==
        "copy_confirm_delete_only"
      ) {
        errors.push(
          "alerter_mover must preserve copy-confirm-delete-only business relocation"
        );
      }
    }
  }
  if (
    policy?.workbook_binding?.queue_spreadsheet_environment_variable !==
      "JOB_PIPELINE_SPREADSHEET_ID" ||
    policy?.workbook_binding?.configuration_spreadsheet_environment_variable !==
      "JOB_PIPELINE_CONFIG_SPREADSHEET_ID" ||
    policy?.workbook_binding?.all_workbook_ids_must_differ !== true ||
    policy?.workbook_binding?.deployment_mode !==
      "in_place_segmented_update" ||
    policy?.workbook_binding?.queue_workbook_requires_current_storage_contract !==
      true ||
    policy?.workbook_binding
      ?.configuration_workbook_requires_current_contract !== true
  ) {
    errors.push("queue and configuration workbook binding policy is incomplete");
  }
  const compatibility = policy?.application_compatibility ?? {};
  if (
    compatibility.legacy_state_guard_compatibility !==
    "guarded_v3_claim_once"
  ) {
    errors.push(
      "application compatibility must limit legacy state guards to one guarded v3 claim"
    );
  }
  const expectedCompatibility = {
    business_row_relocation_mode: "copy_confirm_delete_only",
    pipeline_schema_version: pipelineSchema?.schema_version,
    storage_version: pipelineSchema?.storage_version,
    pipeline_contract_digest:
      pipelineApplicationContractDigest(pipelineSchema),
    candidate_profile_version: candidateProfile?.profile_version,
    application_policy_version: applicationPolicy?.policy_version,
    application_pack_policy_version: applicationPackPolicy?.policy_version,
    application_pack_version: applicationPackPolicy?.pack_version,
    coverage_contract_version: applicationPackPolicy?.coverage_contract_version,
    message_plan_version: applicationPackPolicy?.message_plan_version
  };
  for (const [field, expected] of Object.entries(expectedCompatibility)) {
    if (expected === undefined || compatibility[field] !== expected) {
      errors.push(`application compatibility ${field} is stale or missing`);
    }
  }
  if (
    applicationPolicy?.candidate_profile_version !==
      candidateProfile?.profile_version ||
    applicationPackPolicy?.candidate_profile_version !==
      candidateProfile?.profile_version ||
    applicationPackPolicy?.application_policy_version !==
      applicationPolicy?.policy_version
  ) {
    errors.push("application compatibility source policies do not share one profile/policy unit");
  }
  return errors;
}

export function validateN8nDeploymentEnvironment(policy, environment) {
  const errors = [];
  for (const [key, expected] of Object.entries(policy?.environment ?? {})) {
    if (String(environment?.[key] ?? "") !== expected) {
      errors.push(`${key} does not match deployment policy`);
    }
  }
  for (const key of [
    "JOB_PIPELINE_SPREADSHEET_ID",
    "JOB_PIPELINE_CONFIG_SPREADSHEET_ID",
    "JOB_PIPELINE_OLD_SPREADSHEET_ID",
    "JOB_PIPELINE_REVIEW_URL",
    "JOB_PIPELINE_GROQ_API_KEY",
    "JOB_PIPELINE_SLACK_WEBHOOK_URL",
    "JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID",
    "N8N_RUNNERS_AUTH_TOKEN"
  ]) {
    if (!String(environment?.[key] || "").trim()) {
      errors.push(`${key} is required`);
    }
  }
  const workbookIds = [
    environment?.JOB_PIPELINE_SPREADSHEET_ID,
    environment?.JOB_PIPELINE_CONFIG_SPREADSHEET_ID,
    environment?.JOB_PIPELINE_OLD_SPREADSHEET_ID
  ].filter((value) => String(value || "").trim());
  if (new Set(workbookIds).size !== workbookIds.length) {
    errors.push("queue, configuration, and old workbook identifiers must differ");
  }
  if (
    environment?.JOB_PIPELINE_REVIEW_URL &&
    (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\//i.test(
      environment.JOB_PIPELINE_REVIEW_URL
    ) ||
      !environment.JOB_PIPELINE_REVIEW_URL.includes(
        `/d/${environment.JOB_PIPELINE_SPREADSHEET_ID}/`
      ) ||
      !/#gid=\d+$/.test(environment.JOB_PIPELINE_REVIEW_URL))
  ) {
    errors.push(
      "JOB_PIPELINE_REVIEW_URL must be an HTTPS deep link to the current Main workbook"
    );
  }
  if (environment?.JOB_PIPELINE_GROQ_API_KEY) {
    if (!/^gsk_[A-Za-z0-9_-]{16,}$/.test(environment.JOB_PIPELINE_GROQ_API_KEY)) {
      errors.push("JOB_PIPELINE_GROQ_API_KEY format is invalid");
    }
  }
  if (environment?.JOB_PIPELINE_SLACK_WEBHOOK_URL) {
    let slackUrl;
    try {
      slackUrl = new URL(environment.JOB_PIPELINE_SLACK_WEBHOOK_URL);
    } catch {
      slackUrl = null;
    }
    if (
      !slackUrl ||
      slackUrl.protocol !== "https:" ||
      slackUrl.hostname !== "hooks.slack.com" ||
      slackUrl.username ||
      slackUrl.password ||
      slackUrl.search ||
      slackUrl.hash ||
      !/^\/services\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{12,}$/.test(
        slackUrl.pathname
      )
    ) {
      errors.push("JOB_PIPELINE_SLACK_WEBHOOK_URL is not an approved Slack webhook URL");
    }
  }
  if (environment?.N8N_PUBLIC_API_URL) {
    errors.push(...validateN8nPublicApiUrl(policy, environment.N8N_PUBLIC_API_URL));
  }
  return errors;
}
