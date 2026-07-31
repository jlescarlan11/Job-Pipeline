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
  segmentedCutover,
  acceptance,
  searchKeywordsLedger,
  searchKeywordsPredeploymentBaseline,
  searchKeywordsNonproductionVerification,
  searchKeywordsProductionVerification,
  searchKeywordsVerificationReport,
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
  loadText("../docs/segmented-queue-cutover.md"),
  loadText("../docs/acceptance-matrix.md"),
  loadText("../docs/search-keywords-change-ledger-2026-07-31.md"),
  loadJson(
    "../outputs/search-keywords-20260731/production-predeployment-baseline.json"
  ),
  loadJson(
    "../outputs/search-keywords-20260731/nonproduction-verification.json"
  ),
  loadJson(
    "../outputs/search-keywords-20260731/production-deployment-verification.json"
  ),
  loadText("../docs/search-keywords-verification-2026-07-31.md"),
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
    assert.match(document, /Scraped Jobs/i);
    assert.match(document, /To Review/i);
    assert.match(document, /To Apply/i);
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

test("segmented cutover runbook preserves the no-deploy boundary and compatibility unit", () => {
  for (const required of [
    "Pin and validate the release",
    "Capture restorable backups",
    "Prove the migration in disposable systems",
    "Establish the quiet window",
    "Migrate the workbook",
    "Update workflows as one release unit",
    "Activate and observe",
    "Rollback as one compatibility unit",
    "Commit sanitized evidence"
  ]) {
    assert.match(segmentedCutover, new RegExp(required, "i"));
  }
  assert.match(segmentedCutover, /plan:segmented-queues/);
  assert.match(segmentedCutover, /validate:segmented-cutover/);
  assert.match(segmentedCutover, /has not mutated a production workbook/i);
  assert.match(segmentedCutover, /must not be committed/i);
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
  for (const issue of [51, 52, 53]) {
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
  const issue53Start = acceptance.indexOf("## Issue #53");
  const issue53End = acceptance.indexOf("## Issue #55", issue53Start);
  const issue53Section = acceptance.slice(issue53Start, issue53End);
  assert.equal(
    [...issue53Section.matchAll(/53-AC-\d+[^\n]+SATISFIED/g)].length,
    18
  );
  assert.equal(
    [
      ...issue53Section.matchAll(
        /53-AC-\d+[^\n]+NOT_APPLICABLE_WITH_EVIDENCE/g
      )
    ].length,
    1
  );
  assert.doesNotMatch(
    issue53Section,
    /\b(?:BLOCKED|PARTIAL|UNVERIFIED|PENDING)\b/
  );
  assert.match(searchKeywordsLedger, /Lane A[\s\S]*PASS/);
  assert.match(searchKeywordsLedger, /Lane B[\s\S]*PASS/);
  assert.doesNotMatch(
    searchKeywordsLedger,
    /\|\s*(?:UNREVIEWED|FINDING_RECORDED|FIXED_REQUIRES_REREVIEW)\s*\|/
  );
});

test("Search Keywords rollout baseline and non-production evidence are bounded", () => {
  assert.equal(searchKeywordsPredeploymentBaseline.capture_mode, "read_only");
  assert.equal(
    searchKeywordsPredeploymentBaseline.production_mutation,
    false
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.credentials_included,
    false
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.private_job_content_included,
    false
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.complete_sheet_rows_included,
    false
  );
  assert.deepEqual(
    new Set(
      searchKeywordsPredeploymentBaseline.active_workflow_inventory.map(
        (workflow) => workflow.role
      )
    ),
    new Set(["scraper", "evaluator_generator", "alerter_mover"])
  );
  assert.ok(
    searchKeywordsPredeploymentBaseline.active_workflow_inventory.every(
      (workflow) => workflow.active === true
    )
  );
  assert.deepEqual(
    {
      id: searchKeywordsPredeploymentBaseline.scraper_before_deployment.id,
      nodes:
        searchKeywordsPredeploymentBaseline.scraper_before_deployment
          .node_count,
      executions:
        searchKeywordsPredeploymentBaseline.scraper_before_deployment
          .running_or_waiting_executions
    },
    {
      id: "qxPbOzNs5StaPY8B",
      nodes: 25,
      executions: 0
    }
  );
  assert.deepEqual(
    searchKeywordsPredeploymentBaseline.workbook.sheets.map(
      ({ title, data_row_count: count }) => [title, count]
    ),
    [
      ["Review Queue", 3],
      ["Applied Jobs", 0],
      ["Archive", 12],
      ["_System", 3]
    ]
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.workbook.search_keywords_present,
    false
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.keyword_seed_source.seed_count,
    10
  );
  assert.match(
    searchKeywordsPredeploymentBaseline.keyword_seed_source.sha256,
    /^[a-f0-9]{64}$/
  );
  assert.match(
    searchKeywordsPredeploymentBaseline.rollback.backup_sha256,
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.rollback.backup_permissions,
    "0600"
  );
  assert.equal(
    searchKeywordsPredeploymentBaseline.retained_old_workbook
      .active_replacement_binding_count,
    0
  );

  assert.equal(
    searchKeywordsNonproductionVerification.credentials_included,
    false
  );
  assert.equal(
    searchKeywordsNonproductionVerification.private_job_content_included,
    false
  );
  assert.equal(
    searchKeywordsNonproductionVerification.submission_attempted,
    false
  );
  assert.equal(searchKeywordsNonproductionVerification.apply_points_spent, 0);
  assert.deepEqual(
    searchKeywordsNonproductionVerification.workbook.sheet_titles,
    [
      "Review Queue",
      "Applied Jobs",
      "Archive",
      "Search Keywords",
      "_System"
    ]
  );
  assert.equal(
    searchKeywordsNonproductionVerification.workbook.business_data_row_count,
    0
  );
  assert.equal(
    searchKeywordsNonproductionVerification.workbook.initial_seed_count,
    10
  );
  assert.equal(
    searchKeywordsNonproductionVerification.workbook
      .operator_values_preserved_on_setup_rerun,
    true
  );
  assert.deepEqual(
    {
      active: searchKeywordsNonproductionVerification.workflow.active,
      nodes: searchKeywordsNonproductionVerification.workflow.node_count,
      sheetNodes:
        searchKeywordsNonproductionVerification.workflow
          .google_sheets_node_count,
      seedHits:
        searchKeywordsNonproductionVerification.workflow
          .embedded_keyword_seed_hit_count,
      fallback: searchKeywordsNonproductionVerification.workflow
        .fallback_present,
      reimported:
        searchKeywordsNonproductionVerification.workflow
          .reimported_between_configuration_changes
    },
    {
      active: false,
      nodes: 26,
      sheetNodes: 9,
      seedHits: 0,
      fallback: false,
      reimported: false
    }
  );
  assert.deepEqual(
    searchKeywordsNonproductionVerification.valid_runtime_smokes.map(
      (smoke) => smoke.captured_keyword_count
    ),
    [2, 1]
  );
  assert.ok(
    searchKeywordsNonproductionVerification.valid_runtime_smokes.every(
      (smoke) =>
        smoke.unique_window_count === 1 &&
        smoke.source_request_attempted === true &&
        smoke.business_write_count === 0 &&
        smoke.claim_write_count === 0
    )
  );
  assert.equal(
    searchKeywordsNonproductionVerification.valid_runtime_smokes[1]
      .edited_keyword_observed,
    true
  );
  assert.deepEqual(
    new Set(
      searchKeywordsNonproductionVerification.invalid_configuration_matrix.map(
        ({ case: testCase }) => testCase
      )
    ),
    new Set([
      "normalized_duplicate",
      "enabled_blank",
      "malformed_enabled",
      "no_enabled_keywords",
      "missing_sheet_and_read_failure"
    ])
  );
  assert.ok(
    searchKeywordsNonproductionVerification.invalid_configuration_matrix.every(
      (testCase) =>
        testCase.source_request_output_count === 0 &&
        testCase.claim_write_count === 0 &&
        testCase.business_write_count === 0 &&
        testCase.bounded_error_categories.length > 0
    )
  );
});

test("Search Keywords production rollout evidence is complete and sanitized", () => {
  const evidence = searchKeywordsProductionVerification;
  assert.equal(evidence.capture_mode, "authorized_production_verification");
  for (const privateFlag of [
    "credentials_included",
    "private_job_content_included",
    "complete_sheet_rows_included",
    "prompts_included",
    "model_responses_included",
    "application_messages_included",
    "submission_attempted"
  ]) {
    assert.equal(evidence[privateFlag], false, privateFlag);
  }
  assert.equal(evidence.apply_points_spent, 0);
  assert.equal(
    evidence.deployment_source.deployed_commit,
    "56243802aaed8fb01a0e3bf83f773f1a881572a9"
  );
  assert.equal(
    evidence.deployment_source.normalized_repository_artifact_sha256,
    evidence.deployment_source.normalized_deployed_export_sha256
  );
  assert.deepEqual(
    {
      workflow: evidence.deployment.workflow_id,
      active: evidence.deployment.active,
      nodes: evidence.deployment.node_count,
      sheets: evidence.deployment.google_sheets_node_count,
      bound: evidence.deployment.all_google_sheets_nodes_credential_bound,
      seeds: evidence.deployment.embedded_keyword_seed_hit_count,
      fallback: evidence.deployment.fallback_present
    },
    {
      workflow: "qxPbOzNs5StaPY8B",
      active: true,
      nodes: 26,
      sheets: 9,
      bound: true,
      seeds: 0,
      fallback: false
    }
  );
  const scheduled = evidence.scheduled_scraper_observation;
  assert.deepEqual(
    {
      execution: scheduled.execution_id,
      mode: scheduled.mode,
      success: scheduled.trigger_success_delta,
      errors: scheduled.trigger_error_delta,
      keywords: scheduled.captured_keyword_count,
      windows: scheduled.unique_fixed_window_count,
      newRows: scheduled.new_review_row_count,
      rediscovered: scheduled.rediscovered_review_row_count,
      identities: scheduled.total_business_identity_count_after_scraper,
      unique: scheduled.unique_business_identity_count_after_scraper,
      duplicates: scheduled.cross_store_duplicate_count_after_scraper,
      outOfWindow: scheduled.out_of_window_new_row_count,
      submissions: scheduled.automatic_submission_count
    },
    {
      execution: 6673,
      mode: "trigger",
      success: 1,
      errors: 0,
      keywords: 14,
      windows: 1,
      newRows: 54,
      rediscovered: 1,
      identities: 69,
      unique: 69,
      duplicates: 0,
      outOfWindow: 0,
      submissions: 0
    }
  );
  assert.equal(scheduled.coverage_event_reached, true);
  assert.equal(scheduled.coverage_status_field_bounded, true);
  assert.ok(
    Date.parse(scheduled.new_row_posted_at_min) >=
      Date.parse(scheduled.fixed_window_start)
  );
  assert.ok(
    Date.parse(scheduled.new_row_posted_at_max) <=
      Date.parse(scheduled.fixed_window_end)
  );
  const claims = evidence.discovery_claim_verification;
  assert.deepEqual(
    [
      claims.claim_count,
      claims.unique_claim_key_count,
      claims.unique_identity_count,
      claims.unique_token_count,
      claims.execution_id_count,
      claims.stuck_discovery_claim_count
    ],
    [54, 54, 54, 54, 54, 0]
  );
  assert.ok(
    Date.parse(claims.observed_zero_discovery_claims_at) >
      Date.parse(claims.expires_at)
  );
  const downstream = evidence.downstream_compatibility;
  assert.deepEqual(
    {
      selected: downstream.generator_selected_count,
      processed: downstream.generator_processed_count,
      reviewNeeded: downstream.new_review_needed_count,
      skip: downstream.new_skip_count,
      stages: downstream.review_processing_stage_nonempty_count,
      tokens: downstream.review_processing_token_nonempty_count,
      attempts: downstream.review_attempt_count_nonzero_count,
      moved: downstream.skip_rows_moved_to_archive_count,
      review: downstream.review_row_count_after_movement,
      applied: downstream.applied_row_count_after_movement,
      archive: downstream.archive_row_count_after_movement,
      identities: downstream.total_business_identity_count_after_movement,
      unique: downstream.unique_business_identity_count_after_movement,
      duplicates: downstream.cross_store_duplicate_count_after_movement,
      temporaryClaims:
        downstream.temporary_downstream_claim_count_before_expiry_cleanup,
      cleanup: downstream.downstream_claim_cleanup_execution_id,
      stuckClaims: downstream.stuck_downstream_claim_count
    },
    {
      selected: 5,
      processed: 5,
      reviewNeeded: 1,
      skip: 4,
      stages: 0,
      tokens: 0,
      attempts: 0,
      moved: 4,
      review: 51,
      applied: 0,
      archive: 18,
      identities: 69,
      unique: 69,
      duplicates: 0,
      temporaryClaims: 5,
      cleanup: 6678,
      stuckClaims: 0
    }
  );
  assert.ok(
    Date.parse(downstream.observed_zero_system_claims_at) >
      Date.parse(downstream.downstream_claim_cleanup_started_at)
  );
  assert.deepEqual(
    new Set(evidence.final_active_workflow_inventory.map(({ role }) => role)),
    new Set(["scraper", "evaluator_generator", "alerter_mover"])
  );
  assert.ok(
    evidence.final_active_workflow_inventory.every(
      ({ active }) => active === true
    )
  );
  assert.deepEqual(
    [
      evidence.active_pipeline_workflow_count,
      evidence.active_google_sheets_node_count,
      evidence.active_google_sheets_credential_bound_node_count,
      evidence.active_old_workbook_literal_hit_count,
      evidence.final_running_or_waiting_pipeline_execution_count
    ],
    [3, 39, 39, 0, 0]
  );
  assert.equal(downstream.alerter_success_record_pruned_by_retention, true);
  assert.deepEqual(
    {
      health: evidence.final_runtime_capture.listener_health,
      keywords: evidence.final_runtime_capture.enabled_keyword_count,
      review: evidence.final_runtime_capture.review_row_count,
      fresh: evidence.final_runtime_capture.review_new_count,
      reviewNeeded: evidence.final_runtime_capture.review_needed_count,
      applied: evidence.final_runtime_capture.applied_row_count,
      archive: evidence.final_runtime_capture.archive_row_count,
      archivedSkip: evidence.final_runtime_capture.archive_skip_count,
      claims: evidence.final_runtime_capture.system_claim_count,
      identities:
        evidence.final_runtime_capture.total_business_identity_count,
      unique: evidence.final_runtime_capture.unique_business_identity_count,
      stages:
        evidence.final_runtime_capture
          .review_processing_stage_nonempty_count,
      tokens:
        evidence.final_runtime_capture
          .review_processing_token_nonempty_count,
      attempts:
        evidence.final_runtime_capture.review_attempt_count_nonzero_count
    },
    {
      health: "ok",
      keywords: 14,
      review: 51,
      fresh: 49,
      reviewNeeded: 2,
      applied: 0,
      archive: 18,
      archivedSkip: 18,
      claims: 0,
      identities: 69,
      unique: 69,
      stages: 0,
      tokens: 0,
      attempts: 0
    }
  );
  assert.equal(evidence.retained_old_workbook.unchanged, true);
  assert.equal(
    evidence.retained_old_workbook.modified_time_before,
    evidence.retained_old_workbook.modified_time_after
  );
  assert.equal(evidence.rollback.rollback_required, false);
  assert.equal(evidence.rollback.rollback_performed, false);
  assert.deepEqual(
    [
      evidence.validation.tests_total,
      evidence.validation.tests_passed,
      evidence.validation.tests_intentional_skips,
      evidence.validation.tests_failed
    ],
    [190, 178, 12, 0]
  );
  assert.match(searchKeywordsVerificationReport, /execution `6673`/);
  assert.match(searchKeywordsVerificationReport, /69 unique canonical/i);
  assert.match(searchKeywordsVerificationReport, /190 tests/i);
  assert.doesNotMatch(searchKeywordsVerificationReport, /\bpending\b/i);
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
    [49, 22],
    [51, 14],
    [52, 21],
    [53, 19]
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
  const issue49End = acceptance.indexOf("\n## Issue #", issue49Start + 1);
  const issue49Section = acceptance.slice(issue49Start, issue49End);
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
