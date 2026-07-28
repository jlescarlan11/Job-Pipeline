import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkOnly = process.argv.includes("--check");

const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const readText = async (path) => readFile(resolve(root, path), "utf8");

function stripModuleSyntax(source) {
  return source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "")
    .replace(/^export\s+/gm, "");
}

async function bundledCore(...paths) {
  const sources = [];
  for (const path of paths) sources.push(stripModuleSyntax(await readText(path)));
  return sources.join("\n\n");
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((entry) => entry.name === name);
  if (!node) throw new Error(`Missing node ${name} in ${workflow.name}`);
  return structuredClone(node);
}

function nodeByAnyName(workflow, names) {
  for (const name of names) {
    const node = workflow.nodes.find((entry) => entry.name === name);
    if (node) return structuredClone(node);
  }
  throw new Error(`Missing one of [${names.join(", ")}] in ${workflow.name}`);
}

function codeNode({ id, name, position, jsCode, mode }) {
  return {
    parameters: {
      ...(mode ? { mode } : {}),
      jsCode
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    id,
    name
  };
}

function aggregateNode({ id, name, position, destinationFieldName }) {
  return {
    parameters: {
      aggregate: "aggregateAllItemData",
      destinationFieldName,
      options: {}
    },
    type: "n8n-nodes-base.aggregate",
    typeVersion: 1,
    position,
    id,
    name
  };
}

function schemaColumns(fields) {
  return [
    ...fields.map((field) => ({
      id: field,
      displayName: field,
      required: false,
      defaultMatch: false,
      display: true,
      type: ["match_score", "attempt_count"].includes(field) ? "number" : "string",
      canBeUsedToMatch: true
    })),
    {
      id: "row_number",
      displayName: "row_number",
      required: false,
      defaultMatch: false,
      display: true,
      type: "number",
      canBeUsedToMatch: true,
      readOnly: true
    }
  ];
}

function sheetExpression(field) {
  return `={{ Array.isArray($json.${field}) ? JSON.stringify($json.${field}) : ($json.${field} ?? '') }}`;
}

function appendSheetNode({ base, id, name, position, fields }) {
  const node = structuredClone(base);
  node.id = id;
  node.name = name;
  node.position = position;
  node.parameters.operation = "append";
  node.parameters.columns = {
    mappingMode: "defineBelow",
    value: Object.fromEntries(fields.map((field) => [field, sheetExpression(field)])),
    matchingColumns: [],
    schema: schemaColumns(fields),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };
  return node;
}

function updateSheetNode({ base, id, name, position, fields }) {
  const node = structuredClone(base);
  node.id = id;
  node.name = name;
  node.position = position;
  node.parameters.operation = "update";
  node.parameters.columns = {
    mappingMode: "defineBelow",
    value: {
      row_number: "={{ $json.row_number }}",
      ...Object.fromEntries(fields.map((field) => [field, sheetExpression(field)]))
    },
    matchingColumns: ["row_number"],
    schema: schemaColumns(fields),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };
  return node;
}

function updateSheetByFieldNode({ base, id, name, position, fields, matchingField }) {
  const node = structuredClone(base);
  node.id = id;
  node.name = name;
  node.position = position;
  node.parameters.operation = "update";
  node.parameters.columns = {
    mappingMode: "defineBelow",
    value: {
      [matchingField]: sheetExpression(matchingField),
      ...Object.fromEntries(fields.map((field) => [field, sheetExpression(field)]))
    },
    matchingColumns: [matchingField],
    schema: schemaColumns([...new Set([matchingField, ...fields])]),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };
  return node;
}

function upsertSheetNode({ base, id, name, position, fields, matchingField }) {
  const node = structuredClone(base);
  node.id = id;
  node.name = name;
  node.position = position;
  node.parameters.operation = "appendOrUpdate";
  node.parameters.columns = {
    mappingMode: "defineBelow",
    value: Object.fromEntries(fields.map((field) => [field, sheetExpression(field)])),
    matchingColumns: [matchingField],
    schema: schemaColumns(fields),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };
  return node;
}

function connection(node, index = 0) {
  return { node, type: "main", index };
}

function prepareDiscoveryCode({ core, schema, plan, mode }) {
  const shared = `${core}

const PIPELINE_SCHEMA = ${JSON.stringify(schema)};
const SEARCH_PLAN = ${JSON.stringify(plan)};
const pageResults = $('Aggregate Search Pages').first().json.page_results || [];
const activeRows = $('Aggregate Active Rows').first().json.active_rows || [];
const archiveRows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);
const now = new Date().toISOString();
const reconciliation = reconcileDiscovery(pageResults, activeRows, archiveRows, PIPELINE_SCHEMA, now);
`;
  if (mode === "new") {
    return `${shared}
return reconciliation.new_jobs.map((record) => {
  const workRecord = { ...record, work_stage: 'discovery' };
  const claim = createProcessingClaim(
    workRecord,
    String($execution.id),
    now,
    SEARCH_PLAN.claim_lease_ms
  );
  return {
    json: {
      ...workRecord,
      processing_token: claim.processing_token,
      claim_created_at: claim.created_at,
      claim_expires_at: claim.expires_at
    }
  };
});`;
  }
  if (mode === "active") {
    return `${shared}
return reconciliation.existing_updates
  .filter((update) => update.location === 'active' && update.record.row_number)
  .map((update) => ({ json: update.record }));`;
  }
  if (mode === "archive") {
    return `${shared}
return reconciliation.existing_updates
  .filter((update) => update.location === 'archive' && update.record.row_number)
  .map((update) => ({ json: update.record }));`;
  }
  return `${shared}
const coverage = summarizeCoverage(pageResults, SEARCH_PLAN);
const summary = {
  event: 'discovery_run',
  timestamp: now,
  plan_version: SEARCH_PLAN.plan_version,
  status: coverage.status,
  queries: coverage.queries,
  discovered_unique: reconciliation.discovered_unique,
  new_jobs: reconciliation.new_jobs.length,
  existing_jobs_seen: reconciliation.existing_updates.length,
  malformed_count: reconciliation.malformed_count,
  excluded_count: reconciliation.excluded_count
};
console.log(JSON.stringify(summary));
return [{ json: summary }];`;
}

async function buildScraper() {
  const path = "workflows/scraper.json";
  const current = await readJson(path);
  const schema = await readJson("config/pipeline-schema.json");
  const profile = await readJson("config/candidate-profile.json");
  const plan = await readJson("config/search-plan.json");
  const discoveryCore = await bundledCore("src/contracts.mjs", "src/discovery.mjs");
  const { validateSearchPlan, buildSearchRequests } = await import(
    new URL("../src/discovery.mjs", import.meta.url)
  );
  const planErrors = validateSearchPlan(plan, profile);
  if (planErrors.length > 0) throw new Error(`Invalid search plan:\n- ${planErrors.join("\n- ")}`);
  const requests = buildSearchRequests(plan);

  const schedule = nodeByName(current, "Schedule Trigger");
  schedule.parameters = {
    rule: {
      interval: [{ field: "hours", hoursInterval: plan.schedule_hours }]
    }
  };
  schedule.position = [-1320, 260];

  const fetchPage = nodeByAnyName(current, ["HTTP Request", "Fetch Search Page"]);
  fetchPage.name = "Fetch Search Page";
  fetchPage.position = [-900, 260];
  fetchPage.parameters = {
    url: "={{ $json.request_url }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        {
          name: "User-Agent",
          value:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      ]
    },
    options: {
      batching: {
        batch: {
          batchSize: 1,
          batchInterval: plan.request_interval_ms
        }
      },
      response: {
        response: {
          responseFormat: "text"
        }
      },
      timeout: plan.request_timeout_ms
    }
  };
  fetchPage.retryOnFail = true;
  fetchPage.maxTries = plan.retry.max_attempts;
  fetchPage.waitBetweenTries = plan.retry.backoff_ms;
  fetchPage.onError = "continueRegularOutput";

  const activeRead = nodeByAnyName(current, ["Get row(s) in sheet", "Get Active Rows"]);
  activeRead.name = "Get Active Rows";
  activeRead.position = [-300, 120];

  const archiveRead = nodeByAnyName(current, ["Get rows from Archive", "Get Archive Rows"]);
  archiveRead.name = "Get Archive Rows";
  archiveRead.position = [120, 120];
  archiveRead.alwaysOutputData = true;

  const appendBase = nodeByAnyName(current, [
    "Append row in sheet",
    "Append Discovered Jobs",
    "Get Active Rows"
  ]);
  appendBase.parameters.sheetName = structuredClone(activeRead.parameters.sheetName);
  const archiveUpdateBase = structuredClone(archiveRead);
  const claimsRead = structuredClone(activeRead);
  claimsRead.id = "5b0d6e3f-0eae-4d1e-a0b4-000000000012";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [980, -100];
  claimsRead.parameters.sheetName = {
    __rl: true,
    value: "ProcessingClaims",
    mode: "name",
    cachedResultName: "ProcessingClaims"
  };
  claimsRead.alwaysOutputData = true;

  const claimsAppend = structuredClone(appendBase);
  claimsAppend.id = "5b0d6e3f-0eae-4d1e-a0b4-000000000013";
  claimsAppend.name = "Append Discovery Claims";
  claimsAppend.position = [560, -100];
  claimsAppend.parameters.operation = "append";
  claimsAppend.parameters.sheetName = structuredClone(claimsRead.parameters.sheetName);
  claimsAppend.parameters.columns = {
    mappingMode: "defineBelow",
    value: {
      canonical_job_id: "={{ $json.canonical_job_id }}",
      processing_stage: "discovery",
      processing_token: "={{ $json.processing_token }}",
      created_at: "={{ $json.claim_created_at }}",
      expires_at: "={{ $json.claim_expires_at }}"
    },
    matchingColumns: [],
    schema: schemaColumns([
      "canonical_job_id",
      "processing_stage",
      "processing_token",
      "created_at",
      "expires_at"
    ]),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };

  const workflowFields = schema.fields;
  const seenFields = [
    "source",
    "source_job_id",
    "canonical_job_id",
    "state_guard",
    "canonical_url",
    "search_queries",
    "role_families",
    "last_seen_at",
    "updated_at"
  ];

  const parseCode = `${discoveryCore}

const request = $('Load Search Plan').item.json;
const payload = $json || {};
const errorMessage = payload.error?.message || payload.message || '';
if (errorMessage && !payload.data && !payload.body) {
  return {
    json: {
      ...request,
      ok: false,
      jobs: [],
      excluded: [],
      malformed: [],
      error_category: /429|rate/i.test(errorMessage) ? 'rate_limit' : /timeout/i.test(errorMessage) ? 'timeout' : 'request_failure',
      error_summary: String(errorMessage)
        .replace(/https?:\\/\\/\\S+/gi, '[url]')
        .replace(/(api[_-]?key|token|authorization)\\s*[:=]\\s*\\S+/gi, '$1=[redacted]')
        .slice(0, 200)
    }
  };
}
const html = typeof payload === 'string' ? payload : (payload.data || payload.body || '');
return {
  json: parseSearchResults(html, request, {
    now: new Date().toISOString(),
    lookbackDays: ${plan.lookback_days}
  })
};`;

  const nodes = [
    schedule,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000001",
      name: "Load Search Plan",
      position: [-1120, 260],
      jsCode: `const requests = ${JSON.stringify(requests)};\nreturn requests.map((request) => ({ json: request }));`
    }),
    fetchPage,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000002",
      name: "Parse Search Page",
      position: [-700, 260],
      mode: "runOnceForEachItem",
      jsCode: parseCode
    }),
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000003",
      name: "Aggregate Search Pages",
      position: [-500, 260],
      destinationFieldName: "page_results"
    }),
    activeRead,
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000004",
      name: "Aggregate Active Rows",
      position: [-80, 120],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000005",
      name: "Prepare New Jobs",
      position: [340, -100],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "new" })
    }),
    claimsAppend,
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000014",
      name: "Aggregate Discovery Claims",
      position: [760, -100],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000015",
      name: "Keep Winning Discovery Claims",
      position: [1190, -100],
      jsCode: `${discoveryCore}

const proposed = $('Prepare New Jobs').all().map((item) => item.json);
const claims = $input.all().map((item) => item.json).filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(proposed, claims, new Date().toISOString());
console.log(JSON.stringify({
  event: 'discovery_claims',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000016",
      name: "Prepare Discovery Inserts",
      position: [1400, -100],
      jsCode: `return $input.all().map((item) => {
  const {
    work_stage,
    claim_created_at,
    claim_expires_at,
    ...record
  } = item.json;
  return {
    json: {
      ...record,
      processing_stage: '',
      processing_token: '',
      processing_started_at: ''
    }
  };
});`
    }),
    appendSheetNode({
      base: appendBase,
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000006",
      name: "Append Discovered Jobs",
      position: [1610, -100],
      fields: workflowFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000007",
      name: "Prepare Active Seen Updates",
      position: [340, 80],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "active" })
    }),
    updateSheetNode({
      base: appendBase,
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000008",
      name: "Update Active Seen",
      position: [580, 80],
      fields: seenFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000009",
      name: "Prepare Archive Seen Updates",
      position: [340, 260],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "archive" })
    }),
    updateSheetNode({
      base: archiveUpdateBase,
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000010",
      name: "Update Archive Seen",
      position: [580, 260],
      fields: seenFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000011",
      name: "Log Discovery Summary",
      position: [340, 440],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "summary" })
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Load Search Plan")]] },
    "Load Search Plan": { main: [[connection("Fetch Search Page")]] },
    "Fetch Search Page": { main: [[connection("Parse Search Page")]] },
    "Parse Search Page": { main: [[connection("Aggregate Search Pages")]] },
    "Aggregate Search Pages": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": {
      main: [
        [
          connection("Prepare New Jobs"),
          connection("Prepare Active Seen Updates"),
          connection("Prepare Archive Seen Updates"),
          connection("Log Discovery Summary")
        ]
      ]
    },
    "Prepare New Jobs": { main: [[connection("Append Discovery Claims")]] },
    "Append Discovery Claims": { main: [[connection("Aggregate Discovery Claims")]] },
    "Aggregate Discovery Claims": { main: [[connection("Get Processing Claims")]] },
    "Get Processing Claims": { main: [[connection("Keep Winning Discovery Claims")]] },
    "Keep Winning Discovery Claims": { main: [[connection("Prepare Discovery Inserts")]] },
    "Prepare Discovery Inserts": { main: [[connection("Append Discovered Jobs")]] },
    "Prepare Active Seen Updates": { main: [[connection("Update Active Seen")]] },
    "Prepare Archive Seen Updates": { main: [[connection("Update Archive Seen")]] }
  };

  return {
    path,
    workflow: {
      ...current,
      name: "Job Application Pipeline - Resume-Driven Discovery",
      nodes,
      connections,
      active: false,
      settings: {
        ...current.settings,
        executionOrder: "v1"
      },
      meta: {
        ...current.meta,
        candidateProfileVersion: profile.profile_version,
        searchPlanVersion: plan.plan_version,
        pipelineSchemaVersion: schema.storage_version
      }
    }
  };
}

async function buildGenerator() {
  const path = "workflows/generator.json";
  const current = await readJson(path);
  const profile = await readJson("config/candidate-profile.json");
  const policy = await readJson("config/application-policy.json");
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  const evaluationCore = await bundledCore(
    "src/contracts.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs"
  );
  const { assertValidProfileConfiguration } = await import(
    new URL("../src/profile.mjs", import.meta.url)
  );
  const { buildApplicationSystemMessage } = await import(
    new URL("../src/evaluation.mjs", import.meta.url)
  );
  assertValidProfileConfiguration(profile, policy);
  if (
    runtime.schema_version !== 1 ||
    !Number.isInteger(runtime.generator?.schedule_minutes) ||
    !Number.isInteger(runtime.generator?.per_run_cap) ||
    !Number.isInteger(runtime.generator?.claim_lease_ms) ||
    !Number.isInteger(runtime.generator?.request_retry_backoff_ms)
  ) {
    throw new Error("Invalid generator runtime configuration");
  }

  const schedule = nodeByName(current, "Schedule Trigger");
  schedule.position = [-1540, 180];
  schedule.parameters = {
    rule: {
      interval: [
        {
          field: "minutes",
          minutesInterval: runtime.generator.schedule_minutes
        }
      ]
    }
  };

  const activeRead = nodeByAnyName(current, ["Get row(s) in sheet", "Get Active Rows"]);
  activeRead.name = "Get Active Rows";
  activeRead.position = [-1340, 180];

  const activeUpdateBase = nodeByAnyName(current, [
    "Mark as Processing",
    "Update row in sheet",
    "Get Active Rows"
  ]);
  activeUpdateBase.parameters.sheetName = structuredClone(activeRead.parameters.sheetName);

  const claimsRead = structuredClone(activeRead);
  claimsRead.id = "ee12f5d9-c0d5-4586-bf62-000000000005";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [-480, 180];
  claimsRead.parameters.sheetName = {
    __rl: true,
    value: "ProcessingClaims",
    mode: "name",
    cachedResultName: "ProcessingClaims"
  };
  claimsRead.alwaysOutputData = true;

  const claimsAppend = structuredClone(activeUpdateBase);
  claimsAppend.id = "ee12f5d9-c0d5-4586-bf62-000000000003";
  claimsAppend.name = "Append Processing Claims";
  claimsAppend.position = [-900, 180];
  claimsAppend.parameters.operation = "append";
  claimsAppend.parameters.sheetName = structuredClone(claimsRead.parameters.sheetName);
  const claimFields = [
    "canonical_job_id",
    "processing_stage",
    "processing_token",
    "created_at",
    "expires_at"
  ];
  claimsAppend.parameters.columns = {
    mappingMode: "defineBelow",
    value: {
      canonical_job_id: "={{ $json.canonical_job_id }}",
      processing_stage: "={{ $json.work_stage }}",
      processing_token: "={{ $json.processing_token }}",
      created_at: "={{ $json.claim_created_at }}",
      expires_at: "={{ $json.claim_expires_at }}"
    },
    matchingColumns: [],
    schema: schemaColumns(claimFields),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };

  const fetchDetail = nodeByAnyName(current, ["HTTP Request", "Fetch Job Detail"]);
  fetchDetail.name = "Fetch Job Detail";
  fetchDetail.position = [420, -120];
  fetchDetail.parameters = {
    url: "={{ $('Keep Winning Claims').item.json.canonical_url }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        {
          name: "User-Agent",
          value:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      ]
    },
    options: {
      response: {
        response: {
          responseFormat: "text"
        }
      },
      timeout: runtime.generator.http_timeout_ms
    }
  };
  fetchDetail.retryOnFail = true;
  fetchDetail.maxTries = runtime.generator.retry.max_attempts;
  fetchDetail.waitBetweenTries = runtime.generator.request_retry_backoff_ms;
  fetchDetail.onError = "continueRegularOutput";

  const agent = nodeByName(current, "AI Agent");
  agent.position = [660, 440];
  agent.parameters = {
    promptType: "define",
    text: "={{ $json.application_prompt }}",
    options: {
      systemMessage: buildApplicationSystemMessage(profile, policy),
      batching: {
        batchSize: 1,
        delayBetweenBatches: 20000
      }
    }
  };
  agent.onError = "continueErrorOutput";

  const groq = nodeByName(current, "Groq Chat Model");
  groq.position = [660, 660];

  const prepareCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const POLICY = ${JSON.stringify(policy)};
const SCHEMA = ${JSON.stringify(schema)};
assertValidProfileConfiguration(PROFILE, POLICY);
const now = new Date().toISOString();
const executionId = String($execution.id);
const selected = selectWorkCandidates(
  $input.all().map((item) => item.json),
  SCHEMA,
  {
    now,
    maxItems: ${runtime.generator.per_run_cap},
    leaseMs: ${runtime.generator.claim_lease_ms}
  }
);
return selected.map((record) => {
  const claim = createProcessingClaim(record, executionId, now, ${runtime.generator.claim_lease_ms});
  return {
    json: {
      ...record,
      pipeline_status: record.work_stage === 'evaluation' ? 'evaluating' : 'generating',
      processing_stage: record.work_stage,
      processing_token: claim.processing_token,
      processing_started_at: now,
      claim_created_at: claim.created_at,
      claim_expires_at: claim.expires_at,
      updated_at: now
    }
  };
});`;

  const winnersCode = `${evaluationCore}

const proposed = $('Prepare Work Candidates').all().map((item) => item.json);
const claims = $input.all().map((item) => item.json).filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(proposed, claims, new Date().toISOString());
console.log(JSON.stringify({
  event: 'processing_claims',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const parseDetailCode = `${evaluationCore}

