import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidProfileConfiguration,
  validateApplicationPolicy,
  validateCandidateProfile
} from "../src/profile.mjs";
import {
  canTransition,
  canonicalJobId,
  claimRecord,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  stateGuard,
  transitionRecord,
  validatePipelineSchema
} from "../src/contracts.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const profile = await loadJson("../config/candidate-profile.json");
const policy = await loadJson("../config/application-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");

test("current profile, application policy, and schema are valid", () => {
  assert.deepEqual(validateCandidateProfile(profile), []);
  assert.deepEqual(validateApplicationPolicy(policy, profile), []);
  assert.deepEqual(validatePipelineSchema(schema), []);
  assert.equal(assertValidProfileConfiguration(profile, policy), true);
});

test("profile validation rejects missing required data", () => {
  const invalid = structuredClone(profile);
  delete invalid.candidate.email;
  assert.match(validateCandidateProfile(invalid).join("\n"), /candidate\.email is required/);
});

test("profile validation rejects an unsupported URL and obsolete fact", () => {
  const invalid = structuredClone(profile);
  invalid.candidate.links.portfolio = "http://johnlesterescarlan.netlify.app";
  const errors = validateCandidateProfile(invalid).join("\n");
  assert.match(errors, /must use https/);
  assert.match(errors, /obsolete or unsupported profile term/);
});

test("profile and policy validation reject invalid versions", () => {
  const invalidProfile = structuredClone(profile);
  invalidProfile.profile_version = "latest";
  assert.match(validateCandidateProfile(invalidProfile).join("\n"), /YYYY-MM-DD/);

  const invalidPolicy = structuredClone(policy);
  invalidPolicy.candidate_profile_version = "2025-01-01";
  assert.match(validateApplicationPolicy(invalidPolicy, profile).join("\n"), /must match/);
});

test("canonical identity uses OnlineJobs source id and normalized legacy URL", () => {
  const url = "http://www.ONLINEJOBS.ph/jobseekers/job/react-developer-12345/?tracking=yes#top";
  assert.equal(normalizeCanonicalUrl(url), "https://onlinejobs.ph/jobseekers/job/react-developer-12345");
  assert.equal(canonicalJobId({ job_url: url }), "onlinejobs.ph:12345");
  assert.equal(normalizeCanonicalUrl("https://example.com/job/12345"), "");
  assert.equal(normalizeCanonicalUrl("https://localhost/jobseekers/job/internal-12345"), "");
  assert.equal(
    normalizeCanonicalUrl("https://onlinejobs.ph:444/jobseekers/job/internal-12345"),
    ""
  );
  assert.equal(normalizeCanonicalUrl("https://onlinejobs.ph/jobseekers/jobsearch"), "");
});

test("legacy records preserve decisions and generated messages", () => {
  const legacy = normalizeLegacyRecord(
    {
      job_url: "https://www.onlinejobs.ph/jobseekers/job/full-stack-developer-777",
      status: "applied",
      "created_at ": "2026-07-01T00:00:00.000Z",
      generated_message: "Existing reviewed message"
    },
    schema,
    "2026-07-28T00:00:00.000Z"
  );
  assert.equal(legacy.pipeline_status, "applied");
  assert.equal(legacy.application_decision, "applied");
  assert.equal(legacy.created_at, "2026-07-01T00:00:00.000Z");
  assert.equal(legacy.generated_message, "Existing reviewed message");
  assert.equal(legacy.message_profile_version, "legacy/unknown");
  assert.equal(legacy.canonical_job_id, "onlinejobs.ph:777");
  assert.equal(legacy.state_guard, stateGuard(legacy));
});

test("state transitions allow required paths and reject invalid ones", () => {
  assert.equal(canTransition(schema, "discovered", "evaluating"), true);
  assert.equal(canTransition(schema, "ready", "applied"), true);
  assert.equal(canTransition(schema, "retryable_error", "generating"), true);
  assert.equal(canTransition(schema, "archived", "ready"), false);
  assert.throws(
    () => transitionRecord({ pipeline_status: "archived" }, "ready", schema),
    /Invalid pipeline transition/
  );
});

test("processing claims reject overlapping work and allow stale recovery", () => {
  const active = {
    processing_token: "token-a",
    processing_started_at: "2026-07-28T00:00:00.000Z"
  };
  const overlapping = claimRecord(active, {
    stage: "evaluation",
    token: "token-b",
    now: "2026-07-28T00:05:00.000Z",
    leaseMs: 10 * 60 * 1000
  });
  assert.equal(overlapping.claimed, false);

  const recovered = claimRecord(active, {
    stage: "evaluation",
    token: "token-b",
    now: "2026-07-28T00:11:00.000Z",
    leaseMs: 10 * 60 * 1000
  });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.record.processing_token, "token-b");
});

test("state guards change with manual lifecycle state but not processing metadata", () => {
  const base = {
    canonical_job_id: "onlinejobs.ph:9201",
    pipeline_status: "recommended",
    application_decision: "",
    outcome: ""
  };
  assert.equal(
    stateGuard({ ...base, processing_token: "claim-a" }),
    stateGuard({ ...base, processing_token: "claim-b" })
  );
  assert.notEqual(
    stateGuard(base),
    stateGuard({ ...base, pipeline_status: "skipped", application_decision: "skipped" })
  );
});
