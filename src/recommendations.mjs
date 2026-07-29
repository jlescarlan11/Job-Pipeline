import {
  latestCompleteAnalyticsReport,
  stableSha256
} from "./analytics.mjs";

const DIRECTIONAL_STATUS = "recommendation";

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === "" || value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedText(value, maximum = 1000) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(
      /(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function version(value) {
  return /^\d{4}-\d{2}-\d{2}\/v\d+$/.test(value ?? "");
}

function arrayEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateRecommendationPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["recommendation policy must be an object"];
  }
  if (policy.schema_version !== 1) {
    errors.push("recommendation policy schema_version must be 1");
  }
  for (const field of [
    "policy_version",
    "required_metric_definition_version",
    "required_band_version"
  ]) {
    if (!version(policy[field])) errors.push(`${field} must use YYYY-MM-DD/vN`);
  }
  if (!Number.isInteger(policy.schedule_hours) || policy.schedule_hours < 24) {
    errors.push("schedule_hours must be at least 24");
  }
  if (policy.required_window_type !== "all_time") {
    errors.push("required_window_type must be all_time");
  }
  for (const field of [
    "overall_applications",
    "segment_applications",
    "discovery_volume",
    "promising_requirement_count"
  ]) {
    if (!Number.isInteger(policy.minimums?.[field]) || policy.minimums[field] < 1) {
      errors.push(`minimums.${field} must be a positive integer`);
    }
  }
  for (const field of [
    "explicit_outcome_coverage",
    "dimension_coverage",
    "promising_gap_coverage"
  ]) {
    const value = policy.minimums?.[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`minimums.${field} must be between 0 and 1`);
    }
  }
  if (
    !Number.isFinite(
      policy.comparisons?.minimum_composite_rate_difference
    ) ||
    policy.comparisons.minimum_composite_rate_difference <= 0 ||
    policy.comparisons.minimum_composite_rate_difference > 1
  ) {
    errors.push("minimum composite rate difference must be in (0, 1]");
  }
  if (
    !arrayEquals(policy.comparisons?.composite_outcomes, [
      "reply_rate",
      "interview_rate",
      "offer_rate"
    ])
  ) {
    errors.push(
      "composite outcomes must be reply_rate, interview_rate, and offer_rate"
    );
  }
  if (
    !arrayEquals(policy.score_band_order, [
      "00_24",
      "25_44",
      "45_64",
      "65_79",
      "80_100"
    ])
  ) {
    errors.push("score_band_order is invalid");
  }
  if (!arrayEquals(policy.confidence_order, ["low", "medium", "high"])) {
    errors.push("confidence_order is invalid");
  }
  const expectedDimensions = [
    "matched_skill",
    "salary_band",
    "posting_age_band",
    "apply_points_used",
    "apply_points_recommendation",
    "message_strategy",
    "instruction_completeness"
  ];
  if (!arrayEquals(policy.comparison_dimensions, expectedDimensions)) {
    errors.push("comparison_dimensions are invalid");
  }
  if (
    !Array.isArray(policy.missing_requirement_exclusions) ||
    policy.missing_requirement_exclusions.length === 0
  ) {
    errors.push("missing requirement exclusions are required");
  }
  for (const field of [
    "source_detail_sheet",
    "source_reports_sheet",
    "recommendations_sheet",
    "reports_sheet"
  ]) {
    if (!String(policy[field] || "").trim()) errors.push(`${field} is required`);
  }
  for (const [field, count] of [
    ["recommendation_fields", 28],
    ["report_fields", 19]
  ]) {
    if (
      !Array.isArray(policy[field]) ||
      policy[field].length !== count ||
      new Set(policy[field]).size !== policy[field].length
    ) {
      errors.push(`${field} are invalid`);
    }
  }
  return errors;
}

function analyticsKey(row) {
  return [
    row.dimension || "overall",
    row.segment_key || "all",
    row.metric_key
  ].join("\u001f");
}

function analyticsIndex(rows) {
  return new Map(rows.map((row) => [analyticsKey(row), row]));
}

function metric(index, dimension, segment, metricKey) {
  return index.get([dimension, segment, metricKey].join("\u001f"));
}

