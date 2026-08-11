import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_EXECUTOR_PROTOCOL_VERSION,
  bindObservedJobContext,
  browserClickReceiptStoreProvisioning,
  browserContextDigest,
  browserFormFingerprint,
  browserJobDigest,
  commitBrowserResult,
  confirmAutonomousClaim,
  confirmBrowserReady,
  confirmSubmitIntent,
  planAutonomousClaim,
  planSubmitIntent as planSubmitIntentWithPolicy,
  reconcileBrowserResult,
  recoverBrowserRecord,
  sanitizeBrowserEvidence,
  selectAutonomousCandidates,
  selectAutonomousWork,
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
  browserSubmitAuthorizationDigest,
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
const [schema, profile, rankingPolicy, applicationPolicy, packPolicy, browserTask] =
  await Promise.all([
    loadJson("../config/pipeline-schema.json"),
    loadJson("../config/candidate-profile.json"),
    loadJson("../config/ranking-policy.json"),
    loadJson("../config/application-policy.json"),
    loadJson("../config/application-pack-policy.json"),
    loadJson("../config/browser-executor-task.json")
  ]);
const browserRuntime = browserTask.runtime;
const configuration = { profile, rankingPolicy, applicationPolicy, packPolicy };
const receiptDirectories = [];
const testClickStoreId = `browser-click-store-v1:${"a".repeat(64)}`;
const testClickLedgerId = `browser-click-ledger-v1:${"b".repeat(64)}`;
const testClickGenerationId = `browser-click-generation-v1:${"c".repeat(64)}`;
function clickReceiptStore() {
  const root = mkdtempSync(join(tmpdir(), "job-pipeline-click-receipt-"));
  const directory = join(root, "store");
  const witnessPath = join(root, "witness.json");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(witnessPath, "", { encoding: "utf8", mode: 0o600 });
  receiptDirectories.push(root);
  const provisioning = browserClickReceiptStoreProvisioning({
    directory,
    witness_path: witnessPath,
    store_id: testClickStoreId,
    ledger_id: testClickLedgerId,
    generation_id: testClickGenerationId,
    created_at: "2026-08-10T00:00:00.000Z"
  });
  writeFileSync(
    join(directory, "manifest.json"),
    provisioning.manifest_source,
    { encoding: "utf8", mode: 0o600 }
  );
  writeFileSync(
    join(directory, "consumed.ndjson"),
    provisioning.ledger_source,
    { encoding: "utf8", mode: 0o600 }
  );
  writeFileSync(witnessPath, provisioning.witness_source, {
    encoding: "utf8",
    mode: 0o600
  });
  return {
    directory,
    witness_path: witnessPath,
    store_id: testClickStoreId,
    ledger_id: testClickLedgerId,
    generation_id: testClickGenerationId,
    manifest_sha256: provisioning.manifest_sha256,
    directory_binding_digest:
      provisioning.manifest.directory_binding_digest,
    directory_identity: provisioning.directory_identity,
    witness_identity: provisioning.witness_identity
  };
}
test.after(() => {
  for (const directory of receiptDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
function assertSecretFreeTimestampFailure(operation) {
  assert.throws(operation, (error) => {
    assert.match(error.message, /must be an ISO timestamp/);
    assert.doesNotMatch(String(error.stack), /session-secret/);
    return true;
  });
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
  effective_action: "https://www.onlinejobs.ph/jobseekers/job/9001/apply",
  effective_method: "POST",
  submit_control: {
    name: "submit",
    type: "submit",
    effective_action:
      "https://www.onlinejobs.ph/jobseekers/job/9001/apply",
    effective_method: "POST",
    value_digest: valueDigest("Apply")
  },
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
  effective_action:
    `https://www.onlinejobs.ph/jobseekers/job/${sourceJobId}/apply`,
  submit_control: {
    ...form.submit_control,
    effective_action:
      `https://www.onlinejobs.ph/jobseekers/job/${sourceJobId}/apply`
  }
});
const liveFormFor = (sourceJobId) => ({
  origin: "https://www.onlinejobs.ph",
  page_url:
    `https://www.onlinejobs.ph/jobseekers/job/example-${sourceJobId}`,
  observed_source_job_id: sourceJobId,
  effective_action: "https://www.onlinejobs.ph/apply",
  effective_method: "POST",
  submit_control: {
    name: "op",
    type: "submit",
    effective_action: "https://www.onlinejobs.ph/apply",
    effective_method: "POST",
    value_digest: valueDigest("SEND EMAIL")
  },
  fields: [
    { name: "csrf-token", type: "hidden", required: false },
    { name: "info[name]", type: "hidden", required: false },
    { name: "info[email]", type: "hidden", required: false },
    {
      name: "info[subject]",
      id: "subject",
      type: "text",
      required: true
    },
    {
      name: "info[message]",
      id: "message",
      type: "textarea",
      required: true
    },
    {
      name: "",
      id: "contact-info-content",
      type: "textarea",
      required: false
    },
    { name: "points", type: "text", required: false },
    { name: "op", type: "submit", required: false },
    { name: "contact_email", type: "hidden", required: false },
    { name: "email_sent_count_today", type: "hidden", required: false },
    { name: "back_id", type: "hidden", required: false },
    { name: "sent_to_e_id", type: "hidden", required: false },
    { name: "job_id", type: "hidden", required: false }
  ],
  apply_points: 5,
  apply_points_balance: 55
});
const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I build and maintain full-stack features for an online learning platform, including admin workflows, personalized study programs, eBook and reader access, review reminders, and subscription-based access.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;
const validApplicationSubject =
  "Full-Stack TypeScript Developer Application — John Lester Escarlan";
const validApplicationBody = validMessage
  .split(/\r?\n/)
  .slice(1)
  .join("\n")
  .trim();

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

function browserClaimKey(record) {
  return `browser_executor:${String(record.canonical_job_id).toLowerCase()}:application`;
}

function browserClaimToken(record) {
  return `execution-browser:${browserClaimKey(record)}`;
}

const fieldReceiptsFor = (record, currentForm = form) => [
  { name: "message", value_digest: valueDigest(record.generated_message) },
  {
    name: "apply_points",
    value_digest: valueDigest(String(currentForm.apply_points))
  }
];

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
    apply_points_recommendation: "normal_allocation",
    coverage_contract_version: packPolicy.coverage_contract_version,
    message_plan_version: packPolicy.message_plan_version,
    processing_stage: "browser_executor",
    processing_token: "",
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
  const hasExplicitProcessingToken = Object.hasOwn(overrides, "processing_token");
  Object.assign(base, overrides);
  if (!hasExplicitProcessingToken) {
    base.processing_token = browserClaimToken(base);
  }
  base.state_guard = stateGuard(base);
  return base;
}

function persistedBrowserClaim(record, overrides = {}) {
  return {
    claim_key: browserClaimKey(record),
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
  ...configuration,
  persistedClaims: [persistedBrowserClaim(record)],
  runtime: browserRuntime,
  receiptStore: clickReceiptStore(),
  form,
  fieldReceipts: fieldReceiptsFor(record),
  now,
  ...overrides
});
const planSubmitIntent = (record, options) =>
  planSubmitIntentWithPolicy(record, {
    profile,
    rankingPolicy,
    ...options
  });
const resultCommitAuthorization = (record, overrides = {}) => ({
  freshSourceRows: [record],
  persistedClaims: [persistedBrowserClaim(record)],
  configuration,
  runtime: browserRuntime,
  ...overrides
});
const reconciliationAuthorization = (record, overrides = {}) => ({
  freshSourceRows: [record],
  configuration,
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
    /Browser selection rejected business stores; failure count: 1/
  );
  assert.deepEqual(
    selectAutonomousCandidates(stores, schema, {
      now,
      deadline_ms: Date.parse(now) + 10,
      minimum_headroom_ms: 60_000
    }),
    []
  );
  const hostileRow = {
    ...rows[0],
    pipeline_status: "password=session-secret"
  };
  hostileRow.state_guard = stateGuard(hostileRow);
  assert.throws(
    () =>
      selectAutonomousCandidates(
        { ...stores, "Scraped Jobs": [hostileRow] },
        schema,
        { now }
      ),
    (error) => {
      assert.match(error.message, /failure count: [1-9][0-9]*/);
      assert.doesNotMatch(String(error.stack), /session-secret/);
      return true;
    }
  );
  assertSecretFreeTimestampFailure(() =>
    selectAutonomousCandidates(stores, schema, {
      now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
    })
  );
  assertSecretFreeTimestampFailure(() =>
    planAutonomousClaim(rows[0], {
      execution_id: "hostile-time",
      now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)",
      runtime: browserRuntime
    })
  );
});

