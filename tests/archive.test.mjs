import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  archiveRecordIsComplete,
  confirmArchiveDeletions,
  prepareArchiveCandidates,
  prepareArchiveUpserts
} from "../src/archive.mjs";

const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url), "utf8")
);
const now = "2026-07-28T09:00:00.000Z";

const active = (overrides = {}) => ({
  row_number: 5,
  source: "onlinejobs.ph",
  source_job_id: "4001",
  canonical_job_id: "onlinejobs.ph:4001",
  canonical_url: "https://onlinejobs.ph/jobseekers/job/example-4001",
  job_title: "Example job",
  pipeline_status: "applied",
  application_decision: "applied",
  application_decided_at: "2026-07-27T10:00:00.000Z",
  generated_message: "Keep this message",
  profile_version: "2026-07-28",
  ...overrides
});

test("retryable and terminal generation failures remain active while other terminal states are eligible", () => {
  const plan = prepareArchiveCandidates(
    [
      active({
        pipeline_status: "retryable_error",
        failed_stage: "generation",
        application_decision: ""
      }),
      active({
        row_number: 6,
        source_job_id: "4002",
        canonical_job_id: "onlinejobs.ph:4002",
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/example-4002",
        pipeline_status: "terminal_error",
        failed_stage: "generation",
        application_decision: ""
      }),
      active({
        row_number: 7,
        source_job_id: "4003",
        canonical_job_id: "onlinejobs.ph:4003",
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/example-4003",
        pipeline_status: "terminal_error",
        failed_stage: "evaluation",
        application_decision: ""
      }),
      active({
        row_number: 8,
        source_job_id: "4004",
        canonical_job_id: "onlinejobs.ph:4004",
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/example-4004",
        pipeline_status: "not_recommended",
        application_decision: ""
      })
    ],
    [],
    schema,
    { now }
  );
  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(
    plan.retained.map((entry) => entry.reason),
    ["retryable_error", "terminal_generation_requires_review"]
  );
  assert.deepEqual(
    plan.candidates.map((entry) => entry.canonical_job_id),
    ["onlinejobs.ph:4004", "onlinejobs.ph:4003"]
  );
});

test("eligible rows with unresolved processing claims remain active", () => {
  const plan = prepareArchiveCandidates(
    [
      active({
        processing_stage: "alert",
        processing_token: "alert:live",
        processing_started_at: "2026-07-28T08:59:00.000Z"
      }),
      active({
        row_number: 6,
        source_job_id: "4002",
        canonical_job_id: "onlinejobs.ph:4002",
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/example-4002",
        pipeline_status: "skipped",
        application_decision: "skipped",
        processing_stage: "generation",
        processing_token: "generation:orphan",
        processing_started_at: "2026-07-27T08:00:00.000Z"
      })
    ],
    [],
    schema,
    { now }
  );
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(
    plan.retained.map((entry) => entry.reason),
    ["active_processing_claim", "active_processing_claim"]
  );
});

test("duplicate active identities cannot become archive candidates", () => {
  const duplicate = active({
    row_number: 6,
    canonical_job_id: "ONLINEJOBS.PH:4001",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/conflicting-4001",
    job_title: "Conflicting duplicate"
  });
  const plan = prepareArchiveCandidates(
    [active(), duplicate],
    [],
    schema,
    { now }
  );
  assert.equal(plan.candidates.length, 0);
  assert.deepEqual(
    plan.retained.map((entry) => entry.reason),
    ["ambiguous_active_identity", "ambiguous_active_identity"]
  );
});

