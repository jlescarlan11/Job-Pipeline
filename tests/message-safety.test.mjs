import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluatePersistedMessageSafety } from "../src/message-safety.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson(
  "../config/application-policy.json"
);
const packPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const context = { profile, applicationPolicy, packPolicy };
const now = "2026-07-28T12:00:00.000Z";

const currentSafe = (overrides = {}) => ({
  canonical_job_id: "onlinejobs.ph:safety-control",
  job_title: "TypeScript Developer",
  generated_message:
    "Hi there,\n\nI build TypeScript and React applications using approved profile evidence.\n\nPortfolio: https://johnlesterescarlan.pro",
  message_profile_version: profile.profile_version,
  message_policy_version: applicationPolicy.policy_version,
  message_validation_status: "valid",
  application_instructions: [],
  screening_questions: [],
  selected_proof_refs: [
    "experience:upwork",
    "projects:job-pipeline"
  ],
  application_warnings: [],
  application_pack_status: "ready",
  application_pack_version: packPolicy.pack_version,
  application_pack_profile_version: profile.profile_version,
  application_pack_policy_version: packPolicy.policy_version,
  application_pack_generated_at: now,
  ...overrides
});

test("a current validated persisted message and pack pass the shared gate", () => {
  assert.deepEqual(
    evaluatePersistedMessageSafety(currentSafe(), context),
    { safe: true, reasons: [] }
  );
});

test("persisted message safety reports every provenance, content, and pack quarantine reason", () => {
  const cases = [
    ["message_profile_legacy", { message_profile_version: "legacy/unknown" }],
    ["message_profile_missing", { message_profile_version: "" }],
    ["message_profile_mismatch", { message_profile_version: "2025-01-01" }],
    ["message_policy_missing", { message_policy_version: "" }],
    ["message_policy_mismatch", { message_policy_version: "2025-01-01" }],
    ["message_validation_not_valid", { message_validation_status: "" }],
    ["message_missing", { generated_message: "" }],
    [
      "message_content_invalid",
      {
        generated_message:
          "Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf"
      }
    ],
    [
      "message_content_invalid",
      { generated_message: "I have a strong foundation in TypeScript." }
    ],
    ["pack_status_not_ready", { application_pack_status: "review_required" }],
    ["pack_version_mismatch", { application_pack_version: "old/v1" }],
    [
      "pack_profile_mismatch",
      { application_pack_profile_version: "2025-01-01" }
    ],
    [
      "pack_policy_mismatch",
      { application_pack_policy_version: "old/v1" }
    ],
    ["pack_invalid", { application_pack_generated_at: "not-a-date" }]
  ];
  for (const [reason, overrides] of cases) {
    const result = evaluatePersistedMessageSafety(
      currentSafe(overrides),
      context
    );
    assert.equal(result.safe, false);
    assert.ok(
      result.reasons.includes(reason),
      `${reason} was not reported`
    );
  }
});

test("combined unsafe evidence stays deterministic and fail-closed", () => {
  const result = evaluatePersistedMessageSafety(
    currentSafe({
      generated_message:
        "I have a strong foundation. Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
      message_profile_version: "legacy/unknown",
      message_policy_version: "",
      message_validation_status: "",
      application_pack_status: "",
      application_pack_version: "",
      application_pack_profile_version: "",
      application_pack_policy_version: "",
      application_pack_generated_at: ""
    }),
    context
  );
  assert.deepEqual(result.reasons, [
    "message_profile_legacy",
    "message_policy_missing",
    "message_validation_not_valid",
    "pack_status_not_ready",
    "pack_version_mismatch",
    "pack_profile_mismatch",
    "pack_policy_mismatch",
    "pack_invalid",
    "message_content_invalid"
  ]);
});

test("missing safety configuration cannot authorize dispatch", () => {
  assert.deepEqual(evaluatePersistedMessageSafety(currentSafe()), {
    safe: false,
    reasons: ["message_safety_configuration_missing"]
  });
});

test("stale ready messages retain historical provenance and fail closed after a profile update", () => {
  const historical = currentSafe({
    message_profile_version: "2026-07-28",
    application_pack_profile_version: "2026-07-28"
  });
  const snapshot = structuredClone(historical);

  const result = evaluatePersistedMessageSafety(historical, context);

  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes("message_profile_mismatch"));
  assert.ok(result.reasons.includes("pack_profile_mismatch"));
  assert.deepEqual(historical, snapshot);
  assert.equal(historical.generated_message, snapshot.generated_message);
});
