import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateSegmentedQueueCutoverEvidence } from "../src/segmented-queue-cutover.mjs";

const [schema, review] = await Promise.all(
  ["../config/pipeline-schema.json", "../config/review-sheet.json"].map(
    async (path) => JSON.parse(await readFile(new URL(path, import.meta.url)))
  )
);

const fullSha = "a".repeat(40);
const fullHash = "b".repeat(64);

function validEvidence(phase = "post_activation") {
  return {
    schema_version: 1,
    contract_version: schema.storage_version,
    phase,
    captured_at: "2026-07-31T12:00:00.000Z",
    environment: "production",
    privacy: {
      sanitized: true,
      secret_scan_clean: true,
      credentials_included: false,
      private_job_content_included: false,
      complete_sheet_rows_included: false
    },
    release: {
      issue_55_commit: fullSha,
      issue_56_commit: fullSha,
      issue_57_commit: fullSha,
      commits_reviewed: true,
      build_passed: true,
      artifact_drift_clean: true,
      configuration_valid: true,
      full_suite_passed: true
    },
    backups: {
      workbook_reference: "encrypted-backup/workbook",
      workflow_reference: "encrypted-backup/workflows",
      workbook_sha256: fullHash,
      workflow_sha256: fullHash,
      workbook_restore_verified: true,
      workflow_restore_verified: true
    },
    disposable: {
      visible_sheets: [
        "Scraped Jobs",
        "To Review",
        "To Apply",
        "Applied Jobs",
        "Archive",
        "Search Keywords"
      ],
      hidden_sheets: ["_System"],
      business_headers_exact: true,
      queue_dropdowns_exact: true,
      search_keywords_preserved: true,
      setup_rerun_idempotent: true,
      planner_repeat_equal: true,
      unsafe_planner_rejected: true,
      inactive_workflow_smoke_passed: true
    },
    quiet_window: {
      verified: true,
      running_or_waiting_executions: 0,
      unexpired_claims: 0
    },
    production: {
      visible_sheets: [
        "Scraped Jobs",
        "To Review",
        "To Apply",
        "Applied Jobs",
        "Archive",
        "Search Keywords"
      ],
      hidden_sheets: ["_System"],
      legacy_review_queue_present: false,
      pre_cutover_identity_count: 42,
      post_cutover_identity_count: 42,
      unique_post_cutover_identity_count: 42,
      legacy_source_identity_count: 30,
      planned_destination_counts: {
        "Scraped Jobs": 10,
        "To Review": 8,
        "To Apply": 7,
        "Applied Jobs": 0,
        Archive: 5
      },
      duplicate_identity_count: 0,
      unexplained_loss_count: 0,
      applied_jobs_preserved: true,
      archive_preserved: true,
      search_keywords_preserved: true,
      audit_fields_preserved: true,
      system_evidence_reconciled: true,
      route_counts_reconciled: true,
      state_action_counts_reconciled: true
    },
    workflows: [
      "scraper",
      "evaluator_generator",
      "alerter_mover"
    ].map((role) => ({
      role,
      id: `${role}-production-id`,
      updated_in_place: true,
      contract_version: schema.storage_version,
      configuration_preserved: true,
      role_signature_validated: true,
      artifact_sha256: fullHash,
      active: phase === "post_activation"
    })),
    routes: Object.fromEntries(
      [
        "new_scrape_to_scraped_jobs",
        "rediscovery_preserves_active_owner",
        "generator_reads_scraped_jobs_only",
        "review_needed_to_to_review",
        "ready_to_apply_to_to_apply",
        "automatic_skip_to_archive",
        "approve_to_scraped_jobs",
        "deny_to_archive",
        "i_applied_to_applied_jobs",
        "user_skip_to_archive",
        "invalid_combinations_fail_closed",
        "partial_destination_recovery",
        "ready_alert_from_to_apply_only",
        "ready_alert_idempotent",
        "to_apply_deep_link_verified",
        "no_automatic_submission"
      ].map((name) => [name, true])
    ),
    post_cutover: {
      leaked_claim_count: 0,
      unexplained_failure_count: 0,
      observed_schedule_boundaries: phase === "post_activation" ? 3 : 0,
      workflow_execution_ids:
        phase === "post_activation" ? ["scraper-1", "generator-1", "mover-1"] : [],
      known_deviations: []
    },
    rollback: {
      documented: true,
      rehearsal_verified: true,
      workbook_and_workflows_restored_together: true,
      mutually_compatible_restore: true
    }
  };
}

test("segmented cutover accepts complete sanitized pre/post activation evidence", () => {
  assert.deepEqual(
    validateSegmentedQueueCutoverEvidence(
      schema,
      review,
      validEvidence("pre_activation")
    ),
    []
  );
  assert.deepEqual(
    validateSegmentedQueueCutoverEvidence(
      schema,
      review,
      validEvidence("post_activation")
    ),
    []
  );
});

test("segmented cutover rejects loss, mixed activation, incomplete routes, and secrets", () => {
  const evidence = validEvidence();
  evidence.production.post_cutover_identity_count = 41;
  evidence.workflows[0].active = false;
  evidence.routes.approve_to_scraped_jobs = false;
  evidence.notes = "Authorization: Bearer leaked-token";
  const errors = validateSegmentedQueueCutoverEvidence(
    schema,
    review,
    evidence
  ).join(";");
  assert.match(errors, /zero loss and duplication/);
  assert.match(errors, /scraper active state/);
  assert.match(errors, /routes\.approve_to_scraped_jobs/);
  assert.match(errors, /sensitive material/);
});

test("segmented cutover rejects stale contract, wrong tabs, live work, and incomplete rollback", () => {
  const evidence = validEvidence("pre_activation");
  evidence.contract_version = "stale";
  evidence.disposable.visible_sheets = ["Review Queue"];
  evidence.quiet_window.unexpired_claims = 1;
  evidence.rollback.mutually_compatible_restore = false;
  const errors = validateSegmentedQueueCutoverEvidence(
    schema,
    review,
    evidence
  ).join(";");
  assert.match(errors, /contract_version is stale/);
  assert.match(errors, /disposable workbook sheet contract/);
  assert.match(errors, /quiet window/);
  assert.match(errors, /rollback\.mutually_compatible_restore/);
});
