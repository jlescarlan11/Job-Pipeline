import { createHash } from "node:crypto";

import {
  minuteIntervalExecutionMinutes,
  minuteIntervalScheduleRules,
  validateMinuteIntervalSchedule
} from "./schedules.mjs";
import {
  dailyApplicationLimitPaths,
  n8nScheduledRunsPerWeek,
  validateRuntimeConfig
} from "./runtime.mjs";
import {
  googleCredentialNodeNames,
  validateN8nPublicApiUrl,
  validateWorkflowCutoverPolicy,
  workflowDeploymentDigest
} from "./workflow-cutover.mjs";

const N8N_RUNTIME_ROLES = ["scraper", "alerter_mover"];
const SCHEDULED_RUNTIME_ROLES = [
  "scraper",
  "browser_executor",
  "alerter_mover"
];
const N8N_WORKFLOW_ROLES = ["scraper", "alerter_mover"];

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

function unsupportedObjectKeys(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .map((key) => `${path}.${key} is unsupported`);
}

function browserTaskShapeErrors(task) {
  return [
    ...unsupportedObjectKeys(
      task,
      [
        "schema_version",
        "contract_version",
        "role",
        "surface",
        "source_control_state",
        "prompt",
        "skill",
        "browser_plugin",
        "confirmation_attestation",
        "executor",
        "runtime",
        "provenance",
        "compatibility",
        "project",
        "workbooks",
        "privacy"
      ],
      "browser_task"
    ),
    ...unsupportedObjectKeys(task?.prompt, ["version", "path"], "browser_task.prompt"),
    ...unsupportedObjectKeys(
      task?.skill,
      ["name", "version", "path", "explicit_invocation_required"],
      "browser_task.skill"
    ),
    ...unsupportedObjectKeys(
      task?.browser_plugin,
      [
        "name",
        "uri",
        "browser_family",
        "explicit_invocation_required",
        "signed_in_profile_required",
        "history_access_required",
        "allowed_hosts"
      ],
      "browser_task.browser_plugin"
    ),
    ...unsupportedObjectKeys(
      task?.confirmation_attestation,
      [
        "required",
        "source",
        "algorithm",
        "public_key_environment_variable",
        "key_id",
        "public_key_spki_sha256",
        "private_key_available_to_task"
      ],
      "browser_task.confirmation_attestation"
    ),
    ...unsupportedObjectKeys(
      task?.executor,
      [
        "protocol_version",
        "module_path",
        "cli_path",
        "allowed_operations",
        "generic_sheet_write_allowed",
        "business_row_relocation_allowed"
      ],
      "browser_task.executor"
    ),
    ...unsupportedObjectKeys(
      task?.runtime,
      [
        "timezone",
        "schedule_minutes",
        "schedule_offset_minutes",
        "execution_timeout_seconds",
        "claim_lease_ms",
        "minimum_attempt_headroom_ms",
        "continuation_mode",
        "retry"
      ],
      "browser_task.runtime"
    ),
    ...unsupportedObjectKeys(
      task?.runtime?.retry,
      ["max_attempts", "backoff_ms"],
      "browser_task.runtime.retry"
    ),
    ...unsupportedObjectKeys(
      task?.provenance,
      [
        "prompt_digest",
        "skill_bundle_digest",
        "protocol_bundle_digest",
        "candidate_profile_digest",
        "ranking_policy_digest",
        "application_policy_digest",
        "application_pack_policy_digest",
        "configuration_bundle_digest"
      ],
      "browser_task.provenance"
    ),
    ...unsupportedObjectKeys(
      task?.compatibility,
      [
        "application_execution_mode",
        "automation_contract_version",
        "pipeline_schema_version",
        "pipeline_storage_version"
      ],
      "browser_task.compatibility"
    ),
    ...unsupportedObjectKeys(
      task?.project,
      ["mode", "required_root_markers"],
      "browser_task.project"
    ),
    ...unsupportedObjectKeys(
      task?.workbooks,
      ["queue_environment_variable", "configuration_environment_variable"],
      "browser_task.workbooks"
    ),
    ...unsupportedObjectKeys(
      task?.privacy,
      [
        "log_generated_message",
        "log_job_description",
        "log_dom",
        "log_screenshots",
        "log_browser_history",
        "log_credentials_or_cookies"
      ],
      "browser_task.privacy"
    )
  ];
}

