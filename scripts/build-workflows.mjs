import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  confirmClaimedReviewUpdates,
  validateAppliedJobsConfig,
  validateReviewQueueConfig,
  validateReviewRuntimeConfig
} from "../src/review.mjs";
import { validateClaimRetentionPolicy } from "../src/claim-retention.mjs";
import { validateReportRetentionPolicy } from "../src/report-retention.mjs";
import {
  validateRuntimeConfig,
  workflowExecutionDataSettings
} from "../src/runtime.mjs";
import {
  analyticsScheduleRule,
  minuteIntervalScheduleRules,
  recommendationScheduleRule,
  validateLearningSchedulePair
} from "../src/schedules.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkOnly = process.argv.includes("--check");

const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const readText = async (path) => readFile(resolve(root, path), "utf8");

function assertValidRuntime(runtime) {
  const errors = validateRuntimeConfig(runtime);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n- ${errors.join("\n- ")}`);
  }
}

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

function appendMergeNode({ id, name, position }) {
  return {
    parameters: {
      mode: "append",
      numberInputs: 2
    },
    type: "n8n-nodes-base.merge",
    typeVersion: 3.2,
    position,
    id,
    name
  };
}

function intervalWaitNode({ id, name, position, milliseconds }) {
  return {
    parameters: {
      resume: "timeInterval",
      amount: milliseconds / 1000,
      unit: "seconds"
    },
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
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

function enforceSingleAttemptFailClosedSheetWrite(node) {
  delete node.onError;
  delete node.continueOnFail;
  delete node.retryOnFail;
  delete node.maxTries;
  delete node.waitBetweenTries;
  return node;
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
  return enforceSingleAttemptFailClosedSheetWrite(node);
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
  return enforceSingleAttemptFailClosedSheetWrite(node);
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
  return enforceSingleAttemptFailClosedSheetWrite(node);
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
  return enforceSingleAttemptFailClosedSheetWrite(node);
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
  pages_requested: coverage.pages_requested,
  maximum_page_requests: coverage.maximum_page_requests,
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
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
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
      interval: minuteIntervalScheduleRules(
        {
          schedule_minutes: plan.schedule_hours * 60,
          schedule_offset_minutes: plan.schedule_offset_minutes
        },
        "discovery schedule"
      )
    }
  };
  schedule.position = [-2600, 260];

  const fetchPage = nodeByAnyName(current, ["HTTP Request", "Fetch Search Page"]);
  fetchPage.name = "Fetch Search Page";
  fetchPage.position = [-2200, 260];
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
  activeRead.position = [600, 120];

  const archiveRead = nodeByAnyName(current, ["Get rows from Archive", "Get Archive Rows"]);
  archiveRead.name = "Get Archive Rows";
  archiveRead.position = [1020, 120];
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
  claimsRead.position = [1900, -100];
  claimsRead.parameters.sheetName = {
    __rl: true,
    value: "ProcessingClaims",
    mode: "name",
    cachedResultName: "ProcessingClaims"
  };
  claimsRead.alwaysOutputData = true;

  const claimsAppend = enforceSingleAttemptFailClosedSheetWrite(
    structuredClone(appendBase)
  );
  claimsAppend.id = "5b0d6e3f-0eae-4d1e-a0b4-000000000013";
  claimsAppend.name = "Append Discovery Claims";
  claimsAppend.position = [1460, -100];
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

  const parseSearchPageCode = (stateNodeName) => `${discoveryCore}

const SEARCH_PLAN = ${JSON.stringify(plan)};
const state = $(${JSON.stringify(stateNodeName)}).item.json;
const request = {
  query_id: state.query_id,
  query: state.query,
  role_family: state.role_family,
  evidence_refs: Array.isArray(state.evidence_refs) ? state.evidence_refs : [],
  page_number: state.page_number,
  request_url: state.request_url
};
const payload = $json || {};
const errorMessage =
  payload.error?.message ||
  payload.message ||
  (typeof payload.error === 'string' ? payload.error : '');
let parsed;
if (errorMessage && !payload.data && !payload.body) {
  parsed = {
      ...request,
      ok: false,
      jobs: [],
      excluded: [],
      malformed: [],
      result_card_count: 0,
      has_next: false,
      reported_last_page: request.page_number,
      error_category: /429|rate/i.test(errorMessage) ? 'rate_limit' : /timeout/i.test(errorMessage) ? 'timeout' : 'request_failure',
      error_summary: String(errorMessage)
        .replace(/https?:\\/\\/\\S+/gi, '[url]')
        .replace(/(api[_-]?key|token|authorization)\\s*[:=]\\s*\\S+/gi, '$1=[redacted]')
        .slice(0, 200)
  };
} else {
  const html = typeof payload === 'string' ? payload : (payload.data || payload.body || '');
  parsed = parseSearchResults(html, request, {
    now: new Date().toISOString(),
    lookbackDays: ${plan.lookback_days}
  });
}
return {
  json: advanceSearchPagination(state, parsed, SEARCH_PLAN)
};`;

  const loadSearchPlan = codeNode({
    id: "5b0d6e3f-0eae-4d1e-a0b4-000000000001",
    name: "Load Search Plan",
    position: [-2400, 260],
    jsCode: `const requests = ${JSON.stringify(requests)};\nreturn requests.map((request) => ({ json: request }));`
  });
  const parseFirstPage = codeNode({
    id: "5b0d6e3f-0eae-4d1e-a0b4-000000000002",
    name: "Parse Search Page",
    position: [-2000, 260],
    mode: "runOnceForEachItem",
    jsCode: parseSearchPageCode("Load Search Plan")
  });
  const paginationNodes = [];
  const paginationConnections = {};
  let paginationTail = parseFirstPage.name;
  for (
    let pageNumber = 2;
    pageNumber <= plan.max_pages_per_query;
    pageNumber += 1
  ) {
    const idBase = 100 + pageNumber * 10;
    const stageX = -1800 + (pageNumber - 2) * 1000;
    const hasPageName = `Has Search Page ${pageNumber}`;
    const waitName = `Wait Before Search Page ${pageNumber}`;
    const fetchName = `Fetch Search Page ${pageNumber}`;
    const parseName = `Parse Search Page ${pageNumber}`;
    const mergeName = `Merge Search Page ${pageNumber} Results`;
    const nodeId = (offset) =>
      `5b0d6e3f-0eae-4d1e-a0b4-${String(idBase + offset).padStart(12, "0")}`;
    const stageFetch = structuredClone(fetchPage);
    stageFetch.id = nodeId(2);
    stageFetch.name = fetchName;
    stageFetch.position = [stageX + 400, 180];
    paginationNodes.push(
      booleanIfNode({
        id: nodeId(0),
        name: hasPageName,
        position: [stageX, 260],
        leftValue: "={{ $json.fetch_next_page === true }}"
      }),
      intervalWaitNode({
        id: nodeId(1),
        name: waitName,
        position: [stageX + 200, 180],
        milliseconds: plan.request_interval_ms
      }),
      stageFetch,
      codeNode({
        id: nodeId(3),
        name: parseName,
        position: [stageX + 600, 180],
        mode: "runOnceForEachItem",
        jsCode: parseSearchPageCode(waitName)
      }),
      appendMergeNode({
        id: nodeId(4),
        name: mergeName,
        position: [stageX + 800, 260]
      })
    );
    paginationConnections[paginationTail] = {
      main: [[connection(hasPageName)]]
    };
    paginationConnections[hasPageName] = {
      main: [
        [connection(waitName)],
        [connection(mergeName, 1)]
      ]
    };
    paginationConnections[waitName] = {
      main: [[connection(fetchName)]]
    };
    paginationConnections[fetchName] = {
      main: [[connection(parseName)]]
    };
    paginationConnections[parseName] = {
      main: [[connection(mergeName, 0)]]
    };
    paginationTail = mergeName;
  }
  const expandPageResults = codeNode({
    id: "5b0d6e3f-0eae-4d1e-a0b4-000000000140",
    name: "Expand Search Page Results",
    position: [200, 260],
    jsCode:
      "return $input.all().flatMap((item) => (item.json.page_results || []).map((page) => ({ json: page })));"
  });
  paginationConnections[paginationTail] = {
    main: [[connection(expandPageResults.name)]]
  };

  const nodes = [
    schedule,
    loadSearchPlan,
    fetchPage,
    parseFirstPage,
    ...paginationNodes,
    expandPageResults,
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000003",
      name: "Aggregate Search Pages",
      position: [400, 260],
      destinationFieldName: "page_results"
    }),
    activeRead,
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000004",
      name: "Aggregate Active Rows",
      position: [820, 120],
      destinationFieldName: "active_rows"
    }),
    archiveRead,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000005",
      name: "Prepare New Jobs",
      position: [1240, -100],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "new" })
    }),
    claimsAppend,
    aggregateNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000014",
      name: "Aggregate Discovery Claims",
      position: [1680, -100],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000015",
      name: "Keep Winning Discovery Claims",
      position: [2110, -100],
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
      position: [2320, -100],
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
      position: [2530, -100],
      fields: workflowFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000007",
      name: "Prepare Active Seen Updates",
      position: [1240, 80],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "active" })
    }),
    updateSheetNode({
      base: appendBase,
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000008",
      name: "Update Active Seen",
      position: [1480, 80],
      fields: seenFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000009",
      name: "Prepare Archive Seen Updates",
      position: [1240, 260],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "archive" })
    }),
    updateSheetNode({
      base: archiveUpdateBase,
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000010",
      name: "Update Archive Seen",
      position: [1480, 260],
      fields: seenFields
    }),
    codeNode({
      id: "5b0d6e3f-0eae-4d1e-a0b4-000000000011",
      name: "Log Discovery Summary",
      position: [1240, 440],
      jsCode: prepareDiscoveryCode({ core: discoveryCore, schema, plan, mode: "summary" })
    })
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Load Search Plan")]] },
    "Load Search Plan": { main: [[connection("Fetch Search Page")]] },
    "Fetch Search Page": { main: [[connection("Parse Search Page")]] },
    ...paginationConnections,
    "Expand Search Page Results": {
      main: [[connection("Aggregate Search Pages")]]
    },
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
        executionOrder: "v1",
        executionTimeout: plan.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      meta: {
        ...current.meta,
        candidateProfileVersion: profile.profile_version,
        searchPlanVersion: plan.plan_version,
        scheduleOffsetMinutes: plan.schedule_offset_minutes,
        pipelineSchemaVersion: schema.storage_version,
        executionTimeoutSeconds: plan.execution_timeout_seconds
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
  const groqPolicy = await readJson("config/groq-provider-policy.json");
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
  const evaluationCore = await bundledCore(
    "src/contracts.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs",
    "src/operational-observability.mjs",
    "src/groq-provider.mjs",
    "src/message-safety.mjs",
    "src/alerts.mjs"
  );
  const { assertValidProfileConfiguration } = await import(
    new URL("../src/profile.mjs", import.meta.url)
  );
  const {
    buildApplicationSystemMessage,
    confirmGenerationClaimMarkers,
    validateApplicationPackPolicy,
    validateRankingPolicy
  } = await import(new URL("../src/evaluation.mjs", import.meta.url));
  const generationClaimConfirmationCore =
    confirmGenerationClaimMarkers.toString();
  const { validateAlertPolicy } = await import(
    new URL("../src/alerts.mjs", import.meta.url)
  );
  const {
    groqInitialUserCharacterBudget,
    resolveGroqGenerationModel,
    validateGroqRuntimeCapacity
  } = await import(new URL("../src/groq-provider.mjs", import.meta.url));
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
  const groqRuntimeErrors = validateGroqRuntimeCapacity(
    groqPolicy,
    runtime.generator
  );
  if (groqRuntimeErrors.length > 0) {
    throw new Error(
      `Unsafe Groq runtime capacity:\n- ${groqRuntimeErrors.join("\n- ")}`
    );
  }
  const groqModel = resolveGroqGenerationModel(groqPolicy);
  const applicationSystemMessage = buildApplicationSystemMessage(
    profile,
    policy
  );
  const initialUserCharacterBudget = groqInitialUserCharacterBudget(
    groqPolicy,
    applicationSystemMessage
  );
  const schedule = nodeByName(current, "Schedule Trigger");
  schedule.position = [-1540, 180];
  schedule.parameters = {
    rule: {
      interval: minuteIntervalScheduleRules(
        runtime.generator,
        "generator schedule"
      )
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
  const activeAfterGenerationMark = structuredClone(activeRead);
  activeAfterGenerationMark.id =
    "ee12f5d9-c0d5-4586-bf62-000000000023";
  activeAfterGenerationMark.name = "Get Active After Generation Mark";
  activeAfterGenerationMark.position = [300, 320];
  activeAfterGenerationMark.alwaysOutputData = true;
  const activeBeforeEvaluationCommit = structuredClone(activeRead);
  activeBeforeEvaluationCommit.id =
    "ee12f5d9-c0d5-4586-bf62-000000000025";
  activeBeforeEvaluationCommit.name =
    "Get Active Before Evaluation Commit";
  activeBeforeEvaluationCommit.position = [1580, 20];
  activeBeforeEvaluationCommit.alwaysOutputData = true;
  const activeBeforeGenerationCommit = structuredClone(activeRead);
  activeBeforeGenerationCommit.id =
    "ee12f5d9-c0d5-4586-bf62-000000000028";
  activeBeforeGenerationCommit.name =
    "Get Active Before Generation Commit";
  activeBeforeGenerationCommit.position = [3020, 440];
  activeBeforeGenerationCommit.alwaysOutputData = true;

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
  fetchDetail.position = [1100, -120];
  fetchDetail.parameters = {
    url: "={{ $json.canonical_url }}",
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
  agent.position = [1340, 440];
  agent.parameters = {
    promptType: "define",
    text: "={{ $json.application_prompt }}",
    options: {
      systemMessage: applicationSystemMessage,
      batching: {
        batchSize: 1,
        delayBetweenBatches: groqPolicy.generation.request_interval_ms
      }
    }
  };
  agent.onError = "continueErrorOutput";

  const groq = nodeByName(current, "Groq Chat Model");
  groq.position = [1580, 760];
  groq.parameters = {
    model: groqModel.id,
    options: {
      maxTokensToSample: groqPolicy.generation.maximum_output_tokens,
      temperature: groqPolicy.generation.temperature
    }
  };

  const repairAgent = structuredClone(agent);
  repairAgent.id = "ee12f5d9-c0d5-4586-bf62-000000000020";
  repairAgent.name = "Repair AI Agent";
  repairAgent.position = [2300, 560];
  repairAgent.parameters = {
    ...repairAgent.parameters,
    text: "={{ $json.repair_prompt }}"
  };
  const repairWait = intervalWaitNode({
    id: "ee12f5d9-c0d5-4586-bf62-000000000022",
    name: "Wait Before Repair",
    position: [2060, 560],
    milliseconds: groqPolicy.generation.request_interval_ms
  });

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
    leaseMs: ${runtime.generator.claim_lease_ms},
    stageCaps: {
      generation: ${runtime.generator.per_run_cap},
      evaluation: ${runtime.generator.evaluation_per_run_cap}
    },
    maximumPriorityWaitMs:
      ${runtime.generator.maximum_priority_wait_minutes} * 60 * 1000
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
      claimed_manual_action: record.manual_action,
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

  const confirmClaimMarkersCode = (plannedNode, event) =>
    `${generationClaimConfirmationCore}

const planned = $('${plannedNode}').all().map((item) => item.json);
const freshRows = $input.all()
  .map((item) => item.json)
  .filter((row) => row && Object.keys(row).length > 0);
const confirmed = confirmGenerationClaimMarkers(planned, freshRows);
console.log(JSON.stringify({
  event: '${event}',
  proposed: planned.length,
  confirmed: confirmed.length,
  rejected: planned.length - confirmed.length
}));
return confirmed.map((record) => ({ json: record }));`;

  const parseDetailCode = `${evaluationCore}

const record = $('Confirm Generation Claim Markers').item.json;
const payload = $json || {};
const errorMessage = externalResultErrorMessage(payload);
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
  console.log(JSON.stringify(generatorResultEvent(failed, 'evaluation')));
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
console.log(JSON.stringify(generatorResultEvent(evaluated, 'evaluation')));
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
const GROQ_POLICY = ${JSON.stringify(groqPolicy)};
const APPLICATION_SYSTEM_MESSAGE = ${JSON.stringify(applicationSystemMessage)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const MESSAGE_SAFETY = {
  profile: PROFILE,
  applicationPolicy: POLICY,
  packPolicy: PACK_POLICY
};
const originalRecord = $('Confirm Generation Claim Markers').item.json;
const record = $('Prepare Application Pack').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
const errorMessage = externalResultErrorMessage(payload);
if (errorMessage && !payload.output) {
  const failed = recordStageFailure(originalRecord, new Error(errorMessage), {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
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
  const repairInstructions = buildApplicationRepairMessage(
    message,
    validation.errors
  );
  const repairPrompt = record.application_prompt + '\\n\\n' + repairInstructions;
  const repairBudget = validateGroqPromptBudget(
    GROQ_POLICY,
    APPLICATION_SYSTEM_MESSAGE,
    repairPrompt
  );
  if (!repairBudget.valid) {
    const failed = recordStageFailure(
      originalRecord,
      new Error(
        'message_validation: repair prompt exceeds provider input budget'
      ),
      {
        stage: 'generation',
        now,
        maxAttempts: ${runtime.generator.retry.max_attempts},
        backoffMs: ${runtime.generator.retry.backoff_ms},
        forceRetryable: true
      }
    );
    console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
    return {
      json: {
        ...failed,
        processing_commit_guard: commitGuard,
        commit_token: commitToken,
        should_repair: false
      }
    };
  }
  return {
    json: {
      ...record,
      rejected_message: message,
      validation_errors: validation.errors,
      repair_prompt: repairPrompt,
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
  console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
console.log(JSON.stringify(generatorResultEvent(generated, 'generation')));
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
const originalRecord = $('Confirm Generation Claim Markers').item.json;
const record = $('Prepare Application Pack').item.json;
const repairContext = $('Validate Initial Draft').item.json;
const payload = $json || {};
const now = new Date().toISOString();
const commitToken = record.processing_token;
const commitGuard =
  record.processing_commit_guard || processingCommitGuard(commitToken);
const errorMessage = externalResultErrorMessage(payload);
if (errorMessage && !payload.output) {
  const failed = recordStageFailure(originalRecord, new Error(errorMessage), {
    stage: 'generation',
    now,
    maxAttempts: ${runtime.generator.retry.max_attempts},
    backoffMs: ${runtime.generator.retry.backoff_ms}
  });
  console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
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
  console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
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
  console.log(JSON.stringify(generatorResultEvent(failed, 'generation')));
  return {
    json: {
      ...failed,
      processing_commit_guard: commitGuard,
      commit_token: commitToken
    }
  };
}
console.log(JSON.stringify(generatorResultEvent(generated, 'generation')));
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
const GROQ_POLICY = ${JSON.stringify(groqPolicy)};
const APPLICATION_SYSTEM_MESSAGE = ${JSON.stringify(applicationSystemMessage)};
const record = $('Confirm Generation Claim Markers').item.json;
const now = new Date().toISOString();
let pack = buildApplicationPack(record, PROFILE, POLICY, PACK_POLICY, now);
let applicationPrompt = '';
let promptBudget = {
  valid: true,
  combined_characters: 0,
  character_based_token_estimate: 0
};
if (pack.application_pack_status === 'ready') {
  try {
    applicationPrompt = buildApplicationUserMessage(record, pack, {
      maximumCharacters: ${initialUserCharacterBudget},
      maximumProofs: ${groqPolicy.generation.maximum_prompt_proofs}
    });
    promptBudget = validateGroqPromptBudget(
      GROQ_POLICY,
      APPLICATION_SYSTEM_MESSAGE,
      applicationPrompt
    );
    if (!promptBudget.valid) throw new Error('provider input budget exceeded');
  } catch {
    pack = {
      ...pack,
      application_pack_status: 'review_required',
      application_warnings: [
        ...(pack.application_warnings || []),
        {
          code: 'provider_prompt_budget',
          severity: 'review',
          summary: 'The application context exceeds the configured provider budget.'
        }
      ]
    };
    applicationPrompt = '';
  }
}
const packErrors = validateApplicationPack(pack, PROFILE, PACK_POLICY);
return {
  json: {
    ...record,
    ...pack,
    application_prompt: applicationPrompt,
    application_pack_ready:
      pack.application_pack_status === 'ready' &&
      packErrors.length === 0 &&
      promptBudget.valid,
    application_pack_gate_errors: packErrors,
    application_prompt_characters: promptBudget.combined_characters,
    application_prompt_character_token_estimate:
      promptBudget.character_based_token_estimate
  }
};`;

  const nonReadyPackCode = `${evaluationCore}

const PROFILE = ${JSON.stringify(profile)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const originalRecord = $('Confirm Generation Claim Markers').item.json;
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
console.log(JSON.stringify(generatorResultEvent(reviewRecord, 'generation')));
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
    aggregateNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000030",
      name: "Aggregate Generation Marks",
      position: [80, 320],
      destinationFieldName: "marks_written"
    }),
    activeAfterGenerationMark,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000024",
      name: "Confirm Generation Claim Markers",
      position: [520, 320],
      jsCode: confirmClaimMarkersCode(
        "Keep Winning Claims",
        "generation_claim_markers"
      )
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
              leftValue: "={{ $json.work_stage }}",
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
      position: [620, 180],
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
              leftValue: "={{ $json.job_description }}",
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
      position: [860, 80],
      id: "ee12f5d9-c0d5-4586-bf62-000000000009",
      name: "Has Stored Description"
    },
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000010",
      name: "Use Stored Detail",
      position: [1100, 20],
      mode: "runOnceForEachItem",
      jsCode: "return { json: $json };"
    }),
    fetchDetail,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000011",
      name: "Parse Job Detail",
      position: [1340, -120],
      mode: "runOnceForEachItem",
      jsCode: parseDetailCode
    }),
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000012",
      name: "Evaluate Job",
      position: [1340, 20],
      mode: "runOnceForEachItem",
      jsCode: evaluateCode
    }),
    activeBeforeEvaluationCommit,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000026",
      name: "Confirm Evaluation Commit Marker",
      position: [1820, 20],
      jsCode: confirmClaimMarkersCode(
        "Evaluate Job",
        "generation_evaluation_commit_marker"
      )
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000013",
      name: "Commit Evaluation Result",
      position: [2060, 20],
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
      position: [860, 440],
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
      position: [1100, 440],
      id: "ee12f5d9-c0d5-4586-bf62-000000000017",
      name: "Is Application Pack Ready"
    },
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000018",
      name: "Persist Non-Ready Pack",
      position: [1340, 300],
      mode: "runOnceForEachItem",
      jsCode: nonReadyPackCode
    }),
    agent,
    groq,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000014",
      name: "Validate Initial Draft",
      position: [1580, 440],
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
      position: [1820, 440],
      id: "ee12f5d9-c0d5-4586-bf62-000000000019",
      name: "Needs Repair"
    },
    repairWait,
    repairAgent,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000021",
      name: "Validate Repaired Message",
      position: [2540, 560],
      mode: "runOnceForEachItem",
      jsCode: validateRepairedMessageCode
    }),
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000027",
      name: "Stage Generation Result For Commit",
      position: [2780, 440],
      mode: "runOnceForEachItem",
      jsCode: "return { json: $json };"
    }),
    activeBeforeGenerationCommit,
    codeNode({
      id: "ee12f5d9-c0d5-4586-bf62-000000000029",
      name: "Confirm Generation Commit Marker",
      position: [3260, 440],
      jsCode: confirmClaimMarkersCode(
        "Stage Generation Result For Commit",
        "generation_result_commit_marker"
      )
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "ee12f5d9-c0d5-4586-bf62-000000000015",
      name: "Commit Generation Result",
      position: [3500, 440],
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
    "Mark Claimed Jobs": {
      main: [[connection("Aggregate Generation Marks")]]
    },
    "Aggregate Generation Marks": {
      main: [[connection("Get Active After Generation Mark")]]
    },
    "Get Active After Generation Mark": {
      main: [[connection("Confirm Generation Claim Markers")]]
    },
    "Confirm Generation Claim Markers": {
      main: [[connection("Is Evaluation Work")]]
    },
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
    "Evaluate Job": {
      main: [[connection("Get Active Before Evaluation Commit")]]
    },
    "Get Active Before Evaluation Commit": {
      main: [[connection("Confirm Evaluation Commit Marker")]]
    },
    "Confirm Evaluation Commit Marker": {
      main: [[connection("Commit Evaluation Result")]]
    },
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
      main: [[connection("Stage Generation Result For Commit")]]
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
        [connection("Wait Before Repair")],
        [connection("Stage Generation Result For Commit")]
      ]
    },
    "Wait Before Repair": {
      main: [[connection("Repair AI Agent")]]
    },
    "Repair AI Agent": {
      main: [
        [connection("Validate Repaired Message")],
        [connection("Validate Repaired Message")]
      ]
    },
    "Validate Repaired Message": {
      main: [[connection("Stage Generation Result For Commit")]]
    },
    "Stage Generation Result For Commit": {
      main: [[connection("Get Active Before Generation Commit")]]
    },
    "Get Active Before Generation Commit": {
      main: [[connection("Confirm Generation Commit Marker")]]
    },
    "Confirm Generation Commit Marker": {
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
        executionOrder: "v1",
        executionTimeout: runtime.generator.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      meta: {
        ...current.meta,
        candidateProfileVersion: profile.profile_version,
        applicationPolicyVersion: policy.policy_version,
        rankingPolicyVersion: rankingPolicy.policy_version,
        applicationPackPolicyVersion: packPolicy.policy_version,
        applicationPackVersion: packPolicy.pack_version,
        alertPolicyVersion: alertPolicy.policy_version,
        groqProviderPolicyVersion: groqPolicy.policy_version,
        groqModel: groqModel.id,
        groqProductionActivation: groqModel.production_activation,
        groqRequestIntervalMilliseconds:
          groqPolicy.generation.request_interval_ms,
        pipelineSchemaVersion: schema.storage_version,
        generatorPerRunCap: runtime.generator.per_run_cap,
        generatorEvaluationPerRunCap:
          runtime.generator.evaluation_per_run_cap,
        generatorMaximumPriorityWaitMinutes:
          runtime.generator.maximum_priority_wait_minutes,
        scheduleMinutes: runtime.generator.schedule_minutes,
        scheduleOffsetMinutes:
          runtime.generator.schedule_offset_minutes,
        executionTimeoutSeconds:
          runtime.generator.execution_timeout_seconds
      }
    }
  };
}

