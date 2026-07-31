import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  captureWorkflowCutoverEvidence,
  validateWorkflowCutoverEvidence,
  validateWorkflowCutoverPolicy
} from "../src/workflow-cutover.mjs";

const policy = JSON.parse(
  await readFile(
    new URL("../config/n8n-deployment-policy.json", import.meta.url)
  )
);
const roleWorkflows = [
  {
    id: "scraper-new",
    name: "(Scraper) Job Pipeline - Rolling 24-Hour Keywords",
    active: false,
    nodes: [
      "Get Search Keywords",
      "Capture Fixed Window and Keywords",
      "Append New Review Queue Rows"
    ],
    spreadsheet_id: "new-book"
  },
  {
    id: "generator-new",
    name: "(Evaluator & Generator) Job Pipeline - Safe Routing",
    active: false,
    nodes: [
      "Evaluate and Prepare Application",
      "Guard and Commit Generator Result"
    ],
    spreadsheet_id: "new-book"
  },
  {
    id: "mover-new",
    name: "(Alerter & Mover) Job Pipeline - Slack and Terminal Moves",
    active: false,
    nodes: [
      "Plan Independent Moves",
      "Send Slack Alert",
      "Delete Confirmed Review Queue Rows"
    ],
    spreadsheet_id: "new-book"
  },
  {
    id: "reviewer-old",
    name: "(Reviewer) Job Application Pipeline - Review Actions and Outcomes",
    active: false,
    nodes: [],
    spreadsheet_id: "old-book"
  }
];

const trueSmoke = {
  blank_setup_zero_rows: true,
  setup_rerun_idempotent: true,
  no_old_row_import: true,
  fixed_window_single_clock: true,
  window_start_inclusive: true,
  window_end_inclusive: true,
  old_listing_excluded: true,
  future_listing_excluded: true,
  missing_timestamp_excluded: true,
  unique_and_duplicate_discovery: true,
  ready_route: true,
  review_needed_route: true,
  approval_route: true,
  denial_move: true,
  automatic_skip_move: true,
  user_skip_move: true,
  i_applied_move: true,
  empty_queues: true,
  source_page_failure: true,
  provider_failure: true,
  stale_action: true,
  destination_write_failure: true,
  source_delete_failure: true,
  slack_rejection: true,
  slack_timeout: true,
  repeated_scheduler_runs: true,
  safe_recovery: true,
  slack_copy_fidelity: true,
  links_open_only: true,
  no_automatic_submission: true,
  secret_scan_clean: true
};
const trueObservations = {
  no_out_of_window_jobs: true,
  no_duplicate_jobs: true,
  no_duplicate_alerts: true,
  no_duplicate_applied_rows: true,
  no_duplicate_archive_rows: true,
  no_stuck_claims: true,
  no_old_workbook_writes: true,
  old_workbook_unchanged: true
};

function evidence(phase = "pre_activation") {
  return {
    schema_version: 2,
    policy_version: policy.policy_version,
    phase,
    captured_at: "2026-07-31T12:00:00.000Z",
    inventory_scope: "instance_wide",
    inventory_complete: true,
    workflows: roleWorkflows.map((workflow) => ({
      ...workflow,
      active: phase === "post_activation"
        ? workflow.id.endsWith("-new")
        : false
    })),
    target_workflow_ids: {
      scraper: "scraper-new",
      evaluator_generator: "generator-new",
      alerter_mover: "mover-new"
    },
    fresh_workbook: {
      id: "new-book",
      verified_empty_before_activation: true,
      setup_runs: 2,
      old_rows_imported: false,
      initial_data_rows: {
        "Review Queue": 0,
        "Applied Jobs": 0,
        Archive: 0
      }
    },
    old_workbook: {
      id: "old-book",
      backup_id: "old-book-backup-20260731",
      retained: true,
      active_binding_count: 0
    },
    workflow_backup: {
      reference: "encrypted-backup/workflows-20260731",
      complete: true
    },
    smoke: { ...trueSmoke },
    observations: { ...trueObservations },
    rollback: {
      documented: true,
      verified: true,
      prior_workflow_ids: ["scraper-old", "generator-old", "reviewer-old"],
      old_workbook_id: "old-book"
    }
  };
}

test("cutover policy and complete pre/post evidence accept exactly three roles", () => {
  assert.deepEqual(validateWorkflowCutoverPolicy(policy), []);
  assert.deepEqual(
    validateWorkflowCutoverEvidence(policy, evidence("pre_activation")),
    []
  );
  assert.deepEqual(
    validateWorkflowCutoverEvidence(policy, evidence("post_activation")),
    []
  );
});

test("missing, duplicate, old-active, wrong-workbook, and mixed inventories fail", () => {
  const cases = [
    (() => {
      const value = evidence();
      value.workflows = value.workflows.filter(
        (workflow) => workflow.id !== "mover-new"
      );
      return value;
    })(),
    (() => {
      const value = evidence();
      value.target_workflow_ids.alerter_mover = "generator-new";
      return value;
    })(),
    (() => {
      const value = evidence();
      value.workflows.find((workflow) => workflow.id === "reviewer-old").active = true;
      return value;
    })(),
    (() => {
      const value = evidence();
      value.workflows[0].spreadsheet_id = "old-book";
      return value;
    })(),
    (() => {
      const value = evidence("post_activation");
      value.workflows[1].active = false;
      return value;
    })()
  ];
  for (const value of cases) {
    assert.ok(validateWorkflowCutoverEvidence(policy, value).length > 0);
  }
});

test("fresh workbook, smoke, rollback, and secret evidence are mandatory", () => {
  const value = evidence();
  value.fresh_workbook.initial_data_rows.Archive = 1;
  value.smoke.source_delete_failure = false;
  value.rollback.verified = false;
  value.notes = "Authorization: Bearer leaked-token";
  const errors = validateWorkflowCutoverEvidence(policy, value).join(";");
  assert.match(errors, /zero initial rows/);
  assert.match(errors, /source_delete_failure/);
  assert.match(errors, /rollback/);
  assert.match(errors, /sensitive/);
});

test("capture paginates and stores only sanitized inventory fields", async () => {
  const pages = [
    {
      data: roleWorkflows.slice(0, 2).map((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((name) => ({
          name,
          parameters: { authorization: "must-not-be-captured" }
        }))
      })),
      nextCursor: "page-2"
    },
    {
      data: roleWorkflows.slice(2).map((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((name) => ({ name }))
      })),
      nextCursor: ""
    }
  ];
  let request = 0;
  const captured = await captureWorkflowCutoverEvidence({
    policy,
    phase: "pre_activation",
    apiBaseUrl: "https://n8n.example/api/v1",
    apiKey: "private-key",
    targetMap: {
      target_workflow_ids: evidence().target_workflow_ids,
      workflow_bindings: Object.fromEntries(
        roleWorkflows.map((workflow) => [
          workflow.id,
          { spreadsheet_id: workflow.spreadsheet_id }
        ])
      ),
      fresh_workbook: evidence().fresh_workbook,
      old_workbook: evidence().old_workbook,
      workflow_backup: evidence().workflow_backup,
      smoke: trueSmoke,
      observations: trueObservations,
      rollback: evidence().rollback
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => pages[request++]
    })
  });
  assert.equal(request, 2);
  assert.deepEqual(
    captured.workflows[0].nodes,
    roleWorkflows[0].nodes
  );
  assert.doesNotMatch(JSON.stringify(captured), /must-not-be-captured|private-key/);
  assert.deepEqual(
    validateWorkflowCutoverEvidence(policy, captured),
    []
  );
});
