import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applicationReviewGuard,
  legacyStateGuardV3,
  normalizeLegacyRecord,
  preparationInputGuard,
  stateGuard
} from "../src/contracts.mjs";
import {
  claimGeneratorRecord,
  selectGeneratorCandidate
} from "../src/generator.mjs";
import {
  planReviewPreparationMigration,
  REVIEW_PREPARATION_REGRESSION_IDS,
  validateReviewPreparationCutoverEvidence
} from "../src/review-preparation-cutover.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const schema = await loadJson("../config/pipeline-schema.json");
const runtime = await loadJson("../config/runtime.json");
const legacyGeneratorRuntime = await loadJson(
  "./fixtures/legacy-generator-runtime.json"
);
const deploymentPolicy = await loadJson("../config/n8n-deployment-policy.json");
const receiptPolicy = await loadJson("../config/alert-receipts.json");
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const now = "2026-08-04T02:00:00.000Z";

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

function row(id, store, action = "", overrides = {}) {
  const status =
    store === "To Review"
      ? "review_needed"
      : ["To Apply", "Applied Jobs"].includes(store)
        ? "ready_to_apply"
        : store === "Archive"
          ? "skip"
          : "new";
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
      matched_keywords: ["developer"],
      job_title: `Job ${id}`,
      job_description: "Build React and Node.js features.",
      decision_reason: "Auditable decision",
      application_instructions: [],
      screening_questions: [],
      requirement_coverage: [],
      application_message_plan: [],
      selected_proof_refs: [],
      application_warnings: [],
      created_at: "2026-08-03T01:00:00.000Z",
      updated_at: "2026-08-03T01:00:00.000Z",
      ...(store === "Archive" ? { archive_reason: "automatic_skip" } : {}),
      ...overrides
    },
    schema,
    now
  );
  normalized.state_guard = stateGuard(normalized);
  return normalized;
}

function legacyRow(id, store, action = "", overrides = {}) {
  const current = row(id, store, action, overrides);
  const raw = {
    ...current,
    user_action: action
  };
  for (const field of [
    "review_case_id",
    "review_case_version",
    "review_decision",
    "review_decided_at",
    "prep_status",
    "preparation_version",
    "preparation_input_guard",
    "preparation_updated_at"
  ]) {
    delete raw[field];
  }
  raw.state_guard = legacyStateGuardV3(raw);
  return raw;
}

function snapshot(stores, overrides = {}) {
  return {
    captured_at: now,
    contract_version: schema.storage_version,
    stores,
    active_claims: [],
    message_authorizations: [],
    ...overrides
  };
}

test("migration planner deterministically classifies legacy review decisions without writes", () => {
  const blank = legacyRow(1699999, "To Review");
  const approved = legacyRow(1589947, "To Review", "Approve");
  const denied = legacyRow(1701320, "To Review", "Deny");
  const prepLess = legacyRow(1701315, "To Apply");
  const direct = row(1701179, "Scraped Jobs");
  const input = snapshot(
    businessStores({
      "Scraped Jobs": [direct],
      "To Review": [blank, approved, denied],
      "To Apply": [prepLess]
    })
  );
  const first = planReviewPreparationMigration(input, schema);
  const second = planReviewPreparationMigration(structuredClone(input), schema);
  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.equal(first.writes_allowed, false);
  assert.equal(first.manual_business_row_relocation_allowed, false);
  assert.deepEqual(first.write_operations, []);
  assert.equal(first.business_row_relocation_mode, "copy_confirm_delete_only");
  const byId = new Map(
    first.routes.map((route) => [route.canonical_job_id, route])
  );
  assert.equal(byId.get("onlinejobs.ph:1699999").normalized_decision, "unresolved");
  assert.deepEqual(
    {
      decision: byId.get("onlinejobs.ph:1589947").normalized_decision,
      store: byId.get("onlinejobs.ph:1589947").target_store,
      prep: byId.get("onlinejobs.ph:1589947").target_prep_status
    },
    { decision: "proceed", store: "To Apply", prep: "pending" }
  );
  assert.equal(byId.get("onlinejobs.ph:1701320").target_store, "Archive");
  assert.equal(
    byId.get("onlinejobs.ph:1701315").target_prep_status,
    "preparation_error"
  );
  assert.match(
    byId.get("onlinejobs.ph:1589947").required_guarded_workflow_path,
    /copy_confirm_delete/
  );
  assert.deepEqual(first.named_regression_ids, REVIEW_PREPARATION_REGRESSION_IDS);
});

