import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deploymentCapacity,
  scheduledBurstCapacity,
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const policy = await loadJson("../config/n8n-deployment-policy.json");
const runtime = await loadJson("../config/runtime.json");
const searchPlan = await loadJson("../config/search-plan.json");
const alertPolicy = await loadJson("../config/alert-policy.json");

test("deployment policy matches three-role runtime and capacity", () => {
  assert.deepEqual(
    validateN8nDeploymentPolicy(policy, {
      runtime,
      searchPlan,
      alertPolicy
    }),
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
    timeout_weighted_concurrency: 0.2847,
    scheduled_runs_per_week: 826,
    runs_by_role: {
      scraper: 42,
      generator: 112,
      alerter_mover: 672
    }
  });
  assert.equal(policy.capacity.minimum_scheduled_burst_headroom, 1);
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
});

test("production environment requires exact runtime values and separate workbooks", () => {
  const environment = {
    ...policy.environment,
    JOB_PIPELINE_SPREADSHEET_ID: "new-workbook",
    JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "configuration-workbook",
    JOB_PIPELINE_OLD_SPREADSHEET_ID: "old-workbook",
    JOB_PIPELINE_REVIEW_URL:
      "https://docs.google.com/spreadsheets/d/new-workbook/edit",
    JOB_PIPELINE_GROQ_API_KEY: "present-but-never-logged",
    JOB_PIPELINE_SLACK_WEBHOOK_URL: "present-but-never-logged"
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
    validateN8nDeploymentPolicy(badPolicy, {
      runtime,
      searchPlan,
      alertPolicy
    }).join(";"),
    /three replacement roles|simultaneous|weekly execution/
  );
});
