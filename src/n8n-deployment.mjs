import {
  validateAnalyticsSchedule,
  validateMinuteIntervalSchedule,
  validateRecommendationSchedule
} from "./schedules.mjs";
import { validateWorkflowCutoverPolicy } from "./workflow-cutover.mjs";

const OFFICIAL_SOURCE_PREFIX = "https://docs.n8n.io/";
const WEEK_MINUTES = 7 * 24 * 60;
const REQUIRED_ENVIRONMENT_KEYS = [
  "GENERIC_TIMEZONE",
  "EXECUTIONS_TIMEOUT",
  "EXECUTIONS_TIMEOUT_MAX",
  "EXECUTIONS_DATA_SAVE_ON_ERROR",
  "EXECUTIONS_DATA_SAVE_ON_SUCCESS",
  "EXECUTIONS_DATA_SAVE_ON_PROGRESS",
  "EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS",
  "EXECUTIONS_DATA_PRUNE",
  "EXECUTIONS_DATA_MAX_AGE",
  "EXECUTIONS_DATA_PRUNE_MAX_COUNT",
  "EXECUTIONS_DATA_HARD_DELETE_BUFFER",
  "N8N_CONCURRENCY_PRODUCTION_LIMIT",
  "N8N_METRICS",
  "N8N_METRICS_INCLUDE_DEFAULT_METRICS",
  "N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL",
  "N8N_METRICS_INCLUDE_QUEUE_METRICS",
  "N8N_RUNNERS_MODE",
  "N8N_RUNNERS_MAX_CONCURRENCY",
  "N8N_RUNNERS_TASK_TIMEOUT",
  "N8N_RUNNERS_TASK_REQUEST_TIMEOUT",
  "N8N_RUNNERS_HEARTBEAT_INTERVAL"
];
const REQUIRED_MONITORING_THRESHOLDS = [
  "readiness_consecutive_failures",
  "failed_executions_in_15_minutes",
  "production_queue_wait_seconds",
  "operational_backlog_event_stale_minutes",
  "oldest_due_generation_minutes",
  "oldest_due_evaluation_minutes",
  "oldest_pending_alert_minutes",
  "oldest_manual_action_minutes",
  "active_claim_past_lease_count",
  "provider_rate_limit_events_in_15_minutes"
];

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function workflowBudgets(configs) {
  return [
    {
      name: "scraper",
      timeout_seconds: configs.searchPlan?.execution_timeout_seconds,
      schedule_seconds: configs.searchPlan?.schedule_hours * 60 * 60
    },
    {
      name: "generator",
      timeout_seconds: configs.runtime?.generator?.execution_timeout_seconds,
      schedule_seconds: configs.runtime?.generator?.schedule_minutes * 60
    },
    {
      name: "alerter",
      timeout_seconds: configs.alertPolicy?.execution_timeout_seconds,
      schedule_seconds: configs.alertPolicy?.schedule_minutes * 60
    },
    {
      name: "reviewer",
      timeout_seconds: configs.review?.execution_timeout_seconds,
      schedule_seconds: configs.review?.schedule_minutes * 60
    },
    {
      name: "archiver",
      timeout_seconds: configs.runtime?.archiver?.execution_timeout_seconds,
      schedule_seconds: configs.runtime?.archiver?.schedule_minutes * 60
    },
    {
      name: "analytics",
      timeout_seconds: configs.analytics?.execution_timeout_seconds,
      schedule_seconds: configs.analytics?.schedule_hours * 60 * 60
    },
    {
      name: "recommender",
      timeout_seconds: configs.recommendations?.execution_timeout_seconds,
      schedule_seconds: configs.recommendations?.schedule_hours * 60 * 60
    }
  ];
}

function intervalSchedule(config, name, timeoutSeconds) {
  const errors = validateMinuteIntervalSchedule(config, name);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return {
    name,
    interval_minutes: config.schedule_minutes,
    offset_minutes: config.schedule_offset_minutes,
    timeout_seconds: timeoutSeconds
  };
}

