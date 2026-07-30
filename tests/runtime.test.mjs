import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateRuntimeConfig,
  workflowExecutionDataSettings,
  workflowTimezone
} from "../src/runtime.mjs";
import { validateReviewRuntimeConfig } from "../src/review.mjs";

const runtime = JSON.parse(
  await readFile(new URL("../config/runtime.json", import.meta.url), "utf8")
);
const review = JSON.parse(
  await readFile(new URL("../config/review-sheet.json", import.meta.url), "utf8")
);

test("runtime timeouts are positive, scheduled, lease-safe, and Manila-bound", () => {
  assert.deepEqual(validateRuntimeConfig(runtime), []);
  assert.equal(workflowTimezone(runtime), "Asia/Manila");
  assert.equal(runtime.generator.schedule_minutes, 90);
  assert.equal(runtime.generator.per_run_cap, 1);
  assert.equal(runtime.generator.evaluation_per_run_cap, 1);
  assert.equal(runtime.generator.maximum_priority_wait_minutes, 120);
  assert.deepEqual(runtime.google_sheets.read_retry, {
    max_attempts: 3,
    backoff_ms: 5000
  });
  assert.deepEqual(workflowExecutionDataSettings(runtime), {
    saveDataSuccessExecution: "none",
    saveDataErrorExecution: "all",
    saveExecutionProgress: false,
    saveManualExecutions: true
  });
  for (const name of ["generator", "archiver"]) {
    const config = runtime[name];
    assert.ok(
      config.execution_timeout_seconds < config.schedule_minutes * 60
    );
    assert.ok(
      config.execution_timeout_seconds * 1000 < config.claim_lease_ms
    );
  }
  assert.deepEqual(validateReviewRuntimeConfig(review), []);
  assert.ok(
    review.execution_timeout_seconds < review.schedule_minutes * 60
  );
  assert.ok(
    review.execution_timeout_seconds * 1000 <
      review.projection_claim_lease_ms
  );
});

test("runtime validation rejects overlap, expired ownership, and wrong timezone", () => {
  const invalid = structuredClone(runtime);
  invalid.timezone = "UTC";
  invalid.generator.schedule_offset_minutes =
    invalid.generator.schedule_minutes;
  invalid.archiver.schedule_offset_minutes = -1;
  invalid.generator.execution_timeout_seconds =
    invalid.generator.schedule_minutes * 60;
  invalid.archiver.execution_timeout_seconds =
    invalid.archiver.claim_lease_ms / 1000;
  invalid.execution_data.save_successful_production_executions = "all";
  invalid.execution_data.save_failed_production_executions = "none";
  invalid.execution_data.save_execution_progress = true;
  invalid.execution_data.save_manual_executions = false;
  invalid.google_sheets.read_retry.max_attempts = 0;
  invalid.google_sheets.read_retry.backoff_ms = -1;
  invalid.generator.evaluation_per_run_cap = 2;
  invalid.generator.maximum_priority_wait_minutes =
    invalid.generator.schedule_minutes * 2 + 1;
  const errors = validateRuntimeConfig(invalid).join("\n");
  assert.match(errors, /timezone must be Asia\/Manila/);
  assert.match(errors, /generator schedule_offset_minutes/);
  assert.match(errors, /archiver schedule_offset_minutes/);
  assert.match(errors, /generator execution timeout must be shorter/);
  assert.match(errors, /archiver claim lease must outlast/);
  assert.match(errors, /save_successful_production_executions must be none/);
  assert.match(errors, /save_failed_production_executions must be all/);
  assert.match(errors, /save_execution_progress must be false/);
  assert.match(errors, /save_manual_executions must be true/);
  assert.match(errors, /google_sheets\.read_retry\.max_attempts must be a positive integer/);
  assert.match(errors, /google_sheets\.read_retry\.backoff_ms must be a positive integer/);
  assert.match(errors, /generation and evaluation per-run caps must both be 1/);
  assert.match(errors, /maximum priority wait must be between one and two schedules/);

  const invalidReview = {
    ...review,
    schedule_offset_minutes: review.schedule_minutes,
    execution_timeout_seconds: review.schedule_minutes * 60,
    projection_claim_lease_ms: review.schedule_minutes * 60 * 1000
  };
  assert.match(
    validateReviewRuntimeConfig(invalidReview).join("\n"),
    /review schedule_offset_minutes[\s\S]*review execution timeout must be shorter/
  );
  invalidReview.execution_timeout_seconds =
    invalidReview.projection_claim_lease_ms / 1000;
  assert.match(
    validateReviewRuntimeConfig(invalidReview).join("\n"),
    /projection claim lease must outlast/
  );
});
