import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  alertIdempotencyKey,
  alertRenderErrorCategory,
  applyAlertProviderResult,
  classifyAlertProviderResult,
  evaluateAlertEligibility as evaluateAlertEligibilityCore,
  queueAlertState as queueAlertStateCore,
  renderAlert as renderAlertCore,
  selectAlertCandidates as selectAlertCandidatesCore,
  validateAlertPolicy,
  validateAlertProviderConfiguration
} from "../src/alerts.mjs";
import {
  chooseWinningClaims,
  createProcessingClaim
} from "../src/contracts.mjs";
import { applyManualAction } from "../src/review.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const policy = await loadJson("../config/alert-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson(
  "../config/application-policy.json"
);
const packPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const messageSafetyContext = {
  profile,
  applicationPolicy,
  packPolicy
};
const now = "2026-07-28T12:00:00.000Z";
const evaluateAlertEligibility = (record, usedPolicy, at) =>
  evaluateAlertEligibilityCore(
    record,
    usedPolicy,
    at,
    messageSafetyContext
  );
const queueAlertState = (record, usedPolicy, at) =>
  queueAlertStateCore(record, usedPolicy, at, messageSafetyContext);
const selectAlertCandidates = (
  records,
  usedSchema,
  usedPolicy,
  at
) =>
  selectAlertCandidatesCore(
    records,
    usedSchema,
    usedPolicy,
    at,
    messageSafetyContext
  );
const renderAlert = (record, usedPolicy, options) =>
  renderAlertCore(record, usedPolicy, {
    ...options,
    messageSafetyContext
  });