function workflowScheduleDefinitions(configs) {
  const analyticsErrors = validateAnalyticsSchedule(configs.analytics);
  const recommendationErrors = validateRecommendationSchedule(
    configs.recommendations
  );
  if (analyticsErrors.length > 0 || recommendationErrors.length > 0) {
    throw new Error(
      [...analyticsErrors, ...recommendationErrors].join("; ")
    );
  }
  return [
    intervalSchedule(
      {
        schedule_minutes: configs.searchPlan.schedule_hours * 60,
        schedule_offset_minutes:
          configs.searchPlan.schedule_offset_minutes
      },
      "scraper",
      configs.searchPlan.execution_timeout_seconds
    ),
    intervalSchedule(
      configs.runtime.generator,
      "generator",
      configs.runtime.generator.execution_timeout_seconds
    ),
    intervalSchedule(
      configs.alertPolicy,
      "alerter",
      configs.alertPolicy.execution_timeout_seconds
    ),
    intervalSchedule(
      configs.review,
      "reviewer",
      configs.review.execution_timeout_seconds
    ),
    intervalSchedule(
      configs.runtime.archiver,
      "archiver",
      configs.runtime.archiver.execution_timeout_seconds
    ),
    {
      name: "analytics",
      interval_minutes: 24 * 60,
      offset_minutes:
        configs.analytics.schedule.trigger_at_hour * 60 +
        configs.analytics.schedule.trigger_at_minute,
      timeout_seconds: configs.analytics.execution_timeout_seconds
    },
    {
      name: "recommender",
      interval_minutes: WEEK_MINUTES,
      offset_minutes:
        configs.recommendations.schedule.trigger_at_days[0] * 24 * 60 +
        configs.recommendations.schedule.trigger_at_hour * 60 +
        configs.recommendations.schedule.trigger_at_minute,
      timeout_seconds: configs.recommendations.execution_timeout_seconds
    }
  ];
}

export function scheduledBurstCapacity(configs) {
  const definitions = workflowScheduleDefinitions(configs);
  const events = [];
  let executionId = 0;
  for (const definition of definitions) {
    const intervalSeconds = definition.interval_minutes * 60;
    const offsetSeconds = definition.offset_minutes * 60;
    const lookbackIntervals = Math.max(
      1,
      Math.ceil(definition.timeout_seconds / intervalSeconds)
    );
    for (
      let start =
        offsetSeconds - lookbackIntervals * intervalSeconds;
      start < WEEK_MINUTES * 60;
      start += intervalSeconds
    ) {
      const end = start + definition.timeout_seconds;
      if (end <= 0) continue;
      const id = executionId;
      executionId += 1;
      events.push({
        at: start,
        delta: 1,
        id,
        name: definition.name
      });
      events.push({
        at: end,
        delta: -1,
        id,
        name: definition.name
      });
    }
  }
  events.sort(
    (left, right) =>
      left.at - right.at ||
      left.delta - right.delta ||
      left.id - right.id
  );

  const active = new Map();
  let maximum = 0;
  let peakAtSecond = 0;
  let peakWorkflows = [];
  for (const event of events) {
    if (event.delta < 0) {
      active.delete(event.id);
    } else {
      active.set(event.id, event.name);
      if (
        event.at >= 0 &&
        event.at < WEEK_MINUTES * 60 &&
        active.size > maximum
      ) {
        maximum = active.size;
        peakAtSecond = event.at;
        peakWorkflows = [...active.values()].sort();
      }
    }
  }
  return {
    maximum_simultaneous_scheduled_executions: maximum,
    peak_at_week_second: peakAtSecond,
    peak_workflows: peakWorkflows
  };
}

