import {
  normalizeCanonicalUrl,
  parseHttpUrl,
  stateGuard,
  validateRecordStoreContract
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";
import {
  destinationWrites,
  planOutcomeUpdates,
  planQueueActions
} from "./movement.mjs";

function sanitize(value, maximum = 240) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, "authorization=[redacted]")
    .replace(/(?:api[-_ ]?key|token|secret|webhook)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function slackEscape(value) {
  return sanitize(value, 1000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function listSummary(value, policy, fallback = "None") {
  const items = Array.isArray(value) ? value : [];
  const text = items
    .slice(0, 6)
    .map((item) =>
      sanitize(
        typeof item === "object"
          ? item.summary || item.text || item.requirement || JSON.stringify(item)
          : item,
        policy.summary_item_characters
      )
    )
    .filter(Boolean)
    .join("; ");
  return text || fallback;
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function alertIdempotencyKey(record, policy) {
  const category = alertCategory(record, policy) || "ineligible";
  const preparationIdentity = [
    Number(record.preparation_version || 0),
    String(record.preparation_input_guard || "")
  ].join(":");
  return [
    "slack",
    record.canonical_job_id,
    policy.policy_version,
    category,
    preparationIdentity,
    category === "copy_ready" ? record.generated_at : "",
    category === "copy_ready"
      ? stableHash(String(record.generated_message || ""))
      : stableHash(String(record.required_input || ""))
  ].join(":");
}

export function alertCategory(record, policy) {
  if (
    record?.pipeline_status !== "ready_to_apply" ||
    record?.user_action
  ) return "";
  if (record.prep_status === "message_ready") return "copy_ready";
  if (
    policy?.preparation_reminders?.enabled === true &&
    policy.preparation_reminders.statuses?.includes(record.prep_status)
  ) {
    return `${record.prep_status}_reminder`;
  }
  return "";
}

export function validateAlertPolicy(policy) {
  const errors = [];
  if (policy?.schema_version !== 3) {
    errors.push("alert policy schema_version must be 3");
  }
  if (policy?.channel !== "slack") errors.push("alert channel must be slack");
  for (const field of [
    "schedule_minutes",
    "execution_timeout_seconds",
    "claim_lease_ms",
    "provider_timeout_ms",
    "provider_request_interval_ms",
    "per_run_cap",
    "maximum_message_characters",
    "maximum_action_url_characters",
    "summary_item_characters"
  ]) {
    if (!Number.isInteger(policy?.[field]) || policy[field] < 1) {
      errors.push(`${field} must be a positive integer`);
    }
  }
  if (
    Number.isInteger(policy?.execution_timeout_seconds) &&
    policy.execution_timeout_seconds >= policy.schedule_minutes * 60
  ) {
    errors.push("alert timeout must be shorter than its schedule");
  }
  if (
    Number.isInteger(policy?.provider_timeout_ms) &&
    policy.provider_timeout_ms >= policy.execution_timeout_seconds * 1000
  ) {
    errors.push("Slack timeout must be shorter than workflow timeout");
  }
  if (
    Number.isInteger(policy?.per_run_cap) &&
    Number.isInteger(policy?.provider_timeout_ms) &&
    Number.isInteger(policy?.provider_request_interval_ms) &&
    Number.isInteger(policy?.execution_timeout_seconds) &&
    policy.per_run_cap * policy.provider_timeout_ms +
      Math.max(0, policy.per_run_cap - 1) *
        policy.provider_request_interval_ms >=
      policy.execution_timeout_seconds * 1000
  ) {
    errors.push("serial Slack provider budget must fit workflow timeout");
  }
  if (
    Number.isInteger(policy?.claim_lease_ms) &&
    policy.claim_lease_ms <= policy.execution_timeout_seconds * 1000
  ) {
    errors.push("alert claim lease must outlast workflow timeout");
  }
  if (
    !Number.isInteger(policy?.retry?.max_attempts) ||
    policy.retry.max_attempts < 1 ||
    !Number.isInteger(policy?.retry?.backoff_ms) ||
    policy.retry.backoff_ms < policy.claim_lease_ms
  ) {
    errors.push("alert retry must be bounded and begin after claim expiry");
  }
  if (policy?.retry?.ambiguous_timeout_terminal !== true) {
    errors.push("ambiguous Slack timeouts must be terminal");
  }
  if (
    policy?.eligibility?.pipeline_status !== "ready_to_apply" ||
    policy?.eligibility?.required_prep_status !== "message_ready" ||
    policy?.eligibility?.required_pack_status !== "ready" ||
    policy?.eligibility?.required_message_status !== "valid"
  ) {
    errors.push("alert eligibility must require a fully ready application");
  }
  if (
    policy?.preparation_reminders?.enabled !== true ||
    JSON.stringify(policy?.preparation_reminders?.statuses) !==
      JSON.stringify(["needs_input", "external_steps"]) ||
    !Number.isInteger(
      policy?.preparation_reminders?.maximum_checklist_characters
    ) ||
    policy.preparation_reminders.maximum_checklist_characters < 1 ||
    policy.preparation_reminders.maximum_checklist_characters > 4000
  ) {
    errors.push("preparation reminders must be bounded to the supported states");
  }
  for (const field of ["provider_webhook_url", "review_url"]) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(policy?.environment?.[field] || "")) {
      errors.push(`${field} must name an environment variable`);
    }
  }
  return errors;
}

export function validateAlertRuntimeCapacity(policy, runtimeConfig) {
  const errors = [];
  const retry = runtimeConfig?.google_sheets_read_retry;
  const serialProviderBudget =
    Number(policy?.per_run_cap || 0) * Number(policy?.provider_timeout_ms || 0) +
    Math.max(0, Number(policy?.per_run_cap || 0) - 1) *
      Number(policy?.provider_request_interval_ms || 0);
  const requiredHeadroom =
    serialProviderBudget + Number(retry?.quota_window_delay_ms || 0) + 20000;
  if (
    runtimeConfig?.minimum_provider_commit_headroom_ms < requiredHeadroom
  ) {
    errors.push(
      "provider commit headroom must fit the bounded provider phase and persistence"
    );
  }
  if (
    runtimeConfig?.execution_timeout_seconds !== policy?.execution_timeout_seconds ||
    runtimeConfig?.claim_lease_ms !== policy?.claim_lease_ms ||
    runtimeConfig?.schedule_minutes !== policy?.schedule_minutes ||
    runtimeConfig?.schedule_offset_minutes !== policy?.schedule_offset_minutes ||
    runtimeConfig?.alert_per_run_cap !== policy?.per_run_cap
  ) {
    errors.push("alert runtime bounds must match the alert policy");
  }
  return errors;
}

function retryDue(record, policy, nowMs, expectedKey) {
  if (record.alert_status === "sending") {
    return false;
  }
  if (record.alert_idempotency_key !== expectedKey) return true;
  const retryAt = Date.parse(record.alert_next_retry_at || "");
  return !record.alert_next_retry_at || !Number.isFinite(retryAt) || retryAt <= nowMs;
}

export function preselectPersistedAlertCandidates(
  rows,
  schema,
  policy,
  now = new Date().toISOString()
) {
  if (!Array.isArray(rows)) {
    throw new Error("Persisted alert preselection requires To Apply rows");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Persisted alert preselection requires a valid timestamp");
  }
  const candidates = [];
  const rejected = [];
  const identities = new Set();
  for (const record of rows) {
    const errors = validateRecordStoreContract(record, "To Apply", schema);
    if (errors.length > 0) {
      rejected.push({
        canonical_job_id: String(record?.canonical_job_id || ""),
        reason: "invalid_record"
      });
      continue;
    }
    const identity = String(record.canonical_job_id)
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    if (identities.has(identity)) {
      throw new Error("Alert preselection rejected ambiguous To Apply identity");
    }
    identities.add(identity);

    if (record.alert_status === "sending") {
      const attemptedAt = Date.parse(record.alert_last_attempt_at || "");
      if (
        !Number.isFinite(attemptedAt) ||
        nowMs - attemptedAt >= policy.claim_lease_ms
      ) {
        candidates.push(record);
      }
      continue;
    }

    const category = alertCategory(record, policy);
    const expectedKey = alertIdempotencyKey(record, policy);
    if (
      !category ||
      (record.alert_status === "sent" &&
        record.alert_idempotency_key === expectedKey) ||
      (["terminal_failure", "suppressed"].includes(record.alert_status) &&
        record.alert_idempotency_key === expectedKey) ||
      !retryDue(record, policy, nowMs, expectedKey)
    ) {
      continue;
    }
    candidates.push(record);
  }
  return { candidates, rejected };
}

function countSnapshot(stores, schema) {
  const storeCounts = {};
  const statusCounts = {};
  const preparationStatusCounts = {};
  for (const store of schema.business_stores) {
    const rows = stores[store];
    storeCounts[store] = rows.length;
    statusCounts[store] = {};
    for (const row of rows) {
      const status = String(row.pipeline_status || "unknown");
      statusCounts[store][status] =
        Number(statusCounts[store][status] || 0) + 1;
      const preparationStatus = String(row.prep_status || "");
      if (preparationStatus) {
        preparationStatusCounts[preparationStatus] =
          Number(preparationStatusCounts[preparationStatus] || 0) + 1;
      }
    }
  }
  return {
    store_counts: storeCounts,
    status_counts: statusCounts,
    preparation_status_counts: preparationStatusCounts
  };
}

function assertRecoverableBusinessOwnership(stores, schema, movement) {
  const owners = new Map();
  for (const store of schema.business_stores) {
    for (const row of stores[store]) {
      const identity = String(row?.canonical_job_id || "")
        .trim()
        .normalize("NFKC")
        .toLocaleLowerCase("en-US");
      if (!identity) continue;
      const list = owners.get(identity) || [];
      list.push(store);
      owners.set(identity, list);
    }
  }
  for (const [identity, storesForIdentity] of owners) {
    if (storesForIdentity.length < 2) continue;
    const uniqueStores = [...new Set(storesForIdentity)];
    const recoverable =
      storesForIdentity.length === 2 &&
      uniqueStores.length === 2 &&
      movement.moves.some(
        (move) =>
          String(move.canonical_job_id || "")
            .trim()
            .normalize("NFKC")
            .toLocaleLowerCase("en-US") === identity &&
          move.recovery_required === true &&
          uniqueStores.includes(move.source_sheet) &&
          uniqueStores.includes(move.destination)
      );
    if (!recoverable) {
      throw new Error(
        `Alerter & Mover rejected ambiguous business ownership for ${sanitize(identity, 120)}`
      );
    }
  }
}

export function planAlerterMoverPhases(
  stores,
  schema,
  policy,
  now = new Date().toISOString(),
  movementOptions
) {
  // A destination copy may legitimately coexist with its source when the
  // prior delete failed. Queue planning recognizes that recoverable pair,
  // rejects identities in unrelated stores, and keeps the normal
  // copy-confirm-delete verification boundary intact.
  const movement = planQueueActions(
    stores,
    schema,
    now,
    undefined,
    movementOptions
  );
  assertRecoverableBusinessOwnership(stores, schema, movement);
  const outcome = planOutcomeUpdates(stores["Applied Jobs"], schema, now);
  const potentialAlerts = preselectPersistedAlertCandidates(
    stores["To Apply"],
    schema,
    policy,
    now
  );
  const touched = new Set();
  for (const plan of movement.moves) {
    touched.add(plan.source_sheet);
    touched.add(plan.destination);
  }
  const touchedSheets = schema.business_stores.filter((store) =>
    touched.has(store)
  );
  const counts = countSnapshot(stores, schema);
  const hasMovementWork = movement.moves.length > 0;
  const hasPotentialAlerts = potentialAlerts.candidates.length > 0;
  const hasOutcomeWork = outcome.updates.length > 0;
  return {
    movement,
    outcome,
    potential_alerts: potentialAlerts,
    touched_sheets: touchedSheets,
    has_movement_work: hasMovementWork,
    has_potential_alerts: hasPotentialAlerts,
    has_outcome_work: hasOutcomeWork,
    has_work: hasMovementWork || hasPotentialAlerts || hasOutcomeWork,
    execution_classification:
      hasMovementWork || hasPotentialAlerts || hasOutcomeWork
        ? "eligible_work"
        : "no_eligible_work",
    ...counts
  };
}

export function summarizeAlerterMoverRun({
  plan,
  sheetReadRequests = 0,
  quotaRetries = 0,
  alerts = {},
  errorCategories = [],
  providerClassifications = []
}) {
  const movementCount = Number(plan?.movement?.moves?.length || 0);
  const outcomeCount = Number(plan?.outcome?.updates?.length || 0);
  const selected = Number(alerts.selected || 0);
  const delivered = Number(alerts.delivered || 0);
  const reconciled = Number(alerts.reconciled || 0);
  const retryable = Number(alerts.retryable || 0);
  const terminal = Number(alerts.terminal || 0);
  const copyReadyAlerts = Number(alerts.copy_ready || 0);
  const preparationReminders = Number(alerts.preparation_reminders || 0);
  const routes = (plan?.movement?.moves || []).map((move) => move.route_reason);
  const rejections = plan?.movement?.rejected || [];
  const hasErrors = errorCategories.length > 0;
  const classification = hasErrors
    ? "completed_with_errors"
    : movementCount + outcomeCount + selected + reconciled > 0
      ? "completed_with_work"
      : "no_eligible_work";
  return {
    execution_classification: classification,
    store_counts: plan?.store_counts || {},
    status_counts: plan?.status_counts || {},
    preparation_status_counts: plan?.preparation_status_counts || {},
    movement_count: movementCount,
    movement: {
      proceeded: routes.filter((value) => value === "review_proceeded").length,
      rejected: routes.filter((value) => value === "review_rejected").length,
      applied: routes.filter((value) => value === "user_applied").length,
      skipped: routes.filter((value) =>
        ["user_skip", "automatic_skip"].includes(value)
      ).length,
      repeated_case_suppressions: rejections.filter((entry) =>
        [
          "resolved_review_case_repeated",
          "review_reopen_missing_new_case",
          "review_reopen_missing_reason"
        ].includes(entry.reason)
      ).length,
      partial_recoveries: (plan?.movement?.moves || []).filter(
        (move) => move.recovery_required === true
      ).length,
      failures: rejections.filter(
        (entry) => entry.reason !== "movement_cap_reached"
      ).length
    },
    outcome_update_count: outcomeCount,
    alerts: {
      selected,
      delivered,
      reconciled,
      retryable,
      terminal,
      copy_ready: copyReadyAlerts,
      preparation_reminders: preparationReminders
    },
    provider_classifications: [...new Set(
      providerClassifications.map((value) => sanitize(value, 80))
    )].filter(Boolean),
    sheet_read_request_count: Number(sheetReadRequests || 0),
    quota_retry_count: Number(quotaRetries || 0),
    error_categories: [...new Set(errorCategories.map((value) => sanitize(value, 80)))]
      .filter(Boolean)
      .slice(0, 20)
  };
}

export function evaluateProviderCommitHeadroom({
  executionStartedAt,
  now = new Date().toISOString(),
  executionTimeoutSeconds,
  minimumHeadroomMs
}) {
  const startedMs = Date.parse(executionStartedAt || "");
  const nowMs = Date.parse(now || "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || nowMs < startedMs) {
    throw new Error("Provider headroom requires ordered ISO timestamps");
  }
  if (
    !Number.isInteger(executionTimeoutSeconds) ||
    executionTimeoutSeconds < 1 ||
    !Number.isInteger(minimumHeadroomMs) ||
    minimumHeadroomMs < 1
  ) {
    throw new Error("Provider headroom requires positive integer runtime bounds");
  }
  const deadlineMs = startedMs + executionTimeoutSeconds * 1000;
  const remainingMs = Math.max(0, deadlineMs - nowMs);
  return {
    eligible: remainingMs >= minimumHeadroomMs,
    remaining_ms: remainingMs,
    required_ms: minimumHeadroomMs,
    deadline_at: new Date(deadlineMs).toISOString(),
    classification:
      remainingMs >= minimumHeadroomMs
        ? "provider_headroom_available"
        : "insufficient_provider_headroom"
  };
}

export function evaluateAlertEligibility(
  record,
  policy,
  now,
  messageSafetyContext
) {
  const reasons = [];
  if (record.pipeline_status !== "ready_to_apply") reasons.push("status_not_ready");
  if (record.user_action) reasons.push("operator_action_pending");
  const category = alertCategory(record, policy);
  if (!category) reasons.push("preparation_not_alertable");
  if (category === "copy_ready") {
    if (record.prep_status !== "message_ready") {
      reasons.push("preparation_not_message_ready");
    }
    if (record.application_pack_status !== "ready") reasons.push("pack_not_ready");
    if (record.message_validation_status !== "valid") reasons.push("message_not_valid");
    const safety = evaluatePersistedMessageSafety(record, messageSafetyContext);
    if (!safety.safe) reasons.push(...safety.reasons);
  } else if (category) {
    const checklist = String(record.required_input || "");
    const maximum = Number(
      policy?.preparation_reminders?.maximum_checklist_characters || 0
    );
    if (!checklist.trim()) reasons.push("reminder_checklist_missing");
    if (!maximum || checklist.length > maximum) {
      reasons.push("reminder_checklist_oversized");
    }
    if (
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(
        checklist
      )
    ) reasons.push("reminder_checklist_unsafe");
  }
  const expectedKey = alertIdempotencyKey(record, policy);
  if (
    record.alert_status === "sent" &&
    record.alert_idempotency_key === expectedKey
  ) {
    reasons.push("already_sent");
  }
  if (
    ["terminal_failure", "suppressed"].includes(record.alert_status) &&
    record.alert_idempotency_key === expectedKey
  ) {
    reasons.push("alert_terminal");
  }
  if (!retryDue(record, policy, Date.parse(now), expectedKey)) {
    reasons.push("retry_not_due");
  }
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    idempotency_key: expectedKey,
    category
  };
}

export function selectFreshAlertCandidates(
  freshToApplyRows,
  schema,
  policy,
  now,
  messageSafetyContext
) {
  const candidates = [];
  const rejected = [];
  const stateUpdates = [];
  const identities = new Set();
  for (const record of freshToApplyRows) {
    const contractErrors = validateRecordStoreContract(
      record,
      "To Apply",
      schema
    );
    if (contractErrors.length > 0) {
      rejected.push({
        canonical_job_id: String(record?.canonical_job_id || ""),
        reasons: ["invalid_record"]
      });
      continue;
    }
    if (record.state_guard !== stateGuard(record)) {
      rejected.push({
        canonical_job_id: String(record?.canonical_job_id || ""),
        reasons: ["stale_state_guard"]
      });
      continue;
    }
    const identity = String(record.canonical_job_id)
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    if (identities.has(identity)) {
      throw new Error("Alert selection rejected ambiguous duplicate To Apply identity");
    }
    identities.add(identity);
    if (record.alert_status === "sending") {
      const attemptedAt = Date.parse(record.alert_last_attempt_at || "");
      const expired =
        !Number.isFinite(attemptedAt) ||
        Date.parse(now) - attemptedAt >= policy.claim_lease_ms;
      if (expired) {
        const updated = {
          ...record,
          alert_status: "terminal_failure",
          alert_claim_token: "",
          alert_next_retry_at: "",
          alert_error_category: "ambiguous_delivery",
          alert_error_summary:
            "A prior Slack send did not reach a confirmed commit; delivery is ambiguous and will not be replayed.",
          record_version: record.record_version + 1,
          updated_at: now
        };
        updated.state_guard = stateGuard(updated);
        stateUpdates.push(updated);
        rejected.push({
          canonical_job_id: record.canonical_job_id,
          reasons: ["ambiguous_delivery"]
        });
        continue;
      }
    }
    const eligibility = evaluateAlertEligibility(
      record,
      policy,
      now,
      messageSafetyContext
    );
    if (eligibility.eligible) {
      candidates.push({ record, ...eligibility });
    } else if (record.pipeline_status === "ready_to_apply") {
      rejected.push({
        canonical_job_id: record.canonical_job_id,
        reasons: eligibility.reasons
      });
    }
  }
  candidates.sort(
    (left, right) =>
      Date.parse(
        left.record.preparation_updated_at ||
          left.record.generated_at ||
          left.record.created_at ||
          ""
      ) -
        Date.parse(
          right.record.preparation_updated_at ||
            right.record.generated_at ||
            right.record.created_at ||
            ""
        ) ||
      left.record.canonical_job_id.localeCompare(right.record.canonical_job_id)
  );
  return {
    candidates: candidates.slice(0, policy.per_run_cap),
    rejected,
    state_updates: stateUpdates
  };
}

export function markAlertSending(
  record,
  policy,
  executionId,
  now = new Date().toISOString()
) {
  const idempotencyKey = alertIdempotencyKey(record, policy);
  const sameAttemptSeries = record.alert_idempotency_key === idempotencyKey;
  const marked = {
    ...record,
    alert_status: "sending",
    alert_idempotency_key: idempotencyKey,
    alert_attempt_count:
      (sameAttemptSeries ? Number(record.alert_attempt_count || 0) : 0) + 1,
    alert_last_attempt_at: now,
    alert_next_retry_at: "",
    alert_error_category: "",
    alert_error_summary: "",
    alert_provider_reference: "",
    alert_claim_token: `${sanitize(executionId, 120)}:alert:${stableHash(
      `${record.canonical_job_id}:${idempotencyKey}`
    )}`,
    record_version: record.record_version + 1,
    updated_at: now
  };
  marked.state_guard = stateGuard(marked);
  return marked;
}

function safeHttpsUrl(value, maximum) {
  const parsed = parseHttpUrl(value);
  if (
    parsed?.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.href.length > maximum
  ) {
    return "";
  }
  return parsed.href;
}

export function renderSlackAlert(
  record,
  policy,
  { reviewUrl, messageSafetyContext }
) {
  const eligibility = evaluateAlertEligibility(
    { ...record, alert_status: "", alert_idempotency_key: "" },
    policy,
    record.alert_last_attempt_at || new Date().toISOString(),
    messageSafetyContext
  );
  if (!eligibility.eligible) {
    throw new Error(`Slack alert rejected unsafe record: ${eligibility.reasons.join(",")}`);
  }
  const message = String(record.generated_message || "");
  if (
    message.includes("```") ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/u.test(
      message
    )
  ) {
    throw new Error("Slack alert rejected unsafe message framing");
  }
  const sourceUrl = safeHttpsUrl(
    normalizeCanonicalUrl(record.canonical_url),
    policy.maximum_action_url_characters
  );
  const safeReviewUrl = safeHttpsUrl(
    reviewUrl,
    policy.maximum_action_url_characters
  );
  const links = [
    safeReviewUrl
      ? `<${safeReviewUrl}|Open To Apply>`
      : "To Apply: unavailable",
    sourceUrl
      ? `<${sourceUrl}|Open OnlineJobs.ph>`
      : "Source: unavailable"
  ].join(" · ");
  if (eligibility.category !== "copy_ready") {
    const external = eligibility.category === "external_steps_reminder";
    const title = external
      ? "*External application steps — not submitted:*"
      : "*Candidate input needed — preparation paused:*";
    const checklist = slackEscape(record.required_input);
    const text = [
      title,
      `Role: ${slackEscape(record.job_title) || "Untitled role"}`,
      `Checklist: ${checklist}`,
      external
        ? "These steps must be completed by you outside the pipeline. No application was submitted."
        : "Provide the requested facts through the supported preparation update path. No application was submitted.",
      links
    ].join("\n");
    if (text.length > policy.maximum_message_characters) {
      throw new Error("Slack preparation reminder exceeds configured length");
    }
    return {
      channel: "slack",
      category: eligibility.category,
      preparation_version: record.preparation_version,
      preparation_input_guard: record.preparation_input_guard,
      idempotency_key: eligibility.idempotency_key,
      text,
      review_action: { mode: "open_only", url: safeReviewUrl },
      source_action: { mode: "open_only", url: sourceUrl }
    };
  }
  const context = [
    `*Ready to apply:* ${slackEscape(record.job_title) || "Untitled role"}`,
    `Company: ${slackEscape(record.company) || "Unknown"} · Salary: ${slackEscape(record.salary_text) || "Unknown"}`,
    `Qualification: ${record.qualification_score || "Unknown"}/100 · Opportunity: ${record.opportunity_score || "Unknown"}/100 · Confidence: ${slackEscape(record.ranking_confidence) || "Unknown"}`,
    `Why: ${slackEscape(record.decision_reason) || "Validated match"}`,
    `Gaps: ${slackEscape(listSummary(record.requirement_gaps, policy))}`,
    `Instructions: ${slackEscape(listSummary(record.application_instructions, policy))}`,
    `Questions: ${slackEscape(listSummary(record.screening_questions, policy))}`,
    `Proofs: ${slackEscape(listSummary(record.selected_proof_refs, policy))}`,
    `Warnings: ${slackEscape(listSummary(record.application_warnings, policy))}`
  ].join("\n");
  const applicationBlock =
    `*Application message — copy exactly:*\n\`\`\`${message}\`\`\``;
  const text = `${context}\n${applicationBlock}\n${links}`;
  if (text.length > policy.maximum_message_characters) {
    throw new Error("Slack alert exceeds configured message length");
  }
  return {
    channel: "slack",
    category: "copy_ready",
    preparation_version: record.preparation_version,
    preparation_input_guard: record.preparation_input_guard,
    idempotency_key: eligibility.idempotency_key,
    text,
    review_action: { mode: "open_only", url: safeReviewUrl },
    source_action: { mode: "open_only", url: sourceUrl }
  };
}

function providerClassification(result, policy) {
  const status = Number(result?.statusCode || result?.status || 0);
  const message = String(
    result?.error?.message || result?.error || result?.message || ""
  );
  if (result?.ok === true || (status >= 200 && status < 300)) {
    return { success: true };
  }
  if (/timeout|timed out/i.test(message)) {
    return {
      success: false,
      retryable: !policy.retry.ambiguous_timeout_terminal,
      category: "ambiguous_timeout"
    };
  }
  if (status === 429 || status >= 500 || /rate.?limit|temporar/i.test(message)) {
    return { success: false, retryable: true, category: "provider_retryable" };
  }
  return { success: false, retryable: false, category: "provider_rejected" };
}

export function applySlackProviderResult(
  freshRecord,
  sendingRecord,
  result,
  policy,
  now = new Date().toISOString()
) {
  if (
    !freshRecord ||
    !sendingRecord ||
    freshRecord.canonical_job_id !== sendingRecord.canonical_job_id ||
    freshRecord.record_version !== sendingRecord.record_version ||
    freshRecord.state_guard !== stateGuard(freshRecord) ||
    sendingRecord.state_guard !== stateGuard(sendingRecord) ||
    freshRecord.state_guard !== sendingRecord.state_guard ||
    freshRecord.user_action !== sendingRecord.user_action ||
    freshRecord.prep_status !== sendingRecord.prep_status ||
    freshRecord.preparation_version !== sendingRecord.preparation_version ||
    freshRecord.preparation_input_guard !==
      sendingRecord.preparation_input_guard ||
    freshRecord.alert_status !== "sending" ||
    freshRecord.alert_idempotency_key !== sendingRecord.alert_idempotency_key ||
    !freshRecord.alert_claim_token ||
    freshRecord.alert_claim_token !== sendingRecord.alert_claim_token
  ) {
    throw new Error("Slack result rejected stale To Apply state");
  }
  const classification = providerClassification(result, policy);
  const attempts = Number(freshRecord.alert_attempt_count || 0);
  const retryable =
    !classification.success &&
    classification.retryable &&
    attempts < policy.retry.max_attempts;
  const updated = {
    ...freshRecord,
    alert_status: classification.success
      ? "sent"
      : retryable
        ? "retryable_failure"
        : "terminal_failure",
    alert_sent_at: classification.success ? now : "",
    alert_provider_reference: classification.success
      ? sanitize(result?.reference || result?.ts || "accepted", 120)
      : "",
    alert_error_category: classification.success
      ? ""
      : classification.category,
    alert_error_summary: classification.success
      ? ""
      : sanitize(
          result?.error?.message || result?.error || result?.message || "Slack request failed"
        ),
    alert_next_retry_at: retryable
      ? new Date(Date.parse(now) + policy.retry.backoff_ms).toISOString()
      : "",
    alert_claim_token: "",
    record_version: freshRecord.record_version + 1,
    updated_at: now
  };
  updated.state_guard = stateGuard(updated);
  return updated;
}

export function planAlerterMoverRun(
  stores,
  schema,
  policy,
  now,
  messageSafetyContext,
  movementOptions
) {
  // Movement is planned first and remains usable even if an individual alert
  // is unsafe or the Slack provider later fails.
  const movement = planQueueActions(
    stores,
    schema,
    now,
    messageSafetyContext,
    movementOptions
  );
  const alerts = selectFreshAlertCandidates(
    stores["To Apply"],
    schema,
    policy,
    now,
    messageSafetyContext
  );
  return {
    movement,
    writes: destinationWrites(movement),
    alerts
  };
}