const record = $('Keep Winning Claims').item.json;
const payload = $json || {};
const errorMessage = payload.error?.message || payload.message || '';
if (errorMessage && !payload.data && !payload.body) {
  return {
    json: {
      ...record,
      work_error: String(errorMessage)
    }
  };
}
const html = typeof payload === 'string' ? payload : (payload.data || payload.body || '');
return { json: parseJobDetail(html, record) };`;

  const evaluateCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const record = $json;
const now = new Date().toISOString();
const commitToken = record.processing_token;
if (record.work_error) {
  const failed = recordStageFailure(record, new Error(record.work_error), {
    stage: 'evaluation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  return {
    json: {
      ...failed,
      processing_token: commitToken,
      commit_token: commitToken
    }
  };
}
const evaluation = evaluateJob(record, PROFILE, now);
const evaluated = applyEvaluation(record, evaluation, now);
return {
  json: {
    ...evaluated,
    processing_token: commitToken,
    commit_token: commitToken
  }
};`;

  const validateMessageCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const POLICY = ${JSON.stringify(policy)};
const record = $('Keep Winning Claims').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const errorMessage = payload.error?.message || payload.message || '';
if (errorMessage && !payload.output) {
  const failed = recordStageFailure(record, new Error(errorMessage), {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  return {
    json: {
      ...failed,
      processing_token: commitToken,
      commit_token: commitToken
    }
  };
}
const message = String(payload.output || '');
const validation = validateGeneratedMessage(message, {
  job: record,
  profile: PROFILE,
  policy: POLICY
});
if (!validation.valid) {
  const failed = recordStageFailure(
    record,
    new Error('message_validation: ' + validation.errors.join('; ')),
    {
      stage: 'generation',
      now,
      maxAttempts: ${runtime.generator.retry.max_attempts},
      backoffMs: ${runtime.generator.retry.backoff_ms},
      forceRetryable: true
    }
  );
  return {
    json: {
      ...failed,
      processing_token: commitToken,
      commit_token: commitToken
    }
  };
}
const generated = applyGeneratedMessage(record, message, PROFILE, now);
return {
  json: {
    ...generated,
    processing_token: commitToken,
    commit_token: commitToken
  }
};`;

  const promptCode = `${evaluationCore}

const record = $('Keep Winning Claims').item.json;
return {
  json: {
    ...record,
    application_prompt: buildApplicationUserMessage(record)
  }
};`;

  const commitFields = [
    "source_job_id",
    "canonical_job_id",
    "state_guard",
    "job_title",
    "job_description",
    "salary_text",
    "source_availability",
    "match_score",
    "match_tier",
    "match_decision",
    "match_reasons",
    "requirement_gaps",
    "profile_version",
    "evaluated_at",
    "pipeline_status",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "attempt_count",
    "failed_stage",
    "next_retry_at",
    "error_category",
    "error_summary",
    "generated_message",
    "message_profile_version",
    "message_validation_status",
    "generated_at",
    "manual_action",
    "updated_at"
  ];

  const nodes = [
    schedule,
    activeRead,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000001",
      name: "Prepare Work Candidates",
      position: [-1120, 180],
      jsCode: prepareCode
    }),
    claimsAppend,
    aggregateNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000004",
      name: "Aggregate Claims Written",
      position: [-680, 180],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000006",
      name: "Keep Winning Claims",
      position: [-260, 180],
      jsCode: winnersCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000007",
      name: "Mark Claimed Jobs",
      position: [-40, 180],
      matchingField: "state_guard",
      fields: [
        "processing_stage",
        "processing_token",
        "processing_started_at",
        "updated_at"
      ]
    }),
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: "",
            typeValidation: "strict",
            version: 3
          },
          conditions: [
            {
              id: "ee12f5d9-evaluation-stage",
              leftValue: "={{ $('Keep Winning Claims').item.json.work_stage }}",
              rightValue: "evaluation",
              operator: {
                type: "string",
                operation: "equals"
              }
            }
          ],
          combinator: "and"
        },
        options: {}
      },
      type: "n8n-nodes-base.if",
      typeVersion: 2.3,
      position: [180, 180],
      id: "ee12f5d9-c0d5-4586-bf62-000000000008",
      name: "Is Evaluation Work"
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: "",
            typeValidation: "strict",
            version: 3
          },
          conditions: [
            {
              id: "ee12f5d9-description-present",
              leftValue: "={{ $('Keep Winning Claims').item.json.job_description }}",
              rightValue: "",
              operator: {
                type: "string",
                operation: "notEmpty",
                singleValue: true
              }
            }
          ],
          combinator: "and"
        },
        options: {}
      },
      type: "n8n-nodes-base.if",
      typeVersion: 2.3,
      position: [420, 80],
      id: "ee12f5d9-c0d5-4586-bf62-000000000009",
      name: "Has Stored Description"
    },
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000010",
      name: "Use Stored Detail",
      position: [650, 20],
      mode: "runOnceForEachItem",
      jsCode: "return { json: $('Keep Winning Claims').item.json };"
    }),
    fetchDetail,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000011",
      name: "Parse Job Detail",
      position: [650, -120],
      mode: "runOnceForEachItem",
      jsCode: parseDetailCode
    }),
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000012",
      name: "Evaluate Job",
      position: [890, 20],
      mode: "runOnceForEachItem",
      jsCode: evaluateCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000013",
      name: "Commit Evaluation Result",
      position: [1130, 20],
      matchingField: "processing_token",
      fields: commitFields.filter(
        (field) =>
          ![
            "processing_token",
            "generated_message",
            "message_profile_version",
            "message_validation_status",
            "generated_at"
          ].includes(field)
      )
    }),
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000016",
      name: "Prepare Application Prompt",
      position: [420, 440],
      mode: "runOnceForEachItem",
      jsCode: promptCode
    }),
    agent,
    groq,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000014",
      name: "Validate Generated Message",
      position: [900, 440],
      mode: "runOnceForEachItem",
      jsCode: validateMessageCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000015",
      name: "Commit Generation Result",
      position: [1140, 440],
      matchingField: "processing_token",
      fields: commitFields.filter((field) => field !== "processing_token")
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Prepare Work Candidates")]] },
    "Prepare Work Candidates": { main: [[connection("Append Processing Claims")]] },
    "Append Processing Claims": { main: [[connection("Aggregate Claims Written")]] },
    "Aggregate Claims Written": { main: [[connection("Get Processing Claims")]] },
    "Get Processing Claims": { main: [[connection("Keep Winning Claims")]] },
    "Keep Winning Claims": { main: [[connection("Mark Claimed Jobs")]] },
    "Mark Claimed Jobs": { main: [[connection("Is Evaluation Work")]] },
    "Is Evaluation Work": {
      main: [
        [connection("Has Stored Description")],
        [connection("Prepare Application Prompt")]
      ]
    },
    "Has Stored Description": {
      main: [
        [connection("Use Stored Detail")],
        [connection("Fetch Job Detail")]
      ]
    },
    "Use Stored Detail": { main: [[connection("Evaluate Job")]] },
    "Fetch Job Detail": { main: [[connection("Parse Job Detail")]] },
    "Parse Job Detail": { main: [[connection("Evaluate Job")]] },
    "Evaluate Job": { main: [[connection("Commit Evaluation Result")]] },
    "Prepare Application Prompt": { main: [[connection("AI Agent")]] },
    "Groq Chat Model": {
      ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel", index: 0 }]]
    },
    "AI Agent": {
      main: [
        [connection("Validate Generated Message")],
        [connection("Validate Generated Message")]
      ]
    },
    "Validate Generated Message": { main: [[connection("Commit Generation Result")]] }
  };

  return {
    path,
    workflow: {
      ...current,
      name: "Job Application Pipeline - Evaluation and Generation",
      nodes,
      connections,
      active: false,
      settings: {
        ...current.settings,
        executionOrder: "v1"
      },
      meta: {
        ...current.meta,
        candidateProfileVersion: profile.profile_version,
        applicationPolicyVersion: policy.policy_version,
        pipelineSchemaVersion: schema.storage_version,
        generatorPerRunCap: runtime.generator.per_run_cap
      }
    }
  };
}

async function buildArchiver() {
  const path = "workflows/archiver.json";
  const current = await readJson(path);
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  const archiveCore = await bundledCore("src/contracts.mjs", "src/archive.mjs");
  if (
    !Number.isInteger(runtime.archiver?.schedule_minutes) ||
    !Number.isInteger(runtime.archiver?.claim_lease_ms) ||
    !Array.isArray(runtime.archiver?.eligible_statuses)
  ) {
    throw new Error("Invalid archiver runtime configuration");
  }

  const schedule = nodeByName(current, "Schedule Trigger");
  schedule.position = [-1320, 220];
  schedule.parameters = {
    rule: {
      interval: [
        {
          field: "minutes",
          minutesInterval: runtime.archiver.schedule_minutes
        }
      ]
    }
  };

  const activeRead = nodeByAnyName(current, ["Get row(s) in sheet", "Get Active Rows"]);
  activeRead.name = "Get Active Rows";
  activeRead.position = [-1120, 220];

  const archiveRead = nodeByAnyName(current, [
    "Get Archive Rows",
    "Append row in sheet",
    "Get row(s) in sheet"
  ]);
  archiveRead.id = "7106c36a-a814-4ea8-9100-000000000003";
  archiveRead.name = "Get Archive Rows";
  archiveRead.position = [-700, 220];
  archiveRead.parameters.operation = undefined;
  delete archiveRead.parameters.operation;
  const originalArchiveNode = nodeByAnyName(current, [
    "Append row in sheet",
    "Get Archive Rows"
  ]);
  if (originalArchiveNode.parameters.sheetName) {
    archiveRead.parameters.sheetName = structuredClone(originalArchiveNode.parameters.sheetName);
  }
  archiveRead.parameters.options = {};
  delete archiveRead.parameters.columns;
  archiveRead.alwaysOutputData = true;

  const activeUpdateBase = structuredClone(activeRead);
  const archiveWriteBase = structuredClone(archiveRead);

  const claimsRead = structuredClone(activeRead);
  claimsRead.id = "7106c36a-a814-4ea8-9100-000000000008";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [160, 220];
  claimsRead.parameters.sheetName = {
    __rl: true,
    value: "ProcessingClaims",
    mode: "name",
    cachedResultName: "ProcessingClaims"
  };
  claimsRead.alwaysOutputData = true;

  const claimsAppend = structuredClone(activeRead);
  claimsAppend.id = "7106c36a-a814-4ea8-9100-000000000006";
  claimsAppend.name = "Append Archive Claims";
  claimsAppend.position = [-260, 220];
  claimsAppend.parameters.operation = "append";
  claimsAppend.parameters.sheetName = structuredClone(claimsRead.parameters.sheetName);
  claimsAppend.parameters.columns = {
    mappingMode: "defineBelow",
    value: {
      canonical_job_id: "={{ $json.canonical_job_id }}",
      processing_stage: "archival",
      processing_token: "={{ $json.processing_token }}",
      created_at: "={{ $json.claim_created_at }}",
      expires_at: "={{ $json.claim_expires_at }}"
    },
    matchingColumns: [],
    schema: schemaColumns([
      "canonical_job_id",
      "processing_stage",
      "processing_token",
      "created_at",
      "expires_at"
    ]),
    attemptToConvertTypes: false,
    convertFieldsToString: false
  };

  const prepareCode = `${archiveCore}

const SCHEMA = ${JSON.stringify(schema)};
const activeRows = $('Aggregate Active Rows').first().json.active_rows || [];
const archiveRows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);
const now = new Date().toISOString();
const plan = prepareArchiveCandidates(activeRows, archiveRows, SCHEMA, {
  now,
  eligibleStatuses: ${JSON.stringify(runtime.archiver.eligible_statuses)}
});
console.log(JSON.stringify({
  event: 'archive_plan',
  candidates: plan.candidates.length,
  new_archive_writes: plan.candidates.filter((entry) => !entry.archive_already_complete).length,
  already_archived: plan.candidates.filter((entry) => entry.archive_already_complete).length,
  retained_for_retry: plan.retained.filter((entry) => entry.reason === 'retryable_error').length,
  retained: plan.retained.length,
  retained_reasons: plan.retained.map((entry) => entry.reason)
}));
return plan.candidates.map((record) => {
  const claim = createProcessingClaim(record, String($execution.id), now, ${runtime.archiver.claim_lease_ms});
  return {
    json: {
      ...record,
      processing_token: claim.processing_token,
      claim_created_at: claim.created_at,
      claim_expires_at: claim.expires_at
    }
  };
});`;

  const winnersCode = `${archiveCore}

const proposed = $('Prepare Archive Candidates').all().map((item) => item.json);
const claims = $input.all().map((item) => item.json).filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(proposed, claims, new Date().toISOString());
console.log(JSON.stringify({
  event: 'archive_claims',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const prepareUpsertsCode = `return $('Keep Winning Archive Claims').all().map((item) => ({
  json: {
    ...item.json.archive_record,
    source_row_number: item.json.source_row_number,
    archive_claim_token: item.json.processing_token
  }
}));`;

  const confirmCode = `${archiveCore}

const SCHEMA = ${JSON.stringify(schema)};
const planned = $('Keep Winning Archive Claims').all().map((item) => item.json);
const archiveRows = $('Aggregate Archive After Upsert').first().json.archive_rows || [];
const currentActive = $input.all().map((item) => item.json);
const confirmation = confirmArchiveDeletions(
  planned,
  currentActive,
  archiveRows,
  SCHEMA,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'archive_confirmation',
  confirmed: confirmation.confirmed.length,
  rejected: confirmation.rejected.length,
  rejected_reasons: confirmation.rejected.map((entry) => entry.reason)
}));
return confirmation.confirmed.map((entry) => ({ json: entry }));`;

  const archiveAfterRead = structuredClone(archiveRead);
  archiveAfterRead.id = "7106c36a-a814-4ea8-9100-000000000012";
  archiveAfterRead.name = "Get Archive After Upsert";
  archiveAfterRead.position = [980, 220];

  const activeBeforeDelete = structuredClone(activeRead);
  activeBeforeDelete.id = "7106c36a-a814-4ea8-9100-000000000014";
  activeBeforeDelete.name = "Get Active Before Delete";
  activeBeforeDelete.position = [1400, 220];

  const deleteNode = nodeByAnyName(current, [
    "Delete rows or columns from sheet",
    "Delete Confirmed Active Rows"
  ]);
  deleteNode.name = "Delete Confirmed Active Rows";
  deleteNode.position = [1820, 220];
  deleteNode.parameters = {
    operation: "delete",
    documentId: structuredClone(activeRead.parameters.documentId),
    sheetName: structuredClone(activeRead.parameters.sheetName),
    startIndex: "={{ $json.row_number }}"
  };

  const nodes = [
    schedule,
    activeRead,
    aggregateNode({
      id: "7106c36a-a814-4ea8-9100-000000000002",
      name: "Aggregate Active Rows",
      position: [-900, 220],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    codeNode({
      id: "7106c36a-a814-4ea8-9100-000000000004",
      name: "Prepare Archive Candidates",
      position: [-480, 220],
      jsCode: prepareCode
    }),
    claimsAppend,
    aggregateNode({
      id: "7106c36a-a814-4ea8-9100-000000000007",
      name: "Aggregate Archive Claims",
      position: [-40, 220],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "7106c36a-a814-4ea8-9100-000000000009",
      name: "Keep Winning Archive Claims",
      position: [380, 220],
      jsCode: winnersCode
    }),
    codeNode({
      id: "7106c36a-a814-4ea8-9100-000000000010",
      name: "Prepare Archive Upserts",
      position: [580, 220],
      jsCode: prepareUpsertsCode
    }),
    upsertSheetNode({
      base: archiveWriteBase,
      id: "7106c36a-a814-4ea8-9100-000000000011",
      name: "Upsert Archive Records",
      position: [780, 220],
      fields: schema.fields,
      matchingField: "canonical_job_id"
    }),
    aggregateNode({
      id: "7106c36a-a814-4ea8-9100-000000000016",
      name: "Aggregate Archive Upserts",
      position: [880, 220],
      destinationFieldName: "archive_upserts"
    }),
    archiveAfterRead,
    aggregateNode({
      id: "7106c36a-a814-4ea8-9100-000000000013",
      name: "Aggregate Archive After Upsert",
      position: [1200, 220],
      destinationFieldName: "archive_rows"
    }),
    activeBeforeDelete,
    codeNode({
      id: "7106c36a-a814-4ea8-9100-000000000015",
      name: "Confirm Archive Deletions",
      position: [1610, 220],
      jsCode: confirmCode
    }),
    deleteNode
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": { main: [[connection("Prepare Archive Candidates")]] },
    "Prepare Archive Candidates": { main: [[connection("Append Archive Claims")]] },
    "Append Archive Claims": { main: [[connection("Aggregate Archive Claims")]] },
    "Aggregate Archive Claims": { main: [[connection("Get Processing Claims")]] },
    "Get Processing Claims": { main: [[connection("Keep Winning Archive Claims")]] },
    "Keep Winning Archive Claims": { main: [[connection("Prepare Archive Upserts")]] },
    "Prepare Archive Upserts": { main: [[connection("Upsert Archive Records")]] },
    "Upsert Archive Records": { main: [[connection("Aggregate Archive Upserts")]] },
    "Aggregate Archive Upserts": { main: [[connection("Get Archive After Upsert")]] },
    "Get Archive After Upsert": { main: [[connection("Aggregate Archive After Upsert")]] },
    "Aggregate Archive After Upsert": { main: [[connection("Get Active Before Delete")]] },
    "Get Active Before Delete": { main: [[connection("Confirm Archive Deletions")]] },
    "Confirm Archive Deletions": { main: [[connection("Delete Confirmed Active Rows")]] }
  };

  return {
    path,
    workflow: {
      ...current,
      name: "Job Application Pipeline - Idempotent Archive",
      nodes,
      connections,
      active: false,
      settings: {
        ...current.settings,
        executionOrder: "v1"
      },
      meta: {
        ...current.meta,
        pipelineSchemaVersion: schema.storage_version,
        archiveScheduleMinutes: runtime.archiver.schedule_minutes
      }
    }
  };
}

async function buildReviewer() {
  const path = "workflows/reviewer.json";
  const generator = await readJson("workflows/generator.json");
  const archiver = await readJson("workflows/archiver.json");
  const schema = await readJson("config/pipeline-schema.json");
  const reviewConfig = await readJson("config/review-sheet.json");
  const reviewCore = await bundledCore("src/contracts.mjs", "src/review.mjs");

  const schedule = nodeByName(generator, "Schedule Trigger");
  schedule.id = "88af9ce3-b45f-4aa8-a980-000000000001";
  schedule.position = [-900, 240];
  schedule.parameters = {
    rule: {
      interval: [
        {
          field: "minutes",
          minutesInterval: reviewConfig.schedule_minutes
        }
      ]
    }
  };

  const activeRead = nodeByName(generator, "Get Active Rows");
  activeRead.id = "88af9ce3-b45f-4aa8-a980-000000000002";
  activeRead.position = [-700, 240];

  const archiveRead = nodeByName(archiver, "Get Archive Rows");
  archiveRead.id = "88af9ce3-b45f-4aa8-a980-000000000004";
  archiveRead.position = [-280, 240];
  archiveRead.alwaysOutputData = true;

  const sharedCode = `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const activeRows = $('Aggregate Active Rows').first().json.active_rows || [];
const archiveRows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length > 0);
const now = new Date().toISOString();
const processed = processReviewActions(activeRows, archiveRows, SCHEMA, now);
`;

  const updateFields = [
    "state_guard",
    "pipeline_status",
    "match_decision",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "attempt_count",
    "failed_stage",
    "next_retry_at",
    "error_category",
    "error_summary",
    "source_availability",
    "manual_action",
    "application_decision",
    "application_decided_at",
    "outcome",
    "outcome_at",
    "updated_at"
  ];

  const dashboardNodeBase = structuredClone(activeRead);
  dashboardNodeBase.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.dashboard_sheet,
    mode: "name",
    cachedResultName: reviewConfig.dashboard_sheet
  };

  const nodes = [
    schedule,
    activeRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000003",
      name: "Aggregate Active Rows",
      position: [-480, 240],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000005",
      name: "Prepare Active Review Updates",
      position: [-40, 20],
      jsCode: `${sharedCode}
return processed.active_updates.map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: activeRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000006",
      name: "Update Active Review Actions",
      position: [220, 20],
      matchingField: "canonical_job_id",
      fields: updateFields
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000007",
      name: "Prepare Archive Review Updates",
      position: [-40, 180],
      jsCode: `${sharedCode}
return processed.archive_updates.map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000008",
      name: "Update Archive Review Actions",
      position: [220, 180],
      matchingField: "canonical_job_id",
      fields: updateFields
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000009",
      name: "Prepare Funnel Summary",
      position: [-40, 340],
      jsCode: `${sharedCode}
return [{ json: buildFunnelSummary(activeRows, archiveRows, SCHEMA, now) }];`
    }),
    upsertSheetNode({
      base: dashboardNodeBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000010",
      name: "Update Dashboard Summary",
      position: [220, 340],
      fields: reviewConfig.dashboard_fields,
      matchingField: "metric_key"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000011",
      name: "Log Invalid Review Actions",
      position: [-40, 500],
      jsCode: `${sharedCode}
if (processed.invalid_actions.length > 0) {
  console.log(JSON.stringify({
    event: 'invalid_review_actions',
    count: processed.invalid_actions.length,
    actions: processed.invalid_actions
  }));
}
return [{ json: { event: 'review_run', invalid_actions: processed.invalid_actions.length } }];`
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": {
      main: [
        [
          connection("Prepare Active Review Updates"),
          connection("Prepare Archive Review Updates"),
          connection("Prepare Funnel Summary"),
          connection("Log Invalid Review Actions")
        ]
      ]
    },
    "Prepare Active Review Updates": { main: [[connection("Update Active Review Actions")]] },
    "Prepare Archive Review Updates": { main: [[connection("Update Archive Review Actions")]] },
    "Prepare Funnel Summary": { main: [[connection("Update Dashboard Summary")]] }
  };

  return {
    path,
    workflow: {
      name: "Job Application Pipeline - Review Actions and Outcomes",
      nodes,
      connections,
      active: false,
      settings: {
        executionOrder: "v1",
        binaryMode: "separate"
      },
      versionId: "88af9ce3-b45f-4aa8-a980-000000000012",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        reviewViewVersion: reviewConfig.view_version
      },
      tags: []
    }
  };
}

async function writeGenerated({ path, workflow }) {
  const target = resolve(root, path);
  const next = `${JSON.stringify(workflow, null, 2)}\n`;
  if (checkOnly) {
    const current = await readFile(target, "utf8");
    if (current !== next) throw new Error(`${path} is out of date; run npm run build:workflows`);
    return;
  }
  await writeFile(target, next);
}

const generated = [
  await buildScraper(),
  await buildGenerator(),
  await buildArchiver(),
  await buildReviewer()
];
for (const workflow of generated) await writeGenerated(workflow);

console.log(checkOnly ? "Workflow exports are up to date." : "Workflow exports rebuilt.");
