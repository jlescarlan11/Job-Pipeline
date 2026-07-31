import {
  normalizeCanonicalUrl,
  parseHttpUrl,
  stateGuard,
  validateRecordStoreContract
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";
import {
  destinationWrites,
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
  return [
    "slack",
    record.canonical_job_id,
    policy.policy_version,
    record.generated_at,
    stableHash(String(record.generated_message || ""))
  ].join(":");
}

export function validateAlertPolicy(policy) {
  const errors = [];
  if (policy?.schema_version !== 2) {
    errors.push("alert policy schema_version must be 2");
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
    policy?.eligibility?.required_pack_status !== "ready" ||
    policy?.eligibility?.required_message_status !== "valid"
  ) {
    errors.push("alert eligibility must require a fully ready application");
  }
  for (const field of ["provider_webhook_url", "review_url"]) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(policy?.environment?.[field] || "")) {
      errors.push(`${field} must name an environment variable`);
    }
  }
  return errors;
}

function retryDue(record, policy, nowMs) {
  if (record.alert_status === "sending") {
    return false;
  }
  const retryAt = Date.parse(record.alert_next_retry_at || "");
  return !record.alert_next_retry_at || !Number.isFinite(retryAt) || retryAt <= nowMs;
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
  if (record.application_pack_status !== "ready") reasons.push("pack_not_ready");
  if (record.message_validation_status !== "valid") reasons.push("message_not_valid");
  const expectedKey = alertIdempotencyKey(record, policy);
  if (
    record.alert_status === "sent" &&
    record.alert_idempotency_key === expectedKey
  ) {
    reasons.push("already_sent");
  }
  if (["terminal_failure", "suppressed"].includes(record.alert_status)) {
    reasons.push("alert_terminal");
  }
  if (!retryDue(record, policy, Date.parse(now))) reasons.push("retry_not_due");
  const safety = evaluatePersistedMessageSafety(record, messageSafetyContext);
  if (!safety.safe) reasons.push(...safety.reasons);
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    idempotency_key: expectedKey
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
      Date.parse(left.record.generated_at || left.record.created_at || "") -
        Date.parse(right.record.generated_at || right.record.created_at || "") ||
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
  const marked = {
    ...record,
    alert_status: "sending",
    alert_idempotency_key: alertIdempotencyKey(record, policy),
    alert_attempt_count: Number(record.alert_attempt_count || 0) + 1,
    alert_last_attempt_at: now,
    alert_next_retry_at: "",
    alert_error_category: "",
    alert_error_summary: "",
    alert_provider_reference: "",
    alert_claim_token: `${sanitize(executionId, 120)}:alert:${stableHash(
      `${record.canonical_job_id}:${alertIdempotencyKey(record, policy)}`
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
    idempotency_key: alertIdempotencyKey(record, policy),
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
    freshRecord.state_guard !== sendingRecord.state_guard ||
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
