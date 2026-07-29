import {
  isStaleClaim,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  parseHttpUrl,
  releaseClaim
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";

const ALLOWED_CHANNELS = ["slack"];
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const ALERT_RENDER_ERROR_SUMMARIES = Object.freeze({
  message_code_block_unsafe:
    "The validated application message cannot be represented safely in a Slack code block.",
  message_control_characters:
    "The validated application message contains unsupported control characters.",
  message_too_long:
    "The complete application message and required actions exceed the configured Slack alert limit.",
  render_failure: "The Slack alert could not be rendered safely."
});

function cleanText(value, maximum = 500) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/gi, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .trim()
    .slice(0, maximum);
}

export function alertIdempotencyKey(record, policy) {
  const canonicalId = String(record?.canonical_job_id || "").trim();
  return canonicalId && policy?.policy_version
    ? `${canonicalId}|${policy.policy_version}`
    : "";
}

export function validateAlertPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["alert policy must be an object"];
  }
  if (policy.schema_version !== 1) errors.push("alert policy schema_version must be 1");
  if (!/^\d{4}-\d{2}-\d{2}\/v\d+$/.test(policy.policy_version ?? "")) {
    errors.push("alert policy_version must use YYYY-MM-DD/vN");
  }
  if (!ALLOWED_CHANNELS.includes(policy.channel)) {
    errors.push("alert channel is unsupported");
  }
  for (const field of [
    "schedule_minutes",
    "per_run_cap",
    "claim_lease_ms",
    "provider_timeout_ms",
    "maximum_message_characters",
    "maximum_action_url_characters",
    "summary_item_characters"
  ]) {
    if (!Number.isInteger(policy[field]) || policy[field] < 1) {
      errors.push(`${field} must be a positive integer`);
    }
  }
  if (
    !Number.isInteger(policy.retry?.max_attempts) ||
    policy.retry.max_attempts < 1 ||
    !Number.isInteger(policy.retry?.backoff_ms) ||
    policy.retry.backoff_ms < 1
  ) {
    errors.push("alert retry bounds are invalid");
  }
  if (policy.retry?.ambiguous_timeout_terminal !== true) {
    errors.push("Slack ambiguous timeouts must be terminal to prevent blind duplicates");
  }
  if (
    Number.isInteger(policy.maximum_message_characters) &&
    Number.isInteger(policy.maximum_action_url_characters) &&
    policy.maximum_message_characters <
      policy.maximum_action_url_characters * 3 + 1000
  ) {
    errors.push(
      "maximum_message_characters must preserve three actions and required context"
    );
  }
  for (const field of [
    "maximum_age_days",
    "minimum_qualification_score",
    "minimum_opportunity_score",
    "maximum_major_gaps"
  ]) {
    const value = policy.eligibility?.[field];
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`eligibility.${field} must be non-negative`);
    }
  }
  for (const field of [
    "minimum_qualification_score",
    "minimum_opportunity_score"
  ]) {
    if (policy.eligibility?.[field] > 100) {
      errors.push(`eligibility.${field} must not exceed 100`);
    }
  }
  if (
    !Array.isArray(policy.eligibility?.allowed_confidence) ||
    policy.eligibility.allowed_confidence.length === 0 ||
    policy.eligibility.allowed_confidence.some(
      (value) => !["high", "medium", "low"].includes(value)
    )
  ) {
    errors.push("eligibility.allowed_confidence is invalid");
  }
  if (policy.eligibility?.required_pack_status !== "ready") {
    errors.push("alert eligibility must require a ready pack");
  }
  for (const [field, value] of Object.entries(policy.environment ?? {})) {
    if (
      !["provider_webhook_url", "review_url"].includes(field) ||
      !ENVIRONMENT_NAME.test(value ?? "")
    ) {
      errors.push(`invalid alert environment reference: ${field}`);
    }
  }
  if (Object.keys(policy.environment ?? {}).length !== 2) {
    errors.push("provider_webhook_url and review_url environment references are required");
  }
  return errors;
}

