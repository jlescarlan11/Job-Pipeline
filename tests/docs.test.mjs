import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const loadJson = async (path) => JSON.parse(await loadText(path));

const [
  readme,
  architecture,
  dataContract,
  sheetSchema,
  operations,
  deployment,
  alerts,
  acceptance,
  searchKeywordsLedger,
  generatorBatchVerification,
  productionPredeploymentBaseline,
  productionDeploymentVerification,
  schema,
  searchPlan,
  runtime,
  review,
  alertPolicy,
  deploymentPolicy
] = await Promise.all([
  loadText("../README.md"),
  loadText("../docs/architecture.md"),
  loadText("../docs/data-contract.md"),
  loadText("../docs/sheet-schema.md"),
  loadText("../docs/operations.md"),
  loadText("../docs/n8n-deployment.md"),
  loadText("../docs/alerts.md"),
  loadText("../docs/acceptance-matrix.md"),
  loadText("../docs/search-keywords-change-ledger-2026-07-31.md"),
  loadText("../docs/generator-batch-verification-2026-07-31.md"),
  loadJson(
    "../outputs/generator-batch-20260731/production-predeployment-baseline.json"
  ),
  loadJson(
    "../outputs/generator-batch-20260731/production-deployment-verification.json"
  ),
  loadJson("../config/pipeline-schema.json"),
  loadJson("../config/search-plan.json"),
  loadJson("../config/runtime.json"),
  loadJson("../config/review-sheet.json"),
  loadJson("../config/alert-policy.json"),
  loadJson("../config/n8n-deployment-policy.json")
]);

const visibleSheets = Object.values(review.sheets)
  .filter((sheet) => sheet.visible)
  .map((sheet) => sheet.name);

test("primary docs describe the exact simplified workflow and manual boundary", () => {
  for (const document of [readme, architecture, operations, deployment]) {
    assert.match(document, /Scraper/i);
    assert.match(document, /Evaluator\s*&\s*Generator|Evaluator and Generator/i);
    assert.match(document, /Alerter\s*&\s*Mover|Alerter and Mover/i);
    assert.match(document, /Review Queue/i);
  }
  for (const document of [readme, architecture, operations]) {
    assert.match(document, /manual/i);
    assert.match(
      document,
      /never (?:submitted|submits?)|no (?:step|workflow) (?:authorizes|submits?)[\s\S]{0,30}application/i
    );
  }
  assert.match(readme, /exactly three workflow exports|all three workflow exports/i);
  assert.match(architecture, /exactly three/i);
});

test("docs match all schedules, timeouts, and the Manila timezone", () => {
  const configs = [runtime.scraper, runtime.generator, runtime.alerter_mover];
  for (const document of [architecture, operations, deployment]) {
    assert.match(document, new RegExp(runtime.timezone, "i"));
    for (const config of configs) {
      assert.match(
        document,
        new RegExp(`${config.schedule_minutes}(?:[-\\s]minutes?|\\s+min\\b)`, "i")
      );
      assert.match(
        document,
        new RegExp(`${config.execution_timeout_seconds}(?:[- ]seconds?|\\s+s\\b)`, "i")
      );
    }
  }
  assert.equal(searchPlan.schedule_minutes, runtime.scraper.schedule_minutes);
  assert.equal(alertPolicy.schedule_minutes, runtime.alerter_mover.schedule_minutes);
});

