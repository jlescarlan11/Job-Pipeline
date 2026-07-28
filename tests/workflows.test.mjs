import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const profile = await loadJson("../config/candidate-profile.json");
const policy = await loadJson("../config/application-policy.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const analyticsPolicy = await loadJson("../config/analytics-policy.json");
const recommendationPolicy = await loadJson(
  "../config/recommendation-policy.json"
);
const schema = await loadJson("../config/pipeline-schema.json");
const searchPlan = await loadJson("../config/search-plan.json");
const runtime = await loadJson("../config/runtime.json");
const review = await loadJson("../config/review-sheet.json");

const workflows = Object.fromEntries(
  await Promise.all(
    [
      "scraper",
      "generator",
      "archiver",
      "reviewer",
      "alerter",
      "analytics",
      "recommender"
    ].map(async (name) => [
      name,
      await loadJson(`../workflows/${name}.json`)
    ])
  )
);

const nodeByName = (workflow, name) => {
  const node = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(node, `missing node: ${name}`);
  return node;
};

function connectionTargets(workflow, sourceName) {
  const targets = [];
  for (const outputs of Object.values(workflow.connections[sourceName] ?? {})) {
    for (const branch of outputs) {
      for (const connection of branch ?? []) targets.push(connection.node);
    }
  }
  return targets;
}

function assertDirectConnection(workflow, source, target) {
  assert.ok(
    connectionTargets(workflow, source).includes(target),
    `expected ${source} to connect to ${target}`
  );
}

function compileCodeNode(node) {
  assert.doesNotThrow(
    () =>
      new Function(
        "$input",
        "$",
        "$items",
        "$execution",
        "$json",
        "$node",
        "$workflow",
        "$env",
        "$now",
        "$today",
        "$itemIndex",
        "$runIndex",
        "$binary",
        "$position",
        "$prevNode",
        "$parameter",
        "$response",
        "$evaluateExpression",
        "$getWorkflowStaticData",
        "$getPairedItem",
        "$getExecutionCancelSignal",
        `"use strict"; return (async () => { ${node.parameters.jsCode} })();`
      ),
    `${node.name} contains invalid JavaScript`
  );
}

test("all checked-in workflow exports are disabled, connected, and syntactically valid", () => {
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.equal(workflow.active, false, `${file} must import disabled`);
    assert.equal(workflow.settings.executionOrder, "v1");
    assert.ok(workflow.nodes.length > 0);

    const names = workflow.nodes.map((node) => node.name);
    const ids = workflow.nodes.map((node) => node.id);
    assert.equal(new Set(names).size, names.length, `${file} has duplicate node names`);
    assert.equal(new Set(ids).size, ids.length, `${file} has duplicate node ids`);

    for (const [source, outputTypes] of Object.entries(workflow.connections)) {
      assert.ok(names.includes(source), `${file} connection source is missing: ${source}`);
      for (const outputs of Object.values(outputTypes)) {
        for (const branch of outputs) {
          for (const connection of branch ?? []) {
            assert.ok(
              names.includes(connection.node),
              `${file} connection target is missing: ${connection.node}`
            );
          }
        }
      }
    }
    for (const node of workflow.nodes.filter((entry) => entry.type === "n8n-nodes-base.code")) {
      compileCodeNode(node);
    }
  }
});

