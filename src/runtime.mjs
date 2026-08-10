import { validateMinuteIntervalSchedule } from "./schedules.mjs";
import { isDailyApplicationLimitFieldName } from "./contracts.mjs";

const REQUIRED_TIMEZONE = "Asia/Manila";
export const N8N_WORKFLOW_ROLES = ["scraper", "alerter_mover"];
export const SCHEDULED_ROLES = [
  "scraper",
  "browser_executor",
  "alerter_mover"
];
export const EXPECTED_WORKFLOW_ARTIFACTS = [
  "alerter-mover.json",
  "scraper.json"
];

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function unsupportedObjectKeys(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .map((key) => `${path}.${key} is unsupported`);
}

const SCHEDULE_KEYS = [
  "schedule_minutes",
  "schedule_offset_minutes",
  "execution_timeout_seconds",
  "claim_lease_ms"
];

export function dailyApplicationLimitPaths(value, path = "runtime") {
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, nested] of Object.entries(value)) {
    const next = `${path}.${key}`;
    const scalar =
      nested === null || typeof nested === "object" ? "" : String(nested);
    if (isDailyApplicationLimitFieldName(`${next} ${scalar}`)) paths.push(next);
    paths.push(...dailyApplicationLimitPaths(nested, next));
  }
  return paths;
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
  errors.push(
    ...unsupportedObjectKeys(
      runtime,
      [
        "schema_version",
        "timezone",
        "execution_data",
        "google_sheets",
        "scraper",
        "browser_executor",
        "alerter_mover"
      ],
      "runtime"
    ),
    ...unsupportedObjectKeys(
      runtime.execution_data,
      [
        "save_successful_production_executions",
        "save_failed_production_executions",
        "save_execution_progress",
        "save_manual_executions"
      ],
      "runtime.execution_data"
    ),
    ...unsupportedObjectKeys(
      runtime.google_sheets,
      ["read_retry"],
      "runtime.google_sheets"
    ),
    ...unsupportedObjectKeys(
      runtime.google_sheets?.read_retry,
      ["max_attempts", "backoff_ms"],
      "runtime.google_sheets.read_retry"
    ),
    ...unsupportedObjectKeys(runtime.scraper, SCHEDULE_KEYS, "runtime.scraper"),
    ...unsupportedObjectKeys(
      runtime.browser_executor,
      [
        ...SCHEDULE_KEYS,
        "role_type",
        "minimum_attempt_headroom_ms",
        "continuation_mode",
        "project_mode",
        "retry"
      ],
      "runtime.browser_executor"
    ),
    ...unsupportedObjectKeys(
      runtime.browser_executor?.retry,
      ["max_attempts", "backoff_ms"],
      "runtime.browser_executor.retry"
    ),
    ...unsupportedObjectKeys(
      runtime.alerter_mover,
      [
        ...SCHEDULE_KEYS,
        "claim_contention_settle_ms",
        "movement_per_run_cap",
        "alert_per_run_cap",
        "minimum_provider_commit_headroom_ms",
        "google_sheets_read_retry"
      ],
      "runtime.alerter_mover"
    ),
    ...unsupportedObjectKeys(
      runtime.alerter_mover?.google_sheets_read_retry,
      ["max_attempts", "backoff_ms", "quota_window_delay_ms"],
      "runtime.alerter_mover.google_sheets_read_retry"
    )
  );
  if (runtime.schema_version !== 3) {
    errors.push("runtime schema_version must be 3");
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
  for (const role of SCHEDULED_ROLES) {
    errors.push(...validateScheduledWorkflow(runtime[role], role));
  }
  if (runtime.browser_executor?.role_type !== "codex_scheduled_task") {
    errors.push("browser_executor.role_type must be codex_scheduled_task");
  }
  if (runtime.browser_executor?.project_mode !== "local_project_root") {
    errors.push("browser_executor.project_mode must be local_project_root");
  }
  if (
    runtime.browser_executor?.continuation_mode !==
    "technical_headroom_next_schedule"
  ) {
    errors.push(
      "browser_executor.continuation_mode must defer through technical headroom"
    );
  }
  for (const field of ["max_attempts", "backoff_ms"]) {
    if (!positiveInteger(runtime.browser_executor?.retry?.[field])) {
      errors.push(`browser_executor.retry.${field} must be a positive integer`);
    }
  }
  if (
    !positiveInteger(runtime.browser_executor?.minimum_attempt_headroom_ms) ||
    runtime.browser_executor.minimum_attempt_headroom_ms >=
      runtime.browser_executor.execution_timeout_seconds * 1000
  ) {
    errors.push(
      "browser_executor minimum attempt headroom must be positive and fit its timeout"
    );
  }
  for (const path of dailyApplicationLimitPaths(runtime)) {
    errors.push(`${path} is forbidden; runtime has no daily application limit`);
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
  const scheduleMinuteSets = SCHEDULED_ROLES.flatMap((role) => {
    const config = runtime[role];
    if (
      !positiveInteger(config?.schedule_minutes) ||
      !Number.isInteger(config?.schedule_offset_minutes) ||
      1440 % config.schedule_minutes !== 0
    ) {
      return [];
    }
    return [{
      role,
      minutes: new Set(
        Array.from(
          { length: 1440 / config.schedule_minutes },
          (_, index) =>
            config.schedule_offset_minutes + index * config.schedule_minutes
        )
      )
    }];
  });
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
  const browserMinutes = scheduleMinuteSets.find(
    ({ role }) => role === "browser_executor"
  )?.minutes;
  const alerterMinutes = scheduleMinuteSets.find(
    ({ role }) => role === "alerter_mover"
  )?.minutes;
  if (
    browserMinutes &&
    alerterMinutes &&
    positiveInteger(runtime.browser_executor?.execution_timeout_seconds) &&
    positiveInteger(runtime.alerter_mover?.execution_timeout_seconds)
  ) {
    const dayMinutes = 1440;
    const browserDuration = Math.ceil(
      runtime.browser_executor.execution_timeout_seconds / 60
    );
    const alerterDuration = Math.ceil(
      runtime.alerter_mover.execution_timeout_seconds / 60
    );
    const overlaps = [...browserMinutes].some((browserMinute) =>
      [...alerterMinutes].some((alerterMinute) => {
        const alerterAfterBrowser =
          (alerterMinute - browserMinute + dayMinutes) % dayMinutes;
        const browserAfterAlerter =
          (browserMinute - alerterMinute + dayMinutes) % dayMinutes;
        return (
          alerterAfterBrowser < browserDuration ||
          browserAfterAlerter < alerterDuration
        );
      })
    );
    if (overlaps) {
      errors.push(
        "browser_executor and alerter_mover schedules must not overlap at configured timeouts"
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
    SCHEDULED_ROLES.map((role) => [
      role,
      (7 * 24 * 60) / runtime[role].schedule_minutes
    ])
  );
}

export function n8nScheduledRunsPerWeek(runtime) {
  const all = scheduledRunsPerWeek(runtime);
  return Object.fromEntries(
    N8N_WORKFLOW_ROLES.map((role) => [role, all[role]])
  );
}
