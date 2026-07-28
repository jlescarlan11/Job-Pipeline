import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyManualAction,
  buildFunnelSummary,
  buildReviewQueue,
  processReviewActions
} from "../src/review.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const schema = await loadJson("../config/pipeline-schema.json");
const view = await loadJson("../config/review-sheet.json");
const now = "2026-07-28T10:00:00.000Z";

const job = (overrides = {}) => ({
  row_number: 2,
  source: "onlinejobs.ph",
  source_job_id: "6001",
  canonical_job_id: "onlinejobs.ph:6001",
  canonical_url: "https://onlinejobs.ph/jobseekers/job/example-6001",
  job_title: "TypeScript Developer",
  pipeline_status: "ready",
  match_score: 75,
  match_tier: "direct",
  match_reasons: ["Matched skill: TypeScript"],
  requirement_gaps: [],
  generated_message: "Copy-ready message",
  message_profile_version: "2026-07-28",
  application_decision: "",
  outcome: "",
  manual_action: "",
  ...overrides
});

test("review configuration exposes required information and controlled actions", () => {
  for (const field of [
    "job_title",
    "company",
    "canonical_url",
    "posted_at",
    "salary_text",
    "match_score",
    "match_tier",
    "match_reasons",
    "requirement_gaps",
    "pipeline_status",
    "generated_message",
    "manual_action",
    "application_decision",
    "outcome"
  ]) {
    assert.ok(view.review_columns.includes(field), `missing review column ${field}`);
  }
  assert.deepEqual(view.editable_columns, ["manual_action", "notes"]);
  assert.deepEqual(view.hidden_columns, ["state_guard", "processing_token"]);
  assert.ok(view.manual_action_dropdown.includes("promote"));
  assert.ok(view.manual_action_dropdown.includes("mark_applied"));
  assert.ok(view.manual_action_dropdown.includes("outcome_offer"));
});

test("manual promotion and regeneration create one valid generation path", () => {
  const promoted = applyManualAction(
    job({ pipeline_status: "review_required", manual_action: "promote", generated_message: "" }),
    schema,
    now
  );
  assert.equal(promoted.valid, true);
  assert.equal(promoted.record.pipeline_status, "recommended");
  assert.equal(promoted.record.manual_action, "");

  const regenerated = applyManualAction(job({ manual_action: "regenerate" }), schema, now);
  assert.equal(regenerated.valid, true);
  assert.equal(regenerated.record.pipeline_status, "recommended");
  assert.equal(regenerated.record.generated_message, "Copy-ready message");
});

test("ready jobs can be applied or skipped only by an explicit action", () => {
  const unchanged = applyManualAction(job(), schema, now);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.record.application_decision, "");

  const applied = applyManualAction(job({ manual_action: "mark_applied" }), schema, now);
  assert.equal(applied.record.pipeline_status, "applied");
  assert.equal(applied.record.application_decision, "applied");
  assert.equal(applied.record.application_decided_at, now);

  const skipped = applyManualAction(job({ manual_action: "mark_skipped" }), schema, now);
  assert.equal(skipped.record.pipeline_status, "skipped");
  assert.equal(skipped.record.application_decision, "skipped");
});

test("outcomes require an applied decision and preserve application history", () => {
  const applied = job({
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    manual_action: "outcome_interview"
  });
  const result = applyManualAction(applied, schema, now);
  assert.equal(result.valid, true);
  assert.equal(result.record.outcome, "interview");
  assert.equal(result.record.outcome_at, now);
  assert.equal(result.record.application_decision, "applied");
  assert.equal(result.record.application_decided_at, applied.application_decided_at);
  assert.equal(result.record.generated_message, applied.generated_message);

  const invalid = applyManualAction(
    job({ application_decision: "skipped", manual_action: "outcome_offer" }),
    schema,
    now
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.record.outcome, "");
});

test("unsupported and invalid actions do not erase the previous record", () => {
  const original = job({ manual_action: "delete_everything", outcome: "replied" });
  const unsupported = applyManualAction(original, schema, now);
  assert.equal(unsupported.valid, false);
  assert.deepEqual(unsupported.record, original);

  const invalidTransition = applyManualAction(
    job({ pipeline_status: "review_required", manual_action: "mark_applied" }),
    schema,
    now
  );
  assert.equal(invalidTransition.valid, false);
  assert.equal(invalidTransition.record.pipeline_status, "review_required");
});

test("active and archived action processing stay in their ownership boundary", () => {
  const processed = processReviewActions(
    [job({ manual_action: "mark_applied" })],
    [
      job({
        row_number: 10,
        pipeline_status: "archived",
        archived_from_status: "applied",
        application_decision: "applied",
        manual_action: "outcome_replied"
      })
    ],
    schema,
    now
  );
  assert.equal(processed.active_updates.length, 1);
  assert.equal(processed.archive_updates.length, 1);
  assert.equal(processed.archive_updates[0].outcome, "replied");
  assert.deepEqual(processed.invalid_actions, []);
});

test("priority queue orders ready and high-match jobs before review and recovery", () => {
  const rows = [
    job({ source_job_id: "6101", canonical_job_id: "onlinejobs.ph:6101", pipeline_status: "review_required", match_score: 50 }),
    job({ source_job_id: "6102", canonical_job_id: "onlinejobs.ph:6102", pipeline_status: "ready", match_score: 60 }),
    job({ source_job_id: "6103", canonical_job_id: "onlinejobs.ph:6103", pipeline_status: "recommended", match_score: 90 }),
    job({ source_job_id: "6104", canonical_job_id: "onlinejobs.ph:6104", pipeline_status: "retryable_error", match_score: 95 })
  ];
  const queue = buildReviewQueue(rows, schema, now);
  assert.deepEqual(queue.map((record) => record.pipeline_status), [
    "ready",
    "recommended",
    "review_required",
    "retryable_error"
  ]);
});

test("funnel summary deduplicates active/archive and never infers outcomes", () => {
  const activeRows = [
    job({ source_job_id: "6201", canonical_job_id: "onlinejobs.ph:6201", pipeline_status: "ready" }),
    job({ source_job_id: "6202", canonical_job_id: "onlinejobs.ph:6202", pipeline_status: "review_required", generated_message: "" })
  ];
  const archiveRows = [
    job({
      row_number: 10,
      source_job_id: "6203",
      canonical_job_id: "onlinejobs.ph:6203",
      pipeline_status: "archived",
      archived_from_status: "applied",
      application_decision: "applied",
      outcome: ""
    }),
    job({
      row_number: 11,
      source_job_id: "6204",
      canonical_job_id: "onlinejobs.ph:6204",
      pipeline_status: "archived",
      archived_from_status: "applied",
      application_decision: "applied",
      outcome: "offer"
    })
  ];
  const summary = buildFunnelSummary(activeRows, archiveRows, schema, now);
  assert.equal(summary.total_unique_jobs, 4);
  assert.equal(summary.ready, 3);
  assert.equal(summary.applied, 2);
  assert.equal(summary.offer, 1);
  assert.equal(summary.replied, 0);
  assert.equal(summary.interview, 0);
});

test("empty review and funnel states contain no placeholder records", () => {
  assert.deepEqual(buildReviewQueue([], schema, now), []);
  assert.deepEqual(buildFunnelSummary([], [], schema, now), {
    metric_key: "current",
    generated_at: now,
    total_unique_jobs: 0,
    discovered: 0,
    recommended: 0,
    review_required: 0,
    ready: 0,
    applied: 0,
    skipped: 0,
    replied: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
    retryable_error: 0,
    terminal_error: 0,
    unavailable: 0
  });
});