test("archive candidates preserve generated, evaluation, decision, and outcome data", () => {
  const record = active({
    match_score: 82,
    qualification_score: 84,
    opportunity_score: 79,
    ranking_confidence: "high",
    apply_points_recommendation: "high_allocation",
    scoring_policy_version: "2026-07-28/v1",
    ranking_factors: [{ factor: "qualification", contribution: 30 }],
    match_reasons: ["Matched skill: TypeScript"],
    application_pack_status: "ready",
    application_pack_version: "2026-07-28/v1",
    alert_status: "sent",
    alert_sent_at: "2026-07-27T09:10:00.000Z",
    first_reviewed_at: "2026-07-27T09:15:00.000Z",
    apply_points_used: 8,
    application_message_strategy: "instruction-aware/v1",
    application_qualification_score: 84,
    application_opportunity_score: 79,
    application_ranking_confidence: "high",
    application_scoring_policy_version: "2026-07-28/v1",
    application_apply_points_recommendation: "high_allocation",
    application_pack_status_at_apply: "ready",
    application_posting_age_days: 2,
    application_snapshot_at: "2026-07-27T10:00:00.000Z",
    outcome: "interview",
    outcome_at: "2026-07-28T08:00:00.000Z",
    outcome_events: [
      { id: "reply-1", type: "replied", at: "2026-07-27T18:00:00.000Z" },
      { id: "interview-1", type: "interview", at: "2026-07-28T08:00:00.000Z" }
    ]
  });
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const archived = plan.candidates[0].archive_record;
  assert.equal(archived.pipeline_status, "archived");
  assert.equal(archived.archived_from_status, "applied");
  assert.equal(archived.generated_message, "Keep this message");
  assert.equal(archived.match_score, 82);
  assert.equal(archived.qualification_score, 84);
  assert.equal(archived.opportunity_score, 79);
  assert.equal(archived.ranking_confidence, "high");
  assert.equal(archived.application_pack_status, "ready");
  assert.equal(archived.alert_status, "sent");
  assert.equal(archived.apply_points_used, 8);
  assert.equal(archived.application_qualification_score, 84);
  assert.equal(archived.application_pack_status_at_apply, "ready");
  assert.equal(
    archived.application_snapshot_at,
    "2026-07-27T10:00:00.000Z"
  );
  assert.equal(archived.outcome_events.length, 2);
  assert.equal(archived.application_decision, "applied");
  assert.equal(archived.outcome, "interview");
  assert.equal(archived.archived_at, now);
  assert.equal(archiveRecordIsComplete(archived), true);
});

test("archive reconciliation unions cumulative milestones and keeps the latest current view", () => {
  const record = active({
    outcome: "interview",
    outcome_at: "2026-07-28T08:45:00.000Z",
    outcome_events: [
      { id: "interview-1", type: "interview", at: "2026-07-28T08:45:00.000Z" }
    ]
  });
  const existing = {
    ...record,
    row_number: 20,
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-27T12:00:00.000Z",
    outcome: "replied",
    outcome_at: "2026-07-28T08:30:00.000Z",
    outcome_events: [
      { id: "reply-1", type: "replied", at: "2026-07-28T08:30:00.000Z" }
    ]
  };
  const plan = prepareArchiveCandidates([record], [existing], schema, { now });
  const merged = plan.candidates[0].archive_record;
  assert.equal(merged.outcome, "interview");
  assert.equal(merged.outcome_at, "2026-07-28T08:45:00.000Z");
  assert.deepEqual(
    merged.outcome_events.map((event) => event.type),
    ["replied", "interview"]
  );
});

test("existing archive history wins over stale active outcome data", () => {
  const record = active({ outcome: "" });
  const existing = {
    ...record,
    row_number: 20,
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-27T12:00:00.000Z",
    outcome: "offer",
    outcome_at: "2026-07-28T08:30:00.000Z"
  };
  const plan = prepareArchiveCandidates([record], [existing], schema, { now });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].archive_already_complete, true);
  assert.equal(plan.candidates[0].archive_record.outcome, "offer");
  assert.equal(plan.candidates[0].archive_record.archived_at, existing.archived_at);
});

test("newer active automation wins while Archive-owned inputs are preserved", () => {
  const record = active({
    alert_status: "sent",
    alert_sent_at: "2026-07-28T08:50:00.000Z",
    alert_error_category: "",
    alert_error_summary: "",
    processing_stage: "",
    processing_commit_guard: "",
    processing_token: "",
    processing_started_at: "",
    notes: "Active note"
  });
  const existing = {
    ...record,
    row_number: 20,
    pipeline_status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-27T12:00:00.000Z",
    alert_status: "pending",
    alert_sent_at: "",
    alert_error_category: "provider_failure",
    alert_error_summary: "Stale failure",
    processing_stage: "alert",
    processing_commit_guard: "stale-guard",
    processing_token: "stale-token",
    processing_started_at: "2026-07-28T08:00:00.000Z",
    manual_action: "outcome_offer",
    notes: "Current Archive note"
  };
  const plan = prepareArchiveCandidates([record], [existing], schema, {
    now
  });
  const merged = plan.candidates[0].archive_record;
  assert.equal(merged.alert_status, "sent");
  assert.equal(merged.alert_sent_at, record.alert_sent_at);
  assert.equal(merged.alert_error_category, "");
  assert.equal(merged.alert_error_summary, "");
  assert.equal(merged.processing_stage, "");
  assert.equal(merged.processing_commit_guard, "");
  assert.equal(merged.processing_token, "");
  assert.equal(merged.processing_started_at, "");
  assert.equal(merged.manual_action, "outcome_offer");
  assert.equal(merged.notes, "Current Archive note");
});