test("Sheet docs cover every store, field, status, action, and terminal reason", () => {
  for (const name of [...visibleSheets, review.sheets.system.name]) {
    assert.match(sheetSchema, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const field of schema.fields) {
    assert.match(sheetSchema, new RegExp(`\\\`${field}\\\``), `missing field: ${field}`);
  }
  for (const status of schema.pipeline_statuses) {
    assert.match(
      `${dataContract}\n${sheetSchema}`,
      new RegExp(`\\b${status}\\b`),
      `missing status: ${status}`
    );
  }
  for (const action of schema.user_actions.filter(Boolean)) {
    assert.match(
      `${dataContract}\n${sheetSchema}`,
      new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `missing action: ${action}`
    );
  }
  for (const reason of schema.archive_reasons) {
    assert.match(dataContract, new RegExp(`\\b${reason}\\b`));
  }
});

test("fresh-start documentation is explicit and preserves the old workbook", () => {
  for (const document of [readme, architecture, operations]) {
    assert.match(document, /fresh|new workbook/i);
    assert.match(document, /old workbook/i);
    assert.match(document, /(?:never|no|does not)[\s\S]{0,100}import/i);
  }
  for (const name of visibleSheets) {
    assert.match(operations, new RegExp(name));
  }
  assert.match(operations, /run setup a second time/i);
  assert.match(operations, /zero data rows/i);
  assert.match(operations, /non-empty unexpected sheet/i);
});

test("runbook contains the release, observation, Slack, and rollback gates", () => {
  for (const required of [
    "Freeze and back up",
    "blank non-production workbook",
    "Import replacements inactive",
    "Non-production smoke matrix",
    "issue #22 evidence gate",
    "blank production workbook",
    "Pre-activation inventory gate",
    "Activation",
    "Initial scheduled observation",
    "Rollback"
  ]) {
    assert.match(operations, new RegExp(required, "i"), `missing runbook gate: ${required}`);
  }
  assert.match(operations, /byte-for-byte/i);
  assert.match(operations, /exactly three recognized pipeline workflows/i);
  assert.match(operations, /Never run old and replacement workflows/i);
  assert.match(operations, /live provider acceptance is not satisfied by unit tests alone/i);
});

test("deployment docs and policy agree on capacity, retention, and bindings", () => {
  assert.match(
    deployment,
    new RegExp(
      `concurrency[^\\n]*${deploymentPolicy.capacity.production_concurrency_limit}`,
      "i"
    )
  );
  assert.match(
    deployment,
    new RegExp(`${deploymentPolicy.execution_retention.maximum_age_hours}\\s+hours`, "i")
  );
  assert.match(
    deployment,
    new RegExp(
      deploymentPolicy.workbook_binding.spreadsheet_environment_variable.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      )
    )
  );
  assert.match(architecture, /concurrency limit of three/i);
  assert.match(operations, /JOB_PIPELINE_SPREADSHEET_ID/);
  assert.match(deployment, /complete instance-wide inventory/i);
  assert.match(deployment, /unrecognized|duplicate/i);
  assert.match(deployment, /policy-only/i);
});

test("Generator batch docs cover the five-job runtime, provider envelope, and production gate", () => {
  for (const document of [
    readme,
    architecture,
    operations,
    deployment,
    generatorBatchVerification
  ]) {
    assert.match(document, /five|5/);
    assert.match(document, /sequential/i);
  }
  assert.match(generatorBatchVerification, /17 trigger boundaries/i);
  assert.match(generatorBatchVerification, /170\s+logical requests/i);
  assert.match(generatorBatchVerification, /189 seconds/i);
  assert.match(generatorBatchVerification, /289 seconds/i);
  assert.match(generatorBatchVerification, /openai\/gpt-oss-120b/);
  assert.match(generatorBatchVerification, /openai\/gpt-oss-20b/);
  assert.match(generatorBatchVerification, /sixth untouched/i);
  assert.match(generatorBatchVerification, /groq-live-benchmark\.json/i);
  assert.match(generatorBatchVerification, /groq-permission-validation\.json/i);
  assert.match(generatorBatchVerification, /n8n-import-validation\.json/i);
  assert.match(
    generatorBatchVerification,
    /production-predeployment-baseline\.json/i
  );
  assert.match(
    generatorBatchVerification,
    /production-deployment-verification\.json/i
  );
  assert.match(generatorBatchVerification, /execution\s+`6636`/i);
  assert.match(generatorBatchVerification, /present on\s+`main`/i);
  for (const issue of [47, 48, 49]) {
    assert.match(acceptance, new RegExp(`Issue #${issue}`));
  }
});

test("Search Keywords acceptance accounting and high-assurance lanes are complete", () => {
  for (const issue of [51, 52]) {
    assert.match(acceptance, new RegExp(`Issue #${issue}`));
  }
  for (const criterionCount of [
    ["51", 14],
    ["52", 21]
  ]) {
    const [issue, count] = criterionCount;
    for (let index = 1; index <= count; index += 1) {
      assert.match(
        acceptance,
        new RegExp(
          `${issue}-AC-${String(index).padStart(2, "0")}[^\\n]+SATISFIED`
        )
      );
    }
  }
  assert.match(searchKeywordsLedger, /Lane A[\s\S]*PASS/);
  assert.match(searchKeywordsLedger, /Lane B[\s\S]*PASS/);
  assert.doesNotMatch(
    searchKeywordsLedger,
    /\|\s*(?:UNREVIEWED|FINDING_RECORDED|FIXED_REQUIRES_REREVIEW)\s*\|/
  );
});

