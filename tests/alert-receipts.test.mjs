import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  alertReceiptDataTableSchema,
  alertReceiptPersistenceRow,
  applyProviderResultToAlertReceipt,
  createPendingAlertReceipt,
  planDeliveredReceiptReconciliation,
  transitionAlertReceipt,
  validateAlertReceipt,
  validateAlertReceiptCompatibility,
  validateAlertReceiptPolicy
} from "../src/alert-receipts.mjs";
import {
  createAlertReceiptPersistenceAdapter,
  alertReceiptDataTableProvisioningPlan,
  n8nReceiptDataTableMutation,
  validateAlertReceiptDataTableSnapshot,
  validateAlertReceiptRows
} from "../src/alert-receipt-store.mjs";
import { normalizeLegacyRecord, stateGuard } from "../src/contracts.mjs";
import { destinationWrites, planQueueActions } from "../src/movement.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const policy = await loadJson("../config/alert-receipts.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const now = "2026-08-02T06:00:00.000Z";
const later = "2026-08-02T06:01:00.000Z";
const retryAt = "2026-08-02T06:05:00.000Z";
const providerAt = "2026-08-02T06:02:00.000Z";
const key = "slack:onlinejobs.ph:6101:2026-07-31/v1:deadbeef";

function stores(overrides = {}) {
  return {
    "To Apply": [],
    "Applied Jobs": [],
    Archive: [],
    ...overrides
  };
}

function readyRecord(id = 6101, overrides = {}) {
  const record = normalizeLegacyRecord(
    {
      source: "onlinejobs.ph",
      source_job_id: String(id),
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://onlinejobs.ph/jobseekers/job/example-${id}`,
      row_number: 2,
      record_version: 3,
      pipeline_status: "ready_to_apply",
      user_action: "",
      source_availability: "active",
      attempt_count: 0,
      alert_attempt_count: 1,
      matched_keywords: ["react developer"],
      job_title: `Job ${id}`,
      company: "Example",
      decision_reason: "Auditable decision",
      generated_message:
        "Hi there,\n\nI build TypeScript and React applications using approved profile evidence.\n\nPortfolio: https://johnlesterescarlan.pro",
      generated_at: "2026-08-02T05:00:00.000Z",
      message_validation_status: "valid",
      message_profile_version: profile.profile_version,
      message_policy_version: applicationPolicy.policy_version,
      application_pack_status: "ready",
      application_pack_version: packPolicy.pack_version,
      application_pack_profile_version: profile.profile_version,
      application_pack_policy_version: packPolicy.policy_version,
      application_pack_generated_at: "2026-08-02T05:00:00.000Z",
      application_instructions: [],
      screening_questions: [],
      selected_proof_refs: ["experience:upwork"],
      application_warnings: [],
      alert_status: "sending",
      alert_idempotency_key: key,
      alert_claim_token: "execution-1:alert:deadbeef",
      alert_last_attempt_at: now,
      created_at: "2026-08-02T04:00:00.000Z",
      updated_at: now,
      ...overrides
    },
    schema,
    now
  );
  record.state_guard = stateGuard(record);
  return record;
}

function deliveredReceipt(overrides = {}) {
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  const sending = transitionAlertReceipt(
    pending,
    { expectedVersion: 1, status: "sending", now: later },
    policy
  );
  return applyProviderResultToAlertReceipt(
    sending,
    { statusCode: 200, reference: "slack-ts-1" },
    {
      expectedVersion: sending.receipt_version,
      now: "2026-08-02T06:02:00.000Z"
    },
    policy
  );
}

function movedRecord(destination) {
  const action = destination === "Applied Jobs" ? "I Applied" : "Skip";
  const source = readyRecord(6101, { user_action: action });
  source.state_guard = stateGuard(source);
  const plan = planQueueActions(
    {
      "Scraped Jobs": [],
      "To Review": [],
      "To Apply": [source],
      "Applied Jobs": [],
      Archive: []
    },
    schema,
    now,
    { profile, applicationPolicy, packPolicy }
  );
  const writes = destinationWrites(plan);
  const record = destination === "Applied Jobs"
    ? writes.applied[0]
    : writes.archive[0];
  record.row_number = 2;
  record.state_guard = stateGuard(record);
  return record;
}

