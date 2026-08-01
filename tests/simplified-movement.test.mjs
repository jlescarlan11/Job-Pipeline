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
  hasConfirmedDeliveredMessage,
  planOutcomeUpdates,
  planQueueActions as planQueueActionsRaw
} from "../src/movement.mjs";
import { alertIdempotencyKey } from "../src/alerter-mover.mjs";

const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);
const profile = JSON.parse(
  await readFile(new URL("../config/candidate-profile.json", import.meta.url))
);
const applicationPolicy = JSON.parse(
  await readFile(new URL("../config/application-policy.json", import.meta.url))
);
const packPolicy = JSON.parse(
  await readFile(
    new URL("../config/application-pack-policy.json", import.meta.url)
  )
);
const alertPolicy = JSON.parse(
  await readFile(new URL("../config/alert-policy.json", import.meta.url))
);
const safetyContext = { profile, applicationPolicy, packPolicy };
const now = "2026-07-31T10:00:00.000Z";

function planQueueActions(
  sourceRows,
  appliedRows,
  archiveRows,
  selectedSchema,
  selectedNow,
  options
) {
  const stores = businessStores({
    ...sourceStores(sourceRows),
    "Applied Jobs": appliedRows,
    Archive: archiveRows
  });
  return planQueueActionsRaw(
    stores,
    selectedSchema,
    selectedNow,
    safetyContext,
    options
  );
}

function businessStores(overrides = {}) {
  return {
    "Scraped Jobs": [],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: [],
    ...overrides
  };
}

function sourceStores(rows) {
  const stores = {
    "Scraped Jobs": [],
    "To Review": [],
    "To Apply": []
  };
  for (const record of rows) {
    if (record.pipeline_status === "review_needed") {
      stores["To Review"].push(record);
    } else if (record.pipeline_status === "ready_to_apply") {
      stores["To Apply"].push(record);
    } else {
      stores["Scraped Jobs"].push(record);
    }
  }
  return stores;
}

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
        status === "ready_to_apply"
          ? "Hi there,\n\nI build TypeScript and React applications using approved profile evidence.\n\nPortfolio: https://johnlesterescarlan.pro"
          : "",
      message_validation_status:
        status === "ready_to_apply" ? "valid" : "",
      message_profile_version:
        status === "ready_to_apply" ? profile.profile_version : "",
      message_policy_version:
        status === "ready_to_apply" ? applicationPolicy.policy_version : "",
      application_pack_status:
        status === "ready_to_apply" ? "ready" : "",
      application_pack_version:
        status === "ready_to_apply" ? packPolicy.pack_version : "",
      application_pack_profile_version:
        status === "ready_to_apply" ? profile.profile_version : "",
      application_pack_policy_version:
        status === "ready_to_apply" ? packPolicy.policy_version : "",
      application_pack_generated_at:
        status === "ready_to_apply" ? now : "",
      application_instructions: [],
      screening_questions: [],
      selected_proof_refs:
        status === "ready_to_apply"
          ? ["experience:upwork", "projects:job-pipeline"]
          : [],
      application_warnings: [],
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
    scraped_jobs: writes.scraped_jobs.map((record, index) => ({
      ...record,
      row_number: index + 2
    })),
    to_review: writes.to_review.map((record, index) => ({
      ...record,
      row_number: index + 2
    })),
    to_apply: writes.to_apply.map((record, index) => ({
      ...record,
      row_number: index + 2
    })),
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
    const plan = planQueueActions([invalid], [], [], schema, now);
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.rejected[0].reason, "invalid_source");
  }
});

test("Approve moves to Scraped Jobs for gated generation with context intact", () => {
  const approved = row(4010, "review_needed", "Approve", {
    required_input: "Confirm an evidence gap",
    notes: "Reviewer accepts reconsideration"
  });
  const plan = planQueueActions([approved], [], [], schema, now);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].source_sheet, "To Review");
  assert.equal(plan.moves[0].destination, "Scraped Jobs");
  const returned = destinationWrites(plan).scraped_jobs[0];
  assert.equal(returned.pipeline_status, "review_needed");
  assert.equal(returned.user_action, "Approve");
  assert.equal(returned.review_approved_at, now);
  assert.equal(returned.review_approval_note, "Reviewer accepts reconsideration");
  assert.equal(approved.required_input, "Confirm an evidence gap");
  assert.equal(approved.notes, "Reviewer accepts reconsideration");
});

test("blank generator results route from Scraped Jobs to focused queues", () => {
  const review = row(4011, "review_needed");
  const ready = row(4012, "ready_to_apply");
  const plan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [review, ready] }),
    schema,
    now,
    safetyContext
  );
  assert.deepEqual(
    plan.moves.map((move) => [move.source_sheet, move.destination]),
    [
      ["Scraped Jobs", "To Review"],
      ["Scraped Jobs", "To Apply"]
    ]
  );
  assert.equal(destinationWrites(plan).to_review.length, 1);
  assert.equal(destinationWrites(plan).to_apply.length, 1);
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