test("archive upserts rebase current Archive-owned fields before writing", () => {
  const record = active({
    outcome: "replied",
    outcome_at: "2026-07-28T08:15:00.000Z",
    outcome_events: [
      { id: "reply-1", type: "replied", at: "2026-07-28T08:15:00.000Z" }
    ],
    notes: "Initial note"
  });
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const claimed = {
    ...plan.candidates[0],
    processing_token: "archive:4001"
  };
  const freshArchive = {
    ...plan.candidates[0].archive_record,
    row_number: 20,
    manual_action: "outcome_offer",
    notes: "Current Archive note",
    outcome: "interview",
    outcome_at: "2026-07-28T08:45:00.000Z",
    outcome_events: [
      { id: "reply-1", type: "replied", at: "2026-07-28T08:15:00.000Z" },
      {
        id: "interview-1",
        type: "interview",
        at: "2026-07-28T08:45:00.000Z"
      }
    ]
  };
  const prepared = prepareArchiveUpserts(
    [claimed],
    [freshArchive],
    schema,
    now
  );
  assert.equal(prepared.rejected.length, 0);
  assert.equal(prepared.upserts[0].manual_action, "outcome_offer");
  assert.equal(prepared.upserts[0].notes, "Current Archive note");
  assert.equal(prepared.upserts[0].outcome, "interview");
  assert.equal(prepared.upserts[0].processing_token, "");
  assert.deepEqual(
    prepared.upserts[0].outcome_events.map((event) => event.type),
    ["replied", "interview"]
  );
  assert.equal(prepared.upserts[0].archive_claim_token, "archive:4001");

  const duplicate = prepareArchiveUpserts(
    [claimed],
    [
      freshArchive,
      {
        ...freshArchive,
        row_number: 21,
        canonical_job_id: "ONLINEJOBS.PH:4001",
        canonical_url:
          "https://onlinejobs.ph/jobseekers/job/archive-conflict-4001"
      }
    ],
    schema,
    now
  );
  assert.equal(duplicate.upserts.length, 0);
  assert.equal(
    duplicate.rejected[0].reason,
    "ambiguous_archive_identity"
  );
});

test("source deletion requires a complete archive copy and unchanged row identity", () => {
  const plan = prepareArchiveCandidates([active()], [], schema, { now });
  const candidate = plan.candidates[0];

  const missingCopy = confirmArchiveDeletions([candidate], [active()], [], schema, now);
  assert.equal(missingCopy.confirmed.length, 0);
  assert.equal(missingCopy.rejected[0].reason, "archive_copy_not_confirmed");

  const changedRow = confirmArchiveDeletions(
    [candidate],
    [active({ canonical_job_id: "onlinejobs.ph:9999" })],
    [candidate.archive_record],
    schema,
    now
  );
  assert.equal(changedRow.confirmed.length, 0);
  assert.equal(changedRow.rejected[0].reason, "active_row_identity_changed");

  const confirmed = confirmArchiveDeletions(
    [candidate],
    [active()],
    [candidate.archive_record],
    schema,
    now
  );
  assert.deepEqual(confirmed.confirmed, [
    { row_number: 5, canonical_job_id: "onlinejobs.ph:4001" }
  ]);
});

test("source deletion requires exact cleared automation state in Archive", () => {
  const record = active();
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const candidate = plan.candidates[0];
  const staleAutomationCopy = {
    ...candidate.archive_record,
    alert_error_category: "provider_failure",
    alert_error_summary: "Stale alert failure",
    processing_stage: "alert",
    processing_token: "stale-alert-token",
    processing_started_at: "2026-07-28T08:00:00.000Z"
  };
  const result = confirmArchiveDeletions(
    [candidate],
    [record],
    [staleAutomationCopy],
    schema,
    now
  );
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "archive_copy_not_confirmed");
});

test("source deletion rejects identities duplicated after planning", () => {
  const record = active();
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const candidate = plan.candidates[0];
  const duplicateActive = {
    ...record,
    row_number: 6,
    canonical_job_id: "ONLINEJOBS.PH:4001",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/active-conflict-4001"
  };
  const activeConflict = confirmArchiveDeletions(
    [candidate],
    [record, duplicateActive],
    [candidate.archive_record],
    schema,
    now
  );
  assert.equal(activeConflict.confirmed.length, 0);
  assert.equal(
    activeConflict.rejected[0].reason,
    "ambiguous_active_identity"
  );

  const duplicateArchive = {
    ...candidate.archive_record,
    row_number: 21,
    canonical_job_id: "ONLINEJOBS.PH:4001",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/archive-conflict-4001"
  };
  const archiveConflict = confirmArchiveDeletions(
    [candidate],
    [record],
    [
      { ...candidate.archive_record, row_number: 20 },
      duplicateArchive
    ],
    schema,
    now
  );
  assert.equal(archiveConflict.confirmed.length, 0);
  assert.equal(
    archiveConflict.rejected[0].reason,
    "ambiguous_archive_identity"
  );
});