test("workflow schedules, caps, pacing, retries, and versions match configuration", () => {
  const scraper = workflows.scraper;
  const generator = workflows.generator;
  const archiver = workflows.archiver;
  const reviewer = workflows.reviewer;
  const alerter = workflows.alerter;
  const analytics = workflows.analytics;
  const recommender = workflows.recommender;

  assert.equal(
    nodeByName(scraper, "Schedule Trigger").parameters.rule.interval[0].hoursInterval,
    searchPlan.schedule_hours
  );
  const searchFetch = nodeByName(scraper, "Fetch Search Page");
  assert.equal(
    searchFetch.parameters.options.batching.batch.batchInterval,
    searchPlan.request_interval_ms
  );
  assert.equal(searchFetch.parameters.options.timeout, searchPlan.request_timeout_ms);
  assert.equal(searchFetch.maxTries, searchPlan.retry.max_attempts);
  assert.equal(searchFetch.waitBetweenTries, searchPlan.retry.backoff_ms);

  assert.equal(
    nodeByName(generator, "Schedule Trigger").parameters.rule.interval[0].minutesInterval,
    runtime.generator.schedule_minutes
  );
  assert.equal(generator.meta.generatorPerRunCap, runtime.generator.per_run_cap);
  assert.equal(generator.meta.candidateProfileVersion, profile.profile_version);
  assert.equal(generator.meta.applicationPolicyVersion, policy.policy_version);
  assert.equal(generator.meta.rankingPolicyVersion, rankingPolicy.policy_version);
  assert.equal(
    generator.meta.applicationPackPolicyVersion,
    packPolicy.policy_version
  );
  assert.equal(generator.meta.applicationPackVersion, packPolicy.pack_version);
  const detailFetch = nodeByName(generator, "Fetch Job Detail");
  assert.equal(detailFetch.maxTries, runtime.generator.retry.max_attempts);
  assert.equal(detailFetch.waitBetweenTries, runtime.generator.request_retry_backoff_ms);
  assert.ok(
    detailFetch.waitBetweenTries * (detailFetch.maxTries - 1) <
      runtime.generator.claim_lease_ms,
    "in-node retry waits must remain shorter than the claim lease"
  );

  assert.equal(
    nodeByName(archiver, "Schedule Trigger").parameters.rule.interval[0].minutesInterval,
    runtime.archiver.schedule_minutes
  );
  assert.equal(
    nodeByName(reviewer, "Schedule Trigger").parameters.rule.interval[0].minutesInterval,
    review.schedule_minutes
  );
  assert.equal(
    nodeByName(alerter, "Schedule Trigger").parameters.rule.interval[0]
      .minutesInterval,
    alertPolicy.schedule_minutes
  );
  assert.equal(alerter.meta.alertPolicyVersion, alertPolicy.policy_version);
  assert.equal(alerter.meta.alertChannel, alertPolicy.channel);
  assert.equal(alerter.meta.alertPerRunCap, alertPolicy.per_run_cap);
  assert.equal(
    nodeByName(analytics, "Schedule Trigger").parameters.rule.interval[0]
      .hoursInterval,
    analyticsPolicy.schedule_hours
  );
  assert.equal(
    analytics.meta.metricDefinitionVersion,
    analyticsPolicy.metric_definition_version
  );
  assert.equal(
    analytics.meta.analyticsBandVersion,
    analyticsPolicy.band_version
  );
  assert.equal(
    nodeByName(recommender, "Schedule Trigger").parameters.rule.interval[0]
      .hoursInterval,
    recommendationPolicy.schedule_hours
  );
  assert.equal(
    recommender.meta.recommendationPolicyVersion,
    recommendationPolicy.policy_version
  );
  assert.equal(
    recommender.meta.requiredMetricDefinitionVersion,
    recommendationPolicy.required_metric_definition_version
  );
  assert.equal(recommender.meta.recommendationMode, "read_only_advisory");
  for (const workflow of Object.values(workflows)) {
    assert.equal(workflow.meta.pipelineSchemaVersion, schema.storage_version);
  }
});

test("discovery export retains bounded resume-driven coverage and active/archive deduplication", () => {
  const workflow = workflows.scraper;
  const loadPlan = nodeByName(workflow, "Load Search Plan").parameters.jsCode;
  const enabledQueries = searchPlan.queries.filter((query) => query.enabled);
  assert.equal(enabledQueries.length, 22);
  for (const query of enabledQueries) {
    assert.match(loadPlan, new RegExp(JSON.stringify(query.query).slice(1, -1)));
  }
  assert.match(
    loadPlan,
    new RegExp(`const requests = \\[`)
  );
  assert.match(loadPlan, new RegExp(`"page_number":${searchPlan.max_pages_per_query}`));
  assert.ok(nodeByName(workflow, "Get Active Rows").alwaysOutputData);
  assert.ok(nodeByName(workflow, "Get Archive Rows").alwaysOutputData);
  assert.equal(
    nodeByName(workflow, "Append Discovery Claims").parameters.sheetName.value,
    review.claims_sheet
  );
  assertDirectConnection(workflow, "Prepare New Jobs", "Append Discovery Claims");
  assertDirectConnection(workflow, "Get Processing Claims", "Keep Winning Discovery Claims");
  assertDirectConnection(workflow, "Prepare Discovery Inserts", "Append Discovered Jobs");
  assertDirectConnection(workflow, "Prepare Active Seen Updates", "Update Active Seen");
  assertDirectConnection(workflow, "Prepare Archive Seen Updates", "Update Archive Seen");
  assert.match(nodeByName(workflow, "Log Discovery Summary").parameters.jsCode, /coverage/);
});

