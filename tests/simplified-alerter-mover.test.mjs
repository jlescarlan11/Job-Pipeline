import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  alertCategory,
  alertIdempotencyKey,
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
  stateGuard,
  submissionIdempotencyKey
} from "../src/contracts.mjs";
import {
  browserConfirmationPublicKeyDigest,
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  serializeBrowserConfirmationWitness
} from "../src/browser-confirmation-attestation.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const schema = await loadJson("../config/pipeline-schema.json");
const profile = await loadJson("../config/candidate-profile.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const groqPolicy = await loadJson("../config/groq-provider-policy.json");
const runtimeConfig = await loadJson("../config/runtime.json");
const confirmationKeyId = "alerter-history-adapter-v1";
const confirmationKeys = generateKeyPairSync("ed25519");
const confirmationPublicKey = confirmationKeys.publicKey.export({
  type: "spki",
  format: "pem"
});
const confirmationTrust = {
  keyId: confirmationKeyId,
  publicKey: confirmationPublicKey,
  publicKeySpkiSha256: browserConfirmationPublicKeyDigest(confirmationPublicKey)
};
const generatorClaimLeaseMs =
  runtimeConfig.generator?.claim_lease_ms ??
  runtimeConfig.browser_executor?.claim_lease_ms;
const alertPolicy = await loadJson("../config/alert-policy.json");
const directHtml = await readFile(
  new URL("./fixtures/job-direct.html", import.meta.url),
  "utf8"
);
const now = "2026-07-31T11:00:00.000Z";
const safetyContext = {
  profile,
  applicationPolicy,
  packPolicy,
  confirmationTrust
};

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

const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I build and maintain full-stack features for an online learning platform and diagnose production issues involving React, TypeScript, Node.js APIs, and PostgreSQL. Rent N Roll also gave me direct experience building marketplace and PayMongo webhook workflows.

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
    generatorClaimLeaseMs
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

function makeAutonomous(id, browserState, overrides = {}) {
  const digest = String(id).padStart(64, "0").slice(-64);
  const formStates = new Set([
    "generating",
    "filling",
    "submit_started",
    "confirmed",
    "ambiguous"
  ]);
  const startedStates = new Set(["submit_started", "confirmed", "ambiguous"]);
  const record = normalizeLegacyRecord(
    {
      source: "onlinejobs.ph",
      source_job_id: String(id),
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://onlinejobs.ph/jobseekers/job/private-${id}`,
      row_number: Number(id) % 100 + 2,
      record_version: 1,
      pipeline_status: browserState === "skipped" ? "skip" : "ready_to_apply",
      user_action: "",
      execution_mode: "autonomous_chrome",
      automation_contract_version: "browser-contract-v1",
      autonomous_decision:
        browserState === "skipped"
          ? "skip"
          : ["generating", ...formStates].includes(browserState)
            ? "apply"
            : "",
      browser_state: browserState,
      browser_attempt_id:
        browserState === "queued" || browserState === "skipped"
          ? ""
          : `attempt-v1:${digest}`,
      browser_job_digest: `job-v1:${digest}`,
      browser_context_digest: ["queued", "claimed"].includes(browserState)
        ? ""
        : `context-v1:${digest}`,
      browser_form_fingerprint: formStates.has(browserState)
        ? `form-v1:${digest}`
        : "",
      submission_idempotency_key: "",
      submission_started_at: startedStates.has(browserState)
        ? "2026-07-31T10:56:00.000Z"
        : "",
      submission_confirmed_at:
        browserState === "confirmed" ? "2026-07-31T10:57:00.000Z" : "",
      submission_confirmation_kind:
        browserState === "confirmed" ? "confirmation_page" : "",
      submission_confirmation_reference:
        browserState === "confirmed" ? `confirmation-ref-v1:${digest}` : "",
      submission_confirmation_digest:
        browserState === "confirmed" ? `confirmation-v1:${digest}` : "",
      browser_block_category: browserState === "blocked" ? "captcha" : "",
      source_availability: "active",
      attempt_count: 0,
      alert_attempt_count: 0,
      matched_keywords: ["full stack developer"],
      job_title: `Private role ${id}`,
      company: "Private employer",
      job_description: `PRIVATE JOB DESCRIPTION ${id}`,
      decision_reason: "Private ranking explanation",
      generated_message: `PRIVATE APPLICATION MESSAGE ${id}`,
      application_pack_status: "ready",
      message_validation_status: "valid",
      profile_version: profile.profile_version,
      message_profile_version: profile.profile_version,
      application_pack_profile_version: profile.profile_version,
      policy_version: rankingPolicy.policy_version,
      message_policy_version: applicationPolicy.policy_version,
      application_pack_version: packPolicy.pack_version,
      application_pack_policy_version: packPolicy.policy_version,
      coverage_contract_version: packPolicy.coverage_contract_version,
      message_plan_version: packPolicy.message_plan_version,
      prep_status: "",
      preparation_version: 0,
      preparation_input_guard: "",
      preparation_updated_at: "",
      error_category:
        browserState === "ambiguous" ? "ambiguous_submission" : "",
      error_summary: `PRIVATE BROWSER CONTENT ${id}`,
      posted_at: "2026-07-31T10:00:00.000Z",
      discovered_at: "2026-07-31T10:05:00.000Z",
      generated_at: "2026-07-31T10:55:00.000Z",
      created_at: "2026-07-31T10:05:00.000Z",
      updated_at: "2026-07-31T10:58:00.000Z",
      ...overrides
    },
    schema,
    now
  );
  record.prep_status = "";
  record.preparation_version = 0;
  record.preparation_input_guard = "";
  record.preparation_updated_at = "";
  record.submission_idempotency_key = formStates.has(record.browser_state)
    ? submissionIdempotencyKey(record)
    : "";
  if (record.browser_state === "confirmed") {
    const witness = browserConfirmationWitness(record);
    record.submission_attestation_key_id = confirmationKeyId;
    record.submission_attestation_witness_digest =
      browserConfirmationWitnessDigest(witness);
    record.submission_attestation_signature = sign(
      null,
      Buffer.from(serializeBrowserConfirmationWitness(witness)),
      confirmationKeys.privateKey
    ).toString("base64url");
  }
  record.state_guard = stateGuard(record);
  return record;
}

const autonomousAlertPolicy = {
  ...alertPolicy,
  autonomous_execution_alerts: {
    enabled: true,
    statuses: ["blocked", "ambiguous"],
    maximum_category_characters: 80
  }
};

test("alert policy is bounded and requires safe ready state", () => {
  assert.deepEqual(validateAlertPolicy(alertPolicy), []);
  assert.equal(alertPolicy.eligibility.pipeline_status, "ready_to_apply");
  assert.equal(alertPolicy.eligibility.required_prep_status, "message_ready");
  assert.equal(alertPolicy.eligibility.required_pack_status, "ready");
  assert.equal(alertPolicy.eligibility.required_message_status, "valid");
  assert.ok(alertPolicy.provider_timeout_ms > 0);
  assert.ok(alertPolicy.provider_request_interval_ms > 0);
  assert.ok(alertPolicy.retry.max_attempts > 0);
});

test("autonomous alerts are opt-in and never reuse copy-ready reminders", () => {
  assert.deepEqual(validateAlertPolicy(autonomousAlertPolicy), []);
  for (const record of [
    makeAutonomous(4901, "queued"),
    makeAutonomous(4902, "generating"),
    makeAutonomous(4903, "confirmed")
  ]) {
    assert.equal(alertCategory(record, alertPolicy), "");
    assert.equal(alertCategory(record, autonomousAlertPolicy), "");
  }

  const blocked = makeAutonomous(4904, "blocked");
  assert.equal(alertCategory(blocked, alertPolicy), "");
  assert.equal(alertCategory(blocked, autonomousAlertPolicy), "autonomous_blocked");
});

test("policy-enabled autonomous blocker alerts expose only bounded operational fields", () => {
  const records = [
    makeAutonomous(4910, "blocked"),
    makeAutonomous(4911, "ambiguous")
  ];
  const selected = selectFreshAlertCandidates(
    records,
    schema,
    autonomousAlertPolicy,
    now,
    safetyContext,
    "Scraped Jobs"
  );
  assert.deepEqual(
    selected.candidates.map((entry) => entry.category),
    ["autonomous_blocked", "autonomous_ambiguous"]
  );
  assert.ok(
    selected.candidates.every((entry) => entry.source_store === "Scraped Jobs")
  );

  for (const record of records) {
    const payload = renderSlackAlert(record, autonomousAlertPolicy, {
      reviewUrl: "https://docs.google.com/spreadsheets/d/safe/edit",
      messageSafetyContext: safetyContext
    });
    assert.match(payload.text, /Autonomous application execution needs attention/);
    assert.match(payload.text, new RegExp(`Record: ${record.canonical_job_id}`));
    assert.match(payload.text, /Open Job Pipeline/);
    assert.deepEqual(payload.review_action, {
      mode: "open_only",
      url: "https://docs.google.com/spreadsheets/d/safe/edit"
    });
    assert.deepEqual(payload.source_action, { mode: "open_only", url: "" });
    for (const secret of [
      record.generated_message,
      record.job_description,
      record.decision_reason,
      record.error_summary,
      record.canonical_url
    ]) {
      assert.equal(JSON.stringify(payload).includes(secret), false);
    }
  }
});

test("confirmed autonomous movement is independent of Slack eligibility", () => {
  const confirmed = makeAutonomous(4920, "confirmed", {
    alert_status: "sending",
    alert_idempotency_key: "legacy-copy-ready-alert",
    alert_claim_token: "stale-alert-claim",
    alert_attempt_count: 1,
    alert_last_attempt_at: "2026-07-31T10:00:00.000Z"
  });
  const planned = planAlerterMoverRun(
    businessStores({ "Scraped Jobs": [confirmed] }),
    schema,
    autonomousAlertPolicy,
    now,
    safetyContext
  );
  assert.equal(planned.movement.moves.length, 1);
  assert.equal(planned.movement.moves[0].route_reason, "autonomous_confirmed");
  assert.equal(planned.writes.applied.length, 1);
  assert.equal(planned.writes.applied[0].alert_status, "suppressed");
  assert.equal(planned.writes.applied[0].alert_claim_token, "");
  assert.equal(planned.alerts.candidates.length, 0);
  assert.equal(planned.alerts.state_updates.length, 0);
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

test("preparation states gate copy-ready alerts and emit only bounded distinct reminders", () => {
  const records = Object.fromEntries(
    [
      "pending",
      "preparing",
      "repair_pending",
      "preparation_error",
      "needs_input",
      "external_steps"
    ].map((prepStatus, index) => {
      const record = makeReady(5090 + index, {
        prep_status: prepStatus,
        preparation_version: 2,
        preparation_updated_at: now,
        required_input:
          prepStatus === "needs_input"
            ? "Provide a verified availability window."
            : prepStatus === "external_steps"
              ? "Complete the employer assessment and confirm the result."
              : ""
      });
      record.state_guard = stateGuard(record);
      return [prepStatus, record];
    })
  );
  const selected = selectFreshAlertCandidates(
    Object.values(records),
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.deepEqual(
    selected.candidates.map((entry) => entry.category).sort(),
    ["external_steps_reminder", "needs_input_reminder"]
  );
  for (const status of [
    "pending",
    "preparing",
    "repair_pending",
    "preparation_error"
  ]) {
    assert.equal(alertCategory(records[status], alertPolicy), "");
  }

  for (const status of ["needs_input", "external_steps"]) {
    const record = records[status];
    const payload = renderSlackAlert(record, alertPolicy, {
      reviewUrl: "https://docs.google.com/spreadsheets/d/safe/edit",
      messageSafetyContext: safetyContext
    });
    assert.match(payload.category, /_reminder$/);
    assert.match(payload.text, /No application was submitted/);
    assert.match(payload.text, new RegExp(record.required_input));
    assert.doesNotMatch(payload.text, /copy exactly/i);
    assert.equal(payload.text.includes(record.generated_message), false);
    assert.match(
      payload.idempotency_key,
      new RegExp(`${payload.category}:${record.preparation_version}:prep-v1:`)
    );
  }
});

test("receipt identity suppresses an unchanged reminder but permits one later copy-ready category", () => {
  const needsInput = makeReady(5097, {
    prep_status: "needs_input",
    preparation_version: 3,
    required_input: "Provide a verified start date.",
    preparation_updated_at: now
  });
  needsInput.state_guard = stateGuard(needsInput);
  const sending = markAlertSending(
    needsInput,
    alertPolicy,
    "reminder-run",
    now
  );
  const sent = applySlackProviderResult(
    sending,
    sending,
    { statusCode: 200, reference: "reminder-accepted" },
    alertPolicy,
    "2026-07-31T11:01:00.000Z"
  );
  const unchanged = selectFreshAlertCandidates(
    [sent],
    schema,
    alertPolicy,
    "2026-07-31T11:02:00.000Z",
    safetyContext
  );
  assert.equal(unchanged.candidates.length, 0);
  assert.ok(unchanged.rejected[0].reasons.includes("already_sent"));

  const ready = {
    ...sent,
    prep_status: "message_ready",
    preparation_version: sent.preparation_version + 1,
    preparation_input_guard: `prep-v1:${"d".repeat(64)}`,
    preparation_updated_at: "2026-07-31T11:03:00.000Z",
    required_input: ""
  };
  ready.state_guard = stateGuard(ready);
  assert.notEqual(
    alertIdempotencyKey(ready, alertPolicy),
    sent.alert_idempotency_key
  );
  const later = selectFreshAlertCandidates(
    [ready],
    schema,
    alertPolicy,
    "2026-07-31T11:04:00.000Z",
    safetyContext
  );
  assert.equal(later.candidates.length, 1);
  assert.equal(later.candidates[0].category, "copy_ready");
  assert.equal(
    markAlertSending(ready, alertPolicy, "copy-ready-run", now)
      .alert_attempt_count,
    1
  );
});

test("an active send blocks a newer preparation category until ambiguity is resolved", () => {
  const reminder = makeReady(5009, {
    prep_status: "needs_input",
    required_input: "Confirm your desired schedule.",
    generated_message: "",
    message_validation_status: "",
    message_profile_version: "",
    message_policy_version: "",
    generated_at: ""
  });
  reminder.state_guard = stateGuard(reminder);
  const sending = markAlertSending(
    reminder,
    alertPolicy,
    "reminder-in-flight",
    now
  );
  const changed = makeReady(5009, {
    alert_status: sending.alert_status,
    alert_idempotency_key: sending.alert_idempotency_key,
    alert_claim_token: sending.alert_claim_token,
    alert_attempt_count: sending.alert_attempt_count,
    alert_last_attempt_at: sending.alert_last_attempt_at,
    preparation_version: sending.preparation_version + 1,
    preparation_updated_at: "2026-07-31T10:01:00.000Z"
  });
  changed.state_guard = stateGuard(changed);
  const selected = selectFreshAlertCandidates(
    [changed],
    schema,
    alertPolicy,
    "2026-07-31T10:02:00.000Z",
    safetyContext
  );
  assert.equal(selected.candidates.length, 0);
  assert.match(selected.rejected[0].reasons.join(";"), /retry_not_due/);
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
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: "",
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
  assert.deepEqual(plan.preparation_status_counts, {});
  const summary = summarizeAlerterMoverRun({
    plan,
    sheetReadRequests: 1,
    providerClassifications: ["accepted", "accepted"]
  });
  assert.equal(summary.execution_classification, "no_eligible_work");
  assert.equal(summary.sheet_read_request_count, 1);
  assert.deepEqual(summary.preparation_status_counts, {});
  assert.ok(summary.sheet_read_request_count <= 2);
  assert.deepEqual(summary.provider_classifications, ["accepted"]);
});

test("phase summaries expose bounded preparation-state counts without content", () => {
  const ready = makeReady(5012);
  const needsInput = makeReady(5013, {
    prep_status: "needs_input",
    generated_message: "",
    message_validation_status: "",
    message_profile_version: "",
    message_policy_version: "",
    generated_at: "",
    required_input: "Provide a verified start date."
  });
  ready.state_guard = stateGuard(ready);
  needsInput.state_guard = stateGuard(needsInput);
  const plan = planAlerterMoverPhases(
    businessStores({ "To Apply": [ready, needsInput] }),
    schema,
    alertPolicy,
    now,
    { movementPerRunCap: 25 }
  );
  assert.deepEqual(plan.preparation_status_counts, {
    message_ready: 1,
    needs_input: 1
  });
  const summary = summarizeAlerterMoverRun({ plan });
  assert.deepEqual(summary.preparation_status_counts, {
    message_ready: 1,
    needs_input: 1
  });
  assert.equal(JSON.stringify(summary).includes(ready.generated_message), false);
  assert.equal(JSON.stringify(summary).includes(needsInput.required_input), false);
});

test("movement phases identify only touched stores and retain the six-read budget", () => {
  const review = makeReady(5014, {
    pipeline_status: "review_needed",
    user_action: "",
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: ""
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

test("persisted alert preselection is context-lazy and unrelated ownership conflicts fail closed", () => {
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
          "To Apply": [{ ...ready }],
          Archive: [{ ...ready, archive_reason: "user_skip" }]
        }),
        schema,
        alertPolicy,
        now
      ),
    /ambiguous business ownership/
  );

  const idleDuplicate = makeReady(5017, {
    pipeline_status: "new",
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: "",
    application_pack_status: "",
    message_validation_status: "",
    generated_message: "",
    generated_at: ""
  });
  idleDuplicate.state_guard = stateGuard(idleDuplicate);
  const duplicateReady = makeReady(5017);
  assert.throws(
    () =>
      planAlerterMoverPhases(
        businessStores({
          "Scraped Jobs": [idleDuplicate],
          "To Apply": [duplicateReady]
        }),
        schema,
        alertPolicy,
        now
      ),
    /ambiguous business ownership/
  );
});

test("phase planning recovers a persisted destination copy through guarded deletion", () => {
  const source = makeReady(5016, { user_action: "I Applied" });
  const first = planAlerterMoverPhases(
    businessStores({ "To Apply": [source] }),
    schema,
    alertPolicy,
    now
  );
  const destination = first.movement.moves[0].destination_record;
  const recovery = planAlerterMoverPhases(
    businessStores({
      "To Apply": [source],
      "Applied Jobs": [destination]
    }),
    schema,
    alertPolicy,
    now
  );
  assert.equal(recovery.movement.moves.length, 1);
  assert.equal(recovery.movement.moves[0].write_required, false);
  assert.equal(recovery.movement.moves[0].recovery_required, true);
  assert.equal(recovery.movement.moves[0].destination, "Applied Jobs");
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

  const directSheetEdit = {
    ...sending,
    user_action: "I Applied"
  };
  assert.equal(
    directSheetEdit.state_guard,
    stateGuard(directSheetEdit),
    "operator actions intentionally do not require a guard-cell edit"
  );
  assert.throws(
    () =>
      applySlackProviderResult(
        directSheetEdit,
        sending,
        { ok: true },
        alertPolicy,
        now
      ),
    /stale To Apply state/
  );

  for (const [field, value] of Object.entries({
    generated_message: "Directly edited outbound message",
    job_title: "Directly edited Slack title"
  })) {
    assert.throws(
      () =>
        applySlackProviderResult(
          {
            ...sending,
            [field]: value,
            state_guard: sending.state_guard
          },
          sending,
          { ok: true },
          alertPolicy,
          now
        ),
      /stale To Apply state/,
      field
    );
  }
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
        /message|pack|invalid_record/.test(reason)
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
