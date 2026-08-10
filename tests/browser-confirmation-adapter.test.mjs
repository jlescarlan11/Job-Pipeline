import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  attestApplicationHistoryConfirmation,
  browserConfirmationAdapterPublicKey
} from "../src/browser-confirmation-adapter.mjs";
import {
  browserConfirmationPublicKeyDigest,
  browserConfirmationWitness,
  verifyBrowserConfirmationAttestation
} from "../src/browser-confirmation-attestation.mjs";
import {
  provisionedBrowserTask,
  validateProvisionedBrowserTask
} from "../src/browser-task-runtime.mjs";

const sourceTask = JSON.parse(
  await readFile(
    new URL("../config/browser-executor-task.json", import.meta.url),
    "utf8"
  )
);
const provisionCli = fileURLToPath(
  new URL("../scripts/provision-browser-automation-runtime.mjs", import.meta.url)
);

const clickBinding = {
  schema_version: 1,
  store_id: `browser-click-store-v1:${"a".repeat(64)}`,
  ledger_id: `browser-click-ledger-v1:${"b".repeat(64)}`,
  generation_id: `browser-click-generation-v1:${"c".repeat(64)}`,
  manifest_sha256: `sha256:${"d".repeat(64)}`,
  directory_binding_digest: `sha256:${"e".repeat(64)}`,
  directory_identity: "fs-object-v1:501:20:1:100",
  witness_identity: "fs-object-v1:501:20:1:101"
};

function postSubmitRecord(overrides = {}) {
  return {
    browser_state: "submit_started",
    canonical_job_id: "onlinejobs.ph:1648408",
    source_job_id: "1648408",
    canonical_url:
      "https://www.onlinejobs.ph/jobseekers/job/Vibe-Coder-FullTime-1648408",
    automation_contract_version: "browser-contract-v1",
    browser_attempt_id: `attempt-v1:${"1".repeat(64)}`,
    browser_job_digest: `job-v1:${"2".repeat(64)}`,
    browser_context_digest: `context-v1:${"3".repeat(64)}`,
    browser_form_fingerprint: `form-v1:${"4".repeat(64)}`,
    submission_idempotency_key: `submission-v1:${"5".repeat(64)}`,
    submission_started_at: "2026-08-10T05:03:00.000Z",
    message_profile_version: "candidate-profile-v1",
    message_policy_version: "application-policy-v1",
    application_pack_version: "application-pack-v1",
    application_pack_policy_version: "application-pack-policy-v1",
    ...overrides
  };
}

test("runtime overlay provisions only public trust and click receipt pins", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const runtimeTask = provisionedBrowserTask(sourceTask, {
    clickBinding,
    publicKey,
    keyId: "onlinejobs-history-adapter-v1"
  });
  assert.equal(runtimeTask.source_control_state, "provisioned_runtime");
  assert.equal(
    runtimeTask.confirmation_attestation.public_key_spki_sha256,
    browserConfirmationPublicKeyDigest(publicKey)
  );
  assert.equal(runtimeTask.click_consumption.store_id, clickBinding.store_id);
  assert.deepEqual(validateProvisionedBrowserTask(sourceTask, runtimeTask, publicKey), []);
  assert.equal(sourceTask.source_control_state, "inactive_unscheduled");
  assert.equal(sourceTask.click_consumption.store_id, "unprovisioned");

  const changed = structuredClone(runtimeTask);
  changed.runtime.schedule_minutes = 1;
  assert.deepEqual(validateProvisionedBrowserTask(sourceTask, changed, publicKey), [
    "browser runtime task changes fields outside the provisioning boundary"
  ]);
});

test("independent application-history observation produces a verifiable exact witness", () => {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = browserConfirmationAdapterPublicKey(privateKey);
  const keyId = "onlinejobs-history-adapter-v1";
  const publicKeySpkiSha256 = browserConfirmationPublicKeyDigest(publicKey);
  const record = postSubmitRecord();
  const result = attestApplicationHistoryConfirmation(
    record,
    {
      thread_reference: "message/conversation/bmNDN03d",
      observed_source_job_id: "1648408",
      observed_canonical_url:
        "https://www.onlinejobs.ph/jobseekers/job/Vibe-Coder-FullTime-1648408",
      observed_at: "2026-08-10T05:05:00.000Z"
    },
    { privateKey, keyId, publicKeySpkiSha256 }
  );
  assert.equal(result.result, "confirmed");
  assert.equal(result.confirmation_kind, "application_history");
  assert.equal(result.confirmation_reference.includes("Vibe Coder"), false);
  assert.equal(
    verifyBrowserConfirmationAttestation(
      browserConfirmationWitness(record, result),
      result.confirmation_attestation,
      { publicKey, keyId, publicKeySpkiSha256 }
    ),
    true
  );
  assert.throws(
    () =>
      attestApplicationHistoryConfirmation(
        record,
        {
          thread_reference: "message/conversation/bmNDN03d",
          observed_source_job_id: "9999999",
          observed_canonical_url: record.canonical_url,
          observed_at: "2026-08-10T05:05:00.000Z"
        },
        { privateKey, keyId, publicKeySpkiSha256 }
      ),
    /does not match submit intent/
  );
});

test("browser runtime provisioning writes a private one-time adapter boundary", () => {
  const parent = mkdtempSync(join(tmpdir(), "job-pipeline-browser-runtime-"));
  const clickRoot = join(parent, "click");
  const clickDirectory = join(clickRoot, "store");
  const clickWitness = join(clickRoot, "witness.json");
  const clickBindingPath = join(clickRoot, "binding.json");
  const runtimeRoot = join(parent, "runtime");
  try {
    mkdirSync(clickDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(clickWitness, "{}\n", { mode: 0o600 });
    writeFileSync(
      clickBindingPath,
      `${JSON.stringify({
        ...clickBinding,
        created_at: "2026-08-10T05:00:00.000Z",
        directory: clickDirectory,
        witness_path: clickWitness
      })}\n`,
      { mode: 0o600 }
    );
    chmodSync(clickBindingPath, 0o600);
    const first = spawnSync(
      process.execPath,
      [provisionCli, runtimeRoot, clickBindingPath],
      { encoding: "utf8" }
    );
    assert.equal(first.status, 0, first.stderr);
    const summary = JSON.parse(first.stdout);
    assert.equal(summary.provisioned, true);
    assert.equal(statSync(runtimeRoot).mode & 0o777, 0o700);
    for (const file of [
      "adapter-private-key.pem",
      "attestation-public-key.pem",
      "browser-task.json",
      "binding.json",
      "run-browser-executor.zsh",
      "run-confirmation-adapter.zsh"
    ]) {
      assert.equal(
        statSync(join(runtimeRoot, file)).mode & 0o777,
        file.endsWith(".zsh") ? 0o700 : 0o600
      );
    }
    assert.doesNotMatch(
      readFileSync(join(runtimeRoot, "browser-task.json"), "utf8"),
      /PRIVATE KEY/
    );
    const second = spawnSync(
      process.execPath,
      [provisionCli, runtimeRoot, clickBindingPath],
      { encoding: "utf8" }
    );
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists; never overwrite it/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
