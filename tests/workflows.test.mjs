import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const profile = await loadJson("../config/candidate-profile.json");
const policy = await loadJson("../config/application-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");
const searchPlan = await loadJson("../config/search-plan.json");
const runtime = await loadJson("../config/runtime.json");
const review = await loadJson("../config/review-sheet.json");

const workflows = Object.fromEntries(
  await Promise.all(
    ["scraper", "generator", "archiver", "reviewer"].map(async (name) => [
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
    "Prepare Application Prompt",
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
  assertDirectConnection(workflow, "Prepare Application Prompt", "AI Agent");
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
  assert.ok(
    workflow.nodes.every(
      (node) =>
        !/submit application|auto.?apply/i.test(node.name) &&
        !/\/apply(?:\\b|\/)/i.test(String(node.parameters?.url ?? ""))
    ),
    "no workflow node may submit an application"
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
  assert.deepEqual(review.editable_columns, ["manual_action", "notes"]);
  const prepare = nodeByName(workflow, "Prepare Active Review Updates").parameters.jsCode;
  assert.match(prepare, /if \(!record\.manual_action\) continue/);
  assert.match(prepare, /unsupported manual action/);
  assert.match(prepare, /pipeline_status: "applied"/);
  assert.match(prepare, /pipeline_status: "skipped"/);
  const dashboard = nodeByName(workflow, "Update Dashboard Summary");
  assert.equal(dashboard.parameters.operation, "appendOrUpdate");
  assert.deepEqual(dashboard.parameters.columns.matchingColumns, ["metric_key"]);
  assert.equal(dashboard.parameters.sheetName.value, review.dashboard_sheet);
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