test("selection discovers expired recovery and post-submit reconciliation work", () => {
  const claimedPlan = planAutonomousClaim(autonomousRecord("9110"), {
    execution_id: "execution-recovery",
    attempt_id: `attempt-v1:${"9".repeat(64)}`,
    now,
    runtime: browserRuntime
  });
  const claimed = claimedPlan.proposed_record;
  const submittedBase = fillingRecord({
    source_job_id: "9111",
    canonical_job_id: "onlinejobs.ph:9111",
    canonical_url: "https://www.onlinejobs.ph/jobseekers/job/example-9111"
  });
  submittedBase.browser_job_digest = browserJobDigest(submittedBase);
  submittedBase.browser_context_digest = browserContextDigest({
    record: submittedBase,
    ...configuration
  });
  const submittedForm = formFor("9111");
  submittedBase.browser_form_fingerprint = browserFormFingerprint(
    submittedForm,
    submittedBase
  );
  submittedBase.submission_idempotency_key = submissionIdempotencyKey(submittedBase);
  submittedBase.state_guard = stateGuard(submittedBase);
  const submitted = planSubmitIntent(submittedBase, {
    form: submittedForm,
    field_receipts: [
      { name: "message", value_digest: valueDigest(submittedBase.generated_message) },
      {
        name: "apply_points",
        value_digest: valueDigest(String(submittedForm.apply_points))
      }
    ],
    now
  }).proposed_record;
  const stores = {
    "Scraped Jobs": [claimed, submitted],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: []
  };
  const work = selectAutonomousWork(stores, schema, {
    now: "2026-08-10T02:11:00.000Z",
    persisted_claims: [{ ...claimedPlan.system_claim, row_number: 2 }],
    runtime: browserRuntime
  });
  assert.deepEqual(
    work.map((entry) => [entry.operation, entry.record.canonical_job_id]),
    [
      ["reconcile", submitted.canonical_job_id],
      ["recover", claimed.canonical_job_id]
    ]
  );

  const recovered = recoverBrowserRecord(
    claimed,
    {
      now: "2026-08-10T02:11:00.000Z",
      evidence: {
        category: "transient_browser_failure",
        observed_at: "2026-08-10T02:11:00.000Z"
      },
      freshSourceRows: [claimed],
      persistedClaims: [{ ...claimedPlan.system_claim, row_number: 2 }],
      configuration,
      runtime: browserRuntime
    },
    schema
  );
  assert.equal(recovered.browser_state, "retryable");
  assert.match(recovered.browser_context_digest, /^context-v1:[a-f0-9]{64}$/);
  assert.equal(recovered.next_retry_at, "2026-08-10T02:16:00.000Z");
  assertSecretFreeTimestampFailure(() =>
    recoverBrowserRecord(
      claimed,
      {
        now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)",
        evidence: {
          category: "transient_browser_failure",
          observed_at: "2026-08-10T02:00:00.000Z"
        },
        freshSourceRows: [claimed],
        persistedClaims: [],
        configuration,
        runtime: browserRuntime
      },
      schema
    )
  );

  const foreignLiveClaim = {
    ...claimedPlan.system_claim,
    token: `other:${claimedPlan.system_claim.claim_key}`,
    created_at: "2026-08-10T02:10:00.000Z",
    expires_at: "2026-08-10T02:20:00.000Z",
    row_number: 3
  };
  assert.deepEqual(
    selectAutonomousWork(stores, schema, {
      now: "2026-08-10T02:11:00.000Z",
      persisted_claims: [
        { ...claimedPlan.system_claim, row_number: 2 },
        foreignLiveClaim
      ],
      runtime: browserRuntime
    }).map((entry) => entry.operation),
    ["reconcile"]
  );
  assert.throws(
    () =>
      recoverBrowserRecord(
        claimed,
        {
          now: "2026-08-10T02:11:00.000Z",
          evidence: {
            category: "transient_browser_failure",
            observed_at: "2026-08-10T02:11:00.000Z"
          },
          freshSourceRows: [claimed],
          persistedClaims: [foreignLiveClaim],
          configuration,
          runtime: browserRuntime
        },
        schema
      ),
    /expired or lost claim/
  );
});