function rate(row) {
  return numeric(row?.value);
}

function count(row) {
  return numeric(row?.value) ?? numeric(row?.numerator) ?? 0;
}

function composite(index, dimension, segment) {
  const outcomes = ["reply_rate", "interview_rate", "offer_rate"].map(
    (metricKey) => metric(index, dimension, segment, metricKey)
  );
  const rates = outcomes.map(rate);
  const sampleSize = numeric(outcomes[0]?.denominator);
  if (rates.some((value) => value === undefined) || sampleSize === undefined) {
    return undefined;
  }
  return {
    value:
      Math.round(
        (rates.reduce((sum, value) => sum + value, 0) / outcomes.length) *
          1_000_000
      ) / 1_000_000,
    numerator: outcomes.reduce(
      (sum, row) => sum + (numeric(row.numerator) ?? 0),
      0
    ),
    denominator: sampleSize * outcomes.length,
    sample_size: sampleSize
  };
}

function coverageFor(index, dimension) {
  const row = metric(
    index,
    dimension,
    "all",
    "known_application_coverage"
  );
  return {
    numerator: numeric(row?.coverage_numerator) ?? numeric(row?.numerator) ?? 0,
    denominator:
      numeric(row?.coverage_denominator) ?? numeric(row?.denominator) ?? 0,
    rate: rate(row)
  };
}

function baseEvidence(source, values) {
  return {
    recommendation_id: "",
    run_id: source.run_id,
    analysis_key: source.analysis_key,
    analytics_report_id: source.analytics_report_id,
    recommendation_policy_version: source.policy.policy_version,
    metric_definition_version: source.analytics.metric_definition_version,
    band_version: source.analytics.band_version,
    generated_at: source.generated_at,
    window_start_at: source.analytics.window_start_at || "",
    window_end_at: source.analytics.window_end_at || "",
    status: values.status,
    category: values.category || "",
    affected_type: values.affected_type || "",
    affected_key: boundedText(values.affected_key || "", 500),
    direction: values.direction || "",
    title: boundedText(values.title || "", 500),
    evidence_metric: values.evidence_metric || "",
    numerator: values.numerator ?? "",
    denominator: values.denominator ?? "",
    sample_size: values.sample_size ?? "",
    comparison_value: values.comparison_value ?? "",
    baseline_value: values.baseline_value ?? "",
    difference: values.difference ?? "",
    coverage_numerator: values.coverage_numerator ?? "",
    coverage_denominator: values.coverage_denominator ?? "",
    coverage_rate: values.coverage_rate ?? "",
    proposed_operator_action: boundedText(
      values.proposed_operator_action || "",
      1000
    ),
    caveat: boundedText(values.caveat || "", 1000)
  };
}

function abstention(source, values) {
  return baseEvidence(source, {
    status: "abstained",
    direction: "none",
    caveat:
      values.caveat ||
      "No directional change is justified under the configured sample and coverage rules.",
    ...values
  });
}

function directional(source, values) {
  return baseEvidence(source, {
    status: DIRECTIONAL_STATUS,
    caveat:
      "This is correlational evidence from an observational cohort, not a causal or statistically significant result. Any change requires operator review.",
    ...values
  });
}

function overallGuard(source, index) {
  const applicationCount = count(
    metric(index, "overall", "all", "application_count")
  );
  const outcomeCoverageRow = metric(
    index,
    "overall",
    "all",
    "explicit_outcome_application_coverage"
  );
  const outcomeCoverage = rate(outcomeCoverageRow);
  return {
    applicationCount,
    outcomeCoverage,
    eligible:
      applicationCount >= source.policy.minimums.overall_applications &&
      outcomeCoverage !== undefined &&
      outcomeCoverage >= source.policy.minimums.explicit_outcome_coverage,
    coverageRow: outcomeCoverageRow
  };
}

