import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  migrationDisposition,
  planAutonomousBrowserMigration,
  validateAutonomousBrowserCutoverEvidence
} from "../src/autonomous-browser-cutover.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const policy = await loadJson("../config/n8n-deployment-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");
policy.mixed_cutover.scheduled_task.attestation_key_id =
  "test-history-adapter-v1";
policy.mixed_cutover.scheduled_task.attestation_public_key_spki_sha256 =
  `sha256:${"8".repeat(64)}`;

function evidenceFor(phase = "pre_activation") {
  const post = phase === "post_activation";
  const prepared = phase !== "pre_cutover";
  return {
    schema_version: 1,
    phase,
    policy_version: policy.policy_version,
    deployment_commit: "a".repeat(40),
    captured_at: post
      ? "2026-08-10T09:31:00.000Z"
      : "2026-08-10T08:00:00.000Z",
    privacy: {
      sanitized: true,
      secret_scan_clean: true,
      messages_included: false,
      descriptions_included: false,
      dom_included: false,
      screenshots_included: false,
      cookies_or_credentials_included: false,
      browser_history_included: false
    },
    n8n_workflows: policy.mixed_cutover.n8n_roles.map((role, index) => ({
      role: role.role,
      workflow_id: role.target_workflow_id,
      workflow_version: `version-${index + 1}`,
      artifact_digest: role.artifact_digest,
      binding_digest: String(index + 1).padStart(64, "0"),
      timezone: role.timezone,
      execution_timeout_seconds: role.execution_timeout_seconds,
      active: phase === "pre_activation" ? false : true,
      observed_at: "2026-08-10T08:00:00.000Z"
    })),
    retired_generator: {
      workflow_id: policy.mixed_cutover.retired_generator.target_workflow_id,
      artifact_digest:
        policy.mixed_cutover.retired_generator
          .last_manual_contract_artifact_digest,
      active: prepared ? false : true,
      observed_at: "2026-08-10T08:00:00.000Z"
    },
    scheduled_task: {
      task_id: prepared ? "scheduled-browser-task-1" : "",
      state: phase === "pre_cutover" ? "absent" : post ? "active" : "paused",
      contract_version: policy.mixed_cutover.scheduled_task.contract_version,
      artifact_digest: policy.mixed_cutover.scheduled_task.artifact_digest,
      prompt_digest: policy.mixed_cutover.scheduled_task.prompt_digest,
      skill_version: policy.mixed_cutover.scheduled_task.skill_version,
      protocol_version: policy.mixed_cutover.scheduled_task.protocol_version,
      task_version: prepared ? "task-version-1" : "",
      binding_digest: prepared ? "9".repeat(64) : "",
      attestation_key_id:
        policy.mixed_cutover.scheduled_task.attestation_key_id,
      attestation_public_key_spki_sha256:
        policy.mixed_cutover.scheduled_task.attestation_public_key_spki_sha256,
      observed_at: prepared ? "2026-08-10T08:00:00.000Z" : ""
    },
    instance_inventory: {
      scraper_active_count: phase === "pre_activation" ? 0 : 1,
      alerter_mover_active_count: phase === "pre_activation" ? 0 : 1,
      browser_task_count: prepared ? 1 : 0,
      retired_generator_active_count: phase === "pre_cutover" ? 1 : 0,
      duplicate_role_or_task_count: 0,
      active_verification_copy_count: 0,
      observed_at: "2026-08-10T08:00:00.000Z"
    },
    backups: policy.mixed_cutover.evidence_contract.required_backup_kinds.map(
      (kind, index) => ({
        kind,
        reference: `private-backup-${index + 1}`,
        sha256: String(index + 1).padStart(64, "0"),
        readable: true,
        restore_identifier_verified: true
      })
    ),
    preflight: {
      duplicate_owner_count: 0,
      active_claim_count: 0,
      partial_unknown_move_count: 0,
      malformed_receipt_count: 0,
      unsupported_manual_action_count: 0,
      policy_or_schema_drift_count: 0,
      wrong_binding_count: 0,
      fresh_exact_reread: true,
      all_writers_frozen: true,
      passed: true,
      snapshot_digest: "5".repeat(64),
      ownership_digest: "6".repeat(64),
      store_row_counts: {
        "Scraped Jobs": 0,
        "To Review": 0,
        "To Apply": 0,
        "Applied Jobs": 0,
        Archive: 0
      },
      browser_state_counts: {
        legacy_blank: 0,
        queued: 0,
        claimed: 0,
        evaluating: 0,
        generating: 0,
        filling: 0,
        submit_started: 0,
        confirmed: 0,
        retryable: 0,
        ambiguous: 0,
        blocked: 0,
        unavailable: 0,
        skipped: 0
      },
      receipt_status_counts: {
        pending: 0,
        sending: 0,
        delivered: 0,
        reconciled: 0,
        retryable_rejection: 0,
        terminal_rejection: 0,
        terminal_ambiguity: 0
      },
      compatibility: structuredClone(policy.application_compatibility)
    },
    migration: {
      active_legacy_rows: 0,
      classified_rows: 0,
      executed_rows: 0,
      route_count: 0,
      rejected_rows: 0,
      duplicate_owner_count: 0,
      preserved_field_mismatch_count: 0,
      plan_digest: "7".repeat(64),
      copy_confirm_delete_only: true,
      no_manual_relocation: true
    },
    capability: {
      chrome_plugin_enabled: prepared,
      correct_profile: prepared,
      onlinejobs_allowlisted: prepared,
      signed_in_session_valid: prepared,
      local_project_selected: prepared,
      skill_invocation_verified: prepared,
      mock_sequence_passed: prepared,
      independent_attestation_adapter_verified: prepared,
      attestation_public_key_verified: prepared,
      unattended_submit_status: prepared ? "proven" : "not_tested",
      activation_allowed: prepared
    },
    activation: {
      order: [...policy.mixed_cutover.activation_order],
      retired_generator_inactive_before_browser: true,
      no_mixed_writer_window: true,
      completed: post
    },
    controls: policy.mixed_cutover.evidence_contract.required_control_cases.map(
      (caseId, index) => ({
        case_id: caseId,
        passed: prepared,
        evidence_reference: `control-${index + 1}`,
        result_digest: String(index + 1).padStart(64, "0"),
        observed_at: "2026-08-10T08:00:00.000Z"
      })
    ),
    rollback: {
      documented: true,
      verified_without_execution: true,
      disable_order: [...policy.mixed_cutover.rollback_disable_order],
      compatibility_limits_recorded: true,
      manual_row_relocation_required: false,
      prior_assets: [
        "n8n_scraper",
        "n8n_generator",
        "n8n_alerter_mover",
        "scheduled_browser_task",
        "application_policy",
        "pipeline_schema",
        "main_workbook",
        "configuration_workbook"
      ].map((kind, index) => ({
        kind,
        restore_id: `restore-${index + 1}`,
        version: `prior-${index + 1}`,
        sha256: String(index + 1).padStart(64, "0"),
        compatibility_verified: true
      }))
    },
    observations: post
      ? {
          started_at: "2026-08-10T08:00:00.000Z",
          completed_at: "2026-08-10T09:30:00.000Z",
          scheduled_run_ids: {
            scraper: "run-1",
            browser_executor: "run-2",
            alerter_mover: "run-3"
          },
          outcome_counts: {
            confirmed: 1,
            skipped: 1,
            blocked: 1,
            retryable: 1,
            ambiguous: 1,
            unavailable: 1
          },
          confirmation_digest_count: 1,
          duplicate_submission_count: 0,
          movement_recovery_count: 1,
          claim_recovery_count: 1,
          rollback_status: "not_triggered",
          retired_generator_run_count: 0
        }
      : {}
  };
}