test("generator export gates Groq behind evaluation, claim arbitration, and validation", () => {
  const workflow = workflows.generator;
  for (const requiredNode of [
    "Append Processing Claims",
    "Get Processing Claims",
    "Keep Winning Claims",
    "Fetch Job Detail",
    "Evaluate Job",
    "Prepare Application Pack",
    "AI Agent",
    "Validate Generated Message",
    "Commit Generation Result"
  ]) {
    nodeByName(workflow, requiredNode);
  }
  assert.equal(
    nodeByName(workflow, "Append Processing Claims").parameters.sheetName.value,
    review.claims_sheet
  );
  assert.deepEqual(
    nodeByName(workflow, "Mark Claimed Jobs").parameters.columns.matchingColumns,
    ["state_guard"]
  );
  assert.deepEqual(
    nodeByName(workflow, "Commit Generation Result").parameters.columns.matchingColumns,
    ["processing_token"]
  );
  assert.match(
    nodeByName(workflow, "Commit Generation Result").parameters.columns.value.processing_token,
    /processing_token/
  );
  assertDirectConnection(workflow, "Prepare Application Pack", "AI Agent");
  assertDirectConnection(workflow, "AI Agent", "Validate Generated Message");
  assertDirectConnection(workflow, "Validate Generated Message", "Commit Generation Result");
  assert.ok(
    workflow.nodes.every((node) => !/Clear (?:Evaluation|Generation) Claim/.test(node.name)),
    "a canonical-id cleanup write could erase a newer processing claim"
  );

  const systemMessage = nodeByName(workflow, "AI Agent").parameters.options.systemMessage;
  assert.match(systemMessage, /Pharmacy & Acute Care University/);
  assert.match(systemMessage, /johnlesterescarlan\.pro/);
  assert.match(systemMessage, /manual review/i);
  assert.doesNotMatch(systemMessage, /netlify|FireCheck|PriceCraft|HEALTH/);
  assert.equal(policy.manual_submission_required, true);
  const evaluationCode = nodeByName(workflow, "Evaluate Job").parameters.jsCode;
  assert.match(evaluationCode, /const RANKING_POLICY/);
  assert.match(
    evaluationCode,
    /evaluateJob\(record, PROFILE, RANKING_POLICY, now\)/
  );
  const evaluationCommit = nodeByName(
    workflow,
    "Commit Evaluation Result"
  ).parameters.columns.value;
  for (const field of [
    "qualification_score",
    "opportunity_score",
    "ranking_confidence",
    "apply_points_recommendation",
    "ranking_factors",
    "ranking_missing_signals",
    "requirement_gap_details",
    "scoring_policy_version"
  ]) {
    assert.ok(field in evaluationCommit, `evaluation commit is missing ${field}`);
  }
  const packCode = nodeByName(
    workflow,
    "Prepare Application Pack"
  ).parameters.jsCode;
  assert.match(packCode, /buildApplicationPack/);
  assert.match(packCode, /buildApplicationUserMessage\(record, pack\)/);
  const generationCode = nodeByName(
    workflow,
    "Validate Generated Message"
  ).parameters.jsCode;
  assert.match(generationCode, /const originalRecord = \$\('Keep Winning Claims'\)/);
  assert.match(generationCode, /applyGeneratedApplicationPack/);
  assert.match(generationCode, /queueAlertState\(generated, ALERT_POLICY, now\)/);
  assert.match(generationCode, /recordStageFailure\(originalRecord/);
  const generationCommit = nodeByName(
    workflow,
    "Commit Generation Result"
  ).parameters.columns.value;
  for (const field of [
    "application_instructions",
    "screening_questions",
    "selected_proof_refs",
    "application_warnings",
    "application_pack_status",
    "application_pack_version",
    "application_pack_profile_version",
    "application_pack_policy_version",
    "application_pack_generated_at"
  ]) {
    assert.ok(field in generationCommit, `generation commit is missing ${field}`);
  }
  for (const field of [
    "alert_status",
    "alert_channel",
    "alert_policy_version",
    "alert_idempotency_key",
    "alert_next_retry_at"
  ]) {
    assert.ok(field in generationCommit, `generation commit is missing ${field}`);
  }
  assert.ok(
    workflow.nodes.every(
      (node) =>
        !/submit application|auto.?apply/i.test(node.name) &&
        !/\/apply(?:\\b|\/)/i.test(String(node.parameters?.url ?? ""))
    ),
    "no workflow node may submit an application"
  );
});

test("alerter export claims, validates, sends, and commits without state-changing links", () => {
  const workflow = workflows.alerter;
  for (const requiredNode of [
    "Prepare Alert Candidates",
    "Append Alert Claims",
    "Get Processing Claims",
    "Keep Winning Alert Claims",
    "Mark Alert Attempts",
    "Prepare Alert Delivery",
    "Should Send Provider Alert",
    "Send Slack Alert",
    "Finalize Alert Delivery",
    "Commit Alert Result"
  ]) {
    nodeByName(workflow, requiredNode);
  }
  assert.equal(
    nodeByName(workflow, "Append Alert Claims").parameters.sheetName.value,
    review.claims_sheet
  );
  assert.deepEqual(
    nodeByName(workflow, "Mark Alert Attempts").parameters.columns.matchingColumns,
    ["state_guard"]
  );
  assert.ok(
    nodeByName(workflow, "Mark Alert Attempts").parameters.columns.value
      .alert_status
  );
  assert.deepEqual(
    nodeByName(workflow, "Commit Alert Result").parameters.columns.matchingColumns,
    ["processing_token"]
  );
  const prepare = nodeByName(
    workflow,
    "Prepare Alert Delivery"
  ).parameters.jsCode;
  assert.match(prepare, /validateAlertProviderConfiguration/);
  assert.match(prepare, /review_confirmation/);
  assert.match(prepare, /configuration_error/);
  assert.match(prepare, /\$\('Keep Winning Alert Claims'\)\.item\.json/);
  assert.doesNotMatch(prepare, /request_url/);
  const send = nodeByName(workflow, "Send Slack Alert");
  assert.equal(
    send.parameters.url,
    `={{ $env.${alertPolicy.environment.provider_webhook_url} }}`
  );
  assert.equal(send.parameters.options.timeout, alertPolicy.provider_timeout_ms);
  assert.equal(send.retryOnFail, false);
  assert.match(send.parameters.body, /alert_payload\.text/);
  assert.doesNotMatch(JSON.stringify(send), /hooks\.slack\.com\/services\//);
  const finalize = nodeByName(
    workflow,
    "Finalize Alert Delivery"
  ).parameters.jsCode;
  assert.match(finalize, /applyAlertProviderResult/);
  const finalizeRuntime = finalize.slice(finalize.lastIndexOf("const POLICY ="));
  assert.doesNotMatch(
    finalizeRuntime,
    /job_description|generated_message|application_prompt/
  );
  assert.ok(
    workflow.nodes.every(
      (node) =>
        !/submit application|auto.?apply|spend.*points/i.test(node.name) &&
        !/\/apply(?:\b|\/)/i.test(String(node.parameters?.url ?? ""))
    )
  );
});

test("archiver export upserts by identity and confirms the copy before bottom-up deletion", () => {
  const workflow = workflows.archiver;
  const upsert = nodeByName(workflow, "Upsert Archive Records");
  const deleteRows = nodeByName(workflow, "Delete Confirmed Active Rows");
  assert.equal(upsert.parameters.operation, "appendOrUpdate");
  assert.deepEqual(upsert.parameters.columns.matchingColumns, ["canonical_job_id"]);
  assert.equal(deleteRows.parameters.operation, "delete");
  assert.match(deleteRows.parameters.startIndex, /row_number/);
  assertDirectConnection(workflow, "Upsert Archive Records", "Aggregate Archive Upserts");
  assertDirectConnection(workflow, "Aggregate Archive Upserts", "Get Archive After Upsert");
  assertDirectConnection(workflow, "Get Active Before Delete", "Confirm Archive Deletions");
  assertDirectConnection(workflow, "Confirm Archive Deletions", "Delete Confirmed Active Rows");
  assert.doesNotMatch(
    nodeByName(workflow, "Prepare Archive Candidates").parameters.jsCode,
    /eligibleStatuses\s*=\s*\[[^\]]*retryable_error/
  );
  assert.match(
    nodeByName(workflow, "Prepare Archive Candidates").parameters.jsCode,
    /already_archived/
  );
  assert.match(
    nodeByName(workflow, "Prepare Archive Candidates").parameters.jsCode,
    /retained_for_retry/
  );
});

test("reviewer export only applies explicit actions and upserts one deduplicated funnel row", () => {
  const workflow = workflows.reviewer;
  assert.deepEqual(review.manual_action_dropdown, schema.manual_actions);
  assert.deepEqual(review.editable_columns, [
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "notes"
  ]);
  const prepare = nodeByName(workflow, "Prepare Active Review Updates").parameters.jsCode;
  assert.match(prepare, /if \(!record\.manual_action\) continue/);
  assert.match(prepare, /unsupported manual action/);
  assert.match(prepare, /pipeline_status: "applied"/);
  assert.match(prepare, /pipeline_status: "skipped"/);
  assert.match(prepare, /first_reviewed_at/);
  assert.match(prepare, /application_snapshot_at/);
  assert.match(prepare, /outcome_events/);
  for (const field of [
    "first_reviewed_at",
    "apply_points_used",
    "application_message_strategy",
    "application_snapshot_at",
    "outcome_events"
  ]) {
    assert.ok(
      field in nodeByName(workflow, "Update Active Review Actions")
        .parameters.columns.value,
      `active reviewer commit is missing ${field}`
    );
    assert.ok(
      field in nodeByName(workflow, "Update Archive Review Actions")
        .parameters.columns.value,
      `archive reviewer commit is missing ${field}`
    );
  }
  const dashboard = nodeByName(workflow, "Update Dashboard Summary");
  assert.equal(dashboard.parameters.operation, "appendOrUpdate");
  assert.deepEqual(dashboard.parameters.columns.matchingColumns, ["metric_key"]);
  assert.equal(dashboard.parameters.sheetName.value, review.dashboard_sheet);
});

test("analytics export publishes completion only after every idempotent detail write", () => {
  const workflow = workflows.analytics;
  for (const name of [
    "Get Active Rows",
    "Get Archive Rows",
    "Build Analytics Report",
    "Prepare Analytics Rows",
    "Upsert Analytics Rows",
    "Aggregate Analytics Row Writes",
    "Prepare Analytics Completion",
    "Publish Complete Analytics Report"
  ]) {
    nodeByName(workflow, name);
  }
  const details = nodeByName(workflow, "Upsert Analytics Rows");
  assert.equal(details.parameters.sheetName.value, analyticsPolicy.detail_sheet);
  assert.equal(details.parameters.operation, "appendOrUpdate");
  assert.deepEqual(details.parameters.columns.matchingColumns, [
    "analytics_row_id"
  ]);
  const completion = nodeByName(
    workflow,
    "Publish Complete Analytics Report"
  );
  assert.equal(
    completion.parameters.sheetName.value,
    analyticsPolicy.reports_sheet
  );
  assert.equal(completion.parameters.operation, "appendOrUpdate");
  assert.deepEqual(completion.parameters.columns.matchingColumns, ["report_id"]);
  assertDirectConnection(
    workflow,
    "Upsert Analytics Rows",
    "Aggregate Analytics Row Writes"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Analytics Row Writes",
    "Prepare Analytics Completion"
  );
  assertDirectConnection(
    workflow,
    "Prepare Analytics Completion",
    "Publish Complete Analytics Report"
  );
  const build = nodeByName(workflow, "Build Analytics Report").parameters.jsCode;
  assert.match(build, /buildAnalyticsReport/);
  assert.match(build, /application_opportunity_score/);
  assert.match(build, /outcome_events/);
  assert.match(build, /multi_touch_full_credit/);
  const publishGuard = nodeByName(
    workflow,
    "Prepare Analytics Completion"
  ).parameters.jsCode;
  assert.match(publishGuard, /writes\.length !==/);
  assert.match(publishGuard, /detail_row_count/);
  assert.ok(
    workflow.nodes
      .filter((node) => node.type === "n8n-nodes-base.googleSheets")
      .every(
        (node) =>
          !["Sheet1", "Archive"].includes(node.parameters.sheetName.value) ||
          node.parameters.operation === "read"
      ),
    "analytics must not mutate source records"
  );
});

test("weekly recommender consumes only complete analytics and publishes versioned advisory evidence", () => {
  const workflow = workflows.recommender;
  for (const name of [
    "Get Analytics Reports",
    "Aggregate Analytics Reports",
    "Get Analytics Detail",
    "Build Weekly Recommendations",
    "Prepare Recommendation Rows",
    "Upsert Recommendation Rows",
    "Aggregate Recommendation Row Writes",
    "Prepare Recommendation Report",
    "Publish Recommendation Report"
  ]) {
    nodeByName(workflow, name);
  }

  const reportRead = nodeByName(workflow, "Get Analytics Reports");
  const detailRead = nodeByName(workflow, "Get Analytics Detail");
  assert.equal(
    reportRead.parameters.sheetName.value,
    recommendationPolicy.source_reports_sheet
  );
  assert.equal(
    detailRead.parameters.sheetName.value,
    recommendationPolicy.source_detail_sheet
  );
  assert.equal(reportRead.parameters.operation, "read");
  assert.equal(detailRead.parameters.operation, "read");
  assert.equal(reportRead.onError, "continueRegularOutput");
  assert.equal(detailRead.onError, "continueRegularOutput");

  const details = nodeByName(workflow, "Upsert Recommendation Rows");
  assert.equal(
    details.parameters.sheetName.value,
    recommendationPolicy.recommendations_sheet
  );
  assert.equal(details.parameters.operation, "appendOrUpdate");
  assert.deepEqual(details.parameters.columns.matchingColumns, [
    "recommendation_id"
  ]);
  assert.equal(details.onError, "continueRegularOutput");

  const reports = nodeByName(workflow, "Publish Recommendation Report");
  assert.equal(
    reports.parameters.sheetName.value,
    recommendationPolicy.reports_sheet
  );
  assert.equal(reports.parameters.operation, "appendOrUpdate");
  assert.deepEqual(reports.parameters.columns.matchingColumns, ["run_id"]);
  assertDirectConnection(
    workflow,
    "Upsert Recommendation Rows",
    "Aggregate Recommendation Row Writes"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Recommendation Row Writes",
    "Prepare Recommendation Report"
  );
  assertDirectConnection(
    workflow,
    "Prepare Recommendation Report",
    "Publish Recommendation Report"
  );

  const build = nodeByName(
    workflow,
    "Build Weekly Recommendations"
  ).parameters.jsCode;
  assert.match(build, /latestCompleteAnalyticsReport/);
  assert.match(build, /buildRecommendationReport/);
  assert.match(build, /buildRecommendationFailure/);
  assert.match(build, /source_read_failure/);
  assert.match(build, /do not change weights automatically/i);
  assert.match(build, new RegExp(profile.profile_version.replace("/", "\\/")));

  const publishGuard = nodeByName(
    workflow,
    "Prepare Recommendation Report"
  ).parameters.jsCode;
  assert.match(publishGuard, /detail_write_failure/);
  assert.match(publishGuard, /writes\.length !==/);
  assert.match(publishGuard, /report\.status = 'failed'/);
  assert.equal(reports.onError, undefined);

  assert.ok(
    workflow.nodes
      .filter((node) => node.type === "n8n-nodes-base.googleSheets")
      .every((node) => {
        const sheet = node.parameters.sheetName.value;
        return (
          ![
            recommendationPolicy.source_detail_sheet,
            recommendationPolicy.source_reports_sheet
          ].includes(sheet) || node.parameters.operation === "read"
        );
      }),
    "weekly recommender must not mutate analytics source records"
  );
  assert.equal(
    workflow.nodes.some(
      (node) =>
        node.type === "n8n-nodes-base.httpRequest" ||
        /slack|telegram|email/i.test(node.name)
    ),
    false,
    "optional delivery must not become an authoritative write path"
  );
});

test("workflow exports contain credential references but no embedded secret material", () => {
  const serialized = JSON.stringify(workflows);
  assert.doesNotMatch(serialized, /\b(?:gsk|sk)-[A-Za-z0-9_-]{16,}\b/);
  assert.doesNotMatch(serialized, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i);

  for (const workflow of Object.values(workflows)) {
    for (const node of workflow.nodes) {
      for (const credential of Object.values(node.credentials ?? {})) {
        assert.deepEqual(Object.keys(credential).sort(), ["id", "name"]);
      }
    }
  }
});

test("every persisted Google Sheets match key is within the first 26 record columns", () => {
  const physicalRecordOrder = [
    ...review.review_columns,
    ...schema.fields.filter((field) => !review.review_columns.includes(field))
  ];
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    for (const node of workflow.nodes.filter(
      (entry) => entry.type === "n8n-nodes-base.googleSheets"
    )) {
      for (const matchingField of node.parameters?.columns?.matchingColumns ?? []) {
        if (matchingField === "row_number" || !schema.fields.includes(matchingField)) continue;
        assert.ok(
          physicalRecordOrder.indexOf(matchingField) >= 0 &&
            physicalRecordOrder.indexOf(matchingField) < 26,
          `${workflowName}/${node.name} match key ${matchingField} falls outside A:Z`
        );
      }
    }
  }
});
