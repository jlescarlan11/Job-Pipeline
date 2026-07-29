import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deploymentCapacity,
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const [
  policy,
  runtime,
  searchPlan,
  alertPolicy,
  review,
  analytics,
  recommendations
] = await Promise.all([
  loadJson("../config/n8n-deployment-policy.json"),
  loadJson("../config/runtime.json"),
  loadJson("../config/search-plan.json"),
  loadJson("../config/alert-policy.json"),
  loadJson("../config/review-sheet.json"),
  loadJson("../config/analytics-policy.json"),
  loadJson("../config/recommendation-policy.json")
]);

const configs = {
  runtime,
  searchPlan,
  alertPolicy,
  review,
  analytics,
  recommendations
};

test("deployment policy bounds self-hosted concurrency and execution retention", () => {
  assert.deepEqual(validateN8nDeploymentPolicy(policy, configs), []);
  const capacity = deploymentCapacity(configs);
  assert.equal(capacity.scheduled_executions_per_week, 2066);
  assert.ok(
    Math.abs(capacity.timeout_weighted_concurrency - 0.7848214285714286) <
      1e-12
  );
  assert.equal(capacity.maximum_workflow_timeout_seconds, 1800);
  assert.equal(
    policy.execution_retention.scheduled_failure_count_at_maximum_age,
    4132
  );
  assert.ok(
    policy.execution_retention.maximum_count >
      policy.execution_retention.scheduled_failure_count_at_maximum_age
  );
});

test("deployment environment validation is exact and never echoes values", () => {
  assert.deepEqual(
    validateN8nDeploymentEnvironment(policy, {
      ...policy.environment
    }),
    []
  );
  const invalidEnvironment = {
    ...policy.environment,
    N8N_CONCURRENCY_PRODUCTION_LIMIT: "untrusted-value"
  };
  delete invalidEnvironment.EXECUTIONS_DATA_PRUNE;
  const errors = validateN8nDeploymentEnvironment(
    policy,
    invalidEnvironment
  ).join("\n");
  assert.match(errors, /EXECUTIONS_DATA_PRUNE is missing/);
  assert.match(
    errors,
    /N8N_CONCURRENCY_PRODUCTION_LIMIT does not match deployment policy/
  );
  assert.doesNotMatch(errors, /untrusted-value/);
});

test("deployment policy rejects unbounded storage and exhausted capacity", () => {
  const invalid = structuredClone(policy);
  invalid.environment.EXECUTIONS_DATA_PRUNE = "false";
  invalid.environment.EXECUTIONS_DATA_PRUNE_MAX_COUNT = "100";
  invalid.execution_retention.maximum_count = 100;
  invalid.capacity.production_concurrency_limit = 1;
  invalid.environment.N8N_CONCURRENCY_PRODUCTION_LIMIT = "1";
  invalid.capacity.maximum_utilization_ratio = 0.5;
  invalid.monitoring.metrics_internal_only = false;
  invalid.failure_detection.central_error_workflow_bound = true;
  const errors = validateN8nDeploymentPolicy(invalid, configs).join("\n");
  assert.match(errors, /execution pruning must be enabled/);
  assert.match(errors, /cannot retain the full age window/);
  assert.match(errors, /timeout-weighted utilization exceeds policy/);
  assert.match(errors, /monitoring endpoints must be internal/);
  assert.match(errors, /without a fabricated error-workflow binding/);
});

test("deployment policy fails closed on malformed timeouts and missing alerts", () => {
  const invalid = structuredClone(policy);
  invalid.environment.EXECUTIONS_TIMEOUT = "not-a-number";
  invalid.capacity.queue_wait_alert_seconds = 301;
  delete invalid.monitoring.thresholds.oldest_pending_alert_minutes;
  const errors = validateN8nDeploymentPolicy(invalid, configs).join("\n");
  assert.match(errors, /instance timeout bounds must cover every workflow timeout/);
  assert.match(
    errors,
    /required monitoring threshold oldest_pending_alert_minutes/
  );
  assert.match(errors, /capacity and monitoring queue-wait thresholds must match/);
});
