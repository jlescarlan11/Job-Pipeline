import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deploymentCapacity,
  pipelineApplicationContractDigest,
  scheduledBurstCapacity,
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";
import { workflowDeploymentDigest } from "../src/workflow-cutover.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const policy = await loadJson("../config/n8n-deployment-policy.json");
const runtime = await loadJson("../config/runtime.json");
const searchPlan = await loadJson("../config/search-plan.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const pipelineSchema = await loadJson("../config/pipeline-schema.json");
const candidateProfile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const applicationPackPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const generatedWorkflows = await Promise.all(
  ["scraper", "generator", "alerter-mover"].map((name) =>
    loadJson(`../workflows/${name}.json`)
  )
);
const compatibilityContext = {
  runtime,
  searchPlan,
  alertPolicy,
  pipelineSchema,
  candidateProfile,
  applicationPolicy,
  applicationPackPolicy,
  generatedWorkflows
};

test("deployment policy matches three-role runtime and capacity", () => {
  assert.deepEqual(
    validateN8nDeploymentPolicy(policy, compatibilityContext),
    []
  );
  const configs = {
    scraper: runtime.scraper,
    generator: runtime.generator,
    alerter_mover: runtime.alerter_mover
  };
  assert.deepEqual(scheduledBurstCapacity(configs), {
    maximum_simultaneous_scheduled_executions: 2,
    peak_roles: ["generator", "scraper"]
  });
  assert.deepEqual(deploymentCapacity(configs), {
    maximum_simultaneous_scheduled_executions: 2,
    peak_roles: ["generator", "scraper"],
    timeout_weighted_concurrency: 0.4847,
    scheduled_runs_per_week: 826,
    runs_by_role: {
      scraper: 42,
      generator: 112,
      alerter_mover: 672
    }
  });
  assert.equal(policy.capacity.minimum_scheduled_burst_headroom, 1);
  assert.equal(policy.environment.N8N_RUNNERS_MODE, "external");
  assert.equal(policy.environment.EXECUTIONS_DATA_SAVE_ON_SUCCESS, "none");
});

test("deployment policy has exactly three signatures and all retired markers", () => {
  assert.deepEqual(
    policy.workflow_cutover.roles.map((role) => role.role),
    ["scraper", "evaluator_generator", "alerter_mover"]
  );
  assert.equal(policy.workflow_cutover.retired_role_markers.length, 7);
  assert.equal(
    policy.workbook_binding.queue_spreadsheet_environment_variable,
    "JOB_PIPELINE_SPREADSHEET_ID"
  );
  assert.equal(
    policy.workbook_binding.configuration_spreadsheet_environment_variable,
    "JOB_PIPELINE_CONFIG_SPREADSHEET_ID"
  );
  assert.equal(policy.workbook_binding.all_workbook_ids_must_differ, true);
  assert.equal(
    policy.workbook_binding.deployment_mode,
    "in_place_segmented_update"
  );
  assert.equal(policy.workflow_cutover.schema_version, 3);
  assert.equal(
    new Set(policy.workflow_cutover.roles.map((role) => role.target_workflow_id)).size,
    3
  );
  assert.deepEqual(policy.application_compatibility, {
    legacy_state_guard_compatibility: "forbidden",
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
    message_plan_version: applicationPackPolicy.message_plan_version
  });
});

test("application compatibility rejects a structurally stale pipeline schema", () => {
  const staleSchema = structuredClone(pipelineSchema);
  staleSchema.fields = staleSchema.fields.filter(
    (field) => field !== "review_approval_guard"
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
  const environment = {
    ...policy.environment,
    JOB_PIPELINE_SPREADSHEET_ID: "new-workbook",
    JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "configuration-workbook",
    JOB_PIPELINE_OLD_SPREADSHEET_ID: "old-workbook",
    JOB_PIPELINE_REVIEW_URL:
      "https://docs.google.com/spreadsheets/d/new-workbook/edit#gid=12345",
    JOB_PIPELINE_GROQ_API_KEY: "gsk_testvalue1234567890",
    JOB_PIPELINE_SLACK_WEBHOOK_URL:
      "https://hooks.slack.com/services/T00000000/B00000000/abc123XYZ789token",
    JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID: "receipt-table-id",
    N8N_RUNNERS_AUTH_TOKEN: "present-but-never-logged",
    N8N_PUBLIC_API_URL: "http://127.0.0.1:5678/api/v1"
  };
  assert.deepEqual(
    validateN8nDeploymentEnvironment(policy, environment),
    []
  );
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

test("policy drift in role count, schedules, retention, or headroom fails", () => {
  const badPolicy = structuredClone(policy);
  badPolicy.workflow_cutover.roles.push({
    role: "reviewer",
    name_markers: ["Reviewer", "Legacy"],
    required_node_names: ["One", "Two"]
  });
  badPolicy.capacity.maximum_simultaneous_scheduled_executions = 1;
  badPolicy.execution_retention.scheduled_runs_per_week = 1;
  assert.match(
    validateN8nDeploymentPolicy(badPolicy, compatibilityContext).join(";"),
    /three replacement roles|simultaneous|weekly execution/
  );
});

test("deployment policy pins exact inactive workflow artifacts and runtime signatures", () => {
  for (const field of [
    "artifact_digest",
    "schedule_expressions",
    "execution_timeout_seconds",
    "google_credential_node_count"
  ]) {
    const stale = structuredClone(policy);
    stale.workflow_cutover.roles[1][field] =
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

test("deployment rejects an Alerter & Mover artifact without copy-confirm-delete-only relocation", () => {
  const unsafeWorkflows = structuredClone(generatedWorkflows);
  const unsafeAlerter = unsafeWorkflows.find(
    (workflow) => workflow.meta.workflowRole === "alerter_mover"
  );
  unsafeAlerter.meta.businessRowRelocationMode = "hard_move_allowed";

  const unsafePolicy = structuredClone(policy);
  unsafePolicy.workflow_cutover.roles.find(
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

test("deployment policy rejects a partially deployed application compatibility unit", () => {
  for (const field of [
    "business_row_relocation_mode",
    "application_pack_version",
    "coverage_contract_version",
    "message_plan_version",
    "candidate_profile_version"
  ]) {
    const stale = structuredClone(policy);
    stale.application_compatibility[field] = "stale/v1";
    assert.match(
      validateN8nDeploymentPolicy(stale, compatibilityContext).join(";"),
      new RegExp(`application compatibility ${field}`)
    );
  }
});