test("production evidence is sanitized, bounded, and rollback-ready", () => {
  assert.equal(productionPredeploymentBaseline.capture_mode, "read_only");
  assert.equal(productionPredeploymentBaseline.production_mutation, false);
  assert.equal(productionPredeploymentBaseline.credentials_included, false);
  assert.equal(
    productionPredeploymentBaseline.private_job_content_included,
    false
  );
  assert.deepEqual(
    new Set(
      productionPredeploymentBaseline.active_workflow_inventory.map(
        (workflow) => workflow.role
      )
    ),
    new Set(["scraper", "evaluator_generator", "alerter_mover"])
  );
  assert.ok(
    productionPredeploymentBaseline.active_workflow_inventory.every(
      (workflow) => workflow.active === true
    )
  );
  assert.equal(
    productionPredeploymentBaseline.generator_before_deployment.id,
    "TRUqD9atneyDyMNx"
  );
  assert.equal(
    productionPredeploymentBaseline.generator_before_deployment
      .running_or_waiting_executions,
    0
  );
  assert.deepEqual(
    productionPredeploymentBaseline.workbook.sheets.map(
      ({ title, data_row_count: count }) => [title, count]
    ),
    [
      ["Review Queue", 7],
      ["Applied Jobs", 0],
      ["Archive", 5],
      ["_System", 0]
    ]
  );
  const candidates =
    productionPredeploymentBaseline.generator_smoke_candidates_in_selection_order;
  assert.equal(candidates.length, 7);
  assert.deepEqual(
    candidates.slice(0, 5).map((candidate) => candidate.intended_role),
    ["selected_1", "selected_2", "selected_3", "selected_4", "selected_5"]
  );
  assert.equal(candidates[5].intended_role, "sixth_control");
  assert.ok(
    candidates.every(
      (candidate) =>
        candidate.pipeline_status === "new" &&
        candidate.record_version === 1 &&
        candidate.processing_token_present === false &&
        candidate.attempt_count === 0
    )
  );
  assert.match(
    productionPredeploymentBaseline.rollback.backup_sha256,
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    productionPredeploymentBaseline.rollback.backup_permissions,
    "0600"
  );
  assert.equal(
    productionPredeploymentBaseline.rollback.restore_sequence.length,
    4
  );

  assert.equal(productionDeploymentVerification.credentials_included, false);
  assert.equal(
    productionDeploymentVerification.private_job_content_included,
    false
  );
  assert.equal(productionDeploymentVerification.prompts_included, false);
  assert.equal(productionDeploymentVerification.model_responses_included, false);
  assert.equal(
    productionDeploymentVerification.application_messages_included,
    false
  );
  assert.equal(productionDeploymentVerification.submission_attempted, false);
  assert.equal(productionDeploymentVerification.apply_points_spent, 0);
  assert.equal(
    productionDeploymentVerification.deployment_source.deployed_commit,
    "d525cdc62808d7b0c7a7ff52de00cc0283feb138"
  );
  assert.match(
    productionDeploymentVerification.deployment_source.artifact_sha256,
    /^[a-f0-9]{64}$/
  );
  assert.deepEqual(
    {
      id: productionDeploymentVerification.deployment.workflow_id,
      active: productionDeploymentVerification.deployment.active,
      nodes: productionDeploymentVerification.deployment.node_count,
      cap:
        productionDeploymentVerification.deployment
          .maximum_items_per_execution,
      batch:
        productionDeploymentVerification.deployment.sequential_batch_size,
      pacing:
        productionDeploymentVerification.deployment.candidate_pacing_delay_ms,
      timeout:
        productionDeploymentVerification.deployment.execution_timeout_seconds
    },
    {
      id: "TRUqD9atneyDyMNx",
      active: true,
      nodes: 47,
      cap: 5,
      batch: 1,
      pacing: 20000,
      timeout: 480
    }
  );
  assert.equal(
    productionDeploymentVerification.deployment.active_pipeline_workflow_count,
    3
  );
  assert.equal(
    productionDeploymentVerification.deployment
      .deployed_export_matches_repository_artifact,
    true
  );
  assert.equal(
    productionDeploymentVerification.failed_gates_and_rollbacks.length,
    2
  );
  assert.ok(
    productionDeploymentVerification.failed_gates_and_rollbacks.every(
      (gate) => gate.rolled_back && gate.controlled_rows_restored
    )
  );
  const smoke = productionDeploymentVerification.successful_generator_smoke;
  assert.equal(smoke.selected_count, 5);
  assert.equal(smoke.selected_identities_in_order.length, 5);
  assert.equal(new Set(smoke.selected_identities_in_order).size, 5);
  assert.equal(smoke.distinct_claim_count, 5);
  assert.equal(smoke.guarded_result_update_count, 5);
  assert.equal(smoke.commit_verified_count, 5);
  assert.equal(smoke.sixth_control.mutated, false);
  assert.equal(smoke.sixth_control.pipeline_status, "new");
  assert.equal(smoke.provider_request_count, 0);
  assert.equal(smoke.duplicate_claim_count, 0);
  assert.equal(smoke.duplicate_result_update_count, 0);
  assert.equal(smoke.duplicate_application_message_count, 0);
  assert.equal(
    productionDeploymentVerification.failure_isolation_observation
      .next_item_claim_attempted,
    true
  );
  assert.equal(
    productionDeploymentVerification.failure_isolation_observation
      .batch_aborted_by_item_failure,
    false
  );
  const replay =
    productionDeploymentVerification.alerter_and_mover_verification
      .idempotency_replay;
  assert.deepEqual(
    [
      replay.business_row_write_count,
      replay.business_row_delete_count,
      replay.alert_claim_count,
      replay.slack_provider_call_count
    ],
    [0, 0, 0, 0]
  );
  const cleanup =
    productionDeploymentVerification.alerter_and_mover_verification
      .expired_claim_cleanup;
  assert.equal(cleanup.expired_claims_selected, 5);
  assert.equal(cleanup.expired_claim_delete_succeeded, true);
  assert.equal(cleanup.business_row_write_count, 0);
  assert.equal(cleanup.slack_provider_call_count, 0);
  const finalWorkbook = productionDeploymentVerification.final_workbook_state;
  assert.deepEqual(
    [
      finalWorkbook.review_queue.data_row_count,
      finalWorkbook.applied_jobs.data_row_count,
      finalWorkbook.archive.data_row_count,
      finalWorkbook.system_claims.data_row_count
    ],
    [1, 0, 11, 0]
  );
  assert.equal(finalWorkbook.archive.unique_identity_count, 11);
  assert.equal(finalWorkbook.review_queue.processing_token_present, false);
  assert.deepEqual(
    [
      productionDeploymentVerification.validation.tests_total,
      productionDeploymentVerification.validation.tests_passed,
      productionDeploymentVerification.validation.tests_intentional_skips,
      productionDeploymentVerification.validation.tests_failed
    ],
    [183, 171, 12, 0]
  );
});

