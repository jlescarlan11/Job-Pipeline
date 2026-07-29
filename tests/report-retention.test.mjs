import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { latestCompleteAnalyticsReport } from "../src/analytics.mjs";
import {
  planReportRetention,
  reportRetentionCandidateStatus,
  validateReportRetentionPolicy
} from "../src/report-retention.mjs";

const policy = JSON.parse(
  await readFile(
    new URL("../config/report-retention.json", import.meta.url),
    "utf8"
  )
);
const analyticsPolicy = JSON.parse(
  await readFile(
    new URL("../config/analytics-policy.json", import.meta.url),
    "utf8"
  )
);
const recommendationPolicy = JSON.parse(
  await readFile(
    new URL("../config/recommendation-policy.json", import.meta.url),
    "utf8"
  )
);
const claimRetentionPolicy = JSON.parse(
  await readFile(
    new URL("../config/claim-retention.json", import.meta.url),
    "utf8"
  )
);
const now = "2026-07-30T12:00:00.000Z";

function testPolicy(storeName = "analytics") {
  const candidate = structuredClone(policy);
  candidate[storeName].retention_days = 10;
  candidate[storeName].minimum_reports_before_cleanup = 4;
  candidate[storeName].minimum_complete_reports_to_preserve = 2;
  candidate[storeName].maximum_reports_per_cleanup = 2;
  return candidate;
}

const reports = [
  {
    report_id: "current",
    status: "complete",
    generated_at: "2026-07-29T12:00:00.000Z",
    detail_row_count: 2,
    row_number: 2
  },
  {
    report_id: "previous",
    status: "complete",
    generated_at: "2026-07-28T12:00:00.000Z",
    detail_row_count: 1,
    row_number: 3
  },
  {
    report_id: "expired-a",
    status: "complete",
    generated_at: "2026-06-01T12:00:00.000Z",
    detail_row_count: 2,
    row_number: 4
  },
  {
    report_id: "expired-b",
    status: "complete",
    generated_at: "2026-06-02T12:00:00.000Z",
    detail_row_count: 2,
    row_number: 5
  }
];
const details = [
  {
    analytics_row_id: "current|1",
    report_id: "current",
    row_number: 2
  },
  {
    analytics_row_id: "current|2",
    report_id: "current",
    row_number: 3
  },
  {
    analytics_row_id: "previous|1",
    report_id: "previous",
    row_number: 4
  },
  {
    analytics_row_id: "expired-a|1",
    report_id: "expired-a",
    row_number: 8
  },
  {
    analytics_row_id: "expired-a|2",
    report_id: "expired-a",
    row_number: 9
  },
  {
    analytics_row_id: "expired-b|1",
    report_id: "expired-b",
    row_number: 12
  },
  {
    analytics_row_id: "expired-b|2",
    report_id: "expired-b",
    row_number: 14
  }
];

test("report retention policy bounds both stores and covers their claim leases", () => {
  assert.deepEqual(validateReportRetentionPolicy(policy), []);
  assert.ok(
    policy.analytics.claim_lease_ms >
      analyticsPolicy.execution_timeout_seconds * 1000
  );
  assert.ok(
    policy.recommendations.claim_lease_ms >
      recommendationPolicy.execution_timeout_seconds * 1000
  );
  for (const store of [policy.analytics, policy.recommendations]) {
    assert.ok(
      claimRetentionPolicy.allowed_processing_stages.includes(
        store.claim_stage
      )
    );
  }

  const invalid = structuredClone(policy);
  invalid.analytics.minimum_reports_before_cleanup = 2;
  invalid.analytics.minimum_complete_reports_to_preserve = 2;
  invalid.recommendations.allowed_statuses = [];
  invalid.recommendations.claim_identity = invalid.analytics.claim_identity;
  const errors = validateReportRetentionPolicy(invalid).join("\n");
  assert.match(errors, /must exceed the preserved complete-report count/);
  assert.match(errors, /allowed_statuses/);
  assert.match(errors, /claim identities must be distinct/);
});

