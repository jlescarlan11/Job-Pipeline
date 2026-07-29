import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generatorResultEvent,
  summarizeOperationalBacklog
} from "../src/operational-observability.mjs";

const schema = JSON.parse(
  await readFile(
    new URL("../config/pipeline-schema.json", import.meta.url),
    "utf8"
  )
);
const now = "2026-07-30T12:00:00.000Z";
const leaseOptions = {
  now,
  generationLeaseMs: 10 * 60 * 1000,
  processingLeaseMs: {
    evaluation: 10 * 60 * 1000,
    generation: 10 * 60 * 1000,
    alert: 2 * 60 * 1000
  }
};

function job(id, overrides = {}) {
  return {
    row_number: Number(id),
    source: "onlinejobs.ph",
    source_job_id: String(id),
    canonical_job_id: `onlinejobs.ph:${id}`,
    canonical_url:
      `https://onlinejobs.ph/jobseekers/job/observability-${id}`,
    pipeline_status: "ready",
    application_decision: "",
    created_at: "2026-07-30T08:00:00.000Z",
    updated_at: "2026-07-30T08:00:00.000Z",
    ...overrides
  };
}

test("operational backlog summarizes exact due work and canonical claim markers", () => {
  const activeRows = [
    job(1, {
      pipeline_status: "recommended",
      evaluated_at: "2026-07-30T09:00:00.000Z"
    }),
    job(2, {
      pipeline_status: "generating",
      processing_stage: "generation",
      processing_token: "generation-token",
      processing_started_at: "2026-07-30T11:40:00.000Z"
    }),
    job(3, {
      pipeline_status: "retryable_error",
      failed_stage: "generation",
      next_retry_at: "2026-07-30T11:30:00.000Z"
    }),
    job(4, {
      pipeline_status: "ready",
      manual_action: "regenerate"
    }),
    job(5, {
      alert_status: "pending",
      generated_at: "2026-07-30T10:00:00.000Z",
      processing_stage: "alert",
      processing_token: "alert-token",
      processing_started_at: "2026-07-30T11:55:00.000Z"
    }),
    job(6, {
      alert_status: "retryable_failure",
      generated_at: "2026-07-30T09:30:00.000Z"
    }),
    job(7, {
      pipeline_status: "evaluating",
      processing_stage: "evaluation",
      processing_token: "current-token",
      processing_started_at: "2026-07-30T11:55:00.000Z"
    }),
    job(9, {
      pipeline_status: "discovered",
      created_at: "2026-07-30T09:00:00.000Z",
      updated_at: "2026-07-30T09:00:00.000Z"
    })
  ];
  const archiveRows = [
    job(8, {
      pipeline_status: "archived",
      application_decision: "applied",
      manual_action: "outcome_offer",
      processing_stage: "unknown",
      processing_token: "invalid-token",
      processing_started_at: "2026-07-30T11:59:00.000Z"
    })
  ];
  const summary = summarizeOperationalBacklog(
    {
      activeRows,
      archiveRows,
      queueRows: [
        {
          row_number: 2,
          canonical_job_id: "onlinejobs.ph:1",
          source_state_guard: "guard-1",
          Action: "I Applied"
        }
      ],
      appliedJobsRows: [
        {
          row_number: 2,
          canonical_job_id: "onlinejobs.ph:8",
          source_state_guard: "guard-8",
          Action: "Offer"
        }
      ]
    },
    schema,
    leaseOptions
  );

  assert.equal(summary.due_generation_count, 4);
  assert.equal(summary.oldest_due_generation_minutes, 180);
  assert.equal(summary.generation_age_unobservable_count, 1);
  assert.equal(summary.due_evaluation_count, 1);
  assert.equal(summary.oldest_due_evaluation_minutes, 180);
  assert.equal(summary.evaluation_age_unobservable_count, 0);
  assert.equal(summary.pending_alert_count, 2);
  assert.equal(summary.oldest_pending_alert_minutes, 150);
  assert.equal(summary.pending_alert_age_unobservable_count, 0);
  assert.equal(summary.manual_action_count, 4);
  assert.equal(summary.manual_action_fingerprints.length, 4);
  assert.equal(summary.manual_action_fingerprints_truncated, 0);
  assert.ok(
    summary.manual_action_fingerprints.every((value) =>
      /^[0-9a-f]{16}$/.test(value)
    )
  );
  assert.doesNotMatch(
    JSON.stringify(summary.manual_action_fingerprints),
    /onlinejobs|regenerate|offer|applied/i
  );
  assert.equal(summary.active_claim_past_lease_count, 3);
  assert.equal(summary.invalid_active_claim_marker_count, 1);
  assert.equal(summary.oldest_active_claim_past_lease_minutes, 10);
});