export function deploymentCapacity(configs) {
  const budgets = workflowBudgets(configs);
  if (
    budgets.some(
      (entry) =>
        !Number.isFinite(entry.timeout_seconds) ||
        entry.timeout_seconds <= 0 ||
        !Number.isFinite(entry.schedule_seconds) ||
        entry.schedule_seconds <= 0
    )
  ) {
    throw new Error("all workflow schedules and timeouts are required");
  }
  const burst = scheduledBurstCapacity(configs);
  return {
    budgets,
    timeout_weighted_concurrency: budgets.reduce(
      (total, entry) =>
        total + entry.timeout_seconds / entry.schedule_seconds,
      0
    ),
    scheduled_executions_per_week: budgets.reduce(
      (total, entry) =>
        total + (7 * 24 * 60 * 60) / entry.schedule_seconds,
      0
    ),
    maximum_workflow_timeout_seconds: Math.max(
      ...budgets.map((entry) => entry.timeout_seconds)
    ),
    ...burst
  };
}

export function validateN8nDeploymentPolicy(policy, configs) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["n8n deployment policy must be an object"];
  }
  errors.push(...validateWorkflowCutoverPolicy(policy));
  if (policy.schema_version !== 1) {
    errors.push("n8n deployment policy schema_version must be 1");
  }
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(policy.policy_version || "")) {
    errors.push("n8n deployment policy_version must use YYYY-MM-DD/vN");
  }
  if (policy.deployment_scope !== "self_hosted_regular") {
    errors.push("deployment_scope must be self_hosted_regular");
  }
  if (!Number.isFinite(Date.parse(`${policy.verified_on || ""}T00:00:00Z`))) {
    errors.push("verified_on must be a calendar date");
  }
  if (
    !Array.isArray(policy.official_sources) ||
    policy.official_sources.length < 5 ||
    policy.official_sources.some(
      (source) =>
        typeof source !== "string" ||
        !source.startsWith(OFFICIAL_SOURCE_PREFIX)
    )
  ) {
    errors.push("official_sources must contain current n8n documentation URLs");
  }

  const environment = policy.environment || {};
  for (const key of REQUIRED_ENVIRONMENT_KEYS) {
    if (typeof environment[key] !== "string" || !environment[key]) {
      errors.push(`deployment environment template is missing ${key}`);
    }
  }
  if (environment.EXECUTIONS_DATA_PRUNE !== "true") {
    errors.push("execution pruning must be enabled");
  }
  if (environment.EXECUTIONS_DATA_SAVE_ON_ERROR !== "all") {
    errors.push("failed production executions must be retained");
  }
  if (environment.EXECUTIONS_DATA_SAVE_ON_SUCCESS !== "none") {
    errors.push("successful production executions must not be retained");
  }
  if (environment.EXECUTIONS_DATA_SAVE_ON_PROGRESS !== "false") {
    errors.push("per-node execution progress must not be retained");
  }
  if (environment.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS !== "true") {
    errors.push("manual smoke executions must be retained");
  }
  if (
    environment.N8N_METRICS !== "true" ||
    environment.N8N_METRICS_INCLUDE_DEFAULT_METRICS !== "true" ||
    environment.N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL !== "true"
  ) {
    errors.push("internal metrics and workflow identity labels must be enabled");
  }
  if (environment.N8N_METRICS_INCLUDE_QUEUE_METRICS !== "false") {
    errors.push("regular-mode policy must not claim scaling queue metrics");
  }

  const taskRunner = policy.task_runner || {};
  const runnerMaximumConcurrency = positiveInteger(
    taskRunner.maximum_concurrency
  );
  const runnerTaskTimeout = positiveInteger(
    taskRunner.task_timeout_seconds
  );
  const runnerTaskRequestTimeout = positiveInteger(
    taskRunner.task_request_timeout_seconds
  );
  const runnerHeartbeatInterval = positiveInteger(
    taskRunner.heartbeat_interval_seconds
  );
  if (
    environment.N8N_RUNNERS_MODE !== "internal" ||
    taskRunner.mode !== "internal"
  ) {
    errors.push(
      "single-host regular-mode task runner must be explicitly configured in internal mode"
    );
  }
  if (
    !runnerMaximumConcurrency ||
    !runnerTaskTimeout ||
    !runnerTaskRequestTimeout ||
    !runnerHeartbeatInterval
  ) {
    errors.push("task-runner bounds must be positive integers");
  } else {
    for (const [key, expected] of [
      ["N8N_RUNNERS_MAX_CONCURRENCY", runnerMaximumConcurrency],
      ["N8N_RUNNERS_TASK_TIMEOUT", runnerTaskTimeout],
      ["N8N_RUNNERS_TASK_REQUEST_TIMEOUT", runnerTaskRequestTimeout],
      ["N8N_RUNNERS_HEARTBEAT_INTERVAL", runnerHeartbeatInterval]
    ]) {
      if (String(expected) !== environment[key]) {
        errors.push(`${key} must match task_runner`);
      }
    }
    if (runnerTaskRequestTimeout >= runnerTaskTimeout) {
      errors.push("task-runner request timeout must be shorter than task timeout");
    }
    if (runnerHeartbeatInterval >= runnerTaskRequestTimeout) {
      errors.push(
        "task-runner heartbeat interval must be shorter than request timeout"
      );
    }
  }
  if (
    typeof taskRunner.deployment_reason !== "string" ||
    !taskRunner.deployment_reason.trim()
  ) {
    errors.push("task-runner deployment reason must be recorded");
  }

  const concurrencyLimit = positiveInteger(
    policy.capacity?.production_concurrency_limit
  );
  const maximumConcurrency = Number(
    policy.capacity?.maximum_timeout_weighted_concurrency
  );
  const utilizationRatio = Number(
    policy.capacity?.maximum_utilization_ratio
  );
  if (!concurrencyLimit) {
    errors.push("production concurrency limit must be a positive integer");
  }
  if (
    concurrencyLimit &&
    runnerMaximumConcurrency !== concurrencyLimit
  ) {
    errors.push(
      "task-runner maximum concurrency must match production concurrency"
    );
  }
  if (
    !Number.isFinite(maximumConcurrency) ||
    maximumConcurrency <= 0 ||
    !Number.isFinite(utilizationRatio) ||
    utilizationRatio <= 0 ||
    utilizationRatio > 1
  ) {
    errors.push("deployment capacity bounds are invalid");
  }
  if (
    String(concurrencyLimit || "") !==
    environment.N8N_CONCURRENCY_PRODUCTION_LIMIT
  ) {
    errors.push("concurrency environment value must match the capacity policy");
  }
  const queueWaitAlertSeconds = positiveInteger(
    policy.capacity?.queue_wait_alert_seconds
  );
  if (!queueWaitAlertSeconds) {
    errors.push("queue wait alert must be a positive number of seconds");
  }
  const maximumScheduledBurst = positiveInteger(
    policy.capacity?.maximum_simultaneous_scheduled_executions
  );
  const minimumScheduledBurstHeadroom = positiveInteger(
    policy.capacity?.minimum_scheduled_burst_headroom
  );
  if (!maximumScheduledBurst || !minimumScheduledBurstHeadroom) {
    errors.push("scheduled burst capacity bounds must be positive integers");
  } else if (
    concurrencyLimit &&
    maximumScheduledBurst + minimumScheduledBurstHeadroom >
      concurrencyLimit
  ) {
    errors.push(
      "scheduled burst policy and headroom exceed production concurrency"
    );
  }

  const retentionAge = positiveInteger(
    policy.execution_retention?.maximum_age_hours
  );
  const retentionCount = positiveInteger(
    policy.execution_retention?.maximum_count
  );
  const hardDeleteBuffer = positiveInteger(
    policy.execution_retention?.hard_delete_buffer_hours
  );
  if (!retentionAge || !retentionCount || !hardDeleteBuffer) {
    errors.push("execution retention bounds must be positive integers");
  } else if (hardDeleteBuffer >= retentionAge) {
    errors.push("hard-delete buffer must be shorter than retention age");
  }
  for (const [key, expected] of [
    ["EXECUTIONS_DATA_MAX_AGE", retentionAge],
    ["EXECUTIONS_DATA_PRUNE_MAX_COUNT", retentionCount],
    ["EXECUTIONS_DATA_HARD_DELETE_BUFFER", hardDeleteBuffer]
  ]) {
    if (String(expected || "") !== environment[key]) {
      errors.push(`${key} must match execution_retention`);
    }
  }

  if (
    policy.monitoring?.metrics_internal_only !== true ||
    policy.monitoring?.readiness_path !== "/healthz/readiness" ||
    policy.monitoring?.metrics_path !== "/metrics"
  ) {
    errors.push("monitoring endpoints must be internal and canonical");
  }
  if (!positiveInteger(policy.monitoring?.poll_seconds)) {
    errors.push("monitoring poll_seconds must be a positive integer");
  }
  const workflowEvents = policy.monitoring?.workflow_events || {};
  if (
    policy.monitoring?.log_ingestion_required !== true ||
    workflowEvents.backlog_event !== "operational_backlog" ||
    workflowEvents.event_timestamp_field !== "timestamp" ||
    workflowEvents.provider_result_commit_pending_field !==
      "state_commit_pending" ||
    workflowEvents.manual_action_age_mode !==
      "first_seen_fingerprint" ||
    workflowEvents.manual_action_absence_resets_age !== true ||
    !Array.isArray(workflowEvents.provider_result_events) ||
    workflowEvents.provider_result_events.length !== 2 ||
    new Set(workflowEvents.provider_result_events).size !== 2 ||
    !workflowEvents.provider_result_events.includes("generator_result") ||
    !workflowEvents.provider_result_events.includes("alert_delivery")
  ) {
    errors.push(
      "monitoring must ingest the canonical backlog and provider-result workflow events"
    );
  }
  const monitoringThresholds = policy.monitoring?.thresholds || {};
  for (const key of REQUIRED_MONITORING_THRESHOLDS) {
    const value = monitoringThresholds[key];
    if (!positiveInteger(value)) {
      errors.push(
        `required monitoring threshold ${key} must be a positive integer`
      );
    }
  }
  if (
    queueWaitAlertSeconds &&
    queueWaitAlertSeconds !== monitoringThresholds.production_queue_wait_seconds
  ) {
    errors.push("capacity and monitoring queue-wait thresholds must match");
  }
  if (
    policy.failure_detection?.mode !==
      "external_metrics_and_saved_failures" ||
    policy.failure_detection?.central_error_workflow_bound !== false
  ) {
    errors.push(
      "portable failure detection must use metrics and saved failures without a fabricated error-workflow binding"
    );
  }

  if (configs) {
    const reviewerScheduleMinutes = positiveInteger(
      configs.review?.schedule_minutes
    );
    const reviewerTimeoutSeconds = positiveInteger(
      configs.review?.execution_timeout_seconds
    );
    if (
      reviewerScheduleMinutes &&
      reviewerTimeoutSeconds &&
      monitoringThresholds.operational_backlog_event_stale_minutes * 60 <
        reviewerScheduleMinutes * 60 + reviewerTimeoutSeconds
    ) {
      errors.push(
        "operational backlog freshness must cover one Reviewer cadence plus its timeout"
      );
    }
    if (
      reviewerScheduleMinutes &&
      monitoringThresholds.oldest_manual_action_minutes <
        reviewerScheduleMinutes * 2
    ) {
      errors.push(
        "manual-action threshold must allow two scheduled Reviewer observations"
      );
    }
    const maximumPriorityWaitMinutes = positiveInteger(
      configs.runtime?.generator?.maximum_priority_wait_minutes
    );
    if (
      maximumPriorityWaitMinutes &&
      (
        monitoringThresholds.oldest_due_generation_minutes !==
          maximumPriorityWaitMinutes ||
        monitoringThresholds.oldest_due_evaluation_minutes !==
          maximumPriorityWaitMinutes
      )
    ) {
      errors.push(
        "Generator evaluation and generation backlog thresholds must match maximum priority wait"
      );
    }
    let capacity;
    try {
      capacity = deploymentCapacity(configs);
    } catch (error) {
      errors.push(error.message);
    }
    if (capacity) {
      const defaultTimeout = positiveInteger(
        environment.EXECUTIONS_TIMEOUT
      );
      const maximumTimeout = positiveInteger(
        environment.EXECUTIONS_TIMEOUT_MAX
      );
      if (
        capacity.timeout_weighted_concurrency >
        maximumConcurrency + Number.EPSILON
      ) {
        errors.push("workflow timeout-weighted concurrency exceeds policy");
      }
      if (
        concurrencyLimit &&
        capacity.timeout_weighted_concurrency >
          concurrencyLimit * utilizationRatio + Number.EPSILON
      ) {
        errors.push("workflow timeout-weighted utilization exceeds policy");
      }
      if (
        maximumScheduledBurst &&
        capacity.maximum_simultaneous_scheduled_executions >
          maximumScheduledBurst
      ) {
        errors.push("simultaneous scheduled execution burst exceeds policy");
      }
      if (
        concurrencyLimit &&
        minimumScheduledBurstHeadroom &&
        concurrencyLimit -
          capacity.maximum_simultaneous_scheduled_executions <
          minimumScheduledBurstHeadroom
      ) {
        errors.push(
          "production concurrency limit lacks scheduled burst headroom"
        );
      }
      if (
        !defaultTimeout ||
        !maximumTimeout ||
        defaultTimeout < capacity.maximum_workflow_timeout_seconds ||
        maximumTimeout < capacity.maximum_workflow_timeout_seconds ||
        defaultTimeout > maximumTimeout
      ) {
        errors.push("instance timeout bounds must cover every workflow timeout");
      }
      const scheduledFailuresAtMaximumAge = Math.ceil(
        capacity.scheduled_executions_per_week * (retentionAge / 168)
      );
      if (
        scheduledFailuresAtMaximumAge !==
        policy.execution_retention?.scheduled_failure_count_at_maximum_age
      ) {
        errors.push("scheduled failure retention calculation has drifted");
      }
      if (retentionCount < scheduledFailuresAtMaximumAge) {
        errors.push(
          "execution count bound cannot retain the full age window during a scheduled failure storm"
        );
      }
      if (environment.GENERIC_TIMEZONE !== configs.runtime?.timezone) {
        errors.push("instance timezone must match workflow runtime timezone");
      }
      const executionData = configs.runtime?.execution_data || {};
      if (
        environment.EXECUTIONS_DATA_SAVE_ON_ERROR !==
          executionData.save_failed_production_executions ||
        environment.EXECUTIONS_DATA_SAVE_ON_SUCCESS !==
          executionData.save_successful_production_executions ||
        environment.EXECUTIONS_DATA_SAVE_ON_PROGRESS !==
          String(executionData.save_execution_progress) ||
        environment.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS !==
          String(executionData.save_manual_executions)
      ) {
        errors.push(
          "instance execution-data defaults must match workflow-level policy"
        );
      }
    }
  }
  return errors;
}

export function validateN8nDeploymentEnvironment(policy, environment) {
  const errors = [];
  for (const [key, expected] of Object.entries(policy?.environment || {})) {
    if (!Object.hasOwn(environment || {}, key)) {
      errors.push(`${key} is missing`);
    } else if (String(environment[key]) !== String(expected)) {
      errors.push(`${key} does not match deployment policy`);
    }
  }
  return errors;
}
