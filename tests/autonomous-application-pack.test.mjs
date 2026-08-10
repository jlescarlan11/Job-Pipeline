import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildApplicationPack,
  validateApplicationPack
} from "../src/evaluation.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const [profile, applicationPolicy, packPolicy] = await Promise.all([
  loadJson("../config/candidate-profile.json"),
  loadJson("../config/application-policy.json"),
  loadJson("../config/application-pack-policy.json")
]);
const now = "2026-08-10T02:00:00.000Z";

function job(description, overrides = {}) {
  return {
    source: "onlinejobs.ph",
    source_job_id: "9901",
    canonical_job_id: "onlinejobs.ph:9901",
    canonical_url: "https://www.onlinejobs.ph/jobseekers/job/example-9901",
    job_title: "Full-Stack TypeScript Developer",
    company: "Example Company",
    job_description: description,
    source_availability: "active",
    execution_mode: "autonomous_chrome",
    automation_contract_version: "browser-contract-v1",
    user_action: "",
    ...overrides
  };
}

test("answerable screening questions are policy-authorized without fake review", () => {
  const pack = buildApplicationPack(
    job(
      "Build React, TypeScript, Node.js, and PostgreSQL production features. Please describe one production incident you resolved?"
    ),
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  assert.equal(pack.application_pack_status, "ready");
  assert.equal(pack.review_approved_at, "");
  assert.equal(pack.review_approval_guard, "");
  assert.ok(
    pack.screening_questions.some(
      (question) =>
        question.answer_status === "answer_in_message" &&
        question.policy_authorized === true &&
        question.review_acknowledged !== true
    )
  );
  assert.deepEqual(validateApplicationPack(pack, profile, packPolicy), []);
});

test("unknown candidate facts, ambiguity, and unsafe steps block instead of review", () => {
  const cases = [
    "Build React and TypeScript applications. What salary do you require?",
    "Build React and TypeScript applications. If applicable, start your message with Hello Hiring Team.",
    "Build React and TypeScript applications. Complete this required external form and upload an assessment video."
  ];
  for (const description of cases) {
    const pack = buildApplicationPack(
      job(description),
      profile,
      applicationPolicy,
      packPolicy,
      now
    );
    assert.equal(pack.application_pack_status, "blocked", description);
    assert.notEqual(pack.application_pack_status, "review_required");
    assert.equal(pack.review_approved_at, "");
    assert.ok(
      pack.application_warnings.some(
        (warning) =>
          warning.severity === "blocked" &&
          warning.policy_authorized !== true
      )
    );
    assert.deepEqual(validateApplicationPack(pack, profile, packPolicy), []);
  }
});

test("legacy manual packs retain explicit human-review semantics", () => {
  const pack = buildApplicationPack(
    job(
      "Build React and TypeScript applications. Please describe one production incident you resolved?",
      { execution_mode: "legacy_manual", automation_contract_version: "" }
    ),
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  assert.equal(pack.application_pack_status, "review_required");
  assert.ok(
    pack.screening_questions.every(
      (question) => question.policy_authorized !== true
    )
  );
});
