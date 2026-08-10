import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_EXECUTOR_PROTOCOL_VERSION,
  browserContextDigest,
  browserFormFingerprint,
  browserJobDigest,
  commitBrowserResult,
  confirmAutonomousClaim,
  confirmBrowserReady,
  confirmSubmitIntent,
  planAutonomousClaim,
  planSubmitIntent,
  recoverBrowserRecord,
  sanitizeBrowserEvidence,
  selectAutonomousCandidates,
  submissionIdempotencyKey,
  validateAutonomousDecision
} from "../src/browser-executor.mjs";
import {
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  browserConfirmationPublicKeyDigest,
  serializeBrowserConfirmationWitness
} from "../src/browser-confirmation-attestation.mjs";
import {
  normalizeLegacyRecord,
  stateGuard
} from "../src/contracts.mjs";
import {
  confirmMoveDeletions,
  destinationWrites,
  planQueueActions
} from "../src/movement.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [schema, profile, rankingPolicy, applicationPolicy, packPolicy] =
  await Promise.all([
    loadJson("../config/pipeline-schema.json"),
    loadJson("../config/candidate-profile.json"),
    loadJson("../config/ranking-policy.json"),
    loadJson("../config/application-policy.json"),
    loadJson("../config/application-pack-policy.json")
  ]);

const now = "2026-08-10T02:00:00.000Z";
const confirmationKeyId = "test-browser-history-adapter-v1";
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
function valueDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function withConfirmationAttestation(record, result) {
  const witness = browserConfirmationWitness(record, result);
  return {
    ...result,
    confirmation_attestation: {
      algorithm: "ed25519",
      key_id: confirmationKeyId,
      witness_digest: browserConfirmationWitnessDigest(witness),
      signature: sign(
        null,
        Buffer.from(serializeBrowserConfirmationWitness(witness)),
        confirmationKeys.privateKey
      ).toString("base64url")
    }
  };
}
const form = {
  origin: "https://www.onlinejobs.ph",
  page_url: "https://www.onlinejobs.ph/jobseekers/job/example-9001",
  observed_source_job_id: "9001",
  action: "/jobseekers/job/9001/apply",
  method: "POST",
  fields: [
    { name: "message", type: "textarea", required: true, maximum_length: 4000 },
    {
      name: "apply_points",
      type: "select",
      required: true,
      options_digest: valueDigest([5, 10])
    },
    { name: "submit", type: "submit", required: false }
  ],
  apply_points: 5,
  apply_point_options: [5, 10]
};
const formFor = (sourceJobId) => ({
  ...form,
  page_url: `https://www.onlinejobs.ph/jobseekers/job/example-${sourceJobId}`,
  observed_source_job_id: sourceJobId,
  action: `/jobseekers/job/${sourceJobId}/apply`
});
const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I build and maintain full-stack features for an online learning platform, including admin workflows, personalized study programs, eBook and reader access, review reminders, and subscription-based access.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

function autonomousRecord(id = "9001", overrides = {}) {
  const raw = normalizeLegacyRecord(
    {
      source: "onlinejobs.ph",
      source_job_id: id,
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://www.onlinejobs.ph/jobseekers/job/example-${id}`,
      job_title: "Full-Stack TypeScript Developer",
      company: "Example Company",
      job_description:
        "Build and maintain React and TypeScript features with Node.js APIs and PostgreSQL for a production web application.",
      salary_text: "",
      posted_at: "2026-08-10T01:00:00.000Z",
      discovered_at: "2026-08-10T01:10:00.000Z",
      last_seen_at: "2026-08-10T01:10:00.000Z",
      matched_keywords: ["full stack developer"],
      source_availability: "active",
      pipeline_status: "new",
      user_action: "",
      execution_mode: "autonomous_chrome",
      automation_contract_version: BROWSER_AUTOMATION_CONTRACT_VERSION,
      autonomous_decision: "",
      browser_state: "queued",
      browser_job_digest: `job-v1:${"0".repeat(64)}`,
      record_version: 1,
      attempt_count: 0,
      alert_attempt_count: 0,
      preparation_version: 0,
      created_at: "2026-08-10T01:10:00.000Z",
      updated_at: "2026-08-10T01:10:00.000Z",
      ...overrides
    },
    schema,
    now
  );
  raw.browser_job_digest = browserJobDigest(raw);
  raw.state_guard = stateGuard(raw);
  return raw;
}

