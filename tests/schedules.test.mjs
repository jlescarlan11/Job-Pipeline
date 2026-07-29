import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticsScheduleRule,
  learningScheduleTiming,
  minuteIntervalExecutionMinutes,
  minuteIntervalScheduleRules,
  recommendationScheduleRule,
  validateAnalyticsSchedule,
  validateLearningSchedulePair,
  validateMinuteIntervalSchedule,
  validateRecommendationSchedule
} from "../src/schedules.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const analyticsPolicy = await loadJson("../config/analytics-policy.json");
const recommendationPolicy = await loadJson(
  "../config/recommendation-policy.json"
);
const runtime = await loadJson("../config/runtime.json");
const searchPlan = await loadJson("../config/search-plan.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const review = await loadJson("../config/review-sheet.json");

const intervalSchedules = {
  scraper: {
    schedule_minutes: searchPlan.schedule_hours * 60,
    schedule_offset_minutes: searchPlan.schedule_offset_minutes
  },
  generator: runtime.generator,
  alerter: alertPolicy,
  reviewer: review,
  archiver: runtime.archiver
};

test("minute interval schedules preserve exact cadence with fixed Manila phases", () => {
  for (const [name, config] of Object.entries(intervalSchedules)) {
    assert.deepEqual(validateMinuteIntervalSchedule(config, name), []);
    const minutes = minuteIntervalExecutionMinutes(config, name);
    assert.equal(minutes.length, 1440 / config.schedule_minutes);
    const wrapped = [...minutes, minutes[0] + 1440];
    assert.ok(
      wrapped
        .slice(1)
        .every(
          (minute, index) =>
            minute - wrapped[index] === config.schedule_minutes
        ),
      `${name} must preserve its interval across the midnight boundary`
    );
  }

  assert.deepEqual(minuteIntervalScheduleRules(
    intervalSchedules.scraper,
    "scraper"
  ), [
    {
      field: "cronExpression",
      expression: "0 8 1,5,9,13,17,21 * * *"
    }
  ]);
  assert.deepEqual(minuteIntervalScheduleRules(
    intervalSchedules.generator,
    "generator"
  ), [
    {
      field: "cronExpression",
      expression: "0 1 0,3,6,9,12,15,18,21 * * *"
    },
    {
      field: "cronExpression",
      expression: "0 31 1,4,7,10,13,16,19,22 * * *"
    }
  ]);
  assert.deepEqual(minuteIntervalScheduleRules(
    intervalSchedules.archiver,
    "archiver"
  ), [
    {
      field: "cronExpression",
      expression: "0 19 0,3,6,9,12,15,18,21 * * *"
    },
    {
      field: "cronExpression",
      expression: "0 4,49 1,4,7,10,13,16,19,22 * * *"
    },
    {
      field: "cronExpression",
      expression: "0 34 2,5,8,11,14,17,20,23 * * *"
    }
  ]);
});

test("minute interval schedules reject unsafe cron-step assumptions", () => {
  assert.match(
    validateMinuteIntervalSchedule(
      { schedule_minutes: 90, schedule_offset_minutes: 90 },
      "generator"
    ).join("\n"),
    /schedule_offset_minutes/
  );
  assert.match(
    validateMinuteIntervalSchedule(
      { schedule_minutes: 50, schedule_offset_minutes: 0 },
      "non-divisor"
    ).join("\n"),
    /positive divisor/
  );
});

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