function queryAndRoleRecommendations(source, index, rows) {
  const result = [];
  const baseline = composite(index, "overall", "all");
  const delta = source.policy.comparisons.minimum_composite_rate_difference;
  for (const dimension of ["search_query", "role_family"]) {
    const coverage = coverageFor(index, dimension);
    if (
      coverage.rate === undefined ||
      coverage.rate < source.policy.minimums.dimension_coverage
    ) {
      result.push(
        abstention(source, {
          category: "search_attention",
          affected_type: dimension,
          affected_key: "all",
          title: `Abstain from ${dimension} recommendations: low coverage`,
          evidence_metric: "known_application_coverage",
          numerator: coverage.numerator,
          denominator: coverage.denominator,
          sample_size: coverage.denominator,
          coverage_numerator: coverage.numerator,
          coverage_denominator: coverage.denominator,
          coverage_rate: coverage.rate
        })
      );
      continue;
    }
    const segments = rows
      .filter(
        (row) =>
          row.dimension === dimension &&
          row.metric_key === "application_count" &&
          row.segment_key !== "unknown"
      )
      .sort((left, right) =>
        String(left.segment_key).localeCompare(String(right.segment_key))
      );
    for (const segment of segments) {
      const sample = count(segment);
      if (sample < source.policy.minimums.segment_applications) continue;
      const observed = composite(index, dimension, segment.segment_key);
      if (!observed || !baseline) continue;
      const difference =
        Math.round((observed.value - baseline.value) * 1_000_000) / 1_000_000;
      const volume = count(
        metric(index, dimension, segment.segment_key, "discovered_job_count")
      );
      if (difference >= delta) {
        result.push(
          directional(source, {
            category: "search_attention",
            affected_type: dimension,
            affected_key: segment.segment_key,
            direction: "increase_attention",
            title: `${segment.segment_label} converts above the overall applied cohort`,
            evidence_metric: "reply_interview_offer_composite",
            numerator: observed.numerator,
            denominator: observed.denominator,
            sample_size: observed.sample_size,
            comparison_value: observed.value,
            baseline_value: baseline.value,
            difference,
            coverage_numerator: coverage.numerator,
            coverage_denominator: coverage.denominator,
            coverage_rate: coverage.rate,
            proposed_operator_action:
              `Review whether to increase manual search attention for ${segment.segment_label}; observed discovery volume is ${volume}.`,
            caveat:
              "Multi-touch full-credit attribution is non-additive, and discovery volume alone is not evidence of conversion."
          })
        );
      } else if (
        (difference <= -delta ||
          (observed.numerator === 0 &&
            volume >= source.policy.minimums.discovery_volume))
      ) {
        result.push(
          directional(source, {
            category: "search_attention",
            affected_type: dimension,
            affected_key: segment.segment_key,
            direction: "reduce_attention",
            title: `${segment.segment_label} has weak response evidence despite observable volume`,
            evidence_metric: "reply_interview_offer_composite",
            numerator: observed.numerator,
            denominator: observed.denominator,
            sample_size: observed.sample_size,
            comparison_value: observed.value,
            baseline_value: baseline.value,
            difference,
            coverage_numerator: coverage.numerator,
            coverage_denominator: coverage.denominator,
            coverage_rate: coverage.rate,
            proposed_operator_action:
              `Review whether to reduce manual search attention for ${segment.segment_label}; observed discovery volume is ${volume}.`,
            caveat:
              "Multi-touch full-credit attribution is non-additive; missing outcomes and selection effects may depress observed conversion."
          })
        );
      }
    }
  }
  return result;
}