async function buildArchiver() {
  const path = "workflows/archiver.json";
  const current = await readJson(path);
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
  const archiveCore = await bundledCore("src/contracts.mjs", "src/archive.mjs");

  const schedule = nodeByName(current, "Schedule Trigger");
  schedule.position = [-1320, 220];
  schedule.parameters = {
    rule: {
      interval: minuteIntervalScheduleRules(
        runtime.archiver,
        "archiver schedule"
      )
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

  const prepareUpsertsCode = `${archiveCore}

const SCHEMA = ${JSON.stringify(schema)};
const planned = $('Keep Winning Archive Claims').all()
  .map((item) => item.json);
const freshArchiveRows = $input.all()
  .map((item) => item.json)
  .filter((row) => row && Object.keys(row).length > 0);
const preparation = prepareArchiveUpserts(
  planned,
  freshArchiveRows,
  SCHEMA,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'archive_upsert_rebase',
  proposed: planned.length,
  prepared: preparation.upserts.length,
  rejected: preparation.rejected.length,
  rejected_reasons:
    preparation.rejected.map((entry) => entry.reason)
}));
return preparation.upserts.map((record) => ({ json: record }));`;

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

  const archiveBeforeUpsert = structuredClone(archiveRead);
  archiveBeforeUpsert.id =
    "7106c36a-a814-4ea8-9100-000000000018";
  archiveBeforeUpsert.name = "Get Archive Before Upsert";
  archiveBeforeUpsert.position = [780, 360];
  archiveBeforeUpsert.alwaysOutputData = true;

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
    aggregateNode({
      id: "7106c36a-a814-4ea8-9100-000000000017",
      name: "Aggregate Winning Archive Claims",
      position: [580, 360],
      destinationFieldName: "winning_claims"
    }),
    archiveBeforeUpsert,
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
    "Keep Winning Archive Claims": {
      main: [[connection("Aggregate Winning Archive Claims")]]
    },
    "Aggregate Winning Archive Claims": {
      main: [[connection("Get Archive Before Upsert")]]
    },
    "Get Archive Before Upsert": {
      main: [[connection("Prepare Archive Upserts")]]
    },
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
        executionOrder: "v1",
        executionTimeout: runtime.archiver.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      meta: {
        ...current.meta,
        pipelineSchemaVersion: schema.storage_version,
        archiveScheduleMinutes: runtime.archiver.schedule_minutes,
        scheduleOffsetMinutes:
          runtime.archiver.schedule_offset_minutes,
        executionTimeoutSeconds:
          runtime.archiver.execution_timeout_seconds
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
  const runtime = await readJson("config/runtime.json");
  const alertPolicy = await readJson("config/alert-policy.json");
  const deploymentPolicy = await readJson(
    "config/n8n-deployment-policy.json"
  );
  assertValidRuntime(runtime);
  const claimRetentionPolicy = await readJson(
    "config/claim-retention.json"
  );
  const claimRetentionErrors = validateClaimRetentionPolicy(
    claimRetentionPolicy
  );
  if (claimRetentionErrors.length > 0) {
    throw new Error(
      `Invalid claim retention policy:\n- ${claimRetentionErrors.join("\n- ")}`
    );
  }
  const reviewRuntimeErrors = validateReviewRuntimeConfig(reviewConfig);
  if (reviewRuntimeErrors.length > 0) {
    throw new Error(
      `Invalid review runtime configuration:\n- ${reviewRuntimeErrors.join("\n- ")}`
    );
  }
  const reviewQueueErrors = validateReviewQueueConfig(reviewConfig, schema);
  if (reviewQueueErrors.length > 0) {
    throw new Error(
      `Invalid review queue configuration:\n- ${reviewQueueErrors.join("\n- ")}`
    );
  }
  const appliedJobsErrors = validateAppliedJobsConfig(reviewConfig, schema);
  if (appliedJobsErrors.length > 0) {
    throw new Error(
      `Invalid Applied Jobs configuration:\n- ${appliedJobsErrors.join("\n- ")}`
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
    "src/claim-retention.mjs",
    "src/review-efficiency.mjs",
    "src/profile.mjs",
    "src/evaluation.mjs",
    "src/operational-observability.mjs",
    "src/message-safety.mjs",
    "src/review.mjs"
  );
  const reviewClaimConfirmationCore =
    confirmClaimedReviewUpdates.toString();

  const schedule = nodeByName(generator, "Schedule Trigger");
  schedule.id = "88af9ce3-b45f-4aa8-a980-000000000001";
  schedule.position = [-1810, 240];
  schedule.parameters = {
    rule: {
      interval: minuteIntervalScheduleRules(
        reviewConfig,
        "review schedule"
      )
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
  queueRead.parameters.options = {
    ...queueRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  queueRead.alwaysOutputData = true;

  const appliedJobsRead = structuredClone(activeRead);
  appliedJobsRead.id = "88af9ce3-b45f-4aa8-a980-000000000037";
  appliedJobsRead.name = "Get Applied Jobs Rows";
  appliedJobsRead.position = [-340, 240];
  appliedJobsRead.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.applied_jobs.sheet,
    mode: "name",
    cachedResultName: reviewConfig.applied_jobs.sheet
  };
  appliedJobsRead.alwaysOutputData = true;

  const dashboardRead = structuredClone(activeRead);
  dashboardRead.id = "88af9ce3-b45f-4aa8-a980-000000000097";
  dashboardRead.name = "Get Dashboard Rows";
  dashboardRead.position = [80, 240];
  dashboardRead.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.dashboard_sheet,
    mode: "name",
    cachedResultName: reviewConfig.dashboard_sheet
  };
  dashboardRead.parameters.options = {
    ...dashboardRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  dashboardRead.alwaysOutputData = true;

  const planCode = `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const REVIEW_CONFIG = ${JSON.stringify(reviewConfig)};
const CLAIM_RETENTION_POLICY = ${JSON.stringify(claimRetentionPolicy)};
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
const appliedJobsRows = ($('Aggregate Applied Jobs Rows').first().json.applied_jobs_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const dashboardRows = ($('Aggregate Dashboard Rows').first().json.dashboard_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const claimRows = $('Get Processing Claims for Retention').all()
  .map((item) => item.json)
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
    appliedJobsRows,
    reviewConfig: REVIEW_CONFIG,
    executionId: String($execution.id)
  }
);
const queueProjection = buildReviewQueueProjection(
  activeRows,
  SCHEMA,
  REVIEW_CONFIG,
  now
);
const appliedProjection = buildAppliedJobsProjection(
  activeRows,
  archiveRows,
  SCHEMA,
  REVIEW_CONFIG,
  now
);
const dashboardSummary = buildFunnelSummary(
  activeRows,
  archiveRows,
  SCHEMA,
  now
);
const claimRetentionPlan = planProcessingClaimRetention(
  claimRows,
  CLAIM_RETENTION_POLICY,
  now
);
const operationalBacklog = summarizeOperationalBacklog(
  {
    activeRows,
    archiveRows,
    queueRows,
    appliedJobsRows
  },
  SCHEMA,
  {
    now,
    generationLeaseMs: ${runtime.generator.claim_lease_ms},
    processingLeaseMs: {
      evaluation: ${runtime.generator.claim_lease_ms},
      generation: ${runtime.generator.claim_lease_ms},
      alert: ${alertPolicy.claim_lease_ms}
    }
  }
);
const snapshotStatus = reviewSnapshotStatus({
  processed,
  currentQueueRows: queueRows,
  desiredQueueRows: queueProjection.rows,
  queueFields: REVIEW_CONFIG.review_queue.fields,
  currentAppliedRows: appliedJobsRows,
  desiredAppliedRows: appliedProjection.rows,
  appliedFields: REVIEW_CONFIG.applied_jobs.fields,
  currentDashboardRows: dashboardRows,
  dashboardSummary,
  dashboardFields: REVIEW_CONFIG.dashboard_fields,
  projectionInvalidCount:
    queueProjection.invalid_records.length +
    appliedProjection.invalid_records.length,
  claimRetentionPlan
});
console.log(JSON.stringify({
  event: 'review_snapshot_plan',
  ...snapshotStatus,
  processing_claim_rows: claimRetentionPlan.counts.rows_seen,
  processing_claim_threshold_reached:
    claimRetentionPlan.threshold_reached
}));
console.log(JSON.stringify({
  event: 'operational_backlog',
  timestamp: now,
  deployment_policy_version: ${JSON.stringify(deploymentPolicy.policy_version)},
  ...operationalBacklog
}));
return [{
  json: {
    ...processed,
    snapshot_status: snapshotStatus,
    claim_retention_plan: claimRetentionPlan,
    operational_backlog: operationalBacklog
  }
}];`;

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
  const appliedOutcomeUpdateFields = [
    "state_guard",
    "processing_commit_guard",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "outcome",
    "outcome_at",
    "outcome_events",
    "updated_at"
  ];
  const appliedProjectionRefreshFields =
    reviewConfig.applied_jobs.fields.filter((field) => field !== "Action");
  const appliedProjectionClearFields =
    reviewConfig.applied_jobs.fields.filter(
      (field) =>
        !["Action", "canonical_job_id"].includes(field)
    );

  const activeUpdateBase = structuredClone(activeRead);
  const queueAppendBase = structuredClone(activeRead);
  queueAppendBase.parameters.sheetName = structuredClone(
    queueRead.parameters.sheetName
  );
  const appliedJobsAppendBase = structuredClone(activeRead);
  appliedJobsAppendBase.parameters.sheetName = structuredClone(
    appliedJobsRead.parameters.sheetName
  );
  const projectionClaimsRead = structuredClone(activeRead);
  projectionClaimsRead.id = "88af9ce3-b45f-4aa8-a980-000000000083";
  projectionClaimsRead.name = "Get Applied Jobs Projection Claims";
  projectionClaimsRead.position = [1760, 700];
  projectionClaimsRead.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.claims_sheet,
    mode: "name",
    cachedResultName: reviewConfig.claims_sheet
  };
  projectionClaimsRead.alwaysOutputData = true;
  const retentionClaimsRead = structuredClone(projectionClaimsRead);
  retentionClaimsRead.id = "88af9ce3-b45f-4aa8-a980-000000000099";
  retentionClaimsRead.name = "Get Processing Claims for Retention";
  retentionClaimsRead.position = [500, 240];
  const projectionClaimsAppend = appendSheetNode({
    base: activeRead,
    id: "88af9ce3-b45f-4aa8-a980-000000000084",
    name: "Append Applied Jobs Projection Claim",
    position: [1540, 700],
    fields: [
      "canonical_job_id",
      "processing_stage",
      "processing_token",
      "created_at",
      "expires_at"
    ]
  });
  projectionClaimsAppend.parameters.sheetName = structuredClone(
    projectionClaimsRead.parameters.sheetName
  );

  const dashboardNodeBase = structuredClone(dashboardRead);

  const activeAfterReview = structuredClone(activeRead);
  activeAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000017";
  activeAfterReview.name = "Get Active After Review";
  activeAfterReview.position = [500, 20];
  activeAfterReview.alwaysOutputData = true;

  const activeAfterAppliedClaim = structuredClone(activeRead);
  activeAfterAppliedClaim.id =
    "88af9ce3-b45f-4aa8-a980-000000000069";
  activeAfterAppliedClaim.name = "Get Active After Applied Jobs Claims";
  activeAfterAppliedClaim.position = [1340, -320];
  activeAfterAppliedClaim.alwaysOutputData = true;

  const activeAfterQueueClaim = structuredClone(activeRead);
  activeAfterQueueClaim.id =
    "88af9ce3-b45f-4aa8-a980-000000000103";
  activeAfterQueueClaim.name = "Get Active After Review Queue Claims";
  activeAfterQueueClaim.position = [500, -480];
  activeAfterQueueClaim.alwaysOutputData = true;

  const activeAfterDirectClaim = structuredClone(activeRead);
  activeAfterDirectClaim.id =
    "88af9ce3-b45f-4aa8-a980-000000000105";
  activeAfterDirectClaim.name = "Get Active After Direct Review Claims";
  activeAfterDirectClaim.position = [1780, -480];
  activeAfterDirectClaim.alwaysOutputData = true;

  const archiveAfterReview = structuredClone(archiveRead);
  archiveAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000038";
  archiveAfterReview.name = "Get Archive After Review";
  archiveAfterReview.position = [900, 20];
  archiveAfterReview.alwaysOutputData = true;

  const archiveAfterAppliedClaim = structuredClone(archiveRead);
  archiveAfterAppliedClaim.id =
    "88af9ce3-b45f-4aa8-a980-000000000070";
  archiveAfterAppliedClaim.name = "Get Archive After Applied Jobs Claims";
  archiveAfterAppliedClaim.position = [3760, -320];
  archiveAfterAppliedClaim.alwaysOutputData = true;

  const archiveAfterDirectClaim = structuredClone(archiveRead);
  archiveAfterDirectClaim.id =
    "88af9ce3-b45f-4aa8-a980-000000000107";
  archiveAfterDirectClaim.name = "Get Archive After Direct Review Claims";
  archiveAfterDirectClaim.position = [4420, -480];
  archiveAfterDirectClaim.alwaysOutputData = true;

  const queueAfterReview = structuredClone(queueRead);
  queueAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000019";
  queueAfterReview.name = "Get Review Queue After Review";
  queueAfterReview.position = [900, 20];

  const appliedJobsAfterReview = structuredClone(appliedJobsRead);
  appliedJobsAfterReview.id = "88af9ce3-b45f-4aa8-a980-000000000039";
  appliedJobsAfterReview.name = "Get Applied Jobs After Review";
  appliedJobsAfterReview.position = [1320, 20];
  appliedJobsAfterReview.alwaysOutputData = true;

  const appliedJobsBeforeCleanup = structuredClone(appliedJobsRead);
  appliedJobsBeforeCleanup.id = "88af9ce3-b45f-4aa8-a980-000000000066";
  appliedJobsBeforeCleanup.name = "Get Applied Jobs Before Cleanup";
  appliedJobsBeforeCleanup.position = [1540, 500];
  appliedJobsBeforeCleanup.alwaysOutputData = true;

  const appliedJobsAfterMaintenance = structuredClone(appliedJobsRead);
  appliedJobsAfterMaintenance.id =
    "88af9ce3-b45f-4aa8-a980-000000000088";
  appliedJobsAfterMaintenance.name = "Get Applied Jobs After Maintenance";
  appliedJobsAfterMaintenance.position = [3300, 500];
  appliedJobsAfterMaintenance.alwaysOutputData = true;

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

  const clearAppliedJobsRows = updateSheetByFieldNode({
    base: appliedJobsAppendBase,
    id: "88af9ce3-b45f-4aa8-a980-000000000040",
    name: "Clear Stale Applied Jobs Rows",
    position: [2860, 420],
    fields: appliedProjectionClearFields,
    matchingField: "canonical_job_id"
  });

  const reconciliationCode = `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const REVIEW_CONFIG = ${JSON.stringify(reviewConfig)};
const activeRows = ($('Aggregate Active After Review').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const archiveRows = ($('Aggregate Archive After Review').first().json.archive_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const currentQueueRows = ($('Aggregate Current Review Queue').first().json.queue_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const initialQueueRows = ($('Aggregate Review Queue Rows').first().json.queue_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const currentAppliedJobsRows = ($('Aggregate Current Applied Jobs').first().json.applied_jobs_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const initialAppliedJobsRows = ($('Aggregate Applied Jobs Rows').first().json.applied_jobs_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const reviewQueue = reconcileReviewQueue(
  activeRows,
  currentQueueRows,
  initialQueueRows,
  SCHEMA,
  REVIEW_CONFIG,
  new Date().toISOString()
);
const appliedJobs = reconcileAppliedJobs(
  activeRows,
  archiveRows,
  currentAppliedJobsRows,
  initialAppliedJobsRows,
  SCHEMA,
  REVIEW_CONFIG,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'review_projection_reconciliation',
  review_queue_projected: reviewQueue.queue_rows.length,
  review_queue_deleted: reviewQueue.delete_rows.length,
  review_queue_protected_actions: reviewQueue.protected_action_count,
  review_queue_unchanged: reviewQueue.unchanged_row_count,
  applied_jobs_projected: appliedJobs.applied_rows.length,
  applied_jobs_cleared: appliedJobs.clear_rows.length,
  applied_jobs_protected_actions: appliedJobs.protected_action_count,
  invalid_records: [
    ...reviewQueue.invalid_records,
    ...appliedJobs.invalid_records
  ]
}));
return [{ json: {
  queue_rows: reviewQueue.queue_rows,
  queue_delete_rows: reviewQueue.delete_rows,
  queue_protected_action_count: reviewQueue.protected_action_count,
  queue_unchanged_row_count: reviewQueue.unchanged_row_count,
  applied_rows: appliedJobs.applied_rows,
  applied_clear_rows: appliedJobs.clear_rows,
  applied_protected_action_count: appliedJobs.protected_action_count,
  applied_desired_rows: appliedJobs.desired_rows,
  applied_rebase_rows: appliedJobs.rebase_rows,
  invalid_records: [
    ...reviewQueue.invalid_records,
    ...appliedJobs.invalid_records
  ]
} }];`;

  const finalAppliedJobsCleanupCode = `${reviewCore}

const planned = $('Prepare Review Queue Reconciliation').first().json;
const previousRows =
  $('Aggregate Current Applied Jobs').first().json.applied_jobs_rows || [];
const latestRows =
  $('Aggregate Applied Jobs Before Cleanup').first().json.applied_jobs_rows || [];
return [{
  json: finalizeAppliedJobsCleanup(planned, previousRows, latestRows)
}];`;

  const projectionClaimCode = `${reviewCore}

const now = new Date().toISOString();
const record = {
  canonical_job_id: 'system:applied-jobs-projection',
  work_stage: 'applied_jobs_projection'
};
const claim = createProcessingClaim(
  record,
  String($execution.id),
  now,
  ${reviewConfig.projection_claim_lease_ms}
);
return [{ json: { ...record, ...claim } }];`;

  const projectionWinnerCode = `${reviewCore}

const proposed = $('Prepare Applied Jobs Projection Claim').all()
  .map((item) => item.json);
const claims = $input.all()
  .map((item) => item.json)
  .filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(
  proposed,
  claims,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'applied_jobs_projection_claim',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const appliedJobsDocumentId = activeRead.parameters.documentId.value;
  const appliedJobsMetadataUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${appliedJobsDocumentId}` +
    "?fields=sheets.properties";
  const appliedJobsBatchUpdateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${appliedJobsDocumentId}` +
    ":batchUpdate";
  const appliedAtColumn = reviewConfig.applied_jobs.fields.indexOf("Applied at");
  const identityColumn =
    reviewConfig.applied_jobs.fields.indexOf("canonical_job_id");
  const appliedJobsMaintenanceCode = `
const CONFIG = ${JSON.stringify(reviewConfig.applied_jobs)};
const rows =
  $('Aggregate Applied Jobs After Maintenance').first().json.applied_jobs_rows ||
  [];
const metadata = $input.first().json;
const sheet = (metadata.sheets || []).find(
  (entry) => entry?.properties?.title === CONFIG.sheet
);
if (!sheet || !Number.isInteger(Number(sheet.properties.sheetId))) {
  throw new Error('Applied Jobs sheet metadata is missing');
}
const dataRows = rows.filter(
  (row) => row && Object.keys(row).length > 0
);
if (dataRows.length === 0) return [];
const visibleFields = CONFIG.visible_columns || [];
const identityFoldCounts = new Map();
for (const row of dataRows) {
  const identity = String(row.canonical_job_id || '').trim();
  const foldedIdentity = identity.normalize('NFKC').toLocaleLowerCase('en-US');
  identityFoldCounts.set(
    foldedIdentity,
    (identityFoldCounts.get(foldedIdentity) || 0) + 1
  );
}
const tombstoneIdentities = dataRows
  .filter((row) => {
    const identity = String(row.canonical_job_id || '').trim();
    const foldedIdentity = identity
      .normalize('NFKC')
      .toLocaleLowerCase('en-US');
    return (
      identity &&
      identityFoldCounts.get(foldedIdentity) === 1 &&
      !String(row.Action || '').trim() &&
      !String(row.source_state_guard || '').trim() &&
      visibleFields.every((field) => !String(row[field] || '').trim())
    );
  })
  .map((row) => String(row.canonical_job_id).trim());
const sheetId = Number(sheet.properties.sheetId);
const columnCount = CONFIG.fields.length;
const dataRange = (rowCount) => ({
  sheetId,
  startRowIndex: 1,
  endRowIndex: 1 + rowCount,
  startColumnIndex: 0,
  endColumnIndex: columnCount
});
const sortRequest = (sortSpecs) => ({
  sortRange: {
    range: {
      sheetId,
      startRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: columnCount
    },
    sortSpecs
  }
});
const requests = [];
if (tombstoneIdentities.length > 0) {
  const templateCount = tombstoneIdentities.length;
  requests.push({
    insertDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: 1,
        endIndex: 1 + templateCount
      },
      inheritFromBefore: false
    }
  });
  requests.push({
    updateCells: {
      rows: tombstoneIdentities.map((identity) => ({
        values: [{ userEnteredValue: { stringValue: identity } }]
      })),
      fields: 'userEnteredValue',
      range: {
        sheetId,
        startRowIndex: 1,
        endRowIndex: 1 + templateCount,
        startColumnIndex: ${identityColumn},
        endColumnIndex: ${identityColumn + 1}
      }
    }
  });
  requests.push({
    deleteDuplicates: {
      range: dataRange(dataRows.length + templateCount),
      comparisonColumns: Array.from({ length: columnCount }, (_, index) => ({
        sheetId,
        dimension: 'COLUMNS',
        startIndex: index,
        endIndex: index + 1
      }))
    }
  });
  requests.push({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: 1,
        endIndex: 1 + templateCount
      }
    }
  });
}
if (dataRows.length > 1 || tombstoneIdentities.length > 0) {
  requests.push(sortRequest([
    { dimensionIndex: ${appliedAtColumn}, sortOrder: 'DESCENDING' },
    { dimensionIndex: ${identityColumn}, sortOrder: 'ASCENDING' }
  ]));
}
if (requests.length === 0) return [];
return [{ json: {
  batch_update: { requests },
  applied_jobs_rows: dataRows.length,
  applied_jobs_retirement_candidates: tombstoneIdentities.length
} }];`;

  const googleSheetsCredentials = structuredClone(activeRead.credentials);
  const appliedJobsMetadata = {
    id: "88af9ce3-b45f-4aa8-a980-000000000090",
    name: "Get Applied Jobs Sheet Metadata",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [3740, 500],
    parameters: {
      url: appliedJobsMetadataUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      options: {}
    },
    credentials: googleSheetsCredentials
  };
  const appliedJobsBatchUpdate = {
    id: "88af9ce3-b45f-4aa8-a980-000000000092",
    name: "Sort and Retire Applied Jobs Rows",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [4180, 500],
    parameters: {
      method: "POST",
      url: appliedJobsBatchUpdateUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify($json.batch_update) }}",
      options: {}
    },
    credentials: googleSheetsCredentials
  };
  const claimRetentionPlanCode = `
const plan =
  $('Prepare Review Plan').first().json.claim_retention_plan;
console.log(JSON.stringify({
  event: 'processing_claim_cleanup_plan',
  policy_version: plan.policy_version,
  enabled: plan.enabled,
  threshold_reached: plan.threshold_reached,
  retention_cutoff_at: plan.retention_cutoff_at,
  ...plan.counts,
  delete_ranges: plan.delete_ranges.length
}));
return plan.delete_ranges.length > 0 ? [{ json: plan }] : [];`;
  const claimRetentionBatchCode = `
const SHEET_NAME = ${JSON.stringify(reviewConfig.claims_sheet)};
const plan = $('Plan Processing Claims Cleanup').first().json;
const metadata = $input.first().json;
const sheet = (metadata.sheets || []).find(
  (entry) => entry?.properties?.title === SHEET_NAME
);
const sheetId = Number(sheet?.properties?.sheetId);
if (!Number.isInteger(sheetId) || sheetId < 0) {
  throw new Error('ProcessingClaims sheet metadata is missing');
}
if (!Array.isArray(plan.delete_ranges) || plan.delete_ranges.length === 0) {
  return [];
}
const requests = plan.delete_ranges.map((range) => ({
  deleteDimension: {
    range: {
      sheetId,
      dimension: 'ROWS',
      startIndex: range.start_index,
      endIndex: range.end_index
    }
  }
}));
return [{ json: {
  batch_update: { requests },
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  rows_seen: plan.counts.rows_seen,
  rows_deleted: plan.counts.selected,
  delete_ranges: requests.length
} }];`;
  const claimRetentionLogCode = `
const plan = $('Prepare Processing Claims Batch Cleanup').first().json;
console.log(JSON.stringify({
  event: 'processing_claim_cleanup_committed',
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  rows_seen: plan.rows_seen,
  rows_deleted: plan.rows_deleted,
  delete_ranges: plan.delete_ranges
}));
return [{ json: {
  event: 'processing_claim_cleanup_committed',
  policy_version: plan.policy_version,
  rows_deleted: plan.rows_deleted,
  delete_ranges: plan.delete_ranges
} }];`;
  const processingClaimsMetadata = {
    id: "88af9ce3-b45f-4aa8-a980-000000000093",
    name: "Get Processing Claims Sheet Metadata",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [2420, 780],
    parameters: {
      url: appliedJobsMetadataUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      options: {}
    },
    credentials: googleSheetsCredentials
  };
  const processingClaimsBatchUpdate = {
    id: "88af9ce3-b45f-4aa8-a980-000000000095",
    name: "Delete Expired Processing Claims",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [2860, 780],
    parameters: {
      method: "POST",
      url: appliedJobsBatchUpdateUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify($json.batch_update) }}",
      options: {}
    },
    retryOnFail: false,
    credentials: googleSheetsCredentials
  };

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
    appliedJobsRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000041",
      name: "Aggregate Applied Jobs Rows",
      position: [-130, 240],
      destinationFieldName: "applied_jobs_rows"
    }),
    dashboardRead,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000098",
      name: "Aggregate Dashboard Rows",
      position: [290, 240],
      destinationFieldName: "dashboard_rows"
    }),
    retentionClaimsRead,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000030",
      name: "Prepare Review Plan",
      position: [710, 240],
      jsCode: planCode
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000100",
      name: "Has Review Snapshot Changes",
      position: [930, 240],
      leftValue: "={{ $json.snapshot_status.refresh_required === true }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000101",
      name: "Log Unchanged Review Snapshot",
      position: [1150, 360],
      jsCode: `const status =
  $('Prepare Review Plan').first().json.snapshot_status;
console.log(JSON.stringify({
  event: 'review_snapshot_unchanged',
  ...status
}));
return [{ json: {
  event: 'review_snapshot_unchanged',
  ...status
} }];`
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000031",
      name: "Has Active Review Updates",
      position: [-120, 20],
      leftValue: "={{ $json.active_queue_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000032",
      name: "Prepare Active Review Claims",
      position: [100, -80],
      jsCode:
        "return $('Prepare Review Plan').first().json.active_queue_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000033",
      name: "Mark Active Review Claims",
      position: [300, -80],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000109",
      name: "Aggregate Active Review Claim Marks",
      position: [500, -600],
      destinationFieldName: "marks_written"
    }),
    activeAfterQueueClaim,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000104",
      name: "Aggregate Active After Review Queue Claims",
      position: [700, -480],
      destinationFieldName: "active_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000034",
      name: "Prepare Claimed Active Review Updates",
      position: [500, -80],
      jsCode: `${reviewClaimConfirmationCore}

const plan = $('Prepare Review Plan').first().json;
const fresh = $input.first().json.active_rows || [];
return confirmClaimedReviewUpdates(
  plan.active_queue_updates,
  plan.active_queue_claims,
  fresh
).map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000006",
      name: "Update Active Review Actions",
      position: [700, -80],
      matchingField: "processing_commit_guard",
      fields: updateFields
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000071",
      name: "Has Active Applied Jobs Updates",
      position: [900, -240],
      leftValue:
        "={{ $('Prepare Review Plan').first().json.active_applied_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000072",
      name: "Prepare Active Applied Jobs Claims",
      position: [1120, -320],
      jsCode:
        "return $('Prepare Review Plan').first().json.active_applied_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000073",
      name: "Mark Active Applied Jobs Claims",
      position: [1340, -320],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000110",
      name: "Aggregate Active Applied Jobs Claim Marks",
      position: [1560, -600],
      destinationFieldName: "marks_written"
    }),
    activeAfterAppliedClaim,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000074",
      name: "Aggregate Active After Applied Jobs Claims",
      position: [1780, -320],
      destinationFieldName: "active_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000075",
      name: "Prepare Claimed Active Applied Jobs Updates",
      position: [2000, -320],
      jsCode: `${reviewClaimConfirmationCore}

const plan = $('Prepare Review Plan').first().json;
const fresh = $input.first().json.active_rows || [];
return confirmClaimedReviewUpdates(
  plan.active_applied_updates,
  plan.active_applied_claims,
  fresh
).map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000076",
      name: "Update Active Applied Jobs Actions",
      position: [2220, -320],
      matchingField: "processing_commit_guard",
      fields: appliedOutcomeUpdateFields
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000077",
      name: "Aggregate Active Applied Jobs Updates",
      position: [2440, -320],
      destinationFieldName: "updated_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000054",
      name: "Has Active Direct Review Updates",
      position: [1120, -80],
      leftValue:
        "={{ $('Prepare Review Plan').first().json.active_direct_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000055",
      name: "Prepare Active Direct Review Claims",
      position: [1340, -180],
      jsCode:
        "return $('Prepare Review Plan').first().json.active_direct_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000056",
      name: "Mark Active Direct Review Claims",
      position: [1560, -180],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000111",
      name: "Aggregate Active Direct Review Claim Marks",
      position: [1780, -600],
      destinationFieldName: "marks_written"
    }),
    activeAfterDirectClaim,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000106",
      name: "Aggregate Active After Direct Review Claims",
      position: [1980, -480],
      destinationFieldName: "active_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000057",
      name: "Prepare Claimed Active Direct Review Updates",
      position: [1780, -180],
      jsCode: `${reviewClaimConfirmationCore}

