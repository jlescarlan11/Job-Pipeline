import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticsScheduleRule,
  learningScheduleTiming,
  recommendationScheduleRule,
  validateAnalyticsSchedule,
  validateLearningSchedulePair,
  validateRecommendationSchedule
} from "../src/schedules.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const analyticsPolicy = await loadJson("../config/analytics-policy.json");
const recommendationPolicy = await loadJson(
  "../config/recommendation-policy.json"
);

test("learning schedules are fixed, valid, and separated by the completion buffer", () => {
  assert.deepEqual(validateAnalyticsSchedule(analyticsPolicy), []);
  assert.deepEqual(
    validateRecommendationSchedule(recommendationPolicy),
    []
  );
  assert.deepEqual(
    validateLearningSchedulePair(analyticsPolicy, recommendationPolicy),
    []
  );
  assert.deepEqual(learningScheduleTiming(
    analyticsPolicy,
    recommendationPolicy
  ), {
    analytics_start_minute: 120,
    analytics_deadline_minute: 150,
    recommendation_start_minute: 165,
    completion_buffer_minutes: 15,
    day_minutes: 1440
  });
  assert.deepEqual(analyticsScheduleRule(analyticsPolicy), {
    field: "days",
    daysInterval: 1,
    triggerAtHour: 2,
    triggerAtMinute: 0
  });
  assert.deepEqual(
    recommendationScheduleRule(analyticsPolicy, recommendationPolicy),
    {
      field: "weeks",
      weeksInterval: 1,
      triggerAtDay: [1],
      triggerAtHour: 2,
      triggerAtMinute: 45
    }
  );
});

test("learning schedules reject malformed rules and insufficient separation", () => {
  const malformedAnalytics = structuredClone(analyticsPolicy);
  malformedAnalytics.schedule.field = "hours";
  malformedAnalytics.schedule.trigger_at_hour = 24;
  assert.match(
    validateAnalyticsSchedule(malformedAnalytics).join("\n"),
    /field must be days[\s\S]*trigger_at_hour/
  );

  const malformedRecommendation = structuredClone(recommendationPolicy);
  malformedRecommendation.schedule.trigger_at_days = [7];
  assert.match(
    validateRecommendationSchedule(malformedRecommendation).join("\n"),
    /weekday from 0 through 6/
  );

  const earlyRecommendation = structuredClone(recommendationPolicy);
  earlyRecommendation.schedule.trigger_at_minute = 44;
  assert.match(
    validateLearningSchedulePair(
      analyticsPolicy,
      earlyRecommendation
    ).join("\n"),
    /after the analytics timeout and completion buffer/
  );

  const largerBuffer = structuredClone(recommendationPolicy);
  largerBuffer.source_completion_buffer_minutes = 16;
  assert.match(
    validateLearningSchedulePair(analyticsPolicy, largerBuffer).join("\n"),
    /after the analytics timeout and completion buffer/
  );
});