test("migration planner gives looped Scraped Jobs approvals one guarded workflow exit", () => {
  const approved = legacyRow(1701179, "Scraped Jobs", "Approve", {
    pipeline_status: "review_needed"
  });
  const denied = legacyRow(1701180, "Scraped Jobs", "Deny", {
    pipeline_status: "review_needed"
  });
  const plan = planReviewPreparationMigration(
    snapshot(businessStores({ "Scraped Jobs": [approved, denied] })),
    schema
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.routes.map((route) => [
      route.raw_action,
      route.normalized_decision,
      route.target_store,
      route.target_prep_status
    ]),
    [
      ["Approve", "proceed", "To Apply", "pending"],
      ["Deny", "reject", "Archive", ""]
    ]
  );
  assert.ok(
    plan.routes.every((route) =>
      route.required_guarded_workflow_path.startsWith("alerter_mover_")
    )
  );
});

test("only an exact current persisted-message authorization plans message_ready", () => {
  const message = "A current validated application draft";
  const legacy = legacyRow(1701315, "To Apply", "", {
    generated_message: message,
    message_validation_status: "valid",
    message_profile_version: profile.profile_version,
    message_policy_version: applicationPolicy.policy_version,
    application_pack_status: "ready",
    application_pack_version: packPolicy.pack_version,
    application_pack_profile_version: profile.profile_version,
    application_pack_policy_version: packPolicy.policy_version
  });
  const normalized = normalizeLegacyRecord(legacy, schema, now);
  const authorization = {
    canonical_job_id: normalized.canonical_job_id,
    authorized: true,
    authorization_kind: "persisted_message_safety",
    contract_version: schema.storage_version,
    state_guard: normalized.state_guard,
    preparation_input_guard: preparationInputGuard(normalized),
    message_sha256: createHash("sha256").update(message).digest("hex"),
    checked_at: now
  };
  const accepted = planReviewPreparationMigration(
    snapshot(businessStores({ "To Apply": [legacy] }), {
      message_authorizations: [authorization]
    }),
    schema
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.routes[0].target_prep_status, "message_ready");
  const stale = planReviewPreparationMigration(
    snapshot(businessStores({ "To Apply": [legacy] }), {
      message_authorizations: [
        { ...authorization, message_sha256: "0".repeat(64) }
      ]
    }),
    schema
  );
  assert.equal(stale.routes[0].target_prep_status, "preparation_error");
});

test("migration preflight stops duplicates, stale guards, active claims, and contract mismatch", () => {
  const original = legacyRow(1699999, "To Review", "Approve");
  const duplicate = { ...original, row_number: original.row_number + 1 };
  const plan = planReviewPreparationMigration(
    snapshot(
      businessStores({
        "To Review": [original],
        "To Apply": [duplicate]
      }),
      {
        contract_version: "stale-contract",
        active_claims: [
          {
            canonical_job_id: original.canonical_job_id,
            contract_version: "stale-contract",
            expires_at: "2026-08-04T02:10:00.000Z"
          }
        ]
      }
    ),
    schema
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.writes_allowed, false);
  const categories = new Set(plan.rejects.map((entry) => entry.category));
  assert.ok(categories.has("contract_mismatch"));
  assert.ok(categories.has("active_claim"));
  assert.ok(categories.has("duplicate_identity"));

  const stale = { ...legacyRow(1701179, "To Review") };
  stale.job_title = "Changed after guard";
  const stalePlan = planReviewPreparationMigration(
    snapshot(businessStores({ "To Review": [stale] })),
    schema
  );
  assert.equal(stalePlan.ok, false);
  assert.equal(stalePlan.rejects[0].category, "stale_state_guard");

  const missingGuard = legacyRow(1701179, "To Review");
  delete missingGuard.state_guard;
  const missingGuardPlan = planReviewPreparationMigration(
    snapshot(businessStores({ "To Review": [missingGuard] })),
    schema
  );
  assert.equal(missingGuardPlan.ok, false);
  assert.equal(missingGuardPlan.rejects[0].category, "stale_state_guard");

  const unknownStatus = legacyRow(1701179, "To Review");
  unknownStatus.pipeline_status = "mystery";
  const unknownStatusPlan = planReviewPreparationMigration(
    snapshot(businessStores({ "To Review": [unknownStatus] })),
    schema
  );
  assert.equal(unknownStatusPlan.ok, false);
  assert.equal(
    unknownStatusPlan.rejects[0].category,
    "unsupported_state_action"
  );

  const rowClaim = legacyRow(1701320, "To Review");
  rowClaim.processing_token = "still-owned";
  rowClaim.processing_started_at = now;
  rowClaim.state_guard = legacyStateGuardV3(rowClaim);
  const claimedPlan = planReviewPreparationMigration(
    snapshot(businessStores({ "To Review": [rowClaim] })),
    schema
  );
  assert.equal(claimedPlan.ok, false);
  assert.equal(claimedPlan.rejects[0].category, "active_claim");
});

