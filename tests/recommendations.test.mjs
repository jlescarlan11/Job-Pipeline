import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildAnalyticsReport } from "../src/analytics.mjs";
import {
  buildRecommendationFailure,
  buildRecommendationReport,
  latestCompleteRecommendationReport,
  reusableRecommendationReport,
  validateRecommendationPolicy
} from "../src/recommendations.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const schema = await loadJson("../config/pipeline-schema.json");
const analyticsPolicy = await loadJson("../config/analytics-policy.json");
const recommendationPolicy = await loadJson(
  "../config/recommendation-policy.json"
);
const profile = await loadJson("../config/candidate-profile.json");
const analyticsAt = "2026-07-27T12:00:00.000Z";
const recommendationAt = "2026-07-28T12:00:00.000Z";

const testPolicy = (overrides = {}) => ({
  ...structuredClone(recommendationPolicy),
  minimums: {
    ...recommendationPolicy.minimums,
    overall_applications: 10,
    segment_applications: 5,
    discovery_volume: 5,
    promising_requirement_count: 5,
    explicit_outcome_coverage: 0.8,
    dimension_coverage: 0.8,
    promising_gap_coverage: 0.8,
    ...(overrides.minimums || {})
  },
  comparisons: {
    ...recommendationPolicy.comparisons,
    minimum_composite_rate_difference: 0.1,
    ...(overrides.comparisons || {})
  },
  ...Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => !["minimums", "comparisons"].includes(key)
    )
  )
});

