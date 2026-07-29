import { validateMinuteIntervalSchedule } from "./schedules.mjs";

const REQUIRED_TIMEZONE = "Asia/Manila";

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateScheduledClaimWorkflow(config, name) {
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
  if (runtime.schema_version !== 1) {
    errors.push("runtime schema_version must be 1");
  }
  if (runtime.timezone !== REQUIRED_TIMEZONE) {
    errors.push(`runtime timezone must be ${REQUIRED_TIMEZONE}`);
  }
  if (
    runtime.execution_data?.save_successful_production_executions !== "none"
  ) {
    errors.push(
      "execution_data.save_successful_production_executions must be none"
    );
  }
  if (runtime.execution_data?.save_failed_production_executions !== "all") {
    errors.push(
      "execution_data.save_failed_production_executions must be all"
    );
  }
  if (runtime.execution_data?.save_execution_progress !== false) {
    errors.push("execution_data.save_execution_progress must be false");
  }
  if (runtime.execution_data?.save_manual_executions !== true) {
    errors.push("execution_data.save_manual_executions must be true");
  }
  errors.push(
    ...validateScheduledClaimWorkflow(runtime.generator, "generator"),
    ...validateMinuteIntervalSchedule(runtime.generator, "generator"),
    ...validateScheduledClaimWorkflow(runtime.archiver, "archiver"),
    ...validateMinuteIntervalSchedule(runtime.archiver, "archiver")
  );
  for (const field of [
    "per_run_cap",
    "request_retry_backoff_ms",
    "http_timeout_ms"
  ]) {
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
    positiveInteger(runtime.generator?.execution_timeout_seconds) &&
    runtime.generator.http_timeout_ms >=
      runtime.generator.execution_timeout_seconds * 1000
  ) {
    errors.push(
      "generator HTTP timeout must be shorter than its execution timeout"
    );
  }
  if (
    !Array.isArray(runtime.archiver?.eligible_statuses) ||
    runtime.archiver.eligible_statuses.length === 0 ||
    runtime.archiver.eligible_statuses.some(
      (status, index, all) =>
        typeof status !== "string" ||
        !status ||
        all.indexOf(status) !== index
    )
  ) {
    errors.push("archiver.eligible_statuses must be unique non-empty strings");
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