test("candidate status stays idle below threshold and selects only expired history", () => {
  const configured = testPolicy();
  assert.equal(
    reportRetentionCandidateStatus(reports.slice(0, 3), configured, "analytics", {
      reportIdField: "report_id",
      now
    }).cleanup_required,
    false
  );
  assert.deepEqual(
    reportRetentionCandidateStatus(reports, configured, "analytics", {
      reportIdField: "report_id",
      now
    }),
    {
      policy_version: policy.policy_version,
      store: "analytics",
      enabled: true,
      threshold_reached: true,
      retention_cutoff_at: "2026-07-20T12:00:00.000Z",
      reports_seen: 4,
      eligible: 2,
      cleanup_required: true
    }
  );
  const disabled = structuredClone(configured);
  disabled.enabled = false;
  assert.equal(
    reportRetentionCandidateStatus(reports, disabled, "analytics", {
      reportIdField: "report_id",
      now
    }).cleanup_required,
    false
  );
});

test("retention deletes only count-matched identity groups in descending ranges", () => {
  const plan = planReportRetention(
    reports,
    details,
    testPolicy(),
    "analytics",
    {
      reportIdField: "report_id",
      detailReportIdField: "report_id",
      detailIdField: "analytics_row_id",
      now
    }
  );
  assert.deepEqual(plan.selected_report_ids, ["expired-a", "expired-b"]);
  assert.deepEqual(plan.report_delete_ranges, [
    {
      start_row_number: 4,
      end_row_number: 5,
      start_index: 3,
      end_index: 5
    }
  ]);
  assert.deepEqual(plan.detail_delete_ranges, [
    {
      start_row_number: 14,
      end_row_number: 14,
      start_index: 13,
      end_index: 14
    },
    {
      start_row_number: 12,
      end_row_number: 12,
      start_index: 11,
      end_index: 12
    },
    {
      start_row_number: 8,
      end_row_number: 9,
      start_index: 7,
      end_index: 9
    }
  ]);
  assert.equal(
    latestCompleteAnalyticsReport(
      reports.filter((row) => !plan.selected_report_ids.includes(row.report_id))
    ).report_id,
    "current"
  );
});

test("duplicates, malformed rows, and incomplete detail fail closed", () => {
  const brokenReports = [
    ...reports,
    {
      ...reports[2],
      row_number: 6
    },
    {
      report_id: "bad-time",
      status: "complete",
      generated_at: "June 1",
      detail_row_count: 1,
      row_number: 7
    }
  ];
  const brokenDetails = details.filter(
    (row) => row.analytics_row_id !== "expired-b|2"
  );
  const plan = planReportRetention(
    brokenReports,
    brokenDetails,
    testPolicy(),
    "analytics",
    {
      reportIdField: "report_id",
      detailReportIdField: "report_id",
      detailIdField: "analytics_row_id",
      now
    }
  );
  assert.deepEqual(plan.selected_report_ids, []);
  assert.ok(plan.counts.preserved_malformed_or_ambiguous >= 3);
  assert.equal(plan.counts.preserved_incomplete_detail, 1);
});

test("recommendation retention can remove failed attempts without replacing current", () => {
  const configured = testPolicy("recommendations");
  const reportRows = [
    {
      run_id: "complete-current",
      status: "complete",
      generated_at: "2026-07-29T12:00:00.000Z",
      detail_row_count: 1,
      row_number: 2
    },
    {
      run_id: "complete-previous",
      status: "complete",
      generated_at: "2026-07-28T12:00:00.000Z",
      detail_row_count: 1,
      row_number: 3
    },
    {
      run_id: "failed-old",
      status: "failed",
      generated_at: "2026-06-01T12:00:00.000Z",
      detail_row_count: 1,
      row_number: 4
    },
    {
      run_id: "complete-old",
      status: "complete",
      generated_at: "2026-06-02T12:00:00.000Z",
      detail_row_count: 1,
      row_number: 5
    }
  ];
  const detailRows = reportRows.map((row, index) => ({
    recommendation_id: `${row.run_id}|1`,
    run_id: row.run_id,
    row_number: index + 2
  }));
  const plan = planReportRetention(
    reportRows,
    detailRows,
    configured,
    "recommendations",
    {
      reportIdField: "run_id",
      detailReportIdField: "run_id",
      detailIdField: "recommendation_id",
      now
    }
  );
  assert.deepEqual(plan.selected_report_ids, [
    "failed-old",
    "complete-old"
  ]);
});