test("Generator converts one valid v3 To Apply guard into the v4 preparation claim", () => {
  const legacy = legacyRow(1701315, "To Apply", "", {
    review_approved_at: "2026-08-03T02:00:00.000Z"
  });
  legacy.review_approval_guard = applicationReviewGuard(legacy);
  legacy.state_guard = legacyStateGuardV3(legacy);
  const normalized = normalizeLegacyRecord(legacy, schema, now);
  const selected = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [normalized] },
    schema,
    legacyGeneratorRuntime,
    now
  );
  assert.equal(selected.length, 1);
  const claim = claimGeneratorRecord(
    selected[0].record,
    selected[0].stage,
    "migration-execution",
    now,
    legacyGeneratorRuntime.claim_lease_ms,
    "To Apply"
  );
  assert.equal(claim.record.review_decision, "proceed");
  assert.equal(claim.record.review_case_version, "review-case-v1");
  assert.equal(claim.record.prep_status, "preparing");
  assert.equal(claim.record.preparation_version, 1);
  assert.equal(
    claim.record.preparation_input_guard,
    preparationInputGuard(claim.record)
  );
  assert.equal(claim.record.state_guard, stateGuard(claim.record));

  const mixed = {
    ...normalized,
    prep_status: "pending",
    preparation_version: 1,
    preparation_input_guard: preparationInputGuard(normalized),
    preparation_updated_at: now
  };
  mixed.state_guard = legacyStateGuardV3(mixed);
  assert.throws(
    () =>
      claimGeneratorRecord(
        mixed,
        "generation",
        "mixed-contract",
        now,
        legacyGeneratorRuntime.claim_lease_ms,
        "To Apply"
      ),
    /stale source state guard/
  );
});