function calibrationRecommendations(source, index, rows) {
  const result = [];
  const baseline = composite(index, "overall", "all");
  const delta = source.policy.comparisons.minimum_composite_rate_difference;
  for (const [dimension, order] of [
    ["qualification_score_band", source.policy.score_band_order],
    ["opportunity_score_band", source.policy.score_band_order],
    ["confidence", source.policy.confidence_order]
  ]) {
    const coverage = coverageFor(index, dimension);
    if (
      coverage.rate === undefined ||
      coverage.rate < source.policy.minimums.dimension_coverage
    ) {
      result.push(
        abstention(source, {
          category: "score_calibration",
          affected_type: dimension,
          affected_key: "all",
          title: `Abstain from ${dimension} calibration: low coverage`,
          evidence_metric: "known_application_coverage",
          numerator: coverage.numerator,
          denominator: coverage.denominator,
          sample_size: coverage.denominator,
          coverage_numerator: coverage.numerator,
          coverage_denominator: coverage.denominator,
          coverage_rate: coverage.rate
        })
      );
      continue;
    }
    const eligible = order
      .map((key) => ({
        key,
        observed: composite(index, dimension, key),
        label:
          rows.find(
            (row) =>
              row.dimension === dimension &&
              row.segment_key === key &&
              row.metric_key === "application_count"
          )?.segment_label || key
      }))
      .filter(
        (entry) =>
          entry.observed &&
          entry.observed.sample_size >=
            source.policy.minimums.segment_applications
      );
    for (let indexPosition = 1; indexPosition < eligible.length; indexPosition += 1) {
      const lower = eligible[indexPosition - 1];
      const higher = eligible[indexPosition];
      const difference =
        Math.round(
          (higher.observed.value - lower.observed.value) * 1_000_000
        ) / 1_000_000;
      if (difference <= -delta) {
        result.push(
          directional(source, {
            category: "score_calibration",
            affected_type: dimension,
            affected_key: higher.key,
            direction: "review_overconfidence",
            title: `${higher.label} underperforms the adjacent lower ${dimension} cohort`,
            evidence_metric: "reply_interview_offer_composite",
            numerator: higher.observed.numerator,
            denominator: higher.observed.denominator,
            sample_size: higher.observed.sample_size,
            comparison_value: higher.observed.value,
            baseline_value: lower.observed.value,
            difference,
            coverage_numerator: coverage.numerator,
            coverage_denominator: coverage.denominator,
            coverage_rate: coverage.rate,
            proposed_operator_action:
              "Review the explainable scoring/confidence rules for this band; do not change weights automatically.",
            caveat:
              "The ordered calibration is non-monotonic in this observational cohort; small samples and missing outcomes can cause reversals."
          })
        );
      }
    }
    for (const entry of eligible) {
      if (!baseline) continue;
      const difference =
        Math.round(
          (entry.observed.value - baseline.value) * 1_000_000
        ) / 1_000_000;
      const isLower =
        order.indexOf(entry.key) < Math.floor(order.length / 2);
      if (isLower && difference >= delta) {
        result.push(
          directional(source, {
            category: "score_calibration",
            affected_type: dimension,
            affected_key: entry.key,
            direction: "review_underconfidence",
            title: `${entry.label} outperforms the overall cohort`,
            evidence_metric: "reply_interview_offer_composite",
            numerator: entry.observed.numerator,
            denominator: entry.observed.denominator,
            sample_size: entry.observed.sample_size,
            comparison_value: entry.observed.value,
            baseline_value: baseline.value,
            difference,
            coverage_numerator: coverage.numerator,
            coverage_denominator: coverage.denominator,
            coverage_rate: coverage.rate,
            proposed_operator_action:
              "Review whether the explainable rules underrate this band; retain manual approval for any policy change."
          })
        );
      }
    }
  }
  return result;
}