test("manual-action fingerprints are stable, bounded, and report truncation", () => {
  const queueRows = Array.from({ length: 105 }, (_, index) => ({
    row_number: index + 2,
    canonical_job_id: `onlinejobs.ph:${index + 1}`,
    source_state_guard: `guard-${index + 1}`,
    Action: "Skip"
  }));
  const first = summarizeOperationalBacklog(
    { queueRows },
    schema,
    leaseOptions
  );
  const reordered = summarizeOperationalBacklog(
    { queueRows: [...queueRows].reverse() },
    schema,
    leaseOptions
  );
  assert.equal(first.manual_action_count, 105);
  assert.equal(first.manual_action_fingerprints.length, 100);
  assert.equal(first.manual_action_fingerprints_truncated, 5);
  assert.deepEqual(
    first.manual_action_fingerprints,
    reordered.manual_action_fingerprints
  );
});

test("future operational timestamps fail closed instead of hiding backlog", () => {
  const summary = summarizeOperationalBacklog(
    {
      activeRows: [
        job(201, {
          pipeline_status: "recommended",
          evaluated_at: "2026-07-30T13:00:00.000Z",
          updated_at: "2026-07-30T13:00:00.000Z"
        }),
        job(202, {
          alert_status: "pending",
          generated_at: "2026-07-30T13:00:00.000Z"
        }),
        job(203, {
          pipeline_status: "evaluating",
          processing_stage: "evaluation",
          processing_token: "future-token",
          processing_started_at: "2026-07-30T13:00:00.000Z"
        }),
        job(204, {
          pipeline_status: "discovered",
          created_at: "2026-07-30T13:00:00.000Z",
          updated_at: "2026-07-30T13:00:00.000Z"
        })
      ]
    },
    schema,
    leaseOptions
  );
  assert.equal(summary.due_generation_count, 1);
  assert.equal(summary.oldest_due_generation_minutes, null);
  assert.equal(summary.generation_age_unobservable_count, 1);
  assert.equal(summary.due_evaluation_count, 1);
  assert.equal(summary.oldest_due_evaluation_minutes, null);
  assert.equal(summary.evaluation_age_unobservable_count, 1);
  assert.equal(summary.pending_alert_count, 1);
  assert.equal(summary.oldest_pending_alert_minutes, null);
  assert.equal(summary.pending_alert_age_unobservable_count, 1);
  assert.equal(summary.active_claim_past_lease_count, 1);
  assert.equal(summary.invalid_active_claim_marker_count, 1);
  assert.equal(summary.oldest_active_claim_past_lease_minutes, null);
});

test("discovered overload is visible even when no generation work exists", () => {
  const activeRows = Array.from({ length: 100 }, (_, index) =>
    job(index + 300, {
      pipeline_status: "discovered",
      created_at: "2026-07-30T08:00:00.000Z",
      updated_at: "2026-07-30T08:00:00.000Z"
    })
  );
  const summary = summarizeOperationalBacklog(
    { activeRows },
    schema,
    leaseOptions
  );
  assert.equal(summary.due_generation_count, 0);
  assert.equal(summary.due_evaluation_count, 100);
  assert.equal(summary.oldest_due_evaluation_minutes, 240);
  assert.equal(summary.evaluation_age_unobservable_count, 0);
});

test("operational events expose categories without record evidence", () => {
  assert.deepEqual(
    generatorResultEvent(
      {
        canonical_job_id: "onlinejobs.ph:secret",
        pipeline_status: "retryable_error",
        failed_stage: "generation",
        error_category: "rate_limit",
        updated_at: now,
        error_summary: "provider response with secret evidence"
      },
      "generation"
    ),
    {
      event: "generator_result",
      timestamp: now,
      state_commit_pending: true,
      stage: "generation",
      status: "retryable_error",
      category: "rate_limit"
    }
  );
  assert.throws(
    () =>
      summarizeOperationalBacklog({}, schema, {
        ...leaseOptions,
        now: "invalid"
      }),
    /valid timestamp/
  );
  assert.throws(
    () =>
      summarizeOperationalBacklog({}, schema, {
        ...leaseOptions,
        generationLeaseMs: 0
      }),
    /positive generation lease/
  );
});