test("a concurrent manual update blocks deletion until the archive copy is refreshed", () => {
  const record = active({ outcome: "" });
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const changed = active({
    outcome: "interview",
    outcome_at: "2026-07-28T08:30:00.000Z",
    updated_at: "2026-07-28T08:30:00.000Z"
  });
  const staleArchive = plan.candidates[0].archive_record;
  const result = confirmArchiveDeletions(
    plan.candidates,
    [changed],
    [staleArchive],
    schema,
    now
  );
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.rejected[0].reason, "active_record_changed_after_plan");
});

test("an archive copy missing supported history does not authorize deletion", () => {
  const record = active({
    notes: "Keep this context",
    opportunity_score: 79,
    application_pack_status: "ready",
    outcome_events: [
      { id: "reply-1", type: "replied", at: "2026-07-28T08:00:00.000Z" }
    ]
  });
  const plan = prepareArchiveCandidates([record], [], schema, { now });
  const incomplete = {
    ...plan.candidates[0].archive_record,
    generated_message: "",
    opportunity_score: "",
    application_pack_status: "",
    outcome_events: [],
    notes: ""
  };
  const result = confirmArchiveDeletions(
    plan.candidates,
    [record],
    [incomplete],
    schema,
    now
  );
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.rejected[0].reason, "archive_copy_not_confirmed");
});

test("multiple confirmed deletions are sorted from bottom to top", () => {
  const rows = [
    active({ row_number: 3, source_job_id: "4010", canonical_job_id: "onlinejobs.ph:4010", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-4010" }),
    active({ row_number: 9, source_job_id: "4011", canonical_job_id: "onlinejobs.ph:4011", canonical_url: "https://onlinejobs.ph/jobseekers/job/b-4011" })
  ];
  const plan = prepareArchiveCandidates(rows, [], schema, { now });
  const confirmation = confirmArchiveDeletions(
    plan.candidates,
    rows,
    plan.candidates.map((candidate) => candidate.archive_record),
    schema,
    now
  );
  assert.deepEqual(confirmation.confirmed.map((entry) => entry.row_number), [9, 3]);
});

test("legacy archive rows reconcile by URL and empty input is safe", () => {
  const legacyActive = {
    row_number: 4,
    job_url: "https://www.onlinejobs.ph/jobseekers/job/legacy-5001",
    status: "applied",
    generated_message: "Legacy message",
    "created_at ": "2026-07-01T00:00:00.000Z"
  };
  const legacyArchive = {
    row_number: 10,
    job_url: "https://onlinejobs.ph/jobseekers/job/legacy-5001",
    status: "archived",
    archived_from_status: "applied",
    archived_at: "2026-07-02T00:00:00.000Z"
  };
  const plan = prepareArchiveCandidates([legacyActive], [legacyArchive], schema, { now });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].archive_already_complete, true);
  assert.equal(plan.candidates[0].archive_record.generated_message, "Legacy message");

  assert.deepEqual(prepareArchiveCandidates([], [], schema, { now }), {
    candidates: [],
    retained: []
  });
});

test("archive write failure and delete failure are safely retryable", () => {
  const record = active();
  const firstPlan = prepareArchiveCandidates([record], [], schema, { now });
  const beforeAppend = confirmArchiveDeletions(firstPlan.candidates, [record], [], schema, now);
  assert.equal(beforeAppend.confirmed.length, 0);
  assert.equal(beforeAppend.rejected[0].reason, "archive_copy_not_confirmed");

  const archived = firstPlan.candidates[0].archive_record;
  const afterAppend = confirmArchiveDeletions(
    firstPlan.candidates,
    [record],
    [archived],
    schema,
    now
  );
  assert.equal(afterAppend.confirmed.length, 1);

  // Simulate a delete failure by leaving the active row in place and rerunning.
  const retryPlan = prepareArchiveCandidates([record], [archived], schema, { now });
  assert.equal(retryPlan.candidates.length, 1);
  assert.equal(retryPlan.candidates[0].archive_already_complete, true);
  const uniqueArchive = new Map(
    [archived, retryPlan.candidates[0].archive_record].map((entry) => [
      entry.canonical_job_id,
      entry
    ])
  );
  assert.equal(uniqueArchive.size, 1);
});