const plan = $('Prepare Review Plan').first().json;
const fresh = $input.first().json.active_rows || [];
return confirmClaimedReviewUpdates(
  plan.active_direct_updates,
  plan.active_direct_claims,
  fresh
).map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000058",
      name: "Update Active Direct Review Actions",
      position: [2000, -180],
      matchingField: "processing_commit_guard",
      fields: updateFields
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000059",
      name: "Aggregate Active Direct Review Updates",
      position: [2220, -180],
      destinationFieldName: "updated_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000042",
      name: "Has Archive Review Updates",
      position: [2440, -80],
      leftValue:
        "={{ $('Prepare Review Plan').first().json.archive_projection_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000007",
      name: "Prepare Archive Review Claims",
      position: [2660, -180],
      jsCode:
        "return $('Prepare Review Plan').first().json.archive_projection_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000008",
      name: "Mark Archive Review Claims",
      position: [2880, -180],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000112",
      name: "Aggregate Archive Review Claim Marks",
      position: [3100, -600],
      destinationFieldName: "marks_written"
    }),
    archiveAfterAppliedClaim,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000078",
      name: "Aggregate Archive After Applied Jobs Claims",
      position: [3980, -320],
      destinationFieldName: "archive_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000043",
      name: "Prepare Claimed Archive Review Updates",
      position: [3100, -180],
      jsCode: `${reviewClaimConfirmationCore}

const plan = $('Prepare Review Plan').first().json;
const fresh = $input.first().json.archive_rows || [];
return confirmClaimedReviewUpdates(
  plan.archive_projection_updates,
  plan.archive_projection_claims,
  fresh
).map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000044",
      name: "Update Archive Review Actions",
      position: [3320, -180],
      matchingField: "processing_commit_guard",
      fields: appliedOutcomeUpdateFields
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000045",
      name: "Aggregate Archive Review Updates",
      position: [3540, -180],
      destinationFieldName: "updated_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000060",
      name: "Has Archive Direct Review Updates",
      position: [3760, -80],
      leftValue:
        "={{ $('Prepare Review Plan').first().json.archive_direct_updates.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000061",
      name: "Prepare Archive Direct Review Claims",
      position: [3980, -180],
      jsCode:
        "return $('Prepare Review Plan').first().json.archive_direct_claims.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000062",
      name: "Mark Archive Direct Review Claims",
      position: [4200, -180],
      matchingField: "state_guard",
      fields: ["processing_commit_guard"]
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000113",
      name: "Aggregate Archive Direct Review Claim Marks",
      position: [4420, -600],
      destinationFieldName: "marks_written"
    }),
    archiveAfterDirectClaim,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000108",
      name: "Aggregate Archive After Direct Review Claims",
      position: [4620, -480],
      destinationFieldName: "archive_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000063",
      name: "Prepare Claimed Archive Direct Review Updates",
      position: [4420, -180],
      jsCode: `${reviewClaimConfirmationCore}