const cohort = () =>
  Array.from({ length: 10 }, (_, index) => {
    const strong = index < 5;
    const id = String(9500 + index);
    return {
      source: "onlinejobs.ph",
      source_job_id: id,
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://onlinejobs.ph/jobseekers/job/recommendation-${id}`,
      pipeline_status: "applied",
      application_decision: "applied",
      discovered_at: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      first_reviewed_at: `2026-07-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
      application_decided_at: `2026-07-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`,
      application_snapshot_at: `2026-07-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`,
      application_qualification_score: strong ? 30 : 90,
      application_opportunity_score: strong ? 40 : 90,
      application_ranking_confidence: strong ? "medium" : "high",
      application_scoring_policy_version: "2026-07-28/v1",
      application_apply_points_recommendation: strong
        ? "low_allocation"
        : "high_allocation",
      application_pack_status_at_apply: strong ? "ready" : "review_required",
      application_posting_age_days: strong ? 1 : 7,
      apply_points_used: strong ? 10 : 1,
      application_message_strategy: strong ? "strong/v1" : "weak/v1",
      opportunity_score: 90,
      search_queries: [strong ? "strong query" : "weak query"],
      role_families: [strong ? "strong-role" : "weak-role"],
      match_reasons: [
        `Matched skill: ${strong ? "TypeScript" : "JavaScript"}`
      ],
      requirement_gap_details: [
        { requirement: "Kubernetes", classification: "hard" }
      ],
      scoring_policy_version: "2026-07-28/v1",
      evaluated_at: `2026-07-${String(index + 1).padStart(2, "0")}T00:30:00.000Z`,
      salary_text: strong
        ? "PHP 80,000/month"
        : "PHP 20,000/month",
      outcome: strong ? "interview" : "no_response",
      outcome_at: `2026-07-${String(index + 11).padStart(2, "0")}T00:00:00.000Z`,
      outcome_events: strong
        ? [
            {
              id: `${id}-reply`,
              type: "replied",
              at: `2026-07-${String(index + 11).padStart(2, "0")}T00:00:00.000Z`
            },
            {
              id: `${id}-interview`,
              type: "interview",
              at: `2026-07-${String(index + 12).padStart(2, "0")}T00:00:00.000Z`
            }
          ]
        : [
            {
              id: `${id}-no-response`,
              type: "no_response",
              at: `2026-07-${String(index + 11).padStart(2, "0")}T00:00:00.000Z`
            }
          ],
      updated_at: `2026-07-${String(index + 12).padStart(2, "0")}T00:00:00.000Z`
    };
  });

const completeAnalytics = (records = cohort()) => {
  const report = buildAnalyticsReport(
    records,
    [],
    schema,
    analyticsPolicy,
    analyticsAt,
    { runId: "analytics-fixture" }
  );
  return { rows: report.rows, reports: [report.completion], source: report };
};

test("recommendation policy is versioned, weekly, guarded, and read-only by contract", () => {
  assert.deepEqual(validateRecommendationPolicy(recommendationPolicy), []);
  assert.equal(recommendationPolicy.schedule_hours, 168);
  assert.deepEqual(recommendationPolicy.schedule, {
    field: "weeks",
    weeks_interval: 1,
    trigger_at_days: [1],
    trigger_at_hour: 2,
    trigger_at_minute: 45
  });
  assert.equal(
    recommendationPolicy.source_completion_buffer_minutes,
    15
  );
  assert.equal(recommendationPolicy.minimums.overall_applications, 20);
  assert.equal(recommendationPolicy.minimums.segment_applications, 5);
  assert.equal(
    recommendationPolicy.required_metric_definition_version,
    analyticsPolicy.metric_definition_version
  );

  const invalid = structuredClone(recommendationPolicy);
  invalid.schedule_hours = 1;
  invalid.schedule.trigger_at_days = [7];
  invalid.execution_timeout_seconds = invalid.schedule_hours * 60 * 60;
  invalid.minimums.dimension_coverage = 2;
  invalid.comparisons.composite_outcomes = ["offer_rate"];
  const errors = validateRecommendationPolicy(invalid).join("\n");
  assert.match(errors, /schedule_hours must be at least 24/);
  assert.match(errors, /weekday from 0 through 6/);
  assert.match(
    errors,
    /execution timeout must be shorter than the recommendation schedule/
  );
  assert.match(errors, /dimension_coverage must be between 0 and 1/);
  assert.match(errors, /composite outcomes/);
});

test("strong and weak query/role cohorts produce evidence-backed attention recommendations", () => {
  const analytics = completeAnalytics();
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "weekly-1" }
  );
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.result, "recommendations");
  const strongQuery = result.rows.find(
    (row) =>
      row.affected_type === "search_query" &&
      row.affected_key === "strong query"
  );
  const weakQuery = result.rows.find(
    (row) =>
      row.affected_type === "search_query" &&
      row.affected_key === "weak query"
  );
  assert.equal(strongQuery.direction, "increase_attention");
  assert.equal(weakQuery.direction, "reduce_attention");
  assert.deepEqual(
    [
      strongQuery.numerator,
      strongQuery.denominator,
      strongQuery.sample_size,
      strongQuery.comparison_value,
      strongQuery.baseline_value,
      strongQuery.coverage_rate
    ],
    [10, 15, 5, 0.666667, 0.333333, 1]
  );
  assert.match(strongQuery.proposed_operator_action, /discovery volume is 5/);
  assert.match(strongQuery.caveat, /non-additive/i);
  assert.ok(
    result.rows.some(
      (row) =>
        row.affected_type === "role_family" &&
        row.affected_key === "weak-role" &&
        row.direction === "reduce_attention"
    )
  );
});

test("ordered score and confidence cohorts expose overconfidence and underconfidence", () => {
  const analytics = completeAnalytics();
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "weekly-calibration" }
  );
  assert.ok(
    result.rows.some(
      (row) =>
        row.affected_type === "qualification_score_band" &&
        row.affected_key === "80_100" &&
        row.direction === "review_overconfidence"
    )
  );
  assert.ok(
    result.rows.some(
      (row) =>
        row.affected_type === "qualification_score_band" &&
        row.affected_key === "25_44" &&
        row.direction === "review_underconfidence"
    )
  );
  assert.ok(
    result.rows.some(
      (row) =>
        row.affected_type === "confidence" &&
        row.affected_key === "high" &&
        row.direction === "review_overconfidence"
    )
  );
  assert.ok(
    result.rows
      .filter((row) => row.category === "score_calibration")
      .every(
        (row) =>
          row.sample_size >= 5 &&
          row.denominator &&
          row.caveat
      )
  );
});

test("points, message strategy, instruction, salary, age, and matched-skill comparisons remain advisory", () => {
  const analytics = completeAnalytics();
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "weekly-comparisons" }
  );
  for (const [dimension, strongKey] of [
    ["apply_points_used", "10"],
    ["message_strategy", "strong/v1"],
    ["instruction_completeness", "complete"],
    ["salary_band", "80k_plus"],
    ["posting_age_band", "0_1_days"],
    ["matched_skill", "TypeScript"]
  ]) {
    const recommendation = result.rows.find(
      (row) =>
        row.affected_type === dimension &&
        row.affected_key === strongKey &&
        row.status === "recommendation"
    );
    assert.ok(recommendation, `missing ${dimension} comparison`);
    assert.equal(recommendation.direction, "favor_for_manual_test");
    assert.match(recommendation.proposed_operator_action, /manual test/i);
    assert.match(recommendation.caveat, /correlational/i);
  }
});

test("frequent promising requirements produce a profile-safe missing-skill recommendation", () => {
  const analytics = completeAnalytics();
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "weekly-skills" }
  );
  const skill = result.rows.find(
    (row) =>
      row.category === "missing_skill" &&
      row.affected_key === "Kubernetes" &&
      row.status === "recommendation"
  );
  assert.ok(skill);
  assert.equal(skill.numerator, 10);
  assert.equal(skill.denominator, 10);
  assert.match(skill.title, /absent from approved profile skills/i);
  assert.match(skill.proposed_operator_action, /only after factual evidence/i);
  assert.match(skill.caveat, new RegExp(profile.profile_version));

  const profileWithSkill = structuredClone(profile);
  profileWithSkill.skills.databases_and_cloud.push("Kubernetes");
  const suppressed = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profileWithSkill,
    recommendationAt,
    { attemptId: "weekly-skills-present" }
  );
  assert.equal(
    suppressed.rows.some(
      (row) =>
        row.category === "missing_skill" &&
        row.affected_key === "Kubernetes" &&
        row.status === "recommendation"
    ),
    false
  );
});

test("production sparse-data guards emit one explicit abstention and no direction", () => {
  const analytics = completeAnalytics();
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    recommendationPolicy,
    profile,
    recommendationAt,
    { attemptId: "weekly-sparse" }
  );
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.result, "abstained");
  assert.equal(result.report.recommendation_count, 0);
  assert.equal(result.report.abstention_count, 1);
  assert.equal(result.rows[0].status, "abstained");
  assert.match(result.rows[0].title, /insufficient sample or outcome coverage/i);
});

test("low or unknown dimension coverage can only produce an abstention for that dimension", () => {
  const records = cohort().map((record, index) => ({
    ...record,
    application_message_strategy: index < 5 ? record.application_message_strategy : ""
  }));
  const analytics = completeAnalytics(records);
  const result = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy({ minimums: { dimension_coverage: 0.8 } }),
    profile,
    recommendationAt,
    { attemptId: "weekly-low-coverage" }
  );
  const strategyRows = result.rows.filter(
    (row) => row.affected_type === "message_strategy"
  );
  assert.ok(strategyRows.length > 0);
  assert.ok(strategyRows.every((row) => row.status === "abstained"));
  assert.ok(strategyRows.every((row) => row.coverage_rate === 0.5));
});

test("empty input is successful and never creates a directional recommendation", () => {
  const result = buildRecommendationReport(
    [],
    [],
    recommendationPolicy,
    profile,
    recommendationAt,
    { attemptId: "weekly-empty" }
  );
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.result, "empty");
  assert.equal(result.report.recommendation_count, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "empty");
});

test("incompatible or incomplete analytics fails visibly and retains the latest complete report", () => {
  const analytics = completeAnalytics();
  const incompatible = structuredClone(analytics.reports[0]);
  incompatible.metric_definition_version = "2026-07-27/v1";
  const failed = buildRecommendationReport(
    analytics.rows,
    [incompatible],
    recommendationPolicy,
    profile,
    recommendationAt,
    { attemptId: "weekly-failed" }
  );
  assert.equal(failed.report.status, "failed");
  assert.equal(failed.report.result, "failed");
  assert.equal(failed.report.error_category, "incompatible_analytics_version");
  assert.equal(failed.report.recommendation_count, 0);

  const oldComplete = {
    ...failed.report,
    run_id: "old-complete",
    status: "complete",
    result: "recommendations",
    generated_at: "2026-07-27T12:00:00.000Z"
  };
  assert.equal(
    latestCompleteRecommendationReport([oldComplete, failed.report]).run_id,
    "old-complete"
  );

  const sanitized = buildRecommendationFailure(
    recommendationPolicy,
    profile,
    recommendationAt,
    {
      attemptId: "weekly-error",
      category: "provider_error",
      summary: "api_key=must-not-persist connection failed"
    }
  );
  assert.doesNotMatch(sanitized.report.error_summary, /must-not-persist/);
});

test("partial analytics input is a failed run and cannot supersede prior complete recommendations", () => {
  const analytics = completeAnalytics();
  const partialInput = buildRecommendationReport(
    analytics.rows.slice(0, 1),
    [
      {
        ...analytics.reports[0],
        status: "failed"
      }
    ],
    recommendationPolicy,
    profile,
    recommendationAt,
    { attemptId: "weekly-partial-input" }
  );
  assert.equal(partialInput.report.status, "failed");
  assert.equal(partialInput.report.result, "failed");
  assert.equal(
    partialInput.report.error_category,
    "incomplete_analytics_report"
  );

  const priorComplete = {
    ...partialInput.report,
    run_id: "prior-complete",
    status: "complete",
    result: "abstained",
    generated_at: "2026-07-27T12:00:00.000Z"
  };
  assert.equal(
    latestCompleteRecommendationReport([
      priorComplete,
      partialInput.report
    ]).run_id,
    "prior-complete"
  );
});

test("successful reruns converge while failures retain attempt evidence", () => {
  const analytics = completeAnalytics();
  const first = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "execution-1" }
  );
  const repeated = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "execution-1" }
  );
  const superseding = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    "2026-07-29T12:00:00.000Z",
    { attemptId: "execution-2" }
  );
  assert.deepEqual(repeated, first);
  assert.equal(superseding.report.analysis_key, first.report.analysis_key);
  assert.equal(superseding.report.run_id, first.report.run_id);
  assert.match(first.report.analysis_key, /^recommendation-[a-f0-9]{64}$/);
  assert.equal(
    reusableRecommendationReport(
      [first.report],
      superseding.report
    )?.run_id,
    first.report.run_id
  );
  assert.equal(
    reusableRecommendationReport(
      [
        first.report,
        {
          ...first.report,
          run_id: "different-newer-run",
          analysis_key: "different-newer-analysis",
          generated_at: "2026-07-29T13:00:00.000Z"
        }
      ],
      superseding.report
    ),
    undefined,
    "a return to older evidence must republish it as current"
  );

  const changedPolicy = testPolicy({
    policy_version: "2026-07-29/v2"
  });
  const changed = buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    changedPolicy,
    profile,
    "2026-07-29T12:00:00.000Z",
    { attemptId: "execution-3" }
  );
  assert.notEqual(changed.report.run_id, first.report.run_id);

  const failedFirst = buildRecommendationFailure(
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "failure-1" }
  );
  const failedSecond = buildRecommendationFailure(
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "failure-2" }
  );
  assert.notEqual(failedFirst.report.run_id, failedSecond.report.run_id);
  assert.equal(
    reusableRecommendationReport([failedFirst.report], failedFirst.report),
    undefined
  );
});

test("recommendation analysis never mutates analytics, policy, profile, or source records", () => {
  const records = cohort();
  const analytics = completeAnalytics(records);
  const snapshots = {
    records: structuredClone(records),
    rows: structuredClone(analytics.rows),
    reports: structuredClone(analytics.reports),
    policy: structuredClone(recommendationPolicy),
    profile: structuredClone(profile)
  };
  buildRecommendationReport(
    analytics.rows,
    analytics.reports,
    testPolicy(),
    profile,
    recommendationAt,
    { attemptId: "no-mutation" }
  );
  assert.deepEqual(records, snapshots.records);
  assert.deepEqual(analytics.rows, snapshots.rows);
  assert.deepEqual(analytics.reports, snapshots.reports);
  assert.deepEqual(recommendationPolicy, snapshots.policy);
  assert.deepEqual(profile, snapshots.profile);
});
