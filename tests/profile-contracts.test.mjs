import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertValidProfileConfiguration,
  validateApplicationPolicy,
  validateCandidateProfile
} from "../src/profile.mjs";
import {
  applyValidatedRecordUpdate,
  canTransition,
  canonicalJobId,
  claimRecord,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  parseHttpUrl,
  processingCommitGuard,
  stateGuard,
  transitionRecord,
  validatePipelineSchema,
  validateRecordContract
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

test("HTTP URL parsing is sandbox-safe and rejects unsafe authority forms", () => {
  assert.deepEqual(
    parseHttpUrl("https://github.com/jlescarlan11"),
    {
      protocol: "https:",
      hostname: "github.com",
      port: "",
      pathname: "/jlescarlan11",
      search: "",
      hash: "",
      username: "",
      password: "",
      href: "https://github.com/jlescarlan11"
    }
  );
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("https://user:secret@example.com/path"), null);
  assert.equal(parseHttpUrl("https://example.com:99999/path"), null);
  assert.equal(parseHttpUrl("https://example.com/path with spaces"), null);
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
  assert.equal(legacy.qualification_score, "");
  assert.equal(legacy.opportunity_score, "");
  assert.equal(legacy.ranking_confidence, "");
  assert.deepEqual(legacy.outcome_events, []);
  assert.equal(legacy.canonical_job_id, "onlinejobs.ph:777");
  assert.equal(legacy.state_guard, stateGuard(legacy));
});

test("opportunity-learning contract normalizes and validates persistent values", () => {
  const normalized = normalizeLegacyRecord(
    {
      canonical_url: "https://onlinejobs.ph/jobseekers/job/contract-8101",
      qualification_score: "84",
      opportunity_score: 79,
      ranking_confidence: "high",
      apply_points_recommendation: "high_allocation",
      ranking_factors: JSON.stringify([{ factor: "qualification", contribution: 30 }]),
      ranking_missing_signals: JSON.stringify(["salary"]),
      requirement_gap_details: JSON.stringify([{ requirement: "Kubernetes", severity: "hard" }]),
      application_instructions: JSON.stringify([{ text: "Use a specific subject", required: true }]),
      screening_questions: JSON.stringify([{ text: "Describe a similar project", required: true }]),
      selected_proof_refs: JSON.stringify(["projects:job-pipeline"]),
      application_warnings: JSON.stringify([{ code: "missing_attachment" }]),
      application_pack_status: "review_required",
      alert_status: "pending",
      alert_attempt_count: "1",
      first_reviewed_at: "2026-07-28T10:00:00.000Z",
      apply_points_used: "8",
      application_message_strategy: "instruction-aware/v1",
      application_qualification_score: "84",
      application_opportunity_score: "79",
      application_ranking_confidence: "high",
      application_apply_points_recommendation: "high_allocation",
      application_pack_status_at_apply: "ready",
      application_posting_age_days: "1.5",
      application_snapshot_at: "2026-07-28T10:05:00.000Z",
      outcome_events: JSON.stringify([
        { id: "reply-1", type: "replied", at: "2026-07-28T11:00:00.000Z" }
      ])
    },
    schema,
    "2026-07-28T09:00:00.000Z"
  );

  assert.equal(normalized.qualification_score, 84);
  assert.equal(normalized.apply_points_used, 8);
  assert.equal(normalized.application_posting_age_days, 1.5);
  assert.deepEqual(normalized.ranking_missing_signals, ["salary"]);
  assert.equal(normalized.ranking_factors[0].factor, "qualification");
  assert.equal(normalized.outcome_events[0].type, "replied");
  assert.deepEqual(validateRecordContract(normalized, schema), []);
});

test("record contract rejects invalid scores, enums, timestamps, points, and JSON arrays", () => {
  const invalid = normalizeLegacyRecord(
    {
      canonical_url: "https://onlinejobs.ph/jobseekers/job/invalid-contract-8102",
      qualification_score: 101,
      opportunity_score: -1,
      ranking_confidence: "certain",
      apply_points_recommendation: "spend_everything",
      application_pack_status: "complete",
      alert_status: "delivered",
      apply_points_used: 61,
      apply_points_input: 0,
      application_message_strategy_input: "not versioned",
      first_reviewed_at: "not-a-date",
      ranking_factors: "{\"factor\":\"qualification\"}",
      outcome_events: [
        { id: "duplicate", type: "replied", at: "not-a-date" },
        { id: "duplicate", type: "invented", at: "2026-07-28T10:00:00.000Z" }
      ]
    },
    schema,
    "2026-07-28T09:00:00.000Z"
  );
  const errors = validateRecordContract(invalid, schema).join("\n");
  assert.match(errors, /qualification_score must be at most 100/);
  assert.match(errors, /opportunity_score must be at least 0/);
  assert.match(errors, /ranking_confidence has unsupported value/);
  assert.match(errors, /apply_points_recommendation has unsupported value/);
  assert.match(errors, /application_pack_status has unsupported value/);
  assert.match(errors, /alert_status has unsupported value/);
  assert.match(errors, /apply_points_used must be at most 60/);
  assert.match(errors, /apply_points_input must be at least 1/);
  assert.match(errors, /application_message_strategy_input has an unsupported format/);
  assert.match(errors, /first_reviewed_at must be a valid timestamp/);
  assert.match(errors, /ranking_factors must be a JSON array/);
  assert.match(errors, /outcome_events\[0\]\.at is invalid/);
  assert.match(errors, /outcome_events contains duplicate id/);
  assert.match(errors, /outcome_events\[1\]\.type is invalid/);
});

test("an invalid contract update is atomic and leaves the previous record unchanged", () => {
  const previous = normalizeLegacyRecord(
    {
      canonical_url: "https://onlinejobs.ph/jobseekers/job/valid-contract-8103",
      qualification_score: 84,
      opportunity_score: 79,
      ranking_confidence: "high"
    },
    schema,
    "2026-07-28T09:00:00.000Z"
  );
  const snapshot = structuredClone(previous);

  assert.throws(
    () =>
      applyValidatedRecordUpdate(
        previous,
        { qualification_score: 101, ranking_confidence: "certain" },
        schema
      ),
    /Invalid record update/
  );
  assert.deepEqual(previous, snapshot);
});

test("the durable contract does not define credential or reusable action-token fields", () => {
  const forbidden = schema.fields.filter((field) =>
    /(?:secret|password|credential|access_token|refresh_token|callback_token)/i.test(field)
  );
  assert.deepEqual(forbidden, []);
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
  assert.equal(
    recovered.record.processing_commit_guard,
    processingCommitGuard("token-b")
  );
  assert.equal(processingCommitGuard(""), "");
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
  assert.notEqual(
    stateGuard(base),
    stateGuard({ ...base, first_reviewed_at: "2026-07-28T10:00:00.000Z" })
  );
  assert.notEqual(
    stateGuard(base),
    stateGuard({ ...base, apply_points_used: 8 })
  );
  assert.notEqual(
    stateGuard(base),
    stateGuard({
      ...base,
      outcome_events: [
        { id: "reply-1", type: "replied", at: "2026-07-28T11:00:00.000Z" }
      ]
    })
  );
});
