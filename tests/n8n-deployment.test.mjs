import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  browserTaskContractDigest,
  browserTaskPromptDigest,
  deploymentCapacity,
  pipelineApplicationContractDigest,
  scheduledBurstCapacity,
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";
import { workflowDeploymentDigest } from "../src/workflow-cutover.mjs";
import { browserConfirmationPublicKeyDigest } from "../src/browser-confirmation-attestation.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const policy = await loadJson("../config/n8n-deployment-policy.json");
const runtime = await loadJson("../config/runtime.json");
const searchPlan = await loadJson("../config/search-plan.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const pipelineSchema = await loadJson("../config/pipeline-schema.json");
const candidateProfile = await loadJson("../config/candidate-profile.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const applicationPackPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const browserTask = await loadJson("../config/browser-executor-task.json");
const browserTaskPrompt = await readFile(
  new URL("../docs/browser-executor-task-prompt.md", import.meta.url),
  "utf8"
);
const generatedWorkflows = await Promise.all(
  ["scraper", "alerter-mover"].map((name) =>
    loadJson(`../workflows/${name}.json`)
  )
);
const browserSkillBundle = await Promise.all(
  [
    "../.agents/skills/job-autopilot/SKILL.md",
    "../.agents/skills/job-autopilot/references/executor-protocol.md",
    "../.agents/skills/job-autopilot/references/onlinejobs-form-boundary.md",
    "../.agents/skills/job-autopilot/agents/openai.yaml"
  ].map(async (path) => ({
    path,
    content: await readFile(new URL(path, import.meta.url), "utf8")
  }))
);
const browserProtocolBundle = await Promise.all(
  [
    "../AGENTS.md",
    "../src/browser-confirmation-adapter.mjs",
    "../src/browser-confirmation-attestation.mjs",
    "../src/browser-executor.mjs",
    "../src/browser-task-runtime.mjs",
    "../src/contracts.mjs",
    "../src/evaluation.mjs",
    "../src/profile.mjs",
    "../src/system-claims.mjs",
    "../scripts/browser-confirmation-adapter.mjs",
    "../scripts/browser-executor.mjs"
  ].map(
    async (path) => ({
      path,
      content: await readFile(new URL(path, import.meta.url), "utf8")
    })
  )
);
const compatibilityContext = {
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
};

test("deployment policy matches the mixed runtime and n8n-only capacity", () => {
  assert.deepEqual(
    validateN8nDeploymentPolicy(policy, compatibilityContext),
    []
  );
  const configs = {
    scraper: runtime.scraper,
    alerter_mover: runtime.alerter_mover
  };
  assert.deepEqual(scheduledBurstCapacity(configs), {
    maximum_simultaneous_scheduled_executions: 2,
    peak_roles: ["alerter_mover", "scraper"]
  });
  assert.deepEqual(deploymentCapacity(configs), {
    maximum_simultaneous_scheduled_executions: 2,
    peak_roles: ["alerter_mover", "scraper"],
    timeout_weighted_concurrency: 0.3958,
    scheduled_runs_per_week: 714,
    runs_by_role: { scraper: 42, alerter_mover: 672 }
  });
  assert.equal(policy.execution_retention.browser_task_runs_per_week, 672);
  assert.equal(
    policy.capacity.execution_serialization_mode,
    "bounded_two_slot_with_stabilized_claims"
  );
  assert.equal(policy.capacity.production_concurrency_limit, 2);
  assert.equal(policy.environment.N8N_RUNNERS_MODE, "external");
  assert.equal(policy.environment.EXECUTIONS_DATA_SAVE_ON_SUCCESS, "none");
  assert.equal(policy.environment.NODE_FUNCTION_ALLOW_BUILTIN, "crypto");
});

test("active deployment declares two n8n roles and one external browser task", () => {
  assert.deepEqual(
    policy.mixed_cutover.n8n_roles.map((role) => role.role),
    ["scraper", "alerter_mover"]
  );
  assert.equal(policy.workflow_cutover.legacy_only, true);
  assert.equal(policy.mixed_cutover.scheduled_task.role, "browser_executor");
  assert.equal(
    policy.mixed_cutover.retired_generator.required_active_state,
    false
  );
  assert.equal(
    new Set(
      policy.mixed_cutover.n8n_roles.map((role) => role.target_workflow_id)
    ).size,
    2
  );
  assert.equal(
    policy.workbook_binding.queue_spreadsheet_environment_variable,
    "JOB_PIPELINE_SPREADSHEET_ID"
  );
  assert.equal(
    policy.workbook_binding.configuration_spreadsheet_environment_variable,
    "JOB_PIPELINE_CONFIG_SPREADSHEET_ID"
  );
  assert.equal(policy.workbook_binding.all_workbook_ids_must_differ, true);
});

test("rollback restore order covers every required backup kind exactly once", () => {
  const required = policy.mixed_cutover.evidence_contract.required_backup_kinds;
  const restoreOrder = policy.mixed_cutover.rollback_restore_order;
  assert.equal(new Set(restoreOrder).size, required.length);
  assert.deepEqual([...restoreOrder].sort(), [...required].sort());
  assert.ok(required.includes("browser_click_receipt_store"));

  const stale = structuredClone(policy);
  stale.mixed_cutover.rollback_restore_order.pop();
  assert.match(
    validateN8nDeploymentPolicy(stale, compatibilityContext).join(";"),
    /restore order must cover every required backup kind/
  );
});

test("application compatibility pins the autonomous policy and browser protocol", () => {
  assert.deepEqual(policy.application_compatibility, {
    legacy_state_guard_compatibility: "guarded_v3_claim_once",
    business_row_relocation_mode: "copy_confirm_delete_only",
    pipeline_schema_version: pipelineSchema.schema_version,
    storage_version: pipelineSchema.storage_version,
    pipeline_contract_digest:
      pipelineApplicationContractDigest(pipelineSchema),
    candidate_profile_version: candidateProfile.profile_version,
    application_policy_version: applicationPolicy.policy_version,
    application_pack_policy_version: applicationPackPolicy.policy_version,
    application_pack_version: applicationPackPolicy.pack_version,
    coverage_contract_version: applicationPackPolicy.coverage_contract_version,
    message_plan_version: applicationPackPolicy.message_plan_version,
    application_execution_mode: applicationPolicy.execution_mode,
    automation_contract_version: applicationPolicy.automation_contract_version,
    browser_executor_protocol_version: browserTask.executor.protocol_version,
    browser_skill_version: browserTask.skill.version,
    browser_task_contract_version: browserTask.contract_version,
    browser_task_prompt_version: browserTask.prompt.version
  });
});

test("scheduled task policy pins its source contract, prompt, and runtime", () => {
  const scheduled = policy.mixed_cutover.scheduled_task;
  assert.equal(
    scheduled.artifact_digest,
    browserTaskContractDigest(browserTask, browserTaskPrompt)
  );
  assert.equal(scheduled.prompt_digest, browserTaskPromptDigest(browserTaskPrompt));
  assert.equal(scheduled.source_control_state, "inactive_unscheduled");
  assert.equal(scheduled.skill_path, ".agents/skills/job-autopilot/SKILL.md");
  assert.equal(scheduled.plugin_uri, "plugin://chrome@openai-bundled");
  assert.equal(
    scheduled.click_receipt_store,
    "private_pinned_dual_anchor_hash_chain"
  );
  assert.equal(
    scheduled.click_receipt_directory_environment_variable,
    "JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR"
  );
  assert.equal(
    scheduled.click_receipt_witness_environment_variable,
    "JOB_PIPELINE_BROWSER_CLICK_WITNESS_FILE"
  );
  assert.equal(scheduled.click_receipt_store_id, "unprovisioned");
  assert.equal(scheduled.click_receipt_ledger_id, "unprovisioned");
  assert.equal(scheduled.click_receipt_generation_id, "unprovisioned");
  assert.equal(scheduled.click_receipt_manifest_sha256, "unprovisioned");
  assert.equal(
    scheduled.click_receipt_directory_binding_digest,
    "unprovisioned"
  );
  assert.equal(scheduled.click_receipt_directory_identity, "unprovisioned");
  assert.equal(scheduled.click_receipt_witness_identity, "unprovisioned");
  assert.equal(
    scheduled.click_receipt_loss_or_restore_behavior,
    "disable_reconcile_rotate_never_restore_witness"
  );
  assert.equal(scheduled.schedule_minutes, runtime.browser_executor.schedule_minutes);
  assert.equal(
    scheduled.minimum_attempt_headroom_ms,
    runtime.browser_executor.minimum_attempt_headroom_ms
  );
});

test("Alerter & Mover reads provisioned confirmation trust from public runtime bindings", () => {
  const alerter = generatedWorkflows.find(
    (workflow) => workflow.meta?.workflowRole === "alerter_mover"
  );
  const serialized = JSON.stringify(alerter);
  assert.match(serialized, /JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY/);
  assert.match(serialized, /JOB_PIPELINE_BROWSER_ATTESTATION_KEY_ID/);
  assert.match(
    serialized,
    /JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY_SPKI_SHA256/
  );
  assert.doesNotMatch(
    serialized,
    /keyId:\s*["']unprovisioned|publicKeySpkiSha256:\s*["']unprovisioned/
  );
});

test("application compatibility rejects a structurally stale pipeline schema", () => {
  const staleSchema = structuredClone(pipelineSchema);
  staleSchema.fields = staleSchema.fields.filter(
    (field) => field !== "browser_state"
  );
  assert.match(
    validateN8nDeploymentPolicy(policy, {
      ...compatibilityContext,
      pipelineSchema: staleSchema
    }).join(";"),
    /pipeline_contract_digest/
  );
});

test("production environment requires exact runtime values and separate workbooks", () => {
  const attestationPublicKey = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem"
  });
  const environment = {
    ...policy.environment,
    JOB_PIPELINE_SPREADSHEET_ID: "new-workbook",
    JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "configuration-workbook",
    JOB_PIPELINE_OLD_SPREADSHEET_ID: "old-workbook",
    JOB_PIPELINE_REVIEW_URL:
      "https://docs.google.com/spreadsheets/d/new-workbook/edit#gid=12345",
    JOB_PIPELINE_SLACK_WEBHOOK_URL:
      "https://hooks.slack.com/services/T00000000/B00000000/abc123XYZ789token",
    JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID: "receipt-table-id",
    JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY: attestationPublicKey,
    JOB_PIPELINE_BROWSER_ATTESTATION_KEY_ID: "onlinejobs-history-adapter-v1",
    JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY_SPKI_SHA256:
      browserConfirmationPublicKeyDigest(attestationPublicKey),
    N8N_RUNNERS_AUTH_TOKEN: "present-but-never-logged",
    N8N_PUBLIC_API_URL: "http://127.0.0.1:5678/api/v1"
  };
  assert.deepEqual(validateN8nDeploymentEnvironment(policy, environment), []);
  assert.equal("JOB_PIPELINE_GROQ_API_KEY" in environment, false);
  assert.match(
    validateN8nDeploymentEnvironment(policy, {
      ...environment,
      JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "old-workbook",
      N8N_CONCURRENCY_PRODUCTION_LIMIT: "9"
    }).join(";"),
    /must differ|does not match/
  );
  assert.match(
    validateN8nDeploymentEnvironment(policy, {
      ...environment,
      JOB_PIPELINE_SLACK_WEBHOOK_URL: "https://attacker.example/collect",
      N8N_PUBLIC_API_URL: "https://attacker.example/api/v1"
    }).join(";"),
    /not an approved Slack webhook URL|origin is not approved/
  );
});

test("mixed-policy drift in roles, schedules, retention, or headroom fails", () => {
  const badPolicy = structuredClone(policy);
  badPolicy.mixed_cutover.n8n_roles.push({
    role: "evaluator_generator",
    name_markers: ["Generator"],
    required_node_names: ["Generate"]
  });
  badPolicy.capacity.maximum_simultaneous_scheduled_executions = 1;
  badPolicy.execution_retention.scheduled_runs_per_week = 1;
  assert.match(
    validateN8nDeploymentPolicy(badPolicy, compatibilityContext).join(";"),
    /exactly the two n8n roles|simultaneous|weekly execution/
  );
});

test("bounded two-slot deployment rejects extra or insufficient concurrency", () => {
  for (const limit of [1, 3]) {
    const stale = structuredClone(policy);
    stale.environment.N8N_CONCURRENCY_PRODUCTION_LIMIT = String(limit);
    stale.capacity.production_concurrency_limit = limit;
    assert.match(
      validateN8nDeploymentPolicy(stale, compatibilityContext).join(";"),
      /bounded two-slot execution/
    );
  }
});

test("policy pins exact inactive n8n artifact and runtime signatures", () => {
  for (const field of [
    "artifact_digest",
    "schedule_expressions",
    "execution_timeout_seconds",
    "google_credential_node_count"
  ]) {
    const stale = structuredClone(policy);
    stale.mixed_cutover.n8n_roles[1][field] =
      field === "schedule_expressions"
        ? ["0 0 * * * *"]
        : field === "artifact_digest"
          ? `sha256:${"0".repeat(64)}`
          : 1;
    assert.match(
      validateN8nDeploymentPolicy(stale, compatibilityContext).join(";"),
      /runtime signature|artifact signature/
    );
  }
});

test("deployment rejects a mover artifact without copy-confirm-delete-only relocation", () => {
  const unsafeWorkflows = structuredClone(generatedWorkflows);
  const unsafeAlerter = unsafeWorkflows.find(
    (workflow) => workflow.meta.workflowRole === "alerter_mover"
  );
  unsafeAlerter.meta.businessRowRelocationMode = "hard_move_allowed";
  const unsafePolicy = structuredClone(policy);
  unsafePolicy.mixed_cutover.n8n_roles.find(
    (role) => role.role === "alerter_mover"
  ).artifact_digest = workflowDeploymentDigest(unsafeAlerter);
  assert.match(
    validateN8nDeploymentPolicy(unsafePolicy, {
      ...compatibilityContext,
      generatedWorkflows: unsafeWorkflows
    }).join(";"),
    /must preserve copy-confirm-delete-only business relocation/
  );
});

test("deployment rejects stale browser task and compatibility units", () => {
  const staleTask = structuredClone(browserTask);
  staleTask.executor.protocol_version = "browser-executor-v0";
  assert.match(
    validateN8nDeploymentPolicy(policy, {
      ...compatibilityContext,
      browserTask: staleTask
    }).join(";"),
    /scheduled browser task artifact or runtime signature|compatibility/
  );
  for (const field of [
    "business_row_relocation_mode",
    "application_execution_mode",
    "automation_contract_version",
    "browser_executor_protocol_version",
    "browser_skill_version"
  ]) {
    const stale = structuredClone(policy);
    stale.application_compatibility[field] = "stale/v1";
    assert.match(
      validateN8nDeploymentPolicy(stale, compatibilityContext).join(";"),
      new RegExp(`application compatibility ${field}`)
    );
  }
});

test("deployment rejects a repinned browser task daily application limit", () => {
  for (const field of [
    "daily_application_cap",
    "daily_apply_limit",
    "apply_per_day",
    "per_day_apply_limit",
    "daily_submission_limit",
    "submissions_per_day",
    "max_applications_each_day",
    "application_day_limit",
    "applications_per_24_hours",
    "daily_application_ceiling",
    "daily_app_cap",
    "max_apps_per_day",
    "daily_application_budget",
    "daily_apply_points_budget"
  ]) {
    const cappedTask = structuredClone(browserTask);
    cappedTask.runtime[field] = 5;
    const repinnedPolicy = structuredClone(policy);
    repinnedPolicy.mixed_cutover.scheduled_task.artifact_digest =
      browserTaskContractDigest(cappedTask, browserTaskPrompt);
    assert.match(
      validateN8nDeploymentPolicy(repinnedPolicy, {
        ...compatibilityContext,
        browserTask: cappedTask
      }).join(";"),
      new RegExp(`browser_task\\.runtime\\.${field} is forbidden`)
    );
  }
  for (const nestedLimit of [
    { application_quota: { period: "day", maximum: 5 } },
    { application_limit: { window_hours: 24, value: 5 } }
  ]) {
    const cappedTask = structuredClone(browserTask);
    Object.assign(cappedTask.runtime, nestedLimit);
    const repinnedPolicy = structuredClone(policy);
    repinnedPolicy.mixed_cutover.scheduled_task.artifact_digest =
      browserTaskContractDigest(cappedTask, browserTaskPrompt);
    assert.match(
      validateN8nDeploymentPolicy(repinnedPolicy, {
        ...compatibilityContext,
        browserTask: cappedTask
      }).join(";"),
      /browser_task\.runtime\..*(?:forbidden|unsupported)/
    );
  }
});