test("claim context is disclosed only after append-winner and exact reread", () => {
  const record = autonomousRecord();
  const plan = planAutonomousClaim(record, {
    execution_id: "execution-1",
    attempt_id: `attempt-v1:${"2".repeat(64)}`,
    now,
    runtime: browserRuntime
  });
  assert.equal(plan.proposed_record.browser_state, "claimed");
  assert.equal(plan.proposed_record.attempt_count, 1);
  assert.equal("job" in plan, false);
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
    /claim persistence is missing/
  );
  for (const altered of [
    { claim_key: "browser_executor:onlinejobs.ph:9001:wrong" },
    { canonical_job_id: "onlinejobs.ph:other" },
    { stage: "other_stage" },
    { token: "execution-browser:browser_executor:onlinejobs.ph:9001:other" },
    { created_at: "2026-08-10T01:59:00.000Z" },
    { expires_at: "2026-08-10T03:00:00.000Z" }
  ]) {
    assert.throws(
      () =>
        confirmAutonomousClaim(
          plan,
          {
            persisted_claims: [
              { ...plan.system_claim, ...altered, row_number: 2 }
            ],
            fresh_source_rows: [plan.proposed_record],
            schema,
            now
          },
          configuration
        ),
      /claim persistence is missing, duplicated, or altered/
    );
  }
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
  assertSecretFreeTimestampFailure(() =>
    confirmAutonomousClaim(
      plan,
      {
        persisted_claims: [{ ...plan.system_claim, row_number: 2 }],
        fresh_source_rows: [plan.proposed_record],
        schema,
        now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
      },
      configuration
    )
  );
});

test("claimed Chrome observations can complete missing role context without supplying candidate facts", () => {
  const record = autonomousRecord("9002", {
    company: "",
    job_description: "",
    salary_text: ""
  });
  const claim = planAutonomousClaim(record, {
    execution_id: "execution-live-context",
    attempt_id: `attempt-v1:${"3".repeat(64)}`,
    now,
    runtime: browserRuntime
  });
  const persistedClaims = [{ ...claim.system_claim, row_number: 2 }];
  const confirmed = confirmAutonomousClaim(
    claim,
    {
      persisted_claims: persistedClaims,
      fresh_source_rows: [claim.proposed_record],
      schema,
      now
    },
    configuration
  );
  const observation = {
    page_url: record.canonical_url,
    source_job_id: record.source_job_id,
    job_title: record.job_title,
    company: "Example Company",
    job_description:
      "Build and maintain React and TypeScript features with Node.js APIs and PostgreSQL for a production web application.",
    salary_text: "$1,000 per month"
  };
  const bound = bindObservedJobContext(
    confirmed.proposed_record,
    observation,
    {
      ...configuration,
      persistedClaims,
      runtime: browserRuntime,
      schema
    },
    "2026-08-10T02:01:00.000Z"
  );
  assert.equal(bound.proposed_record.browser_state, "evaluating");
  assert.equal(bound.proposed_record.company, observation.company);
  assert.equal(bound.proposed_record.job_description, observation.job_description);
  assert.equal(bound.proposed_record.salary_text, observation.salary_text);
  assert.notEqual(bound.job_digest, confirmed.job_digest);
  assert.notEqual(bound.context_digest, confirmed.context_digest);
  assert.equal(bound.job.job_description, observation.job_description);
  assert.deepEqual(Object.keys(bound.telemetry).sort(), [
    "attempt_id",
    "canonical_job_id",
    "context_digest",
    "event",
    "job_digest"
  ]);

  const validated = validateAutonomousDecision(
    bound.proposed_record,
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      attempt_id: bound.attempt_id,
      context_digest: bound.context_digest,
      decision: "apply",
      reason_code: "recommended",
      message: validMessage
    },
    {
      ...configuration,
      context_digest: bound.context_digest,
      form: formFor("9002")
    },
    "2026-08-10T02:02:00.000Z"
  );
  assert.equal(validated.outcome, "generate_validated");

  for (const altered of [
    { page_url: "https://www.onlinejobs.ph/jobseekers/job/example-9999" },
    { source_job_id: "9999" },
    { job_title: "Different Job" },
    { job_description: "Too short" }
  ]) {
    assert.throws(
      () =>
        bindObservedJobContext(
          confirmed.proposed_record,
          { ...observation, ...altered },
          {
            ...configuration,
            persistedClaims,
            runtime: browserRuntime,
            schema
          },
          "2026-08-10T02:01:00.000Z"
        ),
      /claimed job|title changed|insufficient/
    );
  }
  assert.throws(
    () =>
      bindObservedJobContext(
        confirmed.proposed_record,
        { ...observation, candidate_skill: "invented" },
        {
          ...configuration,
          persistedClaims,
          runtime: browserRuntime,
          schema
        },
        "2026-08-10T02:01:00.000Z"
      ),
    /unsupported count: 1/
  );
});