test("empty exact reread produces a safe no-write migration plan", () => {
  const snapshot = {
    captured_at: "2026-08-10T08:00:00.000Z",
    contract_version: schema.storage_version,
    active_claims: [],
    stores: Object.fromEntries(schema.business_stores.map((store) => [store, []]))
  };
  assert.deepEqual(planAutonomousBrowserMigration(snapshot, schema), {
    schema_version: 1,
    contract_version: schema.storage_version,
    captured_at: snapshot.captured_at,
    ok: true,
    writes_allowed: false,
    manual_business_row_relocation_allowed: false,
    business_row_relocation_mode: "copy_confirm_delete_only",
    routes: [],
    rejects: [],
    counts: { examined: 0, active: 0, terminal: 0, planned: 0, rejected: 0 }
  });
});

test("migration planning fails closed on an active claim", () => {
  const snapshot = {
    captured_at: "2026-08-10T08:00:00.000Z",
    contract_version: schema.storage_version,
    active_claims: [
      {
        canonical_job_id: "job-1",
        expires_at: "2026-08-10T08:05:00.000Z"
      }
    ],
    stores: Object.fromEntries(schema.business_stores.map((store) => [store, []]))
  };
  const plan = planAutonomousBrowserMigration(snapshot, schema);
  assert.equal(plan.ok, false);
  assert.equal(plan.writes_allowed, false);
  assert.equal(plan.rejects[0].category, "active_claim");
});

