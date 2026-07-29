const DAY_MINUTES = 24 * 60;

function integerInRange(value, minimum, maximum) {
  return (
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function localMinute(schedule) {
  return schedule.trigger_at_hour * 60 + schedule.trigger_at_minute;
}

export function validateAnalyticsSchedule(policy) {
  const schedule = policy?.schedule;
  const errors = [];
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return ["analytics schedule must be an object"];
  }
  if (schedule.field !== "days") {
    errors.push("analytics schedule field must be days");
  }
  if (schedule.days_interval !== 1 || policy.schedule_hours !== 24) {
    errors.push("analytics schedule must run once every 24 hours");
  }
  if (!integerInRange(schedule.trigger_at_hour, 0, 23)) {
    errors.push("analytics trigger_at_hour must be from 0 through 23");
  }
  if (!integerInRange(schedule.trigger_at_minute, 0, 59)) {
    errors.push("analytics trigger_at_minute must be from 0 through 59");
  }
  return errors;
}

export function validateRecommendationSchedule(policy) {
  const schedule = policy?.schedule;
  const errors = [];
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return ["recommendation schedule must be an object"];
  }
  if (schedule.field !== "weeks") {
    errors.push("recommendation schedule field must be weeks");
  }
  if (schedule.weeks_interval !== 1 || policy.schedule_hours !== 168) {
    errors.push("recommendation schedule must run once every 168 hours");
  }
  if (
    !Array.isArray(schedule.trigger_at_days) ||
    schedule.trigger_at_days.length !== 1 ||
    !integerInRange(schedule.trigger_at_days[0], 0, 6)
  ) {
    errors.push(
      "recommendation trigger_at_days must contain one weekday from 0 through 6"
    );
  }
  if (!integerInRange(schedule.trigger_at_hour, 0, 23)) {
    errors.push("recommendation trigger_at_hour must be from 0 through 23");
  }
  if (!integerInRange(schedule.trigger_at_minute, 0, 59)) {
    errors.push("recommendation trigger_at_minute must be from 0 through 59");
  }
  if (
    !Number.isInteger(policy.source_completion_buffer_minutes) ||
    policy.source_completion_buffer_minutes < 1
  ) {
    errors.push(
      "source_completion_buffer_minutes must be a positive integer"
    );
  }
  return errors;
}

export function learningScheduleTiming(analyticsPolicy, recommendationPolicy) {
  const errors = [
    ...validateAnalyticsSchedule(analyticsPolicy),
    ...validateRecommendationSchedule(recommendationPolicy)
  ];
  if (errors.length > 0) {
    throw new Error(`Invalid learning schedule:\n- ${errors.join("\n- ")}`);
  }
  const analyticsStartMinute = localMinute(analyticsPolicy.schedule);
  const analyticsDeadlineMinute =
    analyticsStartMinute +
    Math.ceil(analyticsPolicy.execution_timeout_seconds / 60);
  const recommendationStartMinute = localMinute(
    recommendationPolicy.schedule
  );
  return {
    analytics_start_minute: analyticsStartMinute,
    analytics_deadline_minute: analyticsDeadlineMinute,
    recommendation_start_minute: recommendationStartMinute,
    completion_buffer_minutes:
      recommendationStartMinute - analyticsDeadlineMinute,
    day_minutes: DAY_MINUTES
  };
}

export function validateLearningSchedulePair(
  analyticsPolicy,
  recommendationPolicy
) {
  const errors = [
    ...validateAnalyticsSchedule(analyticsPolicy),
    ...validateRecommendationSchedule(recommendationPolicy)
  ];
  if (errors.length > 0) return errors;
  const timing = learningScheduleTiming(
    analyticsPolicy,
    recommendationPolicy
  );
  if (
    timing.analytics_deadline_minute >= DAY_MINUTES ||
    timing.completion_buffer_minutes <
      recommendationPolicy.source_completion_buffer_minutes
  ) {
    errors.push(
      "recommendation schedule must start after the analytics timeout and completion buffer"
    );
  }
  return errors;
}

export function analyticsScheduleRule(policy) {
  const errors = validateAnalyticsSchedule(policy);
  if (errors.length > 0) {
    throw new Error(`Invalid analytics schedule:\n- ${errors.join("\n- ")}`);
  }
  return {
    field: "days",
    daysInterval: policy.schedule.days_interval,
    triggerAtHour: policy.schedule.trigger_at_hour,
    triggerAtMinute: policy.schedule.trigger_at_minute
  };
}

export function recommendationScheduleRule(analyticsPolicy, policy) {
  const errors = validateLearningSchedulePair(analyticsPolicy, policy);
  if (errors.length > 0) {
    throw new Error(`Invalid learning schedule:\n- ${errors.join("\n- ")}`);
  }
  return {
    field: "weeks",
    weeksInterval: policy.schedule.weeks_interval,
    triggerAtDay: [...policy.schedule.trigger_at_days],
    triggerAtHour: policy.schedule.trigger_at_hour,
    triggerAtMinute: policy.schedule.trigger_at_minute
  };
}
