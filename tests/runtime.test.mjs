import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  scheduledRunsPerWeek,
  validateRuntimeConfig,
  validateWorkflowArtifactManifest,
  workflowExecutionDataSettings,
  workflowTimezone
} from "../src/runtime.mjs";

const runtime = JSON.parse(
  await readFile(new URL("../config/runtime.json", import.meta.url))
);

test("runtime defines only the three bounded replacement roles", () => {
  assert.deepEqual(validateRuntimeConfig(runtime), []);
  assert.deepEqual(
    Object.keys(runtime)
      .filter((key) =>
        ["scraper", "generator", "alerter_mover"].includes(key)
      )
      .sort(),
    ["alerter_mover", "generator", "scraper"]
  );
  assert.equal("archiver" in runtime, false);
  assert.equal("reviewer" in runtime, false);
  assert.equal(workflowTimezone(runtime), "Asia/Manila");
});

test("workflow artifact manifest rejects missing and retired fourth exports", () => {
  assert.deepEqual(
    validateWorkflowArtifactManifest([
      "scraper.json",
      "generator.json",
      "alerter-mover.json"
    ]),
    []
  );
  assert.match(
    validateWorkflowArtifactManifest([
      "scraper.json",
      "generator.json",
      "alerter-mover.json",
      "reviewer.json"
    ]).join(";"),
    /unexpected workflow artifacts: reviewer\.json/
  );
  assert.match(
    validateWorkflowArtifactManifest([
      "scraper.json",
      "generator.json"
    ]).join(";"),
    /missing workflow artifacts: alerter-mover\.json/
  );
});

test("schedules are staggered and retain claim/timeout headroom", () => {
  const offsets = new Set();
  for (const role of ["scraper", "generator", "alerter_mover"]) {
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

test("weekly execution count reflects the final three schedules", () => {
  assert.deepEqual(scheduledRunsPerWeek(runtime), {
    scraper: 42,
    generator: 112,
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
        schedule_offset_minutes: runtime.generator.schedule_offset_minutes,
        claim_lease_ms: 1
      }
    }).join(";"),
    /schema_version|claim lease|must not start together/
  );
});

test("Generator runtime accepts one through five jobs and rejects invalid caps", () => {
  for (const perRunCap of [1, 2, 3, 4, 5]) {
    assert.deepEqual(
      validateRuntimeConfig({
        ...runtime,
        generator: { ...runtime.generator, per_run_cap: perRunCap }
      }),
      []
    );
  }
  for (const perRunCap of [undefined, 0, -1, 1.5, "5", 6]) {
    assert.match(
      validateRuntimeConfig({
        ...runtime,
        generator: { ...runtime.generator, per_run_cap: perRunCap }
      }).join(";"),
      /generator\.per_run_cap/
    );
  }
});

test("Generator runtime enforces production-safe per-candidate Sheet pacing", () => {
  assert.equal(runtime.generator.candidate_pacing_delay_ms, 20000);
  for (const candidatePacingDelayMs of [undefined, 0, -1, 1.5, "20000", 19999]) {
    assert.match(
      validateRuntimeConfig({
        ...runtime,
        generator: {
          ...runtime.generator,
          candidate_pacing_delay_ms: candidatePacingDelayMs
        }
      }).join(";"),
      /generator\.candidate_pacing_delay_ms/
    );
  }
});

test("generator and alerter schedules retain worst-case timeout separation", () => {
  assert.equal(runtime.alerter_mover.schedule_offset_minutes, 14);
  assert.match(
    validateRuntimeConfig({
      ...runtime,
      alerter_mover: {
        ...runtime.alerter_mover,
        schedule_offset_minutes: 4
      }
    }).join(";"),
    /generator and alerter_mover schedules must not overlap/
  );
});
