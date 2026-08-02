import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applySlackProviderResult,
  evaluateProviderCommitHeadroom,
  markAlertSending,
  planAlerterMoverPhases,
  planAlerterMoverRun,
  preselectPersistedAlertCandidates,
  renderSlackAlert,
  selectFreshAlertCandidates,
  summarizeAlerterMoverRun,
  validateAlertPolicy
} from "../src/alerter-mover.mjs";
import {
  applyValidatedGeneration,
  claimGeneratorRecord,
  commitGeneratorResult,
  evaluateAndRoute,
  prepareApplicationGeneration
} from "../src/generator.mjs";
import { parseJobDetail } from "../src/evaluation.mjs";
import {
  normalizeLegacyRecord,
  stateGuard
} from "../src/contracts.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const schema = await loadJson("../config/pipeline-schema.json");
const profile = await loadJson("../config/candidate-profile.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const groqPolicy = await loadJson("../config/groq-provider-policy.json");
const runtime = (await loadJson("../config/runtime.json")).generator;
const alertPolicy = await loadJson("../config/alert-policy.json");
const directHtml = await readFile(
  new URL("./fixtures/job-direct.html", import.meta.url),
  "utf8"
);
const now = "2026-07-31T11:00:00.000Z";
const safetyContext = { profile, applicationPolicy, packPolicy };

function businessStores(overrides = {}) {
  return {
    "Scraped Jobs": [],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: [],
    ...overrides
  };
}

const validMessage = `Hi there,

I reduced API response time from 800 milliseconds to 150 milliseconds by fixing query and schema bottlenecks, and I have shipped production features with TypeScript, React, Node.js, PostgreSQL, and Supabase. Rent N Roll also gave me experience building marketplace and PayMongo webhook workflows.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

function makeReady(id, overrides = {}) {
  const base = {
    source: "onlinejobs.ph",
    source_job_id: String(id),
    canonical_job_id: `onlinejobs.ph:${id}`,
    canonical_url: `https://onlinejobs.ph/jobseekers/job/example-${id}`,
    row_number: Number(id) % 100 + 2,
    record_version: 1,
    pipeline_status: "new",
    user_action: "",
    source_availability: "active",
    attempt_count: 0,
    alert_attempt_count: 0,
    matched_keywords: ["full stack developer"],
    posted_at: "2026-07-31T10:00:00.000Z",
    discovered_at: "2026-07-31T10:05:00.000Z",
    created_at: "2026-07-31T10:05:00.000Z",
    updated_at: "2026-07-31T10:05:00.000Z"
  };
  let record = parseJobDetail(directHtml, base);
  record.source_job_id = String(id);
  record.canonical_job_id = `onlinejobs.ph:${id}`;
  record.canonical_url =
    `https://onlinejobs.ph/jobseekers/job/example-${id}`;
  record = normalizeLegacyRecord(record, schema, now);
  record.state_guard = stateGuard(record);
  const claimed = claimGeneratorRecord(
    record,
    "evaluation",
    `generator-${id}`,
    now,
    runtime.claim_lease_ms
  ).record;
  const evaluated = evaluateAndRoute(
    claimed,
    profile,
    rankingPolicy,
    now
  );
  const prepared = prepareApplicationGeneration(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  const proposed = applyValidatedGeneration(
    evaluated,
    prepared.pack,
    validMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const ready = commitGeneratorResult(
    claimed,
    claimed,
    proposed,
    schema,
    now
  );
  Object.assign(ready, overrides);
  ready.state_guard = stateGuard(ready);
  return ready;
}

test("alert policy is bounded and requires safe ready state", () => {
  assert.deepEqual(validateAlertPolicy(alertPolicy), []);
  assert.equal(alertPolicy.eligibility.pipeline_status, "ready_to_apply");
  assert.equal(alertPolicy.eligibility.required_pack_status, "ready");
  assert.equal(alertPolicy.eligibility.required_message_status, "valid");
  assert.ok(alertPolicy.provider_timeout_ms > 0);
  assert.ok(alertPolicy.provider_request_interval_ms > 0);
  assert.ok(alertPolicy.retry.max_attempts > 0);
});

test("Slack copy contains complete context and the exact stored message", () => {
  const ready = makeReady(5001);
  const payload = renderSlackAlert(ready, alertPolicy, {
    reviewUrl: "https://docs.google.com/spreadsheets/d/safe/edit",
    messageSafetyContext: safetyContext
  });
  assert.match(payload.text, /Ready to apply/);
  assert.match(payload.text, /Qualification:/);
  assert.match(payload.text, /Why:/);
  assert.match(payload.text, /Instructions:/);
  assert.match(payload.text, /Proofs:/);
  const copied = payload.text.match(
    /\*Application message — copy exactly:\*\n```([\s\S]*?)```/
  )[1];
  assert.equal(copied, ready.generated_message);
  assert.match(payload.text, /Open To Apply/);
  assert.match(payload.text, /Open OnlineJobs\.ph/);
  assert.deepEqual(payload.review_action.mode, "open_only");
  assert.deepEqual(payload.source_action.mode, "open_only");
  assert.doesNotMatch(
    payload.text,
    /[?&](?:approve|apply|skip|deny)=/i
  );
});

test("only fresh unacted ready rows are alert candidates", () => {
  const ready = makeReady(5002);
  const notReady = makeReady(5004, { pipeline_status: "review_needed" });
  const acted = makeReady(5003, { user_action: "I Applied" });
  const selected = selectFreshAlertCandidates(
    [ready, notReady, acted],
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.deepEqual(
    selected.candidates.map((entry) => entry.record.canonical_job_id),
    [ready.canonical_job_id]
  );
  assert.throws(
    () =>
      selectFreshAlertCandidates(
        [ready, { ...ready }],
        schema,
        alertPolicy,
        now,
        safetyContext
      ),
    /duplicate To Apply identity/
  );
});

test("movement is planned independently before Slack delivery", () => {
  const applied = makeReady(5010, { user_action: "I Applied" });
  const skipped = makeReady(5011, { user_action: "Skip" });
  const readyToAlert = makeReady(5012);
  const planned = planAlerterMoverRun(
    businessStores({ "To Apply": [applied, skipped, readyToAlert] }),
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(planned.writes.applied.length, 1);
  assert.equal(planned.writes.archive.length, 1);
  assert.equal(planned.alerts.candidates.length, 1);
  assert.equal(
    planned.alerts.candidates[0].record.canonical_job_id,
    readyToAlert.canonical_job_id
  );
});

test("phase planning short-circuits idle stores with explicit counts", () => {
  const idle = makeReady(5013, {
    pipeline_status: "new",
    application_pack_status: "",
    message_validation_status: "",
    generated_message: "",
    generated_at: ""
  });
  idle.state_guard = stateGuard(idle);
  const plan = planAlerterMoverPhases(
    businessStores({ "Scraped Jobs": [idle] }),
    schema,
    alertPolicy,
    now,
    { movementPerRunCap: 25 }
  );
  assert.equal(plan.has_work, false);
  assert.equal(plan.execution_classification, "no_eligible_work");
  assert.deepEqual(plan.store_counts, {
    "Scraped Jobs": 1,
    "To Review": 0,
    "To Apply": 0,
    "Applied Jobs": 0,
    Archive: 0
  });
  assert.deepEqual(plan.status_counts["Scraped Jobs"], { new: 1 });
  const summary = summarizeAlerterMoverRun({
    plan,
    sheetReadRequests: 1,
    providerClassifications: ["accepted", "accepted"]
  });
  assert.equal(summary.execution_classification, "no_eligible_work");
  assert.equal(summary.sheet_read_request_count, 1);
  assert.ok(summary.sheet_read_request_count <= 2);
  assert.deepEqual(summary.provider_classifications, ["accepted"]);
});

test("movement phases identify only touched stores and retain the six-read budget", () => {
  const review = makeReady(5014, {
    pipeline_status: "review_needed",
    user_action: ""
  });
  review.state_guard = stateGuard(review);
  const plan = planAlerterMoverPhases(
    businessStores({ "Scraped Jobs": [review] }),
    schema,
    alertPolicy,
    now,
    { movementPerRunCap: 25 }
  );
  assert.equal(plan.has_movement_work, true);
  assert.equal(plan.has_potential_alerts, false);
  assert.deepEqual(plan.touched_sheets, ["Scraped Jobs", "To Review"]);
  const instrumentedMovementOnlyReads = 4;
  assert.ok(instrumentedMovementOnlyReads <= 6);
});

test("persisted alert preselection is context-lazy and ownership ambiguity fails closed", () => {
  const ready = makeReady(5015);
  assert.deepEqual(
    preselectPersistedAlertCandidates(
      [ready],
      schema,
      alertPolicy,
      now
    ).candidates.map((record) => record.canonical_job_id),
    [ready.canonical_job_id]
  );
  assert.throws(
    () =>
      planAlerterMoverPhases(
        businessStores({
          "Scraped Jobs": [ready],
          "To Apply": [{ ...ready }]
        }),
        schema,
        alertPolicy,
        now
      ),
    /ambiguous business ownership.*duplicate canonical identity/i
  );
});

test("overlapping schedulers cannot claim the same alert", () => {
  const ready = makeReady(5020);
  const sending = markAlertSending(
    ready,
    alertPolicy,
    "alerter-run-1",
    now
  );
  const overlap = selectFreshAlertCandidates(
    [sending],
    schema,
    alertPolicy,
    "2026-07-31T11:01:00.000Z",
    safetyContext
  );
  assert.equal(overlap.candidates.length, 0);
  assert.match(overlap.rejected[0].reasons.join(";"), /retry_not_due/);
});

test("an expired sending claim becomes terminal without another provider candidate", () => {
  const sending = markAlertSending(
    makeReady(5021),
    alertPolicy,
    "alerter-run-expired",
    "2026-07-31T10:00:00.000Z"
  );
  const selected = selectFreshAlertCandidates(
    [sending],
    schema,
    alertPolicy,
    "2026-07-31T11:00:00.000Z",
    safetyContext
  );
  assert.equal(selected.candidates.length, 0);
  assert.equal(selected.state_updates.length, 1);
  assert.equal(selected.state_updates[0].alert_status, "terminal_failure");
  assert.equal(
    selected.state_updates[0].alert_error_category,
    "ambiguous_delivery"
  );
  assert.equal(selected.state_updates[0].alert_claim_token, "");
});

test("successful delivery is idempotent and never replayed", () => {
  const ready = makeReady(5030);
  const sending = markAlertSending(
    ready,
    alertPolicy,
    "alerter-run-1",
    now
  );
  const sent = applySlackProviderResult(
    sending,
    sending,
    { ok: true, reference: "slack-ts-1" },
    alertPolicy,
    now
  );
  assert.equal(sent.alert_status, "sent");
  assert.equal(sent.alert_provider_reference, "slack-ts-1");
  const repeated = selectFreshAlertCandidates(
    [sent],
    schema,
    alertPolicy,
    "2026-07-31T12:00:00.000Z",
    safetyContext
  );
  assert.equal(repeated.candidates.length, 0);
  assert.match(repeated.rejected[0].reasons.join(";"), /already_sent/);
});

test("Slack rejection schedules bounded retry without changing planned moves", () => {
  const applied = makeReady(5040, { user_action: "I Applied" });
  const alert = makeReady(5041);
  const run = planAlerterMoverRun(
    businessStores({ "To Apply": [applied, alert] }),
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  const sending = markAlertSending(
    alert,
    alertPolicy,
    "alerter-run-2",
    now
  );
  const failed = applySlackProviderResult(
    sending,
    sending,
    {
      statusCode: 429,
      error: {
        message:
          "Authorization: Bearer private-token rate limit https://hooks.slack.com/private"
      }
    },
    alertPolicy,
    now
  );
  assert.equal(failed.alert_status, "retryable_failure");
  assert.ok(failed.alert_next_retry_at);
  assert.doesNotMatch(
    failed.alert_error_summary,
    /private-token|hooks\.slack\.com/
  );
  assert.equal(run.writes.applied.length, 1);
});

test("ambiguous Slack timeout is terminal to prevent duplicate delivery", () => {
  const sending = markAlertSending(
    makeReady(5050),
    alertPolicy,
    "alerter-run-3",
    now
  );
  const failed = applySlackProviderResult(
    sending,
    sending,
    { error: { message: "request timed out after upload" } },
    alertPolicy,
    now
  );
  assert.equal(failed.alert_status, "terminal_failure");
  assert.equal(failed.alert_error_category, "ambiguous_timeout");
  assert.equal(failed.alert_next_retry_at, "");
});

test("stale Slack result cannot overwrite a user action", () => {
  const sending = markAlertSending(
    makeReady(5060),
    alertPolicy,
    "alerter-run-4",
    now
  );
  const changed = {
    ...sending,
    user_action: "Skip",
    record_version: sending.record_version + 1
  };
  changed.state_guard = stateGuard(changed);
  assert.throws(
    () =>
      applySlackProviderResult(
        changed,
        sending,
        { ok: true },
        alertPolicy,
        now
      ),
    /stale To Apply state/
  );
});

test("quarantined, stale-policy, and unsafe message rows are suppressed", () => {
  const quarantined = makeReady(5070, {
    message_validation_status: "quarantined"
  });
  const stalePolicy = makeReady(5071, {
    message_policy_version: "old-policy"
  });
  const unsafe = makeReady(5072, {
    generated_message: `${validMessage}\nMore: https://evil.example/private`
  });
  const selected = selectFreshAlertCandidates(
    [quarantined, stalePolicy, unsafe],
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(selected.candidates.length, 0);
  assert.equal(selected.rejected.length, 3);
  assert.ok(
    selected.rejected.every((entry) =>
      entry.reasons.some((reason) =>
        /message|pack/.test(reason)
      )
    )
  );
});

test("unsafe To Apply or source links are rendered as unavailable", () => {
  const ready = makeReady(5080);
  const payload = renderSlackAlert(ready, alertPolicy, {
    reviewUrl: "javascript:approve(5080)",
    messageSafetyContext: safetyContext
  });
  assert.match(payload.text, /To Apply: unavailable/);
  assert.equal(payload.review_action.url, "");
  assert.equal(payload.source_action.mode, "open_only");
});

test("provider headroom fails closed before Slack when the commit window is too small", () => {
  const available = evaluateProviderCommitHeadroom({
    executionStartedAt: "2026-08-02T06:00:00.000Z",
    now: "2026-08-02T06:02:00.000Z",
    executionTimeoutSeconds: 300,
    minimumHeadroomMs: 150000
  });
  assert.equal(available.eligible, true);
  assert.equal(available.remaining_ms, 180000);
  const insufficient = evaluateProviderCommitHeadroom({
    executionStartedAt: "2026-08-02T06:00:00.000Z",
    now: "2026-08-02T06:03:00.001Z",
    executionTimeoutSeconds: 300,
    minimumHeadroomMs: 120000
  });
  assert.equal(insufficient.eligible, false);
  assert.equal(insufficient.classification, "insufficient_provider_headroom");
  assert.throws(
    () =>
      evaluateProviderCommitHeadroom({
        executionStartedAt: "invalid",
        now: "2026-08-02T06:00:00.000Z",
        executionTimeoutSeconds: 300,
        minimumHeadroomMs: 120000
      }),
    /ordered ISO timestamps/
  );
});
