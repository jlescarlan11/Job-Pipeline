import { validateMinuteIntervalSchedule } from "./schedules.mjs";

const REQUIRED_TIMEZONE = "Asia/Manila";
const WORKFLOW_ROLES = ["scraper", "generator", "alerter_mover"];
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
  if (runtime.generator?.per_run_cap !== 1) {
    errors.push("generator.per_run_cap must be 1");
  }
  for (const field of ["request_retry_backoff_ms", "http_timeout_ms"]) {
    if (!positiveInteger(runtime.generator?.[field])) {
      errors.push(`generator.${field} must be a positive integer`);
    }
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
