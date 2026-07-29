import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateRuntimeConfig,
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
  invalid.generator.execution_timeout_seconds =
    invalid.generator.schedule_minutes * 60;
  invalid.archiver.execution_timeout_seconds =
    invalid.archiver.claim_lease_ms / 1000;
  const errors = validateRuntimeConfig(invalid).join("\n");
  assert.match(errors, /timezone must be Asia\/Manila/);
  assert.match(errors, /generator execution timeout must be shorter/);
  assert.match(errors, /archiver claim lease must outlast/);

  const invalidReview = {
    ...review,
    execution_timeout_seconds: review.schedule_minutes * 60,
    projection_claim_lease_ms: review.schedule_minutes * 60 * 1000
  };
  assert.match(
    validateReviewRuntimeConfig(invalidReview).join("\n"),
    /review execution timeout must be shorter/
  );
  invalidReview.execution_timeout_seconds =
    invalidReview.projection_claim_lease_ms / 1000;
  assert.match(
    validateReviewRuntimeConfig(invalidReview).join("\n"),
    /projection claim lease must outlast/
  );
});
