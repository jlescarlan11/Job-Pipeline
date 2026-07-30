import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeLegacyRecord,
  stateGuard
} from "../src/contracts.mjs";
import {
  applyOutcomeUpdate,
  confirmMoveDeletions,
  destinationWrites,
  planQueueActions
} from "../src/movement.mjs";

const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);
const now = "2026-07-31T10:00:00.000Z";

function row(id, status, action = "", overrides = {}) {
  const normalized = normalizeLegacyRecord(
    {
      source: "onlinejobs.ph",
      source_job_id: String(id),
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://onlinejobs.ph/jobseekers/job/example-${id}`,
      row_number: Number(id) % 100 + 2,
      record_version: 3,
      pipeline_status: status,
      user_action: action,
      source_availability: "active",
      attempt_count: 0,
      matched_keywords: ["react developer"],
      job_title: `Job ${id}`,
      company: "Example",
      decision_reason: "Auditable decision",
      generated_message:
        status === "ready_to_apply" ? "A safe generated message." : "",
      message_validation_status:
        status === "ready_to_apply" ? "valid" : "",
      message_profile_version:
        status === "ready_to_apply" ? "2026-07-29" : "",
      message_policy_version:
        status === "ready_to_apply" ? "2026-07-28" : "",
      application_pack_status:
        status === "ready_to_apply" ? "ready" : "",
      application_pack_version:
        status === "ready_to_apply" ? "2026-07-28/v1" : "",
      application_pack_profile_version:
        status === "ready_to_apply" ? "2026-07-29" : "",
      application_pack_policy_version:
        status === "ready_to_apply" ? "2026-07-28/v1" : "",
      created_at: "2026-07-31T08:00:00.000Z",
      updated_at: "2026-07-31T09:00:00.000Z",
      ...overrides
    },
    schema,
    now
  );
  normalized.state_guard = stateGuard(normalized);
  return normalized;
}

function destinationAfterWrite(plans) {
  const writes = destinationWrites(plans);
  return {
    applied: writes.applied.map((record, index) => ({
      ...record,
      row_number: index + 2
    })),
    archive: writes.archive.map((record, index) => ({
      ...record,
      row_number: index + 2
    }))
  };
}

test("ready rows expose only I Applied and Skip; review rows expose only Approve and Deny", () => {
  const invalidPairs = [
    row(4001, "ready_to_apply", "Approve"),
    row(4002, "ready_to_apply", "Deny"),
    row(4003, "review_needed", "I Applied"),
    row(4004, "review_needed", "Skip"),
    row(4005, "new", "Deny")
  ];
  for (const invalid of invalidPairs) {
    assert.throws(
      () => planQueueActions([invalid], [], [], schema, now),
      /rejected invalid row/
    );
  }
});

test("Approve remains in Review Queue for gated generation with context intact", () => {
  const approved = row(4010, "review_needed", "Approve", {
    required_input: "Confirm an evidence gap",
    notes: "Reviewer accepts reconsideration"
  });
  const plan = planQueueActions([approved], [], [], schema, now);
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.generation_requests, [
    {
      canonical_job_id: approved.canonical_job_id,
      source_row_number: approved.row_number,
      source_state_guard: approved.state_guard,
      source_record_version: approved.record_version
    }
  ]);
  assert.equal(approved.required_input, "Confirm an evidence gap");
  assert.equal(approved.notes, "Reviewer accepts reconsideration");
});

test("Deny and user Skip retain full context in Archive", () => {
  const denied = row(4020, "review_needed", "Deny", {
    requirement_gaps: ["PHP"],
    notes: "Not a good tradeoff"
  });
  const skipped = row(4021, "ready_to_apply", "Skip", {
    notes: "User chose another role"
  });
  const plan = planQueueActions([denied, skipped], [], [], schema, now);
  const writes = destinationWrites(plan);
  assert.equal(writes.archive.length, 2);
  const deniedCopy = writes.archive.find(
    (record) => record.canonical_job_id === denied.canonical_job_id
  );
  assert.equal(deniedCopy.archive_reason, "review_denied");
  assert.deepEqual(deniedCopy.requirement_gaps, ["PHP"]);
  assert.equal(deniedCopy.notes, "Not a good tradeoff");
  const skippedCopy = writes.archive.find(
    (record) => record.canonical_job_id === skipped.canonical_job_id
  );
  assert.equal(skippedCopy.archive_reason, "user_skip");
  assert.equal(skippedCopy.generated_message, skipped.generated_message);
});

test("automatic skip moves to Archive without an operator action", () => {
  const automatic = row(4030, "skip", "", {
    decision_reason: "Hard seniority mismatch"
  });
  const plan = planQueueActions([automatic], [], [], schema, now);
  const writes = destinationWrites(plan);
  assert.equal(writes.archive.length, 1);
  assert.equal(writes.archive[0].archive_reason, "automatic_skip");
  assert.equal(writes.archive[0].decision_reason, "Hard seniority mismatch");
});