test("alert docs preserve safe eligibility, fidelity, idempotency, and independence", () => {
  for (const required of [
    "ready_to_apply",
    "application_pack_status",
    "message_validation_status",
    "idempotency",
    "code block",
    "byte",
    "timeout",
    "movement"
  ]) {
    assert.match(alerts, new RegExp(required, "i"), `missing alert behavior: ${required}`);
  }
  assert.match(alerts, /does not submit|never submits/i);
  assert.match(alerts, /independent/i);
});

test("acceptance accounting covers every criterion and labels live gates honestly", () => {
  const expectedCounts = new Map([
    [39, 13],
    [40, 20],
    [41, 14],
    [42, 16],
    [43, 16],
    [44, 14],
    [45, 20],
    [47, 13],
    [48, 22],
    [49, 22]
  ]);
  for (const [issue, expected] of expectedCounts) {
    const start = acceptance.indexOf(`## Issue #${issue}`);
    const next = acceptance.indexOf("\n## Issue #", start + 1);
    const section = acceptance.slice(start, next === -1 ? undefined : next);
    assert.notEqual(start, -1, `missing issue #${issue}`);
    assert.equal(
      [...section.matchAll(/^\d+\.\s/mg)].length,
      expected,
      `issue #${issue} criterion count`
    );
  }
  assert.match(acceptance, /every Issue #45 live gate (?:is|are) completed/i);
  assert.match(acceptance, /authorized production cutover/i);
  assert.equal(
    [...acceptance.matchAll(/47-AC-\d+[^\n]*SATISFIED/g)].length,
    13
  );
  assert.equal(
    [...acceptance.matchAll(/48-AC-\d+[^\n]*SATISFIED/g)].length,
    22
  );
  const issue49Start = acceptance.indexOf("## Issue #49");
  const issue49Section = acceptance.slice(issue49Start);
  assert.equal(
    [...issue49Section.matchAll(/49-AC-\d+[^\n]*SATISFIED/g)].length,
    22
  );
  assert.doesNotMatch(issue49Section, /\b(?:BLOCKED|PARTIAL)\b/);
  assert.match(issue49Section, /final deployed source is commit/i);
});

test("completed cutover report records sanitized live evidence", async () => {
  const report = await loadText("../docs/cutover-2026-07-31.md");
  for (const required of [
    "exactly 3 active replacements",
    "rolling 24-hour",
    "04:08",
    "04:32",
    "04:44",
    "04:59",
    "automatic_skip",
    "zero webhook/API-key/authorization pattern hits",
    "No automatic application submission"
  ]) {
    assert.match(report, new RegExp(required, "i"), required);
  }
});

test("retired workflow documents and smoke snapshots are removed", async () => {
  const retired = [
    "../docs/analytics.md",
    "../docs/recommendations.md",
    "../docs/review-report.md",
    "../docs/smoke-test-2026-07-28.md",
    "../docs/smoke-test-2026-07-29-applied-jobs.md",
    "../docs/smoke-test-2026-07-30-generator-recovery.md",
    "../docs/smoke-test-2026-07-30-report-recovery.md"
  ];
  for (const path of retired) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});