test("permanently unavailable source rows and legacy 404/410 errors move to Archive", () => {
  const unavailable = row(4031, "unavailable", "", {
    source_availability: "unavailable",
    error_category: "source_unavailable",
    error_summary: "HTTP 410: source job posting is no longer available."
  });
  const legacyError = row(4032, "error", "", {
    error_category: "provider_failure_exhausted",
    error_summary: '410 - "<!DOCTYPE html><html>listing removed</html>"'
  });
  const transient = row(4033, "error", "", {
    error_category: "provider_timeout",
    error_summary: "503 - temporary upstream failure"
  });
  const plan = planQueueActions(
    [unavailable, legacyError, transient],
    [],
    [],
    schema,
    now
  );
  const writes = destinationWrites(plan);
  assert.equal(writes.archive.length, 2);
  for (const archived of writes.archive) {
    assert.equal(archived.archive_reason, "source_unavailable");
    assert.equal(archived.pipeline_status, "unavailable");
    assert.equal(archived.source_availability, "unavailable");
    assert.equal(archived.next_retry_at, "");
  }
  assert.equal(
    plan.moves.some(
      (move) => move.canonical_job_id === transient.canonical_job_id
    ),
    false
  );

  const written = destinationAfterWrite(plan);
  const confirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([unavailable, legacyError, transient]),
      Archive: written.archive
    }),
    schema
  );
  assert.equal(confirmation.deletions.length, 2);
});

test("I Applied requires current provenance or a confirmed delivery of the exact stored message", () => {
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
    const rejected = planQueueActions([unsafe], [], [], schema, now);
    assert.equal(rejected.moves.length, 0, missing);
    assert.equal(rejected.rejected.length, 1, missing);
    assert.ok(
      ["invalid_source", "unsafe_action"].includes(
        rejected.rejected[0].reason
      ),
      missing
    );
  }

  const deliveredBeforeContextChange = row(
    4042,
    "ready_to_apply",
    "I Applied",
    {
      message_profile_version: "historical/profile",
      application_pack_profile_version: "historical/profile",
      generated_at: now
    }
  );
  deliveredBeforeContextChange.alert_status = "sent";
  deliveredBeforeContextChange.alert_sent_at = now;
  deliveredBeforeContextChange.alert_idempotency_key = alertIdempotencyKey(
    deliveredBeforeContextChange,
    alertPolicy
  );
  deliveredBeforeContextChange.state_guard = stateGuard(
    deliveredBeforeContextChange
  );

  assert.equal(
    hasConfirmedDeliveredMessage(deliveredBeforeContextChange),
    true
  );
  const historicalPlan = planQueueActions(
    [deliveredBeforeContextChange],
    [],
    [],
    schema,
    now
  );
  assert.equal(historicalPlan.moves.length, 1);
  assert.equal(historicalPlan.moves[0].destination, "Applied Jobs");

  const changedAfterDelivery = {
    ...deliveredBeforeContextChange,
    generated_message: `${deliveredBeforeContextChange.generated_message} changed`
  };
  changedAfterDelivery.state_guard = stateGuard(changedAfterDelivery);
  assert.equal(hasConfirmedDeliveredMessage(changedAfterDelivery), false);
  const changedPlan = planQueueActions(
    [changedAfterDelivery],
    [],
    [],
    schema,
    now
  );
  assert.equal(changedPlan.moves.length, 0);
  assert.equal(changedPlan.rejected[0].reason, "unsafe_action");
});

test("destination write failure keeps the focused-queue source", () => {
  const source = row(4050, "ready_to_apply", "I Applied");
  const plan = planQueueActions([source], [], [], schema, now);
  const confirmation = confirmMoveDeletions(
    plan,
    businessStores(sourceStores([source])),
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
  const third = row(4062, "ready_to_apply", "Skip", { row_number: 12 });
  first.state_guard = stateGuard(first);
  second.state_guard = stateGuard(second);
  third.state_guard = stateGuard(third);
  const plan = planQueueActions([first, second, third], [], [], schema, now);
  const written = destinationAfterWrite(plan);
  const confirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([first, second, third]),
      "Applied Jobs": written.applied,
      Archive: written.archive
    }),
    schema
  );
  assert.deepEqual(confirmation.deletions, [
    {
      row_number: 12,
      canonical_job_id: third.canonical_job_id,
      source_sheet: "To Apply",
      destination: "Archive"
    },
    {
      row_number: 3,
      canonical_job_id: first.canonical_job_id,
      source_sheet: "To Apply",
      destination: "Applied Jobs"
    },
    {
      row_number: 9,
      canonical_job_id: second.canonical_job_id,
      source_sheet: "To Review",
      destination: "Archive"
    }
  ]);
  assert.deepEqual(confirmation.rejected, []);
});