class MemoryBackend {
  constructor(seed = []) {
    this.rows = new Map(seed.map((row) => [row.receipt_id, { ...row }]));
  }
  async getAllById(id) {
    return this.rows.has(id) ? [{ ...this.rows.get(id) }] : [];
  }
  async createIfAbsent(row) {
    if (this.rows.has(row.receipt_id)) return false;
    this.rows.set(row.receipt_id, { ...row });
    return true;
  }
  async compareAndSwap(id, version, row) {
    if (this.rows.get(id)?.receipt_version !== version) return false;
    this.rows.set(id, { ...row });
    return true;
  }
  async listByStatus(status) {
    return [...this.rows.values()]
      .filter((row) => row.status === status)
      .map((row) => ({ ...row }));
  }
}

class FileBackend {
  constructor(path) {
    this.path = path;
  }
  async rows() {
    return JSON.parse(await readFile(this.path, "utf8"));
  }
  async save(rows) {
    await writeFile(this.path, JSON.stringify(rows), "utf8");
  }
  async getAllById(id) {
    return (await this.rows()).filter((row) => row.receipt_id === id);
  }
  async createIfAbsent(row) {
    const rows = await this.rows();
    if (rows.some((entry) => entry.receipt_id === row.receipt_id)) return false;
    rows.push(row);
    await this.save(rows);
    return true;
  }
  async compareAndSwap(id, version, row) {
    const rows = await this.rows();
    const index = rows.findIndex(
      (entry) => entry.receipt_id === id && entry.receipt_version === version
    );
    if (index < 0) return false;
    rows[index] = row;
    await this.save(rows);
    return true;
  }
  async listByStatus(status) {
    return (await this.rows()).filter((row) => row.status === status);
  }
}

test("receipt policy and Data Table schema are bounded and transport-neutral", () => {
  assert.deepEqual(validateAlertReceiptPolicy(policy), []);
  assert.deepEqual(
    validateAlertReceiptCompatibility(policy, alertPolicy),
    []
  );
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  assert.equal(pending.receipt_id, key);
  assert.deepEqual(validateAlertReceipt(pending, policy), []);
  assert.deepEqual(
    alertReceiptDataTableSchema().map((column) => column.name),
    Object.keys(alertReceiptPersistenceRow(pending, policy))
  );
  assert.doesNotMatch(JSON.stringify(pending), /generated_message|slack_payload|webhook/i);
  const provisioning = alertReceiptDataTableProvisioningPlan(policy);
  assert.equal(provisioning.business_sheet_schema_mutation, false);
  assert.equal(provisioning.write_contract.create, "atomic_upsert_by_receipt_id");
  assert.deepEqual(
    validateAlertReceiptDataTableSnapshot(
      {
        id: "receipt_table_1",
        name: policy.store.table_name,
        columns: alertReceiptDataTableSchema(),
        rows: [pending]
      },
      policy
    ),
    []
  );
});

test("receipt validation rejects malformed, oversized, stale, and duplicate persisted data without throwing", () => {
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  assert.doesNotThrow(() => validateAlertReceipt({}, policy));
  assert.ok(validateAlertReceipt({}, policy).length > 0);
  assert.match(
    validateAlertReceipt(
      { ...pending, provider_status: 700, canonical_job_id: "unsafe\u200bidentity" },
      policy
    ).join("; "),
    /provider_status|canonical_job_id/
  );
  assert.match(
    validateAlertReceiptRows([pending, { ...pending }], policy).join("; "),
    /duplicate current receipt identity/
  );
  assert.match(
    validateAlertReceiptRows(
      [{ ...pending, id: 1, createdAt: now, updatedAt: now, raw_response: "secret" }],
      policy
    ).join("; "),
    /unexpected persisted field raw_response/
  );
  assert.match(
    validateAlertReceiptDataTableSnapshot(
      {
        id: "receipt_table_1",
        name: policy.store.table_name,
        columns: [...alertReceiptDataTableSchema(), { name: "raw_payload", type: "string" }],
        rows: [pending]
      },
      policy
    ).join("; "),
    /column count/
  );
  assert.match(
    validateAlertReceiptPolicy({
      ...policy,
      statuses: [...policy.statuses, "unknown"],
      maximum_attempts: 99
    }).join("; "),
    /supported value exactly once|between 1 and 10/
  );
  assert.doesNotThrow(() =>
    validateAlertReceiptDataTableSnapshot({}, { schema_version: 999 })
  );
  assert.ok(
    validateAlertReceiptDataTableSnapshot({}, { schema_version: 999 }).length > 0
  );
  assert.match(
    validateAlertReceiptCompatibility(
      { ...policy, maximum_attempts: policy.maximum_attempts + 1 },
      alertPolicy
    ).join("; "),
    /retry caps must match/
  );
});