test("migration dispositions never manufacture autonomous authority for legacy rows", () => {
  const legacy = { execution_mode: "legacy_manual", browser_state: "" };
  assert.equal(
    migrationDisposition("Scraped Jobs", {
      ...legacy,
      pipeline_status: "new",
      user_action: ""
    }, schema).disposition,
    "retain_legacy_manual"
  );
  assert.equal(
    migrationDisposition("Scraped Jobs", {
      ...legacy,
      pipeline_status: "skip",
      user_action: ""
    }, schema).disposition,
    "drain_legacy_scraped_route"
  );
  assert.equal(
    migrationDisposition("Scraped Jobs", {
      ...legacy,
      pipeline_status: "unavailable",
      source_availability: "active",
      error_category: "",
      error_summary: "",
      user_action: ""
    }, schema).disposition,
    "retain_legacy_manual"
  );
  for (const record of [
    {
      ...legacy,
      pipeline_status: "new",
      source_availability: "unavailable",
      user_action: ""
    },
    {
      ...legacy,
      pipeline_status: "error",
      source_availability: "active",
      error_summary: "Source returned HTTP 404 - gone",
      user_action: ""
    }
  ]) {
    assert.equal(
      migrationDisposition("Scraped Jobs", record, schema).disposition,
      "drain_legacy_source_unavailable"
    );
  }
  for (const action of ["Proceed", "Reject"]) {
    assert.equal(
      migrationDisposition("To Review", {
        ...legacy,
        pipeline_status: "review_needed",
        user_action: action
      }, schema).disposition,
      "drain_legacy_review_action"
    );
  }
  assert.equal(
    migrationDisposition("To Review", {
      ...legacy,
      pipeline_status: "review_needed",
      user_action: ""
    }, schema).disposition,
    "retain_legacy_review_blocked"
  );
  for (const action of ["I Applied", "Skip"]) {
    assert.equal(
      migrationDisposition("To Apply", {
        ...legacy,
        pipeline_status: "ready_to_apply",
        user_action: action
      }, schema).disposition,
      "drain_legacy_application_action"
    );
  }
  assert.equal(
    migrationDisposition("To Apply", {
      ...legacy,
      pipeline_status: "ready_to_apply",
      user_action: ""
    }, schema).disposition,
    "retain_legacy_manual"
  );
  assert.equal(
    migrationDisposition("Scraped Jobs", {
      execution_mode: "autonomous_chrome",
      browser_state: "queued",
      pipeline_status: "new",
      user_action: ""
    }, schema).disposition,
    "claim_for_autonomous_executor"
  );
});

test("pre-activation evidence proves paused task and unattended capability", () => {
  assert.deepEqual(
    validateAutonomousBrowserCutoverEvidence(
      policy,
      evidenceFor("pre_activation")
    ),
    []
  );
});

test("pre-cutover evidence records current legacy artifacts without claiming target digests", () => {
  const evidence = evidenceFor("pre_cutover");
  evidence.n8n_workflows[0].workflow_id = "current-scraper-id";
  evidence.n8n_workflows[0].artifact_digest = `sha256:${"3".repeat(64)}`;
  evidence.n8n_workflows[1].workflow_id = "current-alerter-id";
  evidence.n8n_workflows[1].artifact_digest = `sha256:${"4".repeat(64)}`;
  assert.deepEqual(validateAutonomousBrowserCutoverEvidence(policy, evidence), []);
});

test("post-activation evidence proves one observed mixed role set", () => {
  assert.deepEqual(
    validateAutonomousBrowserCutoverEvidence(
      policy,
      evidenceFor("post_activation")
    ),
    []
  );
});

test("cutover rejects reordered activation and rollback steps", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.activation.order.reverse();
  evidence.rollback.disable_order.reverse();
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /activation order|rollback evidence/
  );
});

test("cutover rejects confirmation blockers, failed controls, and private payloads", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.capability.unattended_submit_status = "blocked_confirmation";
  evidence.capability.activation_allowed = false;
  evidence.controls[0].passed = false;
  evidence.private_debug = { generated_message: "must not be committed" };
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /private or secret material|unattended submit capability|every pre-activation/
  );
});

test("cutover rejects an active Generator and stale browser task digest", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.retired_generator.active = true;
  evidence.scheduled_task.artifact_digest = `sha256:${"0".repeat(64)}`;
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /retired Generator state|scheduled browser task compatibility/
  );
});

test("cutover rejects fabricated controls, blank runs, duplicates, and incomplete rollback", () => {
  const evidence = evidenceFor("post_activation");
  evidence.controls[0].evidence_reference = "";
  evidence.controls[1].result_digest = "not-a-digest";
  evidence.observations.scheduled_run_ids.browser_executor = "";
  evidence.instance_inventory.duplicate_role_or_task_count = 1;
  evidence.migration.plan_digest = "";
  evidence.rollback.prior_assets.pop();
  evidence.n8n_workflows[0].workflow_version = "";
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /control .* incomplete|scheduled observation|inventory|migration|rollback prior assets|runtime evidence/
  );
});

test("cutover evidence observations cannot occur after capture", () => {
  const evidence = evidenceFor("post_activation");
  evidence.captured_at = "2026-08-10T09:00:00.000Z";
  evidence.controls[0].observed_at = "2026-08-10T09:40:00.000Z";
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /control .* incomplete|scheduled observation/
  );
});

test("cutover evidence rejects unknown private fields and path-shaped backup references", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.private_debug = {
    payload: "John's full cover letter and confidential screening answer"
  };
  evidence.backups[0].reference = "/private/backup/workbook.json";
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /unsupported fields|not restore-ready/
  );
});

test("cutover rejects identifiers with valid prefixes plus hidden payloads", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.backups[0].reference = `${"a".repeat(160)} private payload`;
  evidence.scheduled_task.task_id = "scheduled-browser-task-1 private payload";
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /not restore-ready|task ID is missing/
  );
});

test("cutover requires frozen store and browser-state counts to reconcile", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.preflight.browser_state_counts.confirmed = 5;
  assert.match(
    validateAutonomousBrowserCutoverEvidence(policy, evidence).join(";"),
    /row totals must match/
  );
});