function decodeSlackEntities(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractApplicationMessage(alertText) {
  const marker = "*Application message — copy below:*\n```";
  const start = alertText.indexOf(marker);
  assert.notEqual(start, -1, "application message marker is missing");
  const contentStart = start + marker.length;
  const end = alertText.indexOf("```", contentStart);
  assert.notEqual(end, -1, "application message closing fence is missing");
  return decodeSlackEntities(alertText.slice(contentStart, end));
}

const ready = (overrides = {}) => ({
  row_number: 2,
  source: "onlinejobs.ph",
  source_job_id: "7001",
  canonical_job_id: "onlinejobs.ph:7001",
  canonical_url: "https://onlinejobs.ph/jobseekers/job/typescript-developer-7001",
  job_title: "TypeScript Developer",
  company: "",
  salary_text: "",
  posted_at: "2026-07-27T12:00:00.000Z",
  source_availability: "active",
  pipeline_status: "ready",
  qualification_score: 80,
  opportunity_score: 78,
  ranking_confidence: "medium",
  apply_points_recommendation: "normal_allocation",
  requirement_gap_details: [],
  application_pack_status: "ready",
  application_instructions: [],
  screening_questions: [],
  selected_proof_refs: [
    "experience:upwork",
    "projects:job-pipeline"
  ],
  application_warnings: [],
  generated_message: "Existing ready message",
  message_profile_version: profile.profile_version,
  message_policy_version: applicationPolicy.policy_version,
  message_validation_status: "valid",
  application_pack_version: packPolicy.pack_version,
  application_pack_profile_version: profile.profile_version,
  application_pack_policy_version: packPolicy.policy_version,
  application_pack_generated_at: now,
  application_decision: "",
  alert_status: "",
  alert_attempt_count: 0,
  created_at: "2026-07-27T12:00:00.000Z",
  ...overrides
});

test("alert policy is versioned, bounded, and secret-free", () => {
  assert.deepEqual(validateAlertPolicy(policy), []);
  assert.equal(policy.schedule_minutes, 15);
  assert.equal(policy.provider_request_interval_ms, 1100);
  assert.equal(
    (90 / policy.schedule_minutes) * policy.per_run_cap,
    30,
    "six recovery sweeps must expose capacity for 30 alerts per Generator interval"
  );
  assert.equal(policy.eligibility.minimum_opportunity_score, 50);
  assert.match(policy.environment.provider_webhook_url, /^[A-Z0-9_]+$/);
  assert.doesNotMatch(JSON.stringify(policy), /hooks\.slack\.com|Bearer|https:\/\//i);

  const invalid = structuredClone(policy);
  invalid.channel = "arbitrary_webhook";
  invalid.retry.ambiguous_timeout_terminal = false;
  invalid.environment.review_url = "https://secret.example";
  invalid.maximum_action_url_characters = 1000;
  invalid.maximum_message_characters = 1000;
  const errors = validateAlertPolicy(invalid).join("\n");
  assert.match(errors, /channel is unsupported/);
  assert.match(errors, /ambiguous timeouts must be terminal/);
  assert.match(errors, /invalid alert environment reference/);
  assert.match(errors, /preserve two required links/);

  const unsafeTiming = structuredClone(policy);
  unsafeTiming.execution_timeout_seconds =
    unsafeTiming.claim_lease_ms / 1000;
  unsafeTiming.schedule_minutes =
    unsafeTiming.claim_lease_ms / 60000;
  unsafeTiming.schedule_offset_minutes = unsafeTiming.schedule_minutes;
  unsafeTiming.provider_timeout_ms =
    unsafeTiming.execution_timeout_seconds * 1000;
  unsafeTiming.provider_request_interval_ms = 999;
  unsafeTiming.per_run_cap = 2;
  unsafeTiming.retry.backoff_ms = unsafeTiming.claim_lease_ms - 1;
  const timingErrors = validateAlertPolicy(unsafeTiming).join("\n");
  assert.match(timingErrors, /claim lease must outlast/);
  assert.match(timingErrors, /alert schedule_offset_minutes/);
  assert.match(timingErrors, /claim lease must expire before/);
  assert.match(timingErrors, /provider timeout must be shorter/);
  assert.match(timingErrors, /paced at least one second apart/);
  assert.match(timingErrors, /execution timeout must exceed capped/);
  assert.match(timingErrors, /retry backoff must not precede/);
});

test("provider configuration allows only HTTPS Slack webhooks and HTTPS review surfaces", () => {
  assert.deepEqual(
    validateAlertProviderConfiguration(
      {
        webhookUrl: "https://hooks.slack.com/services/test/value",
        reviewUrl:
          "https://docs.google.com/spreadsheets/d/example/edit#gid=123456"
      },
      policy
    ),
    []
  );
  assert.match(
    validateAlertProviderConfiguration(
      {
        webhookUrl: "https://attacker.example/collect",
        reviewUrl: "javascript:alert(1)"
      },
      policy
    ).join("\n"),
    /approved bounded Slack HTTPS host|bounded credential-free HTTPS/
  );
  assert.match(
    validateAlertProviderConfiguration(
      {
        webhookUrl: `https://hooks.slack.com/services/${"x".repeat(800)}`,
        reviewUrl: "https://docs.google.com/spreadsheets/d/example"
      },
      policy
    ).join("\n"),
    /bounded Slack/
  );
  assert.match(
    validateAlertProviderConfiguration(
      {
        webhookUrl: "https://hooks.slack.com/services/test/value",
        reviewUrl:
          "https://docs.google.com/spreadsheets/d/example/edit#gid=1|Injected>"
      },
      policy
    ).join("\n"),
    /bounded credential-free HTTPS/
  );
});

test("eligibility enforces every configured boundary", () => {
  const boundary = ready({
    qualification_score: policy.eligibility.minimum_qualification_score,
    opportunity_score: policy.eligibility.minimum_opportunity_score,
    posted_at: "2026-07-25T12:00:00.000Z"
  });
  assert.deepEqual(evaluateAlertEligibility(boundary, policy, now).reasons, []);

  const cases = [
    ["qualification_below_threshold", { qualification_score: 69 }],
    [
      "opportunity_below_threshold",
      {
        opportunity_score:
          policy.eligibility.minimum_opportunity_score - 1
      }
    ],
    ["confidence_not_allowed", { ranking_confidence: "low" }],
    ["pack_not_ready", { application_pack_status: "review_required" }],
    ["posting_timestamp_missing", { posted_at: "" }],
    [
      "major_gap_limit_exceeded",
      {
        requirement_gap_details: [
          { requirement: "Kubernetes", classification: "hard" }
        ]
      }
    ],
    ["source_unavailable", { source_availability: "unavailable" }],
    [
      "source_url_invalid",
      {
        canonical_url: `https://onlinejobs.ph/jobseekers/job/${"x".repeat(
          policy.maximum_action_url_characters
        )}`
      }
    ],
    [
      "source_url_invalid",
      {
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/example-7001|Injected>"
      }
    ]
  ];
  for (const [reason, changes] of cases) {
    assert.ok(
      evaluateAlertEligibility(ready(changes), policy, now).reasons.includes(reason),
      `${reason} was not enforced`
    );
  }
});

test("quarantined persisted messages never queue or reach provider delivery", () => {
  const unsafe = ready({
    generated_message:
      "I have a strong foundation. Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
    message_profile_version: "legacy/unknown",
    message_policy_version: "",
    message_validation_status: "",
    application_pack_status: "",
    application_pack_version: "",
    application_pack_profile_version: "",
    application_pack_policy_version: "",
    application_pack_generated_at: "",
    alert_status: "pending",
    alert_idempotency_key: "onlinejobs.ph:7001|old-policy"
  });
  const eligibility = evaluateAlertEligibility(unsafe, policy, now);
  assert.ok(eligibility.reasons.includes("message_quarantined"));
  assert.ok(
    eligibility.message_safety.reasons.includes(
      "message_profile_legacy"
    )
  );

  const queued = queueAlertState(unsafe, policy, now);
  assert.equal(queued.alert_status, "not_eligible");
  assert.match(queued.alert_suppressed_reason, /message_quarantined/);

  const selected = selectAlertCandidates([unsafe], schema, policy, now);
  assert.equal(selected.candidates.length, 1);
  assert.equal(selected.candidates[0].delivery_mode, "state_only");
  assert.equal(selected.candidates[0].alert_status, "not_eligible");
  assert.match(
    selected.candidates[0].alert_suppressed_reason,
    /message_quarantined/
  );
  assert.throws(
    () =>
      renderAlert(unsafe, policy, {
        reviewUrl:
          "https://docs.google.com/spreadsheets/d/review-sheet"
      }),
    /message_quarantined/
  );
});

test("eligible committed packs are immediately queued with one idempotency key", () => {
  const queued = queueAlertState(ready(), policy, now);
  assert.equal(queued.alert_status, "pending");
  assert.equal(queued.alert_policy_version, policy.policy_version);
  assert.equal(queued.alert_channel, "slack");
  assert.equal(queued.alert_next_retry_at, now);
  assert.equal(queued.alert_idempotency_key, alertIdempotencyKey(queued, policy));

  const selected = selectAlertCandidates([queued], schema, policy, now);
  assert.equal(selected.candidates.length, 1);
  assert.equal(selected.candidates[0].delivery_mode, "deliver");
});

test("rendered Slack alert preserves the complete copyable message and non-mutating actions", () => {
  const generatedMessage = `Subject line: TypeScript Developer Application — John Lester Escarlan

Hi there,

I build TypeScript & React features with evidence < assumptions > hype.  I keep the original paragraph spacing intact.

GitHub: ${profile.candidate.links.github}`;
  const record = ready({
    alert_status: "pending",
    alert_policy_version: policy.policy_version,
    alert_idempotency_key: `onlinejobs.ph:7001|${policy.policy_version}`,
    alert_last_attempt_at: now,
    job_description: "FULL DESCRIPTION MUST NOT APPEAR",
    generated_message: generatedMessage,
    application_instructions: [
      { type: "subject", text: "Use subject line CODE-TS" }
    ],
    screening_questions: [],
    application_warnings: [],
    company: "",
    salary_text: ""
  });
  const reviewUrl =
    "https://docs.google.com/spreadsheets/d/example/edit#gid=123456";
  const alert = renderAlert(record, policy, { reviewUrl });
  assert.match(alert.text, /Qualification 80\/100/);
  assert.match(alert.text, /Opportunity 78\/100/);
  assert.match(alert.text, /Confidence medium/);
  assert.match(alert.text, /Employer: Unknown/);
  assert.match(alert.text, /Salary: Unknown/);
  assert.match(alert.text, /Questions: None detected/);
  assert.match(alert.text, /Instructions: Use subject line CODE-TS/);
  assert.match(alert.text, /Open Review Queue/);
  assert.match(alert.text, /Open OnlineJobs\.ph/);
  assert.equal(alert.text.split(reviewUrl).length - 1, 1);
  assert.doesNotMatch(
    alert.text,
    /Review in Sheet|Review in authorized Sheet|Confirm skip in Sheet/
  );
  assert.doesNotMatch(alert.text, /FULL DESCRIPTION/);
  assert.match(alert.text, /\*Application message — copy below:\*\n```/);
  assert.match(alert.text, /TypeScript &amp; React/);
  assert.match(alert.text, /evidence &lt; assumptions &gt; hype/);
  assert.equal(extractApplicationMessage(alert.text), generatedMessage);
  assert.equal(alert.review_action.mode, "authorized_review_surface");
  assert.equal(alert.review_action.url, reviewUrl);
  assert.equal("skip_action" in alert, false);
  assert.equal(alert.source_action.mode, "open_only");
  assert.equal(
    alert.source_action.url,
    "https://onlinejobs.ph/jobseekers/job/typescript-developer-7001"
  );
  assert.ok(alert.text.length <= policy.maximum_message_characters);

  const maximum = "x".repeat(policy.summary_item_characters);
  const bounded = renderAlert(
    ready({
      alert_last_attempt_at: now,
      company: maximum,
      salary_text: maximum,
      requirement_gap_details: Array.from({ length: 3 }, () => ({
        requirement: maximum,
        classification: "preference"
      })),
      application_instructions: Array.from({ length: 3 }, () => ({
        type: "format",
        required: false,
        text: maximum
      })),
      screening_questions: [],
      selected_proof_refs: [
        "experience:upwork",
        "projects:job-pipeline",
        "projects:rent-n-roll"
      ],
      application_warnings: []
    }),
    policy,
    {
      reviewUrl: `https://docs.google.com/${"r".repeat(
        policy.maximum_action_url_characters - 24
      )}`
    }
  );
  assert.ok(bounded.text.length <= policy.maximum_message_characters);
  assert.match(bounded.text, /Warnings:/);
  assert.match(bounded.text, /Open Review Queue/);
  assert.doesNotMatch(
    bounded.text,
    /Review in Sheet|Review in authorized Sheet|Confirm skip in Sheet/
  );
  assert.match(bounded.text, /Open OnlineJobs\.ph/);
  assert.equal(
    extractApplicationMessage(bounded.text),
    "Existing ready message"
  );
});

test("message fitting drops optional context before altering the complete message", () => {
  const generatedMessage = "x".repeat(3000);
  const alert = renderAlert(
    ready({
      generated_message: generatedMessage,
      alert_last_attempt_at: now,
      company: "c".repeat(policy.summary_item_characters),
      salary_text: "s".repeat(policy.summary_item_characters),
      application_instructions: Array.from({ length: 3 }, () => ({
        type: "format",
        required: false,
        text: "i".repeat(policy.summary_item_characters)
      }))
    }),
    policy,
    {
      reviewUrl: "https://docs.google.com/spreadsheets/d/example"
    }
  );

  assert.ok(alert.text.length <= policy.maximum_message_characters);
  assert.equal(extractApplicationMessage(alert.text), generatedMessage);
  assert.doesNotMatch(alert.text, /Warnings:/);
  assert.match(alert.text, /Open OnlineJobs\.ph/);
});

test("complete messages are accepted at the exact payload boundary and rejected one character beyond it", () => {
  const reviewUrl = "https://docs.google.com/spreadsheets/d/example";
  const sourceUrl = ready().canonical_url;
  const links = [
    `<${reviewUrl}|Open Review Queue>`,
    `<${sourceUrl}|Open OnlineJobs.ph>`
  ].join(" · ");
  const requiredOverhead =
    "*Application message — copy below:*\n".length +
    "``````".length +
    1 +
    links.length;
  const maximumApplicationMessageLength =
    policy.maximum_message_characters - requiredOverhead;
  const exactMessage = "x".repeat(maximumApplicationMessageLength);
  const exact = renderAlert(
    ready({
      generated_message: exactMessage,
      alert_last_attempt_at: now
    }),
    policy,
    { reviewUrl }
  );
  assert.equal(exact.text.length, policy.maximum_message_characters);
  assert.equal(extractApplicationMessage(exact.text), exactMessage);

  assert.throws(
    () =>
      renderAlert(
        ready({
          generated_message: `${exactMessage}x`,
          alert_last_attempt_at: now
        }),
        policy,
        { reviewUrl }
      ),
    (error) =>
      alertRenderErrorCategory(error) === "message_too_long"
  );
});

test("unrenderable messages fail closed without exposing or modifying the pack", () => {
  const cases = [
    ["message_too_long", "x".repeat(10000)],
    ["message_code_block_unsafe", "Copy this ```unsafe fence```"],
    ["message_code_block_unsafe", "`boundary backtick"],
    ["message_control_characters", "invisible\u200bseparator"]
  ];

  for (const [category, generatedMessage] of cases) {
    const record = ready({
      generated_message: generatedMessage,
      alert_last_attempt_at: now,
      processing_token: `claim-${category}`,
      processing_stage: "alert"
    });
    let thrown;
    try {
      renderAlert(record, policy, {
        reviewUrl: "https://docs.google.com/spreadsheets/d/example"
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${category} did not fail rendering`);
    assert.equal(alertRenderErrorCategory(thrown), category);
    assert.doesNotMatch(thrown.message, new RegExp(generatedMessage.slice(0, 20)));

    const finalized = applyAlertProviderResult(
      record,
      {
        preflight_error: alertRenderErrorCategory(thrown),
        at: now
      },
      policy
    );
    assert.equal(finalized.alert_status, "terminal_failure");
    assert.equal(finalized.alert_error_category, category);
    assert.equal(finalized.alert_next_retry_at, "");
    assert.equal(finalized.processing_token, "");
    assert.equal(finalized.processing_stage, "");
    assert.equal(finalized.generated_message, generatedMessage);
    assert.equal(finalized.application_pack_status, "ready");
    assert.doesNotMatch(finalized.alert_error_summary, /x{20}|unsafe fence|invisible/);
  }
});

test("confirmed success persists delivery evidence and suppresses duplicate initial alerts", () => {
  const queued = {
    ...queueAlertState(ready(), policy, now),
    processing_token: "alert-claim",
    processing_commit_guard: "commit:alert-claim",
    processing_stage: "alert"
  };
  const sent = applyAlertProviderResult(
    queued,
    {
      statusCode: 200,
      body: "ok",
      provider_reference: "delivery-7001",
      at: now
    },
    policy
  );
  assert.equal(sent.alert_status, "sent");
  assert.equal(sent.alert_sent_at, now);
  assert.equal(sent.alert_provider_reference, "delivery-7001");
  assert.equal(sent.processing_token, "");
  assert.equal(sent.processing_stage, "");
  assert.equal(sent.processing_started_at, "");
  assert.equal(sent.processing_commit_guard, "commit:alert-claim");
  assert.equal(sent.generated_message, queued.generated_message);

  assert.deepEqual(queueAlertState(sent, policy, now), sent);
  assert.deepEqual(selectAlertCandidates([sent], schema, policy, now).candidates, []);

  const sentUnderPreviousPolicy = {
    ...sent,
    alert_policy_version: "2026-07-28/v1",
    alert_idempotency_key: "onlinejobs.ph:7001|2026-07-28/v1"
  };
  assert.deepEqual(
    selectAlertCandidates(
      [sentUnderPreviousPolicy],
      schema,
      policy,
      now
    ).candidates,
    []
  );
  assert.deepEqual(
    queueAlertState(sentUnderPreviousPolicy, policy, now),
    sentUnderPreviousPolicy,
    "a policy rollout must not requeue a confirmed delivery"
  );
});

test("policy rollout preserves pending retry ownership, due time, and attempt budget", () => {
  const previousPolicy = {
    ...policy,
    policy_version: "2026-07-30/v3"
  };
  const retryDueAt = "2026-07-28T12:05:00.000Z";
  const retryable = {
    ...queueAlertState(ready(), previousPolicy, now),
    alert_status: "retryable_failure",
    alert_attempt_count: 2,
    alert_last_attempt_at: "2026-07-28T12:03:00.000Z",
    alert_next_retry_at: retryDueAt,
    alert_error_category: "provider_failure",
    alert_error_summary: "Provider response was not a confirmed success."
  };

  assert.deepEqual(
    queueAlertState(retryable, policy, now),
    retryable,
    "policy changes must not make a retry early or replenish attempts"
  );
  assert.deepEqual(
    selectAlertCandidates([retryable], schema, policy, now).candidates,
    []
  );

  const due = {
    ...retryable,
    alert_next_retry_at: "2026-07-28T11:59:00.000Z"
  };
  const selected = selectAlertCandidates(
    [due],
    schema,
    policy,
    now
  ).candidates;
  assert.equal(selected.length, 1);
  assert.equal(selected[0].alert_attempt_count, 2);
  const exhausted = applyAlertProviderResult(
    {
      ...selected[0],
      processing_token: "rollover-retry",
      processing_stage: "alert"
    },
    {
      statusCode: 503,
      body: "unavailable",
      at: now
    },
    policy
  );
  assert.equal(exhausted.alert_status, "terminal_failure");
  assert.equal(exhausted.alert_attempt_count, 3);
  assert.equal(exhausted.alert_next_retry_at, "");
});

test("a stale in-flight delivery is terminalized without a blind resend", () => {
  const inFlight = {
    ...queueAlertState(ready(), policy, now),
    alert_status: "sending",
    processing_stage: "alert",
    processing_token: "possibly-delivered-claim",
    processing_started_at: "2026-07-28T11:49:59.999Z"
  };
  const result = selectAlertCandidates([inFlight], schema, policy, now);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].delivery_mode, "state_only");
  assert.equal(result.candidates[0].alert_status, "terminal_failure");
  assert.equal(
    result.candidates[0].alert_error_category,
    "ambiguous_delivery"
  );
  assert.equal(result.candidates[0].alert_next_retry_at, "");

  const active = selectAlertCandidates(
    [
      {
        ...inFlight,
        processing_started_at: "2026-07-28T11:59:00.001Z"
      }
    ],
    schema,
    policy,
    now
  );
  assert.deepEqual(active.candidates, []);
});

test("transient provider failures retry with bounded backoff and preserve the pack", () => {
  const queued = {
    ...queueAlertState(ready(), policy, now),
    processing_token: "alert-claim",
    processing_stage: "alert"
  };
  const retry = applyAlertProviderResult(
    queued,
    {
      statusCode: 429,
      body: "rate limited api_key=must-redact",
      at: now
    },
    policy
  );
  assert.equal(retry.alert_status, "retryable_failure");
  assert.equal(retry.alert_attempt_count, 1);
  assert.equal(
    retry.alert_next_retry_at,
    "2026-07-28T12:02:00.000Z"
  );
  assert.doesNotMatch(retry.alert_error_summary, /must-redact/);
  assert.equal(retry.application_pack_status, "ready");
  assert.equal(retry.generated_message, "Existing ready message");

  assert.equal(
    selectAlertCandidates(
      [retry],
      schema,
      policy,
      "2026-07-28T12:01:59.000Z"
    ).candidates.length,
    0
  );
  assert.equal(
    selectAlertCandidates(
      [retry],
      schema,
      policy,
      "2026-07-28T12:02:00.000Z"
    ).candidates.length,
    1
  );

  const originalClaim = createProcessingClaim(
    {
      canonical_job_id: retry.canonical_job_id,
      work_stage: "alert"
    },
    "initial",
    now,
    policy.claim_lease_ms
  );
  const retryCandidate = selectAlertCandidates(
    [retry],
    schema,
    policy,
    "2026-07-28T12:02:00.000Z"
  ).candidates[0];
  const nextClaim = createProcessingClaim(
    retryCandidate,
    "retry",
    "2026-07-28T12:02:00.000Z",
    policy.claim_lease_ms
  );
  const proposedRetry = {
    ...retryCandidate,
    ...nextClaim
  };
  assert.deepEqual(
    chooseWinningClaims(
      [proposedRetry],
      [
        { ...originalClaim, row_number: 2 },
        { ...nextClaim, row_number: 3 }
      ],
      "2026-07-28T12:02:00.000Z"
    ).map((candidate) => candidate.processing_token),
    [nextClaim.processing_token]
  );

  const terminal = applyAlertProviderResult(
    {
      ...retry,
      alert_attempt_count: policy.retry.max_attempts - 1,
      processing_token: "alert-claim-3",
      processing_stage: "alert"
    },
    { statusCode: 503, body: "unavailable", at: now },
    policy
  );
  assert.equal(terminal.alert_status, "terminal_failure");
  assert.equal(terminal.alert_next_retry_at, "");
});

test("ambiguous timeout and missing configuration fail visibly without blind retry", () => {
  const timeout = classifyAlertProviderResult(
    { error: "request timed out", at: now },
    policy,
    now
  );
  assert.equal(timeout.category, "ambiguous_timeout");
  assert.equal(timeout.retryable, false);

  const missingConfig = classifyAlertProviderResult(
    { configuration_error: "Slack webhook environment variable is missing" },
    policy,
    now
  );
  assert.equal(missingConfig.category, "configuration_error");
  assert.equal(missingConfig.retryable, false);

  const unexpectedPreflight = classifyAlertProviderResult(
    {
      preflight_error: "api_key=must-not-leak",
      at: now
    },
    policy,
    now
  );
  assert.equal(unexpectedPreflight.category, "render_failure");
  assert.equal(unexpectedPreflight.retryable, false);
  assert.doesNotMatch(
    unexpectedPreflight.summary,
    /api_key|must-not-leak/
  );
  assert.equal(
    alertRenderErrorCategory({ alert_category: "toString" }),
    "render_failure"
  );
});

test("n8n string-shaped Slack errors retain retry and category semantics", () => {
  const rateLimit = classifyAlertProviderResult(
    { error: "Slack rate limit 429" },
    policy,
    now
  );
  assert.equal(rateLimit.category, "rate_limit");
  assert.equal(rateLimit.retryable, true);

  const unavailable = classifyAlertProviderResult(
    { error: "503 service temporarily unavailable" },
    policy,
    now
  );
  assert.equal(unavailable.category, "provider_failure");
  assert.equal(unavailable.retryable, true);

  const connection = classifyAlertProviderResult(
    { error: "connect ECONNRESET" },
    policy,
    now
  );
  assert.equal(connection.category, "provider_failure");
  assert.equal(connection.retryable, true);
});

test("known-unavailable pending alerts are claimed for suppression, not delivery", () => {
  const pendingUnavailable = ready({
    source_availability: "unavailable",
    alert_status: "pending",
    alert_policy_version: policy.policy_version,
    alert_idempotency_key: alertIdempotencyKey(ready(), policy)
  });
  const result = selectAlertCandidates(
    [pendingUnavailable],
    schema,
    policy,
    now
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].delivery_mode, "state_only");
  assert.equal(result.candidates[0].alert_status, "suppressed");
  assert.equal(result.candidates[0].alert_suppressed_reason, "source_unavailable");
  assert.equal(result.candidates[0].application_decision, "");
});

test("forwarded or tampered links have no state-changing capability and repeated skip is idempotent", () => {
  const alert = renderAlert(
    ready({ alert_last_attempt_at: now }),
    policy,
    { reviewUrl: "javascript:alert(1)" }
  );
  assert.equal(alert.review_action.url, "");
  assert.ok(
    [alert.review_action, alert.source_action].every(
      (action) => !("token" in action) && !("record" in action)
    )
  );
  assert.equal("skip_action" in alert, false);

  const firstSkip = applyManualAction(
    ready({ manual_action: "mark_skipped" }),
    schema,
    now
  );
  assert.equal(firstSkip.valid, true);
  const repeated = applyManualAction(
    { ...firstSkip.record, manual_action: "mark_skipped" },
    schema,
    "2026-07-28T13:00:00.000Z"
  );
  assert.equal(repeated.valid, true);
  assert.equal(repeated.record.application_decision, "skipped");
  assert.equal(
    repeated.record.application_decided_at,
    firstSkip.record.application_decided_at
  );
});

test("empty input produces no provider work", () => {
  assert.deepEqual(selectAlertCandidates([], schema, policy, now), {
    candidates: [],
    state_updates: []
  });
});