test("copy-confirm-delete resolves fresh row numbers after latest-first sorting", () => {
  const source = row(4063, "ready_to_apply", "I Applied", { row_number: 12 });
  source.state_guard = stateGuard(source);
  const plan = planQueueActions([source], [], [], schema, now);
  const written = destinationAfterWrite(plan);
  const sortedSource = { ...source, row_number: 2 };
  const confirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([sortedSource]),
      "Applied Jobs": written.applied
    }),
    schema
  );
  assert.deepEqual(confirmation.deletions, [
    {
      row_number: 2,
      canonical_job_id: source.canonical_job_id,
      source_sheet: "To Apply",
      destination: "Applied Jobs"
    }
  ]);
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
    businessStores({
      ...sourceStores([source]),
      "Applied Jobs": written.applied
    }),
    schema
  );
  assert.equal(confirmation.deletions.length, 1);

  const afterDelete = confirmMoveDeletions(
    rerunPlan,
    businessStores({ "Applied Jobs": written.applied }),
    schema
  );
  assert.deepEqual(afterDelete, { deletions: [], rejected: [] });
});

test("a partial destination is repaired by identity without losing destination-owned data", () => {
  const source = row(4071, "ready_to_apply", "I Applied");
  const initial = planQueueActions([source], [], [], schema, now);
  const complete = destinationAfterWrite(initial).applied[0];
  const partial = {
    ...complete,
    job_title: "",
    notes: "Terminal-store note",
    outcome: "interview",
    outcome_recorded_value: "interview",
    outcome_at: "2026-07-31T10:01:00.000Z"
  };
  partial.state_guard = stateGuard(partial);
  const recovery = planQueueActions(
    [source],
    [partial],
    [],
    schema,
    "2026-07-31T10:05:00.000Z"
  );
  assert.equal(recovery.moves[0].write_required, true);
  assert.equal(recovery.moves[0].destination_record.job_title, source.job_title);
  assert.equal(recovery.moves[0].destination_record.notes, "Terminal-store note");
  assert.equal(recovery.moves[0].destination_record.outcome, "interview");
  assert.equal(
    recovery.moves[0].destination_record.applied_at,
    complete.applied_at
  );
});

test("active-destination repair preserves a newer action and alert state", () => {
  const source = row(4075, "ready_to_apply");
  const initial = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [source] }),
    schema,
    now,
    safetyContext
  );
  const complete = destinationAfterWrite(initial).to_apply[0];
  const partial = {
    ...complete,
    job_title: "",
    user_action: "Skip",
    alert_status: "sending",
    alert_idempotency_key: "existing-alert",
    alert_claim_token: "existing-alert-claim",
    alert_sent_at: "2026-07-31T10:01:00.000Z"
  };
  partial.state_guard = stateGuard(partial);
  const recovery = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [source],
      "To Apply": [partial]
    }),
    schema,
    "2026-07-31T10:05:00.000Z",
    safetyContext
  );
  assert.equal(recovery.moves[0].write_required, true);
  assert.equal(recovery.moves[0].destination_record.job_title, source.job_title);
  assert.equal(recovery.moves[0].destination_record.user_action, "Skip");
  assert.equal(recovery.moves[0].destination_record.alert_status, "sending");
  assert.equal(
    recovery.moves[0].destination_record.alert_idempotency_key,
    "existing-alert"
  );
  assert.equal(
    recovery.moves[0].destination_record.alert_claim_token,
    "existing-alert-claim"
  );
});

test("movement cap applies across every route", () => {
  const first = row(4072, "skip");
  const second = row(4073, "skip");
  const approval = row(4074, "review_needed", "Approve");
  const plan = planQueueActions(
    [first, second, approval],
    [],
    [],
    schema,
    now,
    { movementPerRunCap: 1 }
  );
  assert.equal(plan.moves.length, 1);
  assert.ok(
    plan.rejected.some((entry) => entry.reason === "movement_cap_reached")
  );
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
    businessStores({
      ...sourceStores([changed]),
      "Applied Jobs": written.applied
    }),
    schema
  );
  assert.deepEqual(confirmation.deletions, []);
  assert.equal(confirmation.rejected[0].reason, "stale_source");

  const noteChanged = { ...source, notes: "operator added context" };
  const noteConfirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([noteChanged]),
      "Applied Jobs": written.applied
    }),
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
  const conflict = planQueueActions(
    [source],
    [],
    [row(4090, "skip", "", { archived_at: now, archive_reason: "automatic_skip" })],
    schema,
    now
  );
  assert.equal(conflict.moves.length, 0);
  assert.equal(conflict.rejected[0].reason, "identity_conflict");

  const alias = row(4091, "skip", "", {
    canonical_url: source.canonical_url
  });
  assert.throws(
    () =>
      planQueueActionsRaw(
        businessStores({
          "To Apply": [source],
          Archive: [alias]
        }),
        schema,
        now,
        safetyContext
      ),
    /ambiguous canonical URL/
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
  assert.equal(updated.outcome_recorded_value, "interview");
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

  const operatorEdited = {
    ...applied,
    outcome: "replied",
    outcome_recorded_value: ""
  };
  operatorEdited.state_guard = stateGuard(operatorEdited);
  const planned = planOutcomeUpdates(
    [operatorEdited],
    schema,
    "2026-08-01T02:00:00.000Z"
  );
  assert.equal(planned.updates.length, 1);
  assert.equal(planned.updates[0].outcome_recorded_value, "replied");
});
