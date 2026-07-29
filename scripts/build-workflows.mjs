import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateReviewQueueConfig } from "../src/review.mjs";

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

function booleanIfNode({ id, name, position, leftValue }) {
  return {
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
            id: `${id}-condition`,
            leftValue,
            rightValue: true,
            operator: {
              type: "boolean",
              operation: "true",
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
      type: [
        "match_score",
        "qualification_score",
        "opportunity_score",
        "application_qualification_score",
        "application_opportunity_score",
        "application_posting_age_days",
        "attempt_count",
        "alert_attempt_count",
        "apply_points_input",
        "apply_points_used",
        "numerator",
        "denominator",
        "value",
        "sample_size",
        "coverage_numerator",
        "coverage_denominator",
        "record_count",
        "application_count",
        "detail_row_count",
        "minimum_overall_applications",
        "minimum_segment_applications",
        "minimum_explicit_outcome_coverage",
        "recommendation_count",
        "abstention_count",
        "comparison_value",
        "baseline_value",
        "difference",
        "coverage_rate"
      ].includes(field) ? "number" : "string",
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
  const accessor = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field)
    ? `$json.${field}`
    : `$json[${JSON.stringify(field)}]`;
  return `={{ Array.isArray(${accessor}) ? JSON.stringify(${accessor}) : (${accessor} ?? '') }}`;
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
  const rankingPolicy = await readJson("config/ranking-policy.json");
  const packPolicy = await readJson("config/application-pack-policy.json");
  const alertPolicy = await readJson("config/alert-policy.json");
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  const evaluationCore = await bundledCore(
    "src/contracts.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs",
    "src/message-safety.mjs",
    "src/alerts.mjs"
  );
  const { assertValidProfileConfiguration } = await import(
    new URL("../src/profile.mjs", import.meta.url)
  );
  const {
    buildApplicationSystemMessage,
    validateApplicationPackPolicy,
    validateRankingPolicy
  } = await import(new URL("../src/evaluation.mjs", import.meta.url));
  const { validateAlertPolicy } = await import(
    new URL("../src/alerts.mjs", import.meta.url)
  );
  assertValidProfileConfiguration(profile, policy);
  const rankingPolicyErrors = validateRankingPolicy(rankingPolicy, profile);
  if (rankingPolicyErrors.length > 0) {
    throw new Error(`Invalid ranking policy:\n- ${rankingPolicyErrors.join("\n- ")}`);
  }
  const packPolicyErrors = validateApplicationPackPolicy(
    packPolicy,
    profile,
    policy
  );
  if (packPolicyErrors.length > 0) {
    throw new Error(`Invalid application-pack policy:\n- ${packPolicyErrors.join("\n- ")}`);
  }
  const alertPolicyErrors = validateAlertPolicy(alertPolicy);
  if (alertPolicyErrors.length > 0) {
    throw new Error(`Invalid alert policy:\n- ${alertPolicyErrors.join("\n- ")}`);
  }
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
  agent.position = [900, 440];
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
  groq.position = [1140, 760];

  const repairAgent = structuredClone(agent);
  repairAgent.id = "ee12f5d9-c0d5-4586-bf62-000000000020";
  repairAgent.name = "Repair AI Agent";
  repairAgent.position = [1620, 560];
  repairAgent.parameters = {
    ...repairAgent.parameters,
    text: "={{ $json.repair_prompt }}"
  };

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
      processing_commit_guard: processingCommitGuard(claim.processing_token),
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
const RANKING_POLICY = ${JSON.stringify(rankingPolicy)};
const record = $json;
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
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
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
const evaluation = evaluateJob(record, PROFILE, RANKING_POLICY, now);
const evaluated = applyEvaluation(record, evaluation, now);
return {
  json: {
    ...evaluated,
    processing_commit_guard: commitGuard,
    commit_token: commitToken
  }
};`;

  const validateInitialMessageCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const POLICY = ${JSON.stringify(policy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const MESSAGE_SAFETY = {
  profile: PROFILE,
  applicationPolicy: POLICY,
  packPolicy: PACK_POLICY
};
const originalRecord = $('Keep Winning Claims').item.json;
const record = $('Prepare Application Pack').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
const errorMessage = payload.error?.message || payload.message || '';
if (errorMessage && !payload.output) {
  const failed = recordStageFailure(originalRecord, new Error(errorMessage), {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken,
      should_repair: false
    }
  };
}
const message = String(payload.output || '');
const validation = validateGeneratedMessage(message, {
  job: record,
  profile: PROFILE,
  policy: POLICY,
  pack: record
});
if (!validation.valid) {
  return {
    json: {
      ...record,
      rejected_message: message,
      validation_errors: validation.errors,
      repair_prompt:
        buildApplicationUserMessage(record, record) +
        '\\n\\n' +
        buildApplicationRepairMessage(message, validation.errors),
      processing_commit_guard: commitGuard,
      commit_token: commitToken,
      should_repair: true
    }
  };
}
let generated;
try {
  generated = applyGeneratedApplicationPack(
    record,
    record,
    message,
    PROFILE,
    POLICY,
    PACK_POLICY,
    now
  );
  generated = queueAlertState(
    generated,
    ALERT_POLICY,
    now,
    MESSAGE_SAFETY
  );
} catch (error) {
  const failed = recordStageFailure(originalRecord, error, {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms},
    forceRetryable: true
  });
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
return {
  json: {
    ...generated,
    processing_commit_guard: commitGuard,
    commit_token: commitToken,
    should_repair: false
  }
};`;

  const validateRepairedMessageCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const POLICY = ${JSON.stringify(policy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const MESSAGE_SAFETY = {
  profile: PROFILE,
  applicationPolicy: POLICY,
  packPolicy: PACK_POLICY
};
const originalRecord = $('Keep Winning Claims').item.json;
const record = $('Prepare Application Pack').item.json;
const repairContext = $('Validate Initial Draft').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
const errorMessage = payload.error?.message || payload.message || '';
if (errorMessage && !payload.output) {
  const failed = recordStageFailure(originalRecord, new Error(errorMessage), {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
const message = String(payload.output || '');
const validation = validateGeneratedMessage(message, {
  job: record,
  profile: PROFILE,
  policy: POLICY,
  pack: record
});
if (!validation.valid) {
  const failed = recordStageFailure(
    originalRecord,
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
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
let generated;
try {
  generated = applyGeneratedApplicationPack(
    record,
    record,
    message,
    PROFILE,
    POLICY,
    PACK_POLICY,
    now
  );
  generated = queueAlertState(
    generated,
    ALERT_POLICY,
    now,
    MESSAGE_SAFETY
  );
} catch (error) {
  const failed = recordStageFailure(originalRecord, error, {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms},
    forceRetryable: true
  });
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
return {
  json: {
    ...generated,
    processing_commit_guard: commitGuard,
    commit_token: commitToken,
    initial_validation_errors: repairContext.validation_errors
  }
};`;

  const promptCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const POLICY = ${JSON.stringify(policy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const record = $('Keep Winning Claims').item.json;
const now = new Date().toISOString();
const pack = buildApplicationPack(record, PROFILE, POLICY, PACK_POLICY, now);
const packErrors = validateApplicationPack(pack, PROFILE, PACK_POLICY);
return {
  json: {
    ...record,
    ...pack,
    application_prompt: buildApplicationUserMessage(record, pack),
    application_pack_ready:
      pack.application_pack_status === 'ready' &&
      packErrors.length === 0,
    application_pack_gate_errors: packErrors
  }
};`;

  const nonReadyPackCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const originalRecord = $('Keep Winning Claims').item.json;
const record = $('Prepare Application Pack').item.json;
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
let reviewRecord;
try {
  reviewRecord = applyNonReadyApplicationPack(
    originalRecord,
    record,
    PROFILE,
    PACK_POLICY,
    now
  );
} catch (error) {
  reviewRecord = recordStageFailure(originalRecord, error, {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms},
    forceRetryable: false
  });
}
return {
  json: {
    ...reviewRecord,
    processing_commit_guard: commitGuard,
    commit_token: commitToken
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
    "qualification_score",
    "opportunity_score",
    "ranking_confidence",
    "apply_points_recommendation",
    "ranking_factors",
    "ranking_missing_signals",
    "requirement_gap_details",
    "scoring_policy_version",
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
    "message_policy_version",
    "message_validation_status",
    "generated_at",
    "application_instructions",
    "screening_questions",
    "selected_proof_refs",
    "application_warnings",
    "application_pack_status",
    "application_pack_version",
    "application_pack_profile_version",
    "application_pack_policy_version",
    "application_pack_generated_at",
    "alert_status",
    "alert_channel",
    "alert_policy_version",
    "alert_idempotency_key",
    "alert_attempt_count",
    "alert_last_attempt_at",
    "alert_next_retry_at",
    "alert_sent_at",
    "alert_provider_reference",
    "alert_error_category",
    "alert_error_summary",
    "alert_suppressed_reason",
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
        "processing_commit_guard",
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
      matchingField: "processing_commit_guard",
      fields: commitFields.filter(
        (field) =>
          ![
            "generated_message",
            "message_profile_version",
            "message_validation_status",
            "generated_at"
          ].includes(field)
      )
    }),
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000016",
      name: "Prepare Application Pack",
      position: [420, 440],
      mode: "runOnceForEachItem",
      jsCode: promptCode
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
              id: "ee12f5d9-application-pack-ready",
              leftValue:
                "={{ $json.application_pack_ready }}",
              rightValue: true,
              operator: {
                type: "boolean",
                operation: "true",
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
      position: [650, 440],
      id: "ee12f5d9-c0d5-4586-bf62-000000000017",
      name: "Is Application Pack Ready"
    },
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000018",
      name: "Persist Non-Ready Pack",
      position: [900, 300],
      mode: "runOnceForEachItem",
      jsCode: nonReadyPackCode
    }),
    agent,
    groq,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000014",
      name: "Validate Initial Draft",
      position: [1140, 440],
      mode: "runOnceForEachItem",
      jsCode: validateInitialMessageCode
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
              id: "ee12f5d9-needs-repair",
              leftValue: "={{ $json.should_repair }}",
              rightValue: true,
              operator: {
                type: "boolean",
                operation: "true",
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
      position: [1380, 440],
      id: "ee12f5d9-c0d5-4586-bf62-000000000019",
      name: "Needs Repair"
    },
    repairAgent,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000021",
      name: "Validate Repaired Message",
      position: [1860, 560],
      mode: "runOnceForEachItem",
      jsCode: validateRepairedMessageCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000015",
      name: "Commit Generation Result",
      position: [2100, 440],
      matchingField: "processing_commit_guard",
      fields: commitFields
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
        [connection("Prepare Application Pack")]
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
    "Prepare Application Pack": {
      main: [[connection("Is Application Pack Ready")]]
    },
    "Is Application Pack Ready": {
      main: [
        [connection("AI Agent")],
        [connection("Persist Non-Ready Pack")]
      ]
    },
    "Persist Non-Ready Pack": {
      main: [[connection("Commit Generation Result")]]
    },
    "Groq Chat Model": {
      ai_languageModel: [
        [
          { node: "AI Agent", type: "ai_languageModel", index: 0 },
          {
            node: "Repair AI Agent",
            type: "ai_languageModel",
            index: 0
          }
        ]
      ]
    },
    "AI Agent": {
      main: [
        [connection("Validate Initial Draft")],
        [connection("Validate Initial Draft")]
      ]
    },
    "Validate Initial Draft": {
      main: [[connection("Needs Repair")]]
    },
    "Needs Repair": {
      main: [
        [connection("Repair AI Agent")],
        [connection("Commit Generation Result")]
      ]
    },
    "Repair AI Agent": {
      main: [
        [connection("Validate Repaired Message")],
        [connection("Validate Repaired Message")]
      ]
    },
    "Validate Repaired Message": {
      main: [[connection("Commit Generation Result")]]
    }
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
        rankingPolicyVersion: rankingPolicy.policy_version,
        applicationPackPolicyVersion: packPolicy.policy_version,
        applicationPackVersion: packPolicy.pack_version,
        alertPolicyVersion: alertPolicy.policy_version,
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
  retained_for_generation_review: plan.retained.filter(
    (entry) => entry.reason === 'terminal_generation_requires_review'
  ).length,
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
  const reviewQueueErrors = validateReviewQueueConfig(reviewConfig, schema);
  if (reviewQueueErrors.length > 0) {
    throw new Error(
      `Invalid review queue configuration:\n- ${reviewQueueErrors.join("\n- ")}`
    );
  }
  const profile = await readJson("config/candidate-profile.json");
  const applicationPolicy = await readJson(
    "config/application-policy.json"
  );
  const packPolicy = await readJson(
    "config/application-pack-policy.json"
  );
  const reviewCore = await bundledCore(
    "src/contracts.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs",
    "src/message-safety.mjs",
    "src/review.mjs"
  );

  const schedule = nodeByName(generator, "Schedule Trigger");
  schedule.id = "88af9ce3-b45f-4aa8-a980-000000000001";
  schedule.position = [-1810, 240];
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
  activeRead.position = [-1600, 240];
  activeRead.alwaysOutputData = true;

  const archiveRead = nodeByName(archiver, "Get Archive Rows");
  archiveRead.id = "88af9ce3-b45f-4aa8-a980-000000000004";
  archiveRead.position = [-1180, 240];
  archiveRead.alwaysOutputData = true;

  const queueRead = structuredClone(activeRead);
  queueRead.id = "88af9ce3-b45f-4aa8-a980-000000000005";
  queueRead.name = "Get Review Queue Rows";
  queueRead.position = [-760, 240];
  queueRead.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.review_queue.sheet,
    mode: "name",
    cachedResultName: reviewConfig.review_queue.sheet
  };
  queueRead.alwaysOutputData = true;

  const planCode = `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const REVIEW_CONFIG = ${JSON.stringify(reviewConfig)};
const MESSAGE_SAFETY = {
  profile: ${JSON.stringify(profile)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
};
const activeRows = ($('Aggregate Active Rows').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const archiveRows = ($('Aggregate Archive Rows').first().json.archive_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const queueRows = ($('Aggregate Review Queue Rows').first().json.queue_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const now = new Date().toISOString();
const processed = processReviewActions(
  activeRows,
  archiveRows,
  SCHEMA,
  now,
  MESSAGE_SAFETY,
  {
    queueRows,
    reviewConfig: REVIEW_CONFIG,
    executionId: String($execution.id)
  }
);
return [{ json: processed }];`;

  const updateFields = [
    "state_guard",
    "pipeline_status",
    "match_decision",
    "processing_stage",
    "processing_commit_guard",
    "processing_token",
    "processing_started_at",
    "attempt_count",
    "failed_stage",
    "next_retry_at",
    "error_category",
    "error_summary",
    "source_availability",
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "first_reviewed_at",
    "application_decision",
    "application_decided_at",
    "apply_points_used",
    "application_message_strategy",
    "application_qualification_score",
    "application_opportunity_score",
    "application_ranking_confidence",
    "application_scoring_policy_version",
    "application_apply_points_recommendation",
    "application_pack_status_at_apply",
    "application_posting_age_days",
    "application_snapshot_at",
    "outcome",
    "outcome_at",
    "outcome_events",
    "updated_at"
  ];

  const activeUpdateBase = structuredClone(activeRead);
  const queueAppendBase = structuredClone(activeRead);
  queueAppendBase.parameters.sheetName = structuredClone(
    queueRead.parameters.sheetName
  );

  const dashboardNodeBase = structuredClone(activeRead);
  dashboardNodeBase.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.dashboard_sheet,
    mode: "name",
    cachedResultName: reviewConfig.dashboard_sheet
  };

  const activeAfterReview = structuredClone(activeRead);
  activeAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000017";
  activeAfterReview.name = "Get Active After Review";
  activeAfterReview.position = [500, 20];
  activeAfterReview.alwaysOutputData = true;

  const queueAfterReview = structuredClone(queueRead);
  queueAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000019";
  queueAfterReview.name = "Get Review Queue After Review";
  queueAfterReview.position = [900, 20];

  const deleteQueueRows = nodeByAnyName(archiver, [
    "Delete Confirmed Active Rows",
    "Delete rows or columns from sheet"
  ]);
  deleteQueueRows.id = "88af9ce3-b45f-4aa8-a980-000000000025";
  deleteQueueRows.name = "Delete Existing Review Queue Rows";
  deleteQueueRows.position = [2080, -60];
  deleteQueueRows.parameters = {
    operation: "delete",
    documentId: structuredClone(activeRead.parameters.documentId),
    sheetName: structuredClone(queueRead.parameters.sheetName),
    startIndex: "={{ $json.row_number }}"
  };

  const reconciliationCode = `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const REVIEW_CONFIG = ${JSON.stringify(reviewConfig)};
const activeRows = ($('Aggregate Active After Review').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const currentQueueRows = ($('Aggregate Current Review Queue').first().json.queue_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const initialQueueRows = ($('Aggregate Review Queue Rows').first().json.queue_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const reconciliation = reconcileReviewQueue(
  activeRows,
  currentQueueRows,
  initialQueueRows,
  SCHEMA,
  REVIEW_CONFIG,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'review_queue_reconciliation',
  projected: reconciliation.queue_rows.length,
  deleted: reconciliation.delete_rows.length,
  protected_actions: reconciliation.protected_action_count,
  invalid_records: reconciliation.invalid_records
}));
return [{ json: reconciliation }];`;

  const nodes = [
    schedule,
    activeRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000003",
      name: "Aggregate Active Rows",
      position: [-1390, 240],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000028",
      name: "Aggregate Archive Rows",
      position: [-970, 240],
      destinationFieldName: "archive_rows"
    }),
    queueRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000029",
      name: "Aggregate Review Queue Rows",
      position: [-550, 240],
      destinationFieldName: "queue_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000030",
      name: "Prepare Review Plan",
      position: [-340, 240],
      jsCode: planCode
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000031",
      name: "Has Active Review Updates",
      position: [-120, 20],
      leftValue: "={{ $json.active_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000032",
      name: "Prepare Active Review Claims",
      position: [100, -80],
      jsCode:
        "return $('Prepare Review Plan').first().json.active_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000033",
      name: "Mark Active Review Claims",
      position: [300, -80],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000034",
      name: "Prepare Claimed Active Review Updates",
      position: [500, -80],
      jsCode: `const marked = new Set(
  $input.all()
    .map((item) => String(item.json.processing_commit_guard || ''))
    .filter(Boolean)
);
return $('Prepare Review Plan').first().json.active_updates
  .filter((record) => marked.has(String(record.processing_commit_guard || '')))
  .map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000006",
      name: "Update Active Review Actions",
      position: [700, -80],
      matchingField: "processing_commit_guard",
      fields: updateFields
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000007",
      name: "Prepare Archive Review Updates",
      position: [-120, 340],
      jsCode:
        "return $('Prepare Review Plan').first().json.archive_updates.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000008",
      name: "Update Archive Review Actions",
      position: [100, 340],
      matchingField: "canonical_job_id",
      fields: updateFields
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000009",
      name: "Prepare Funnel Summary",
      position: [-120, 500],
      jsCode: `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const activeRows = ($('Aggregate Active Rows').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const archiveRows = ($('Aggregate Archive Rows').first().json.archive_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
return [{ json: buildFunnelSummary(activeRows, archiveRows, SCHEMA, new Date().toISOString()) }];`
    }),
    upsertSheetNode({
      base: dashboardNodeBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000010",
      name: "Update Dashboard Summary",
      position: [100, 500],
      fields: reviewConfig.dashboard_fields,
      matchingField: "metric_key"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000011",
      name: "Log Invalid Review Actions",
      position: [-120, 660],
      jsCode: `const processed = $('Prepare Review Plan').first().json;
if (processed.invalid_actions.length > 0) {
  console.log(JSON.stringify({
    event: 'invalid_review_actions',
    count: processed.invalid_actions.length,
    actions: processed.invalid_actions
  }));
}
return [{ json: {
  event: 'review_run',
  invalid_actions: processed.invalid_actions.length,
  processed_queue_actions: processed.processed_queue_actions.length
} }];`
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000036",
      name: "Aggregate Active Review Updates",
      position: [900, -80],
      destinationFieldName: "updated_rows"
    }),
    activeAfterReview,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000018",
      name: "Aggregate Active After Review",
      position: [700, 20],
      destinationFieldName: "active_rows"
    }),
    queueAfterReview,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000020",
      name: "Aggregate Current Review Queue",
      position: [1110, 20],
      destinationFieldName: "queue_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000021",
      name: "Prepare Review Queue Reconciliation",
      position: [1320, 20],
      jsCode: reconciliationCode
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000022",
      name: "Has Review Queue Deletions",
      position: [1540, 20],
      leftValue: "={{ $json.delete_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000023",
      name: "Prepare Review Queue Deletions",
      position: [1760, -60],
      jsCode:
        "return $('Prepare Review Queue Reconciliation').first().json.delete_rows.map((record) => ({ json: record }));"
    }),
    deleteQueueRows,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000026",
      name: "Aggregate Review Queue Deletions",
      position: [2290, -60],
      destinationFieldName: "deleted_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000024",
      name: "Has Review Queue Appends",
      position: [2500, 20],
      leftValue:
        "={{ $('Prepare Review Queue Reconciliation').first().json.queue_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000027",
      name: "Prepare Review Queue Appends",
      position: [2720, -60],
      jsCode:
        "return $('Prepare Review Queue Reconciliation').first().json.queue_rows.map((record) => ({ json: record }));"
    }),
    appendSheetNode({
      base: queueAppendBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000035",
      name: "Append Review Queue Rows",
      position: [2940, -60],
      fields: reviewConfig.review_queue.fields
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": { main: [[connection("Aggregate Archive Rows")]] },
    "Aggregate Archive Rows": { main: [[connection("Get Review Queue Rows")]] },
    "Get Review Queue Rows": { main: [[connection("Aggregate Review Queue Rows")]] },
    "Aggregate Review Queue Rows": { main: [[connection("Prepare Review Plan")]] },
    "Prepare Review Plan": {
      main: [
        [
          connection("Has Active Review Updates"),
          connection("Prepare Archive Review Updates"),
          connection("Prepare Funnel Summary"),
          connection("Log Invalid Review Actions")
        ]
      ]
    },
    "Has Active Review Updates": {
      main: [
        [connection("Prepare Active Review Claims")],
        [connection("Get Active After Review")]
      ]
    },
    "Prepare Active Review Claims": { main: [[connection("Mark Active Review Claims")]] },
    "Mark Active Review Claims": {
      main: [[connection("Prepare Claimed Active Review Updates")]]
    },
    "Prepare Claimed Active Review Updates": {
      main: [[connection("Update Active Review Actions")]]
    },
    "Update Active Review Actions": {
      main: [[connection("Aggregate Active Review Updates")]]
    },
    "Aggregate Active Review Updates": {
      main: [[connection("Get Active After Review")]]
    },
    "Prepare Archive Review Updates": { main: [[connection("Update Archive Review Actions")]] },
    "Prepare Funnel Summary": { main: [[connection("Update Dashboard Summary")]] },
    "Get Active After Review": {
      main: [[connection("Aggregate Active After Review")]]
    },
    "Aggregate Active After Review": {
      main: [[connection("Get Review Queue After Review")]]
    },
    "Get Review Queue After Review": {
      main: [[connection("Aggregate Current Review Queue")]]
    },
    "Aggregate Current Review Queue": {
      main: [[connection("Prepare Review Queue Reconciliation")]]
    },
    "Prepare Review Queue Reconciliation": {
      main: [[connection("Has Review Queue Deletions")]]
    },
    "Has Review Queue Deletions": {
      main: [
        [connection("Prepare Review Queue Deletions")],
        [connection("Has Review Queue Appends")]
      ]
    },
    "Prepare Review Queue Deletions": {
      main: [[connection("Delete Existing Review Queue Rows")]]
    },
    "Delete Existing Review Queue Rows": {
      main: [[connection("Aggregate Review Queue Deletions")]]
    },
    "Aggregate Review Queue Deletions": {
      main: [[connection("Has Review Queue Appends")]]
    },
    "Has Review Queue Appends": {
      main: [[connection("Prepare Review Queue Appends")], []]
    },
    "Prepare Review Queue Appends": {
      main: [[connection("Append Review Queue Rows")]]
    }
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
        reviewViewVersion: reviewConfig.view_version,
        reviewQueueVersion: reviewConfig.review_queue.version
      },
      tags: []
    }
  };
}

async function buildAlerter() {
  const path = "workflows/alerter.json";
  const template = await readJson("workflows/generator.json");
  const schema = await readJson("config/pipeline-schema.json");
  const policy = await readJson("config/alert-policy.json");
  const profile = await readJson("config/candidate-profile.json");
  const applicationPolicy = await readJson(
    "config/application-policy.json"
  );
  const packPolicy = await readJson(
    "config/application-pack-policy.json"
  );
  const alertCore = await bundledCore(
    "src/contracts.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs",
    "src/message-safety.mjs",
    "src/alerts.mjs"
  );
  const { validateAlertPolicy } = await import(
    new URL("../src/alerts.mjs", import.meta.url)
  );
  const policyErrors = validateAlertPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid alert policy:\n- ${policyErrors.join("\n- ")}`);
  }

  const activeRead = nodeByName(template, "Get Active Rows");
  activeRead.id = "a11e7e00-0000-4000-8000-000000000002";
  activeRead.name = "Get Active Rows";
  activeRead.position = [-1180, 180];
  activeRead.alwaysOutputData = true;

  const claimsAppend = nodeByName(template, "Append Processing Claims");
  claimsAppend.id = "a11e7e00-0000-4000-8000-000000000004";
  claimsAppend.name = "Append Alert Claims";
  claimsAppend.position = [-760, 180];

  const claimsRead = nodeByName(template, "Get Processing Claims");
  claimsRead.id = "a11e7e00-0000-4000-8000-000000000006";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [-320, 180];
  claimsRead.alwaysOutputData = true;

  const activeUpdateBase = structuredClone(activeRead);
  const alertFields = [
    "state_guard",
    "alert_status",
    "alert_channel",
    "alert_policy_version",
    "alert_idempotency_key",
    "alert_attempt_count",
    "alert_last_attempt_at",
    "alert_next_retry_at",
    "alert_sent_at",
    "alert_provider_reference",
    "alert_error_category",
    "alert_error_summary",
    "alert_suppressed_reason",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "updated_at"
  ];

  const prepareCode = `${alertCore}

const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(policy)};
const MESSAGE_SAFETY = {
  profile: ${JSON.stringify(profile)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
};
const now = new Date().toISOString();
const selection = selectAlertCandidates(
  $input.all().map((item) => item.json),
  SCHEMA,
  POLICY,
  now,
  MESSAGE_SAFETY
);
return selection.candidates.map((record) => {
  const claim = createProcessingClaim(
    record,
    String($execution.id),
    now,
    POLICY.claim_lease_ms
  );
  return {
    json: {
      ...record,
      alert_status: record.delivery_mode === 'deliver'
        ? 'sending'
        : record.alert_status,
      processing_stage: 'alert',
      processing_token: claim.processing_token,
      processing_commit_guard: processingCommitGuard(claim.processing_token),
      processing_started_at: now,
      alert_last_attempt_at: now,
      claim_created_at: claim.created_at,
      claim_expires_at: claim.expires_at,
      updated_at: now
    }
  };
});`;

  const winnersCode = `${alertCore}

const proposed = $('Prepare Alert Candidates').all().map((item) => item.json);
const claims = $input.all().map((item) => item.json).filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(proposed, claims, new Date().toISOString());
console.log(JSON.stringify({
  event: 'alert_claims',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const prepareDeliveryCode = `${alertCore}

const POLICY = ${JSON.stringify(policy)};
const MESSAGE_SAFETY = {
  profile: ${JSON.stringify(profile)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
};
const record = $('Keep Winning Alert Claims').item.json;
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
if (record.delivery_mode === 'state_only') {
  const finalized = releaseClaim(record, commitToken, now);
  return {
    json: {
      ...finalized,
      processing_commit_guard: commitGuard,
      commit_token: commitToken,
      should_send: false
    }
  };
}

const webhookUrl = String($env[POLICY.environment.provider_webhook_url] || '').trim();
const reviewUrl = String($env[POLICY.environment.review_url] || '').trim();
const configurationErrors = validateAlertProviderConfiguration(
  { webhookUrl, reviewUrl },
  POLICY
);
if (configurationErrors.length > 0) {
  const finalized = applyAlertProviderResult(
    record,
    {
      configuration_error: configurationErrors.join('; '),
      at: now
    },
    POLICY
  );
  return {
    json: {
      ...finalized,
      processing_commit_guard: commitGuard,
      commit_token: commitToken,
      should_send: false
    }
  };
}
let alertPayload;
try {
  alertPayload = renderAlert(
    { ...record, alert_last_attempt_at: now },
    POLICY,
    { reviewUrl, messageSafetyContext: MESSAGE_SAFETY }
  );
} catch (error) {
  const finalized = applyAlertProviderResult(
    record,
    {
      preflight_error: alertRenderErrorCategory(error),
      at: now
    },
    POLICY
  );
  return {
    json: {
      ...finalized,
      processing_commit_guard: commitGuard,
      commit_token: commitToken,
      should_send: false
    }
  };
}
return {
  json: {
    ...record,
    alert_last_attempt_at: now,
    alert_payload: alertPayload,
    commit_token: commitToken,
    should_send: true
  }
};`;

  const finalizeCode = `${alertCore}

const POLICY = ${JSON.stringify(policy)};
const record = $('Prepare Alert Delivery').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
const providerResult = {
  statusCode:
    payload.statusCode ||
    payload.status ||
    payload.error?.statusCode ||
    payload.error?.status ||
    0,
  body: typeof payload.body === 'string'
    ? payload.body
    : typeof payload.data === 'string'
      ? payload.data
      : '',
  message: payload.error?.message || payload.message || '',
  at: now
};
const finalized = applyAlertProviderResult(record, providerResult, POLICY);
console.log(JSON.stringify({
  event: 'alert_delivery',
  canonical_job_id: finalized.canonical_job_id,
  status: finalized.alert_status,
  category: finalized.alert_error_category || ''
}));
return {
  json: {
    ...finalized,
    processing_commit_guard: commitGuard,
    commit_token: commitToken
  }
};`;

  const schedule = {
    parameters: {
      rule: {
        interval: [
          {
            field: "minutes",
            minutesInterval: policy.schedule_minutes
          }
        ]
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [-1400, 180],
    id: "a11e7e00-0000-4000-8000-000000000001",
    name: "Schedule Trigger"
  };

  const shouldSend = {
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
            id: "a11e7e00-provider-send",
            leftValue: "={{ $json.should_send }}",
            rightValue: true,
            operator: {
              type: "boolean",
              operation: "true",
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
    position: [560, 180],
    id: "a11e7e00-0000-4000-8000-000000000010",
    name: "Should Send Provider Alert"
  };

  const sendSlack = {
    parameters: {
      method: "POST",
      url: `={{ $env.${policy.environment.provider_webhook_url} }}`,
      sendBody: true,
      contentType: "json",
      specifyBody: "json",
      jsonBody: "={{ { text: $json.alert_payload.text } }}",
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: "text"
          }
        },
        timeout: policy.provider_timeout_ms
      }
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [780, 80],
    id: "a11e7e00-0000-4000-8000-000000000011",
    name: "Send Slack Alert",
    retryOnFail: false,
    onError: "continueRegularOutput"
  };

  const nodes = [
    schedule,
    activeRead,
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000003",
      name: "Prepare Alert Candidates",
      position: [-980, 180],
      jsCode: prepareCode
    }),
    claimsAppend,
    aggregateNode({
      id: "a11e7e00-0000-4000-8000-000000000005",
      name: "Aggregate Alert Claims",
      position: [-540, 180],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000007",
      name: "Keep Winning Alert Claims",
      position: [-100, 180],
      jsCode: winnersCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "a11e7e00-0000-4000-8000-000000000008",
      name: "Mark Alert Attempts",
      position: [120, 180],
      matchingField: "state_guard",
      fields: [
        "alert_status",
        "processing_stage",
        "processing_commit_guard",
        "processing_token",
        "processing_started_at",
        "alert_last_attempt_at",
        "updated_at"
      ]
    }),
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000009",
      name: "Prepare Alert Delivery",
      position: [340, 180],
      mode: "runOnceForEachItem",
      jsCode: prepareDeliveryCode
    }),
    shouldSend,
    sendSlack,
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000012",
      name: "Finalize Alert Delivery",
      position: [1000, 80],
      mode: "runOnceForEachItem",
      jsCode: finalizeCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "a11e7e00-0000-4000-8000-000000000013",
      name: "Commit Alert Result",
      position: [1240, 180],
      matchingField: "processing_commit_guard",
      fields: alertFields
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Prepare Alert Candidates")]] },
    "Prepare Alert Candidates": { main: [[connection("Append Alert Claims")]] },
    "Append Alert Claims": { main: [[connection("Aggregate Alert Claims")]] },
    "Aggregate Alert Claims": { main: [[connection("Get Processing Claims")]] },
    "Get Processing Claims": { main: [[connection("Keep Winning Alert Claims")]] },
    "Keep Winning Alert Claims": { main: [[connection("Mark Alert Attempts")]] },
    "Mark Alert Attempts": { main: [[connection("Prepare Alert Delivery")]] },
    "Prepare Alert Delivery": { main: [[connection("Should Send Provider Alert")]] },
    "Should Send Provider Alert": {
      main: [
        [connection("Send Slack Alert")],
        [connection("Commit Alert Result")]
      ]
    },
    "Send Slack Alert": { main: [[connection("Finalize Alert Delivery")]] },
    "Finalize Alert Delivery": { main: [[connection("Commit Alert Result")]] }
  };

  return {
    path,
    workflow: {
      name: "Job Application Pipeline - High-Match Alerts",
      nodes,
      connections,
      active: false,
      settings: {
        executionOrder: "v1"
      },
      versionId: "a11e7e00-0000-4000-8000-000000000014",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        alertPolicyVersion: policy.policy_version,
        alertChannel: policy.channel,
        alertPerRunCap: policy.per_run_cap
      },
      tags: []
    }
  };
}

async function buildAnalytics() {
  const path = "workflows/analytics.json";
  const generator = await readJson("workflows/generator.json");
  const archiver = await readJson("workflows/archiver.json");
  const schema = await readJson("config/pipeline-schema.json");
  const policy = await readJson("config/analytics-policy.json");
  const analyticsCore = await bundledCore(
    "src/contracts.mjs",
    "src/analytics.mjs"
  );
  const { validateAnalyticsPolicy } = await import(
    new URL("../src/analytics.mjs", import.meta.url)
  );
  const policyErrors = validateAnalyticsPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(`Invalid analytics policy:\n- ${policyErrors.join("\n- ")}`);
  }

  const activeRead = nodeByName(generator, "Get Active Rows");
  activeRead.id = "a13a17c5-0000-4000-8000-000000000002";
  activeRead.name = "Get Active Rows";
  activeRead.position = [-980, 240];
  activeRead.alwaysOutputData = true;

  const archiveRead = nodeByName(archiver, "Get Archive Rows");
  archiveRead.id = "a13a17c5-0000-4000-8000-000000000004";
  archiveRead.name = "Get Archive Rows";
  archiveRead.position = [-560, 240];
  archiveRead.alwaysOutputData = true;

  const analyticsWriteBase = structuredClone(activeRead);
  analyticsWriteBase.parameters.sheetName = {
    __rl: true,
    value: policy.detail_sheet,
    mode: "name",
    cachedResultName: policy.detail_sheet
  };
  const reportsWriteBase = structuredClone(activeRead);
  reportsWriteBase.parameters.sheetName = {
    __rl: true,
    value: policy.reports_sheet,
    mode: "name",
    cachedResultName: policy.reports_sheet
  };

  const buildCode = `${analyticsCore}

const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(policy)};
const activeRows = ($('Aggregate Active Rows').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const archiveRows = $input.all()
  .map((item) => item.json)
  .filter((row) => row && Object.keys(row).length > 0);
const report = buildAnalyticsReport(
  activeRows,
  archiveRows,
  SCHEMA,
  POLICY,
  new Date().toISOString(),
  { runId: String($execution.id) }
);
console.log(JSON.stringify({
  event: 'analytics_report_built',
  report_id: report.completion.report_id,
  records: report.completion.record_count,
  applications: report.completion.application_count,
  detail_rows: report.completion.detail_row_count,
  warnings: report.completion.warning_summary
}));
return [{
  json: {
    analytics_rows: report.rows,
    completion: report.completion
  }
}];`;

  const prepareRowsCode = `const report = $('Build Analytics Report').first().json;
return (report.analytics_rows || []).map((row) => ({ json: row }));`;

  const prepareCompletionCode = `const report = $('Build Analytics Report').first().json;
const completion = report.completion;
const writes = $json.analytics_rows_written || [];
if (writes.length !== Number(completion.detail_row_count)) {
  throw new Error(
    'Analytics detail refresh incomplete: expected ' +
    completion.detail_row_count + ' rows, observed ' + writes.length
  );
}
return [{ json: completion }];`;

  const schedule = {
    parameters: {
      rule: {
        interval: [
          {
            field: "hours",
            hoursInterval: policy.schedule_hours
          }
        ]
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [-1200, 240],
    id: "a13a17c5-0000-4000-8000-000000000001",
    name: "Schedule Trigger"
  };

  const nodes = [
    schedule,
    activeRead,
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000003",
      name: "Aggregate Active Rows",
      position: [-760, 240],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000005",
      name: "Build Analytics Report",
      position: [-340, 240],
      jsCode: buildCode
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000006",
      name: "Prepare Analytics Rows",
      position: [-100, 240],
      jsCode: prepareRowsCode
    }),
    upsertSheetNode({
      base: analyticsWriteBase,
      id: "a13a17c5-0000-4000-8000-000000000007",
      name: "Upsert Analytics Rows",
      position: [140, 240],
      fields: policy.detail_fields,
      matchingField: "analytics_row_id"
    }),
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000008",
      name: "Aggregate Analytics Row Writes",
      position: [380, 240],
      destinationFieldName: "analytics_rows_written"
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000009",
      name: "Prepare Analytics Completion",
      position: [620, 240],
      jsCode: prepareCompletionCode
    }),
    upsertSheetNode({
      base: reportsWriteBase,
      id: "a13a17c5-0000-4000-8000-000000000010",
      name: "Publish Complete Analytics Report",
      position: [860, 240],
      fields: policy.report_fields,
      matchingField: "report_id"
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": { main: [[connection("Build Analytics Report")]] },
    "Build Analytics Report": { main: [[connection("Prepare Analytics Rows")]] },
    "Prepare Analytics Rows": { main: [[connection("Upsert Analytics Rows")]] },
    "Upsert Analytics Rows": {
      main: [[connection("Aggregate Analytics Row Writes")]]
    },
    "Aggregate Analytics Row Writes": {
      main: [[connection("Prepare Analytics Completion")]]
    },
    "Prepare Analytics Completion": {
      main: [[connection("Publish Complete Analytics Report")]]
    }
  };

  return {
    path,
    workflow: {
      name: "Job Application Pipeline - Conversion Analytics",
      nodes,
      connections,
      active: false,
      settings: {
        executionOrder: "v1"
      },
      versionId: "a13a17c5-0000-4000-8000-000000000011",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        metricDefinitionVersion: policy.metric_definition_version,
        analyticsBandVersion: policy.band_version,
        analyticsScheduleHours: policy.schedule_hours
      },
      tags: []
    }
  };
}

async function buildRecommender() {
  const path = "workflows/recommender.json";
  const analyticsWorkflow = await readJson("workflows/analytics.json");
  const schema = await readJson("config/pipeline-schema.json");
  const policy = await readJson("config/recommendation-policy.json");
  const profile = await readJson("config/candidate-profile.json");
  const recommendationCore = await bundledCore(
    "src/contracts.mjs",
    "src/analytics.mjs",
    "src/recommendations.mjs"
  );
  const { validateRecommendationPolicy } = await import(
    new URL("../src/recommendations.mjs", import.meta.url)
  );
  const policyErrors = validateRecommendationPolicy(policy);
  if (policyErrors.length > 0) {
    throw new Error(
      `Invalid recommendation policy:\n- ${policyErrors.join("\n- ")}`
    );
  }

  const reportsRead = nodeByName(analyticsWorkflow, "Get Active Rows");
  reportsRead.id = "b14b18d6-0000-4000-8000-000000000002";
  reportsRead.name = "Get Analytics Reports";
  reportsRead.position = [-980, 240];
  reportsRead.parameters.operation = "read";
  reportsRead.parameters.sheetName = {
    __rl: true,
    value: policy.source_reports_sheet,
    mode: "name",
    cachedResultName: policy.source_reports_sheet
  };
  reportsRead.alwaysOutputData = true;
  reportsRead.onError = "continueRegularOutput";

  const analyticsRead = structuredClone(reportsRead);
  analyticsRead.id = "b14b18d6-0000-4000-8000-000000000004";
  analyticsRead.name = "Get Analytics Detail";
  analyticsRead.position = [-560, 240];
  analyticsRead.parameters.sheetName = {
    __rl: true,
    value: policy.source_detail_sheet,
    mode: "name",
    cachedResultName: policy.source_detail_sheet
  };

  const recommendationWriteBase = structuredClone(reportsRead);
  recommendationWriteBase.parameters.sheetName = {
    __rl: true,
    value: policy.recommendations_sheet,
    mode: "name",
    cachedResultName: policy.recommendations_sheet
  };
  const reportWriteBase = structuredClone(reportsRead);
  delete reportWriteBase.alwaysOutputData;
  delete reportWriteBase.onError;
  reportWriteBase.parameters.sheetName = {
    __rl: true,
    value: policy.reports_sheet,
    mode: "name",
    cachedResultName: policy.reports_sheet
  };

  const buildCode = `${recommendationCore}

const POLICY = ${JSON.stringify(policy)};
const PROFILE = ${JSON.stringify(profile)};
const reportRows = ($('Aggregate Analytics Reports').first().json.analytics_report_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const analyticsRows = $input.all()
  .map((item) => item.json)
  .filter((row) => row && Object.keys(row).length > 0);
const sourceReadFailed = [...reportRows, ...analyticsRows].some(
  (row) => row.error || row.errorMessage || row.error_description
);
const now = new Date().toISOString();
let result;
try {
  if (sourceReadFailed) throw new Error('analytics source read failed');
  result = buildRecommendationReport(
    analyticsRows,
    reportRows,
    POLICY,
    PROFILE,
    now,
    { attemptId: String($execution.id) }
  );
} catch (error) {
  result = buildRecommendationFailure(POLICY, PROFILE, now, {
    attemptId: String($execution.id),
    category: sourceReadFailed ? 'source_read_failure' : 'processing_failure',
    summary: sourceReadFailed
      ? 'The weekly recommendation source could not be read.'
      : 'The weekly recommendation analysis could not be completed.'
  });
}
console.log(JSON.stringify({
  event: 'weekly_recommendation_report_built',
  run_id: result.report.run_id,
  status: result.report.status,
  result: result.report.result,
  recommendations: result.report.recommendation_count,
  abstentions: result.report.abstention_count,
  detail_rows: result.report.detail_row_count,
  error_category: result.report.error_category
}));
return [{
  json: {
    recommendation_rows: result.rows,
    report: result.report
  }
}];`;

  const prepareRowsCode = `const result = $('Build Weekly Recommendations').first().json;
return (result.recommendation_rows || []).map((row) => ({ json: row }));`;

  const prepareReportCode = `const result = $('Build Weekly Recommendations').first().json;
const report = { ...result.report };
const writes = $json.recommendation_rows_written || [];
const writeFailed = writes.some(
  (row) => row && (row.error || row.errorMessage || row.error_description)
);
if (writeFailed || writes.length !== Number(report.detail_row_count)) {
  report.status = 'failed';
  report.result = 'failed';
  report.error_category = 'detail_write_failure';
  report.error_summary =
    'One or more weekly recommendation detail rows could not be persisted.';
}
console.log(JSON.stringify({
  event: 'weekly_recommendation_report_published',
  run_id: report.run_id,
  status: report.status,
  result: report.result,
  detail_rows_expected: report.detail_row_count,
  detail_rows_observed: writes.length,
  error_category: report.error_category
}));
return [{ json: report }];`;

  const schedule = {
    parameters: {
      rule: {
        interval: [
          {
            field: "hours",
            hoursInterval: policy.schedule_hours
          }
        ]
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [-1200, 240],
    id: "b14b18d6-0000-4000-8000-000000000001",
    name: "Schedule Trigger"
  };

  const upsertRows = upsertSheetNode({
    base: recommendationWriteBase,
    id: "b14b18d6-0000-4000-8000-000000000008",
    name: "Upsert Recommendation Rows",
    position: [380, 240],
    fields: policy.recommendation_fields,
    matchingField: "recommendation_id"
  });
  upsertRows.onError = "continueRegularOutput";

  const nodes = [
    schedule,
    reportsRead,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000003",
      name: "Aggregate Analytics Reports",
      position: [-760, 240],
      destinationFieldName: "analytics_report_rows"
    }),
    analyticsRead,
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000005",
      name: "Build Weekly Recommendations",
      position: [-340, 240],
      jsCode: buildCode
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000006",
      name: "Prepare Recommendation Rows",
      position: [-100, 240],
      jsCode: prepareRowsCode
    }),
    upsertRows,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000009",
      name: "Aggregate Recommendation Row Writes",
      position: [620, 240],
      destinationFieldName: "recommendation_rows_written"
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000010",
      name: "Prepare Recommendation Report",
      position: [860, 240],
      jsCode: prepareReportCode
    }),
    upsertSheetNode({
      base: reportWriteBase,
      id: "b14b18d6-0000-4000-8000-000000000011",
      name: "Publish Recommendation Report",
      position: [1100, 240],
      fields: policy.report_fields,
      matchingField: "run_id"
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Analytics Reports")]] },
    "Get Analytics Reports": {
      main: [[connection("Aggregate Analytics Reports")]]
    },
    "Aggregate Analytics Reports": {
      main: [[connection("Get Analytics Detail")]]
    },
    "Get Analytics Detail": {
      main: [[connection("Build Weekly Recommendations")]]
    },
    "Build Weekly Recommendations": {
      main: [[connection("Prepare Recommendation Rows")]]
    },
    "Prepare Recommendation Rows": {
      main: [[connection("Upsert Recommendation Rows")]]
    },
    "Upsert Recommendation Rows": {
      main: [[connection("Aggregate Recommendation Row Writes")]]
    },
    "Aggregate Recommendation Row Writes": {
      main: [[connection("Prepare Recommendation Report")]]
    },
    "Prepare Recommendation Report": {
      main: [[connection("Publish Recommendation Report")]]
    }
  };

  return {
    path,
    workflow: {
      name: "Job Application Pipeline - Weekly Recommendations",
      nodes,
      connections,
      active: false,
      settings: {
        executionOrder: "v1"
      },
      versionId: "b14b18d6-0000-4000-8000-000000000012",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        recommendationPolicyVersion: policy.policy_version,
        requiredMetricDefinitionVersion:
          policy.required_metric_definition_version,
        requiredAnalyticsBandVersion: policy.required_band_version,
        recommendationScheduleHours: policy.schedule_hours,
        recommendationMode: "read_only_advisory"
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
  await buildReviewer(),
  await buildAlerter(),
  await buildAnalytics(),
  await buildRecommender()
];
for (const workflow of generated) await writeGenerated(workflow);

console.log(checkOnly ? "Workflow exports are up to date." : "Workflow exports rebuilt.");