test("apply-by-default rejects model skips and permits truthfully framed low-ranked work", () => {
  const lowFit = autonomousRecord("9201");
  const evaluating = {
    ...lowFit,
    browser_state: "evaluating",
    browser_attempt_id: `attempt-v1:${"3".repeat(64)}`,
    processing_stage: "browser_executor",
    processing_token:
      "execution-browser:browser_executor:onlinejobs.ph:9201:application",
    processing_started_at: now
  };
  evaluating.browser_job_digest = browserJobDigest(evaluating);
  evaluating.state_guard = stateGuard(evaluating);
  const strictRankingPolicy = {
    ...rankingPolicy,
    qualification: {
      ...rankingPolicy.qualification,
      recommended_minimum: 99
    }
  };
  const context = browserContextDigest({
    record: evaluating,
    profile,
    rankingPolicy: strictRankingPolicy,
    applicationPolicy,
    packPolicy
  });
  evaluating.browser_context_digest = context;
  evaluating.state_guard = stateGuard(evaluating);
  assert.throws(
    () =>
      validateAutonomousDecision(
        evaluating,
        {
          protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
          attempt_id: evaluating.browser_attempt_id,
          context_digest: context,
          decision: "skip",
          reason_code: "model_preference"
        },
        {
          profile,
          rankingPolicy: strictRankingPolicy,
          applicationPolicy,
          packPolicy,
          context_digest: context,
          form: formFor("9201")
        },
        now
      ),
    /Apply-by-default policy does not authorize this skip/
  );
  const result = validateAutonomousDecision(
    evaluating,
    {
      protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
      attempt_id: evaluating.browser_attempt_id,
      context_digest: context,
      decision: "apply",
      reason_code: "truthful_transferable_fit",
      message: validMessage
    },
    {
      profile,
      rankingPolicy: strictRankingPolicy,
      applicationPolicy,
      packPolicy,
      context_digest: context,
      form: formFor("9201")
    },
    now
  );
  assert.equal(result.outcome, "generate_validated");
  assert.notEqual(
    result.proposed_record.apply_points_recommendation,
    "save_points"
  );
});

test("eligible ChatGPT drafts are recomputed, validated, and bound to the form", () => {
  const evaluating = autonomousRecord("9250", {
    browser_state: "evaluating",
    browser_attempt_id: `attempt-v1:${"5".repeat(64)}`,
    processing_stage: "browser_executor",
    processing_token:
      "execution-browser:browser_executor:onlinejobs.ph:9250:application",
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
  const applicationForm = formFor("9250");
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
        {
          profile,
          rankingPolicy,
          applicationPolicy,
          packPolicy,
          persistedClaims: [],
          runtime: browserRuntime,
          form: applicationForm
        },
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
      persistedClaims: [persistedBrowserClaim(result.proposed_record)],
      runtime: browserRuntime,
      form: applicationForm
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
      persistedClaims: [persistedBrowserClaim(fillPlan.proposed_record)],
      runtime: browserRuntime,
      form: applicationForm
    },
    now
  );
  assert.equal(fillCapability.capability, "fill_application_form");
  assert.equal(fillCapability.apply_points, 5);
  assert.equal(fillCapability.apply_points_digest, valueDigest("5"));

  assertSecretFreeTimestampFailure(() =>
    validateAutonomousDecision(
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
      "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
    )
  );
  assertSecretFreeTimestampFailure(() =>
    confirmBrowserReady(
      result.proposed_record,
      [result.proposed_record],
      {
        profile,
        rankingPolicy,
        applicationPolicy,
        packPolicy,
        persistedClaims: [persistedBrowserClaim(result.proposed_record)],
        runtime: browserRuntime,
        form: applicationForm
      },
      "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
    )
  );
  const unsafePersistedMessage = {
    ...result.proposed_record,
    generated_message:
      `${validMessage}\nhttps://private.example/?token=session-secret`
  };
  unsafePersistedMessage.state_guard = stateGuard(unsafePersistedMessage);
  assert.throws(
    () =>
      confirmBrowserReady(
        unsafePersistedMessage,
        [unsafePersistedMessage],
        {
          profile,
          rankingPolicy,
          applicationPolicy,
          packPolicy,
          persistedClaims: [persistedBrowserClaim(unsafePersistedMessage)],
          runtime: browserRuntime,
          form: applicationForm
        },
        now
      ),
    (error) => {
      assert.match(error.message, /Persisted message failed safety; failure count:/);
      assert.doesNotMatch(String(error.stack), /session-secret|private\.example/);
      return true;
    }
  );

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
          message:
            `${validMessage}\nhttps://private.example/?token=session-secret`
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
    (error) => {
      assert.match(error.message, /ChatGPT message is invalid; failure count:/);
      assert.doesNotMatch(String(error.stack), /session-secret|private\.example/);
      return true;
    }
  );
});

