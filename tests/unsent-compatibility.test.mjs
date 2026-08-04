import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeLegacyRecord,
  preparationInputGuard,
  stateGuard,
  validateRecordStoreContract
} from "../src/contracts.mjs";
import { buildApplicationPack } from "../src/evaluation.mjs";
import { buildUnsentCompatibilityInventory } from "../src/unsent-compatibility.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [
  profile,
  applicationPolicy,
  packPolicy,
  pipelineSchema,
  deploymentPolicy
] = await Promise.all([
  loadJson("../config/candidate-profile.json"),
  loadJson("../config/application-policy.json"),
  loadJson("../config/application-pack-policy.json"),
  loadJson("../config/pipeline-schema.json"),
  loadJson("../config/n8n-deployment-policy.json")
]);
const now = "2026-08-03T10:00:00.000Z";
const job = {
  canonical_job_id: "onlinejobs.ph:unsent-control",
  source_job_id: "unsent-control",
  source: "onlinejobs.ph",
  canonical_url: "https://www.onlinejobs.ph/jobseekers/job/unsent-control",
  job_title: "TypeScript Developer",
  source_availability: "active",
  job_description:
    "Build and maintain TypeScript, React, Node.js, and PostgreSQL product features for production workflows."
};
const pack = buildApplicationPack(
  job,
  profile,
  applicationPolicy,
  packPolicy,
  now
);

function safeRecord(overrides = {}) {
  const record = normalizeLegacyRecord(
    {
      ...job,
      pipeline_status: "ready_to_apply",
      generated_message:
        "Subject line: TypeScript Developer Application — John Lester Escarlan\n\nHi there,\n\nI delivered three client-facing features using React, TypeScript, and Node.js.\n\nI would welcome a conversation about how my experience fits this role.\n\nPortfolio: https://johnlesterescarlan.pro",
      message_profile_version: profile.profile_version,
      message_policy_version: applicationPolicy.policy_version,
      message_validation_status: "valid",
      application_instructions: pack.application_instructions,
      screening_questions: pack.screening_questions,
      requirement_coverage: pack.requirement_coverage,
      application_message_plan: [pack.message_plan],
      selected_proof_refs: pack.selected_proof_refs,
      application_warnings: pack.application_warnings,
      application_pack_status: pack.application_pack_status,
      application_pack_version: pack.application_pack_version,
      application_pack_profile_version: pack.application_pack_profile_version,
      application_pack_policy_version: pack.application_pack_policy_version,
      coverage_contract_version: pack.coverage_contract_version,
      message_plan_version: pack.message_plan.version,
      application_pack_generated_at: pack.application_pack_generated_at,
      ...overrides
    },
    pipelineSchema,
    now
  );
  record.prep_status = "message_ready";
  record.preparation_version = 1;
  record.preparation_updated_at = now;
  record.preparation_input_guard = preparationInputGuard(record);
  record.state_guard = stateGuard(record);
  return record;
}

const context = {
  profile,
  applicationPolicy,
  packPolicy,
  pipelineSchema,
  applicationCompatibility: deploymentPolicy.application_compatibility,
  capturedAt: now
};

test("unsent inventory uses the shared safety gate and emits only bounded digests", () => {
  const current = safeRecord();
  assert.deepEqual(
    validateRecordStoreContract(current, "To Apply", pipelineSchema),
    []
  );
  const stale = safeRecord({
    canonical_job_id: "onlinejobs.ph:unsent-stale",
    source_job_id: "unsent-stale",
    canonical_url: "https://www.onlinejobs.ph/jobseekers/job/unsent-stale",
    application_pack_version: "legacy/v1"
  });
  const inventory = buildUnsentCompatibilityInventory({
    ...context,
    records: [current, stale],
    dispositions: {
      "onlinejobs.ph:unsent-stale": "return_to_review"
    }
  });
  assert.equal(inventory.total_records, 2);
  assert.equal(inventory.compatible_records, 1);
  assert.equal(inventory.incompatible_records, 1);
  assert.equal(inventory.unhandled_incompatible_records, 0);
  const incompatible = inventory.records.find((record) => !record.safe);
  assert.ok(incompatible.reason_codes.includes("pack_version_mismatch"));
  assert.equal(incompatible.disposition, "return_to_review");
  const serialized = JSON.stringify(inventory);
  assert.doesNotMatch(serialized, /unsent-control|unsent-stale|generated_message|job_description|John Lester/);
  assert.match(inventory.records[0].identity_digest, /^sha256:[0-9a-f]{64}$/);
});

test("missing dispositions remain visibly pending and duplicate identities fail closed", () => {
  const stale = safeRecord({ application_pack_version: "legacy/v1" });
  const inventory = buildUnsentCompatibilityInventory({
    ...context,
    records: [stale]
  });
  assert.equal(inventory.unhandled_incompatible_records, 1);
  assert.equal(inventory.records[0].disposition, "pending");
  assert.throws(
    () =>
      buildUnsentCompatibilityInventory({
        ...context,
        records: [stale, structuredClone(stale)]
      }),
    /duplicate identity/
  );
});