function fillingRecord(overrides = {}) {
  const base = autonomousRecord("9001", {
    browser_state: "filling",
    autonomous_decision: "apply",
    browser_attempt_id: `attempt-v1:${"1".repeat(64)}`,
    browser_form_fingerprint: "",
    pipeline_status: "ready_to_apply",
    profile_version: profile.profile_version,
    policy_version: rankingPolicy.policy_version,
    message_profile_version: profile.profile_version,
    message_policy_version: applicationPolicy.policy_version,
    generated_message: validMessage,
    message_validation_status: "valid",
    application_pack_status: "ready",
    application_pack_profile_version: profile.profile_version,
    application_pack_version: packPolicy.pack_version,
    application_pack_policy_version: packPolicy.policy_version,
    coverage_contract_version: packPolicy.coverage_contract_version,
    message_plan_version: packPolicy.message_plan_version,
    processing_stage: "browser_executor",
    processing_token: "execution:browser",
    processing_started_at: now
  });
  base.prep_status = "";
  base.browser_context_digest = browserContextDigest({
    record: base,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  base.browser_form_fingerprint = browserFormFingerprint(form, base);
  base.submission_idempotency_key = submissionIdempotencyKey(base);
  Object.assign(base, overrides);
  base.state_guard = stateGuard(base);
  return base;
}

function persistedBrowserClaim(record, overrides = {}) {
  return {
    claim_key: `browser_executor:${record.canonical_job_id}:application`,
    canonical_job_id: record.canonical_job_id,
    stage: "browser_executor",
    token: record.processing_token,
    created_at: record.processing_started_at,
    expires_at: "2026-08-10T02:10:00.000Z",
    row_number: 2,
    ...overrides
  };
}

const submitConfiguration = (record, overrides = {}) => ({
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy,
  persistedClaims: [persistedBrowserClaim(record)],
  now,
  ...overrides
});

test("selection validates global ownership and has no daily or per-run cap", () => {
  const rows = Array.from({ length: 7 }, (_, index) =>
    autonomousRecord(String(9100 + index))
  );
  const stores = {
    "Scraped Jobs": rows,
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: []
  };
  assert.equal(
    selectAutonomousCandidates(stores, schema, {
      now,
      deadline_ms: Date.parse(now) + 300_000,
      minimum_headroom_ms: 60_000
    }).length,
    7
  );
  assert.throws(
    () =>
      selectAutonomousCandidates(
        { ...stores, Archive: [rows[0]] },
        schema,
        { now }
      ),
    /duplicate canonical identity/
  );
  assert.deepEqual(
    selectAutonomousCandidates(stores, schema, {
      now,
      deadline_ms: Date.parse(now) + 10,
      minimum_headroom_ms: 60_000
    }),
    []
  );
});

test("claim context is disclosed only after append-winner and exact reread", () => {
  const record = autonomousRecord();
  const plan = planAutonomousClaim(record, {
    execution_id: "execution-1",
    attempt_id: `attempt-v1:${"2".repeat(64)}`,
    now,
    lease_ms: 600_000
  });
  assert.equal(plan.proposed_record.browser_state, "claimed");
  assert.equal("job" in plan, false);
  const configuration = {
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  };
  assert.throws(
    () =>
      confirmAutonomousClaim(
        plan,
        {
          persisted_claims: [],
          fresh_source_rows: [plan.proposed_record],
          schema,
          now
        },
        configuration
      ),
    /did not win contention/
  );
  const confirmed = confirmAutonomousClaim(
    plan,
    {
      persisted_claims: [{ ...plan.system_claim, row_number: 2 }],
      fresh_source_rows: [plan.proposed_record],
      schema,
      now
    },
    configuration
  );
  assert.equal(confirmed.proposed_record.browser_state, "evaluating");
  assert.equal(confirmed.profile.profile_version, profile.profile_version);
  assert.match(confirmed.context_digest, /^context-v1:[a-f0-9]{64}$/);
  assert.equal(
    confirmed.proposed_record.browser_context_digest,
    confirmed.context_digest
  );
});

test("low-fit work is skipped deterministically and ambiguous jobs cannot be model-skipped", () => {
  const lowFit = autonomousRecord("9201", {
    job_title: "Senior Medical Director",
    job_description:
      "Must hold a medical degree and ten years of clinical leadership experience directing hospital programs."
  });
  const evaluating = {
    ...lowFit,
    browser_state: "evaluating",
    browser_attempt_id: `attempt-v1:${"3".repeat(64)}`,
    processing_stage: "browser_executor",
    processing_token: "execution:browser",
    processing_started_at: now
  };
  evaluating.browser_job_digest = browserJobDigest(evaluating);
  evaluating.state_guard = stateGuard(evaluating);
  const context = browserContextDigest({
    record: evaluating,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  evaluating.browser_context_digest = context;
  evaluating.state_guard = stateGuard(evaluating);
  const result = validateAutonomousDecision(
    evaluating,
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      attempt_id: evaluating.browser_attempt_id,
      context_digest: context,
      decision: "skip",
      reason_code: "deterministically_unsupported"
    },
    {
      profile,
      rankingPolicy,
      applicationPolicy,
      packPolicy,
      context_digest: context,
      form: formFor("9250")
    },
    now
  );
  assert.equal(result.proposed_record.browser_state, "skipped");
  assert.equal(result.proposed_record.user_action, "");

  const ambiguous = autonomousRecord("9202", {
    job_description: "Build React products. ".repeat(3000),
    browser_state: "evaluating",
    browser_attempt_id: `attempt-v1:${"4".repeat(64)}`,
    processing_stage: "browser_executor",
    processing_token: "execution:browser",
    processing_started_at: now
  });
  ambiguous.browser_job_digest = browserJobDigest(ambiguous);
  ambiguous.state_guard = stateGuard(ambiguous);
  const ambiguousContext = browserContextDigest({
    record: ambiguous,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  ambiguous.browser_context_digest = ambiguousContext;
  ambiguous.state_guard = stateGuard(ambiguous);
  assert.throws(
    () =>
      validateAutonomousDecision(
        ambiguous,
        {
          protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
          attempt_id: ambiguous.browser_attempt_id,
          context_digest: ambiguousContext,
          decision: "skip",
          reason_code: "model_preference"
        },
        {
          profile,
          rankingPolicy,
          applicationPolicy,
          packPolicy,
          context_digest: ambiguousContext,
          form: formFor("9250")
        },
        now
      ),
    /cannot skip an eligible or ambiguous job/
  );
});

test("eligible ChatGPT drafts are recomputed, validated, and bound to the form", () => {
  const evaluating = autonomousRecord("9250", {
    browser_state: "evaluating",
    browser_attempt_id: `attempt-v1:${"5".repeat(64)}`,
    processing_stage: "browser_executor",
    processing_token: "execution:browser",
    processing_started_at: now
  });
  evaluating.browser_job_digest = browserJobDigest(evaluating);
  evaluating.state_guard = stateGuard(evaluating);
  const context = browserContextDigest({
    record: evaluating,
    profile,
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
  evaluating.browser_context_digest = context;
  evaluating.state_guard = stateGuard(evaluating);
  const result = validateAutonomousDecision(
    evaluating,
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      attempt_id: evaluating.browser_attempt_id,
      context_digest: context,
      decision: "apply",
      reason_code: "recommended",
      message: validMessage
    },
    {
      profile,
      rankingPolicy,
      applicationPolicy,
      packPolicy,
      context_digest: context,
      form: formFor("9250")
    },
    now
  );
  assert.equal(result.proposed_record.browser_state, "generating");
  assert.equal(result.proposed_record.application_pack_status, "ready");
  assert.equal(result.proposed_record.message_validation_status, "valid");
  assert.equal(
    result.proposed_record.submission_idempotency_key,
    submissionIdempotencyKey(result.proposed_record)
  );
  assert.equal(result.proposed_record.review_approved_at || "", "");
  assert.equal(result.proposed_record.user_action, "");
  assert.throws(
    () =>
      confirmBrowserReady(
        result.proposed_record,
        [result.proposed_record],
        { profile, rankingPolicy, applicationPolicy, packPolicy, persistedClaims: [] },
        now
      ),
    /claim is expired, lost, or not the winner/
  );
  const fillPlan = confirmBrowserReady(
    result.proposed_record,
    [result.proposed_record],
    {
      profile,
      rankingPolicy,
      applicationPolicy,
      packPolicy,
      persistedClaims: [persistedBrowserClaim(result.proposed_record)]
    },
    now
  );
  const fillCapability = confirmBrowserReady(
    fillPlan.proposed_record,
    [fillPlan.proposed_record],
    {
      profile,
      rankingPolicy,
      applicationPolicy,
      packPolicy,
      persistedClaims: [persistedBrowserClaim(fillPlan.proposed_record)]
    },
    now
  );
  assert.equal(fillCapability.capability, "fill_application_form");

  assert.throws(
    () =>
      validateAutonomousDecision(
        evaluating,
        {
          protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
          attempt_id: evaluating.browser_attempt_id,
          context_digest: context,
          decision: "apply",
          reason_code: "recommended",
          message: `${validMessage}\nI have ten years of Kubernetes leadership.`
        },
        {
          profile,
          rankingPolicy,
          applicationPolicy,
          packPolicy,
          context_digest: context,
          form: formFor("9250")
        },
        now
      ),
    /ChatGPT message is invalid/
  );
});

test("submit intent must be persisted and reread before one-click capability", () => {
  const filling = fillingRecord();
  const plan = planSubmitIntent(filling, {
    form,
    field_receipts: [
      { name: "message", value_digest: valueDigest(filling.generated_message) },
      { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
    ],
    now
  });
  assert.equal(plan.proposed_record.browser_state, "submit_started");
  assert.equal("capability" in plan, false);
  assert.throws(
    () => confirmSubmitIntent(plan, [filling], submitConfiguration(filling)),
    /persistence mismatch/
  );
  const authorization = confirmSubmitIntent(
    plan,
    [plan.proposed_record],
    submitConfiguration(plan.proposed_record)
  );
  assert.equal(authorization.capability, "click_application_submit_once");
  assert.equal(
    authorization.submission_idempotency_key,
    filling.submission_idempotency_key
  );
});

test("post-click confirmation is exact and uncertainty cannot be recovered blindly", () => {
  const filling = fillingRecord();
  const intent = planSubmitIntent(filling, {
    form,
    field_receipts: [
      { name: "message", value_digest: valueDigest(filling.generated_message) },
      { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
    ],
    now
  }).proposed_record;
  const authorization = confirmSubmitIntent(
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      proposed_record: intent
    },
    [intent],
    submitConfiguration(intent)
  );
  const confirmationReference = "application/receipt-9001";
  const confirmedResult = withConfirmationAttestation(intent, {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: intent.browser_attempt_id,
    job_digest: intent.browser_job_digest,
    form_fingerprint: intent.browser_form_fingerprint,
    submission_idempotency_key: intent.submission_idempotency_key,
    authorization_digest: authorization.authorization_digest,
    result: "confirmed",
    evidence: {
      category: "submission_confirmed",
      observed_at: now,
      reference_digest: valueDigest(confirmationReference)
    },
    confirmation_kind: "confirmation_page",
    confirmation_reference: confirmationReference,
    observed_source_job_id: "9001",
    observed_canonical_url: form.page_url
  });
  assert.throws(
    () =>
      commitBrowserResult(
        intent,
        { ...confirmedResult, confirmation_attestation: undefined },
        "2026-08-10T02:01:00.000Z",
        schema,
        confirmationTrust
      ),
    /trusted independent adapter attestation/
  );
  assert.throws(
    () =>
      commitBrowserResult(
        intent,
        confirmedResult,
        "2026-08-10T02:01:00.000Z",
        schema,
        {
          ...confirmationTrust,
          publicKey: confirmationKeys.privateKey.export({
            type: "pkcs8",
            format: "pem"
          })
        }
      ),
    /trusted independent adapter attestation/
  );
  const confirmed = commitBrowserResult(
    intent,
    confirmedResult,
    "2026-08-10T02:01:00.000Z",
    schema,
    confirmationTrust
  );
  assert.equal(confirmed.browser_state, "confirmed");
  assert.match(confirmed.submission_confirmation_reference, /^confirmation-ref-v1:/);
  assert.match(confirmed.submission_confirmation_digest, /^confirmation-v1:/);

  const source = { ...confirmed, row_number: 2 };
  const emptyStores = {
    "Scraped Jobs": [source],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: []
  };
  const movement = planQueueActions(
    emptyStores,
    schema,
    "2026-08-10T02:02:00.000Z",
    { profile, applicationPolicy, packPolicy, confirmationTrust }
  );
  assert.deepEqual(movement.rejected, []);
  assert.equal(movement.moves.length, 1);
  const destination = {
    ...destinationWrites(movement).applied[0],
    row_number: 2
  };
  const confirmation = confirmMoveDeletions(
    movement,
    {
      ...emptyStores,
      "Applied Jobs": [destination]
    },
    schema,
    confirmationTrust
  );
  assert.deepEqual(confirmation.rejected, []);
  assert.deepEqual(confirmation.deletions, [
    {
      row_number: 2,
      canonical_job_id: source.canonical_job_id,
      source_sheet: "Scraped Jobs",
      destination: "Applied Jobs"
    }
  ]);

  const ambiguous = commitBrowserResult(
    intent,
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      attempt_id: intent.browser_attempt_id,
      job_digest: intent.browser_job_digest,
      form_fingerprint: intent.browser_form_fingerprint,
      submission_idempotency_key: intent.submission_idempotency_key,
      authorization_digest: authorization.authorization_digest,
      result: "ambiguous",
      evidence: {
        category: "submission_uncertain",
        summary: "Navigation changed without bounded confirmation",
        observed_at: now
      }
    },
    "2026-08-10T02:01:00.000Z",
    schema
  );
  assert.throws(
    () =>
      recoverBrowserRecord(ambiguous, {
        now: "2026-08-10T02:02:00.000Z",
        retry_at: "2026-08-10T02:10:00.000Z",
        evidence: { category: "transient_browser_failure" }
      }, schema),
    /cannot be retried/
  );

  const reconciledReference = "application/history-9001";
  const reconciledResult = {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: ambiguous.browser_attempt_id,
    job_digest: ambiguous.browser_job_digest,
    form_fingerprint: ambiguous.browser_form_fingerprint,
    submission_idempotency_key: ambiguous.submission_idempotency_key,
    authorization_digest: authorization.authorization_digest,
    result: "confirmed",
    evidence: {
      category: "submission_confirmed",
      observed_at: "2026-08-10T02:02:00.000Z",
      reference_digest: valueDigest(reconciledReference)
    },
    confirmation_kind: "application_history",
    confirmation_reference: reconciledReference,
    observed_source_job_id: "9001",
    observed_canonical_url: form.page_url
  };
  const reconciled = commitBrowserResult(
    ambiguous,
    withConfirmationAttestation(ambiguous, reconciledResult),
    "2026-08-10T02:03:00.000Z",
    schema,
    confirmationTrust
  );
  assert.equal(reconciled.browser_state, "confirmed");
});

test("click and confirmation authority require live claims, current config, and exact evidence", () => {
  const filling = fillingRecord();
  assert.throws(
    () =>
      planSubmitIntent(filling, {
        form,
        field_receipts: [
          { name: "message", value_digest: valueDigest("wrong value") },
          { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
        ],
        now
      }),
    /does not match the authorized message/
  );
  const plan = planSubmitIntent(filling, {
    form,
    field_receipts: [
      { name: "message", value_digest: valueDigest(filling.generated_message) },
      { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
    ],
    now
  });
  assert.throws(
    () =>
      confirmSubmitIntent(plan, [plan.proposed_record], {
        ...submitConfiguration(plan.proposed_record),
        persistedClaims: []
      }),
    /claim is expired, lost, or not the winner/
  );
  assert.throws(
    () =>
      confirmSubmitIntent(plan, [plan.proposed_record], {
        ...submitConfiguration(plan.proposed_record),
        profile: { ...profile, profile_version: "stale-profile" }
      }),
    /configuration is stale/
  );

  const authorization = confirmSubmitIntent(
    plan,
    [plan.proposed_record],
    submitConfiguration(plan.proposed_record)
  );
  assert.throws(
    () =>
      commitBrowserResult(
        plan.proposed_record,
        {
          protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
          attempt_id: plan.proposed_record.browser_attempt_id,
          job_digest: plan.proposed_record.browser_job_digest,
          form_fingerprint: plan.proposed_record.browser_form_fingerprint,
          submission_idempotency_key:
            plan.proposed_record.submission_idempotency_key,
          authorization_digest: authorization.authorization_digest,
          result: "confirmed",
          evidence: {
            category: "navigation_failed",
            observed_at: now,
            reference_digest: "a".repeat(64)
          },
          confirmation_kind: "confirmation_page",
          confirmation_reference: "application/receipt-9001",
          observed_source_job_id: "different-job",
          observed_canonical_url: form.page_url
        },
        "2026-08-10T02:01:00.000Z",
        schema
      ),
    /evidence does not match its lifecycle state|bounded evidence identity/
  );
});

test("executor rejects wrong-job forms and illegal terminal recovery", () => {
  const record = fillingRecord();
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          page_url: "https://www.onlinejobs.ph/jobseekers/job/example-9999",
          observed_source_job_id: "9999",
          action: "/jobseekers/job/9999/apply"
        },
        record
      ),
    /match the claimed OnlineJobs\.ph job/
  );
  const one = {
    ...fillingRecord(),
    source_job_id: "1",
    canonical_job_id: "onlinejobs.ph:1",
    canonical_url: "https://www.onlinejobs.ph/jobseekers/job/example-1"
  };
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...formFor("1"),
          action: "/jobseekers/job/9001/apply"
        },
        one
      ),
    /match the claimed OnlineJobs\.ph job/
  );
  const blocked = { ...record, browser_state: "blocked" };
  blocked.state_guard = stateGuard(blocked);
  assert.throws(
    () =>
      recoverBrowserRecord(
        blocked,
        {
          now,
          retry_at: "2026-08-10T02:05:00.000Z",
          evidence: {
            category: "transient_browser_failure",
            observed_at: now
          }
        },
        schema
      ),
    /not recoverable/
  );
});

test("form fingerprints and evidence fail closed without leaking secrets", () => {
  assert.match(
    browserFormFingerprint({
      ...form,
      origin: "https://onlinejobs.ph",
      page_url: "https://onlinejobs.ph/jobseekers/job/example-9001",
      action: "https://onlinejobs.ph/jobseekers/job/9001/apply"
    }, fillingRecord()),
    /^form-v1:/
  );
  assert.throws(
    () =>
      browserFormFingerprint({
        ...form,
        action: "https://employer.example/apply"
      }, fillingRecord()),
    /match the claimed OnlineJobs\.ph job/
  );
  assert.throws(
    () => browserFormFingerprint({ ...form, extra: true }, fillingRecord()),
    /unsupported: extra/
  );
  const evidence = sanitizeBrowserEvidence({
    category: "login_required",
    summary:
      "authorization=Bearer abc123 cookie=session-secret https://private.example/path"
  });
  assert.equal(evidence.summary, "Browser result: login required");
  assert.doesNotMatch(JSON.stringify(evidence), /abc123|session-secret|private\.example/);
});

test("CLI accepts only strict stdin operations and selects one record at a time", () => {
  const script = fileURLToPath(
    new URL("../scripts/browser-executor.mjs", import.meta.url)
  );
  const stores = {
    "Scraped Jobs": [],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: []
  };
  const valid = spawnSync(process.execPath, [script, "select"], {
    input: JSON.stringify({ stores, now }),
    encoding: "utf8"
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    candidate: null,
    due_count: 0
  });
  const invalid = spawnSync(process.execPath, [script, "select"], {
    input: JSON.stringify({ stores, now, generated_message: "private" }),
    encoding: "utf8"
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unsupported: generated_message/);
  assert.doesNotMatch(invalid.stderr, /private/);
});