export function pipelineApplicationContractDigest(pipelineSchema) {
  return `pipeline-v2:${createHash("sha256")
    .update(JSON.stringify(stableValue(pipelineSchema ?? {})))
    .digest("hex")}`;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function scheduledBurstCapacity(configs) {
  const events = [];
  for (const role of N8N_RUNTIME_ROLES) {
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
  const runs = Object.fromEntries(
    N8N_RUNTIME_ROLES.map((role) => [
      role,
      (7 * 24 * 60) / configs[role].schedule_minutes
    ])
  );
  const timeoutWeighted = N8N_RUNTIME_ROLES.reduce(
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

export function browserTaskContractDigest(task, prompt) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue({ task, prompt: String(prompt || "") })))
    .digest("hex")}`;
}

export function browserTaskPromptDigest(prompt) {
  return `sha256:${createHash("sha256")
    .update(String(prompt || ""))
    .digest("hex")}`;
}

export function repositoryBundleDigest(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      path: String(entry?.path || ""),
      content: String(entry?.content || "")
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")}`;
}

export function configurationDigest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

export function validateN8nDeploymentPolicy(
  policy,
  {
    runtime,
    searchPlan,
    alertPolicy,
    pipelineSchema,
    candidateProfile,
    rankingPolicy,
    applicationPolicy,
    applicationPackPolicy,
    generatedWorkflows,
    browserTask,
    browserTaskPrompt,
    browserSkillBundle,
    browserProtocolBundle
  }
) {
  const errors = [];
  errors.push(...browserTaskShapeErrors(browserTask));
  if (policy?.schema_version !== 3) {
    errors.push("deployment policy schema_version must be 3");
  }
  if (
    policy?.deployment_scope !==
    "self_hosted_regular_plus_codex_scheduled"
  ) {
    errors.push(
      "deployment scope must be self_hosted_regular_plus_codex_scheduled"
    );
  }
  if (policy?.active_contract !== "mixed_cutover") {
    errors.push("deployment active_contract must be mixed_cutover");
  }
  const runtimeErrors = validateRuntimeConfig(runtime);
  errors.push(...runtimeErrors.map((error) => `runtime: ${error}`));
  for (const path of [
    ...dailyApplicationLimitPaths(browserTask, "browser_task"),
    ...dailyApplicationLimitPaths(policy, "deployment_policy")
  ]) {
    errors.push(`${path} is forbidden; deployment has no daily application limit`);
  }
  for (const role of SCHEDULED_RUNTIME_ROLES) {
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
  if (policy?.environment?.NODE_FUNCTION_ALLOW_BUILTIN !== "crypto") {
    errors.push(
      "n8n Code nodes must allow only the crypto builtin for confirmation verification"
    );
  }
  if (policy?.environment?.EXECUTIONS_DATA_PRUNE !== "true") {
    errors.push("execution pruning must be enabled");
  }

  if (runtimeErrors.length === 0) {
    const capacity = deploymentCapacity({
      scraper: runtime.scraper,
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
    const browserRuns = n8nScheduledRunsPerWeek(runtime);
    const allBrowserRuns = (7 * 24 * 60) /
      runtime.browser_executor.schedule_minutes;
    if (
      Object.values(browserRuns).reduce((total, value) => total + value, 0) !==
        capacity.scheduled_runs_per_week ||
      policy?.execution_retention?.browser_task_runs_per_week !== allBrowserRuns
    ) {
      errors.push("n8n and browser-task execution retention counts are stale");
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
    errors.push("monitoring required events must cover both n8n workflows");
  }
  const expectedBrowserEvents = new Set([
    "browser_executor_run",
    "browser_attempt_result"
  ]);
  if (
    !Array.isArray(policy?.monitoring?.browser_task_required_events) ||
    policy.monitoring.browser_task_required_events.length !==
      expectedBrowserEvents.size ||
    policy.monitoring.browser_task_required_events.some(
      (event) => !expectedBrowserEvents.has(event)
    )
  ) {
    errors.push("monitoring browser-task events are incomplete");
  }

  if (policy?.workflow_cutover?.legacy_only !== true) {
    errors.push("historical workflow_cutover contract must be marked legacy_only");
  } else {
    errors.push(
      ...validateWorkflowCutoverPolicy(policy).map(
        (error) => `legacy workflow cutover: ${error}`
      )
    );
  }
  const mixed = policy?.mixed_cutover;
  if (
    mixed?.schema_version !== 1 ||
    mixed?.deployment_mode !== "two_n8n_plus_scheduled_browser"
  ) {
    errors.push("mixed cutover contract is missing or stale");
  }
  const roles = mixed?.n8n_roles ?? [];
  if (
    roles.length !== 2 ||
    new Set(roles.map((entry) => entry.role)).size !== 2 ||
    !N8N_WORKFLOW_ROLES.every((role) =>
      roles.some((entry) => entry.role === role)
    )
  ) {
    errors.push("mixed cutover must define exactly the two n8n roles");
  }
  for (const role of roles) {
    const runtimeConfig = runtime?.[role.role];
    const expectedSchedule = runtimeConfig
      ? minuteIntervalScheduleRules(runtimeConfig, role.role)
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
      if (
        workflow?.meta?.autonomousSubmissionAware !== true ||
        workflow?.meta?.manualSubmissionOnly !== false ||
        JSON.stringify(workflow?.meta?.alertSourceSheets) !==
          JSON.stringify(["Scraped Jobs", "To Apply"])
      ) {
        errors.push(
          "alerter_mover metadata must describe autonomous and legacy alert ownership"
        );
      }
    }
  }
  const scheduledTask = mixed?.scheduled_task ?? {};
  const browserRuntime = runtime?.browser_executor ?? {};
  const taskDigest = browserTaskContractDigest(browserTask, browserTaskPrompt);
  const promptDigest = browserTaskPromptDigest(browserTaskPrompt);
  const skillBundleDigest = repositoryBundleDigest(browserSkillBundle);
  const protocolBundleDigest = repositoryBundleDigest(browserProtocolBundle);
  const candidateProfileDigest = configurationDigest(candidateProfile);
  const rankingPolicyDigest = configurationDigest(rankingPolicy);
  const applicationPolicyDigest = configurationDigest(applicationPolicy);
  const applicationPackPolicyDigest = configurationDigest(applicationPackPolicy);
  const configurationBundleDigest = configurationDigest({
    candidate_profile: candidateProfile,
    ranking_policy: rankingPolicy,
    application_policy: applicationPolicy,
    application_pack_policy: applicationPackPolicy
  });
  const expectedOperations = [
    "select",
    "plan-claim",
    "confirm-claim",
    "validate-decision",
    "confirm-browser-ready",
    "plan-submit-intent",
    "confirm-submit-intent",
    "commit-result",
    "recover"
  ];
  if (
    browserTask?.schema_version !== 1 ||
    browserTask?.role !== "browser_executor" ||
    browserTask?.surface !== "codex_scheduled_task" ||
    browserTask?.source_control_state !== "inactive_unscheduled" ||
    browserTask?.executor?.generic_sheet_write_allowed !== false ||
    browserTask?.executor?.business_row_relocation_allowed !== false ||
    browserTask?.browser_plugin?.uri !== "plugin://chrome@openai-bundled" ||
    browserTask?.browser_plugin?.browser_family !== "chrome" ||
    browserTask?.browser_plugin?.signed_in_profile_required !== true ||
    browserTask?.browser_plugin?.history_access_required !== false ||
    browserTask?.confirmation_attestation?.required !== true ||
    browserTask?.confirmation_attestation?.source !==
      "independent_application_history_adapter" ||
    browserTask?.confirmation_attestation?.algorithm !== "ed25519" ||
    browserTask?.confirmation_attestation?.public_key_environment_variable !==
      "JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY" ||
    browserTask?.confirmation_attestation?.key_id !== "unprovisioned" ||
    browserTask?.confirmation_attestation?.public_key_spki_sha256 !==
      "unprovisioned" ||
    browserTask?.confirmation_attestation?.private_key_available_to_task !== false ||
    browserTask?.project?.mode !== "local_project_root" ||
    JSON.stringify(browserTask?.executor?.allowed_operations) !==
      JSON.stringify(expectedOperations)
  ) {
    errors.push("browser task ownership, plugin, project, or source state is invalid");
  }
  if (
    scheduledTask.role !== "browser_executor" ||
    scheduledTask.contract_version !== browserTask?.contract_version ||
    scheduledTask.artifact_digest !== taskDigest ||
    scheduledTask.prompt_version !== browserTask?.prompt?.version ||
    scheduledTask.prompt_digest !== promptDigest ||
    scheduledTask.skill_name !== browserTask?.skill?.name ||
    scheduledTask.skill_version !== browserTask?.skill?.version ||
    scheduledTask.skill_path !== browserTask?.skill?.path ||
    scheduledTask.protocol_version !== browserTask?.executor?.protocol_version ||
    scheduledTask.plugin_uri !== browserTask?.browser_plugin?.uri ||
    scheduledTask.project_mode !== browserTask?.project?.mode ||
    scheduledTask.timezone !== runtime?.timezone ||
    scheduledTask.schedule_minutes !== browserRuntime.schedule_minutes ||
    scheduledTask.schedule_offset_minutes !==
      browserRuntime.schedule_offset_minutes ||
    scheduledTask.execution_timeout_seconds !==
      browserRuntime.execution_timeout_seconds ||
    scheduledTask.claim_lease_ms !== browserRuntime.claim_lease_ms ||
    scheduledTask.minimum_attempt_headroom_ms !==
      browserRuntime.minimum_attempt_headroom_ms ||
    scheduledTask.continuation_mode !== browserRuntime.continuation_mode ||
    scheduledTask.retry_max_attempts !== browserRuntime.retry?.max_attempts ||
    scheduledTask.retry_backoff_ms !== browserRuntime.retry?.backoff_ms ||
    browserTask?.runtime?.timezone !== runtime?.timezone ||
    browserTask?.runtime?.schedule_minutes !== browserRuntime.schedule_minutes ||
    browserTask?.runtime?.schedule_offset_minutes !==
      browserRuntime.schedule_offset_minutes ||
    browserTask?.runtime?.execution_timeout_seconds !==
      browserRuntime.execution_timeout_seconds ||
    browserTask?.runtime?.claim_lease_ms !== browserRuntime.claim_lease_ms ||
    browserTask?.runtime?.minimum_attempt_headroom_ms !==
      browserRuntime.minimum_attempt_headroom_ms ||
    browserTask?.runtime?.continuation_mode !==
      browserRuntime.continuation_mode ||
    browserTask?.runtime?.retry?.max_attempts !==
      browserRuntime.retry?.max_attempts ||
    browserTask?.runtime?.retry?.backoff_ms !==
      browserRuntime.retry?.backoff_ms ||
    browserTask?.provenance?.prompt_digest !== promptDigest ||
    browserTask?.provenance?.skill_bundle_digest !== skillBundleDigest ||
    browserTask?.provenance?.protocol_bundle_digest !== protocolBundleDigest ||
    browserTask?.provenance?.candidate_profile_digest !==
      candidateProfileDigest ||
    browserTask?.provenance?.ranking_policy_digest !== rankingPolicyDigest ||
    browserTask?.provenance?.application_policy_digest !==
      applicationPolicyDigest ||
    browserTask?.provenance?.application_pack_policy_digest !==
      applicationPackPolicyDigest ||
    browserTask?.provenance?.configuration_bundle_digest !==
      configurationBundleDigest ||
    scheduledTask.prompt_digest !== browserTask?.provenance?.prompt_digest ||
    scheduledTask.skill_bundle_digest !==
      browserTask?.provenance?.skill_bundle_digest ||
    scheduledTask.protocol_bundle_digest !==
      browserTask?.provenance?.protocol_bundle_digest ||
    scheduledTask.candidate_profile_digest !==
      browserTask?.provenance?.candidate_profile_digest ||
    scheduledTask.ranking_policy_digest !==
      browserTask?.provenance?.ranking_policy_digest ||
    scheduledTask.application_policy_digest !==
      browserTask?.provenance?.application_policy_digest ||
    scheduledTask.application_pack_policy_digest !==
      browserTask?.provenance?.application_pack_policy_digest ||
    scheduledTask.configuration_bundle_digest !==
      browserTask?.provenance?.configuration_bundle_digest ||
    scheduledTask.attestation_key_id !==
      browserTask?.confirmation_attestation?.key_id ||
    scheduledTask.attestation_public_key_spki_sha256 !==
      browserTask?.confirmation_attestation?.public_key_spki_sha256 ||
    scheduledTask.source_control_state !== "inactive_unscheduled"
  ) {
    errors.push("scheduled browser task artifact or runtime signature is stale");
  }
  if (
    mixed?.retired_generator?.role !== "evaluator_generator" ||
    mixed?.retired_generator?.required_active_state !== false ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(
      String(mixed?.retired_generator?.target_workflow_id || "")
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(
        mixed?.retired_generator?.last_manual_contract_artifact_digest || ""
      )
    )
  ) {
    errors.push("retired Generator rollback identity is incomplete");
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
    message_plan_version: applicationPackPolicy?.message_plan_version,
    application_execution_mode: applicationPolicy?.execution_mode,
    automation_contract_version:
      applicationPolicy?.automation_contract_version,
    browser_executor_protocol_version:
      browserTask?.executor?.protocol_version,
    browser_skill_version: browserTask?.skill?.version,
    browser_task_contract_version: browserTask?.contract_version,
    browser_task_prompt_version: browserTask?.prompt?.version
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
      applicationPolicy?.policy_version ||
    browserTask?.compatibility?.application_execution_mode !==
      applicationPolicy?.execution_mode ||
    browserTask?.compatibility?.automation_contract_version !==
      applicationPolicy?.automation_contract_version ||
    browserTask?.compatibility?.pipeline_schema_version !==
      pipelineSchema?.schema_version ||
    browserTask?.compatibility?.pipeline_storage_version !==
      pipelineSchema?.storage_version
  ) {
    errors.push(
      "application compatibility sources do not share one profile/policy/task unit"
    );
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