export function validateAlertProviderConfiguration(
  { webhookUrl, reviewUrl },
  policy
) {
  const errors = [];
  const webhook = parseHttpUrl(webhookUrl);
  if (!webhook) {
    errors.push("provider webhook URL is missing or invalid");
  }
  if (
    webhook &&
    (webhook.protocol !== "https:" ||
      !["hooks.slack.com", "hooks.slack-gov.com"].includes(webhook.hostname) ||
      webhookUrl.length > policy.maximum_action_url_characters)
  ) {
    errors.push(
      "provider webhook URL must use an approved bounded Slack HTTPS host"
    );
  }
  const review = parseHttpUrl(reviewUrl);
  if (!review) {
    errors.push("review URL is missing or invalid");
  }
  if (
    review &&
    (review.protocol !== "https:" ||
      review.username ||
      review.password ||
      reviewUrl.length > policy.maximum_action_url_characters)
  ) {
    errors.push("review URL must use bounded credential-free HTTPS");
  }
  if (policy.channel !== "slack") errors.push("provider channel is unsupported");
  return errors;
}

function scoreKnown(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function evaluateAlertEligibility(
  record,
  policy,
  now = new Date().toISOString(),
  messageSafetyContext
) {
  const reasons = [];
  if (!record?.canonical_job_id) reasons.push("missing_identity");
  const sourceUrl = normalizeCanonicalUrl(record?.canonical_url);
  if (
    !sourceUrl ||
    sourceUrl.length > policy.maximum_action_url_characters
  ) {
    reasons.push("source_url_invalid");
  }
  if (record?.pipeline_status !== "ready") reasons.push("lifecycle_not_ready");
  if (record?.application_decision) reasons.push("application_already_decided");
  if (record?.source_availability === "unavailable") reasons.push("source_unavailable");
  if (record?.application_pack_status !== policy.eligibility.required_pack_status) {
    reasons.push("pack_not_ready");
  }
  const messageSafety = evaluatePersistedMessageSafety(
    record,
    messageSafetyContext
  );
  if (!messageSafety.safe) reasons.push("message_quarantined");
  if (
    !scoreKnown(record?.qualification_score) ||
    record.qualification_score < policy.eligibility.minimum_qualification_score
  ) {
    reasons.push("qualification_below_threshold");
  }
  if (
    !scoreKnown(record?.opportunity_score) ||
    record.opportunity_score < policy.eligibility.minimum_opportunity_score
  ) {
    reasons.push("opportunity_below_threshold");
  }
  if (!policy.eligibility.allowed_confidence.includes(record?.ranking_confidence)) {
    reasons.push("confidence_not_allowed");
  }
  const majorGaps = (Array.isArray(record?.requirement_gap_details)
    ? record.requirement_gap_details
    : []
  ).filter((gap) => ["hard", "ambiguous"].includes(gap?.classification));
  if (majorGaps.length > policy.eligibility.maximum_major_gaps) {
    reasons.push("major_gap_limit_exceeded");
  }
  const nowMs = Date.parse(now);
  const postedMs = Date.parse(record?.posted_at || "");
  const postingAgeDays =
    Number.isFinite(nowMs) && Number.isFinite(postedMs) && postedMs <= nowMs
      ? (nowMs - postedMs) / (24 * 60 * 60 * 1000)
      : undefined;
  if (
    postingAgeDays === undefined ||
    postingAgeDays > policy.eligibility.maximum_age_days
  ) {
    reasons.push(
      record?.posted_at ? "posting_timestamp_invalid" : "posting_timestamp_missing"
    );
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    posting_age_days: postingAgeDays,
    message_safety: messageSafety
  };
}

export function queueAlertState(
  record,
  policy,
  now = new Date().toISOString(),
  messageSafetyContext
) {
  const eligibility = evaluateAlertEligibility(
    record,
    policy,
    now,
    messageSafetyContext
  );
  const key = alertIdempotencyKey(record, policy);
  if (
    record.alert_status === "sent" &&
    record.alert_idempotency_key === key
  ) {
    return record;
  }
  if (record.source_availability === "unavailable") {
    return {
      ...record,
      alert_status: "suppressed",
      alert_channel: policy.channel,
      alert_policy_version: policy.policy_version,
      alert_idempotency_key: key,
      alert_suppressed_reason: "source_unavailable",
      alert_next_retry_at: "",
      updated_at: now
    };
  }
  if (!eligibility.eligible) {
    return {
      ...record,
      alert_status: "not_eligible",
      alert_channel: policy.channel,
      alert_policy_version: policy.policy_version,
      alert_idempotency_key: key,
      alert_suppressed_reason: eligibility.reasons.join(","),
      alert_next_retry_at: "",
      updated_at: now
    };
  }
  if (
    record.alert_idempotency_key === key &&
    ["pending", "sending", "retryable_failure", "terminal_failure"].includes(
      record.alert_status
    )
  ) {
    return record;
  }
  return {
    ...record,
    alert_status: "pending",
    alert_channel: policy.channel,
    alert_policy_version: policy.policy_version,
    alert_idempotency_key: key,
    alert_attempt_count: 0,
    alert_last_attempt_at: "",
    alert_next_retry_at: now,
    alert_sent_at: "",
    alert_provider_reference: "",
    alert_error_category: "",
    alert_error_summary: "",
    alert_suppressed_reason: "",
    updated_at: now
  };
}

function retryDue(record, now) {
  if (!record.alert_next_retry_at) return true;
  const retryAt = Date.parse(record.alert_next_retry_at);
  return !Number.isFinite(retryAt) || retryAt <= Date.parse(now);
}

export function selectAlertCandidates(
  rawRows,
  schema,
  policy,
  now = new Date().toISOString(),
  messageSafetyContext
) {
  const selected = [];
  for (const raw of rawRows) {
    const record = normalizeLegacyRecord(raw, schema, now);
    const safetyEligibility = evaluateAlertEligibility(
      record,
      policy,
      now,
      messageSafetyContext
    );
    if (
      !safetyEligibility.message_safety.safe &&
      ["pending", "sending", "retryable_failure"].includes(
        record.alert_status
      )
    ) {
      selected.push({
        ...queueAlertState(
          record,
          policy,
          now,
          messageSafetyContext
        ),
        row_number: raw.row_number,
        work_stage: "alert",
        delivery_mode: "state_only"
      });
      continue;
    }
    if (record.alert_status === "sending") {
      if (
        !isStaleClaim(record, Date.parse(now), policy.claim_lease_ms)
      ) {
        continue;
      }
      selected.push({
        ...record,
        alert_status: "terminal_failure",
        alert_next_retry_at: "",
        alert_error_category: "ambiguous_delivery",
        alert_error_summary:
          "Delivery began but its final acknowledgement was not persisted; automatic resend was suppressed.",
        updated_at: now,
        row_number: raw.row_number,
        work_stage: "alert",
        delivery_mode: "state_only"
      });
      continue;
    }
    const queued = queueAlertState(
      record,
      policy,
      now,
      messageSafetyContext
    );
    const existingDeliveryState = ["pending", "retryable_failure"].includes(
      record.alert_status
    );
    if (!existingDeliveryState) continue;
    if (["suppressed", "not_eligible"].includes(queued.alert_status)) {
      selected.push({
        ...queued,
        row_number: raw.row_number,
        work_stage: "alert",
        delivery_mode: "state_only"
      });
      continue;
    }
    if (
      ["pending", "retryable_failure"].includes(queued.alert_status) &&
      retryDue(queued, now) &&
      evaluateAlertEligibility(
        queued,
        policy,
        now,
        messageSafetyContext
      ).eligible
    ) {
      selected.push({
        ...queued,
        row_number: raw.row_number,
        work_stage: "alert",
        delivery_mode: "deliver"
      });
    }
  }
  selected.sort(
    (left, right) =>
      Number(right.opportunity_score) - Number(left.opportunity_score) ||
      Date.parse(right.posted_at) - Date.parse(left.posted_at) ||
      left.canonical_job_id.localeCompare(right.canonical_job_id)
  );
  return {
    candidates: selected.slice(0, policy.per_run_cap),
    state_updates: []
  };
}

function summaryList(values, policy, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  return values
    .slice(0, 3)
    .map((value) =>
      cleanText(
        typeof value === "string"
          ? value
          : value.text || value.summary || value.requirement || "",
        policy.summary_item_characters
      )
    )
    .filter(Boolean)
    .join(" | ") || fallback;
}

function slackEscape(value) {
  return cleanText(value, 500)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function slackEscapeLiteral(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function alertRenderError(category) {
  const normalizedCategory =
    Object.hasOwn(ALERT_RENDER_ERROR_SUMMARIES, category)
      ? category
      : "render_failure";
  const error = new Error(ALERT_RENDER_ERROR_SUMMARIES[normalizedCategory]);
  error.name = "AlertRenderError";
  error.alert_category = normalizedCategory;
  return error;
}

export function alertRenderErrorCategory(error) {
  const category = String(error?.alert_category || "");
  return Object.hasOwn(ALERT_RENDER_ERROR_SUMMARIES, category)
    ? category
    : "render_failure";
}

function fitAlertLines(lines, minimums, maximum) {
  if (!Number.isFinite(maximum) || maximum <= 0) return "";
  const result = lines.map((line, index) => ({
    text: line,
    minimum: minimums[index] ?? 0
  }));
  const length = () =>
    result.reduce((sum, line) => sum + line.text.length, 0) +
    Math.max(0, result.length - 1);
  while (length() > maximum) {
    let candidate = -1;
    let reducible = 0;
    for (let index = 0; index < result.length; index += 1) {
      const available =
        result[index].text.length - result[index].minimum;
      if (available > reducible) {
        candidate = index;
        reducible = available;
      }
    }
    if (candidate >= 0 && reducible > 0) {
      const excess = length() - maximum;
      const nextLength =
        result[candidate].text.length - Math.min(reducible, excess);
      result[candidate].text = `${result[candidate].text
        .slice(
          0,
          Math.max(
            result[candidate].minimum - 1,
            nextLength - 1
          )
        )
        .trimEnd()}…`;
      continue;
    }
    result.pop();
  }
  return result.map((line) => line.text).join("\n");
}

export function renderAlert(
  record,
  policy,
  { reviewUrl, messageSafetyContext }
) {
  const messageSafety = evaluatePersistedMessageSafety(
    record,
    messageSafetyContext
  );
  if (!messageSafety.safe) {
    throw new Error(
      `message_quarantined: ${messageSafety.reasons.join(",")}`
    );
  }
  const normalizedSourceUrl = normalizeCanonicalUrl(record.canonical_url);
  const sourceUrl =
    normalizedSourceUrl.length <= policy.maximum_action_url_characters
      ? normalizedSourceUrl
      : "";
  const parsedReviewUrl = parseHttpUrl(reviewUrl);
  const safeReviewUrl =
    parsedReviewUrl?.protocol === "https:" &&
    parsedReviewUrl.href.length <= policy.maximum_action_url_characters
      ? parsedReviewUrl.href
      : "";
  const age = evaluateAlertEligibility(
    record,
    policy,
    record.alert_last_attempt_at || new Date().toISOString(),
    messageSafetyContext
  ).posting_age_days;
  const employer = cleanText(record.company, 120) || "Unknown";
  const salary = cleanText(record.salary_text, 120) || "Unknown";
  const instructions = summaryList(
    record.application_instructions,
    policy,
    "None detected"
  );
  const questions = summaryList(
    record.screening_questions,
    policy,
    "None detected"
  );
  const proofs = summaryList(record.selected_proof_refs, policy, "None selected");
  const warnings = summaryList(record.application_warnings, policy, "None");
  const gaps = summaryList(record.requirement_gap_details, policy, "None");
  const links = [
    safeReviewUrl ? `<${safeReviewUrl}|Review in authorized Sheet>` : "Review: unavailable",
    safeReviewUrl ? `<${safeReviewUrl}|Confirm skip in Sheet>` : "Skip: unavailable",
    sourceUrl ? `<${sourceUrl}|Open OnlineJobs.ph>` : "Source: unavailable"
  ].join(" · ");
  const applicationMessage = String(record.generated_message ?? "");
  if (
    applicationMessage.includes("```") ||
    applicationMessage.startsWith("`") ||
    applicationMessage.endsWith("`")
  ) {
    throw alertRenderError("message_code_block_unsafe");
  }
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/u.test(
      applicationMessage
    )
  ) {
    throw alertRenderError("message_control_characters");
  }
  const applicationBlock =
    `*Application message — copy below:*\n` +
    `\`\`\`${slackEscapeLiteral(applicationMessage)}\`\`\``;
  const requiredTail = `${applicationBlock}\n${links}`;
  if (requiredTail.length > policy.maximum_message_characters) {
    throw alertRenderError("message_too_long");
  }
  const contextLines = [
    `*High-opportunity job:* ${slackEscape(record.job_title) || "Untitled role"}`,
    `Qualification ${record.qualification_score}/100 · Opportunity ${record.opportunity_score}/100 · Confidence ${record.ranking_confidence}`,
    `Employer: ${slackEscape(employer)} · Salary: ${slackEscape(salary)} · Freshness: ${
      Number.isFinite(age) ? `${Math.round(age * 10) / 10} days` : "Unknown"
    }`,
    `Apply Points: ${record.apply_points_recommendation || "Unknown"} · Major gaps: ${slackEscape(gaps)}`,
    `Instructions: ${slackEscape(instructions)}`,
    `Questions: ${slackEscape(questions)}`,
    `Proofs: ${slackEscape(proofs)}`,
    `Warnings: ${slackEscape(warnings)}`
  ];
  const context = fitAlertLines(
    contextLines,
    [60, 80, 100, 100, 120, 120, 120, 180],
    policy.maximum_message_characters - requiredTail.length - 1
  );
  const text = context
    ? `${context}\n${requiredTail}`
    : requiredTail;
  if (text.length > policy.maximum_message_characters) {
    throw alertRenderError("message_too_long");
  }
  return {
    channel: policy.channel,
    idempotency_key: alertIdempotencyKey(record, policy),
    text,
    review_action: {
      mode: "authorized_review_surface",
      url: safeReviewUrl
    },
    skip_action: {
      mode: "review_confirmation",
      url: safeReviewUrl
    },
    source_action: {
      mode: "open_only",
      url: sourceUrl
    }
  };
}

export function classifyAlertProviderResult(
  result,
  policy,
  now = new Date().toISOString()
) {
  const status = Number(result?.statusCode || result?.status || 0);
  const message = cleanText(
    result?.error?.message || result?.message || result?.body || "",
    200
  );
  if (result?.preflight_error) {
    const category = String(result.preflight_error);
    const normalizedCategory =
      Object.hasOwn(ALERT_RENDER_ERROR_SUMMARIES, category)
        ? category
        : "render_failure";
    return {
      success: false,
      retryable: false,
      category: normalizedCategory,
      summary: ALERT_RENDER_ERROR_SUMMARIES[normalizedCategory],
      at: now
    };
  }
  if (result?.configuration_error) {
    return {
      success: false,
      retryable: false,
      category: "configuration_error",
      summary: cleanText(result.configuration_error, 200),
      at: now
    };
  }
  if (status >= 200 && status < 300 && /^(?:ok)?$/i.test(message)) {
    return {
      success: true,
      retryable: false,
      category: "",
      summary: "",
      provider_reference: cleanText(result.provider_reference, 120),
      at: now
    };
  }
  const timeout = status === 0 && /timeout|timed out|aborted/i.test(message);
  if (timeout && policy.retry.ambiguous_timeout_terminal) {
    return {
      success: false,
      retryable: false,
      category: "ambiguous_timeout",
      summary: "Provider timeout has ambiguous delivery; manual reconciliation required.",
      at: now
    };
  }
  const retryable =
    status === 429 ||
    status >= 500 ||
    (status === 0 && /temporar|connection|econn/i.test(message));
  return {
    success: false,
    retryable,
    category:
      status === 429
        ? "rate_limit"
        : status >= 500
          ? "provider_failure"
          : status >= 400
            ? "provider_rejected"
            : "provider_malformed_response",
    summary: message || "Provider response was not a confirmed success.",
    at: now
  };
}

export function applyAlertProviderResult(record, result, policy) {
  const outcome = classifyAlertProviderResult(result, policy, result?.at);
  const attempts = Number(record.alert_attempt_count || 0) + 1;
  if (outcome.success) {
    return releaseClaim(
      {
        ...record,
        alert_status: "sent",
        alert_channel: policy.channel,
        alert_policy_version: policy.policy_version,
        alert_idempotency_key: alertIdempotencyKey(record, policy),
        alert_attempt_count: attempts,
        alert_last_attempt_at: outcome.at,
        alert_next_retry_at: "",
        alert_sent_at: outcome.at,
        alert_provider_reference: outcome.provider_reference || "",
        alert_error_category: "",
        alert_error_summary: "",
        alert_suppressed_reason: "",
        updated_at: outcome.at
      },
      record.processing_token,
      outcome.at
    );
  }
  const retryable =
    outcome.retryable && attempts < policy.retry.max_attempts;
  return releaseClaim(
    {
      ...record,
      alert_status: retryable ? "retryable_failure" : "terminal_failure",
      alert_channel: policy.channel,
      alert_policy_version: policy.policy_version,
      alert_idempotency_key: alertIdempotencyKey(record, policy),
      alert_attempt_count: attempts,
      alert_last_attempt_at: outcome.at,
      alert_next_retry_at: retryable
        ? new Date(
            Date.parse(outcome.at) +
              policy.retry.backoff_ms * 2 ** (attempts - 1)
          ).toISOString()
        : "",
      alert_error_category: outcome.category,
      alert_error_summary: cleanText(outcome.summary, 200),
      updated_at: outcome.at
    },
    record.processing_token,
    outcome.at
  );
}
