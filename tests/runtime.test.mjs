import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  n8nScheduledRunsPerWeek,
  scheduledRunsPerWeek,
  validateRuntimeConfig,
  validateWorkflowArtifactManifest,
  workflowExecutionDataSettings,
  workflowTimezone
} from "../src/runtime.mjs";

const runtime = JSON.parse(
  await readFile(new URL("../config/runtime.json", import.meta.url))
);

test("runtime defines two n8n roles plus the scheduled browser executor", () => {
  assert.deepEqual(validateRuntimeConfig(runtime), []);
  assert.deepEqual(
    Object.keys(runtime)
      .filter((key) =>
        ["scraper", "browser_executor", "alerter_mover"].includes(key)
      )
      .sort(),
    ["alerter_mover", "browser_executor", "scraper"]
  );
  assert.equal("generator" in runtime, false);
  assert.equal("archiver" in runtime, false);
  assert.equal("reviewer" in runtime, false);
  assert.equal(workflowTimezone(runtime), "Asia/Manila");
});

test("active workflow artifact manifest contains exactly the two n8n exports", () => {
  assert.deepEqual(
    validateWorkflowArtifactManifest(["scraper.json", "alerter-mover.json"]),
    []
  );
  assert.match(
    validateWorkflowArtifactManifest([
      "scraper.json",
      "generator.json",
      "alerter-mover.json"
    ]).join(";"),
    /unexpected workflow artifacts: generator\.json/
  );
  assert.match(
    validateWorkflowArtifactManifest(["scraper.json"]).join(";"),
    /missing workflow artifacts: alerter-mover\.json/
  );
});

test("all scheduled roles are staggered and retain claim/timeout headroom", () => {
  const offsets = new Set();
  for (const role of ["scraper", "browser_executor", "alerter_mover"]) {
    const config = runtime[role];
    assert.ok(
      config.execution_timeout_seconds < config.schedule_minutes * 60,
      role
    );
    assert.ok(
      config.claim_lease_ms > config.execution_timeout_seconds * 1000,
      role
    );
    assert.equal(offsets.has(config.schedule_offset_minutes), false, role);
    offsets.add(config.schedule_offset_minutes);
  }
});

test("execution retention settings keep failures and manual smoke only", () => {
  assert.deepEqual(workflowExecutionDataSettings(runtime), {
    saveDataSuccessExecution: "none",
    saveDataErrorExecution: "all",
    saveExecutionProgress: false,
    saveManualExecutions: true
  });
});

test("weekly counts distinguish the external browser task from n8n runs", () => {
  assert.deepEqual(scheduledRunsPerWeek(runtime), {
    scraper: 42,
    browser_executor: 112,
    alerter_mover: 672
  });
  assert.deepEqual(n8nScheduledRunsPerWeek(runtime), {
    scraper: 42,
    alerter_mover: 672
  });
});

test("runtime validation rejects overlap, unbounded claims, and legacy schema", () => {
  assert.match(
    validateRuntimeConfig({
      ...runtime,
      schema_version: 1,
      scraper: {
        ...runtime.scraper,
        schedule_offset_minutes:
          runtime.browser_executor.schedule_offset_minutes,
        claim_lease_ms: 1
      }
    }).join(";"),
    /schema_version|claim lease|must not start together/
  );
});

test("browser executor uses technical headroom without a daily application cap", () => {
  assert.equal(
    runtime.browser_executor.continuation_mode,
    "technical_headroom_next_schedule"
  );
  assert.equal(runtime.browser_executor.minimum_attempt_headroom_ms, 120000);
  assert.equal(
    JSON.stringify(runtime).match(/daily_(?:application_)?(?:cap|limit|quota)/i),
    null
  );
  for (const forbidden of [
    { daily_application_cap: 5 },
    { max_daily_applications: 5 },
    { application_daily_limit: 5 },
    { daily_apply_limit: 5 },
    { apply_per_day: 5 },
    { per_day_apply_limit: 5 },
    { daily_submission_limit: 5 },
    { submissions_per_day: 5 },
    { max_applications_each_day: 5 },
    { application_day_limit: 5 },
    { applications_per_24_hours: 5 },
    { daily_application_ceiling: 5 },
    { daily_app_cap: 5 },
    { max_apps_per_day: 5 },
    { application_quota: { period: "day", maximum: 5 } },
    { application_limit: { window_hours: 24, value: 5 } },
    { retry: { ...runtime.browser_executor.retry, date_bucket: "today" } }
  ]) {
    assert.match(
      validateRuntimeConfig({
        ...runtime,
        browser_executor: { ...runtime.browser_executor, ...forbidden }
      }).join(";"),
      /forbidden; runtime has no daily application limit/
    );
  }
});

test("browser and mover schedules retain worst-case timeout separation", () => {
  assert.equal(runtime.alerter_mover.schedule_offset_minutes, 10);
  assert.equal(runtime.browser_executor.schedule_offset_minutes, 2);
  assert.match(
    validateRuntimeConfig({
      ...runtime,
      browser_executor: {
        ...runtime.browser_executor,
        execution_timeout_seconds: 540
      }
    }).join(";"),
    /browser_executor and alerter_mover schedules must not overlap/
  );
});

test("malformed scheduled role reports validation errors instead of crashing", () => {
  assert.doesNotThrow(() =>
    validateRuntimeConfig({ ...runtime, browser_executor: undefined })
  );
  assert.match(
    validateRuntimeConfig({ ...runtime, browser_executor: undefined }).join(";"),
    /browser_executor\.schedule_minutes/
  );
});

test("Alerter claim contention stabilization remains in-process and bounded", () => {
  assert.equal(runtime.alerter_mover.claim_contention_settle_ms, 10000);
  for (const claimContentionSettleMs of [undefined, 0, -1, 1.5, 65000]) {
    assert.match(
      validateRuntimeConfig({
        ...runtime,
        alerter_mover: {
          ...runtime.alerter_mover,
          claim_contention_settle_ms: claimContentionSettleMs
        }
      }).join(";"),
      /claim_contention_settle_ms/
    );
  }
});