function comparisonRecommendations(source, index, rows) {
  const result = [];
  const baseline = composite(index, "overall", "all");
  const delta = source.policy.comparisons.minimum_composite_rate_difference;
  for (const dimension of source.policy.comparison_dimensions) {
    const coverage = coverageFor(index, dimension);
    if (
      coverage.rate === undefined ||
      coverage.rate < source.policy.minimums.dimension_coverage
    ) {
      result.push(
        abstention(source, {
          category: "cohort_comparison",
          affected_type: dimension,
          affected_key: "all",
          title: `Abstain from ${dimension} comparison: low coverage`,
          evidence_metric: "known_application_coverage",
          numerator: coverage.numerator,
          denominator: coverage.denominator,
          sample_size: coverage.denominator,
          coverage_numerator: coverage.numerator,
          coverage_denominator: coverage.denominator,
          coverage_rate: coverage.rate
        })
      );
      continue;
    }
    const eligible = rows
      .filter(
        (row) =>
          row.dimension === dimension &&
          row.metric_key === "application_count" &&
          row.segment_key !== "unknown" &&
          count(row) >= source.policy.minimums.segment_applications
      )
      .map((row) => ({
        row,
        observed: composite(index, dimension, row.segment_key)
      }))
      .filter((entry) => entry.observed)
      .sort(
        (left, right) =>
          right.observed.value - left.observed.value ||
          String(left.row.segment_key).localeCompare(
            String(right.row.segment_key)
          )
      );
    if (eligible.length < 2 || !baseline) {
      result.push(
        abstention(source, {
          category: "cohort_comparison",
          affected_type: dimension,
          affected_key: "all",
          title: `Abstain from ${dimension} comparison: insufficient eligible segments`,
          evidence_metric: "eligible_segment_count",
          numerator: eligible.length,
          denominator: 2,
          sample_size: eligible.reduce(
            (sum, entry) => sum + entry.observed.sample_size,
            0
          ),
          coverage_numerator: coverage.numerator,
          coverage_denominator: coverage.denominator,
          coverage_rate: coverage.rate
        })
      );
      continue;
    }
    for (const [entry, direction] of [
      [eligible[0], "favor_for_manual_test"],
      [eligible.at(-1), "review_or_deprioritize"]
    ]) {
      const difference =
        Math.round(
          (entry.observed.value - baseline.value) * 1_000_000
        ) / 1_000_000;
      if (
        (direction === "favor_for_manual_test" && difference < delta) ||
        (direction === "review_or_deprioritize" && difference > -delta)
      ) {
        continue;
      }
      result.push(
        directional(source, {
          category: "cohort_comparison",
          affected_type: dimension,
          affected_key: entry.row.segment_key,
          direction,
          title: `${entry.row.segment_label} differs materially from overall response conversion`,
          evidence_metric: "reply_interview_offer_composite",
          numerator: entry.observed.numerator,
          denominator: entry.observed.denominator,
          sample_size: entry.observed.sample_size,
          comparison_value: entry.observed.value,
          baseline_value: baseline.value,
          difference,
          coverage_numerator: coverage.numerator,
          coverage_denominator: coverage.denominator,
          coverage_rate: coverage.rate,
          proposed_operator_action:
            direction === "favor_for_manual_test"
              ? `Consider a bounded manual test that gives more attention to ${entry.row.segment_label}.`
              : `Review whether to reduce reliance on ${entry.row.segment_label}; do not change policy automatically.`
        })
      );
    }
  }
  return result;
}

function profileSkillSet(profile) {
  const skills = [];
  for (const values of Object.values(profile?.skills ?? {})) {
    if (Array.isArray(values)) skills.push(...values);
  }
  return new Set(
    skills.map((skill) =>
      String(skill).toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim()
    )
  );
}