test("I Applied requires current validated pack/message provenance", () => {
  const safe = row(4040, "ready_to_apply", "I Applied");
  const plan = planQueueActions([safe], [], [], schema, now);
  const writes = destinationWrites(plan);
  assert.equal(writes.applied.length, 1);
  assert.equal(writes.applied[0].applied_at, now);
  assert.equal(writes.applied[0].user_action, "");
  assert.equal(writes.applied[0].generated_message, safe.generated_message);

  for (const missing of [
    "generated_message",
    "message_validation_status",
    "message_profile_version",
    "message_policy_version",
    "application_pack_status",
    "application_pack_version"
  ]) {
    const unsafe = row(4041, "ready_to_apply", "I Applied", {
      [missing]: ""
    });
    assert.throws(
      () => planQueueActions([unsafe], [], [], schema, now),
      /safety evidence is incomplete/,
      missing
    );
  }
});

test("destination write failure keeps the Review Queue source", () => {
  const source = row(4050, "ready_to_apply", "I Applied");
  const plan = planQueueActions([source], [], [], schema, now);
  const confirmation = confirmMoveDeletions(
    plan,
    [source],
    [],
    [],
    schema
  );
  assert.deepEqual(confirmation.deletions, []);
  assert.deepEqual(confirmation.rejected, [
    {
      canonical_job_id: source.canonical_job_id,
      reason: "destination_unconfirmed"
    }
  ]);
});

test("copy-confirm-delete succeeds once and uses descending source rows", () => {
  const first = row(4060, "ready_to_apply", "I Applied", { row_number: 3 });
  const second = row(4061, "review_needed", "Deny", { row_number: 9 });
  first.state_guard = stateGuard(first);
  second.state_guard = stateGuard(second);
  const plan = planQueueActions([first, second], [], [], schema, now);
  const written = destinationAfterWrite(plan);
  const confirmation = confirmMoveDeletions(
    plan,
    [first, second],
    written.applied,
    written.archive,
    schema
  );
  assert.deepEqual(
    confirmation.deletions.map((entry) => entry.row_number),
    [9, 3]
  );
  assert.deepEqual(confirmation.rejected, []);
});

test("delete failure is idempotent on rerun and does not duplicate destination", () => {
  const source = row(4070, "ready_to_apply", "I Applied");
  const firstPlan = planQueueActions([source], [], [], schema, now);
  const written = destinationAfterWrite(firstPlan);

  const rerunPlan = planQueueActions(
    [source],
    written.applied,
    [],
    schema,
    "2026-07-31T10:05:00.000Z"
  );
  assert.equal(rerunPlan.moves.length, 1);
  assert.equal(rerunPlan.moves[0].write_required, false);
  assert.deepEqual(destinationWrites(rerunPlan).applied, []);
  const confirmation = confirmMoveDeletions(
    rerunPlan,
    [source],
    written.applied,
    [],
    schema
  );
  assert.equal(confirmation.deletions.length, 1);

  const afterDelete = confirmMoveDeletions(
    rerunPlan,
    [],
    written.applied,
    [],
    schema
  );
  assert.deepEqual(afterDelete, { deletions: [], rejected: [] });
});

test("last-minute source changes prevent deletion", () => {
  const source = row(4080, "ready_to_apply", "I Applied");
  const plan = planQueueActions([source], [], [], schema, now);
  const written = destinationAfterWrite(plan);
  const changed = {
    ...source,
    user_action: "Skip",
    record_version: source.record_version + 1
  };
  changed.state_guard = stateGuard(changed);
  const confirmation = confirmMoveDeletions(
    plan,
    [changed],
    written.applied,
    [],
    schema
  );
  assert.deepEqual(confirmation.deletions, []);
  assert.equal(confirmation.rejected[0].reason, "stale_source");

  const noteChanged = { ...source, notes: "operator added context" };
  const noteConfirmation = confirmMoveDeletions(
    plan,
    [noteChanged],
    written.applied,
    [],
    schema
  );
  assert.deepEqual(noteConfirmation.deletions, []);
  assert.equal(noteConfirmation.rejected[0].reason, "stale_source");
});

test("ambiguous or conflicting destination identities fail closed", () => {
  const source = row(4090, "ready_to_apply", "I Applied");
  assert.throws(
    () => planQueueActions([source], [row(4090, "new"), row(4090, "new")], [], schema, now),
    /ambiguous duplicate/
  );
  assert.throws(
    () =>
      planQueueActions(
        [source],
        [],
        [row(4090, "skip", "", { archived_at: now, archive_reason: "automatic_skip" })],
        schema,
        now
      ),
    /conflicting canonical identity/
  );
});

test("Applied Jobs outcome changes are guarded and retain application history", () => {
  const applied = {
    ...destinationWrites(
      planQueueActions([row(4100, "ready_to_apply", "I Applied")], [], [], schema, now)
    ).applied[0],
    row_number: 2
  };
  const updated = applyOutcomeUpdate(
    applied,
    "interview",
    applied.state_guard,
    schema,
    "2026-08-01T01:00:00.000Z"
  );
  assert.equal(updated.outcome, "interview");
  assert.equal(updated.outcome_at, "2026-08-01T01:00:00.000Z");
  assert.equal(updated.applied_at, applied.applied_at);
  assert.equal(updated.generated_message, applied.generated_message);
  assert.throws(
    () =>
      applyOutcomeUpdate(
        updated,
        "offer",
        applied.state_guard,
        schema,
        now
      ),
    /stale/
  );
  assert.throws(
    () =>
      applyOutcomeUpdate(
        applied,
        "hired_without_interview",
        applied.state_guard,
        schema,
        now
      ),
    /unsupported/
  );
});
