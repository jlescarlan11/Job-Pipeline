import assert from "node:assert/strict";
import test from "node:test";

import {
  projectionRowsMatch,
  reusableFunnelSummary,
  reviewSnapshotStatus
} from "../src/review-efficiency.mjs";

const queueFields = ["Status", "Job title", "Action", "canonical_job_id"];
const appliedFields = [
  "Applied at",
  "Current outcome",
  "Action",
  "canonical_job_id"
];
const dashboardFields = [
  "metric_key",
  "generated_at",
  "total_unique_jobs",
  "applied",
  "offer"
];
const queueRows = [
  {
    Status: "Ready",
    "Job title": "TypeScript Developer",
    Action: "",
    canonical_job_id: "onlinejobs.ph:1"
  }
];
const appliedRows = [
  {
    "Applied at": "2026-07-30T00:00:00.000Z",
    "Current outcome": "",
    Action: "",
    canonical_job_id: "onlinejobs.ph:2"
  }
];
const dashboard = {
  metric_key: "current",
  generated_at: "2026-07-30T00:00:00.000Z",
  total_unique_jobs: 2,
  applied: 1,
  offer: 0
};
const emptyProcessed = {
  active_updates: [],
  archive_updates: [],
  invalid_actions: []
};
const noCleanup = { delete_ranges: [] };

test("exact projections and funnel content authorize an idle Reviewer exit", () => {
  assert.equal(
    projectionRowsMatch(queueRows, structuredClone(queueRows), queueFields),
    true
  );
  assert.equal(
    reusableFunnelSummary(
      [{ ...dashboard, generated_at: "2026-07-29T00:00:00.000Z" }],
      dashboard,
      dashboardFields
    )?.metric_key,
    "current"
  );
  assert.deepEqual(
    reviewSnapshotStatus({
      processed: emptyProcessed,
      currentQueueRows: queueRows,
      desiredQueueRows: structuredClone(queueRows),
      queueFields,
      currentAppliedRows: appliedRows,
      desiredAppliedRows: structuredClone(appliedRows),
      appliedFields,
      currentDashboardRows: [dashboard],
      dashboardSummary: {
        ...dashboard,
        generated_at: "2026-07-30T00:05:00.000Z"
      },
      dashboardFields,
      claimRetentionPlan: noCleanup
    }),
    {
      refresh_required: false,
      source_update_count: 0,
      invalid_action_count: 0,
      invalid_projection_count: 0,
      review_queue_current: true,
      applied_jobs_current: true,
      dashboard_current: true,
      claim_cleanup_required: false
    }
  );
});

test("any action, drift, ambiguity, formula, or retention work fails the gate closed", () => {
  const base = {
    processed: emptyProcessed,
    currentQueueRows: queueRows,
    desiredQueueRows: structuredClone(queueRows),
    queueFields,
    currentAppliedRows: appliedRows,
    desiredAppliedRows: structuredClone(appliedRows),
    appliedFields,
    currentDashboardRows: [dashboard],
    dashboardSummary: dashboard,
    dashboardFields,
    claimRetentionPlan: noCleanup
  };
  const cases = [
    {
      ...base,
      processed: {
        ...emptyProcessed,
        active_updates: [{ canonical_job_id: "onlinejobs.ph:1" }]
      }
    },
    {
      ...base,
      currentQueueRows: [{ ...queueRows[0], Action: "I Applied" }]
    },
    {
      ...base,
      currentAppliedRows: [
        { ...appliedRows[0], "Current outcome": "=CURRENT_OUTCOME()" }
      ]
    },
    {
      ...base,
      currentDashboardRows: [dashboard, { ...dashboard }]
    },
    {
      ...base,
      projectionInvalidCount: 1
    },
    {
      ...base,
      claimRetentionPlan: {
        delete_ranges: [{ start_index: 1, end_index: 2 }]
      }
    }
  ];
  for (const candidate of cases) {
    assert.equal(reviewSnapshotStatus(candidate).refresh_required, true);
  }
});
