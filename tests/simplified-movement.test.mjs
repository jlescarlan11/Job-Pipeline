import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applicationReviewGuard,
  legacyStateGuardV3,
  normalizeLegacyRecord,
  preparationInputGuard,
  reviewCaseId,
  stateGuard,
  submissionIdempotencyKey
} from "../src/contracts.mjs";
import {
  applyOutcomeUpdate,
  confirmMoveDeletions,
  destinationWrites,
  planOutcomeUpdates,
  planQueueActions as planQueueActionsRaw
} from "../src/movement.mjs";
import {
  browserConfirmationPublicKeyDigest,
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  serializeBrowserConfirmationWitness
} from "../src/browser-confirmation-attestation.mjs";

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
const confirmationKeyId = "movement-history-adapter-v1";
const confirmationKeys = generateKeyPairSync("ed25519");
const confirmationPublicKey = confirmationKeys.publicKey.export({
  type: "spki",
  format: "pem"
});
const confirmationTrust = {
  keyId: confirmationKeyId,
  publicKey: confirmationPublicKey,
  publicKeySpkiSha256: browserConfirmationPublicKeyDigest(confirmationPublicKey)
};
const safetyContext = {
  profile,
  applicationPolicy,
  packPolicy,
  confirmationTrust
};
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
          ? `Subject line: Job ${id} Application — John Lester Escarlan\n\nHi there,\n\nI build TypeScript and React applications using approved profile evidence.\n\nPortfolio: https://johnlesterescarlan.pro`
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
      coverage_contract_version:
        status === "ready_to_apply" ? packPolicy.coverage_contract_version : "",
      message_plan_version:
        status === "ready_to_apply" ? packPolicy.message_plan_version : "",
      application_pack_generated_at:
        status === "ready_to_apply" ? now : "",
      application_instructions: [],
      screening_questions: [],
      requirement_coverage: [],
      application_message_plan:
        status === "ready_to_apply"
          ? [
              {
                version: packPolicy.message_plan_version,
                subject_line: `Subject line: Job ${id} Application — John Lester Escarlan`,
                requirements: []
              }
            ]
          : [],
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

function autonomousConfirmedRow(id, overrides = {}) {
  const digest = "a".repeat(64);
  const record = row(id, "ready_to_apply", "", {
    execution_mode: "autonomous_chrome",
    automation_contract_version: "browser-contract-v1",
    autonomous_decision: "apply",
    browser_state: "confirmed",
    browser_attempt_id: `attempt-v1:${digest}`,
    browser_job_digest: `job-v1:${digest}`,
    browser_context_digest: `context-v1:${digest}`,
    browser_form_fingerprint: `form-v1:${digest}`,
    submission_idempotency_key: "",
    submission_started_at: "2026-07-31T09:55:00.000Z",
    submission_confirmed_at: "2026-07-31T09:56:00.000Z",
    submission_confirmation_kind: "confirmation_page",
    submission_confirmation_reference: `confirmation-ref-v1:${digest}`,
    submission_confirmation_digest: `confirmation-v1:${digest}`,
    browser_block_category: "",
    profile_version: profile.profile_version,
    message_profile_version: profile.profile_version,
    application_pack_profile_version: profile.profile_version,
    policy_version: "ranking-policy/v1",
    message_policy_version: applicationPolicy.policy_version,
    application_pack_policy_version: packPolicy.policy_version,
    application_pack_version: packPolicy.pack_version,
    coverage_contract_version: packPolicy.coverage_contract_version,
    message_plan_version: packPolicy.message_plan_version,
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: "",
    generated_at: now,
    ...overrides
  });
  // Autonomous execution cannot reuse legacy review/preparation authority.
  record.prep_status = "";
  record.preparation_version = 0;
  record.preparation_input_guard = "";
  record.preparation_updated_at = "";
  record.submission_idempotency_key = Object.hasOwn(
    overrides,
    "submission_idempotency_key"
  )
    ? overrides.submission_idempotency_key
    : submissionIdempotencyKey(record);
  if (record.browser_state === "confirmed") {
    attestAutonomousConfirmation(record, overrides);
  }
  record.state_guard = stateGuard(record);
  return record;
}