test("receipt lifecycle accepts forward transitions and rejects duplicate, backward, and stale changes", () => {
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  const sending = transitionAlertReceipt(
    pending,
    { expectedVersion: 1, status: "sending", now: later },
    policy
  );
  const delivered = applyProviderResultToAlertReceipt(
    sending,
    { statusCode: 200, reference: "slack-ts-1" },
    { expectedVersion: 2, now: "2026-08-02T06:02:00.000Z" },
    policy
  );
  const reconciled = transitionAlertReceipt(
    delivered,
    {
      expectedVersion: delivered.receipt_version,
      status: "reconciled",
      now: "2026-08-02T06:03:00.000Z"
    },
    policy
  );
  assert.deepEqual(
    [pending.status, sending.status, delivered.status, reconciled.status],
    ["pending", "sending", "delivered", "reconciled"]
  );
  assert.throws(
    () =>
      transitionAlertReceipt(
        sending,
        { expectedVersion: 1, status: "delivered", now },
        policy
      ),
    /stale receipt_version/
  );
  assert.throws(
    () =>
      transitionAlertReceipt(
        sending,
        { expectedVersion: 2, status: "sending", now },
        policy
      ),
    /duplicate status/
  );
  assert.throws(
    () =>
      transitionAlertReceipt(
        delivered,
        { expectedVersion: 3, status: "sending", now },
        policy
      ),
    /rejected delivered -> sending/
  );
});

test("definite, bounded retryable, and ambiguous provider outcomes remain distinct", () => {
  const makeSending = (attemptCount = 1) => {
    const pending = createPendingAlertReceipt(
      {
        idempotencyKey: key,
        canonicalJobId: "onlinejobs.ph:6101",
        executionId: "execution-1",
        attemptCount,
        now
      },
      policy
    );
    return transitionAlertReceipt(
      pending,
      { expectedVersion: 1, status: "sending", now: later },
      policy
    );
  };
  const retryable = applyProviderResultToAlertReceipt(
    makeSending(),
    { statusCode: 429, error: { message: "temporary rate limit" } },
    { expectedVersion: 2, retryAt, now: providerAt },
    policy
  );
  assert.equal(retryable.status, "retryable_rejection");
  const nextPending = transitionAlertReceipt(
    retryable,
    {
      expectedVersion: retryable.receipt_version,
      status: "pending",
      executionId: "execution-2",
      now: retryAt
    },
    policy
  );
  assert.equal(nextPending.attempt_count, 2);
  const capped = applyProviderResultToAlertReceipt(
    makeSending(policy.maximum_attempts),
    { statusCode: 503, error: { message: "temporary unavailable" } },
    { expectedVersion: 2, retryAt, now: providerAt },
    policy
  );
  assert.equal(capped.status, "terminal_rejection");
  assert.equal(capped.provider_classification, "retryable_rejection");
  const rejected = applyProviderResultToAlertReceipt(
    makeSending(),
    { statusCode: 400, error: { message: "invalid payload" } },
    { expectedVersion: 2, now: providerAt },
    policy
  );
  assert.equal(rejected.status, "terminal_rejection");
  const ambiguous = applyProviderResultToAlertReceipt(
    makeSending(),
    { error: { message: "socket timed out after upload" } },
    { expectedVersion: 2, now: providerAt },
    policy
  );
  assert.equal(ambiguous.status, "terminal_ambiguity");
  const misleadingOk = applyProviderResultToAlertReceipt(
    makeSending(),
    { ok: true, statusCode: 503, error: { message: "temporary unavailable" } },
    { expectedVersion: 2, retryAt, now: providerAt },
    policy
  );
  assert.equal(misleadingOk.status, "retryable_rejection");
  const unknownTemporary = applyProviderResultToAlertReceipt(
    makeSending(),
    { error: { message: "temporary connection failure" } },
    { expectedVersion: 2, now: providerAt },
    policy
  );
  assert.equal(unknownTemporary.status, "terminal_ambiguity");
  assert.throws(
    () =>
      transitionAlertReceipt(
        ambiguous,
        {
          expectedVersion: ambiguous.receipt_version,
          status: "pending",
          executionId: "operator-not-authorized",
          now: retryAt
        },
        policy
      ),
    /terminal_ambiguity -> pending/
  );
  assert.throws(
    () =>
      transitionAlertReceipt(
        retryable,
        {
          expectedVersion: retryable.receipt_version,
          status: "pending",
          executionId: "execution-too-early",
          now: "2026-08-02T06:04:59.999Z"
        },
        policy
      ),
    /retry is not due/
  );
});