const plan = $('Prepare Review Plan').first().json;
const fresh = $input.first().json.archive_rows || [];
return confirmClaimedReviewUpdates(
  plan.archive_direct_updates,
  plan.archive_direct_claims,
  fresh
).map((record) => ({ json: record }));`
    }),
    updateSheetByFieldNode({
      base: archiveRead,
      id: "88af9ce3-b45f-4aa8-a980-000000000064",
      name: "Update Archive Direct Review Actions",
      position: [4640, -180],
      matchingField: "processing_commit_guard",
      fields: updateFields
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000065",
      name: "Aggregate Archive Direct Review Updates",
      position: [4860, -180],
      destinationFieldName: "updated_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000009",
      name: "Prepare Funnel Summary",
      position: [-120, 500],
      jsCode: `${reviewCore}

const SCHEMA = ${JSON.stringify(schema)};
const activeRows = ($('Aggregate Active After Review').first().json.active_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const archiveRows = ($('Aggregate Archive After Review').first().json.archive_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const dashboardRows = ($('Aggregate Dashboard Rows').first().json.dashboard_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const summary = buildFunnelSummary(
  activeRows,
  archiveRows,
  SCHEMA,
  new Date().toISOString()
);
const reusable = reusableFunnelSummary(
  dashboardRows,
  summary,
  ${JSON.stringify(reviewConfig.dashboard_fields)}
);
console.log(JSON.stringify({
  event: 'dashboard_summary',
  action: reusable ? 'unchanged' : 'publish',
  metric_key: summary.metric_key
}));
return [{
  json: {
    ...summary,
    publish_required: !reusable
  }
}];`
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000102",
      name: "Has Dashboard Changes",
      position: [100, 500],
      leftValue: "={{ $json.publish_required === true }}"
    }),
    upsertSheetNode({
      base: dashboardNodeBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000010",
      name: "Update Dashboard Summary",
      position: [320, 500],
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
  processed_queue_actions: processed.processed_queue_actions.length,
  processed_applied_actions: processed.processed_applied_actions.length
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
    archiveAfterReview,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000046",
      name: "Aggregate Archive After Review",
      position: [1110, 20],
      destinationFieldName: "archive_rows"
    }),
    queueAfterReview,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000020",
      name: "Aggregate Current Review Queue",
      position: [1110, 20],
      destinationFieldName: "queue_rows"
    }),
    appliedJobsAfterReview,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000047",
      name: "Aggregate Current Applied Jobs",
      position: [1530, 20],
      destinationFieldName: "applied_jobs_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000021",
      name: "Prepare Review Queue Reconciliation",
      position: [1320, 20],
      jsCode: reconciliationCode
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000085",
      name: "Prepare Applied Jobs Projection Claim",
      position: [1320, 700],
      jsCode: projectionClaimCode
    }),
    projectionClaimsAppend,
    projectionClaimsRead,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000086",
      name: "Keep Winning Applied Jobs Projection Claim",
      position: [1980, 700],
      jsCode: projectionWinnerCode
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000087",
      name: "Plan Processing Claims Cleanup",
      position: [2200, 780],
      jsCode: claimRetentionPlanCode
    }),
    processingClaimsMetadata,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000094",
      name: "Prepare Processing Claims Batch Cleanup",
      position: [2640, 780],
      jsCode: claimRetentionBatchCode
    }),
    processingClaimsBatchUpdate,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000096",
      name: "Log Processing Claims Cleanup",
      position: [3080, 780],
      jsCode: claimRetentionLogCode
    }),
    appliedJobsBeforeCleanup,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000067",
      name: "Aggregate Applied Jobs Before Cleanup",
      position: [1760, 500],
      destinationFieldName: "applied_jobs_rows"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000068",
      name: "Finalize Applied Jobs Cleanup",
      position: [1980, 500],
      jsCode: finalAppliedJobsCleanupCode
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000022",
      name: "Has Review Queue Deletions",
      position: [1540, 20],
      leftValue: "={{ $json.queue_delete_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000023",
      name: "Prepare Review Queue Deletions",
      position: [1760, -60],
      jsCode:
        "return $('Prepare Review Queue Reconciliation').first().json.queue_delete_rows.map((record) => ({ json: record }));"
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
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000079",
      name: "Has Applied Jobs Rebases",
      position: [1980, 620],
      leftValue: "={{ $json.applied_rebase_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000080",
      name: "Prepare Applied Jobs Rebases",
      position: [2200, 620],
      jsCode:
        "return $('Finalize Applied Jobs Cleanup').first().json.applied_rebase_rows.map((record) => ({ json: record }));"
    }),
    updateSheetByFieldNode({
      base: appliedJobsAppendBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000081",
      name: "Refresh Protected Applied Jobs Rows",
      position: [2420, 620],
      fields: appliedProjectionRefreshFields.filter(
        (field) => field !== "canonical_job_id"
      ),
      matchingField: "canonical_job_id"
    }),
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000082",
      name: "Aggregate Applied Jobs Rebases",
      position: [2640, 620],
      destinationFieldName: "updated_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000048",
      name: "Has Applied Jobs Clears",
      position: [2200, 500],
      leftValue: "={{ $json.applied_clear_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000049",
      name: "Prepare Applied Jobs Clears",
      position: [2420, 420],
      jsCode:
        "return $('Finalize Applied Jobs Cleanup').first().json.applied_clear_rows.map((record) => ({ json: record }));"
    }),
    clearAppliedJobsRows,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000050",
      name: "Aggregate Applied Jobs Clears",
      position: [3080, 420],
      destinationFieldName: "cleared_rows"
    }),
    booleanIfNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000051",
      name: "Has Applied Jobs Upserts",
      position: [2500, 500],
      leftValue:
        "={{ $('Finalize Applied Jobs Cleanup').first().json.applied_rows.length > 0 }}"
    }),
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000052",
      name: "Prepare Applied Jobs Upserts",
      position: [2720, 420],
      jsCode:
        "return $('Finalize Applied Jobs Cleanup').first().json.applied_rows.map((record) => ({ json: record }));"
    }),
    upsertSheetNode({
      base: appliedJobsAppendBase,
      id: "88af9ce3-b45f-4aa8-a980-000000000053",
      name: "Upsert Applied Jobs Rows",
      position: [2940, 420],
      fields: appliedProjectionRefreshFields,
      matchingField: "canonical_job_id"
    }),
    appliedJobsAfterMaintenance,
    aggregateNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000089",
      name: "Aggregate Applied Jobs After Maintenance",
      position: [3520, 500],
      destinationFieldName: "applied_jobs_rows"
    }),
    appliedJobsMetadata,
    codeNode({
      id: "88af9ce3-b45f-4aa8-a980-000000000091",
      name: "Prepare Applied Jobs Atomic Cleanup",
      position: [3960, 500],
      jsCode: appliedJobsMaintenanceCode
    }),
    appliedJobsBatchUpdate
  ];

  const connections = {
    "Schedule Trigger": { main: [[connection("Get Active Rows")]] },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": { main: [[connection("Aggregate Archive Rows")]] },
    "Aggregate Archive Rows": { main: [[connection("Get Review Queue Rows")]] },
    "Get Review Queue Rows": { main: [[connection("Aggregate Review Queue Rows")]] },
    "Aggregate Review Queue Rows": { main: [[connection("Get Applied Jobs Rows")]] },
    "Get Applied Jobs Rows": { main: [[connection("Aggregate Applied Jobs Rows")]] },
    "Aggregate Applied Jobs Rows": { main: [[connection("Get Dashboard Rows")]] },
    "Get Dashboard Rows": { main: [[connection("Aggregate Dashboard Rows")]] },
    "Aggregate Dashboard Rows": {
      main: [[connection("Get Processing Claims for Retention")]]
    },
    "Get Processing Claims for Retention": {
      main: [[connection("Prepare Review Plan")]]
    },
    "Prepare Review Plan": {
      main: [[connection("Has Review Snapshot Changes")]]
    },
    "Has Review Snapshot Changes": {
      main: [
        [
          connection("Has Active Review Updates"),
          connection("Log Invalid Review Actions")
        ],
        [connection("Log Unchanged Review Snapshot")]
      ]
    },
    "Has Active Review Updates": {
      main: [
        [connection("Prepare Active Review Claims")],
        [connection("Has Active Applied Jobs Updates")]
      ]
    },
    "Prepare Active Review Claims": { main: [[connection("Mark Active Review Claims")]] },
    "Mark Active Review Claims": {
      main: [[connection("Aggregate Active Review Claim Marks")]]
    },
    "Aggregate Active Review Claim Marks": {
      main: [[connection("Get Active After Review Queue Claims")]]
    },
    "Get Active After Review Queue Claims": {
      main: [[connection("Aggregate Active After Review Queue Claims")]]
    },
    "Aggregate Active After Review Queue Claims": {
      main: [[connection("Prepare Claimed Active Review Updates")]]
    },
    "Prepare Claimed Active Review Updates": {
      main: [[connection("Update Active Review Actions")]]
    },
    "Update Active Review Actions": {
      main: [[connection("Aggregate Active Review Updates")]]
    },
    "Aggregate Active Review Updates": {
      main: [[connection("Has Active Applied Jobs Updates")]]
    },
    "Has Active Applied Jobs Updates": {
      main: [
        [connection("Prepare Active Applied Jobs Claims")],
        [connection("Has Active Direct Review Updates")]
      ]
    },
    "Prepare Active Applied Jobs Claims": {
      main: [[connection("Mark Active Applied Jobs Claims")]]
    },
    "Mark Active Applied Jobs Claims": {
      main: [[connection("Aggregate Active Applied Jobs Claim Marks")]]
    },
    "Aggregate Active Applied Jobs Claim Marks": {
      main: [[connection("Get Active After Applied Jobs Claims")]]
    },
    "Get Active After Applied Jobs Claims": {
      main: [[connection("Aggregate Active After Applied Jobs Claims")]]
    },
    "Aggregate Active After Applied Jobs Claims": {
      main: [[connection("Prepare Claimed Active Applied Jobs Updates")]]
    },
    "Prepare Claimed Active Applied Jobs Updates": {
      main: [[connection("Update Active Applied Jobs Actions")]]
    },
    "Update Active Applied Jobs Actions": {
      main: [[connection("Aggregate Active Applied Jobs Updates")]]
    },
    "Aggregate Active Applied Jobs Updates": {
      main: [[connection("Has Active Direct Review Updates")]]
    },
    "Has Active Direct Review Updates": {
      main: [
        [connection("Prepare Active Direct Review Claims")],
        [connection("Has Archive Review Updates")]
      ]
    },
    "Prepare Active Direct Review Claims": {
      main: [[connection("Mark Active Direct Review Claims")]]
    },
    "Mark Active Direct Review Claims": {
      main: [[connection("Aggregate Active Direct Review Claim Marks")]]
    },
    "Aggregate Active Direct Review Claim Marks": {
      main: [[connection("Get Active After Direct Review Claims")]]
    },
    "Get Active After Direct Review Claims": {
      main: [[connection("Aggregate Active After Direct Review Claims")]]
    },
    "Aggregate Active After Direct Review Claims": {
      main: [[connection("Prepare Claimed Active Direct Review Updates")]]
    },
    "Prepare Claimed Active Direct Review Updates": {
      main: [[connection("Update Active Direct Review Actions")]]
    },
    "Update Active Direct Review Actions": {
      main: [[connection("Aggregate Active Direct Review Updates")]]
    },
    "Aggregate Active Direct Review Updates": {
      main: [[connection("Has Archive Review Updates")]]
    },
    "Has Archive Review Updates": {
      main: [
        [connection("Prepare Archive Review Claims")],
        [connection("Has Archive Direct Review Updates")]
      ]
    },
    "Prepare Archive Review Claims": {
      main: [[connection("Mark Archive Review Claims")]]
    },
    "Mark Archive Review Claims": {
      main: [[connection("Aggregate Archive Review Claim Marks")]]
    },
    "Aggregate Archive Review Claim Marks": {
      main: [[connection("Get Archive After Applied Jobs Claims")]]
    },
    "Get Archive After Applied Jobs Claims": {
      main: [[connection("Aggregate Archive After Applied Jobs Claims")]]
    },
    "Aggregate Archive After Applied Jobs Claims": {
      main: [[connection("Prepare Claimed Archive Review Updates")]]
    },
    "Prepare Claimed Archive Review Updates": {
      main: [[connection("Update Archive Review Actions")]]
    },
    "Update Archive Review Actions": {
      main: [[connection("Aggregate Archive Review Updates")]]
    },
    "Aggregate Archive Review Updates": {
      main: [[connection("Has Archive Direct Review Updates")]]
    },
    "Has Archive Direct Review Updates": {
      main: [
        [connection("Prepare Archive Direct Review Claims")],
        [connection("Get Active After Review")]
      ]
    },
    "Prepare Archive Direct Review Claims": {
      main: [[connection("Mark Archive Direct Review Claims")]]
    },
    "Mark Archive Direct Review Claims": {
      main: [[connection("Aggregate Archive Direct Review Claim Marks")]]
    },
    "Aggregate Archive Direct Review Claim Marks": {
      main: [[connection("Get Archive After Direct Review Claims")]]
    },
    "Get Archive After Direct Review Claims": {
      main: [[connection("Aggregate Archive After Direct Review Claims")]]
    },
    "Aggregate Archive After Direct Review Claims": {
      main: [[connection("Prepare Claimed Archive Direct Review Updates")]]
    },
    "Prepare Claimed Archive Direct Review Updates": {
      main: [[connection("Update Archive Direct Review Actions")]]
    },
    "Update Archive Direct Review Actions": {
      main: [[connection("Aggregate Archive Direct Review Updates")]]
    },
    "Aggregate Archive Direct Review Updates": {
      main: [[connection("Get Active After Review")]]
    },
    "Prepare Funnel Summary": { main: [[connection("Has Dashboard Changes")]] },
    "Has Dashboard Changes": {
      main: [[connection("Update Dashboard Summary")], []]
    },
    "Get Active After Review": {
      main: [[connection("Aggregate Active After Review")]]
    },
    "Aggregate Active After Review": {
      main: [[connection("Get Archive After Review")]]
    },
    "Get Archive After Review": {
      main: [[connection("Aggregate Archive After Review")]]
    },
    "Aggregate Archive After Review": {
      main: [[
        connection("Get Review Queue After Review"),
        connection("Prepare Funnel Summary")
      ]]
    },
    "Get Review Queue After Review": {
      main: [[connection("Aggregate Current Review Queue")]]
    },
    "Aggregate Current Review Queue": {
      main: [[connection("Get Applied Jobs After Review")]]
    },
    "Get Applied Jobs After Review": {
      main: [[connection("Aggregate Current Applied Jobs")]]
    },
    "Aggregate Current Applied Jobs": {
      main: [[connection("Prepare Review Queue Reconciliation")]]
    },
    "Prepare Review Queue Reconciliation": {
      main: [[
        connection("Has Review Queue Deletions"),
        connection("Prepare Applied Jobs Projection Claim")
      ]]
    },
    "Prepare Applied Jobs Projection Claim": {
      main: [[connection("Append Applied Jobs Projection Claim")]]
    },
    "Append Applied Jobs Projection Claim": {
      main: [[connection("Get Applied Jobs Projection Claims")]]
    },
    "Get Applied Jobs Projection Claims": {
      main: [[connection("Keep Winning Applied Jobs Projection Claim")]]
    },
    "Keep Winning Applied Jobs Projection Claim": {
      main: [[
        connection("Get Applied Jobs Before Cleanup"),
        connection("Plan Processing Claims Cleanup")
      ]]
    },
    "Plan Processing Claims Cleanup": {
      main: [[connection("Get Processing Claims Sheet Metadata")]]
    },
    "Get Processing Claims Sheet Metadata": {
      main: [[connection("Prepare Processing Claims Batch Cleanup")]]
    },
    "Prepare Processing Claims Batch Cleanup": {
      main: [[connection("Delete Expired Processing Claims")]]
    },
    "Delete Expired Processing Claims": {
      main: [[connection("Log Processing Claims Cleanup")]]
    },
    "Get Applied Jobs Before Cleanup": {
      main: [[connection("Aggregate Applied Jobs Before Cleanup")]]
    },
    "Aggregate Applied Jobs Before Cleanup": {
      main: [[connection("Finalize Applied Jobs Cleanup")]]
    },
    "Finalize Applied Jobs Cleanup": {
      main: [[connection("Has Applied Jobs Rebases")]]
    },
    "Has Applied Jobs Rebases": {
      main: [
        [connection("Prepare Applied Jobs Rebases")],
        [connection("Has Applied Jobs Clears")]
      ]
    },
    "Prepare Applied Jobs Rebases": {
      main: [[connection("Refresh Protected Applied Jobs Rows")]]
    },
    "Refresh Protected Applied Jobs Rows": {
      main: [[connection("Aggregate Applied Jobs Rebases")]]
    },
    "Aggregate Applied Jobs Rebases": {
      main: [[connection("Has Applied Jobs Clears")]]
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
    },
    "Has Applied Jobs Clears": {
      main: [
        [connection("Prepare Applied Jobs Clears")],
        [connection("Has Applied Jobs Upserts")]
      ]
    },
    "Prepare Applied Jobs Clears": {
      main: [[connection("Clear Stale Applied Jobs Rows")]]
    },
    "Clear Stale Applied Jobs Rows": {
      main: [[connection("Aggregate Applied Jobs Clears")]]
    },
    "Aggregate Applied Jobs Clears": {
      main: [[connection("Has Applied Jobs Upserts")]]
    },
    "Has Applied Jobs Upserts": {
      main: [
        [connection("Prepare Applied Jobs Upserts")],
        [connection("Get Applied Jobs After Maintenance")]
      ]
    },
    "Prepare Applied Jobs Upserts": {
      main: [[connection("Upsert Applied Jobs Rows")]]
    },
    "Upsert Applied Jobs Rows": {
      main: [[connection("Get Applied Jobs After Maintenance")]]
    },
    "Get Applied Jobs After Maintenance": {
      main: [[connection("Aggregate Applied Jobs After Maintenance")]]
    },
    "Aggregate Applied Jobs After Maintenance": {
      main: [[connection("Get Applied Jobs Sheet Metadata")]]
    },
    "Get Applied Jobs Sheet Metadata": {
      main: [[connection("Prepare Applied Jobs Atomic Cleanup")]]
    },
    "Prepare Applied Jobs Atomic Cleanup": {
      main: [[connection("Sort and Retire Applied Jobs Rows")]]
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
        binaryMode: "separate",
        executionTimeout: reviewConfig.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      versionId: "88af9ce3-b45f-4aa8-a980-000000000012",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        reviewViewVersion: reviewConfig.view_version,
        reviewQueueVersion: reviewConfig.review_queue.version,
        appliedJobsVersion: reviewConfig.applied_jobs.version,
        scheduleMinutes: reviewConfig.schedule_minutes,
        scheduleOffsetMinutes:
          reviewConfig.schedule_offset_minutes,
        executionTimeoutSeconds: reviewConfig.execution_timeout_seconds,
        claimRetentionPolicyVersion: claimRetentionPolicy.policy_version
      },
      tags: []
    }
  };
}

async function buildAlerter() {
  const path = "workflows/alerter.json";
  const template = await readJson("workflows/generator.json");
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
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
  const activeAfterAlertMark = structuredClone(activeRead);
  activeAfterAlertMark.id = "a11e7e00-0000-4000-8000-000000000015";
  activeAfterAlertMark.name = "Get Active After Alert Mark";
  activeAfterAlertMark.position = [340, 180];
  activeAfterAlertMark.alwaysOutputData = true;
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

  const confirmAttemptCode = `${alertCore}

const planned = $('Keep Winning Alert Claims').all()
  .map((item) => item.json);
const freshRows = $input.all()
  .map((item) => item.json)
  .filter((row) => row && Object.keys(row).length > 0);
const confirmed = confirmAlertAttemptMarkers(planned, freshRows);
console.log(JSON.stringify({
  event: 'alert_attempt_markers',
  proposed: planned.length,
  confirmed: confirmed.length,
  rejected: planned.length - confirmed.length
}));
return confirmed.map((record) => ({ json: record }));`;

  const prepareDeliveryCode = `${alertCore}

const POLICY = ${JSON.stringify(policy)};
const MESSAGE_SAFETY = {
  profile: ${JSON.stringify(profile)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
};
const record = $json;
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
  error: payload.error,
  body: typeof payload.body === 'string'
    ? payload.body
    : typeof payload.data === 'string'
      ? payload.data
      : '',
  message: alertProviderErrorMessage(payload),
  at: now
};
const finalized = applyAlertProviderResult(record, providerResult, POLICY);
console.log(JSON.stringify({
  event: 'alert_delivery',
  timestamp: finalized.alert_last_attempt_at || finalized.updated_at || now,
  state_commit_pending: true,
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
        interval: minuteIntervalScheduleRules(
          policy,
          "alert schedule"
        )
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.3,
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
    position: [1000, 180],
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
        batching: {
          batch: {
            batchSize: 1,
            batchInterval: policy.provider_request_interval_ms
          }
        },
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
    position: [1220, 80],
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
    aggregateNode({
      id: "a11e7e00-0000-4000-8000-000000000017",
      name: "Aggregate Alert Attempt Marks",
      position: [340, 320],
      destinationFieldName: "marks_written"
    }),
    activeAfterAlertMark,
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000016",
      name: "Confirm Alert Attempt Markers",
      position: [560, 180],
      jsCode: confirmAttemptCode
    }),
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000009",
      name: "Prepare Alert Delivery",
      position: [780, 180],
      mode: "runOnceForEachItem",
      jsCode: prepareDeliveryCode
    }),
    shouldSend,
    sendSlack,
    codeNode({
      id: "a11e7e00-0000-4000-8000-000000000012",
      name: "Finalize Alert Delivery",
      position: [1440, 80],
      mode: "runOnceForEachItem",
      jsCode: finalizeCode
    }),
    updateSheetByFieldNode({
      base: activeUpdateBase,
      id: "a11e7e00-0000-4000-8000-000000000013",
      name: "Commit Alert Result",
      position: [1680, 180],
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
    "Mark Alert Attempts": {
      main: [[connection("Aggregate Alert Attempt Marks")]]
    },
    "Aggregate Alert Attempt Marks": {
      main: [[connection("Get Active After Alert Mark")]]
    },
    "Get Active After Alert Mark": {
      main: [[connection("Confirm Alert Attempt Markers")]]
    },
    "Confirm Alert Attempt Markers": {
      main: [[connection("Prepare Alert Delivery")]]
    },
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
        executionOrder: "v1",
        executionTimeout: policy.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      versionId: "a11e7e00-0000-4000-8000-000000000014",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        alertPolicyVersion: policy.policy_version,
        alertChannel: policy.channel,
        alertPerRunCap: policy.per_run_cap,
        alertProviderRequestIntervalMs:
          policy.provider_request_interval_ms,
        scheduleMinutes: policy.schedule_minutes,
        scheduleOffsetMinutes: policy.schedule_offset_minutes,
        executionTimeoutSeconds: policy.execution_timeout_seconds
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
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
  const policy = await readJson("config/analytics-policy.json");
  const reviewConfig = await readJson("config/review-sheet.json");
  const reportRetention = await readJson("config/report-retention.json");
  const claimRetention = await readJson("config/claim-retention.json");
  const reportRetentionErrors =
    validateReportRetentionPolicy(reportRetention);
  if (reportRetentionErrors.length > 0) {
    throw new Error(
      `Invalid report retention policy:\n- ${reportRetentionErrors.join("\n- ")}`
    );
  }
  if (
    reportRetention.analytics.claim_lease_ms <=
    policy.execution_timeout_seconds * 1000
  ) {
    throw new Error(
      "Analytics report-store claim lease must exceed its execution timeout"
    );
  }
  if (
    !claimRetention.allowed_processing_stages.includes(
      reportRetention.analytics.claim_stage
    )
  ) {
    throw new Error(
      "Analytics report-store claim stage must be covered by claim retention"
    );
  }
  const analyticsCore = await bundledCore(
    "src/contracts.mjs",
    "src/schedules.mjs",
    "src/analytics.mjs",
    "src/report-retention.mjs"
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

  const reportsRead = structuredClone(activeRead);
  reportsRead.id = "a13a17c5-0000-4000-8000-000000000012";
  reportsRead.name = "Get Analytics Reports";
  reportsRead.position = [-1420, 240];
  reportsRead.parameters.operation = "read";
  reportsRead.parameters.sheetName = {
    __rl: true,
    value: policy.reports_sheet,
    mode: "name",
    cachedResultName: policy.reports_sheet
  };
  reportsRead.alwaysOutputData = true;
  reportsRead.onError = "continueRegularOutput";

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

  const claimFields = [
    "canonical_job_id",
    "processing_stage",
    "processing_token",
    "created_at",
    "expires_at"
  ];
  const claimsBase = structuredClone(activeRead);
  claimsBase.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.claims_sheet,
    mode: "name",
    cachedResultName: reviewConfig.claims_sheet
  };
  const prepareStoreClaimCode = `${analyticsCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const STORE = RETENTION.analytics;
const now = new Date().toISOString();
const proposed = {
  canonical_job_id: STORE.claim_identity,
  work_stage: STORE.claim_stage
};
const claim = createProcessingClaim(
  proposed,
  String($execution.id),
  now,
  STORE.claim_lease_ms
);
return [{ json: {
  ...proposed,
  ...claim
} }];`;
  const appendStoreClaim = appendSheetNode({
    base: claimsBase,
    id: "a13a17c5-0000-4000-8000-000000000015",
    name: "Append Analytics Store Claim",
    position: [-2060, 240],
    fields: claimFields
  });
  const claimsRead = structuredClone(claimsBase);
  claimsRead.id = "a13a17c5-0000-4000-8000-000000000017";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [-1640, 240];
  claimsRead.parameters.operation = "read";
  claimsRead.alwaysOutputData = true;
  const keepStoreWinnerCode = `${analyticsCore}

const proposed = $('Prepare Analytics Store Claim').all()
  .map((item) => item.json);
const claims = $input.all()
  .map((item) => item.json)
  .filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(
  proposed,
  claims,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'analytics_store_claim',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const retentionCandidateCode = `${analyticsCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const reportRows =
  $('Aggregate Analytics Reports').first().json.analytics_report_rows || [];
const status = reportRetentionCandidateStatus(
  reportRows,
  RETENTION,
  'analytics',
  {
    reportIdField: 'report_id',
    now: new Date().toISOString()
  }
);
console.log(JSON.stringify({
  event: 'analytics_report_retention_candidate',
  ...status
}));
return status.cleanup_required ? [{ json: status }] : [];`;
  const reportsRetentionRead = structuredClone(reportsRead);
  reportsRetentionRead.id = "a13a17c5-0000-4000-8000-000000000022";
  reportsRetentionRead.name = "Get Analytics Reports for Retention";
  reportsRetentionRead.position = [1580, 500];
  delete reportsRetentionRead.onError;
  reportsRetentionRead.parameters.options = {
    ...reportsRetentionRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  const detailsRetentionRead = structuredClone(analyticsWriteBase);
  detailsRetentionRead.id = "a13a17c5-0000-4000-8000-000000000024";
  detailsRetentionRead.name = "Get Analytics Detail for Retention";
  detailsRetentionRead.position = [2000, 500];
  detailsRetentionRead.parameters.operation = "read";
  detailsRetentionRead.alwaysOutputData = true;
  detailsRetentionRead.parameters.options = {
    ...detailsRetentionRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  const retentionPlanCode = `${analyticsCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const reportRows =
  $('Aggregate Analytics Reports for Retention').first().json.analytics_report_rows || [];
const detailRows =
  $('Aggregate Analytics Detail for Retention').first().json.analytics_detail_rows || [];
const plan = planReportRetention(
  reportRows,
  detailRows,
  RETENTION,
  'analytics',
  {
    reportIdField: 'report_id',
    detailReportIdField: 'report_id',
    detailIdField: 'analytics_row_id',
    now: new Date().toISOString()
  }
);
console.log(JSON.stringify({
  event: 'analytics_report_retention_plan',
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  ...plan.counts,
  report_delete_ranges: plan.report_delete_ranges.length,
  detail_delete_ranges: plan.detail_delete_ranges.length
}));
return plan.selected_report_ids.length > 0 ? [{ json: plan }] : [];`;
  const spreadsheetId = activeRead.parameters.documentId.value;
  const spreadsheetMetadataUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    "?fields=sheets.properties";
  const spreadsheetBatchUpdateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    ":batchUpdate";
  const retentionBatchCode = `
const DETAIL_SHEET = ${JSON.stringify(policy.detail_sheet)};
const REPORTS_SHEET = ${JSON.stringify(policy.reports_sheet)};
const plan = $('Plan Analytics Report Retention').first().json;
const metadata = $input.first().json;
const sheetId = (title) => {
  const sheet = (metadata.sheets || []).find(
    (entry) => entry?.properties?.title === title
  );
  const value = Number(sheet?.properties?.sheetId);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Report-retention sheet metadata is missing: ' + title);
  }
  return value;
};
const deleteRequests = (ranges, targetSheetId) =>
  ranges.map((range) => ({
    deleteDimension: {
      range: {
        sheetId: targetSheetId,
        dimension: 'ROWS',
        startIndex: range.start_index,
        endIndex: range.end_index
      }
    }
  }));
const requests = [
  ...deleteRequests(plan.detail_delete_ranges, sheetId(DETAIL_SHEET)),
  ...deleteRequests(plan.report_delete_ranges, sheetId(REPORTS_SHEET))
];
if (requests.length === 0) return [];
return [{ json: {
  batch_update: { requests },
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  reports_deleted: plan.counts.selected,
  detail_rows_deleted: plan.detail_delete_ranges.reduce(
    (total, range) => total + range.end_index - range.start_index,
    0
  ),
  delete_ranges: requests.length
} }];`;
  const googleSheetsCredentials = structuredClone(activeRead.credentials);
  const retentionMetadata = {
    id: "a13a17c5-0000-4000-8000-000000000027",
    name: "Get Analytics Retention Sheet Metadata",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [2630, 500],
    parameters: {
      url: spreadsheetMetadataUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      options: {}
    },
    credentials: googleSheetsCredentials
  };
  const retentionBatchUpdate = {
    id: "a13a17c5-0000-4000-8000-000000000029",
    name: "Delete Expired Analytics Reports",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [3050, 500],
    parameters: {
      method: "POST",
      url: spreadsheetBatchUpdateUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify($json.batch_update) }}",
      options: {}
    },
    retryOnFail: false,
    credentials: googleSheetsCredentials
  };
  const retentionLogCode = `
const cleanup = $('Prepare Analytics Retention Batch').first().json;
console.log(JSON.stringify({
  event: 'analytics_report_retention_committed',
  policy_version: cleanup.policy_version,
  retention_cutoff_at: cleanup.retention_cutoff_at,
  reports_deleted: cleanup.reports_deleted,
  detail_rows_deleted: cleanup.detail_rows_deleted,
  delete_ranges: cleanup.delete_ranges
}));
return [{ json: {
  event: 'analytics_report_retention_committed',
  policy_version: cleanup.policy_version,
  reports_deleted: cleanup.reports_deleted,
  detail_rows_deleted: cleanup.detail_rows_deleted
} }];`;

  const buildCode = `${analyticsCore}

const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(policy)};
const reportRows = ($('Aggregate Analytics Reports').first().json.analytics_report_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
if (reportRows.some(
  (row) => row.error || row.errorMessage || row.error_description
)) {
  throw new Error('analytics report store could not be read');
}
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
const reusable = reusableAnalyticsReport(reportRows, report.completion);
const publishRequired = !reusable;
console.log(JSON.stringify({
  event: 'analytics_report_built',
  report_id: report.completion.report_id,
  action: publishRequired ? 'publish' : 'unchanged',
  records: report.completion.record_count,
  applications: report.completion.application_count,
  detail_rows: report.completion.detail_row_count,
  warnings: report.completion.warning_summary
}));
return [{
  json: {
    analytics_rows: report.rows,
    completion: report.completion,
    publish_required: publishRequired
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
            ...analyticsScheduleRule(policy)
          }
        ]
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [-1640, 240],
    id: "a13a17c5-0000-4000-8000-000000000001",
    name: "Schedule Trigger"
  };

  const nodes = [
    schedule,
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000014",
      name: "Prepare Analytics Store Claim",
      position: [-2270, 240],
      jsCode: prepareStoreClaimCode
    }),
    appendStoreClaim,
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000016",
      name: "Aggregate Analytics Store Claim",
      position: [-1850, 240],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000018",
      name: "Keep Winning Analytics Store Claim",
      position: [-1430, 240],
      jsCode: keepStoreWinnerCode
    }),
    reportsRead,
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000013",
      name: "Aggregate Analytics Reports",
      position: [-1200, 240],
      destinationFieldName: "analytics_report_rows"
    }),
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
    booleanIfNode({
      id: "a13a17c5-0000-4000-8000-000000000019",
      name: "Should Publish Analytics Report",
      position: [-100, 240],
      leftValue: "={{ $json.publish_required }}"
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000006",
      name: "Prepare Analytics Rows",
      position: [140, 240],
      jsCode: prepareRowsCode
    }),
    upsertSheetNode({
      base: analyticsWriteBase,
      id: "a13a17c5-0000-4000-8000-000000000007",
      name: "Upsert Analytics Rows",
      position: [380, 240],
      fields: policy.detail_fields,
      matchingField: "analytics_row_id"
    }),
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000008",
      name: "Aggregate Analytics Row Writes",
      position: [620, 240],
      destinationFieldName: "analytics_rows_written"
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000009",
      name: "Prepare Analytics Completion",
      position: [860, 240],
      jsCode: prepareCompletionCode
    }),
    upsertSheetNode({
      base: reportsWriteBase,
      id: "a13a17c5-0000-4000-8000-000000000010",
      name: "Publish Complete Analytics Report",
      position: [1100, 240],
      fields: policy.report_fields,
      matchingField: "report_id"
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000020",
      name: "Plan Analytics Retention Candidates",
      position: [1370, 500],
      jsCode: retentionCandidateCode
    }),
    reportsRetentionRead,
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000023",
      name: "Aggregate Analytics Reports for Retention",
      position: [1790, 500],
      destinationFieldName: "analytics_report_rows"
    }),
    detailsRetentionRead,
    aggregateNode({
      id: "a13a17c5-0000-4000-8000-000000000025",
      name: "Aggregate Analytics Detail for Retention",
      position: [2210, 500],
      destinationFieldName: "analytics_detail_rows"
    }),
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000026",
      name: "Plan Analytics Report Retention",
      position: [2420, 500],
      jsCode: retentionPlanCode
    }),
    retentionMetadata,
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000028",
      name: "Prepare Analytics Retention Batch",
      position: [2840, 500],
      jsCode: retentionBatchCode
    }),
    retentionBatchUpdate,
    codeNode({
      id: "a13a17c5-0000-4000-8000-000000000030",
      name: "Log Analytics Retention",
      position: [3260, 500],
      jsCode: retentionLogCode
    })
  ];

  const connections = {
    "Schedule Trigger": {
      main: [[connection("Prepare Analytics Store Claim")]]
    },
    "Prepare Analytics Store Claim": {
      main: [[connection("Append Analytics Store Claim")]]
    },
    "Append Analytics Store Claim": {
      main: [[connection("Aggregate Analytics Store Claim")]]
    },
    "Aggregate Analytics Store Claim": {
      main: [[connection("Get Processing Claims")]]
    },
    "Get Processing Claims": {
      main: [[connection("Keep Winning Analytics Store Claim")]]
    },
    "Keep Winning Analytics Store Claim": {
      main: [[connection("Get Analytics Reports")]]
    },
    "Get Analytics Reports": {
      main: [[connection("Aggregate Analytics Reports")]]
    },
    "Aggregate Analytics Reports": {
      main: [[connection("Get Active Rows")]]
    },
    "Get Active Rows": { main: [[connection("Aggregate Active Rows")]] },
    "Aggregate Active Rows": { main: [[connection("Get Archive Rows")]] },
    "Get Archive Rows": { main: [[connection("Build Analytics Report")]] },
    "Build Analytics Report": {
      main: [[connection("Should Publish Analytics Report")]]
    },
    "Should Publish Analytics Report": {
      main: [
        [connection("Prepare Analytics Rows")],
        [connection("Plan Analytics Retention Candidates")]
      ]
    },
    "Prepare Analytics Rows": { main: [[connection("Upsert Analytics Rows")]] },
    "Upsert Analytics Rows": {
      main: [[connection("Aggregate Analytics Row Writes")]]
    },
    "Aggregate Analytics Row Writes": {
      main: [[connection("Prepare Analytics Completion")]]
    },
    "Prepare Analytics Completion": {
      main: [[connection("Publish Complete Analytics Report")]]
    },
    "Publish Complete Analytics Report": {
      main: [[connection("Plan Analytics Retention Candidates")]]
    },
    "Plan Analytics Retention Candidates": {
      main: [[connection("Get Analytics Reports for Retention")]]
    },
    "Get Analytics Reports for Retention": {
      main: [[connection("Aggregate Analytics Reports for Retention")]]
    },
    "Aggregate Analytics Reports for Retention": {
      main: [[connection("Get Analytics Detail for Retention")]]
    },
    "Get Analytics Detail for Retention": {
      main: [[connection("Aggregate Analytics Detail for Retention")]]
    },
    "Aggregate Analytics Detail for Retention": {
      main: [[connection("Plan Analytics Report Retention")]]
    },
    "Plan Analytics Report Retention": {
      main: [[connection("Get Analytics Retention Sheet Metadata")]]
    },
    "Get Analytics Retention Sheet Metadata": {
      main: [[connection("Prepare Analytics Retention Batch")]]
    },
    "Prepare Analytics Retention Batch": {
      main: [[connection("Delete Expired Analytics Reports")]]
    },
    "Delete Expired Analytics Reports": {
      main: [[connection("Log Analytics Retention")]]
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
        executionOrder: "v1",
        executionTimeout: policy.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      versionId: "a13a17c5-0000-4000-8000-000000000011",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        metricDefinitionVersion: policy.metric_definition_version,
        analyticsBandVersion: policy.band_version,
        analyticsScheduleHours: policy.schedule_hours,
        reportRetentionPolicyVersion: reportRetention.policy_version,
        reportRetentionDays: reportRetention.analytics.retention_days,
        reportStoreClaimLeaseMs:
          reportRetention.analytics.claim_lease_ms,
        executionTimeoutSeconds: policy.execution_timeout_seconds
      },
      tags: []
    }
  };
}