function missingRequirementRecommendations(source, index, rows, profile) {
  const result = [];
  const coverageRow = metric(
    index,
    "missing_requirement",
    "all",
    "promising_job_gap_coverage"
  );
  const coverage = {
    numerator:
      numeric(coverageRow?.coverage_numerator) ??
      numeric(coverageRow?.numerator) ??
      0,
    denominator:
      numeric(coverageRow?.coverage_denominator) ??
      numeric(coverageRow?.denominator) ??
      0,
    rate: rate(coverageRow)
  };
  if (
    coverage.rate === undefined ||
    coverage.rate < source.policy.minimums.promising_gap_coverage
  ) {
    return [
      abstention(source, {
        category: "missing_skill",
        affected_type: "missing_requirement",
        affected_key: "all",
        title: "Abstain from missing-skill recommendations: low promising-job gap coverage",
        evidence_metric: "promising_job_gap_coverage",
        numerator: coverage.numerator,
        denominator: coverage.denominator,
        sample_size: coverage.denominator,
        coverage_numerator: coverage.numerator,
        coverage_denominator: coverage.denominator,
        coverage_rate: coverage.rate
      })
    ];
  }
  const profileSkills = profileSkillSet(profile);
  for (const row of rows
    .filter(
      (candidate) =>
        candidate.dimension === "missing_requirement" &&
        candidate.metric_key === "promising_job_request_count"
    )
    .sort((left, right) =>
      String(left.segment_key).localeCompare(String(right.segment_key))
    )) {
    const requirement = String(row.segment_label || row.segment_key);
    const normalized = requirement
      .toLowerCase()
      .replace(/[^a-z0-9+#.]+/g, " ")
      .trim();
    if (
      source.policy.missing_requirement_exclusions.some((excluded) =>
        normalized.includes(excluded.toLowerCase())
      ) ||
      profileSkills.has(normalized) ||
      count(row) < source.policy.minimums.promising_requirement_count
    ) {
      continue;
    }
    result.push(
      directional(source, {
        category: "missing_skill",
        affected_type: "missing_requirement",
        affected_key: requirement,
        direction: "investigate_skill_development",
        title: `${requirement} is repeatedly requested by promising jobs and absent from approved profile skills`,
        evidence_metric: "promising_job_request_count",
        numerator: numeric(row.numerator) ?? count(row),
        denominator: numeric(row.denominator) ?? coverage.denominator,
        sample_size: numeric(row.sample_size) ?? coverage.denominator,
        comparison_value: count(row),
        baseline_value: "",
        difference: "",
        coverage_numerator: coverage.numerator,
        coverage_denominator: coverage.denominator,
        coverage_rate: coverage.rate,
        proposed_operator_action:
          `Assess whether ${requirement} fits the target direction and whether to learn it; add it to the profile only after factual evidence exists.`,
        caveat:
          `The requirement was absent from approved profile skills at ${profile.profile_version}; frequency does not establish fit, value, or candidate proficiency.`
      })
    );
  }
  if (result.length === 0) {
    result.push(
      abstention(source, {
        category: "missing_skill",
        affected_type: "missing_requirement",
        affected_key: "all",
        title: "No missing requirement meets the guarded recommendation threshold",
        evidence_metric: "eligible_missing_requirement_count",
        numerator: 0,
        denominator: source.policy.minimums.promising_requirement_count,
        sample_size: coverage.denominator,
        coverage_numerator: coverage.numerator,
        coverage_denominator: coverage.denominator,
        coverage_rate: coverage.rate
      })
    );
  }
  return result;
}

function deduplicateEvidence(rows) {
  const values = new Map();
  for (const row of rows) {
    const key = [
      row.status,
      row.category,
      row.affected_type,
      row.affected_key,
      row.direction
    ].join("\u001f");
    if (!values.has(key)) values.set(key, row);
  }
  return [...values.values()];
}

function finalizeRows(source, rows) {
  return deduplicateEvidence(rows).map((row, index) => {
    const complete = {
      ...row,
      recommendation_id: `${source.run_id}|${String(index + 1).padStart(4, "0")}`
    };
    return Object.fromEntries(
      source.policy.recommendation_fields.map((field) => [
        field,
        complete[field] ?? ""
      ])
    );
  });
}

function reportMetadata(source, rows, status, result, error = {}) {
  const recommendationCount = rows.filter(
    (row) => row.status === DIRECTIONAL_STATUS
  ).length;
  const abstentionCount = rows.filter(
    (row) => row.status === "abstained"
  ).length;
  return {
    run_id: source.run_id,
    analysis_key: source.analysis_key,
    status,
    result,
    recommendation_policy_version: source.policy.policy_version,
    analytics_report_id: source.analytics_report_id,
    metric_definition_version:
      source.analytics?.metric_definition_version || "",
    band_version: source.analytics?.band_version || "",
    generated_at: source.generated_at,
    window_start_at: source.analytics?.window_start_at || "",
    window_end_at: source.analytics?.window_end_at || "",
    minimum_overall_applications:
      source.policy.minimums.overall_applications,
    minimum_segment_applications:
      source.policy.minimums.segment_applications,
    minimum_explicit_outcome_coverage:
      source.policy.minimums.explicit_outcome_coverage,
    recommendation_count: recommendationCount,
    abstention_count: abstentionCount,
    detail_row_count: rows.length,
    error_category: error.category || "",
    error_summary: boundedText(error.summary || "", 300)
  };
}

function createSource(
  policy,
  analytics,
  profile,
  now,
  attemptId,
  { stableRunId = false } = {}
) {
  const analyticsReportId = analytics?.report_id || "no-analytics";
  const analysisKey = `recommendation-${stableSha256(
    [
      analyticsReportId,
      policy.policy_version,
      profile?.profile_version || "unknown"
    ].join("\u001f")
  )}`;
  const attempt = String(attemptId || now)
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 64);
  return {
    policy,
    analytics: analytics || {},
    analytics_report_id: analytics?.report_id || "",
    analysis_key: analysisKey,
    run_id: stableRunId
      ? analysisKey
      : `${analysisKey}-${attempt || now.replace(/[^0-9]/g, "")}`,
    generated_at: now
  };
}

export function buildRecommendationFailure(
  policy,
  profile,
  now,
  {
    attemptId = "",
    analytics,
    category = "processing_failure",
    summary = "Weekly recommendation processing failed."
  } = {}
) {
  const source = createSource(policy, analytics, profile, now, attemptId);
  const failure = abstention(source, {
    category: "run_health",
    affected_type: "weekly_report",
    affected_key: "all",
    title: "Weekly recommendation run failed",
    evidence_metric: "run_failure",
    caveat:
      "The failure is non-authoritative; retain the last complete weekly report."
  });
  const rows = finalizeRows(source, [failure]);
  return {
    rows,
    report: reportMetadata(source, rows, "failed", "failed", {
      category: boundedText(category, 100),
      summary
    })
  };
}

export function buildRecommendationReport(
  analyticsRows,
  analyticsReportRows,
  policy,
  profile,
  now = new Date().toISOString(),
  { attemptId = "" } = {}
) {
  const errors = validateRecommendationPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid recommendation policy:\n- ${errors.join("\n- ")}`);
  }
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error("recommendation report timestamp is invalid");
  }
  const latest = latestCompleteAnalyticsReport(analyticsReportRows);
  const source = createSource(policy, latest, profile, now, attemptId, {
    stableRunId: true
  });
  if (!latest) {
    const emptyInput =
      analyticsRows.length === 0 && analyticsReportRows.length === 0;
    if (!emptyInput) {
      return buildRecommendationFailure(policy, profile, now, {
        attemptId,
        category: "incomplete_analytics_report",
        summary:
          "Analytics input exists, but no valid complete analytics report is available."
      });
    }
    const rows = finalizeRows(source, [
      abstention(source, {
        status: "empty",
        category: "analytics_input",
        affected_type: "analytics_report",
        affected_key: "all",
        title: "No completed analytics input is available",
        evidence_metric: "complete_analytics_report_count",
        numerator: 0,
        denominator: analyticsReportRows.length,
        sample_size: 0,
        caveat:
          "No search, ranking, profile, strategy, application, or Apply Points setting was changed."
      })
    ]);
    return {
      rows,
      report: reportMetadata(source, rows, "complete", "empty")
    };
  }
  if (
    latest.metric_definition_version !==
      policy.required_metric_definition_version ||
    latest.band_version !== policy.required_band_version ||
    latest.window_type !== policy.required_window_type
  ) {
    return buildRecommendationFailure(policy, profile, now, {
      attemptId,
      analytics: latest,
      category: "incompatible_analytics_version",
      summary:
        "The latest complete analytics report does not match the required metric, band, or window version."
    });
  }
  const rowsForReport = analyticsRows.filter(
    (row) => row.report_id === latest.report_id
  );
  if (
    rowsForReport.length !== Number(latest.detail_row_count) ||
    rowsForReport.some(
      (row) =>
        row.metric_definition_version !== latest.metric_definition_version ||
        row.band_version !== latest.band_version
    )
  ) {
    return buildRecommendationFailure(policy, profile, now, {
      attemptId,
      analytics: latest,
      category: "incomplete_analytics_detail",
      summary:
        "The latest complete analytics metadata does not match its persisted detail rows."
    });
  }
  const index = analyticsIndex(rowsForReport);
  const guard = overallGuard(source, index);
  if (guard.applicationCount === 0) {
    const rows = finalizeRows(source, [
      abstention(source, {
        status: "empty",
        category: "overall",
        affected_type: "application_cohort",
        affected_key: "all",
        title: "Completed analytics contains no applications",
        evidence_metric: "application_count",
        numerator: 0,
        denominator: 0,
        sample_size: 0,
        caveat:
          "This is a successful empty weekly report; no policy or profile state was changed."
      })
    ]);
    return {
      rows,
      report: reportMetadata(source, rows, "complete", "empty")
    };
  }
  if (!guard.eligible) {
    const rows = finalizeRows(source, [
      abstention(source, {
        category: "overall",
        affected_type: "application_cohort",
        affected_key: "all",
        title: "Abstain from weekly recommendations: insufficient sample or outcome coverage",
        evidence_metric: "overall_eligibility",
        numerator: guard.applicationCount,
        denominator: source.policy.minimums.overall_applications,
        sample_size: guard.applicationCount,
        comparison_value: guard.outcomeCoverage,
        baseline_value:
          source.policy.minimums.explicit_outcome_coverage,
        coverage_numerator:
          numeric(guard.coverageRow?.coverage_numerator) ??
          numeric(guard.coverageRow?.numerator) ??
          0,
        coverage_denominator:
          numeric(guard.coverageRow?.coverage_denominator) ??
          numeric(guard.coverageRow?.denominator) ??
          guard.applicationCount,
        coverage_rate: guard.outcomeCoverage
      })
    ]);
    return {
      rows,
      report: reportMetadata(source, rows, "complete", "abstained")
    };
  }

  let evidence = [
    ...queryAndRoleRecommendations(source, index, rowsForReport),
    ...calibrationRecommendations(source, index, rowsForReport),
    ...comparisonRecommendations(source, index, rowsForReport),
    ...missingRequirementRecommendations(
      source,
      index,
      rowsForReport,
      profile
    )
  ];
  if (!evidence.some((row) => row.status === DIRECTIONAL_STATUS)) {
    evidence.push(
      abstention(source, {
        category: "overall",
        affected_type: "weekly_report",
        affected_key: "all",
        title: "No eligible cohort produced a directional signal",
        evidence_metric: "directional_recommendation_count",
        numerator: 0,
        denominator: 1,
        sample_size: guard.applicationCount,
        coverage_rate: guard.outcomeCoverage
      })
    );
  }
  const rows = finalizeRows(source, evidence);
  return {
    rows,
    report: reportMetadata(
      source,
      rows,
      "complete",
      rows.some((row) => row.status === DIRECTIONAL_STATUS)
        ? "recommendations"
        : "abstained"
    )
  };
}

export function latestCompleteRecommendationReport(reportRows) {
  return [...reportRows]
    .filter(
      (row) =>
        row?.status === "complete" &&
        row.run_id &&
        Number.isFinite(Date.parse(row.generated_at || ""))
    )
    .sort(
      (left, right) =>
        Date.parse(right.generated_at) - Date.parse(left.generated_at) ||
        String(right.run_id).localeCompare(String(left.run_id))
    )[0];
}

export function reusableRecommendationReport(reportRows, report) {
  if (report?.status !== "complete") return undefined;
  const latest = latestCompleteRecommendationReport(reportRows);
  return latest &&
    latest.run_id === report.run_id &&
    latest.analysis_key === report.analysis_key &&
    latest.result === report.result &&
    latest.recommendation_policy_version ===
      report.recommendation_policy_version &&
    latest.analytics_report_id === report.analytics_report_id &&
    latest.metric_definition_version === report.metric_definition_version &&
    latest.band_version === report.band_version &&
    latest.window_start_at === report.window_start_at &&
    latest.window_end_at === report.window_end_at &&
    Number(latest.minimum_overall_applications) ===
      report.minimum_overall_applications &&
    Number(latest.minimum_segment_applications) ===
      report.minimum_segment_applications &&
    Number(latest.minimum_explicit_outcome_coverage) ===
      report.minimum_explicit_outcome_coverage &&
    Number(latest.recommendation_count) === report.recommendation_count &&
    Number(latest.abstention_count) === report.abstention_count &&
    Number(latest.detail_row_count) === report.detail_row_count &&
    String(latest.error_category || "") === report.error_category &&
    String(latest.error_summary || "") === report.error_summary
    ? latest
    : undefined;
}