test("receipt persistence allowlist redacts provider secrets and excludes raw payloads", () => {
  const sending = transitionAlertReceipt(
    createPendingAlertReceipt(
      {
        idempotencyKey: key,
        canonicalJobId: "onlinejobs.ph:6101",
        executionId: "execution-1",
        now
      },
      policy
    ),
    { expectedVersion: 1, status: "sending", now: later },
    policy
  );
  const failed = applyProviderResultToAlertReceipt(
    sending,
    {
      statusCode: 429,
      raw_response: { generated_message: "private complete message" },
      error: {
        message:
          "Authorization: Bearer private-token webhook=https://hooks.slack.com/private"
      }
    },
    { expectedVersion: 2, retryAt, now: providerAt },
    policy
  );
  const persisted = alertReceiptPersistenceRow(
    {
      ...failed,
      generated_message: "private complete message",
      job_description: "private job description",
      profile_context: "private profile",
      raw_response: "private raw response"
    },
    policy
  );
  const serialized = JSON.stringify(persisted);
  assert.doesNotMatch(
    serialized,
    /private-token|hooks\.slack\.com|private complete message|private job description|private profile|private raw response/
  );
  assert.ok(failed.error_summary.length <= policy.bounds.error_summary);
  const delivered = applyProviderResultToAlertReceipt(
    sending,
    { statusCode: 200, reference: "private complete message copied here" },
    { expectedVersion: 2, now: providerAt },
    policy
  );
  assert.equal(delivered.provider_reference, "accepted");
  const credentialReference = applyProviderResultToAlertReceipt(
    sending,
    { statusCode: 200, reference: "xoxb-private-credential" },
    { expectedVersion: 2, now: providerAt },
    policy
  );
  assert.equal(credentialReference.provider_reference, "accepted");
});

test("delivered receipts reconcile every allowed current owner without provider work", () => {
  const delivered = deliveredReceipt();
  const toApply = readyRecord();
  const applied = movedRecord("Applied Jobs");
  const archive = movedRecord("Archive");
  for (const [store, record] of [
    ["To Apply", toApply],
    ["Applied Jobs", applied],
    ["Archive", archive]
  ]) {
    const plan = planDeliveredReceiptReconciliation(
      delivered,
      stores({ [store]: [record] }),
      schema,
      policy,
      "2026-08-02T06:03:00.000Z"
    );
    assert.equal(plan.provider_send, false);
    assert.equal(plan.owner_store, store);
    assert.equal(plan.business_update.alert_status, "sent");
    assert.equal(plan.business_update.alert_idempotency_key, key);
    assert.equal(plan.receipt_update.status, "reconciled");
  }
  assert.throws(
    () =>
      planDeliveredReceiptReconciliation(
        delivered,
        stores({ "To Apply": [toApply], "Applied Jobs": [applied] }),
        schema,
        policy,
        now
      ),
    /ambiguous canonical ownership/
  );
  assert.throws(
    () =>
      planDeliveredReceiptReconciliation(
        delivered,
        stores({ "To Apply": [toApply, { ...toApply, row_number: 3 }] }),
        schema,
        policy,
        providerAt
      ),
    /ambiguous canonical ownership/
  );
  assert.throws(
    () =>
      planDeliveredReceiptReconciliation(
        delivered,
        stores({ "To Apply": [{ ...toApply, alert_idempotency_key: "" }] }),
        schema,
        policy,
        providerAt
      ),
    /stale idempotency key/
  );
});

test("reconciled and legacy receipt planning are idempotent and mutation-free", () => {
  const delivered = deliveredReceipt();
  const first = planDeliveredReceiptReconciliation(
    delivered,
    stores({ "To Apply": [readyRecord()] }),
    schema,
    policy,
    "2026-08-02T06:03:00.000Z"
  );
  const repeated = planDeliveredReceiptReconciliation(
    first.receipt_update,
    stores({ "To Apply": [first.business_update] }),
    schema,
    policy,
    "2026-08-02T06:04:00.000Z"
  );
  assert.deepEqual(repeated, {
    classification: "already_reconciled",
    provider_send: false,
    business_update: null,
    receipt_update: null
  });
  assert.deepEqual(
    planDeliveredReceiptReconciliation(
      null,
      stores({ "To Apply": [readyRecord()] }),
      schema,
      policy,
      now
    ),
    {
      classification: "legacy_no_receipt",
      provider_send: false,
      business_update: null,
      receipt_update: null
    }
  );
});