async function buildRecommender() {
  const path = "workflows/recommender.json";
  const analyticsWorkflow = await readJson("workflows/analytics.json");
  const schema = await readJson("config/pipeline-schema.json");
  const runtime = await readJson("config/runtime.json");
  assertValidRuntime(runtime);
  const policy = await readJson("config/recommendation-policy.json");
  const analyticsPolicy = await readJson("config/analytics-policy.json");
  const reviewConfig = await readJson("config/review-sheet.json");
  const reportRetention = await readJson("config/report-retention.json");
  const claimRetention = await readJson("config/claim-retention.json");
  const reportRetentionErrors =
    validateReportRetentionPolicy(reportRetention);
  if (reportRetentionErrors.length > 0) {
    throw new Error(
      `Invalid report retention policy:\n- ${reportRetentionErrors.join("\n- ")}`
    );
  }
  if (
    reportRetention.recommendations.claim_lease_ms <=
    policy.execution_timeout_seconds * 1000
  ) {
    throw new Error(
      "Recommendation report-store claim lease must exceed its execution timeout"
    );
  }
  if (
    !claimRetention.allowed_processing_stages.includes(
      reportRetention.recommendations.claim_stage
    )
  ) {
    throw new Error(
      "Recommendation report-store claim stage must be covered by claim retention"
    );
  }
  const profile = await readJson("config/candidate-profile.json");
  const recommendationCore = await bundledCore(
    "src/contracts.mjs",
    "src/schedules.mjs",
    "src/analytics.mjs",
    "src/recommendations.mjs",
    "src/report-retention.mjs"
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
  const scheduleErrors = validateLearningSchedulePair(
    analyticsPolicy,
    policy
  );
  if (scheduleErrors.length > 0) {
    throw new Error(
      `Invalid learning schedule:\n- ${scheduleErrors.join("\n- ")}`
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

  const recommendationReportsRead = structuredClone(reportsRead);
  recommendationReportsRead.id =
    "b14b18d6-0000-4000-8000-000000000013";
  recommendationReportsRead.name = "Get Recommendation Reports";
  recommendationReportsRead.position = [-1420, 240];
  recommendationReportsRead.parameters.sheetName = {
    __rl: true,
    value: policy.reports_sheet,
    mode: "name",
    cachedResultName: policy.reports_sheet
  };

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

  const claimFields = [
    "canonical_job_id",
    "processing_stage",
    "processing_token",
    "created_at",
    "expires_at"
  ];
  const claimsBase = structuredClone(reportsRead);
  delete claimsBase.onError;
  claimsBase.parameters.sheetName = {
    __rl: true,
    value: reviewConfig.claims_sheet,
    mode: "name",
    cachedResultName: reviewConfig.claims_sheet
  };
  const prepareStoreClaimCode = `${recommendationCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const STORE = RETENTION.recommendations;
const now = new Date().toISOString();
const proposed = {
  canonical_job_id: STORE.claim_identity,
  work_stage: STORE.claim_stage
};
const claim = createProcessingClaim(
  proposed,
  String($execution.id),
  now,
  STORE.claim_lease_ms
);
return [{ json: {
  ...proposed,
  ...claim
} }];`;
  const appendStoreClaim = appendSheetNode({
    base: claimsBase,
    id: "b14b18d6-0000-4000-8000-000000000017",
    name: "Append Recommendation Store Claim",
    position: [-2060, 240],
    fields: claimFields
  });
  const claimsRead = structuredClone(claimsBase);
  claimsRead.id = "b14b18d6-0000-4000-8000-000000000019";
  claimsRead.name = "Get Processing Claims";
  claimsRead.position = [-1640, 240];
  claimsRead.parameters.operation = "read";
  claimsRead.alwaysOutputData = true;
  const keepStoreWinnerCode = `${recommendationCore}

const proposed = $('Prepare Recommendation Store Claim').all()
  .map((item) => item.json);
const claims = $input.all()
  .map((item) => item.json)
  .filter((claim) => claim && claim.canonical_job_id);
const winners = chooseWinningClaims(
  proposed,
  claims,
  new Date().toISOString()
);
console.log(JSON.stringify({
  event: 'recommendation_store_claim',
  proposed: proposed.length,
  won: winners.length,
  lost: proposed.length - winners.length
}));
return winners.map((record) => ({ json: record }));`;

  const retentionCandidateCode = `${recommendationCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const reportRows =
  $('Aggregate Recommendation Reports').first().json.recommendation_report_rows || [];
const status = reportRetentionCandidateStatus(
  reportRows,
  RETENTION,
  'recommendations',
  {
    reportIdField: 'run_id',
    now: new Date().toISOString()
  }
);
console.log(JSON.stringify({
  event: 'recommendation_report_retention_candidate',
  ...status
}));
return status.cleanup_required ? [{ json: status }] : [];`;
  const reportsRetentionRead = structuredClone(recommendationReportsRead);
  reportsRetentionRead.id = "b14b18d6-0000-4000-8000-000000000023";
  reportsRetentionRead.name = "Get Recommendation Reports for Retention";
  reportsRetentionRead.position = [1820, 500];
  delete reportsRetentionRead.onError;
  reportsRetentionRead.parameters.options = {
    ...reportsRetentionRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  const detailsRetentionRead = structuredClone(recommendationWriteBase);
  detailsRetentionRead.id = "b14b18d6-0000-4000-8000-000000000025";
  detailsRetentionRead.name = "Get Recommendation Detail for Retention";
  detailsRetentionRead.position = [2240, 500];
  detailsRetentionRead.parameters.operation = "read";
  detailsRetentionRead.alwaysOutputData = true;
  delete detailsRetentionRead.onError;
  detailsRetentionRead.parameters.options = {
    ...detailsRetentionRead.parameters.options,
    outputFormatting: {
      values: {
        general: "FORMULA",
        date: "FORMATTED_STRING"
      }
    }
  };
  const retentionPlanCode = `${recommendationCore}

const RETENTION = ${JSON.stringify(reportRetention)};
const reportRows =
  $('Aggregate Recommendation Reports for Retention').first().json.recommendation_report_rows || [];
const detailRows =
  $('Aggregate Recommendation Detail for Retention').first().json.recommendation_rows || [];
const plan = planReportRetention(
  reportRows,
  detailRows,
  RETENTION,
  'recommendations',
  {
    reportIdField: 'run_id',
    detailReportIdField: 'run_id',
    detailIdField: 'recommendation_id',
    now: new Date().toISOString()
  }
);
console.log(JSON.stringify({
  event: 'recommendation_report_retention_plan',
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  ...plan.counts,
  report_delete_ranges: plan.report_delete_ranges.length,
  detail_delete_ranges: plan.detail_delete_ranges.length
}));
return plan.selected_report_ids.length > 0 ? [{ json: plan }] : [];`;
  const spreadsheetId = reportsRead.parameters.documentId.value;
  const spreadsheetMetadataUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    "?fields=sheets.properties";
  const spreadsheetBatchUpdateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    ":batchUpdate";
  const retentionBatchCode = `
const DETAIL_SHEET = ${JSON.stringify(policy.recommendations_sheet)};
const REPORTS_SHEET = ${JSON.stringify(policy.reports_sheet)};
const plan = $('Plan Recommendation Report Retention').first().json;
const metadata = $input.first().json;
const sheetId = (title) => {
  const sheet = (metadata.sheets || []).find(
    (entry) => entry?.properties?.title === title
  );
  const value = Number(sheet?.properties?.sheetId);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Report-retention sheet metadata is missing: ' + title);
  }
  return value;
};
const deleteRequests = (ranges, targetSheetId) =>
  ranges.map((range) => ({
    deleteDimension: {
      range: {
        sheetId: targetSheetId,
        dimension: 'ROWS',
        startIndex: range.start_index,
        endIndex: range.end_index
      }
    }
  }));
const requests = [
  ...deleteRequests(
    plan.detail_delete_ranges,
    sheetId(DETAIL_SHEET)
  ),
  ...deleteRequests(
    plan.report_delete_ranges,
    sheetId(REPORTS_SHEET)
  )
];
if (requests.length === 0) return [];
return [{ json: {
  batch_update: { requests },
  policy_version: plan.policy_version,
  retention_cutoff_at: plan.retention_cutoff_at,
  reports_deleted: plan.counts.selected,
  detail_rows_deleted: plan.detail_delete_ranges.reduce(
    (total, range) => total + range.end_index - range.start_index,
    0
  ),
  delete_ranges: requests.length
} }];`;
  const googleSheetsCredentials = structuredClone(reportsRead.credentials);
  const retentionMetadata = {
    id: "b14b18d6-0000-4000-8000-000000000028",
    name: "Get Recommendation Retention Sheet Metadata",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [2870, 500],
    parameters: {
      url: spreadsheetMetadataUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      options: {}
    },
    credentials: googleSheetsCredentials
  };
  const retentionBatchUpdate = {
    id: "b14b18d6-0000-4000-8000-000000000030",
    name: "Delete Expired Recommendation Reports",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position: [3290, 500],
    parameters: {
      method: "POST",
      url: spreadsheetBatchUpdateUrl,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleSheetsOAuth2Api",
      sendBody: true,
      contentType: "raw",
      rawContentType: "application/json",
      body: "={{ JSON.stringify($json.batch_update) }}",
      options: {}
    },
    retryOnFail: false,
    credentials: googleSheetsCredentials
  };
  const retentionLogCode = `
const cleanup =
  $('Prepare Recommendation Retention Batch').first().json;
console.log(JSON.stringify({
  event: 'recommendation_report_retention_committed',
  policy_version: cleanup.policy_version,
  retention_cutoff_at: cleanup.retention_cutoff_at,
  reports_deleted: cleanup.reports_deleted,
  detail_rows_deleted: cleanup.detail_rows_deleted,
  delete_ranges: cleanup.delete_ranges
}));
return [{ json: {
  event: 'recommendation_report_retention_committed',
  policy_version: cleanup.policy_version,
  reports_deleted: cleanup.reports_deleted,
  detail_rows_deleted: cleanup.detail_rows_deleted
} }];`;

  const buildCode = `${recommendationCore}

const POLICY = ${JSON.stringify(policy)};
const PROFILE = ${JSON.stringify(profile)};
const recommendationReportRows = ($('Aggregate Recommendation Reports').first().json.recommendation_report_rows || [])
  .filter((row) => row && Object.keys(row).length > 0);
const recommendationReportReadFailed = recommendationReportRows.some(
  (row) => row.error || row.errorMessage || row.error_description
);
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
const reusable = recommendationReportReadFailed
  ? undefined
  : reusableRecommendationReport(recommendationReportRows, result.report);
const publishRequired = !reusable;
console.log(JSON.stringify({
  event: 'weekly_recommendation_report_built',
  run_id: result.report.run_id,
  action: publishRequired ? 'publish' : 'unchanged',
  history_read_failed: recommendationReportReadFailed,
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
    report: result.report,
    publish_required: publishRequired
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
            ...recommendationScheduleRule(analyticsPolicy, policy)
          }
        ]
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [-1640, 240],
    id: "b14b18d6-0000-4000-8000-000000000001",
    name: "Schedule Trigger"
  };

  const upsertRows = upsertSheetNode({
    base: recommendationWriteBase,
    id: "b14b18d6-0000-4000-8000-000000000008",
    name: "Upsert Recommendation Rows",
    position: [620, 240],
    fields: policy.recommendation_fields,
    matchingField: "recommendation_id"
  });
  upsertRows.onError = "continueRegularOutput";

  const nodes = [
    schedule,
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000016",
      name: "Prepare Recommendation Store Claim",
      position: [-2270, 240],
      jsCode: prepareStoreClaimCode
    }),
    appendStoreClaim,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000018",
      name: "Aggregate Recommendation Store Claim",
      position: [-1850, 240],
      destinationFieldName: "claims_written"
    }),
    claimsRead,
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000020",
      name: "Keep Winning Recommendation Store Claim",
      position: [-1430, 240],
      jsCode: keepStoreWinnerCode
    }),
    recommendationReportsRead,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000014",
      name: "Aggregate Recommendation Reports",
      position: [-1200, 240],
      destinationFieldName: "recommendation_report_rows"
    }),
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
    booleanIfNode({
      id: "b14b18d6-0000-4000-8000-000000000015",
      name: "Should Publish Recommendation Report",
      position: [-100, 240],
      leftValue: "={{ $json.publish_required }}"
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000006",
      name: "Prepare Recommendation Rows",
      position: [140, 240],
      jsCode: prepareRowsCode
    }),
    upsertRows,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000009",
      name: "Aggregate Recommendation Row Writes",
      position: [860, 240],
      destinationFieldName: "recommendation_rows_written"
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000010",
      name: "Prepare Recommendation Report",
      position: [1100, 240],
      jsCode: prepareReportCode
    }),
    upsertSheetNode({
      base: reportWriteBase,
      id: "b14b18d6-0000-4000-8000-000000000011",
      name: "Publish Recommendation Report",
      position: [1340, 240],
      fields: policy.report_fields,
      matchingField: "run_id"
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000021",
      name: "Plan Recommendation Retention Candidates",
      position: [1610, 500],
      jsCode: retentionCandidateCode
    }),
    reportsRetentionRead,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000024",
      name: "Aggregate Recommendation Reports for Retention",
      position: [2030, 500],
      destinationFieldName: "recommendation_report_rows"
    }),
    detailsRetentionRead,
    aggregateNode({
      id: "b14b18d6-0000-4000-8000-000000000026",
      name: "Aggregate Recommendation Detail for Retention",
      position: [2450, 500],
      destinationFieldName: "recommendation_rows"
    }),
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000027",
      name: "Plan Recommendation Report Retention",
      position: [2660, 500],
      jsCode: retentionPlanCode
    }),
    retentionMetadata,
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000029",
      name: "Prepare Recommendation Retention Batch",
      position: [3080, 500],
      jsCode: retentionBatchCode
    }),
    retentionBatchUpdate,
    codeNode({
      id: "b14b18d6-0000-4000-8000-000000000031",
      name: "Log Recommendation Retention",
      position: [3500, 500],
      jsCode: retentionLogCode
    })
  ];

  const connections = {
    "Schedule Trigger": {
      main: [[connection("Prepare Recommendation Store Claim")]]
    },
    "Prepare Recommendation Store Claim": {
      main: [[connection("Append Recommendation Store Claim")]]
    },
    "Append Recommendation Store Claim": {
      main: [[connection("Aggregate Recommendation Store Claim")]]
    },
    "Aggregate Recommendation Store Claim": {
      main: [[connection("Get Processing Claims")]]
    },
    "Get Processing Claims": {
      main: [[connection("Keep Winning Recommendation Store Claim")]]
    },
    "Keep Winning Recommendation Store Claim": {
      main: [[connection("Get Recommendation Reports")]]
    },
    "Get Recommendation Reports": {
      main: [[connection("Aggregate Recommendation Reports")]]
    },
    "Aggregate Recommendation Reports": {
      main: [[connection("Get Analytics Reports")]]
    },
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
      main: [[connection("Should Publish Recommendation Report")]]
    },
    "Should Publish Recommendation Report": {
      main: [
        [connection("Prepare Recommendation Rows")],
        [connection("Plan Recommendation Retention Candidates")]
      ]
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
    },
    "Publish Recommendation Report": {
      main: [[connection("Plan Recommendation Retention Candidates")]]
    },
    "Plan Recommendation Retention Candidates": {
      main: [[connection("Get Recommendation Reports for Retention")]]
    },
    "Get Recommendation Reports for Retention": {
      main: [[connection("Aggregate Recommendation Reports for Retention")]]
    },
    "Aggregate Recommendation Reports for Retention": {
      main: [[connection("Get Recommendation Detail for Retention")]]
    },
    "Get Recommendation Detail for Retention": {
      main: [[connection("Aggregate Recommendation Detail for Retention")]]
    },
    "Aggregate Recommendation Detail for Retention": {
      main: [[connection("Plan Recommendation Report Retention")]]
    },
    "Plan Recommendation Report Retention": {
      main: [[connection("Get Recommendation Retention Sheet Metadata")]]
    },
    "Get Recommendation Retention Sheet Metadata": {
      main: [[connection("Prepare Recommendation Retention Batch")]]
    },
    "Prepare Recommendation Retention Batch": {
      main: [[connection("Delete Expired Recommendation Reports")]]
    },
    "Delete Expired Recommendation Reports": {
      main: [[connection("Log Recommendation Retention")]]
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
        executionOrder: "v1",
        executionTimeout: policy.execution_timeout_seconds,
        timezone: runtime.timezone,
        ...workflowExecutionDataSettings(runtime)
      },
      versionId: "b14b18d6-0000-4000-8000-000000000012",
      meta: {
        pipelineSchemaVersion: schema.storage_version,
        recommendationPolicyVersion: policy.policy_version,
        requiredMetricDefinitionVersion:
          policy.required_metric_definition_version,
        requiredAnalyticsBandVersion: policy.required_band_version,
        recommendationScheduleHours: policy.schedule_hours,
        sourceCompletionBufferMinutes:
          policy.source_completion_buffer_minutes,
        reportRetentionPolicyVersion: reportRetention.policy_version,
        reportRetentionDays:
          reportRetention.recommendations.retention_days,
        reportStoreClaimLeaseMs:
          reportRetention.recommendations.claim_lease_ms,
        executionTimeoutSeconds: policy.execution_timeout_seconds,
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
