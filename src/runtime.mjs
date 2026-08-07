import { validateMinuteIntervalSchedule } from "./schedules.mjs";

const REQUIRED_TIMEZONE = "Asia/Manila";
const WORKFLOW_ROLES = ["scraper", "generator", "alerter_mover"];
const MINIMUM_GENERATOR_CANDIDATE_PACING_DELAY_MS = 20000;
export const EXPECTED_WORKFLOW_ARTIFACTS = [
  "alerter-mover.json",
  "generator.json",
  "scraper.json"
];

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function validateWorkflowArtifactManifest(files) {
  if (!Array.isArray(files)) {
    return ["workflow artifact manifest must be an array"];
  }
  const actual = [...new Set(files.filter((file) => file.endsWith(".json")))]
    .sort();
  const expected = [...EXPECTED_WORKFLOW_ARTIFACTS].sort();
  const missing = expected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !expected.includes(file));
  const errors = [];
  if (missing.length > 0) {
    errors.push(`missing workflow artifacts: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(`unexpected workflow artifacts: ${unexpected.join(", ")}`);
  }
  return errors;
}

function validateScheduledWorkflow(config, name) {
  const errors = [];
  for (const field of [
    "schedule_minutes",
    "execution_timeout_seconds",
    "claim_lease_ms"
  ]) {
    if (!positiveInteger(config?.[field])) {
      errors.push(`${name}.${field} must be a positive integer`);
    }
  }
  errors.push(...validateMinuteIntervalSchedule(config, name));
  if (
    positiveInteger(config?.execution_timeout_seconds) &&
    positiveInteger(config?.schedule_minutes) &&
    config.execution_timeout_seconds >= config.schedule_minutes * 60
  ) {
    errors.push(`${name} execution timeout must be shorter than its schedule`);
  }
  if (
    positiveInteger(config?.execution_timeout_seconds) &&
    positiveInteger(config?.claim_lease_ms) &&
    config.execution_timeout_seconds * 1000 >= config.claim_lease_ms
  ) {
    errors.push(`${name} claim lease must outlast its execution timeout`);
  }
  return errors;
}

export function validateRuntimeConfig(runtime) {
  const errors = [];
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    return ["runtime configuration must be an object"];
  }
  if (runtime.schema_version !== 2) {
    errors.push("runtime schema_version must be 2");
  }
  if (runtime.timezone !== REQUIRED_TIMEZONE) {
    errors.push(`runtime timezone must be ${REQUIRED_TIMEZONE}`);
  }
  if (
    runtime.execution_data?.save_successful_production_executions !== "none"
  ) {
    errors.push("successful production execution payloads must not be retained");
  }
  if (runtime.execution_data?.save_failed_production_executions !== "all") {
    errors.push("failed production executions must be retained");
  }
  if (runtime.execution_data?.save_execution_progress !== false) {
    errors.push("execution progress retention must be disabled");
  }
  if (runtime.execution_data?.save_manual_executions !== true) {
    errors.push("manual smoke executions must be retained");
  }
  for (const field of ["max_attempts", "backoff_ms"]) {
    if (!positiveInteger(runtime.google_sheets?.read_retry?.[field])) {
      errors.push(`google_sheets.read_retry.${field} must be a positive integer`);
    }
  }
  for (const role of WORKFLOW_ROLES) {
    errors.push(...validateScheduledWorkflow(runtime[role], role));
  }
  if (!positiveInteger(runtime.generator?.per_run_cap)) {
    errors.push("generator.per_run_cap must be a positive integer");
  } else if (runtime.generator.per_run_cap > 5) {
    errors.push("generator.per_run_cap must not exceed 5");
  }
  for (const field of [
    "candidate_pacing_delay_ms",
    "request_retry_backoff_ms",
    "http_timeout_ms"
  ]) {
    if (!positiveInteger(runtime.generator?.[field])) {
      errors.push(`generator.${field} must be a positive integer`);
    }
  }
  if (
    positiveInteger(runtime.generator?.candidate_pacing_delay_ms) &&
    runtime.generator.candidate_pacing_delay_ms <
      MINIMUM_GENERATOR_CANDIDATE_PACING_DELAY_MS
  ) {
    errors.push(
      `generator.candidate_pacing_delay_ms must be at least ${MINIMUM_GENERATOR_CANDIDATE_PACING_DELAY_MS}`
    );
  }
  for (const field of ["max_attempts", "backoff_ms"]) {
    if (!positiveInteger(runtime.generator?.retry?.[field])) {
      errors.push(`generator.retry.${field} must be a positive integer`);
    }
  }
  if (
    positiveInteger(runtime.generator?.http_timeout_ms) &&
    runtime.generator.http_timeout_ms >=
      runtime.generator.execution_timeout_seconds * 1000
  ) {
    errors.push("generator HTTP timeout must be shorter than workflow timeout");
  }
  for (const field of ["movement_per_run_cap", "alert_per_run_cap"]) {
    if (!positiveInteger(runtime.alerter_mover?.[field])) {
      errors.push(`alerter_mover.${field} must be a positive integer`);
    }
  }
  if (
    !positiveInteger(runtime.alerter_mover?.claim_contention_settle_ms) ||
    runtime.alerter_mover.claim_contention_settle_ms >= 65000
  ) {
    errors.push(
      "alerter_mover.claim_contention_settle_ms must be a positive integer below 65000"
    );
  }
  const alerterReadRetry = runtime.alerter_mover?.google_sheets_read_retry;
  if (
    alerterReadRetry?.max_attempts !== 2 ||
    !positiveInteger(alerterReadRetry?.backoff_ms) ||
    !positiveInteger(alerterReadRetry?.quota_window_delay_ms) ||
    alerterReadRetry.backoff_ms !== alerterReadRetry.quota_window_delay_ms ||
    alerterReadRetry.quota_window_delay_ms < 60000
  ) {
    errors.push(
      "alerter_mover initial business snapshot must retry once after a quota-window delay"
    );
  }
  if (
    !positiveInteger(runtime.alerter_mover?.minimum_provider_commit_headroom_ms) ||
    runtime.alerter_mover.minimum_provider_commit_headroom_ms >=
      runtime.alerter_mover.execution_timeout_seconds * 1000
  ) {
    errors.push(
      "alerter_mover provider commit headroom must be positive and fit its timeout"
    );
  }
  const scheduleMinuteSets = WORKFLOW_ROLES.map((role) => ({
    role,
    minutes: new Set(
      Array.from(
        {
          length:
            1440 / runtime[role].schedule_minutes
        },
        (_, index) =>
          runtime[role].schedule_offset_minutes +
          index * runtime[role].schedule_minutes
      )
    )
  }));
  for (let left = 0; left < scheduleMinuteSets.length; left += 1) {
    for (let right = left + 1; right < scheduleMinuteSets.length; right += 1) {
      if (
        [...scheduleMinuteSets[left].minutes].some((minute) =>
          scheduleMinuteSets[right].minutes.has(minute)
        )
      ) {
        errors.push(
          `${scheduleMinuteSets[left].role} and ${scheduleMinuteSets[right].role} schedules must not start together`
        );
      }
    }
  }
  const generatorMinutes = scheduleMinuteSets.find(
    ({ role }) => role === "generator"
  )?.minutes;
  const alerterMinutes = scheduleMinuteSets.find(
    ({ role }) => role === "alerter_mover"
  )?.minutes;
  if (
    generatorMinutes &&
    alerterMinutes &&
    positiveInteger(runtime.generator?.execution_timeout_seconds) &&
    positiveInteger(runtime.alerter_mover?.execution_timeout_seconds)
  ) {
    const dayMinutes = 1440;
    const generatorDuration = Math.ceil(
      runtime.generator.execution_timeout_seconds / 60
    );
    const alerterDuration = Math.ceil(
      runtime.alerter_mover.execution_timeout_seconds / 60
    );
    const overlaps = [...generatorMinutes].some((generatorMinute) =>
      [...alerterMinutes].some((alerterMinute) => {
        const alerterAfterGenerator =
          (alerterMinute - generatorMinute + dayMinutes) % dayMinutes;
        const generatorAfterAlerter =
          (generatorMinute - alerterMinute + dayMinutes) % dayMinutes;
        return (
          alerterAfterGenerator < generatorDuration ||
          generatorAfterAlerter < alerterDuration
        );
      })
    );
    if (overlaps) {
      errors.push(
        "generator and alerter_mover schedules must not overlap at configured timeouts"
      );
    }
  }
  return errors;
}

export function workflowTimezone(runtime) {
  const errors = validateRuntimeConfig(runtime);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  }
  return runtime.timezone;
}

export function workflowExecutionDataSettings(runtime) {
  const errors = validateRuntimeConfig(runtime);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  }
  return {
    saveDataSuccessExecution:
      runtime.execution_data.save_successful_production_executions,
    saveDataErrorExecution:
      runtime.execution_data.save_failed_production_executions,
    saveExecutionProgress: runtime.execution_data.save_execution_progress,
    saveManualExecutions: runtime.execution_data.save_manual_executions
  };
}

export function scheduledRunsPerWeek(runtime) {
  const errors = validateRuntimeConfig(runtime);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  }
  return Object.fromEntries(
    WORKFLOW_ROLES.map((role) => [
      role,
      (7 * 24 * 60) / runtime[role].schedule_minutes
    ])
  );
}
