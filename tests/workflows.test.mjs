import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyticsScheduleRule,
  learningScheduleTiming,
  minuteIntervalScheduleRules,
  recommendationScheduleRule
} from "../src/schedules.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const profile = await loadJson("../config/candidate-profile.json");
const policy = await loadJson("../config/application-policy.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const groqPolicy = await loadJson("../config/groq-provider-policy.json");
const claimRetentionPolicy = await loadJson(
  "../config/claim-retention.json"
);
const reportRetentionPolicy = await loadJson(
  "../config/report-retention.json"
);
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
      assert.doesNotMatch(
        node.parameters.jsCode,
        /\bnew\s+URL\s*\(/,
        `${file}/${node.name} relies on URL, which is unavailable in the n8n Code-node sandbox`
      );
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

  for (const [name, workflow] of Object.entries(workflows)) {
    assert.equal(workflow.settings.timezone, runtime.timezone, name);
    assert.ok(
      Number.isInteger(workflow.settings.executionTimeout) &&
        workflow.settings.executionTimeout > 0,
      `${name} must have a positive execution timeout`
    );
    assert.equal(
      workflow.meta.executionTimeoutSeconds,
      workflow.settings.executionTimeout,
      `${name} timeout metadata must match settings`
    );
    assert.equal(workflow.settings.saveDataSuccessExecution, "none", name);
    assert.equal(workflow.settings.saveDataErrorExecution, "all", name);
    assert.equal(workflow.settings.saveExecutionProgress, false, name);
    assert.equal(workflow.settings.saveManualExecutions, true, name);
  }

  const scheduledRunsPerWeek =
    (7 * 24) / searchPlan.schedule_hours +
    (7 * 24 * 60) / runtime.generator.schedule_minutes +
    (7 * 24 * 60) / alertPolicy.schedule_minutes +
    (7 * 24 * 60) / review.schedule_minutes +
    (7 * 24 * 60) / runtime.archiver.schedule_minutes +
    (7 * 24) / analyticsPolicy.schedule_hours +
    (7 * 24) / recommendationPolicy.schedule_hours;
  assert.equal(scheduledRunsPerWeek, 1730);
  assert.equal((7 * 24 * 60) / alertPolicy.schedule_minutes, 672);
  assert.equal(review.schedule_minutes, 15);
  assert.equal((7 * 24 * 60) / review.schedule_minutes, 672);
  const annualReviewerExecutions =
    (365 * 24 * 60) / review.schedule_minutes;
  assert.equal(annualReviewerExecutions, 35040);
  assert.equal(52560 - annualReviewerExecutions, 17520);
  assert.equal((52560 - annualReviewerExecutions) * 6, 105120);
  assert.ok(
    (runtime.generator.schedule_minutes / alertPolicy.schedule_minutes) *
      alertPolicy.per_run_cap >=
      runtime.generator.per_run_cap,
    "Alerter recovery capacity must cover the Generator's maximum output"
  );
  assert.equal(
    Object.values(workflows).filter(
      (workflow) => workflow.settings.saveDataSuccessExecution !== "none"
    ).length,
    0
  );
  for (const name of [
    "scraper",
    "generator",
    "alerter",
    "reviewer",
    "archiver"
  ]) {
    const trigger = nodeByName(workflows[name], "Schedule Trigger");
    assert.equal(trigger.typeVersion, 1.3, name);
    assert.ok(
      trigger.parameters.rule.interval.every(
        (rule) =>
          rule.field === "cronExpression" &&
          /^0 (?:\d+(?:,\d+)*) (?:\*|\d+(?:,\d+)*) \* \* \*$/.test(
            rule.expression
          )
      ),
      `${name} must use explicit six-field cron rules`
    );
  }

  assert.deepEqual(
    nodeByName(scraper, "Schedule Trigger").parameters.rule.interval,
    minuteIntervalScheduleRules(
      {
        schedule_minutes: searchPlan.schedule_hours * 60,
        schedule_offset_minutes: searchPlan.schedule_offset_minutes
      },
      "scraper"
    )
  );
  for (
    let pageNumber = 1;
    pageNumber <= searchPlan.max_pages_per_query;
    pageNumber += 1
  ) {
    const suffix = pageNumber === 1 ? "" : ` ${pageNumber}`;
    const searchFetch = nodeByName(scraper, `Fetch Search Page${suffix}`);
    assert.equal(
      searchFetch.parameters.options.batching.batch.batchInterval,
      searchPlan.request_interval_ms
    );
    assert.equal(
      searchFetch.parameters.options.timeout,
      searchPlan.request_timeout_ms
    );
    assert.equal(searchFetch.maxTries, searchPlan.retry.max_attempts);
    assert.equal(searchFetch.waitBetweenTries, searchPlan.retry.backoff_ms);
    if (pageNumber > 1) {
      const wait = nodeByName(
        scraper,
        `Wait Before Search Page ${pageNumber}`
      );
      assert.equal(wait.parameters.resume, "timeInterval");
      assert.equal(
        wait.parameters.amount * 1000,
        searchPlan.request_interval_ms
      );
      assert.equal(wait.parameters.unit, "seconds");
    }
  }
  assert.equal(scraper.meta.searchPlanVersion, searchPlan.plan_version);
  assert.equal(
    scraper.meta.scheduleOffsetMinutes,
    searchPlan.schedule_offset_minutes
  );
  assert.equal(
    scraper.settings.executionTimeout,
    searchPlan.execution_timeout_seconds
  );
  assert.ok(
    searchPlan.execution_timeout_seconds <
      searchPlan.schedule_hours * 60 * 60
  );

  assert.deepEqual(
    nodeByName(generator, "Schedule Trigger").parameters.rule.interval,
    minuteIntervalScheduleRules(runtime.generator, "generator")
  );
  assert.equal(generator.meta.generatorPerRunCap, runtime.generator.per_run_cap);
  assert.equal(
    generator.meta.generatorEvaluationPerRunCap,
    runtime.generator.evaluation_per_run_cap
  );
  assert.equal(
    generator.meta.generatorMaximumPriorityWaitMinutes,
    runtime.generator.maximum_priority_wait_minutes
  );
  assert.equal(
    generator.meta.scheduleOffsetMinutes,
    runtime.generator.schedule_offset_minutes
  );
  assert.equal(
    generator.settings.executionTimeout,
    runtime.generator.execution_timeout_seconds
  );
  const prepareWorkCode = nodeByName(
    generator,
    "Prepare Work Candidates"
  ).parameters.jsCode;
  assert.match(
    prepareWorkCode,
    new RegExp(
      `generation:\\s*${runtime.generator.per_run_cap}[\\s\\S]*evaluation:\\s*${runtime.generator.evaluation_per_run_cap}`
    )
  );
  assert.match(
    prepareWorkCode,
    new RegExp(
      `${runtime.generator.maximum_priority_wait_minutes}\\s*\\*\\s*60\\s*\\*\\s*1000`
    )
  );
  assert.ok(
    runtime.generator.execution_timeout_seconds * 1000 <
      runtime.generator.claim_lease_ms
  );
  assert.equal(generator.meta.candidateProfileVersion, profile.profile_version);
  assert.equal(generator.meta.applicationPolicyVersion, policy.policy_version);
  assert.equal(generator.meta.rankingPolicyVersion, rankingPolicy.policy_version);
  assert.equal(
    generator.meta.applicationPackPolicyVersion,
    packPolicy.policy_version
  );
  assert.equal(generator.meta.applicationPackVersion, packPolicy.pack_version);
  assert.equal(
    generator.meta.groqProviderPolicyVersion,
    groqPolicy.policy_version
  );
  assert.equal(generator.meta.groqModel, groqPolicy.selected_model);
  assert.equal(
    generator.meta.groqRequestIntervalMilliseconds,
    groqPolicy.generation.request_interval_ms
  );
  for (const agentName of ["AI Agent", "Repair AI Agent"]) {
    assert.equal(
      nodeByName(generator, agentName).parameters.options.batching
        .delayBetweenBatches,
      groqPolicy.generation.request_interval_ms
    );
  }
  const repairWait = nodeByName(generator, "Wait Before Repair");
  assert.equal(repairWait.parameters.resume, "timeInterval");
  assert.equal(repairWait.parameters.unit, "seconds");
  assert.equal(
    repairWait.parameters.amount * 1000,
    groqPolicy.generation.request_interval_ms
  );
  assert.deepEqual(
    generator.connections["Needs Repair"].main[0],
    [{ node: "Wait Before Repair", type: "main", index: 0 }]
  );
  assert.deepEqual(
    generator.connections["Wait Before Repair"].main[0],
    [{ node: "Repair AI Agent", type: "main", index: 0 }]
  );
  const groq = nodeByName(generator, "Groq Chat Model");
  assert.equal(groq.parameters.model, groqPolicy.selected_model);
  assert.equal(
    groq.parameters.options.maxTokensToSample,
    groqPolicy.generation.maximum_output_tokens
  );
  assert.equal(
    groq.parameters.options.temperature,
    groqPolicy.generation.temperature
  );
  const detailFetch = nodeByName(generator, "Fetch Job Detail");
  assert.equal(detailFetch.maxTries, runtime.generator.retry.max_attempts);
  assert.equal(detailFetch.waitBetweenTries, runtime.generator.request_retry_backoff_ms);
  assert.ok(
    detailFetch.waitBetweenTries * (detailFetch.maxTries - 1) <
      runtime.generator.claim_lease_ms,
    "in-node retry waits must remain shorter than the claim lease"
  );

  assert.deepEqual(
    nodeByName(archiver, "Schedule Trigger").parameters.rule.interval,
    minuteIntervalScheduleRules(runtime.archiver, "archiver")
  );
  assert.equal(
    archiver.settings.executionTimeout,
    runtime.archiver.execution_timeout_seconds
  );
  assert.equal(
    archiver.meta.scheduleOffsetMinutes,
    runtime.archiver.schedule_offset_minutes
  );
  assert.ok(
    runtime.archiver.execution_timeout_seconds * 1000 <
      runtime.archiver.claim_lease_ms
  );
  assert.deepEqual(
    nodeByName(reviewer, "Schedule Trigger").parameters.rule.interval,
    minuteIntervalScheduleRules(review, "reviewer")
  );
  assert.equal(
    reviewer.settings.executionTimeout,
    review.execution_timeout_seconds
  );
  assert.equal(
    reviewer.meta.scheduleOffsetMinutes,
    review.schedule_offset_minutes
  );
  assert.ok(
    review.execution_timeout_seconds * 1000 <
      review.projection_claim_lease_ms
  );
  assert.ok(
    review.projection_claim_lease_ms <
      review.schedule_minutes * 60 * 1000,
    "Reviewer projection lease must expire before the next scheduled poll"
  );
  assert.deepEqual(
    nodeByName(alerter, "Schedule Trigger").parameters.rule.interval,
    minuteIntervalScheduleRules(alertPolicy, "alerter")
  );
  assert.equal(alerter.meta.alertPolicyVersion, alertPolicy.policy_version);
  assert.equal(alerter.meta.alertChannel, alertPolicy.channel);
  assert.equal(alerter.meta.alertPerRunCap, alertPolicy.per_run_cap);
  assert.equal(
    alerter.meta.alertProviderRequestIntervalMs,
    alertPolicy.provider_request_interval_ms
  );
  assert.equal(
    alerter.meta.scheduleOffsetMinutes,
    alertPolicy.schedule_offset_minutes
  );
  assert.equal(
    alerter.settings.executionTimeout,
    alertPolicy.execution_timeout_seconds
  );
  assert.ok(
    alertPolicy.execution_timeout_seconds * 1000 <
      alertPolicy.claim_lease_ms
  );
  assert.ok(
    alertPolicy.retry.backoff_ms >= alertPolicy.claim_lease_ms
  );
  assert.ok(
    alertPolicy.claim_lease_ms <
      alertPolicy.schedule_minutes * 60 * 1000
  );
  assert.ok(
    alertPolicy.provider_timeout_ms * alertPolicy.per_run_cap +
      alertPolicy.provider_request_interval_ms *
        (alertPolicy.per_run_cap - 1) <
      alertPolicy.execution_timeout_seconds * 1000
  );
  assert.deepEqual(
    nodeByName(analytics, "Schedule Trigger").parameters.rule.interval,
    [analyticsScheduleRule(analyticsPolicy)]
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
    analytics.settings.executionTimeout,
    analyticsPolicy.execution_timeout_seconds
  );
  assert.deepEqual(
    nodeByName(recommender, "Schedule Trigger").parameters.rule.interval,
    [recommendationScheduleRule(analyticsPolicy, recommendationPolicy)]
  );
  const learningTiming = learningScheduleTiming(
    analyticsPolicy,
    recommendationPolicy
  );
  assert.equal(
    learningTiming.completion_buffer_minutes,
    recommendationPolicy.source_completion_buffer_minutes
  );
  assert.equal(
    recommender.meta.recommendationPolicyVersion,
    recommendationPolicy.policy_version
  );
  assert.equal(
    recommender.meta.requiredMetricDefinitionVersion,
    recommendationPolicy.required_metric_definition_version
  );
  assert.equal(
    recommender.settings.executionTimeout,
    recommendationPolicy.execution_timeout_seconds
  );
  assert.equal(
    recommender.meta.sourceCompletionBufferMinutes,
    recommendationPolicy.source_completion_buffer_minutes
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
  assert.equal(
    (loadPlan.match(/"page_number":1/g) || []).length,
    enabledQueries.length
  );
  assert.doesNotMatch(loadPlan, /"page_number":2/);
  const firstParse = nodeByName(
    workflow,
    "Parse Search Page"
  ).parameters.jsCode;
  assert.match(firstParse, /buildNextSearchRequest/);
  assert.match(firstParse, /result_card_count/);
  for (
    let pageNumber = 2;
    pageNumber <= searchPlan.max_pages_per_query;
    pageNumber += 1
  ) {
    const hasPage = `Has Search Page ${pageNumber}`;
    const wait = `Wait Before Search Page ${pageNumber}`;
    const fetch = `Fetch Search Page ${pageNumber}`;
    const parse = `Parse Search Page ${pageNumber}`;
    const merge = `Merge Search Page ${pageNumber} Results`;
    nodeByName(workflow, hasPage);
    nodeByName(workflow, wait);
    nodeByName(workflow, fetch);
    const parseNode = nodeByName(workflow, parse);
    const mergeNode = nodeByName(workflow, merge);
    assert.equal(mergeNode.parameters.mode, "append");
    assert.equal(mergeNode.parameters.numberInputs, 2);
    assert.match(parseNode.parameters.jsCode, /buildNextSearchRequest/);
    assert.deepEqual(workflow.connections[hasPage].main, [
      [{ node: wait, type: "main", index: 0 }],
      [{ node: merge, type: "main", index: 1 }]
    ]);
    assertDirectConnection(workflow, wait, fetch);
    assertDirectConnection(workflow, fetch, parse);
    assertDirectConnection(workflow, parse, merge);
  }
  assert.match(
    nodeByName(workflow, "Expand Search Page Results").parameters.jsCode,
    /page_results/
  );
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
  for (const writeName of [
    "Append Discovery Claims",
    "Append Discovered Jobs",
    "Update Active Seen",
    "Update Archive Seen"
  ]) {
    const writeNode = nodeByName(workflow, writeName);
    assert.equal(writeNode.onError, undefined, `${writeName} must stop on write failure`);
    assert.equal(writeNode.continueOnFail, undefined);
    assert.equal(writeNode.retryOnFail, undefined, `${writeName} must not retry ambiguous writes`);
    assert.equal(writeNode.maxTries, undefined);
    assert.equal(writeNode.waitBetweenTries, undefined);
  }
  const summary = nodeByName(
    workflow,
    "Log Discovery Summary"
  ).parameters.jsCode;
  assert.match(summary, /coverage/);
  assert.match(summary, /pages_requested/);
  assert.match(summary, /maximum_page_requests/);
});

test("generator export gates Groq behind evaluation, claim arbitration, and validation", () => {
  const workflow = workflows.generator;
  for (const requiredNode of [
    "Append Processing Claims",
    "Get Processing Claims",
    "Keep Winning Claims",
    "Aggregate Generation Marks",
    "Get Active After Generation Mark",
    "Confirm Generation Claim Markers",
    "Fetch Job Detail",
    "Evaluate Job",
    "Get Active Before Evaluation Commit",
    "Confirm Evaluation Commit Marker",
    "Prepare Application Pack",
    "Is Application Pack Ready",
    "Persist Non-Ready Pack",
    "AI Agent",
    "Validate Initial Draft",
    "Needs Repair",
    "Repair AI Agent",
    "Validate Repaired Message",
    "Stage Generation Result For Commit",
    "Get Active Before Generation Commit",
    "Confirm Generation Commit Marker",
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
    ["processing_commit_guard"]
  );
  for (const name of [
    "Commit Evaluation Result",
    "Commit Generation Result"
  ]) {
    const commit = nodeByName(workflow, name);
    assert.deepEqual(commit.parameters.columns.matchingColumns, [
      "processing_commit_guard"
    ]);
    assert.match(
      commit.parameters.columns.value.processing_commit_guard,
      /processing_commit_guard/
    );
    assert.match(
      commit.parameters.columns.value.processing_token,
      /\$json\.processing_token/
    );
    assert.match(
      commit.parameters.columns.value.processing_stage,
      /\$json\.processing_stage/
    );
    assert.match(
      commit.parameters.columns.value.processing_started_at,
      /\$json\.processing_started_at/
    );
  }
  const markClaim = nodeByName(workflow, "Mark Claimed Jobs");
  assert.ok(markClaim.parameters.columns.value.processing_commit_guard);
  assert.ok(markClaim.parameters.columns.value.processing_token);
  assertDirectConnection(
    workflow,
    "Mark Claimed Jobs",
    "Aggregate Generation Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Generation Marks",
    "Get Active After Generation Mark"
  );
  assertDirectConnection(
    workflow,
    "Get Active After Generation Mark",
    "Confirm Generation Claim Markers"
  );
  assertDirectConnection(
    workflow,
    "Confirm Generation Claim Markers",
    "Is Evaluation Work"
  );
  const prepareCandidates = nodeByName(
    workflow,
    "Prepare Work Candidates"
  ).parameters.jsCode;
  assert.match(prepareCandidates, /claimed_manual_action:\s*record\.manual_action/);
  assert.match(
    prepareCandidates,
    /claimed_alert_status:\s*record\.alert_status/
  );
  for (const [nodeName, plannedNode] of [
    ["Confirm Generation Claim Markers", "Keep Winning Claims"],
    ["Confirm Evaluation Commit Marker", "Evaluate Job"],
    [
      "Confirm Generation Commit Marker",
      "Stage Generation Result For Commit"
    ]
  ]) {
    const confirmation = nodeByName(workflow, nodeName).parameters.jsCode;
    assert.match(confirmation, /confirmGenerationClaimMarkers/);
    assert.match(
      confirmation,
      new RegExp(`\\$\\('${plannedNode}'\\)\\.all\\(\\)`)
    );
  }
  assertDirectConnection(
    workflow,
    "Prepare Application Pack",
    "Is Application Pack Ready"
  );
  assertDirectConnection(workflow, "Is Application Pack Ready", "AI Agent");
  assertDirectConnection(
    workflow,
    "Is Application Pack Ready",
    "Persist Non-Ready Pack"
  );
  assertDirectConnection(
    workflow,
    "Persist Non-Ready Pack",
    "Stage Generation Result For Commit"
  );
  assertDirectConnection(workflow, "AI Agent", "Validate Initial Draft");
  assert.match(
    nodeByName(workflow, "Parse Job Detail").parameters.jsCode,
    /externalResultErrorMessage\(payload\)/
  );
  assertDirectConnection(workflow, "Validate Initial Draft", "Needs Repair");
  assertDirectConnection(workflow, "Needs Repair", "Wait Before Repair");
  assertDirectConnection(workflow, "Wait Before Repair", "Repair AI Agent");
  assertDirectConnection(
    workflow,
    "Needs Repair",
    "Stage Generation Result For Commit"
  );
  assertDirectConnection(
    workflow,
    "Repair AI Agent",
    "Validate Repaired Message"
  );
  assertDirectConnection(
    workflow,
    "Validate Repaired Message",
    "Stage Generation Result For Commit"
  );
  assertDirectConnection(
    workflow,
    "Evaluate Job",
    "Get Active Before Evaluation Commit"
  );
  assertDirectConnection(
    workflow,
    "Get Active Before Evaluation Commit",
    "Confirm Evaluation Commit Marker"
  );
  assertDirectConnection(
    workflow,
    "Confirm Evaluation Commit Marker",
    "Commit Evaluation Result"
  );
  assertDirectConnection(
    workflow,
    "Stage Generation Result For Commit",
    "Get Active Before Generation Commit"
  );
  assertDirectConnection(
    workflow,
    "Get Active Before Generation Commit",
    "Confirm Generation Commit Marker"
  );
  assertDirectConnection(
    workflow,
    "Confirm Generation Commit Marker",
    "Commit Generation Result"
  );
  assert.ok(
    workflow.nodes.every((node) => !/Clear (?:Evaluation|Generation) Claim/.test(node.name)),
    "a canonical-id cleanup write could erase a newer processing claim"
  );

  const systemMessage = nodeByName(workflow, "AI Agent").parameters.options.systemMessage;
  assert.match(systemMessage, /johnlesterescarlan\.pro/);
  assert.match(systemMessage, /manual review/i);
  assert.match(systemMessage, /selected approved proofs are the only candidate facts/i);
  assert.doesNotMatch(systemMessage, /Pharmacy & Acute Care University/);
  assert.doesNotMatch(systemMessage, /netlify|FireCheck|PriceCraft|HEALTH/);
  assert.equal(policy.manual_submission_required, true);
  const evaluationCode = nodeByName(workflow, "Evaluate Job").parameters.jsCode;
  const detailParserCode = nodeByName(
    workflow,
    "Parse Job Detail"
  ).parameters.jsCode;
  assert.match(detailParserCode, /detail_parse_error/);
  assert.match(detailParserCode, /recognizable job-page evidence/);
  assert.match(evaluationCode, /const RANKING_POLICY/);
  assert.match(
    evaluationCode,
    /evaluateJob\(record, PROFILE, RANKING_POLICY, now\)/
  );
  const evaluationRuntime = evaluationCode.slice(
    evaluationCode.lastIndexOf("const PROFILE =")
  );
  assert.match(evaluationRuntime, /processing_commit_guard:\s*commitGuard/);
  assert.doesNotMatch(
    evaluationRuntime,
    /processing_token:\s*commitToken/
  );
  const generationRuntime = nodeByName(
    workflow,
    "Validate Initial Draft"
  ).parameters.jsCode.slice(
    nodeByName(
      workflow,
      "Validate Initial Draft"
    ).parameters.jsCode.lastIndexOf("const PROFILE =")
  );
  assert.match(generationRuntime, /processing_commit_guard:\s*commitGuard/);
  assert.doesNotMatch(
    generationRuntime,
    /processing_token:\s*commitToken/
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
  assert.ok(
    Object.keys(evaluationCommit).every(
      (field) => !field.startsWith("alert_")
    ),
    "deterministic evaluation must not write Alerter-owned fields"
  );
  const packCode = nodeByName(
    workflow,
    "Prepare Application Pack"
  ).parameters.jsCode;
  assert.match(packCode, /buildApplicationPack/);
  assert.match(packCode, /validateApplicationPack/);
  assert.match(packCode, /application_pack_ready/);
  assert.match(packCode, /buildApplicationUserMessage\(record, pack,\s*\{/);
  assert.match(
    packCode,
    new RegExp(
      `maximumProofs:\\s*${groqPolicy.generation.maximum_prompt_proofs}`
    )
  );
  assert.match(packCode, /provider_prompt_budget/);
  assert.match(packCode, /validateGroqPromptBudget/);
  const generationCode = nodeByName(
    workflow,
    "Validate Initial Draft"
  ).parameters.jsCode;
  assert.match(
    generationCode,
    /function evaluatePersistedMessageSafety\s*\(/
  );
  assert.match(generationCode, /function validateGeneratedMessage\s*\(/);
  assert.match(generationCode, /function validateApplicationPack\s*\(/);
  assert.match(generationCode, /externalResultErrorMessage\(payload\)/);
  assert.match(
    generationCode,
    /const originalRecord = \$\('Confirm Generation Claim Markers'\)/
  );
  assert.match(generationCode, /applyGeneratedApplicationPack/);
  assert.match(
    generationCode,
    /queueAlertState\(\s*generated,\s*ALERT_POLICY,\s*now,\s*MESSAGE_SAFETY\s*\)/
  );
  assert.match(generationCode, /applicationPolicy:\s*POLICY/);
  assert.match(generationCode, /recordStageFailure\(originalRecord/);
  assert.match(generationCode, /buildApplicationRepairMessage/);
  assert.match(generationCode, /record\.application_prompt/);
  assert.match(generationCode, /repair prompt exceeds provider input budget/);
  assert.match(generationCode, /should_repair:\s*true/);
  const repairCode = nodeByName(
    workflow,
    "Validate Repaired Message"
  ).parameters.jsCode;
  assert.match(repairCode, /validateGeneratedMessage/);
  assert.match(repairCode, /externalResultErrorMessage\(payload\)/);
  assert.match(repairCode, /recordStageFailure\(originalRecord/);
  assert.match(repairCode, /applyGeneratedApplicationPack/);
  const nonReadyCode = nodeByName(
    workflow,
    "Persist Non-Ready Pack"
  ).parameters.jsCode;
  assert.match(nonReadyCode, /applyNonReadyApplicationPack/);
  assert.doesNotMatch(nonReadyCode, /AI Agent|Groq Chat Model/);
  for (const nodeName of [
    "Parse Job Detail",
    "Prepare Application Pack",
    "Persist Non-Ready Pack",
    "Validate Initial Draft",
    "Validate Repaired Message"
  ]) {
    const code = nodeByName(workflow, nodeName).parameters.jsCode;
    assert.match(code, /\$\('Confirm Generation Claim Markers'\)/);
    assert.doesNotMatch(code, /\$\('Keep Winning Claims'\)/);
  }
  assert.equal(
    nodeByName(workflow, "Fetch Job Detail").parameters.url,
    "={{ $json.canonical_url }}"
  );
  for (const nodeName of [
    "Evaluate Job",
    "Persist Non-Ready Pack",
    "Validate Initial Draft",
    "Validate Repaired Message"
  ]) {
    assert.match(
      nodeByName(workflow, nodeName).parameters.jsCode,
      /generatorResultEvent/
    );
    assert.match(
      nodeByName(workflow, nodeName).parameters.jsCode,
      /state_commit_pending/
    );
  }
  assert.equal(
    workflow.nodes.filter((node) => node.name === "Repair AI Agent").length,
    1
  );
  assert.equal(
    nodeByName(workflow, "Repair AI Agent").parameters.text,
    "={{ $json.repair_prompt }}"
  );
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
    "Aggregate Alert Attempt Marks",
    "Get Active After Alert Mark",
    "Confirm Alert Attempt Markers",
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
    ["processing_commit_guard"]
  );
  const alertCommit = nodeByName(workflow, "Commit Alert Result");
  assert.match(
    alertCommit.parameters.columns.value.processing_commit_guard,
    /processing_commit_guard/
  );
  assert.match(
    alertCommit.parameters.columns.value.processing_token,
    /\$json\.processing_token/
  );
  const markAlert = nodeByName(workflow, "Mark Alert Attempts");
  assert.ok(markAlert.parameters.columns.value.processing_commit_guard);
  assert.ok(markAlert.parameters.columns.value.processing_token);
  assert.equal(
    nodeByName(workflow, "Aggregate Alert Attempt Marks").parameters.aggregate,
    "aggregateAllItemData"
  );
  assertDirectConnection(
    workflow,
    "Mark Alert Attempts",
    "Aggregate Alert Attempt Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Alert Attempt Marks",
    "Get Active After Alert Mark"
  );
  assertDirectConnection(
    workflow,
    "Get Active After Alert Mark",
    "Confirm Alert Attempt Markers"
  );
  assertDirectConnection(
    workflow,
    "Confirm Alert Attempt Markers",
    "Prepare Alert Delivery"
  );
  const confirmAttempt = nodeByName(
    workflow,
    "Confirm Alert Attempt Markers"
  ).parameters.jsCode;
  assert.match(confirmAttempt, /confirmAlertAttemptMarkers/);
  assert.match(confirmAttempt, /\$\('Keep Winning Alert Claims'\)\.all\(\)/);
  const prepare = nodeByName(
    workflow,
    "Prepare Alert Delivery"
  ).parameters.jsCode;
  assert.match(prepare, /validateAlertProviderConfiguration/);
  assert.match(prepare, /Open Review Queue/);
  assert.doesNotMatch(
    prepare,
    /Review in Sheet|Review in authorized Sheet|Confirm skip in Sheet|review_confirmation/
  );
  assert.match(prepare, /configuration_error/);
  assert.match(prepare, /evaluatePersistedMessageSafety/);
  assert.match(prepare, /Application message — copy below/);
  assert.match(prepare, /function slackEscapeLiteral\s*\(/);
  assert.match(prepare, /alertRenderErrorCategory\(error\)/);
  assert.match(prepare, /preflight_error/);
  assert.match(
    nodeByName(
      workflow,
      "Prepare Alert Candidates"
    ).parameters.jsCode,
    /selectAlertCandidates\(\s*[\s\S]*MESSAGE_SAFETY\s*\)/
  );
  for (const nodeName of [
    "Prepare Alert Candidates",
    "Prepare Alert Delivery"
  ]) {
    const code = nodeByName(workflow, nodeName).parameters.jsCode;
    assert.match(code, /function evaluatePersistedMessageSafety\s*\(/);
    assert.match(code, /function validateGeneratedMessage\s*\(/);
    assert.match(code, /function validateApplicationPack\s*\(/);
  }
  assert.match(prepare, /const record = \$json/);
  assert.doesNotMatch(prepare, /request_url/);
  const prepareRuntime = prepare.slice(prepare.lastIndexOf("const POLICY ="));
  assert.match(prepareRuntime, /processing_commit_guard:\s*commitGuard/);
  assert.match(
    prepareRuntime,
    /catch\s*\(error\)[\s\S]*should_send:\s*false/
  );
  assert.doesNotMatch(
    prepareRuntime,
    /processing_token:\s*commitToken/
  );
  assert.doesNotMatch(
    prepareRuntime,
    /console\.(?:log|error)\([^)]*(?:generated_message|alertPayload|error)/
  );
  const send = nodeByName(workflow, "Send Slack Alert");
  assert.equal(
    send.parameters.url,
    `={{ $env.${alertPolicy.environment.provider_webhook_url} }}`
  );
  assert.equal(send.parameters.method, "POST");
  assert.equal(send.parameters.contentType, "json");
  assert.equal(send.parameters.specifyBody, "json");
  assert.equal(send.parameters.options.timeout, alertPolicy.provider_timeout_ms);
  assert.equal(
    send.parameters.options.batching.batch.batchSize,
    1
  );
  assert.equal(
    send.parameters.options.batching.batch.batchInterval,
    alertPolicy.provider_request_interval_ms
  );
  assert.equal(send.retryOnFail, false);
  assert.match(send.parameters.jsonBody, /alert_payload\.text/);
  assert.doesNotMatch(JSON.stringify(send), /hooks\.slack\.com\/services\//);
  const finalize = nodeByName(
    workflow,
    "Finalize Alert Delivery"
  ).parameters.jsCode;
  assert.match(finalize, /applyAlertProviderResult/);
  assert.match(finalize, /alertProviderErrorMessage\(payload\)/);
  assert.match(finalize, /error:\s*payload\.error/);
  const finalizeRuntime = finalize.slice(finalize.lastIndexOf("const POLICY ="));
  assert.match(finalizeRuntime, /processing_commit_guard:\s*commitGuard/);
  assert.match(finalizeRuntime, /payload\.error\?\.status/);
  assert.match(finalizeRuntime, /state_commit_pending:\s*true/);
  assert.match(finalizeRuntime, /timestamp:/);
  assert.doesNotMatch(
    finalizeRuntime,
    /processing_token:\s*commitToken/
  );
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
  assert.ok(
    workflow.nodes.every(
      (node) => !/Clear Alert Claim/.test(node.name)
    ),
    "an unguarded follow-up cleanup could erase a newer alert claim"
  );
});

test("archiver export serializes exact-key upserts and confirms the copy before bottom-up deletion", () => {
  const workflow = workflows.archiver;
  const upsert = nodeByName(workflow, "Upsert Archive Records");
  const writeLoop = nodeByName(workflow, "Loop Over Archive Writes");
  const deleteRows = nodeByName(workflow, "Delete Confirmed Active Rows");
  assert.equal(upsert.parameters.operation, "appendOrUpdate");
  assert.equal(
    upsert.parameters.columns.matchingColumns,
    "={{ [$json.archive_match_field] }}"
  );
  assert.equal(writeLoop.type, "n8n-nodes-base.splitInBatches");
  assert.equal(writeLoop.parameters.batchSize, 1);
  assert.equal(deleteRows.parameters.operation, "delete");
  assert.equal(deleteRows.parameters.toDelete, "rows");
  assert.match(deleteRows.parameters.startIndex, /row_number/);
  assert.equal(deleteRows.parameters.numberToDelete, 1);
  assertDirectConnection(
    workflow,
    "Keep Winning Archive Claims",
    "Aggregate Winning Archive Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Winning Archive Claims",
    "Get Archive Before Upsert"
  );
  assertDirectConnection(
    workflow,
    "Get Archive Before Upsert",
    "Prepare Archive Upserts"
  );
  assert.equal(
    nodeByName(
      workflow,
      "Aggregate Winning Archive Claims"
    ).parameters.aggregate,
    "aggregateAllItemData"
  );
  const prepareUpserts = nodeByName(
    workflow,
    "Prepare Archive Upserts"
  ).parameters.jsCode;
  assert.match(prepareUpserts, /prepareArchiveUpserts/);
  assert.match(prepareUpserts, /freshArchiveRows/);
  assert.match(prepareUpserts, /ambiguous_archive_identity/);
  assertDirectConnection(
    workflow,
    "Prepare Archive Upserts",
    "Loop Over Archive Writes"
  );
  assert.equal(
    workflow.connections["Loop Over Archive Writes"].main[0][0].node,
    "Aggregate Archive Upserts"
  );
  assert.equal(
    workflow.connections["Loop Over Archive Writes"].main[1][0].node,
    "Upsert Archive Records"
  );
  assertDirectConnection(
    workflow,
    "Upsert Archive Records",
    "Loop Over Archive Writes"
  );
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
  assert.match(
    nodeByName(workflow, "Prepare Archive Candidates").parameters.jsCode,
    /active_processing_claim/
  );
});

test("reviewer export safely synchronizes the simplified queue and preserves legacy review paths", () => {
  const workflow = workflows.reviewer;
  assert.deepEqual(review.manual_action_dropdown, schema.manual_actions);
  assert.deepEqual(review.editable_columns, [
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "notes"
  ]);
  const prepare = nodeByName(workflow, "Prepare Review Plan").parameters.jsCode;
  assert.match(
    prepare,
    /const directAction = String\(record\.manual_action \|\| ""\)\.trim\(\)/
  );
  assert.match(prepare, /unsupported manual action/);
  assert.match(prepare, /pipeline_status: "applied"/);
  assert.match(prepare, /pipeline_status: "skipped"/);
  assert.match(prepare, /first_reviewed_at/);
  assert.match(prepare, /application_snapshot_at/);
  assert.match(prepare, /outcome_events/);
  assert.match(prepare, /evaluatePersistedMessageSafety/);
  assert.match(prepare, /function evaluatePersistedMessageSafety\s*\(/);
  assert.match(prepare, /function validateGeneratedMessage\s*\(/);
  assert.match(prepare, /function validateApplicationPack\s*\(/);
  assert.match(
    prepare,
    /processReviewActions\(\s*activeRows,\s*archiveRows,\s*SCHEMA,\s*now,\s*MESSAGE_SAFETY,\s*\{[\s\S]*queueRows,[\s\S]*reviewConfig: REVIEW_CONFIG,[\s\S]*executionId: String\(\$execution\.id\)/
  );
  assert.match(prepare, /Generate Application/);
  assert.match(prepare, /I Applied/);
  assert.match(prepare, /mark_applied/);
  assert.match(prepare, /mark_skipped/);
  assert.match(prepare, /const resolveGuardedAction/);
  assert.match(prepare, /projectedGuard !== sourceGuard\.computed/);
  assert.match(prepare, /source state guard integrity mismatch/);
  assert.match(prepare, /conflicting \$\{projectionName\(location\)\} actions/);
  assert.match(prepare, /processed_applied_actions/);
  assert.match(prepare, /appliedJobsRows/);
  assert.match(prepare, /summarizeOperationalBacklog/);
  assert.match(prepare, /event:\s*'operational_backlog'/);
  assert.match(
    prepare,
    new RegExp(String(runtime.generator.claim_lease_ms))
  );
  assert.match(
    prepare,
    new RegExp(String(alertPolicy.claim_lease_ms))
  );
  assert.match(prepare, /manual_action_fingerprints/);

  const queueRead = nodeByName(workflow, "Get Review Queue Rows");
  assert.equal(queueRead.parameters.sheetName.value, review.review_queue.sheet);
  assert.deepEqual(queueRead.parameters.options.outputFormatting, {
    values: {
      general: "FORMULA",
      date: "FORMATTED_STRING"
    }
  });
  const queueAfterReview = nodeByName(
    workflow,
    "Get Review Queue After Review"
  );
  assert.deepEqual(
    queueAfterReview.parameters.options.outputFormatting,
    queueRead.parameters.options.outputFormatting
  );
  const appliedJobsRead = nodeByName(workflow, "Get Applied Jobs Rows");
  assert.equal(
    appliedJobsRead.parameters.sheetName.value,
    review.applied_jobs.sheet
  );
  const claim = nodeByName(workflow, "Mark Active Review Claims");
  assert.deepEqual(claim.parameters.columns.matchingColumns, ["state_guard"]);
  assert.deepEqual(Object.keys(claim.parameters.columns.value).sort(), [
    "processing_commit_guard",
    "state_guard"
  ]);
  const commit = nodeByName(workflow, "Update Active Review Actions");
  assert.deepEqual(commit.parameters.columns.matchingColumns, [
    "processing_commit_guard"
  ]);
  assertDirectConnection(
    workflow,
    "Prepare Active Review Claims",
    "Mark Active Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Mark Active Review Claims",
    "Aggregate Active Review Claim Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Review Claim Marks",
    "Get Active After Review Queue Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Active After Review Queue Claims",
    "Aggregate Active After Review Queue Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active After Review Queue Claims",
    "Prepare Claimed Active Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Prepare Claimed Active Review Updates",
    "Update Active Review Actions"
  );
  const archiveClaim = nodeByName(workflow, "Mark Archive Review Claims");
  assert.deepEqual(archiveClaim.parameters.columns.matchingColumns, [
    "state_guard"
  ]);
  const archiveCommit = nodeByName(
    workflow,
    "Update Archive Review Actions"
  );
  assert.deepEqual(archiveCommit.parameters.columns.matchingColumns, [
    "processing_commit_guard"
  ]);
  const activeAppliedCommit = nodeByName(
    workflow,
    "Update Active Applied Jobs Actions"
  );
  assert.deepEqual(activeAppliedCommit.parameters.columns.matchingColumns, [
    "processing_commit_guard"
  ]);
  for (const prepareName of [
    "Prepare Claimed Active Review Updates",
    "Prepare Claimed Active Applied Jobs Updates",
    "Prepare Claimed Active Direct Review Updates",
    "Prepare Claimed Archive Review Updates",
    "Prepare Claimed Archive Direct Review Updates"
  ]) {
    const code = nodeByName(workflow, prepareName).parameters.jsCode;
    assert.match(code, /confirmClaimedReviewUpdates/);
    assert.match(code, /function confirmClaimedReviewUpdates\s*\(/);
  }
  for (const fanInName of [
    "Aggregate Active Review Claim Marks",
    "Aggregate Active Applied Jobs Claim Marks",
    "Aggregate Active Direct Review Claim Marks",
    "Aggregate Archive Review Claim Marks",
    "Aggregate Archive Direct Review Claim Marks"
  ]) {
    assert.equal(
      nodeByName(workflow, fanInName).parameters.aggregate,
      "aggregateAllItemData"
    );
  }
  assertDirectConnection(
    workflow,
    "Prepare Archive Review Claims",
    "Mark Archive Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Mark Archive Review Claims",
    "Aggregate Archive Review Claim Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive Review Claim Marks",
    "Get Archive After Applied Jobs Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Archive After Applied Jobs Claims",
    "Aggregate Archive After Applied Jobs Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive After Applied Jobs Claims",
    "Prepare Claimed Archive Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Prepare Claimed Archive Review Updates",
    "Update Archive Review Actions"
  );
  const activeDirectClaim = nodeByName(
    workflow,
    "Mark Active Direct Review Claims"
  );
  assert.deepEqual(activeDirectClaim.parameters.columns.matchingColumns, [
    "state_guard"
  ]);
  const activeDirectCommit = nodeByName(
    workflow,
    "Update Active Direct Review Actions"
  );
  assert.deepEqual(activeDirectCommit.parameters.columns.matchingColumns, [
    "processing_commit_guard"
  ]);
  assertDirectConnection(
    workflow,
    "Mark Active Direct Review Claims",
    "Aggregate Active Direct Review Claim Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Direct Review Claim Marks",
    "Get Active After Direct Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Active After Direct Review Claims",
    "Aggregate Active After Direct Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active After Direct Review Claims",
    "Prepare Claimed Active Direct Review Updates"
  );
  const archiveDirectClaim = nodeByName(
    workflow,
    "Mark Archive Direct Review Claims"
  );
  assert.deepEqual(archiveDirectClaim.parameters.columns.matchingColumns, [
    "state_guard"
  ]);
  const archiveDirectCommit = nodeByName(
    workflow,
    "Update Archive Direct Review Actions"
  );
  assert.deepEqual(archiveDirectCommit.parameters.columns.matchingColumns, [
    "processing_commit_guard"
  ]);
  assertDirectConnection(
    workflow,
    "Mark Archive Direct Review Claims",
    "Aggregate Archive Direct Review Claim Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive Direct Review Claim Marks",
    "Get Archive After Direct Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Archive After Direct Review Claims",
    "Aggregate Archive After Direct Review Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive After Direct Review Claims",
    "Prepare Claimed Archive Direct Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Review Updates",
    "Has Active Applied Jobs Updates"
  );
  assertDirectConnection(
    workflow,
    "Mark Active Applied Jobs Claims",
    "Aggregate Active Applied Jobs Claim Marks"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Applied Jobs Claim Marks",
    "Get Active After Applied Jobs Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Active After Applied Jobs Claims",
    "Aggregate Active After Applied Jobs Claims"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active After Applied Jobs Claims",
    "Prepare Claimed Active Applied Jobs Updates"
  );
  assertDirectConnection(
    workflow,
    "Prepare Claimed Active Applied Jobs Updates",
    "Update Active Applied Jobs Actions"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Applied Jobs Updates",
    "Has Active Direct Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active Direct Review Updates",
    "Has Archive Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive Review Updates",
    "Has Archive Direct Review Updates"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive Direct Review Updates",
    "Get Active After Review"
  );

  for (const field of [
    "processing_commit_guard",
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
      field in nodeByName(workflow, "Update Archive Direct Review Actions")
        .parameters.columns.value,
      `archive direct reviewer commit is missing ${field}`
    );
  }
  for (const nodeName of [
    "Update Active Applied Jobs Actions",
    "Update Archive Review Actions"
  ]) {
    const values = nodeByName(workflow, nodeName).parameters.columns.value;
    for (const field of [
      "state_guard",
      "processing_commit_guard",
      "processing_stage",
      "processing_token",
      "processing_started_at",
      "outcome",
      "outcome_at",
      "outcome_events",
      "updated_at"
    ]) {
      assert.ok(field in values, `${nodeName} is missing ${field}`);
    }
    for (const field of [
      "manual_action",
      "apply_points_input",
      "apply_points_used",
      "application_posting_age_days"
    ]) {
      assert.ok(!(field in values), `${nodeName} rewrites ${field}`);
    }
  }

  const reconciliation = nodeByName(
    workflow,
    "Prepare Review Queue Reconciliation"
  ).parameters.jsCode;
  assert.match(reconciliation, /reconcileReviewQueue\(/);
  assert.match(reconciliation, /reconcileAppliedJobs\(/);
  assert.doesNotMatch(reconciliation, /confirmedCommitGuards/);
  assert.match(reconciliation, /sourceWriteConfirmed/);
  assert.match(reconciliation, /protected_action_count/);
  assert.match(reconciliation, /unchanged_row_count/);
  assert.match(reconciliation, /review_queue_unchanged/);
  assert.match(reconciliation, /invalid_records/);
  const finalCleanup = nodeByName(
    workflow,
    "Finalize Applied Jobs Cleanup"
  ).parameters.jsCode;
  assert.match(finalCleanup, /finalizeAppliedJobsCleanup\(/);
  assert.match(finalCleanup, /projectionActionSnapshot/);
  const rebase = nodeByName(
    workflow,
    "Refresh Protected Applied Jobs Rows"
  );
  assert.equal(rebase.parameters.operation, "update");
  assert.deepEqual(rebase.parameters.columns.matchingColumns, [
    "canonical_job_id"
  ]);
  assert.ok(!("Action" in rebase.parameters.columns.value));
  for (const field of review.applied_jobs.fields.filter(
    (field) => field !== "Action"
  )) {
    assert.ok(field in rebase.parameters.columns.value);
  }
  const deleteRows = nodeByName(
    workflow,
    "Retire Unchanged Review Queue Rows"
  );
  assert.equal(deleteRows.type, "n8n-nodes-base.httpRequest");
  assert.equal(deleteRows.parameters.method, "POST");
  assert.match(deleteRows.parameters.url, /:batchUpdate$/);
  assert.equal(deleteRows.retryOnFail, false);
  const queueCleanup = nodeByName(
    workflow,
    "Prepare Review Queue Atomic Cleanup"
  ).parameters.jsCode;
  assert.match(queueCleanup, /queue_delete_snapshots/);
  assert.match(queueCleanup, /deleteDuplicates/);
  assert.match(queueCleanup, /comparisonColumns/);
  assert.match(queueCleanup, /deleteDimension/);
  const appendRows = nodeByName(workflow, "Append Review Queue Rows");
  assert.equal(appendRows.parameters.operation, "append");
  assert.equal(appendRows.parameters.sheetName.value, review.review_queue.sheet);
  assert.deepEqual(
    Object.keys(appendRows.parameters.columns.value),
    review.review_queue.fields
  );
  assert.match(
    appendRows.parameters.columns.value["Job title"],
    /\$json\["Job title"\]/
  );
  assert.doesNotMatch(
    appendRows.parameters.columns.value["Job title"],
    /\$json\.Job title/
  );
  const clearAppliedRows = nodeByName(
    workflow,
    "Clear Stale Applied Jobs Rows"
  );
  assert.equal(clearAppliedRows.parameters.operation, "update");
  assert.deepEqual(clearAppliedRows.parameters.columns.matchingColumns, [
    "canonical_job_id"
  ]);
  assert.ok(!("Action" in clearAppliedRows.parameters.columns.value));
  assert.ok("source_state_guard" in clearAppliedRows.parameters.columns.value);
  assert.ok(!("row_number" in clearAppliedRows.parameters.columns.value));
  assert.equal(
    clearAppliedRows.parameters.sheetName.value,
    review.applied_jobs.sheet
  );
  const upsertAppliedRows = nodeByName(workflow, "Upsert Applied Jobs Rows");
  assert.equal(upsertAppliedRows.parameters.operation, "appendOrUpdate");
  assert.deepEqual(upsertAppliedRows.parameters.columns.matchingColumns, [
    "canonical_job_id"
  ]);
  assert.equal(
    upsertAppliedRows.parameters.sheetName.value,
    review.applied_jobs.sheet
  );
  assert.deepEqual(
    Object.keys(upsertAppliedRows.parameters.columns.value),
    review.applied_jobs.fields.filter((field) => field !== "Action")
  );
  assert.ok(!("row_number" in upsertAppliedRows.parameters.columns.value));
  assert.equal(
    workflow.nodes.some(
      (node) =>
        node.parameters?.operation === "delete" &&
        node.parameters?.sheetName?.value === review.applied_jobs.sheet
    ),
    false
  );
  assert.equal(
    workflow.settings.executionTimeout,
    review.execution_timeout_seconds
  );
  const projectionClaim = nodeByName(
    workflow,
    "Prepare Applied Jobs Projection Claim"
  ).parameters.jsCode;
  assert.match(projectionClaim, /applied_jobs_projection/);
  assert.match(projectionClaim, /createProcessingClaim/);
  assert.match(
    projectionClaim,
    new RegExp(String(review.projection_claim_lease_ms))
  );
  const claimWinner = nodeByName(
    workflow,
    "Keep Winning Applied Jobs Projection Claim"
  ).parameters.jsCode;
  assert.match(claimWinner, /chooseWinningClaims/);
  const claimAppend = nodeByName(
    workflow,
    "Append Applied Jobs Projection Claim"
  );
  assert.equal(claimAppend.parameters.operation, "append");
  assert.equal(
    claimAppend.parameters.sheetName.value,
    review.claims_sheet
  );
  assert.equal(
    workflow.meta.claimRetentionPolicyVersion,
    claimRetentionPolicy.policy_version
  );
  const claimCleanupPlan = nodeByName(
    workflow,
    "Plan Processing Claims Cleanup"
  ).parameters.jsCode;
  assert.match(claimCleanupPlan, /claim_retention_plan/);
  assert.match(claimCleanupPlan, /processing_claim_cleanup_plan/);
  const initialPlan = nodeByName(
    workflow,
    "Prepare Review Plan"
  ).parameters.jsCode;
  assert.match(initialPlan, /planProcessingClaimRetention/);
  assert.match(initialPlan, /reviewSnapshotStatus/);
  assert.match(initialPlan, /buildReviewQueueProjection/);
  assert.match(initialPlan, /buildAppliedJobsProjection/);
  assert.match(
    initialPlan,
    new RegExp(claimRetentionPolicy.policy_version.replace("/", "\\/"))
  );
  const prepareClaimCleanup = nodeByName(
    workflow,
    "Prepare Processing Claims Batch Cleanup"
  ).parameters.jsCode;
  assert.match(prepareClaimCleanup, /deleteDimension/);
  assert.match(prepareClaimCleanup, /startIndex: range\.start_index/);
  assert.match(prepareClaimCleanup, /endIndex: range\.end_index/);
  const deleteClaims = nodeByName(
    workflow,
    "Delete Expired Processing Claims"
  );
  assert.equal(deleteClaims.parameters.method, "POST");
  assert.match(deleteClaims.parameters.url, /:batchUpdate$/);
  assert.equal(
    deleteClaims.parameters.nodeCredentialType,
    "googleSheetsOAuth2Api"
  );
  assert.equal(deleteClaims.retryOnFail, false);
  assert.equal(deleteClaims.continueOnFail, undefined);
  const atomicCleanup = nodeByName(
    workflow,
    "Prepare Applied Jobs Atomic Cleanup"
  ).parameters.jsCode;
  assert.match(atomicCleanup, /sortRange/);
  assert.match(atomicCleanup, /insertDimension/);
  assert.match(atomicCleanup, /deleteDuplicates/);
  assert.match(atomicCleanup, /comparisonColumns/);
  assert.match(atomicCleanup, /updateCells/);
  assert.match(atomicCleanup, /deleteDimension/);
  assert.match(atomicCleanup, /identityFoldCounts/);
  assert.match(atomicCleanup, /toLocaleLowerCase\('en-US'\)/);
  assert.ok(
    atomicCleanup.indexOf("deleteDuplicates") <
      atomicCleanup.indexOf("deleteDimension")
  );
  assert.match(
    atomicCleanup,
    /dimensionIndex: 0, sortOrder: 'DESCENDING'[\s\S]*dimensionIndex: 8, sortOrder: 'ASCENDING'/
  );
  assert.match(atomicCleanup, /source_state_guard/);
  assert.match(atomicCleanup, /tombstoneIdentities/);
  const batchUpdate = nodeByName(
    workflow,
    "Sort and Retire Applied Jobs Rows"
  );
  assert.equal(batchUpdate.parameters.method, "POST");
  assert.match(batchUpdate.parameters.url, /:batchUpdate$/);
  assert.equal(batchUpdate.retryOnFail, false);
  assert.equal(
    batchUpdate.parameters.nodeCredentialType,
    "googleSheetsOAuth2Api"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Applied Jobs Rows",
    "Get Dashboard Rows"
  );
  assertDirectConnection(
    workflow,
    "Get Dashboard Rows",
    "Aggregate Dashboard Rows"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Dashboard Rows",
    "Get Processing Claims for Retention"
  );
  assertDirectConnection(
    workflow,
    "Get Processing Claims for Retention",
    "Prepare Review Plan"
  );
  assertDirectConnection(
    workflow,
    "Prepare Review Plan",
    "Has Review Snapshot Changes"
  );
  assertDirectConnection(
    workflow,
    "Has Review Snapshot Changes",
    "Log Unchanged Review Snapshot"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Active After Review",
    "Get Archive After Review"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive After Review",
    "Get Review Queue After Review"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Archive After Review",
    "Prepare Funnel Summary"
  );
  assert.equal(
    connectionTargets(workflow, "Prepare Review Plan").includes(
      "Prepare Funnel Summary"
    ),
    false
  );
  assertDirectConnection(
    workflow,
    "Aggregate Current Applied Jobs",
    "Prepare Review Queue Reconciliation"
  );
  assertDirectConnection(
    workflow,
    "Prepare Review Queue Reconciliation",
    "Prepare Applied Jobs Projection Claim"
  );
  assertDirectConnection(
    workflow,
    "Append Applied Jobs Projection Claim",
    "Get Applied Jobs Projection Claims"
  );
  assertDirectConnection(
    workflow,
    "Get Applied Jobs Projection Claims",
    "Keep Winning Applied Jobs Projection Claim"
  );
  assertDirectConnection(
    workflow,
    "Keep Winning Applied Jobs Projection Claim",
    "Get Applied Jobs Before Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Keep Winning Applied Jobs Projection Claim",
    "Plan Processing Claims Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Plan Processing Claims Cleanup",
    "Get Processing Claims Sheet Metadata"
  );
  assertDirectConnection(
    workflow,
    "Get Processing Claims Sheet Metadata",
    "Prepare Processing Claims Batch Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Prepare Processing Claims Batch Cleanup",
    "Delete Expired Processing Claims"
  );
  assertDirectConnection(
    workflow,
    "Delete Expired Processing Claims",
    "Log Processing Claims Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Get Applied Jobs Before Cleanup",
    "Aggregate Applied Jobs Before Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Applied Jobs Before Cleanup",
    "Finalize Applied Jobs Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Finalize Applied Jobs Cleanup",
    "Has Applied Jobs Rebases"
  );
  assertDirectConnection(
    workflow,
    "Prepare Applied Jobs Rebases",
    "Refresh Protected Applied Jobs Rows"
  );
  assertDirectConnection(
    workflow,
    "Refresh Protected Applied Jobs Rows",
    "Aggregate Applied Jobs Rebases"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Applied Jobs Rebases",
    "Has Applied Jobs Clears"
  );
  assertDirectConnection(
    workflow,
    "Keep Winning Applied Jobs Projection Claim",
    "Has Review Queue Deletions"
  );
  assertDirectConnection(
    workflow,
    "Get Review Queue Sheet Metadata",
    "Prepare Review Queue Atomic Cleanup"
  );
  assertDirectConnection(
    workflow,
    "Prepare Review Queue Atomic Cleanup",
    "Retire Unchanged Review Queue Rows"
  );
  assertDirectConnection(
    workflow,
    "Retire Unchanged Review Queue Rows",
    "Aggregate Review Queue Deletions"
  );
  assertDirectConnection(
    workflow,
    "Prepare Review Queue Appends",
    "Append Review Queue Rows"
  );
  assertDirectConnection(
    workflow,
    "Clear Stale Applied Jobs Rows",
    "Aggregate Applied Jobs Clears"
  );
  assertDirectConnection(
    workflow,
    "Prepare Applied Jobs Upserts",
    "Upsert Applied Jobs Rows"
  );
  assertDirectConnection(
    workflow,
    "Upsert Applied Jobs Rows",
    "Aggregate Applied Jobs Upserts"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Applied Jobs Upserts",
    "Get Applied Jobs After Maintenance"
  );
  assert.equal(
    nodeByName(
      workflow,
      "Aggregate Applied Jobs Upserts"
    ).parameters.aggregate,
    "aggregateAllItemData"
  );
  assertDirectConnection(
    workflow,
    "Aggregate Applied Jobs After Maintenance",
    "Get Applied Jobs Sheet Metadata"
  );
  assertDirectConnection(
    workflow,
    "Prepare Applied Jobs Atomic Cleanup",
    "Sort and Retire Applied Jobs Rows"
  );

  const dashboard = nodeByName(workflow, "Update Dashboard Summary");
  const dashboardRead = nodeByName(workflow, "Get Dashboard Rows");
  assert.equal(
    dashboardRead.parameters.sheetName.value,
    review.dashboard_sheet
  );
  assert.equal(
    dashboardRead.parameters.options.outputFormatting.values.general,
    "FORMULA"
  );
  const retentionRead = nodeByName(
    workflow,
    "Get Processing Claims for Retention"
  );
  assert.equal(retentionRead.parameters.sheetName.value, review.claims_sheet);
  const funnelSummary = nodeByName(
    workflow,
    "Prepare Funnel Summary"
  ).parameters.jsCode;
  assert.match(funnelSummary, /\$\('Aggregate Active After Review'\)/);
  assert.match(funnelSummary, /\$\('Aggregate Archive After Review'\)/);
  assert.doesNotMatch(funnelSummary, /\$\('Aggregate Active Rows'\)/);
  assert.doesNotMatch(funnelSummary, /\$\('Aggregate Archive Rows'\)/);
  assert.match(funnelSummary, /reusableFunnelSummary/);
  assertDirectConnection(
    workflow,
    "Prepare Funnel Summary",
    "Has Dashboard Changes"
  );
  assertDirectConnection(
    workflow,
    "Has Dashboard Changes",
    "Update Dashboard Summary"
  );
  assert.equal(
    connectionTargets(workflow, "Prepare Funnel Summary").includes(
      "Update Dashboard Summary"
    ),
    false
  );
  assert.equal(dashboard.parameters.operation, "appendOrUpdate");
  assert.deepEqual(dashboard.parameters.columns.matchingColumns, ["metric_key"]);
  assert.equal(dashboard.parameters.sheetName.value, review.dashboard_sheet);
  assert.equal(workflow.meta.reviewQueueVersion, review.review_queue.version);
  assert.equal(workflow.meta.appliedJobsVersion, review.applied_jobs.version);
});

test("Review Queue atomic retirement includes Action in the unchanged-row template", async () => {
  const code = nodeByName(
    workflows.reviewer,
    "Prepare Review Queue Atomic Cleanup"
  ).parameters.jsCode;
  const execute = new Function(
    "$input",
    "$",
    `"use strict"; return (async () => { ${code} })();`
  );
  const snapshot = Object.fromEntries(
    review.review_queue.fields.map((field) => [field, ""])
  );
  snapshot.Status = "ready";
  snapshot.Score = 88;
  snapshot["Job title"] = "Atomic queue test";
  snapshot.canonical_job_id = "onlinejobs.ph:atomic-queue";
  snapshot.source_state_guard = "guard:atomic-queue";
  snapshot.row_number = 4;
  const result = await execute(
    {
      first: () => ({
        json: {
          sheets: [
            {
              properties: {
                title: review.review_queue.sheet,
                sheetId: 29
              }
            }
          ]
        }
      })
    },
    (name) => {
      assert.equal(name, "Prepare Review Queue Reconciliation");
      return {
        first: () => ({
          json: {
            queue_delete_snapshots: [snapshot],
            queue_max_row_number: 4
          }
        })
      };
    }
  );
  const requests = result[0].json.batch_update.requests;
  assert.deepEqual(
    requests.map((request) => Object.keys(request)[0]),
    [
      "insertDimension",
      "updateCells",
      "deleteDuplicates",
      "deleteDimension"
    ]
  );
  const actionIndex = review.review_queue.fields.indexOf("Action");
  assert.deepEqual(
    requests[1].updateCells.rows[0].values[actionIndex],
    {}
  );
  assert.equal(
    requests[2].deleteDuplicates.comparisonColumns.length,
    review.review_queue.fields.length
  );
  assert.deepEqual(requests[3], {
    deleteDimension: {
      range: {
        sheetId: 29,
        dimension: "ROWS",
        startIndex: 1,
        endIndex: 2
      }
    }
  });

  await assert.rejects(
    execute(
      {
        first: () => ({
          json: {
            sheets: [
              {
                properties: {
                  title: review.review_queue.sheet,
                  sheetId: 29
                }
              }
            ]
          }
        })
      },
      () => ({
        first: () => ({
          json: {
            queue_delete_snapshots: [
              snapshot,
              {
                ...snapshot,
                canonical_job_id: "ONLINEJOBS.PH:ATOMIC-QUEUE",
                "Job title": "Conflicting duplicate"
              }
            ],
            queue_max_row_number: 5
          }
        })
      })
    ),
    /snapshot identities are ambiguous/
  );
});

test("Applied Jobs atomic retirement templates are case-fold unique and delete only themselves", async () => {
  const code = nodeByName(
    workflows.reviewer,
    "Prepare Applied Jobs Atomic Cleanup"
  ).parameters.jsCode;
  const execute = new Function(
    "$input",
    "$",
    `"use strict"; return (async () => { ${code} })();`
  );
  const blankRow = (identity, action = "") => ({
    "Applied at": "",
    "Job title": "",
    Company: "",
    "Generated message": "",
    "Job link": "",
    "Current outcome": "",
    "Outcome updated at": "",
    Action: action,
    canonical_job_id: identity,
    source_state_guard: ""
  });
  const rows = [
    blankRow("onlinejobs.ph:CaseVariant"),
    blankRow("onlinejobs.ph:casevariant"),
    blankRow("onlinejobs.ph:unique-retirement"),
    blankRow("onlinejobs.ph:protected-action", "Offer")
  ];
  const result = await execute(
    {
      first: () => ({
        json: {
          sheets: [{ properties: { title: review.applied_jobs.sheet, sheetId: 31 } }]
        }
      })
    },
    (name) => {
      assert.equal(name, "Aggregate Applied Jobs After Maintenance");
      return { first: () => ({ json: { applied_jobs_rows: rows } }) };
    }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].json.applied_jobs_retirement_candidates, 1);
  const requests = result[0].json.batch_update.requests;
  assert.deepEqual(
    requests[1].updateCells.rows.map(
      (row) => row.values[0].userEnteredValue.stringValue
    ),
    ["onlinejobs.ph:unique-retirement"]
  );
  assert.deepEqual(requests[3], {
    deleteDimension: {
      range: {
        sheetId: 31,
        dimension: "ROWS",
        startIndex: 1,
        endIndex: 2
      }
    }
  });
  assert.deepEqual(requests.at(-1).sortRange.sortSpecs, [
    { dimensionIndex: 0, sortOrder: "DESCENDING" },
    { dimensionIndex: 8, sortOrder: "ASCENDING" }
  ]);
});

test("analytics export publishes completion only after every idempotent detail write", () => {
  const workflow = workflows.analytics;
  for (const name of [
    "Prepare Analytics Store Claim",
    "Append Analytics Store Claim",
    "Get Processing Claims",
    "Keep Winning Analytics Store Claim",
    "Get Analytics Reports",
    "Aggregate Analytics Reports",
    "Get Active Rows",
    "Get Archive Rows",
    "Build Analytics Report",
    "Should Publish Analytics Report",
    "Prepare Analytics Rows",
    "Upsert Analytics Rows",
    "Aggregate Analytics Row Writes",
    "Prepare Analytics Completion",
    "Publish Complete Analytics Report",
    "Plan Analytics Retention Candidates",
    "Get Analytics Reports for Retention",
    "Get Analytics Detail for Retention",
    "Plan Analytics Report Retention",
    "Delete Expired Analytics Reports"
  ]) {
    nodeByName(workflow, name);
  }
  assertDirectConnection(
    workflow,
    "Schedule Trigger",
    "Prepare Analytics Store Claim"
  );
  assertDirectConnection(
    workflow,
    "Keep Winning Analytics Store Claim",
    "Get Analytics Reports"
  );
  const claimAppend = nodeByName(workflow, "Append Analytics Store Claim");
  assert.equal(claimAppend.parameters.operation, "append");
  assert.equal(claimAppend.parameters.sheetName.value, review.claims_sheet);
  const claimCode = nodeByName(
    workflow,
    "Prepare Analytics Store Claim"
  ).parameters.jsCode;
  assert.match(claimCode, /createProcessingClaim/);
  assert.match(
    claimCode,
    new RegExp(reportRetentionPolicy.analytics.claim_stage)
  );
  assert.match(
    nodeByName(
      workflow,
      "Keep Winning Analytics Store Claim"
    ).parameters.jsCode,
    /chooseWinningClaims/
  );
  const reports = nodeByName(workflow, "Get Analytics Reports");
  assert.equal(reports.parameters.sheetName.value, analyticsPolicy.reports_sheet);
  assert.equal(reports.parameters.operation, "read");
  assert.equal(reports.onError, "continueRegularOutput");
  assertDirectConnection(
    workflow,
    "Aggregate Analytics Reports",
    "Get Active Rows"
  );
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
    "Build Analytics Report",
    "Should Publish Analytics Report"
  );
  assertDirectConnection(
    workflow,
    "Should Publish Analytics Report",
    "Prepare Analytics Rows"
  );
  assert.deepEqual(
    workflow.connections["Should Publish Analytics Report"].main[1],
    [
      {
        node: "Plan Analytics Retention Candidates",
        type: "main",
        index: 0
      }
    ]
  );
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
  assertDirectConnection(
    workflow,
    "Publish Complete Analytics Report",
    "Plan Analytics Retention Candidates"
  );
  assertDirectConnection(
    workflow,
    "Plan Analytics Retention Candidates",
    "Get Analytics Reports for Retention"
  );
  assertDirectConnection(
    workflow,
    "Plan Analytics Report Retention",
    "Get Analytics Retention Sheet Metadata"
  );
  assertDirectConnection(
    workflow,
    "Prepare Analytics Retention Batch",
    "Delete Expired Analytics Reports"
  );
  const retentionReports = nodeByName(
    workflow,
    "Get Analytics Reports for Retention"
  );
  const retentionDetails = nodeByName(
    workflow,
    "Get Analytics Detail for Retention"
  );
  for (const node of [retentionReports, retentionDetails]) {
    assert.equal(
      node.parameters.options.outputFormatting.values.general,
      "FORMULA"
    );
    assert.equal(node.onError, undefined);
  }
  const retentionPlan = nodeByName(
    workflow,
    "Plan Analytics Report Retention"
  ).parameters.jsCode;
  assert.match(retentionPlan, /planReportRetention/);
  assert.match(retentionPlan, /analytics_row_id/);
  const retentionBatch = nodeByName(
    workflow,
    "Delete Expired Analytics Reports"
  );
  assert.equal(retentionBatch.retryOnFail, false);
  assert.match(retentionBatch.parameters.url, /:batchUpdate$/);
  assert.equal(
    workflow.meta.reportRetentionPolicyVersion,
    reportRetentionPolicy.policy_version
  );
  assert.equal(
    workflow.meta.reportStoreClaimLeaseMs,
    reportRetentionPolicy.analytics.claim_lease_ms
  );
  const build = nodeByName(workflow, "Build Analytics Report").parameters.jsCode;
  assert.match(build, /buildAnalyticsReport/);
  assert.match(build, /application_opportunity_score/);
  assert.match(build, /outcome_events/);
  assert.match(build, /multi_touch_full_credit/);
  assert.match(build, /reusableAnalyticsReport/);
  assert.match(build, /reportHistoryReadFailed/);
  assert.match(build, /history_read_failed: reportHistoryReadFailed/);
  assert.doesNotMatch(build, /analytics report store could not be read/);
  assert.match(build, /publish_required: publishRequired/);
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
    "Prepare Recommendation Store Claim",
    "Append Recommendation Store Claim",
    "Get Processing Claims",
    "Keep Winning Recommendation Store Claim",
    "Get Recommendation Reports",
    "Aggregate Recommendation Reports",
    "Get Analytics Reports",
    "Aggregate Analytics Reports",
    "Get Analytics Detail",
    "Build Weekly Recommendations",
    "Should Publish Recommendation Report",
    "Prepare Recommendation Rows",
    "Upsert Recommendation Rows",
    "Aggregate Recommendation Row Writes",
    "Prepare Recommendation Report",
    "Publish Recommendation Report",
    "Plan Recommendation Retention Candidates",
    "Get Recommendation Reports for Retention",
    "Get Recommendation Detail for Retention",
    "Plan Recommendation Report Retention",
    "Delete Expired Recommendation Reports"
  ]) {
    nodeByName(workflow, name);
  }
  assertDirectConnection(
    workflow,
    "Schedule Trigger",
    "Prepare Recommendation Store Claim"
  );
  assertDirectConnection(
    workflow,
    "Keep Winning Recommendation Store Claim",
    "Get Recommendation Reports"
  );
  const claimAppend = nodeByName(
    workflow,
    "Append Recommendation Store Claim"
  );
  assert.equal(claimAppend.parameters.operation, "append");
  assert.equal(claimAppend.parameters.sheetName.value, review.claims_sheet);
  const claimCode = nodeByName(
    workflow,
    "Prepare Recommendation Store Claim"
  ).parameters.jsCode;
  assert.match(claimCode, /createProcessingClaim/);
  assert.match(
    claimCode,
    new RegExp(reportRetentionPolicy.recommendations.claim_stage)
  );
  assert.match(
    nodeByName(
      workflow,
      "Keep Winning Recommendation Store Claim"
    ).parameters.jsCode,
    /chooseWinningClaims/
  );

  const previousReports = nodeByName(workflow, "Get Recommendation Reports");
  assert.equal(
    previousReports.parameters.sheetName.value,
    recommendationPolicy.reports_sheet
  );
  assert.equal(previousReports.parameters.operation, "read");
  assert.equal(previousReports.onError, "continueRegularOutput");
  assertDirectConnection(
    workflow,
    "Aggregate Recommendation Reports",
    "Get Analytics Reports"
  );
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
    "Build Weekly Recommendations",
    "Should Publish Recommendation Report"
  );
  assertDirectConnection(
    workflow,
    "Should Publish Recommendation Report",
    "Prepare Recommendation Rows"
  );
  assert.deepEqual(
    workflow.connections["Should Publish Recommendation Report"].main[1],
    [
      {
        node: "Plan Recommendation Retention Candidates",
        type: "main",
        index: 0
      }
    ]
  );
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
  assertDirectConnection(
    workflow,
    "Publish Recommendation Report",
    "Plan Recommendation Retention Candidates"
  );
  assertDirectConnection(
    workflow,
    "Plan Recommendation Retention Candidates",
    "Get Recommendation Reports for Retention"
  );
  assertDirectConnection(
    workflow,
    "Plan Recommendation Report Retention",
    "Get Recommendation Retention Sheet Metadata"
  );
  assertDirectConnection(
    workflow,
    "Prepare Recommendation Retention Batch",
    "Delete Expired Recommendation Reports"
  );
  const retentionReports = nodeByName(
    workflow,
    "Get Recommendation Reports for Retention"
  );
  const retentionDetails = nodeByName(
    workflow,
    "Get Recommendation Detail for Retention"
  );
  for (const node of [retentionReports, retentionDetails]) {
    assert.equal(
      node.parameters.options.outputFormatting.values.general,
      "FORMULA"
    );
    assert.equal(node.onError, undefined);
  }
  const retentionPlan = nodeByName(
    workflow,
    "Plan Recommendation Report Retention"
  ).parameters.jsCode;
  assert.match(retentionPlan, /planReportRetention/);
  assert.match(retentionPlan, /recommendation_id/);
  const retentionBatch = nodeByName(
    workflow,
    "Delete Expired Recommendation Reports"
  );
  assert.equal(retentionBatch.retryOnFail, false);
  assert.match(retentionBatch.parameters.url, /:batchUpdate$/);
  assert.equal(
    workflow.meta.reportRetentionPolicyVersion,
    reportRetentionPolicy.policy_version
  );
  assert.equal(
    workflow.meta.reportStoreClaimLeaseMs,
    reportRetentionPolicy.recommendations.claim_lease_ms
  );

  const build = nodeByName(
    workflow,
    "Build Weekly Recommendations"
  ).parameters.jsCode;
  assert.match(build, /latestCompleteAnalyticsReport/);
  assert.match(build, /buildRecommendationReport/);
  assert.match(build, /buildRecommendationFailure/);
  assert.match(build, /reusableRecommendationReport/);
  assert.match(build, /history_read_failed: recommendationReportReadFailed/);
  assert.match(build, /publish_required: publishRequired/);
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
    workflow.nodes.some((node) => /slack|telegram|email/i.test(node.name)),
    false,
    "optional delivery must not become an authoritative write path"
  );
  assert.ok(
    workflow.nodes
      .filter((node) => node.type === "n8n-nodes-base.httpRequest")
      .every(
        (node) =>
          /Retention Sheet Metadata|Delete Expired Recommendation Reports/.test(
            node.name
          ) &&
          /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//.test(
            node.parameters.url
          )
      ),
    "recommender HTTP requests must be restricted to report retention"
  );
});

test("report retention batches delete detail and metadata atomically by their own sheet IDs", async () => {
  const cases = [
    {
      workflow: workflows.analytics,
      node: "Prepare Analytics Retention Batch",
      planNode: "Plan Analytics Report Retention",
      detailSheet: analyticsPolicy.detail_sheet,
      reportsSheet: analyticsPolicy.reports_sheet
    },
    {
      workflow: workflows.recommender,
      node: "Prepare Recommendation Retention Batch",
      planNode: "Plan Recommendation Report Retention",
      detailSheet: recommendationPolicy.recommendations_sheet,
      reportsSheet: recommendationPolicy.reports_sheet
    }
  ];
  for (const candidate of cases) {
    const code = nodeByName(
      candidate.workflow,
      candidate.node
    ).parameters.jsCode;
    const execute = new Function(
      "$input",
      "$",
      `"use strict"; return (async () => { ${code} })();`
    );
    const plan = {
      policy_version: reportRetentionPolicy.policy_version,
      retention_cutoff_at: "2026-01-01T00:00:00.000Z",
      counts: { selected: 2 },
      detail_delete_ranges: [
        { start_index: 9, end_index: 12 },
        { start_index: 3, end_index: 5 }
      ],
      report_delete_ranges: [{ start_index: 4, end_index: 6 }]
    };
    const result = await execute(
      {
        first: () => ({
          json: {
            sheets: [
              {
                properties: {
                  title: candidate.detailSheet,
                  sheetId: 41
                }
              },
              {
                properties: {
                  title: candidate.reportsSheet,
                  sheetId: 42
                }
              }
            ]
          }
        })
      },
      (name) => {
        assert.equal(name, candidate.planNode);
        return { first: () => ({ json: plan }) };
      }
    );
    assert.deepEqual(
      result[0].json.batch_update.requests.map(
        (request) => request.deleteDimension.range
      ),
      [
        {
          sheetId: 41,
          dimension: "ROWS",
          startIndex: 9,
          endIndex: 12
        },
        {
          sheetId: 41,
          dimension: "ROWS",
          startIndex: 3,
          endIndex: 5
        },
        {
          sheetId: 42,
          dimension: "ROWS",
          startIndex: 4,
          endIndex: 6
        }
      ]
    );
    assert.equal(result[0].json.reports_deleted, 2);
    assert.equal(result[0].json.detail_rows_deleted, 5);
  }
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