function validEvidence(phase) {
  const post = phase === "post_cutover";
  const commit = "a".repeat(40);
  const counts = Object.fromEntries(
    schema.business_stores.map((store) => [store, 0])
  );
  counts["To Review"] = 1;
  counts["To Apply"] = 4;
  const trueMap = (fields) =>
    Object.fromEntries(fields.map((field) => [field, true]));
  return {
    schema_version: 1,
    phase,
    environment: "production",
    contract_version: schema.storage_version,
    captured_at: now,
    privacy: {
      sanitized: true,
      secret_scan_clean: true,
      credentials_included: false,
      generated_messages_included: false,
      job_descriptions_included: false,
      complete_sheet_rows_included: false
    },
    release: {
      commit,
      issue_75_commit: commit,
      issue_76_commit: commit,
      issue_77_commit: commit,
      ...trueMap([
        "build_passed",
        "validate_passed",
        "artifact_drift_clean",
        "commits_reviewed"
      ])
    },
    workflows: deploymentPolicy.workflow_cutover.roles.map((role) => ({
      role: role.role,
      id: role.target_workflow_id,
      version_id: `${role.role}-version-1`,
      artifact_digest: role.artifact_digest,
      timezone: runtime.timezone,
      execution_timeout_seconds: role.execution_timeout_seconds,
      schedule_expressions: role.schedule_expressions,
      queue_binding_environment_variable:
        deploymentPolicy.workbook_binding
          .queue_spreadsheet_environment_variable,
      configuration_binding_environment_variable:
        deploymentPolicy.workbook_binding
          .configuration_spreadsheet_environment_variable,
      active: post
    })),
    workflow_inventory: {
      instance_wide: true,
      stale_and_verification_copies_inactive: true,
      unrecognized_active_pipeline_writer_count: 0,
      active_role_count: post ? 3 : 0
    },
    workbook: {
      pipeline_schema_version: schema.schema_version,
      storage_version: schema.storage_version,
      receipt_schema_version: receiptPolicy.schema_version,
      row_counts: counts,
      pre_cutover_identity_count: 5,
      authoritative_identity_count: 5,
      unique_identity_count: 5,
      duplicate_identity_count: 0,
      unexplained_loss_count: 0,
      ...trueMap([
        "operator_values_preserved",
        "business_rows_preserved_by_setup",
        "zero_seed_rows_created",
        "setup_idempotent"
      ])
    },
    backups:
      deploymentPolicy.workflow_cutover.evidence_contract.required_backup_kinds.map(
        (kind) => ({
          kind,
          reference: `${kind}-backup-1`,
          sha256: "b".repeat(64),
          readable: true,
          restore_identifier_verified: true
        })
      ),
    preflight: {
      fresh_exact_reread: true,
      passed: true,
      all_identities_indexed: true,
      duplicate_identity_count: 0,
      unsupported_state_action_count: 0,
      stale_guard_count: 0,
      active_claim_count: 0,
      contract_mismatch_count: 0,
      partial_move_count: 0
    },
    migration: {
      ...trueMap([
        "planner_repeat_equal",
        "planner_made_no_writes",
        "every_legacy_row_classified",
        "copy_confirm_delete_only",
        "no_manual_relocation",
        "stale_duplicate_rule_observed"
      ]),
      legacy_blank_count: 1,
      legacy_proceed_count: 1,
      legacy_reject_count: 1,
      legacy_to_apply_count: 1,
      migration_reject_count: 0,
      planned_legacy_count: 4,
      executed_legacy_count: post ? 4 : 0
    },
    disposable: trueMap([
      "append_confirm_delete_partial_failure_passed",
      "stale_action_rejected",
      "duplicate_owner_not_created",
      "setup_rerun_idempotent",
      "no_auto_application"
    ]),
    execution_parity: trueMap([
      "same_generated_workflow",
      "same_route_table",
      "same_claims_guards_caps",
      "same_receipt_contract",
      "same_audit_outputs"
    ]),
    named_records: REVIEW_PREPARATION_REGRESSION_IDS.map((sourceJobId) => ({
      source_job_id: sourceJobId,
      owner_store: "To Apply",
      outcome: "message_ready",
      authoritative_owner_count: post ? 1 : 0,
      repeated_undecided_review_case_count: 0
    })),
    observations: {
      preparation_pending_count: 0,
      message_ready_count: 5,
      needs_input_count: 0,
      external_steps_count: 0,
      repair_or_error_count: 0,
      repeated_case_suppression_count: 0,
      partial_recovery_count: 0,
      provider_failure_count: 0,
      reminder_count: 0,
      copy_ready_alert_count: 1,
      unresolved_migration_reject_count: 0,
      scheduled_boundaries_observed: post ? 3 : 0,
      observation_minutes: post
        ? deploymentPolicy.workflow_cutover.evidence_contract
            .minimum_observation_minutes
        : 0,
      ...trueMap([
        "unchanged_paused_records_not_reprepared",
        "unchanged_paused_records_not_rereminded",
        "controlled_input_change_resumed_once",
        "copy_ready_alert_at_most_once",
        "reminder_categories_policy_exact"
      ])
    },
    regressions: trueMap([
      "rediscovery",
      "direct_ready",
      "applied",
      "skip",
      "reject",
      "archive",
      "claim_recovery",
      "slack_receipts",
      "no_auto_application"
    ]),
    rollback: {
      ...trueMap([
        "triggers_documented",
        "order_documented",
        "compatibility_limits_documented",
        "restores_compatibility_unit",
        "no_manual_row_relocation"
      ]),
      runbook_reference: "review-preparation-cutover-runbook-v1"
    }
  };
}

test("sanitized pre/post cutover evidence passes only with complete live proof", () => {
  for (const phase of ["pre_cutover", "post_cutover"]) {
    assert.deepEqual(
      validateReviewPreparationCutoverEvidence(
        schema,
        runtime,
        deploymentPolicy,
        receiptPolicy,
        validEvidence(phase)
      ),
      []
    );
  }
  const unsafe = validEvidence("post_cutover");
  unsafe.notes = { generated_message: "private draft" };
  assert.match(
    validateReviewPreparationCutoverEvidence(
      schema,
      runtime,
      deploymentPolicy,
      receiptPolicy,
      unsafe
    ).join("; "),
    /sensitive material/
  );
  const incomplete = validEvidence("post_cutover");
  incomplete.observations.scheduled_boundaries_observed = 2;
  assert.match(
    validateReviewPreparationCutoverEvidence(
      schema,
      runtime,
      deploymentPolicy,
      receiptPolicy,
      incomplete
    ).join("; "),
    /observation is incomplete/
  );
  const missingDuration = validEvidence("post_cutover");
  delete missingDuration.observations.observation_minutes;
  assert.match(
    validateReviewPreparationCutoverEvidence(
      schema,
      runtime,
      deploymentPolicy,
      receiptPolicy,
      missingDuration
    ).join("; "),
    /observation_minutes must be a non-negative integer/
  );
});