function attestAutonomousConfirmation(record, overrides = {}) {
  const witness = browserConfirmationWitness(record);
  const attestation = {
    submission_attestation_key_id: confirmationKeyId,
    submission_attestation_witness_digest:
      browserConfirmationWitnessDigest(witness),
    submission_attestation_signature: sign(
      null,
      Buffer.from(serializeBrowserConfirmationWitness(witness)),
      confirmationKeys.privateKey
    ).toString("base64url")
  };
  for (const [field, value] of Object.entries(attestation)) {
    record[field] = Object.hasOwn(overrides, field) ? overrides[field] : value;
  }
  return record;
}

function legacyStateGuard(record, userAction = record.user_action) {
  const canonicalId = String(record.canonical_job_id || "");
  const state = [
    canonicalId,
    String(record.pipeline_status || ""),
    String(userAction || ""),
    String(record.record_version || ""),
    String(record.processing_stage || ""),
    String(record.processing_token || ""),
    String(record.review_approved_at || ""),
    String(record.review_approval_note || ""),
    String(record.generated_at || ""),
    String(record.alert_status || ""),
    String(record.alert_claim_token || ""),
    String(record.outcome || ""),
    String(record.outcome_recorded_value || ""),
    String(record.applied_at || ""),
    String(record.archived_at || ""),
    String(record.archive_reason || "")
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < state.length; index += 1) {
    hash ^= state.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${canonicalId}|${(hash >>> 0).toString(16).padStart(8, "0")}`;
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

test("ready rows expose only I Applied and Skip; review rows expose only Proceed and Reject", () => {
  const invalidPairs = [
    row(4001, "ready_to_apply", "Proceed"),
    row(4002, "ready_to_apply", "Reject"),
    row(4003, "review_needed", "I Applied"),
    row(4004, "review_needed", "Skip"),
    row(4005, "new", "Reject")
  ];
  for (const invalid of invalidPairs) {
    const plan = planQueueActions([invalid], [], [], schema, now);
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.rejected[0].reason, "invalid_source");
  }
});

test("Proceed resolves review once into pending preparation in To Apply", () => {
  const approved = row(4010, "review_needed", "Proceed", {
    required_input: "Confirm an evidence gap",
    notes: "Reviewer accepts reconsideration"
  });
  const plan = planQueueActions([approved], [], [], schema, now);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].source_sheet, "To Review");
  assert.equal(plan.moves[0].destination, "To Apply");
  const returned = destinationWrites(plan).to_apply[0];
  assert.equal(returned.pipeline_status, "ready_to_apply");
  assert.equal(returned.prep_status, "pending");
  assert.equal(returned.user_action, "");
  assert.equal(returned.review_case_id, reviewCaseId(approved));
  assert.equal(returned.review_case_version, "review-case-v1");
  assert.equal(returned.review_decision, "proceed");
  assert.equal(returned.review_decided_at, now);
  assert.equal(returned.review_approved_at, now);
  assert.equal(returned.review_approval_note, "Reviewer accepts reconsideration");
  assert.equal(returned.review_approval_guard, applicationReviewGuard(approved));
  assert.equal(returned.preparation_version, 1);
  assert.equal(returned.preparation_input_guard, preparationInputGuard(returned));
  assert.equal(approved.required_input, "Confirm an evidence gap");
  assert.equal(approved.notes, "Reviewer accepts reconsideration");
});

test("partial Proceed destinations are repaired before review sources are deleted", () => {
  const approved = row(4013, "review_needed", "Proceed", {
    notes: "Approved after evidence review"
  });
  const initial = planQueueActions([approved], [], [], schema, now);
  const complete = destinationAfterWrite(initial).to_apply[0];
  const partial = {
    ...complete,
    review_approved_at: "",
    review_approval_guard: "",
    preparation_input_guard: ""
  };
  partial.state_guard = stateGuard(partial);

  const recovery = planQueueActionsRaw(
    businessStores({
      "To Review": [approved],
      "To Apply": [partial]
    }),
    schema,
    "2026-07-31T10:05:00.000Z",
    safetyContext
  );
  assert.equal(recovery.moves[0].write_required, true);
  assert.ok(recovery.moves[0].destination_record.review_approved_at);
  assert.match(
    recovery.moves[0].destination_record.review_approval_guard,
    /^review-v1:[a-f0-9]{64}$/
  );

  const confirmation = confirmMoveDeletions(
    initial,
    businessStores({
      "To Review": [approved],
      "To Apply": [partial]
    }),
    schema
  );
  assert.deepEqual(confirmation.deletions, []);
  assert.equal(confirmation.rejected[0].reason, "destination_unconfirmed");
});

test("approval copy confirmation accepts the rebound review strategy guard", () => {
  const approved = row(4014, "review_needed", "Proceed", {
    notes: "Reconsider after strategy review",
    application_warnings: ["manual_external_action"]
  });
  const priorStrategy = {
    ...approved,
    application_warnings: []
  };
  approved.review_approval_guard = applicationReviewGuard(priorStrategy);
  approved.state_guard = stateGuard(approved);

  const plan = planQueueActions([approved], [], [], schema, now);
  const written = destinationAfterWrite(plan).to_apply[0];
  assert.notEqual(written.review_approval_guard, approved.review_approval_guard);
  assert.equal(
    written.review_approval_guard,
    applicationReviewGuard(approved)
  );

  const confirmation = confirmMoveDeletions(
    plan,
    businessStores({
      "To Review": [approved],
      "To Apply": [written]
    }),
    schema
  );
  assert.deepEqual(confirmation.deletions, [
    {
      row_number: approved.row_number,
      canonical_job_id: approved.canonical_job_id,
      source_sheet: "To Review",
      destination: "To Apply"
    }
  ]);
  assert.deepEqual(confirmation.rejected, []);
});

test("resolved review cases cannot reopen unchanged but a material new case can", () => {
  const resolved = row(4015, "review_needed", "", {
    review_case_version: "review-case-v1",
    review_decision: "proceed",
    review_decided_at: now,
    required_input: "Confirm the original evidence gap."
  });
  resolved.review_case_id = reviewCaseId(resolved);
  resolved.state_guard = stateGuard(resolved);
  const repeated = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [resolved] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(repeated.moves.length, 0);
  assert.equal(repeated.rejected[0].reason, "resolved_review_case_repeated");
  assert.doesNotMatch(repeated.rejected[0].summary, /description|message/i);

  const changed = {
    ...resolved,
    decision_reason: "Employer added a new mandatory assessment.",
    required_input: "Review the newly added assessment requirement."
  };
  changed.state_guard = stateGuard(changed);
  assert.notEqual(reviewCaseId(changed), resolved.review_case_id);
  const reopened = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [changed] }),
    schema,
    "2026-07-31T10:02:00.000Z",
    safetyContext
  );
  assert.equal(reopened.moves.length, 1);
  assert.equal(reopened.moves[0].destination, "To Review");
  assert.notEqual(
    reopened.moves[0].destination_record.review_case_id,
    resolved.review_case_id
  );
  assert.equal(reopened.moves[0].destination_record.review_decision, "");
  assert.equal(reopened.moves[0].destination_record.review_decided_at, "");
});

test("concurrent or repeated Proceed reconciles one To Apply owner", () => {
  const proceeded = row(4016, "review_needed", "Proceed", {
    required_input: "Confirm a bounded requirement."
  });
  const initial = planQueueActions([proceeded], [], [], schema, now);
  const written = destinationAfterWrite(initial).to_apply[0];
  const repeat = planQueueActionsRaw(
    businessStores({
      "To Review": [proceeded],
      "To Apply": [written]
    }),
    schema,
    "2026-07-31T10:03:00.000Z",
    safetyContext
  );
  assert.equal(repeat.moves.length, 1);
  assert.equal(repeat.moves[0].write_required, false);
  assert.equal(destinationWrites(repeat).to_apply.length, 0);
  const confirmed = confirmMoveDeletions(
    repeat,
    businessStores({
      "To Review": [proceeded],
      "To Apply": [written]
    }),
    schema
  );
  assert.equal(confirmed.deletions.length, 1);
  assert.equal(confirmed.deletions[0].source_sheet, "To Review");
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

test("Reject and user Skip retain full context in Archive", () => {
  const denied = row(4020, "review_needed", "Reject", {
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
  assert.equal(deniedCopy.archive_reason, "review_rejected");
  assert.equal(deniedCopy.review_decision, "reject");
  assert.equal(deniedCopy.review_decided_at, now);
  assert.deepEqual(deniedCopy.requirement_gaps, ["PHP"]);
  assert.equal(deniedCopy.notes, "Not a good tradeoff");
  const skippedCopy = writes.archive.find(
    (record) => record.canonical_job_id === skipped.canonical_job_id
  );
  assert.equal(skippedCopy.archive_reason, "user_skip");
  assert.equal(skippedCopy.generated_message, skipped.generated_message);
});

test("direct operator actions route without requiring an impossible guard edit", () => {
  for (const [id, status, action, destination] of [
    [4022, "review_needed", "Proceed", "To Apply"],
    [4023, "review_needed", "Reject", "Archive"],
    [4024, "ready_to_apply", "I Applied", "Applied Jobs"],
    [4025, "ready_to_apply", "Skip", "Archive"]
  ]) {
    const persisted = row(id, status);
    const operatorEdited = {
      ...persisted,
      user_action: action,
      notes: `operator chose ${action}`
    };
    assert.equal(operatorEdited.state_guard, stateGuard(operatorEdited));
    const plan = planQueueActionsRaw(
      businessStores(sourceStores([operatorEdited])),
      schema,
      now,
      safetyContext
    );
    assert.equal(plan.rejected.length, 0, action);
    assert.equal(plan.moves[0].destination, destination, action);
  }
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

test("legacy movement guards fail closed after the guarded migration", () => {
  const automatic = row(4026, "skip");
  automatic.state_guard = legacyStateGuard(automatic);

  const acted = row(4027, "ready_to_apply");
  acted.state_guard = legacyStateGuard(acted);
  acted.user_action = "Skip";

  const tampered = row(4028, "review_needed");
  tampered.state_guard = legacyStateGuard(tampered);
  tampered.generated_at = "2026-07-31T09:59:59.000Z";

  const current = row(4029, "skip");

  const plan = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [automatic, tampered, current],
      "To Apply": [acted]
    }),
    schema,
    now,
    safetyContext
  );

  assert.deepEqual(
    plan.moves.map((move) => [move.canonical_job_id, move.destination]),
    [[current.canonical_job_id, "Archive"]]
  );
  const [moved] = destinationWrites(plan).archive;
  assert.match(moved.state_guard, /\|[a-f0-9]{64}$/);
  assert.equal(moved.state_guard, stateGuard(moved));
  assert.deepEqual(
    plan.rejected.map((entry) => [entry.canonical_job_id, entry.reason]),
    [
      [automatic.canonical_job_id, "invalid_source"],
      [tampered.canonical_job_id, "invalid_source"],
      [acted.canonical_job_id, "invalid_source"]
    ]
  );
});

test("the retired Scraped Jobs approval loop has one guarded v3 exit", () => {
  for (const [legacyAction, destination, routeReason] of [
    ["Approve", "To Apply", "review_proceeded"],
    ["Deny", "Archive", "review_rejected"]
  ]) {
    const raw = row(2460 + legacyAction.length, "review_needed", "");
    raw.user_action = legacyAction;
    delete raw.compatibility_legacy_user_action;
    raw.state_guard = legacyStateGuardV3(raw);
    const normalized = normalizeLegacyRecord(raw, schema, now);
    const stores = businessStores({ "Scraped Jobs": [normalized] });
    const plan = planQueueActionsRaw(stores, schema, now, safetyContext);
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].source_sheet, "Scraped Jobs");
    assert.equal(plan.moves[0].destination, destination);
    assert.equal(plan.moves[0].route_reason, routeReason);
    assert.equal(plan.moves[0].destination_record.user_action, "");
    assert.equal(plan.moves[0].destination_record.review_case_version, "review-case-v1");
  }
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

test("I Applied records the manual fact independently of current alert message safety", () => {
  const safe = row(4040, "ready_to_apply", "I Applied");
  const plan = planQueueActions([safe], [], [], schema, now);
  const writes = destinationWrites(plan);
  assert.equal(writes.applied.length, 1);
  assert.equal(writes.applied[0].applied_at, now);
  assert.equal(writes.applied[0].user_action, "");
  assert.equal(writes.applied[0].generated_message, safe.generated_message);

  const terminalAlertWithInvalidCurrentContent = row(
    4042,
    "ready_to_apply",
    "I Applied",
    {
      message_profile_version: "historical/profile",
      application_pack_profile_version: "historical/profile",
      generated_message: "Hi there,",
      alert_status: "terminal_failure",
      alert_error_category: "provider_rejected"
    }
  );
  terminalAlertWithInvalidCurrentContent.state_guard = stateGuard(
    terminalAlertWithInvalidCurrentContent
  );
  const terminalPlan = planQueueActions(
    [terminalAlertWithInvalidCurrentContent],
    [],
    [],
    schema,
    now
  );
  assert.equal(terminalPlan.moves.length, 1);
  assert.equal(terminalPlan.moves[0].destination, "Applied Jobs");
  assert.equal(terminalPlan.rejected.length, 0);
});

test("terminal operator actions cancel in-flight alerts instead of stranding moves", () => {
  for (const [id, action, destination] of [
    [4043, "I Applied", "Applied Jobs"],
    [4044, "Skip", "Archive"]
  ]) {
    const source = row(id, "ready_to_apply", action, {
      alert_status: "sending",
      alert_idempotency_key: `slack:onlinejobs.ph:${id}:test`,
      alert_claim_token: `execution:alert:${id}`,
      alert_attempt_count: 1,
      alert_last_attempt_at: "2026-07-31T09:59:00.000Z"
    });
    const plan = planQueueActions([source], [], [], schema, now);
    assert.equal(plan.rejected.length, 0);
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.moves[0].destination, destination);
    assert.equal(plan.moves[0].destination_record.alert_status, "suppressed");
    assert.equal(plan.moves[0].destination_record.alert_claim_token, "");
    assert.equal(plan.moves[0].destination_record.alert_next_retry_at, "");
    assert.equal(
      plan.moves[0].destination_record.alert_error_category,
      "operator_terminal_action"
    );
  }
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
  const second = row(4061, "review_needed", "Reject", { row_number: 9 });
  const third = row(4062, "ready_to_apply", "Skip", { row_number: 12 });
  first.state_guard = stateGuard(first);
  second.state_guard = stateGuard(second);
  third.state_guard = stateGuard(third);
  const plan = planQueueActions([first, second, third], [], [], schema, now);
  const written = destinationAfterWrite(plan);
  assert.deepEqual(
    written.applied[0].requirement_coverage,
    first.requirement_coverage
  );
  assert.deepEqual(
    written.applied[0].application_message_plan,
    first.application_message_plan
  );
  assert.equal(
    written.applied[0].coverage_contract_version,
    first.coverage_contract_version
  );
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

test("Proceed recovery accepts a destination that was guardedly prepared before source cleanup", () => {
  const source = row(2513, "review_needed", "Proceed", {
    review_case_id: "",
    review_case_version: "",
    review_decision: "",
    review_decided_at: ""
  });
  source.state_guard = stateGuard(source);
  const initial = planQueueActions(
    [source],
    [],
    [],
    schema,
    now
  );
  const pending = initial.moves[0].destination_record;
  const progressed = {
    ...pending,
    prep_status: "needs_input",
    required_input: "Provide a verified availability date.",
    application_pack_status: "review_required",
    application_warnings: [
      {
        code: "candidate_input_required",
        severity: "review",
        summary: "A verified availability date is required."
      }
    ],
    record_version: pending.record_version + 2,
    preparation_updated_at: "2026-07-31T10:05:00.000Z",
    updated_at: "2026-07-31T10:05:00.000Z"
  };
  progressed.state_guard = stateGuard(progressed);
  const recovery = planQueueActionsRaw(
    businessStores({
      "To Review": [source],
      "To Apply": [progressed]
    }),
    schema,
    "2026-07-31T10:06:00.000Z",
    safetyContext
  );
  assert.equal(recovery.moves.length, 1);
  assert.equal(recovery.moves[0].write_required, false);
  assert.equal(recovery.moves[0].recovery_required, true);
  assert.deepEqual(
    confirmMoveDeletions(
      recovery,
      businessStores({
        "To Review": [source],
        "To Apply": [progressed]
      }),
      schema
    ).deletions.map((entry) => entry.canonical_job_id),
    [source.canonical_job_id]
  );
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
  const approval = row(4074, "review_needed", "Proceed");
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

  const directEditWithStaleGuard = {
    ...source,
    job_description: "A newer description entered directly in the Sheet",
    state_guard: source.state_guard
  };
  const staleGuardConfirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([directEditWithStaleGuard]),
      "Applied Jobs": written.applied
    }),
    schema
  );
  assert.deepEqual(staleGuardConfirmation.deletions, []);
  assert.equal(staleGuardConfirmation.rejected[0].reason, "stale_source");

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

  const rediscovered = {
    ...source,
    matched_keywords: [...source.matched_keywords, "new rediscovery keyword"],
    last_seen_at: "2026-07-31T10:01:00.000Z",
    updated_at: "2026-07-31T10:01:00.000Z"
  };
  assert.equal(rediscovered.state_guard, source.state_guard);
  const rediscoveryConfirmation = confirmMoveDeletions(
    plan,
    businessStores({
      ...sourceStores([rediscovered]),
      "Applied Jobs": written.applied
    }),
    schema
  );
  assert.deepEqual(rediscoveryConfirmation.deletions, []);
  assert.equal(rediscoveryConfirmation.rejected[0].reason, "stale_source");
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

test("exact autonomous confirmation moves directly to Applied Jobs with submission provenance", () => {
  const source = autonomousConfirmedRow(4200);
  const plan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [source] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].destination, "Applied Jobs");
  assert.equal(plan.moves[0].route_reason, "autonomous_confirmed");
  assert.match(plan.moves[0].claim_scope, /autonomous_confirmed/);
  assert.match(plan.moves[0].claim_scope, /submission-v1/);
  const [destination] = destinationWrites(plan).applied;
  assert.equal(destination.applied_at, source.submission_confirmed_at);
  assert.equal(destination.user_action, "");
  for (const field of [
    "execution_mode",
    "autonomous_decision",
    "browser_state",
    "browser_attempt_id",
    "browser_job_digest",
    "browser_form_fingerprint",
    "submission_idempotency_key",
    "submission_confirmed_at",
    "submission_confirmation_kind",
    "submission_confirmation_reference",
    "submission_confirmation_digest",
    "submission_attestation_key_id",
    "submission_attestation_witness_digest",
    "submission_attestation_signature",
    "message_profile_version",
    "message_policy_version",
    "application_pack_profile_version",
    "application_pack_policy_version"
  ]) {
    assert.deepEqual(destination[field], source[field], field);
  }
});

test("Alerter & Mover independently rejects forged confirmation receipts", () => {
  const forged = autonomousConfirmedRow(4202);
  forged.submission_attestation_signature = "Z".repeat(86);
  forged.state_guard = stateGuard(forged);
  const plan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [forged] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(plan.moves.length, 0);
  assert.ok(
    plan.rejected.some(
      (entry) =>
        entry.reason === "invalid_autonomous_confirmation" &&
        /independent_confirmation_attestation/.test(entry.summary)
    )
  );
});

test("autonomous skip archives distinctly without manufacturing an operator action", () => {
  const source = autonomousConfirmedRow(4201, {
    pipeline_status: "skip",
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: "",
    autonomous_decision: "skip",
    browser_state: "skipped",
    submission_idempotency_key: "",
    submission_started_at: "",
    submission_confirmed_at: "",
    submission_confirmation_kind: "",
    submission_confirmation_reference: "",
    submission_confirmation_digest: ""
  });
  source.preparation_input_guard = "";
  source.state_guard = stateGuard(source);
  const plan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [source] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].route_reason, "autonomous_skip");
  const [destination] = destinationWrites(plan).archive;
  assert.equal(destination.archive_reason, "autonomous_skip");
  assert.equal(destination.user_action, "");
});

test("every nonterminal or uncertain autonomous browser state remains unmoved", () => {
  const formStates = new Set([
    "generating",
    "filling",
    "submit_started",
    "ambiguous"
  ]);
  const startedStates = new Set(["submit_started", "ambiguous"]);
  for (const [index, browserState] of [
    "queued",
    "claimed",
    "evaluating",
    "generating",
    "filling",
    "submit_started",
    "retryable",
    "ambiguous",
    "blocked",
    "unavailable"
  ].entries()) {
    const source = autonomousConfirmedRow(4210 + index, {
      browser_state: browserState,
      autonomous_decision: [
        "generating",
        "filling",
        "submit_started",
        "ambiguous"
      ].includes(browserState)
        ? "apply"
        : "",
      browser_attempt_id: ["queued", "unavailable"].includes(browserState)
        ? ""
        : `attempt-v1:${"a".repeat(64)}`,
      browser_form_fingerprint: formStates.has(browserState)
        ? `form-v1:${"a".repeat(64)}`
        : "",
      submission_idempotency_key: formStates.has(browserState)
        ? submissionIdempotencyKey({
            ...autonomousConfirmedRow(4210 + index),
            browser_state: browserState
          })
        : "",
      submission_started_at: startedStates.has(browserState)
        ? "2026-07-31T09:55:00.000Z"
        : "",
      submission_confirmed_at: "",
      submission_confirmation_kind: "",
      submission_confirmation_reference: "",
      submission_confirmation_digest: "",
      browser_block_category: browserState === "blocked" ? "captcha" : ""
    });
    source.state_guard = stateGuard(source);
    const plan = planQueueActionsRaw(
      businessStores({ "Scraped Jobs": [source] }),
      schema,
      now,
      safetyContext
    );
    assert.equal(plan.moves.length, 0, browserState);
    assert.equal(
      plan.rejected.length,
      0,
      `${browserState}: ${JSON.stringify(plan.rejected)}`
    );
  }
});

test("malformed autonomous confirmation evidence cannot authorize movement", () => {
  const mutations = {
    browser_attempt_id: "",
    browser_job_digest: "",
    browser_form_fingerprint: "",
    submission_idempotency_key: "",
    submission_started_at: "invalid",
    submission_confirmed_at: "",
    submission_confirmation_kind: "",
    submission_confirmation_reference: "",
    submission_confirmation_digest: "",
    message_profile_version: "different-profile"
  };
  let id = 4230;
  for (const [field, value] of Object.entries(mutations)) {
    const source = autonomousConfirmedRow(id, { [field]: value });
    source.state_guard = stateGuard(source);
    const plan = planQueueActionsRaw(
      businessStores({ "Scraped Jobs": [source] }),
      schema,
      now,
      safetyContext
    );
    assert.equal(plan.moves.length, 0, field);
    assert.ok(plan.rejected.length > 0, field);
    id += 1;
  }

  const policyMismatch = autonomousConfirmedRow(4245);
  policyMismatch.message_policy_version = "stale-message-policy";
  policyMismatch.state_guard = stateGuard(policyMismatch);
  const mismatchedPolicyPlan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [policyMismatch] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(mismatchedPolicyPlan.moves.length, 0);
  assert.ok(
    mismatchedPolicyPlan.rejected.some(
      (entry) => entry.reason === "invalid_source"
    )
  );

  const staleGuard = autonomousConfirmedRow(4246);
  staleGuard.submission_confirmation_reference =
    `confirmation-ref-v1:${"d".repeat(64)}`;
  const stalePlan = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [staleGuard] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(stalePlan.moves.length, 0);
  assert.ok(
    stalePlan.rejected.some(
      (entry) =>
        entry.reason === "invalid_source" &&
        /state guard/i.test(entry.summary)
    )
  );
});

test("autonomous destination recovery repairs partial copies but rejects another submission identity", () => {
  const source = autonomousConfirmedRow(4250);
  const initial = planQueueActionsRaw(
    businessStores({ "Scraped Jobs": [source] }),
    schema,
    now,
    safetyContext
  );
  const complete = { ...destinationWrites(initial).applied[0], row_number: 2 };
  const repeated = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [source],
      "Applied Jobs": [complete]
    }),
    schema,
    "2026-07-31T10:05:00.000Z",
    safetyContext
  );
  assert.equal(repeated.moves[0].write_required, false);
  const confirmation = confirmMoveDeletions(
    repeated,
    businessStores({
      "Scraped Jobs": [source],
      "Applied Jobs": [complete]
    }),
    schema,
    confirmationTrust
  );
  assert.equal(confirmation.deletions.length, 1);

  const partial = {
    ...complete,
    submission_confirmation_reference: "",
    notes: "Newer destination note",
    record_version: complete.record_version + 1
  };
  partial.state_guard = stateGuard(partial);
  const repair = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [source],
      "Applied Jobs": [partial]
    }),
    schema,
    "2026-07-31T10:06:00.000Z",
    safetyContext
  );
  assert.equal(repair.moves[0].write_required, true);
  assert.equal(
    repair.moves[0].destination_record.submission_confirmation_reference,
    source.submission_confirmation_reference
  );
  assert.equal(repair.moves[0].destination_record.notes, partial.notes);

  const strongerDigest = "c".repeat(64);
  const strongerConfirmedAt = "2026-07-31T09:58:00.000Z";
  const stronger = {
    ...complete,
    job_title: "",
    notes: "Keep the destination-owned note",
    outcome: "interview",
    outcome_recorded_value: "interview",
    outcome_at: "2026-07-31T10:04:00.000Z",
    browser_attempt_id: `attempt-v1:${strongerDigest}`,
    submission_confirmed_at: strongerConfirmedAt,
    submission_confirmation_kind: "application_history",
    submission_confirmation_reference: `confirmation-ref-v1:${strongerDigest}`,
    submission_confirmation_digest: `confirmation-v1:${strongerDigest}`,
    applied_at: strongerConfirmedAt,
    record_version: complete.record_version + 2
  };
  attestAutonomousConfirmation(stronger);
  stronger.state_guard = stateGuard(stronger);
  const strongerRepair = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [source],
      "Applied Jobs": [stronger]
    }),
    schema,
    "2026-07-31T10:06:30.000Z",
    safetyContext
  );
  assert.equal(strongerRepair.moves[0].write_required, true);
  assert.equal(
    strongerRepair.moves[0].destination_record.submission_confirmation_kind,
    "application_history"
  );
  assert.equal(
    strongerRepair.moves[0].destination_record.submission_confirmation_digest,
    stronger.submission_confirmation_digest
  );
  assert.equal(
    strongerRepair.moves[0].destination_record.applied_at,
    strongerConfirmedAt
  );
  assert.equal(strongerRepair.moves[0].destination_record.job_title, source.job_title);
  assert.equal(
    strongerRepair.moves[0].destination_record.notes,
    stronger.notes
  );
  assert.equal(
    strongerRepair.moves[0].destination_record.outcome,
    "interview"
  );

  const conflicting = {
    ...complete,
    submission_idempotency_key: `submission-v1:${"b".repeat(64)}`
  };
  conflicting.state_guard = stateGuard(conflicting);
  const conflict = planQueueActionsRaw(
    businessStores({
      "Scraped Jobs": [source],
      "Applied Jobs": [conflicting]
    }),
    schema,
    "2026-07-31T10:07:00.000Z",
    safetyContext
  );
  assert.equal(conflict.moves.length, 0);
  assert.ok(conflict.rejected.some((entry) => entry.reason === "destination_conflict"));
});

test("legacy manual actions cannot authorize an autonomous record", () => {
  const forged = autonomousConfirmedRow(4260, { user_action: "I Applied" });
  forged.state_guard = stateGuard(forged);
  const plan = planQueueActionsRaw(
    businessStores({ "To Apply": [forged] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(plan.moves.length, 0);
  assert.ok(
    plan.rejected.some((entry) =>
      ["invalid_source", "forged_autonomous_action"].includes(entry.reason)
    )
  );
});