test("submit intent must be persisted and reread before one-click capability", () => {
  const filling = fillingRecord();
  const sheetProjectedFilling = Object.fromEntries(
    schema.fields.map((field) => [field, filling[field] ?? ""])
  );
  assert.equal(
    Object.hasOwn(sheetProjectedFilling, "apply_points_recommendation"),
    false
  );
  assert.equal(
    planSubmitIntent(sheetProjectedFilling, {
      form,
      field_receipts: [
        { name: "message", value_digest: valueDigest(filling.generated_message) },
        { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
      ],
      now
    }).proposed_record.browser_state,
    "submit_started"
  );
  assertSecretFreeTimestampFailure(() =>
    planSubmitIntent(filling, {
      form,
      field_receipts: [
        { name: "message", value_digest: valueDigest(filling.generated_message) },
        { name: "apply_points", value_digest: valueDigest(String(form.apply_points)) }
      ],
      now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
    })
  );
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
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, {
          form: {
            ...form,
            submit_control: {
              ...form.submit_control,
              value_digest: valueDigest("Changed submit control")
            }
          }
        })
      ),
    /changed immediately before submit click/
  );
  const preClickReceiptStore = clickReceiptStore();
  const preClickLedger = readFileSync(
    join(preClickReceiptStore.directory, "consumed.ndjson"),
    "utf8"
  );
  const preClickWitness = readFileSync(preClickReceiptStore.witness_path, "utf8");
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, {
          receiptStore: preClickReceiptStore,
          fieldReceipts: [
            { name: "message", value_digest: valueDigest("changed after plan") },
            fieldReceiptsFor(plan.proposed_record)[1]
          ]
        })
      ),
    /does not match the authorized message/
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, {
          receiptStore: preClickReceiptStore,
          fieldReceipts: [
            fieldReceiptsFor(plan.proposed_record)[0],
            { name: "apply_points", value_digest: valueDigest("10") }
          ]
        })
      ),
    /does not match the authorized apply_points value/
  );
  assert.deepEqual(readdirSync(preClickReceiptStore.directory).sort(), [
    "consumed.ndjson",
    "manifest.json"
  ]);
  assert.equal(
    readFileSync(join(preClickReceiptStore.directory, "consumed.ndjson"), "utf8"),
    preClickLedger
  );
  assert.equal(
    readFileSync(preClickReceiptStore.witness_path, "utf8"),
    preClickWitness
  );
  const receiptStore = clickReceiptStore();
  const initialLedger = readFileSync(
    join(receiptStore.directory, "consumed.ndjson"),
    "utf8"
  );
  const initialWitness = readFileSync(receiptStore.witness_path, "utf8");
  const authorization = confirmSubmitIntent(
    plan,
    [plan.proposed_record],
    submitConfiguration(plan.proposed_record, { receiptStore })
  );
  assert.equal(authorization.capability, "click_application_submit_once");
  assert.equal(
    authorization.submission_idempotency_key,
    filling.submission_idempotency_key
  );
  assert.match(authorization.consumption_receipt_digest, /^[a-f0-9]{64}$/);
  const jobReceiptName = `${valueDigest(filling.canonical_job_id)}.job.json`;
  const restoredFilling = fillingRecord({
    browser_attempt_id: `attempt-v1:${"d".repeat(64)}`
  });
  assert.equal(
    restoredFilling.submission_idempotency_key,
    filling.submission_idempotency_key
  );
  const restoredPlan = planSubmitIntent(restoredFilling, {
    form,
    field_receipts: [
      {
        name: "message",
        value_digest: valueDigest(restoredFilling.generated_message)
      },
      {
        name: "apply_points",
        value_digest: valueDigest(String(form.apply_points))
      }
    ],
    now
  });
  assert.notEqual(
    browserSubmitAuthorizationDigest(restoredPlan.proposed_record),
    authorization.authorization_digest
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        restoredPlan,
        [restoredPlan.proposed_record],
        submitConfiguration(restoredPlan.proposed_record, { receiptStore })
      ),
    /already consumed/
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /already consumed/
  );
  const receiptFiles = readdirSync(receiptStore.directory);
  assert.deepEqual(receiptFiles.sort(), [
    jobReceiptName,
    "consumed.ndjson",
    "manifest.json"
  ]);
  const receipt = readFileSync(
    join(receiptStore.directory, jobReceiptName),
    "utf8"
  );
  const ledger = readFileSync(
    join(receiptStore.directory, "consumed.ndjson"),
    "utf8"
  );
  const consumedWitness = readFileSync(receiptStore.witness_path, "utf8");
  assert.doesNotMatch(
    `${receipt}\n${ledger}`,
    /onlinejobs|example company|full-stack/i
  );
  rmSync(
    join(receiptStore.directory, jobReceiptName)
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /already consumed/
  );
  writeFileSync(
    join(receiptStore.directory, "consumed.ndjson"),
    initialLedger,
    "utf8"
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
  );
  writeFileSync(
    join(receiptStore.directory, "consumed.ndjson"),
    ledger,
    "utf8"
  );
  writeFileSync(receiptStore.witness_path, initialWitness, "utf8");
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
  );
  writeFileSync(receiptStore.witness_path, consumedWitness, "utf8");
  const crashStore = clickReceiptStore();
  const orphanJobReceipt = `${valueDigest(filling.canonical_job_id)}.job.json`;
  writeFileSync(join(crashStore.directory, orphanJobReceipt), `${receipt}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  assert.throws(
    () =>
      confirmSubmitIntent(
        restoredPlan,
        [restoredPlan.proposed_record],
        submitConfiguration(restoredPlan.proposed_record, {
          receiptStore: crashStore
        })
      ),
    /already consumed/
  );
  assert.equal(
    readFileSync(join(crashStore.directory, "consumed.ndjson"), "utf8"),
    initialLedger
  );
  const lockPath = join(receiptStore.directory, ".consume.lock");
  writeFileSync(lockPath, "interrupted\n", { encoding: "utf8", mode: 0o600 });
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /busy or requires recovery/
  );
  rmSync(lockPath);
  const ledgerPath = join(receiptStore.directory, "consumed.ndjson");
  rmSync(ledgerPath);
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
  );
  writeFileSync(ledgerPath, ledger, { encoding: "utf8", mode: 0o600 });
  const manifestPath = join(receiptStore.directory, "manifest.json");
  const manifest = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, `${manifest} `, "utf8");
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
  );
  writeFileSync(manifestPath, manifest, "utf8");
  const otherStore = clickReceiptStore();
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, {
          receiptStore: { ...receiptStore, directory: otherStore.directory }
        })
      ),
    /missing, changed, or unsafe/
  );
  const publicStore = clickReceiptStore();
  chmodSync(publicStore.directory, 0o777);
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore: publicStore })
      ),
    /missing, changed, or unsafe/
  );
  chmodSync(publicStore.directory, 0o700);
  const nestedRoot = mkdtempSync(join(tmpdir(), "job-pipeline-click-nested-"));
  receiptDirectories.push(nestedRoot);
  const nestedStore = join(nestedRoot, "store");
  const misleadingParent = join(nestedStore, "..evil");
  const nestedWitness = join(misleadingParent, "witness.json");
  mkdirSync(nestedStore, { mode: 0o700 });
  mkdirSync(misleadingParent, { mode: 0o700 });
  writeFileSync(nestedWitness, "", { encoding: "utf8", mode: 0o600 });
  assert.throws(
    () =>
      browserClickReceiptStoreProvisioning({
        directory: nestedStore,
        witness_path: nestedWitness,
        store_id: testClickStoreId,
        ledger_id: testClickLedgerId,
        generation_id: testClickGenerationId,
        created_at: "2026-08-10T00:00:00.000Z"
      }),
    /must already exist privately/
  );
  const hostileTimestampStore = clickReceiptStore();
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, {
          receiptStore: hostileTimestampStore,
          now: "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)"
        })
      ),
    (error) => {
      assert.match(error.message, /must be an ISO timestamp/);
      assert.doesNotMatch(String(error.stack), /session-secret/);
      return true;
    }
  );
  rmSync(receiptStore.directory, { recursive: true, force: true });
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
  );
  assert.equal(existsSync(receiptStore.directory), false);
  mkdirSync(receiptStore.directory, { mode: 0o700 });
  writeFileSync(
    join(receiptStore.directory, "manifest.json"),
    manifest,
    { encoding: "utf8", mode: 0o600 }
  );
  writeFileSync(
    join(receiptStore.directory, "consumed.ndjson"),
    initialLedger,
    { encoding: "utf8", mode: 0o600 }
  );
  assert.throws(
    () =>
      confirmSubmitIntent(
        plan,
        [plan.proposed_record],
        submitConfiguration(plan.proposed_record, { receiptStore })
      ),
    /missing, changed, or unsafe/
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
  assertSecretFreeTimestampFailure(() =>
    reconcileBrowserResult(
      intent,
      confirmedResult,
      "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)",
      schema,
      confirmationTrust,
      reconciliationAuthorization(intent)
    )
  );
  assert.throws(
    () =>
      reconcileBrowserResult(
        intent,
        { ...confirmedResult, confirmation_attestation: undefined },
        "2026-08-10T02:01:00.000Z",
        schema,
        confirmationTrust,
        reconciliationAuthorization(intent)
      ),
    /trusted independent adapter attestation/
  );
  assert.throws(
    () =>
      reconcileBrowserResult(
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
        },
        reconciliationAuthorization(intent)
      ),
    /trusted independent adapter attestation/
  );
  const confirmed = reconcileBrowserResult(
    intent,
    confirmedResult,
    "2026-08-10T02:01:00.000Z",
    schema,
    confirmationTrust,
    reconciliationAuthorization(intent)
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

  const ambiguous = reconcileBrowserResult(
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
    schema,
    {},
    reconciliationAuthorization(intent)
  );
  assert.throws(
    () =>
      recoverBrowserRecord(ambiguous, {
        now: "2026-08-10T02:02:00.000Z",
        evidence: { category: "transient_browser_failure" },
        freshSourceRows: [ambiguous],
        persistedClaims: [],
        configuration,
        runtime: browserRuntime
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
  const reconciled = reconcileBrowserResult(
    ambiguous,
    withConfirmationAttestation(ambiguous, reconciledResult),
    "2026-08-10T02:03:00.000Z",
    schema,
    confirmationTrust,
    reconciliationAuthorization(ambiguous)
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
  assert.throws(
    () =>
      planSubmitIntent(filling, {
        form,
        field_receipts: [
          { name: "message", value_digest: valueDigest(filling.generated_message) },
          { name: "apply_points", value_digest: valueDigest("10") }
        ],
        now
      }),
    /does not match the authorized apply_points value/
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
      reconcileBrowserResult(
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
        schema,
        {},
        reconciliationAuthorization(plan.proposed_record)
      ),
    /evidence does not match its lifecycle state|bounded evidence identity/
  );
});

test("pre-submit results require exact live ownership and enforce technical retries", () => {
  const filling = fillingRecord({ attempt_count: 1 });
  const retryResult = {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: filling.browser_attempt_id,
    job_digest: filling.browser_job_digest,
    result: "retryable",
    evidence: {
      category: "transient_browser_failure",
      observed_at: now
    }
  };
  assertSecretFreeTimestampFailure(() =>
    commitBrowserResult(
      filling,
      retryResult,
      "Mon, 10 Aug 2026 02:00:00 GMT (cookie=session-secret)",
      schema,
      {},
      resultCommitAuthorization(filling)
    )
  );
  assert.throws(
    () =>
      commitBrowserResult(
        filling,
        retryResult,
        "2026-08-10T02:01:00.000Z",
        schema,
        {},
        resultCommitAuthorization(filling, { persistedClaims: [] })
      ),
    /claim is expired, lost, or not the winner/
  );
  assert.throws(
    () =>
      commitBrowserResult(
        filling,
        retryResult,
        "2026-08-10T02:01:00.000Z",
        schema,
        {},
        resultCommitAuthorization(filling, {
          persistedClaims: [
            {
              ...persistedBrowserClaim(filling),
              claim_key: "browser_executor:onlinejobs.ph:9001:wrong_scope"
            }
          ]
        })
      ),
    /claim is expired, lost, or not the winner/
  );
  assert.throws(
    () =>
      commitBrowserResult(
        filling,
        retryResult,
        "2026-08-10T02:01:00.000Z",
        schema,
        {},
        resultCommitAuthorization(filling, {
          freshSourceRows: [{ ...filling, notes: "changed" }]
        })
      ),
    /persistence mismatch/
  );
  assert.throws(
    () =>
      commitBrowserResult(
        filling,
        { ...retryResult, retry_at: "2026-08-10T02:01:00.001Z" },
        "2026-08-10T02:01:00.000Z",
        schema,
        {},
        resultCommitAuthorization(filling)
      ),
    /unsupported count: 1/
  );
  assert.throws(
    () =>
      commitBrowserResult(
        filling,
        retryResult,
        "2026-08-10T02:01:00.000Z",
        schema,
        {},
        resultCommitAuthorization(filling, {
          configuration: {
            ...configuration,
            applicationPolicy: {
              ...applicationPolicy,
              policy_version: "stale-policy"
            }
          }
        })
      ),
    /configuration is stale/
  );
  const retryable = commitBrowserResult(
    filling,
    retryResult,
    "2026-08-10T02:01:00.000Z",
    schema,
    {},
    resultCommitAuthorization(filling)
  );
  assert.equal(retryable.browser_state, "retryable");
  assert.equal(retryable.attempt_count, 1);
  assert.equal(retryable.next_retry_at, "2026-08-10T02:06:00.000Z");
  assert.throws(
    () =>
      planAutonomousClaim(retryable, {
        execution_id: "execution-too-early",
        now: "2026-08-10T02:01:00.001Z",
        runtime: browserRuntime
      }),
    /retry backoff has not elapsed/
  );
  const aliasedRetryable = {
    ...retryable,
    browser_next_retry_at: "2026-08-10T01:00:00.000Z"
  };
  assert.throws(
    () =>
      selectAutonomousWork(
        {
          "Scraped Jobs": [aliasedRetryable],
          "To Review": [],
          "To Apply": [],
          "Applied Jobs": [],
          Archive: []
        },
        schema,
        {
          now: "2026-08-10T02:01:00.001Z",
          persisted_claims: [],
          runtime: browserRuntime
        }
      ),
    /unsupported browser_next_retry_at alias/
  );
  assert.throws(
    () =>
      planAutonomousClaim(aliasedRetryable, {
        execution_id: "execution-alias",
        now: "2026-08-10T02:10:00.000Z",
        runtime: browserRuntime
      }),
    /unsupported browser_next_retry_at alias/
  );

  const exhausted = fillingRecord({ attempt_count: 3 });
  const exhaustedResult = {
    ...retryResult,
    attempt_id: exhausted.browser_attempt_id,
    job_digest: exhausted.browser_job_digest
  };
  const blocked = commitBrowserResult(
    exhausted,
    exhaustedResult,
    "2026-08-10T02:01:00.000Z",
    schema,
    {},
    resultCommitAuthorization(exhausted)
  );
  assert.equal(blocked.browser_state, "blocked");
  assert.equal(blocked.browser_block_category, "transient_browser_failure");
  assert.equal(blocked.next_retry_at, "");
  assert.throws(
    () =>
      planAutonomousClaim(
        autonomousRecord("9112", { attempt_count: 3 }),
        {
          execution_id: "execution-exhausted",
          now,
          runtime: browserRuntime
        }
      ),
    /retry limit is exhausted/
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
          effective_action:
            "https://www.onlinejobs.ph/jobseekers/job/9999/apply",
          submit_control: {
            ...form.submit_control,
            effective_action:
              "https://www.onlinejobs.ph/jobseekers/job/9999/apply"
          }
        },
        record
      ),
    /match the claimed OnlineJobs\.ph job/
  );
  for (const actionPath of [
    "/jobseekers/job/attacker-prefix-9001/apply",
    "/jobseekers/job/9001/apply?target=other",
    "/jobseekers/job/9001/apply#other"
  ]) {
    const effectiveAction = new URL(actionPath, form.origin).href;
    assert.throws(
      () =>
        browserFormFingerprint(
          {
            ...form,
            effective_action: effectiveAction,
            submit_control: {
              ...form.submit_control,
              effective_action: effectiveAction
            }
          },
          record
        ),
      /match the claimed OnlineJobs\.ph job/
    );
  }
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          fields: Array.from({ length: 65 }, (_, index) => ({
            name: `field_${index}`,
            type: "hidden",
            required: false
          }))
        },
        record
      ),
    /bounded field inventory/
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
          effective_action:
            "https://www.onlinejobs.ph/jobseekers/job/9001/apply",
          submit_control: {
            ...form.submit_control,
            effective_action:
              "https://www.onlinejobs.ph/jobseekers/job/9001/apply"
          }
        },
        one
      ),
    /match the claimed OnlineJobs\.ph job/
  );
  const blocked = {
    ...record,
    browser_state: "blocked",
    browser_form_fingerprint: "",
    submission_idempotency_key: "",
    browser_block_category: "invalid_form"
  };
  blocked.state_guard = stateGuard(blocked);
  assert.throws(
    () =>
      recoverBrowserRecord(
        blocked,
        {
          now,
          evidence: {
            category: "transient_browser_failure",
            observed_at: now
          },
          freshSourceRows: [blocked],
          persistedClaims: [],
          configuration,
          runtime: browserRuntime
        },
        schema
      ),
    /not recoverable/
  );
});

test("form fingerprints and evidence fail closed without leaking secrets", () => {
  const observedLiveForm = liveFormFor("9001");
  const liveFilling = fillingRecord();
  liveFilling.browser_form_fingerprint = browserFormFingerprint(
    observedLiveForm,
    liveFilling
  );
  liveFilling.submission_idempotency_key = submissionIdempotencyKey(liveFilling);
  liveFilling.state_guard = stateGuard(liveFilling);
  assert.match(
    liveFilling.browser_form_fingerprint,
    /^form-v1:/
  );
  assert.equal(
    planSubmitIntent(liveFilling, {
      form: observedLiveForm,
      field_receipts: [
        { name: "subject", value_digest: valueDigest(validApplicationSubject) },
        { name: "message", value_digest: valueDigest(validApplicationBody) },
        { name: "apply_points", value_digest: valueDigest("5") }
      ],
      now
    }).proposed_record.browser_state,
    "submit_started"
  );
  assert.throws(
    () =>
      planSubmitIntent(liveFilling, {
        form: observedLiveForm,
        field_receipts: [
          { name: "message", value_digest: valueDigest(validApplicationBody) },
          { name: "apply_points", value_digest: valueDigest("5") }
        ],
        now
      }),
    /Required application fields were not reread: subject/
  );
  assert.match(
    browserFormFingerprint({
      ...form,
      origin: "https://onlinejobs.ph",
      page_url: "https://onlinejobs.ph/jobseekers/job/example-9001",
      effective_action: "https://onlinejobs.ph/jobseekers/job/9001/apply",
      submit_control: {
        ...form.submit_control,
        effective_action: "https://onlinejobs.ph/jobseekers/job/9001/apply"
      }
    }, fillingRecord()),
    /^form-v1:/
  );
  assert.throws(
    () =>
      browserFormFingerprint({
        ...form,
        effective_action: "https://employer.example/apply",
        submit_control: {
          ...form.submit_control,
          effective_action: "https://employer.example/apply"
        }
      }, fillingRecord()),
    /match the claimed OnlineJobs\.ph job/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          submit_control: {
            ...form.submit_control,
            effective_action: "https://employer.example/apply"
          }
        },
        fillingRecord()
      ),
    /match the claimed OnlineJobs\.ph job/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          submit_control: {
            ...form.submit_control,
            effective_method: "GET"
          }
        },
        fillingRecord()
      ),
    /method must be POST/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        { ...form, effective_action: "/jobseekers/job/9001/apply" },
        fillingRecord()
      ),
    /valid and credential-free/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          fields: [
            ...form.fields,
            { name: "alternate_submit", type: "submit", required: false }
          ]
        },
        fillingRecord()
      ),
    /fields or live Apply Points are unsupported/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          fields: [
            ...form.fields,
            { name: "subscribe", type: "checkbox", required: false }
          ]
        },
        fillingRecord()
      ),
    /fields or live Apply Points are unsupported/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          fields: [
            ...form.fields,
            { name: "phone", type: "text", required: false }
          ]
        },
        fillingRecord()
      ),
    /fields or live Apply Points are unsupported/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        { ...form, apply_points: 10 },
        fillingRecord()
      ),
    /fields or live Apply Points are unsupported/
  );
  assert.match(
    browserFormFingerprint(
      { ...form, apply_points: 10 },
      fillingRecord({ apply_points_recommendation: "high_allocation" })
    ),
    /^form-v1:/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        form,
        fillingRecord({ apply_points_recommendation: "save_points" })
      ),
    /fields or live Apply Points are unsupported/
  );
  for (const changed of [
    { origin: "https://attacker:secret@www.onlinejobs.ph" },
    {
      page_url:
        "https://attacker:secret@www.onlinejobs.ph/jobseekers/job/example-9001"
    },
    {
      effective_action:
        "https://attacker:secret@www.onlinejobs.ph/jobseekers/job/9001/apply"
    }
  ]) {
    assert.throws(
      () => browserFormFingerprint({ ...form, ...changed }, fillingRecord()),
      /valid and credential-free/
    );
  }
  assert.throws(
    () =>
      browserFormFingerprint(
        { ...form, origin: "cookie=session-secret" },
        fillingRecord()
      ),
    (error) => {
      assert.match(error.message, /valid and credential-free/);
      assert.doesNotMatch(String(error.stack), /session-secret/);
      return true;
    }
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        {
          ...form,
          fields: form.fields.map((field) =>
            field.name === "message" ? { ...field, required: null } : field
          )
        },
        fillingRecord()
      ),
    /required flag must be boolean/
  );
  assert.throws(
    () => browserFormFingerprint({ ...form, extra: true }, fillingRecord()),
    /unsupported count: 1/
  );
  assert.throws(
    () =>
      browserFormFingerprint(
        { ...form, "password=session-secret": true },
        fillingRecord()
      ),
    (error) => {
      assert.match(error.message, /unsupported count: 1/);
      assert.doesNotMatch(String(error.stack), /session-secret/);
      return true;
    }
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
    input: JSON.stringify({ stores, persisted_claims: [], now }),
    encoding: "utf8"
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    candidate: null,
    operation: null,
    due_count: 0,
    recovery_count: 0,
    reconciliation_count: 0
  });

  const rawCandidate = autonomousRecord("9900");
  const sheetShapedCandidate = Object.fromEntries(
    Object.entries(rawCandidate).map(([field, value]) => {
      if (
        (schema.string_list_fields.includes(field) ||
          schema.json_array_fields.includes(field)) &&
        Array.isArray(value)
      ) {
        return [field, JSON.stringify(value)];
      }
      if (["number", "integer"].includes(schema.field_rules[field]?.type)) {
        return [field, String(value)];
      }
      return [field, value === "" ? null : value];
    })
  );
  const legacyCompatibilityRow = {
    ...sheetShapedCandidate,
    source_job_id: "9899",
    canonical_job_id: "onlinejobs.ph:9899",
    canonical_url:
      "https://www.onlinejobs.ph/jobseekers/job/example-9899",
    execution_mode: null,
    automation_contract_version: null,
    browser_state: null,
    browser_job_digest: null
  };
  const normalizedSelection = spawnSync(process.execPath, [script, "select"], {
    input: JSON.stringify({
      stores: {
        ...stores,
        "Scraped Jobs": [legacyCompatibilityRow, sheetShapedCandidate]
      },
      persisted_claims: [],
      now
    }),
    encoding: "utf8"
  });
  assert.equal(normalizedSelection.status, 0, normalizedSelection.stderr);
  const normalizedSelectionOutput = JSON.parse(normalizedSelection.stdout);
  assert.equal(
    normalizedSelectionOutput.candidate.canonical_job_id,
    rawCandidate.canonical_job_id
  );
  assert.equal(normalizedSelectionOutput.candidate.record_version, 1);
  assert.deepEqual(
    normalizedSelectionOutput.candidate.matched_keywords,
    rawCandidate.matched_keywords
  );
  assert.equal(normalizedSelectionOutput.operation, "claim");
  assert.equal(normalizedSelectionOutput.due_count, 1);

  const invalid = spawnSync(process.execPath, [script, "select"], {
    input: JSON.stringify({
      stores,
      persisted_claims: [],
      now,
      generated_message: "private"
    }),
    encoding: "utf8"
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unsupported count: 1/);
  assert.doesNotMatch(invalid.stderr, /private/);
  const hostileKey = spawnSync(process.execPath, [script, "select"], {
    input: JSON.stringify({
      stores,
      persisted_claims: [],
      now,
      "cookie=session-secret": true
    }),
    encoding: "utf8"
  });
  assert.notEqual(hostileKey.status, 0);
  assert.match(hostileKey.stderr, /unsupported count: 1/);
  assert.doesNotMatch(hostileKey.stderr, /session-secret/);

  const filling = fillingRecord();
  const plan = planSubmitIntent(filling, {
    form,
    field_receipts: [
      { name: "message", value_digest: valueDigest(filling.generated_message) },
      {
        name: "apply_points",
        value_digest: valueDigest(String(form.apply_points))
      }
    ],
    now
  });
  const confirmInput = JSON.stringify({
    plan,
    fresh_source_rows: [plan.proposed_record],
    persisted_claims: [persistedBrowserClaim(plan.proposed_record)],
    form,
    field_receipts: fieldReceiptsFor(plan.proposed_record),
    now
  });
  const receiptEnvironment = {
    ...process.env,
    JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR: clickReceiptStore().directory
  };
  const unprovisionedConfirm = spawnSync(
    process.execPath,
    [script, "confirm-submit-intent"],
    { input: confirmInput, encoding: "utf8", env: receiptEnvironment }
  );
  assert.notEqual(unprovisionedConfirm.status, 0);
  assert.match(unprovisionedConfirm.stderr, /identity is not provisioned/);
  assert.doesNotMatch(
    unprovisionedConfirm.stderr,
    /Full-Stack|Example Company/
  );
});