test("persistence adapter prevents concurrent duplicate creation and stale transitions", async () => {
  const backend = new MemoryBackend();
  const adapter = createAlertReceiptPersistenceAdapter(backend, policy);
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  const creates = await Promise.all(
    Array.from({ length: 12 }, () => adapter.create({ ...pending }))
  );
  assert.equal(creates.filter((entry) => entry.created).length, 1);
  assert.equal(backend.rows.size, 1);
  const transitionResults = await Promise.allSettled([
    adapter.transition(key, {
      expectedVersion: 1,
      status: "sending",
      now: later
    }),
    adapter.transition(key, {
      expectedVersion: 1,
      status: "sending",
      now: later
    })
  ]);
  assert.equal(
    transitionResults.filter((entry) => entry.status === "fulfilled").length,
    1
  );
  assert.equal(
    transitionResults.filter((entry) => entry.status === "rejected").length,
    1
  );
  const sending = transitionResults.find(
    (entry) => entry.status === "fulfilled"
  ).value;
  assert.equal(sending.status, "sending");
  assert.deepEqual(n8nReceiptDataTableMutation(sending, 1, policy).match, {
    receipt_id: key,
    receipt_version: 1
  });
  assert.equal(n8nReceiptDataTableMutation(pending, undefined, policy).operation, "upsert");
  assert.equal(
    n8nReceiptDataTableMutation(sending, 1, policy).postcondition.exact_row_count,
    1
  );
});

test("persistence adapter fails closed when the store exposes duplicate identities", async () => {
  const delivered = deliveredReceipt();
  const backend = new MemoryBackend([delivered]);
  backend.getAllById = async () => [delivered, { ...delivered }];
  const adapter = createAlertReceiptPersistenceAdapter(backend, policy);
  await assert.rejects(adapter.get(key), /duplicate current receipts/);
  await assert.rejects(adapter.listDelivered(), /duplicate current receipts|stale data/);
});

test("persistence adapter detects a partial or corrupted durable write", async () => {
  const pending = createPendingAlertReceipt(
    {
      idempotencyKey: key,
      canonicalJobId: "onlinejobs.ph:6101",
      executionId: "execution-1",
      now
    },
    policy
  );
  const backend = new MemoryBackend();
  const adapter = createAlertReceiptPersistenceAdapter(backend, policy);
  await adapter.create(pending);
  backend.compareAndSwap = async (id, version, row) => {
    if (backend.rows.get(id)?.receipt_version !== version) return false;
    backend.rows.set(id, { ...row, status: "pending" });
    return true;
  };
  await assert.rejects(
    adapter.transition(key, {
      expectedVersion: 1,
      status: "sending",
      now: later
    }),
    /invalid data|persisted status does not match/
  );
});

test("persistence adapter survives recreation against a disposable local store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-pipeline-receipts-"));
  const path = join(directory, "receipts.json");
  await writeFile(path, "[]", "utf8");
  try {
    const firstAdapter = createAlertReceiptPersistenceAdapter(
      new FileBackend(path),
      policy
    );
    const pending = createPendingAlertReceipt(
      {
        idempotencyKey: key,
        canonicalJobId: "onlinejobs.ph:6101",
        executionId: "execution-1",
        now
      },
      policy
    );
    await firstAdapter.create(pending);
    await firstAdapter.transition(key, {
      expectedVersion: 1,
      status: "sending",
      now: later
    });
    await firstAdapter.transition(key, {
      expectedVersion: 2,
      status: "delivered",
      providerStatus: 200,
      providerClassification: "accepted",
      providerReference: "slack-ts-1",
      now: providerAt
    });
    const restartedAdapter = createAlertReceiptPersistenceAdapter(
      new FileBackend(path),
      policy
    );
    const afterRestart = await restartedAdapter.get(key);
    assert.equal(afterRestart.status, "delivered");
    assert.equal(afterRestart.receipt_version, 3);
    assert.equal((await restartedAdapter.listDelivered()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
