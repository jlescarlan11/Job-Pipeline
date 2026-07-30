import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  validateAlertPolicy
} from "../src/alerter-mover.mjs";
import {
  validateSearchPlan
} from "../src/discovery.mjs";
import {
  validateGroqProviderPolicy,
  validateGroqRuntimeCapacity
} from "../src/groq-provider.mjs";
import {
  validateWorkflowArtifactManifest,
  validateRuntimeConfig,
  workflowExecutionDataSettings
} from "../src/runtime.mjs";
import { minuteIntervalScheduleRules } from "../src/schedules.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkOnly = process.argv.includes("--check");

const readJson = async (path) =>
  JSON.parse(await readFile(resolve(root, path), "utf8"));
const readText = async (path) => readFile(resolve(root, path), "utf8");

const [
  schema,
  review,
  searchPlan,
  runtime,
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy,
  groqPolicy,
  alertPolicy
] = await Promise.all([
  readJson("config/pipeline-schema.json"),
  readJson("config/review-sheet.json"),
  readJson("config/search-plan.json"),
  readJson("config/runtime.json"),
  readJson("config/candidate-profile.json"),
  readJson("config/ranking-policy.json"),
  readJson("config/application-policy.json"),
  readJson("config/application-pack-policy.json"),
  readJson("config/groq-provider-policy.json"),
  readJson("config/alert-policy.json")
]);

const runtimeErrors = validateRuntimeConfig(runtime);
if (runtimeErrors.length > 0) {
  throw new Error(`Invalid runtime configuration:\n- ${runtimeErrors.join("\n- ")}`);
}
const searchErrors = validateSearchPlan(searchPlan);
if (searchErrors.length > 0) {
  throw new Error(`Invalid search plan:\n- ${searchErrors.join("\n- ")}`);
}
const alertErrors = validateAlertPolicy(alertPolicy);
if (alertErrors.length > 0) {
  throw new Error(`Invalid alert policy:\n- ${alertErrors.join("\n- ")}`);
}
const groqErrors = [
  ...validateGroqProviderPolicy(groqPolicy),
  ...validateGroqRuntimeCapacity(groqPolicy, runtime.generator)
];
if (groqErrors.length > 0) {
  throw new Error(`Invalid Groq provider/runtime configuration:\n- ${groqErrors.join("\n- ")}`);
}
if (review.sheets.review_queue.name !== "Review Queue") {
  throw new Error("Review Queue must be the authoritative active sheet");
}

function stripModuleSyntax(source) {
  return source
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "")
    .replace(/^export\s+/gm, "");
}

async function bundledCore(...paths) {
  const sources = [];
  for (const path of paths) {
    sources.push(stripModuleSyntax(await readText(path)));
  }
  return sources.join("\n\n");
}

const discoveryCore = await bundledCore(
  "src/schedules.mjs",
  "src/contracts.mjs",
  "src/discovery.mjs"
);
const generatorCore = await bundledCore(
  "src/contracts.mjs",
  "src/profile.mjs",
  "src/evaluation.mjs",
  "src/groq-provider.mjs",
  "src/generator.mjs"
);
const groqModel = groqPolicy.models.find(
  (model) => model.id === groqPolicy.selected_model
);
const movementCore = await bundledCore(
  "src/contracts.mjs",
  "src/profile.mjs",
  "src/evaluation.mjs",
  "src/message-safety.mjs",
  "src/system-claims.mjs",
  "src/movement.mjs"
);
const alertCore = await bundledCore(
  "src/contracts.mjs",
  "src/profile.mjs",
  "src/evaluation.mjs",
  "src/message-safety.mjs",
  "src/system-claims.mjs",
  "src/alerter-mover.mjs"
);
// A successful Generator commit must clear the exact Approve action it
// consumed. Notes remain user-owned and are never written by the Generator.
const reviewMachineFields = schema.fields.filter((field) => field !== "notes");
const discoveryUpdateFields = [
  "canonical_job_id",
  "matched_keywords",
  "source_availability",
  "last_seen_at",
  "updated_at"
];
const generatorClaimFields = [
  "canonical_job_id",
  "pipeline_status",
  "record_version",
  "state_guard",
  "processing_stage",
  "processing_token",
  "processing_started_at",
  "review_approved_at",
  "review_approval_note",
  "updated_at"
];
const alertStateFields = [
  "canonical_job_id",
  "record_version",
  "state_guard",
  "alert_status",
  "alert_idempotency_key",
  "alert_claim_token",
  "alert_attempt_count",
  "alert_last_attempt_at",
  "alert_next_retry_at",
  "alert_sent_at",
  "alert_provider_reference",
  "alert_error_category",
  "alert_error_summary",
  "updated_at"
];
const outcomeStateFields = [
  "canonical_job_id",
  "record_version",
  "state_guard",
  "outcome",
  "outcome_recorded_value",
  "outcome_at",
  "updated_at"
];

let nodeCounter = 0;
function id() {
  nodeCounter += 1;
  return `f3a00000-0000-4000-8000-${String(nodeCounter).padStart(12, "0")}`;
}

function scheduleNode(name, position, config) {
  return {
    parameters: {
      rule: {
        interval: minuteIntervalScheduleRules(config, name)
      }
    },
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.3,
    position,
    id: id(),
    name: "Schedule Trigger"
  };
}

function codeNode(name, position, jsCode, mode) {
  return {
    parameters: {
      ...(mode ? { mode } : {}),
      jsCode
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    id: id(),
    name
  };
}

function ifNode(name, position, expression) {
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
            id: `${id()}-condition`,
            leftValue: expression,
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
    id: id(),
    name
  };
}

function waitNode(name, position, milliseconds) {
  return {
    parameters: {
      resume: "timeInterval",
      amount: milliseconds / 1000,
      unit: "seconds"
    },
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position,
    id: id(),
    name
  };
}

function aggregateNode(name, position, destinationFieldName) {
  return {
    parameters: {
      aggregate: "aggregateAllItemData",
      destinationFieldName,
      options: {}
    },
    type: "n8n-nodes-base.aggregate",
    typeVersion: 1,
    position,
    id: id(),
    name
  };
}

function httpNode(
  name,
  position,
  {
    url,
    method = "GET",
    timeout,
    retry,
    headers = [],
    body,
    jsonBody,
    responseFormat = "text",
    fullResponse = false,
    continueOnError = true,
    interval
  }
) {
  return {
    parameters: {
      method,
      url,
      sendHeaders: headers.length > 0,
      ...(headers.length > 0
        ? { headerParameters: { parameters: headers } }
        : {}),
      ...(jsonBody !== undefined
        ? {
            sendBody: true,
            specifyBody: "json",
            jsonBody
          }
        : body !== undefined
        ? {
            sendBody: true,
            contentType: "raw",
            rawContentType: "application/json",
            body
          }
        : {}),
      options: {
        ...(interval
          ? {
              batching: {
                batch: { batchSize: 1, batchInterval: interval }
              }
            }
          : {}),
        response: {
          response: { responseFormat, fullResponse }
        },
        timeout
      }
    },
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.4,
    position,
    id: id(),
    name,
    ...(continueOnError ? { onError: "continueRegularOutput" } : {}),
    ...(retry
      ? {
          retryOnFail: true,
          maxTries: retry.max_attempts,
          waitBetweenTries: retry.backoff_ms
        }
      : {})
  };
}

function documentId() {
  return {
    __rl: true,
    value: "={{ $env.JOB_PIPELINE_SPREADSHEET_ID }}",
    mode: "id"
  };
}

function sheetName(name) {
  return {
    __rl: true,
    value: name,
    mode: "name"
  };
}

function resourceSchema(fields) {
  return [
    ...fields.map((field) => ({
      id: field,
      displayName: field,
      required: false,
      defaultMatch: false,
      display: true,
      type: ["record_version", "attempt_count", "alert_attempt_count"].includes(field)
        ? "number"
        : "string",
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
  return `={{ Array.isArray($json[${JSON.stringify(field)}]) || (typeof $json[${JSON.stringify(field)}] === 'object' && $json[${JSON.stringify(field)}] !== null) ? JSON.stringify($json[${JSON.stringify(field)}]) : ($json[${JSON.stringify(field)}] ?? '') }}`;
}

function readSheet(name, position, sheet) {
  return {
    parameters: {
      documentId: documentId(),
      sheetName: sheetName(sheet),
      options: {}
    },
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.7,
    position,
    id: id(),
    name,
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: runtime.google_sheets.read_retry.max_attempts,
    waitBetweenTries: runtime.google_sheets.read_retry.backoff_ms
  };
}

function writeSheet(
  name,
  position,
  sheet,
  operation,
  fields,
  matchingColumns = [],
  { continueOnError = false } = {}
) {
  const value = Object.fromEntries(
    fields.map((field) => [field, sheetExpression(field)])
  );
  if (operation === "update" && matchingColumns.includes("row_number")) {
    value.row_number = "={{ $json.row_number }}";
  }
  return {
    parameters: {
      operation,
      documentId: documentId(),
      sheetName: sheetName(sheet),
      columns: {
        mappingMode: "defineBelow",
        value,
        matchingColumns,
        schema: resourceSchema(fields),
        attemptToConvertTypes: false,
        convertFieldsToString: false
      },
      options: {}
    },
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.7,
    position,
    id: id(),
    name,
    ...(continueOnError ? { onError: "continueRegularOutput" } : {})
  };
}

function deleteRowsNode(
  name,
  position,
  sheet,
  { continueOnError = false } = {}
) {
  return {
    parameters: {
      operation: "delete",
      documentId: documentId(),
      sheetName: sheetName(sheet),
      startIndex: "={{ $json.row_number }}",
      numberToDelete: 1
    },
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.7,
    position,
    id: id(),
    name,
    ...(continueOnError ? { onError: "continueRegularOutput" } : {})
  };
}

function connection(node, index = 0) {
  return { node, type: "main", index };
}

function workflowSettings(config) {
  return {
    executionOrder: "v1",
    binaryMode: "separate",
    timeSavedMode: "fixed",
    callerPolicy: "workflowsFromSameOwner",
    availableInMCP: false,
    executionTimeout: config.execution_timeout_seconds,
    timezone: runtime.timezone,
    ...workflowExecutionDataSettings(runtime)
  };
}

function buildScraper() {
  const queue = review.sheets.review_queue.name;
  const applied = review.sheets.applied_jobs.name;
  const archive = review.sheets.archive.name;
  const system = review.sheets.system.name;
  const config = runtime.scraper;
  const nodes = [
    scheduleNode("scraper", [-1800, 200], config),
    codeNode(
      "Capture Fixed Window and Keywords",
      [-1600, 200],
      `${discoveryCore}
const SEARCH_PLAN = ${JSON.stringify(searchPlan)};
const errors = validateSearchPlan(SEARCH_PLAN);
if (errors.length) throw new Error('Invalid search plan: ' + errors.join('; '));
const window = createDiscoveryWindow(new Date().toISOString());
return buildSearchRequests(SEARCH_PLAN, window).map((request) => ({ json: request }));`
    ),
    httpNode("Fetch Search Page", [-1400, 200], {
      url: "={{ $json.request_url }}",
      timeout: searchPlan.request_timeout_ms,
      retry: searchPlan.retry,
      interval: searchPlan.request_interval_ms,
      headers: [
        {
          name: "User-Agent",
          value: "Mozilla/5.0 JobPipeline/3.0 read-only"
        }
      ]
    }),
    codeNode(
      "Parse Search Page",
      [-1200, 200],
      `${discoveryCore}
const SEARCH_PLAN = ${JSON.stringify(searchPlan)};
let previous;
try {
  previous = $('Pace Next Page').item.json;
} catch {
  previous = $('Capture Fixed Window and Keywords').item.json;
}
const errorMessage = $json?.error?.message || $json?.message || (typeof $json?.error === 'string' ? $json.error : '');
const page = errorMessage && !$json.data && !$json.body
  ? {
      ...previous,
      ok: false,
      jobs: [],
      excluded: [],
      malformed: [],
      result_card_count: 0,
      has_next: false,
      error_category: /429|rate/i.test(errorMessage) ? 'rate_limit' : /timeout/i.test(errorMessage) ? 'timeout' : 'request_failure',
      error_summary: String(errorMessage).replace(/https?:\\/\\/\\S+/gi, '[url]').slice(0, 200)
    }
  : parseSearchResults(
      typeof $json === 'string' ? $json : ($json.data || $json.body || ''),
      previous
    );
return { json: advanceSearchPagination(previous, page, SEARCH_PLAN) };`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Has Next Source Page",
      [-1000, 200],
      "={{ $json.fetch_next_page === true }}"
    ),
    waitNode(
      "Pace Next Page",
      [-800, 80],
      searchPlan.request_interval_ms
    ),
    aggregateNode("Aggregate Search Pages", [-800, 300], "search_states"),
    readSheet("Get Review Queue", [-600, 300], queue),
    aggregateNode("Aggregate Review Queue", [-400, 300], "review_rows"),
    readSheet("Get Applied Jobs", [-200, 300], applied),
    aggregateNode("Aggregate Applied Jobs", [0, 300], "applied_rows"),
    readSheet("Get Archive", [200, 300], archive),
    aggregateNode("Aggregate Archive", [400, 300], "archive_rows"),
    codeNode(
      "Reconcile Discovery",
      [600, 300],
      `${discoveryCore}
const SCHEMA = ${JSON.stringify(schema)};
const SEARCH_PLAN = ${JSON.stringify(searchPlan)};
const states = $('Aggregate Search Pages').first().json.search_states || [];
const pageResults = states.flatMap((state) => state.page_results || []);
const nonempty = (row) => row && Object.keys(row).length;
const reviewRows = ($('Aggregate Review Queue').first().json.review_rows || []).filter(nonempty);
const appliedRows = ($('Aggregate Applied Jobs').first().json.applied_rows || []).filter(nonempty);
const archiveRows = ($('Aggregate Archive').first().json.archive_rows || []).filter(nonempty);
const now = states[0]?.window_end || new Date().toISOString();
const reconciliation = reconcileDiscovery(pageResults, reviewRows, appliedRows, archiveRows, SCHEMA, now);
const coverage = summarizeCoverage(pageResults, SEARCH_PLAN);
console.log(JSON.stringify({
  event: 'discovery_run',
  window_start: states[0]?.window_start,
  window_end: states[0]?.window_end,
  coverage_status: coverage.status,
  new_jobs: reconciliation.new_jobs.length,
  review_updates: reconciliation.review_updates.length,
  exclusions: reconciliation.exclusion_counts,
  malformed_count: reconciliation.malformed_count
}));
return [{ json: { ...reconciliation, coverage, now } }];`
    ),
    codeNode(
      "Emit Discovery Claims",
      [800, 160],
      `const plan = $('Reconcile Discovery').first().json;
return (plan.new_jobs || []).map((record) => {
  const token = String($execution.id) + ':' + record.canonical_job_id + ':discovery';
  return { json: {
    ...record,
    claim_key: 'discovery:' + record.canonical_job_id.toLowerCase(),
    stage: 'discovery',
    token,
    expires_at: new Date(Date.parse(plan.now) + ${searchPlan.claim_lease_ms}).toISOString()
  } };
});`
    ),
    writeSheet(
      "Append Discovery Claims",
      [1000, 160],
      system,
      "append",
      review.sheets.system.fields
    ),
    aggregateNode("Aggregate Proposed Claims", [1200, 160], "proposed_claims"),
    readSheet("Get Discovery Claims", [1400, 160], system),
    aggregateNode("Aggregate Discovery Claims", [1600, 160], "all_claims"),
    codeNode(
      "Select Expired Discovery Claims",
      [1800, 40],
      `const now = Date.parse($('Reconcile Discovery').first().json.now);
const claims = $('Aggregate Discovery Claims').first().json.all_claims || [];
return claims
  .filter((claim) =>
    Number.isInteger(Number(claim.row_number)) &&
    Number(claim.row_number) >= 2 &&
    Number.isFinite(Date.parse(claim.expires_at || '')) &&
    Date.parse(claim.expires_at) <= now
  )
  .sort((left, right) => Number(right.row_number) - Number(left.row_number))
  .map((claim) => ({ json: { row_number: Number(claim.row_number) } }));`
    ),
    deleteRowsNode(
      "Delete Expired Discovery Claims",
      [2000, 40],
      system
    ),
    codeNode(
      "Keep Winning Discovery Claims",
      [1800, 160],
      `const proposed = $('Emit Discovery Claims').all().map((item) => item.json);
const claims = $('Aggregate Discovery Claims').first().json.all_claims || [];
const winners = new Map();
for (const claim of claims) {
  if (!claim.claim_key || !claim.token || !Number.isInteger(Number(claim.row_number))) continue;
  if (Date.parse(claim.expires_at || '') <= Date.now()) continue;
  const current = winners.get(String(claim.claim_key).toLowerCase());
  if (!current || Number(claim.row_number) < Number(current.row_number)) {
    winners.set(String(claim.claim_key).toLowerCase(), claim);
  }
}
return proposed
  .filter((record) => winners.get(record.claim_key)?.token === record.token)
  .map((record) => {
    const clean = { ...record };
    delete clean.claim_key;
    delete clean.stage;
    delete clean.token;
    delete clean.expires_at;
    return { json: clean };
  });`
    ),
    writeSheet(
      "Append New Review Queue Rows",
      [2000, 160],
      queue,
      "append",
      schema.fields
    ),
    codeNode(
      "Emit Review Queue Seen Updates",
      [800, 440],
      `const updates = $('Reconcile Discovery').first().json.review_updates || [];
return updates.filter((record) => Number.isInteger(Number(record.row_number)))
  .map((record) => ({ json: record }));`
    ),
    writeSheet(
      "Update Review Queue Seen",
      [1000, 440],
      queue,
      "update",
      discoveryUpdateFields,
      ["canonical_job_id"]
    )
  ];
  const connections = {
    "Schedule Trigger": {
      main: [[connection("Capture Fixed Window and Keywords")]]
    },
    "Capture Fixed Window and Keywords": {
      main: [[connection("Fetch Search Page")]]
    },
    "Fetch Search Page": { main: [[connection("Parse Search Page")]] },
    "Parse Search Page": { main: [[connection("Has Next Source Page")]] },
    "Has Next Source Page": {
      main: [
        [connection("Pace Next Page")],
        [connection("Aggregate Search Pages")]
      ]
    },
    "Pace Next Page": { main: [[connection("Fetch Search Page")]] },
    "Aggregate Search Pages": { main: [[connection("Get Review Queue")]] },
    "Get Review Queue": { main: [[connection("Aggregate Review Queue")]] },
    "Aggregate Review Queue": { main: [[connection("Get Applied Jobs")]] },
    "Get Applied Jobs": { main: [[connection("Aggregate Applied Jobs")]] },
    "Aggregate Applied Jobs": { main: [[connection("Get Archive")]] },
    "Get Archive": { main: [[connection("Aggregate Archive")]] },
    "Aggregate Archive": { main: [[connection("Reconcile Discovery")]] },
    "Reconcile Discovery": {
      main: [
        [
          connection("Emit Discovery Claims"),
          connection("Emit Review Queue Seen Updates")
        ]
      ]
    },
    "Emit Discovery Claims": { main: [[connection("Append Discovery Claims")]] },
    "Append Discovery Claims": {
      main: [[connection("Aggregate Proposed Claims")]]
    },
    "Aggregate Proposed Claims": {
      main: [[connection("Get Discovery Claims")]]
    },
    "Get Discovery Claims": {
      main: [[connection("Aggregate Discovery Claims")]]
    },
    "Aggregate Discovery Claims": {
      main: [
        [
          connection("Keep Winning Discovery Claims"),
          connection("Select Expired Discovery Claims")
        ]
      ]
    },
    "Select Expired Discovery Claims": {
      main: [[connection("Delete Expired Discovery Claims")]]
    },
    "Keep Winning Discovery Claims": {
      main: [[connection("Append New Review Queue Rows")]]
    },
    "Emit Review Queue Seen Updates": {
      main: [[connection("Update Review Queue Seen")]]
    }
  };
  return {
    name: "(Scraper) Job Pipeline - Rolling 24-Hour Keywords",
    nodes,
    connections,
    active: false,
    settings: workflowSettings(config),
    versionId: "f3a00000-0000-4000-8000-000000000001",
    meta: {
      templateCredsSetupCompleted: false,
      workflowRole: "scraper",
      workflowContractVersion: "2026-07-31/v2",
      searchPlanVersion: searchPlan.plan_version,
      pipelineSchemaVersion: schema.storage_version,
      windowHours: 24,
      authoritativeActiveSheet: queue,
      executionTimeoutSeconds: config.execution_timeout_seconds,
      scheduleOffsetMinutes: config.schedule_offset_minutes
    },
    pinData: {},
    tags: []
  };
}

function buildGenerator() {
  const queue = review.sheets.review_queue.name;
  const config = runtime.generator;
  const nodes = [
    scheduleNode("generator", [-1600, 200], config),
    readSheet("Get Review Queue", [-1400, 200], queue),
    aggregateNode("Aggregate Review Queue", [-1200, 200], "review_rows"),
    codeNode(
      "Select and Claim Candidate",
      [-1000, 200],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const RUNTIME = ${JSON.stringify(config)};
const now = new Date().toISOString();
const rows = ($input.first().json.review_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA, now));
const selected = selectGeneratorCandidate(rows, SCHEMA, RUNTIME, now);
return selected.map(({ record, stage }) => ({
  json: claimGeneratorRecord(
    record,
    stage,
    String($execution.id),
    now,
    RUNTIME.claim_lease_ms
  ).record
}));`
    ),
    writeSheet(
      "Persist Generator Claim",
      [-800, 200],
      queue,
      "update",
      generatorClaimFields,
      ["canonical_job_id"]
    ),
    aggregateNode("Aggregate Claimed Candidate", [-600, 200], "claimed_rows"),
    ifNode(
      "Needs Fresh Job Detail",
      [-500, 200],
      "={{ $('Select and Claim Candidate').first().json.processing_stage === 'evaluation' }}"
    ),
    httpNode("Fetch Job Detail", [-300, 80], {
      url: "={{ $('Select and Claim Candidate').first().json.canonical_url }}",
      timeout: config.http_timeout_ms,
      retry: {
        max_attempts: config.retry.max_attempts,
        backoff_ms: config.request_retry_backoff_ms
      },
      headers: [
        {
          name: "User-Agent",
          value: "Mozilla/5.0 JobPipeline/3.0 read-only"
        }
      ]
    }),
    codeNode(
      "Use Stored Job Detail",
      [-300, 320],
      "return { json: {} };",
      "runOnceForEachItem"
    ),
    codeNode(
      "Evaluate and Prepare Application",
      [-100, 200],
      `${generatorCore}
const PROFILE = ${JSON.stringify(profile)};
const RANKING_POLICY = ${JSON.stringify(rankingPolicy)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const PROVIDER_POLICY = ${JSON.stringify(groqPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const claimed = $('Select and Claim Candidate').first().json;
const now = new Date().toISOString();
const errorMessage = $json?.error?.message || $json?.message || (typeof $json?.error === 'string' ? $json.error : '');
if (
  claimed.processing_stage === 'evaluation' &&
  errorMessage &&
  !$json.data &&
  !$json.body
) {
  return { json: {
    provider_required: false,
    claimed_record: claimed,
    proposed_record: recordGeneratorFailure(claimed, new Error(errorMessage), RUNTIME, now)
  } };
}
const html = typeof $json === 'string' ? $json : ($json.data || $json.body || '');
let working = claimed.processing_stage === 'evaluation'
  ? parseJobDetail(html, claimed)
  : claimed;
if (working.processing_stage === 'evaluation') {
  working = evaluateAndRoute(working, PROFILE, RANKING_POLICY, now);
}
if (working.processing_stage !== 'generation' || !working.processing_token) {
  return { json: {
    provider_required: false,
    claimed_record: claimed,
    proposed_record: working
  } };
}
try {
  const prepared = prepareApplicationGeneration(
    working,
    PROFILE,
    APPLICATION_POLICY,
    PACK_POLICY,
    PROVIDER_POLICY,
    now
  );
  return { json: {
    ...prepared,
    claimed_record: claimed,
    working_record: working,
    proposed_record: prepared.record
  } };
} catch (error) {
  return { json: {
    provider_required: false,
    claimed_record: claimed,
    proposed_record: recordGeneratorFailure(working, error, RUNTIME, now)
  } };
}`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Provider Required",
      [100, 200],
      "={{ $json.provider_required === true }}"
    ),
    httpNode("Generate Initial Application with Groq", [300, 40], {
      url: "https://api.groq.com/openai/v1/chat/completions",
      method: "POST",
      timeout: config.http_timeout_ms,
      headers: [
        {
          name: "Authorization",
          value: "={{ 'Bearer ' + $env.JOB_PIPELINE_GROQ_API_KEY }}"
        },
        {
          name: "Accept-Encoding",
          value: "identity"
        }
      ],
      jsonBody:
        "={{ JSON.stringify({ model: " +
        JSON.stringify(groqPolicy.selected_model) +
        ", temperature: " +
        JSON.stringify(groqPolicy.generation.temperature) +
        ", max_tokens: " +
        JSON.stringify(groqPolicy.generation.maximum_output_tokens) +
        ", reasoning_effort: " +
        JSON.stringify(groqModel.reasoning_effort) +
        ", reasoning_format: " +
        JSON.stringify(groqPolicy.generation.reasoning_format) +
        ", messages: [{ role: 'system', content: $json.system_message }, { role: 'user', content: $json.user_message }] }) }}",
      responseFormat: "json"
    }),
    codeNode(
      "Validate Initial Draft",
      [500, 40],
      `${generatorCore}
const PROFILE = ${JSON.stringify(profile)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const PROVIDER_POLICY = ${JSON.stringify(groqPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const prepared = $('Evaluate and Prepare Application').first().json;
const errorMessage = $json?.error?.message || $json?.message || (typeof $json?.error === 'string' ? $json.error : '');
const message = $json?.choices?.[0]?.message?.content || $json?.data?.choices?.[0]?.message?.content || '';
try {
  if (errorMessage || !message) throw new Error(errorMessage || 'Provider response contained no message');
  const assessed = assessInitialGenerationDraft(
    prepared.working_record,
    prepared.pack,
    message,
    prepared.system_message,
    prepared.user_message,
    PROFILE,
    APPLICATION_POLICY,
    PACK_POLICY,
    PROVIDER_POLICY,
    new Date().toISOString()
  );
  return { json: {
    ...assessed,
    claimed_record: prepared.claimed_record,
    working_record: prepared.working_record,
    pack: prepared.pack,
    system_message: prepared.system_message,
    initial_user_message: prepared.user_message
  } };
} catch (error) {
  return { json: {
    repair_required: false,
    claimed_record: prepared.claimed_record,
    proposed_record: recordGeneratorFailure(
      prepared.working_record,
      error,
      RUNTIME,
      new Date().toISOString()
    )
  } };
}
`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Needs One Repair",
      [700, 40],
      "={{ $json.repair_required === true }}"
    ),
    waitNode(
      "Wait Before Repair",
      [900, -80],
      groqPolicy.generation.request_interval_ms
    ),
    httpNode("Generate Application Repair with Groq", [1100, -80], {
      url: "https://api.groq.com/openai/v1/chat/completions",
      method: "POST",
      timeout: config.http_timeout_ms,
      headers: [
        {
          name: "Authorization",
          value: "={{ 'Bearer ' + $env.JOB_PIPELINE_GROQ_API_KEY }}"
        },
        {
          name: "Accept-Encoding",
          value: "identity"
        }
      ],
      jsonBody:
        "={{ JSON.stringify({ model: " +
        JSON.stringify(groqPolicy.selected_model) +
        ", temperature: " +
        JSON.stringify(groqPolicy.generation.temperature) +
        ", max_tokens: " +
        JSON.stringify(groqPolicy.generation.maximum_output_tokens) +
        ", reasoning_effort: " +
        JSON.stringify(groqModel.reasoning_effort) +
        ", reasoning_format: " +
        JSON.stringify(groqPolicy.generation.reasoning_format) +
        ", messages: [{ role: 'system', content: $json.system_message }, { role: 'user', content: $json.repair_user_message }] }) }}",
      responseFormat: "json"
    }),
    codeNode(
      "Validate Repaired Draft",
      [1300, -80],
      `${generatorCore}
const PROFILE = ${JSON.stringify(profile)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const staged = $('Validate Initial Draft').first().json;
const errorMessage = $json?.error?.message || $json?.message || (typeof $json?.error === 'string' ? $json.error : '');
const message = $json?.choices?.[0]?.message?.content || $json?.data?.choices?.[0]?.message?.content || '';
let proposed;
try {
  if (errorMessage || !message) throw new Error(errorMessage || 'Repair response contained no message');
  proposed = applyValidatedGeneration(
    staged.working_record,
    staged.pack,
    message,
    PROFILE,
    APPLICATION_POLICY,
    PACK_POLICY,
    new Date().toISOString()
  );
} catch (error) {
  proposed = recordGeneratorFailure(
    staged.working_record,
    error,
    RUNTIME,
    new Date().toISOString()
  );
}
return { json: {
  claimed_record: staged.claimed_record,
  proposed_record: proposed
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Use Valid Initial Draft",
      [900, 120],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Use Non-Provider Result",
      [300, 320],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Stage Generator Result",
      [1500, 160],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record
} };`,
      "runOnceForEachItem"
    ),
    readSheet("Get Review Queue Before Commit", [1700, 160], queue),
    aggregateNode("Aggregate Fresh Review Queue", [1900, 160], "fresh_rows"),
    codeNode(
      "Guard and Commit Generator Result",
      [2100, 160],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const staged = $('Stage Generator Result').first().json;
const fresh = ($input.first().json.fresh_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA))
  .find((row) => row.canonical_job_id === staged.claimed_record.canonical_job_id);
if (!fresh) throw new Error('Generator commit could not find claimed Review Queue row');
return { json: commitGeneratorResult(
  fresh,
  staged.claimed_record,
  staged.proposed_record,
  SCHEMA,
  new Date().toISOString()
) };`
    ),
    writeSheet(
      "Update Review Queue Result",
      [2300, 160],
      queue,
      "update",
      reviewMachineFields,
      ["canonical_job_id"]
    ),
    readSheet("Get Review Queue After Commit", [2500, 160], queue),
    aggregateNode(
      "Aggregate Review Queue After Commit",
      [2700, 160],
      "fresh_rows"
    ),
    codeNode(
      "Confirm Generator Result Persisted",
      [2900, 160],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const COMMIT_FIELDS = ${JSON.stringify(reviewMachineFields)};
const planned = $('Guard and Commit Generator Result').first().json;
const fresh = ($input.first().json.fresh_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA));
const persisted = confirmGeneratorResultPersisted(
  planned,
  fresh,
  SCHEMA,
  COMMIT_FIELDS
);
console.log(JSON.stringify({
  event: 'generator_result',
  canonical_job_id: persisted.canonical_job_id,
  status: persisted.pipeline_status,
  stage: persisted.processing_stage || ''
}));
return { json: {
  canonical_job_id: persisted.canonical_job_id,
  pipeline_status: persisted.pipeline_status,
  commit_verified: true
} };`
    )
  ];
  const connections = {
    "Schedule Trigger": { main: [[connection("Get Review Queue")]] },
    "Get Review Queue": { main: [[connection("Aggregate Review Queue")]] },
    "Aggregate Review Queue": {
      main: [[connection("Select and Claim Candidate")]]
    },
    "Select and Claim Candidate": {
      main: [[connection("Persist Generator Claim")]]
    },
    "Persist Generator Claim": {
      main: [[connection("Aggregate Claimed Candidate")]]
    },
    "Aggregate Claimed Candidate": {
      main: [[connection("Needs Fresh Job Detail")]]
    },
    "Needs Fresh Job Detail": {
      main: [
        [connection("Fetch Job Detail")],
        [connection("Use Stored Job Detail")]
      ]
    },
    "Fetch Job Detail": {
      main: [[connection("Evaluate and Prepare Application")]]
    },
    "Use Stored Job Detail": {
      main: [[connection("Evaluate and Prepare Application")]]
    },
    "Evaluate and Prepare Application": {
      main: [[connection("Provider Required")]]
    },
    "Provider Required": {
      main: [
        [connection("Generate Initial Application with Groq")],
        [connection("Use Non-Provider Result")]
      ]
    },
    "Generate Initial Application with Groq": {
      main: [[connection("Validate Initial Draft")]]
    },
    "Validate Initial Draft": {
      main: [[connection("Needs One Repair")]]
    },
    "Needs One Repair": {
      main: [
        [connection("Wait Before Repair")],
        [connection("Use Valid Initial Draft")]
      ]
    },
    "Wait Before Repair": {
      main: [[connection("Generate Application Repair with Groq")]]
    },
    "Generate Application Repair with Groq": {
      main: [[connection("Validate Repaired Draft")]]
    },
    "Validate Repaired Draft": {
      main: [[connection("Stage Generator Result")]]
    },
    "Use Valid Initial Draft": {
      main: [[connection("Stage Generator Result")]]
    },
    "Use Non-Provider Result": {
      main: [[connection("Stage Generator Result")]]
    },
    "Stage Generator Result": {
      main: [[connection("Get Review Queue Before Commit")]]
    },
    "Get Review Queue Before Commit": {
      main: [[connection("Aggregate Fresh Review Queue")]]
    },
    "Aggregate Fresh Review Queue": {
      main: [[connection("Guard and Commit Generator Result")]]
    },
    "Guard and Commit Generator Result": {
      main: [[connection("Update Review Queue Result")]]
    },
    "Update Review Queue Result": {
      main: [[connection("Get Review Queue After Commit")]]
    },
    "Get Review Queue After Commit": {
      main: [[connection("Aggregate Review Queue After Commit")]]
    },
    "Aggregate Review Queue After Commit": {
      main: [[connection("Confirm Generator Result Persisted")]]
    }
  };
  return {
    name: "(Evaluator & Generator) Job Pipeline - Safe Routing",
    nodes,
    connections,
    active: false,
    settings: workflowSettings(config),
    versionId: "f3a00000-0000-4000-8000-000000000002",
    meta: {
      templateCredsSetupCompleted: false,
      workflowRole: "evaluator_generator",
      workflowContractVersion: "2026-07-31/v2",
      pipelineSchemaVersion: schema.storage_version,
      candidateProfileVersion: profile.profile_version,
      applicationPolicyVersion: applicationPolicy.policy_version,
      applicationPackPolicyVersion: packPolicy.policy_version,
      groqProviderPolicyVersion: groqPolicy.policy_version,
      authoritativeActiveSheet: queue,
      manualSubmissionOnly: true,
      maximumModelRequestsPerItem:
        groqPolicy.generation.maximum_requests_per_item,
      boundedRepairEnabled: true,
      executionTimeoutSeconds: config.execution_timeout_seconds,
      scheduleOffsetMinutes: config.schedule_offset_minutes
    },
    pinData: {},
    tags: []
  };
}

function buildAlerterMover() {
  const queue = review.sheets.review_queue.name;
  const applied = review.sheets.applied_jobs.name;
  const archive = review.sheets.archive.name;
  const system = review.sheets.system.name;
  const config = runtime.alerter_mover;
  const nodes = [
    scheduleNode("alerter_mover", [-2200, 240], config),
    readSheet("Get Fresh Review Queue", [-2000, 240], queue),
    aggregateNode("Aggregate Fresh Review Queue", [-1800, 240], "review_rows"),
    readSheet("Get Applied Jobs", [-1600, 240], applied),
    aggregateNode("Aggregate Applied Jobs", [-1400, 240], "applied_rows"),
    readSheet("Get Archive", [-1200, 240], archive),
    aggregateNode("Aggregate Archive", [-1000, 240], "archive_rows"),
    codeNode(
      "Plan Independent Moves",
      [-800, 240],
      `${movementCore}
const SCHEMA = ${JSON.stringify(schema)};
const PROFILE = ${JSON.stringify(profile)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const now = new Date().toISOString();
const reviewRows = ($('Aggregate Fresh Review Queue').first().json.review_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA, now));
const appliedRows = ($('Aggregate Applied Jobs').first().json.applied_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA, now));
const archiveRows = ($('Aggregate Archive').first().json.archive_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA, now));
const safety = {
  profile: PROFILE,
  applicationPolicy: APPLICATION_POLICY,
  packPolicy: PACK_POLICY
};
const movement = planQueueActions(
  reviewRows,
  appliedRows,
  archiveRows,
  SCHEMA,
  now,
  safety,
  { movementPerRunCap: RUNTIME.movement_per_run_cap }
);
const outcome = planOutcomeUpdates(appliedRows, SCHEMA, now);
console.log(JSON.stringify({
  event: 'movement_plan',
  moves: movement.moves.length,
  generation_requests: movement.generation_requests.length,
  rejected: movement.rejected.map((entry) => entry.reason),
  outcome_updates: outcome.updates.length
}));
return [{ json: { movement, outcome, now } }];`
    ),
    codeNode(
      "Prepare Outcome Updates",
      [-600, 240],
      `const rows = $('Plan Independent Moves').first().json.outcome.updates || [];
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Outcome Updates", [-400, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Update Applied Outcomes",
      [-200, 120],
      applied,
      "update",
      outcomeStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    codeNode(
      "Emit Movement Claims",
      [0, 240],
      `${movementCore}
const RUNTIME = ${JSON.stringify(config)};
const plan = $('Plan Independent Moves').first().json;
const rows = (plan.movement.moves || []).map((movementPlan) => ({
  ...createSystemClaim({
    stage: 'movement',
    canonicalJobId: movementPlan.canonical_job_id,
    scope: movementPlan.destination,
    executionId: String($execution.id),
    now: plan.now,
    leaseMs: RUNTIME.claim_lease_ms
  }),
  movement_plan: movementPlan
}));
return rows.length
  ? rows.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Movement Claims", [200, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Append Movement Claims",
      [400, 120],
      system,
      "append",
      review.sheets.system.fields,
      [],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Movement Claim Writes", [600, 120], "claims"),
    readSheet("Get System Claims", [800, 240], system),
    aggregateNode("Aggregate System Claims", [1000, 240], "system_claims"),
    codeNode(
      "Keep Winning Movement Claims",
      [1200, 240],
      `${movementCore}
const plan = $('Plan Independent Moves').first().json;
const proposed = $('Emit Movement Claims').all()
  .map((item) => item.json)
  .filter((item) => item._noop !== true);
const persisted = $input.first().json.system_claims || [];
const winners = selectWinningSystemClaims(proposed, persisted, plan.now);
return [{ json: {
  movement: {
    ...plan.movement,
    moves: winners.map((winner) => winner.movement_plan)
  }
} }];`
    ),
    codeNode(
      "Select Expired System Claims",
      [1200, 40],
      `${movementCore}
const plan = $('Plan Independent Moves').first().json;
const rows = expiredSystemClaimRows(
  $input.first().json.system_claims || [],
  plan.now
);
return rows.length
  ? rows.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Expired System Claims",
      [1400, 40],
      "={{ $json._noop !== true }}"
    ),
    deleteRowsNode(
      "Delete Expired System Claims",
      [1600, 40],
      system,
      { continueOnError: true }
    ),
    codeNode(
      "Prepare Applied Writes",
      [1400, 240],
      `${movementCore}
const writes = destinationWrites(
  $('Keep Winning Movement Claims').first().json.movement
);
return writes.applied.length
  ? writes.applied.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Applied Writes", [1600, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Upsert Applied Jobs",
      [1800, 120],
      applied,
      "appendOrUpdate",
      schema.fields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Applied Writes", [2000, 120], "applied_writes"),
    codeNode(
      "Prepare Archive Writes",
      [2200, 240],
      `${movementCore}
const writes = destinationWrites(
  $('Keep Winning Movement Claims').first().json.movement
);
return writes.archive.length
  ? writes.archive.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Archive Writes", [2400, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Upsert Archive",
      [2600, 120],
      archive,
      "appendOrUpdate",
      schema.fields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Archive Writes", [2800, 120], "archive_writes"),
    readSheet("Get Review Queue After Copies", [3000, 240], queue),
    aggregateNode("Aggregate Review After Copies", [3200, 240], "review_rows"),
    readSheet("Get Applied Jobs After Copies", [3400, 240], applied),
    aggregateNode("Aggregate Applied After Copies", [3600, 240], "applied_rows"),
    readSheet("Get Archive After Copies", [3800, 240], archive),
    aggregateNode("Aggregate Archive After Copies", [4000, 240], "archive_rows"),
    codeNode(
      "Confirm Destination Copies",
      [4200, 240],
      `${movementCore}
const SCHEMA = ${JSON.stringify(schema)};
const plans = $('Keep Winning Movement Claims').first().json.movement;
const result = confirmMoveDeletions(
  plans,
  ($('Aggregate Review After Copies').first().json.review_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA)),
  ($('Aggregate Applied After Copies').first().json.applied_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA)),
  ($('Aggregate Archive After Copies').first().json.archive_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA)),
  SCHEMA
);
console.log(JSON.stringify({
  event: 'movement_confirmation',
  confirmed: result.deletions.length,
  rejected: result.rejected.map((entry) => entry.reason)
}));
return [{ json: result }];`
    ),
    codeNode(
      "Prepare Confirmed Deletions",
      [4400, 240],
      `const rows = $('Confirm Destination Copies').first().json.deletions || [];
return rows.length
  ? rows.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Confirmed Deletions",
      [4600, 240],
      "={{ $json._noop !== true }}"
    ),
    deleteRowsNode(
      "Delete Confirmed Review Queue Rows",
      [4800, 120],
      queue,
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Deletion Attempts", [5000, 240], "deletions"),
    readSheet("Get Review Queue After Moves", [5200, 240], queue),
    aggregateNode("Aggregate Review After Moves", [5400, 240], "review_rows"),
    codeNode(
      "Select Fresh Alerts",
      [5600, 240],
      `${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(alertPolicy)};
const PROFILE = ${JSON.stringify(profile)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const rows = ($('Aggregate Review After Moves').first().json.review_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA));
const selected = selectFreshAlertCandidates(
  rows,
  SCHEMA,
  POLICY,
  new Date().toISOString(),
  { profile: PROFILE, applicationPolicy: APPLICATION_POLICY, packPolicy: PACK_POLICY }
);
console.log(JSON.stringify({
  event: 'alert_selection',
  candidates: selected.candidates.length,
  state_updates: selected.state_updates.length,
  rejected: selected.rejected.map((entry) => entry.reasons)
}));
return [{ json: selected }];`
    ),
    codeNode(
      "Prepare Terminal Alert States",
      [5800, 240],
      `const rows = $('Select Fresh Alerts').first().json.state_updates || [];
return rows.length
  ? rows.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Terminal Alert States",
      [6000, 240],
      "={{ $json._noop !== true }}"
    ),
    writeSheet(
      "Persist Terminal Alert States",
      [6200, 120],
      queue,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    codeNode(
      "Emit Alert Claims",
      [6400, 240],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const selected = $('Select Fresh Alerts').first().json;
const now = new Date().toISOString();
const rows = (selected.candidates || []).map(({ record, idempotency_key }) => ({
  ...createSystemClaim({
    stage: 'alert',
    canonicalJobId: record.canonical_job_id,
    scope: idempotency_key,
    executionId: String($execution.id),
    now,
    leaseMs: RUNTIME.claim_lease_ms
  }),
  alert_candidate: record
}));
return rows.length
  ? rows.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Alert Claims", [6600, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Append Alert Claims",
      [6800, 120],
      system,
      "append",
      review.sheets.system.fields,
      [],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Alert Claim Writes", [7000, 120], "claims"),
    readSheet("Get Alert System Claims", [7200, 240], system),
    aggregateNode(
      "Aggregate Alert System Claims",
      [7400, 240],
      "system_claims"
    ),
    codeNode(
      "Keep Winning Alert Claims",
      [7600, 240],
      `${alertCore}
const proposed = $('Emit Alert Claims').all()
  .map((item) => item.json)
  .filter((item) => item._noop !== true);
const winners = selectWinningSystemClaims(
  proposed,
  $input.first().json.system_claims || [],
  new Date().toISOString()
);
return [{ json: {
  candidates: winners.map((winner) => winner.alert_candidate)
} }];`
    ),
    codeNode(
      "Prepare Alert Sending States",
      [7800, 240],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const rows = $('Keep Winning Alert Claims').first().json.candidates || [];
return rows.length
  ? rows.map((record) => ({
      json: markAlertSending(
        record,
        POLICY,
        String($execution.id),
        new Date().toISOString()
      )
    }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Alert Sending States",
      [8000, 240],
      "={{ $json._noop !== true }}"
    ),
    writeSheet(
      "Persist Alert Sending States",
      [8200, 120],
      queue,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Alert Sending States", [8400, 240], "claims"),
    readSheet("Get Review Queue After Alert Claims", [8600, 240], queue),
    aggregateNode("Aggregate Fresh Alert Claims", [8800, 240], "review_rows"),
    codeNode(
      "Confirm and Render Alerts",
      [9000, 240],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const PROFILE = ${JSON.stringify(profile)};
const APPLICATION_POLICY = ${JSON.stringify(applicationPolicy)};
const PACK_POLICY = ${JSON.stringify(packPolicy)};
const proposed = $('Prepare Alert Sending States').all()
  .map((item) => item.json)
  .filter((item) => item._noop !== true);
const fresh = ($input.first().json.review_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, ${JSON.stringify(schema)}));
const byId = new Map(fresh.map((row) => [String(row.canonical_job_id).toLowerCase(), row]));
const rendered = proposed.flatMap((claim) => {
  try {
    const persisted = byId.get(String(claim.canonical_job_id).toLowerCase());
    if (!persisted ||
        persisted.record_version !== claim.record_version ||
        persisted.state_guard !== claim.state_guard ||
        persisted.alert_status !== 'sending' ||
        persisted.alert_claim_token !== claim.alert_claim_token ||
        persisted.user_action) return [];
    const payload = renderSlackAlert(persisted, POLICY, {
      reviewUrl: $env[POLICY.environment.review_url],
      messageSafetyContext: { profile: PROFILE, applicationPolicy: APPLICATION_POLICY, packPolicy: PACK_POLICY }
    });
    return [{ json: { claim: persisted, payload } }];
  } catch (error) {
    console.log(JSON.stringify({
      event: 'alert_render_rejected',
      canonical_job_id: claim.canonical_job_id,
      category: 'stale_or_unsafe'
    }));
    return [];
  }
});
return rendered.length
  ? rendered
  : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Provider Alerts", [9200, 240], "={{ $json._noop !== true }}"),
    httpNode("Send Slack Alert", [9400, 120], {
      url: `={{ $env.${alertPolicy.environment.provider_webhook_url} }}`,
      method: "POST",
      timeout: alertPolicy.provider_timeout_ms,
      interval: alertPolicy.provider_request_interval_ms,
      body: "={{ JSON.stringify({ text: $json.payload.text }) }}",
      responseFormat: "text",
      fullResponse: true,
      continueOnError: true
    }),
    codeNode(
      "Stage Slack Result",
      [9600, 120],
      `const request = $('Confirm and Render Alerts').item.json;
return { json: {
  claim: request.claim,
  provider_result: $json
} };`,
      "runOnceForEachItem"
    ),
    aggregateNode("Aggregate Slack Results", [9800, 120], "results"),
    readSheet("Get Review Queue Before Alert Commit", [10000, 120], queue),
    aggregateNode(
      "Aggregate Review Before Alert Commit",
      [10200, 120],
      "review_rows"
    ),
    codeNode(
      "Guard and Commit Slack Results",
      [10400, 120],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const staged = $('Aggregate Slack Results').first().json.results || [];
const fresh = ($input.first().json.review_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, ${JSON.stringify(schema)}));
const byId = new Map(fresh.map((row) => [String(row.canonical_job_id).toLowerCase(), row]));
return staged.flatMap((entry) => {
  try {
    const current = byId.get(String(entry.claim.canonical_job_id).toLowerCase());
    const updated = applySlackProviderResult(
      current,
      entry.claim,
      entry.provider_result,
      POLICY,
      new Date().toISOString()
    );
    console.log(JSON.stringify({
      event: 'alert_delivery',
      canonical_job_id: updated.canonical_job_id,
      status: updated.alert_status,
      category: updated.alert_error_category || ''
    }));
    return [{ json: updated }];
  } catch (error) {
    console.log(JSON.stringify({
      event: 'alert_delivery',
      canonical_job_id: entry.claim?.canonical_job_id || '',
      status: 'commit_rejected',
      category: 'stale_state'
    }));
    return [];
  }
});`
    ),
    writeSheet(
      "Update Alert Results",
      [10600, 120],
      queue,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    )
  ];
  const connections = {
    "Schedule Trigger": { main: [[connection("Get Fresh Review Queue")]] },
    "Get Fresh Review Queue": {
      main: [[connection("Aggregate Fresh Review Queue")]]
    },
    "Aggregate Fresh Review Queue": {
      main: [[connection("Get Applied Jobs")]]
    },
    "Get Applied Jobs": { main: [[connection("Aggregate Applied Jobs")]] },
    "Aggregate Applied Jobs": { main: [[connection("Get Archive")]] },
    "Get Archive": { main: [[connection("Aggregate Archive")]] },
    "Aggregate Archive": { main: [[connection("Plan Independent Moves")]] },
    "Plan Independent Moves": {
      main: [[connection("Prepare Outcome Updates")]]
    },
    "Prepare Outcome Updates": {
      main: [[connection("Has Outcome Updates")]]
    },
    "Has Outcome Updates": {
      main: [
        [connection("Update Applied Outcomes")],
        [connection("Emit Movement Claims")]
      ]
    },
    "Update Applied Outcomes": {
      main: [[connection("Emit Movement Claims")]]
    },
    "Emit Movement Claims": {
      main: [[connection("Has Movement Claims")]]
    },
    "Has Movement Claims": {
      main: [
        [connection("Append Movement Claims")],
        [connection("Get System Claims")]
      ]
    },
    "Append Movement Claims": {
      main: [[connection("Aggregate Movement Claim Writes")]]
    },
    "Aggregate Movement Claim Writes": {
      main: [[connection("Get System Claims")]]
    },
    "Get System Claims": {
      main: [[connection("Aggregate System Claims")]]
    },
    "Aggregate System Claims": {
      main: [
        [
          connection("Keep Winning Movement Claims"),
          connection("Select Expired System Claims")
        ]
      ]
    },
    "Select Expired System Claims": {
      main: [[connection("Has Expired System Claims")]]
    },
    "Has Expired System Claims": {
      main: [[connection("Delete Expired System Claims")], []]
    },
    "Keep Winning Movement Claims": {
      main: [[connection("Prepare Applied Writes")]]
    },
    "Prepare Applied Writes": { main: [[connection("Has Applied Writes")]] },
    "Has Applied Writes": {
      main: [
        [connection("Upsert Applied Jobs")],
        [connection("Prepare Archive Writes")]
      ]
    },
    "Upsert Applied Jobs": {
      main: [[connection("Aggregate Applied Writes")]]
    },
    "Aggregate Applied Writes": {
      main: [[connection("Prepare Archive Writes")]]
    },
    "Prepare Archive Writes": { main: [[connection("Has Archive Writes")]] },
    "Has Archive Writes": {
      main: [
        [connection("Upsert Archive")],
        [connection("Get Review Queue After Copies")]
      ]
    },
    "Upsert Archive": {
      main: [[connection("Aggregate Archive Writes")]]
    },
    "Aggregate Archive Writes": {
      main: [[connection("Get Review Queue After Copies")]]
    },
    "Get Review Queue After Copies": {
      main: [[connection("Aggregate Review After Copies")]]
    },
    "Aggregate Review After Copies": {
      main: [[connection("Get Applied Jobs After Copies")]]
    },
    "Get Applied Jobs After Copies": {
      main: [[connection("Aggregate Applied After Copies")]]
    },
    "Aggregate Applied After Copies": {
      main: [[connection("Get Archive After Copies")]]
    },
    "Get Archive After Copies": {
      main: [[connection("Aggregate Archive After Copies")]]
    },
    "Aggregate Archive After Copies": {
      main: [[connection("Confirm Destination Copies")]]
    },
    "Confirm Destination Copies": {
      main: [[connection("Prepare Confirmed Deletions")]]
    },
    "Prepare Confirmed Deletions": {
      main: [[connection("Has Confirmed Deletions")]]
    },
    "Has Confirmed Deletions": {
      main: [
        [connection("Delete Confirmed Review Queue Rows")],
        [connection("Aggregate Deletion Attempts")]
      ]
    },
    "Delete Confirmed Review Queue Rows": {
      main: [[connection("Aggregate Deletion Attempts")]]
    },
    "Aggregate Deletion Attempts": {
      main: [[connection("Get Review Queue After Moves")]]
    },
    "Get Review Queue After Moves": {
      main: [[connection("Aggregate Review After Moves")]]
    },
    "Aggregate Review After Moves": {
      main: [[connection("Select Fresh Alerts")]]
    },
    "Select Fresh Alerts": {
      main: [[connection("Prepare Terminal Alert States")]]
    },
    "Prepare Terminal Alert States": {
      main: [[connection("Has Terminal Alert States")]]
    },
    "Has Terminal Alert States": {
      main: [
        [connection("Persist Terminal Alert States")],
        [connection("Emit Alert Claims")]
      ]
    },
    "Persist Terminal Alert States": {
      main: [[connection("Emit Alert Claims")]]
    },
    "Emit Alert Claims": {
      main: [[connection("Has Alert Claims")]]
    },
    "Has Alert Claims": {
      main: [
        [connection("Append Alert Claims")],
        [connection("Get Alert System Claims")]
      ]
    },
    "Append Alert Claims": {
      main: [[connection("Aggregate Alert Claim Writes")]]
    },
    "Aggregate Alert Claim Writes": {
      main: [[connection("Get Alert System Claims")]]
    },
    "Get Alert System Claims": {
      main: [[connection("Aggregate Alert System Claims")]]
    },
    "Aggregate Alert System Claims": {
      main: [[connection("Keep Winning Alert Claims")]]
    },
    "Keep Winning Alert Claims": {
      main: [[connection("Prepare Alert Sending States")]]
    },
    "Prepare Alert Sending States": {
      main: [[connection("Has Alert Sending States")]]
    },
    "Has Alert Sending States": {
      main: [
        [connection("Persist Alert Sending States")],
        [connection("Aggregate Alert Sending States")]
      ]
    },
    "Persist Alert Sending States": {
      main: [[connection("Aggregate Alert Sending States")]]
    },
    "Aggregate Alert Sending States": {
      main: [[connection("Get Review Queue After Alert Claims")]]
    },
    "Get Review Queue After Alert Claims": {
      main: [[connection("Aggregate Fresh Alert Claims")]]
    },
    "Aggregate Fresh Alert Claims": {
      main: [[connection("Confirm and Render Alerts")]]
    },
    "Confirm and Render Alerts": {
      main: [[connection("Has Provider Alerts")]]
    },
    "Has Provider Alerts": {
      main: [[connection("Send Slack Alert")], []]
    },
    "Send Slack Alert": { main: [[connection("Stage Slack Result")]] },
    "Stage Slack Result": {
      main: [[connection("Aggregate Slack Results")]]
    },
    "Aggregate Slack Results": {
      main: [[connection("Get Review Queue Before Alert Commit")]]
    },
    "Get Review Queue Before Alert Commit": {
      main: [[connection("Aggregate Review Before Alert Commit")]]
    },
    "Aggregate Review Before Alert Commit": {
      main: [[connection("Guard and Commit Slack Results")]]
    },
    "Guard and Commit Slack Results": {
      main: [[connection("Update Alert Results")]]
    }
  };
  return {
    name: "(Alerter & Mover) Job Pipeline - Slack and Terminal Moves",
    nodes,
    connections,
    active: false,
    settings: workflowSettings(config),
    versionId: "f3a00000-0000-4000-8000-000000000003",
    meta: {
      templateCredsSetupCompleted: false,
      workflowRole: "alerter_mover",
      workflowContractVersion: "2026-07-31/v2",
      alertPolicyVersion: alertPolicy.policy_version,
      pipelineSchemaVersion: schema.storage_version,
      authoritativeActiveSheet: queue,
      destinationSheets: [applied, archive],
      manualSubmissionOnly: true,
      movementIndependentOfSlack: true,
      movementBeforeAlertSelection: true,
      appendWinnerClaims: true,
      executionTimeoutSeconds: config.execution_timeout_seconds,
      scheduleOffsetMinutes: config.schedule_offset_minutes
    },
    pinData: {},
    tags: []
  };
}

const outputs = [
  ["workflows/scraper.json", buildScraper()],
  ["workflows/generator.json", buildGenerator()],
  ["workflows/alerter-mover.json", buildAlerterMover()]
];

const workflowsDirectory = resolve(root, "workflows");
const existingWorkflowFiles = (await readdir(workflowsDirectory))
  .filter((file) => file.endsWith(".json"))
  .sort();
const unexpectedWorkflowErrors = validateWorkflowArtifactManifest([
  ...existingWorkflowFiles,
  ...outputs.map(([path]) => path.split("/").pop())
]).filter((error) => error.startsWith("unexpected"));
if (unexpectedWorkflowErrors.length > 0) {
  throw new Error(
    `Invalid workflow artifact manifest:\n- ${unexpectedWorkflowErrors.join("\n- ")}`
  );
}

for (const [path, workflow] of outputs) {
  const target = resolve(root, path);
  const generated = `${JSON.stringify(workflow, null, 2)}\n`;
  if (checkOnly) {
    const current = await readFile(target, "utf8");
    if (current !== generated) {
      throw new Error(`${path} is out of date; run npm run build:workflows`);
    }
  } else {
    await writeFile(target, generated);
  }
}

const finalWorkflowFiles = (await readdir(workflowsDirectory))
  .filter((file) => file.endsWith(".json"))
  .sort();
const manifestErrors = validateWorkflowArtifactManifest(finalWorkflowFiles);
if (manifestErrors.length > 0) {
  throw new Error(
    `Invalid workflow artifact manifest:\n- ${manifestErrors.join("\n- ")}`
  );
}

if (checkOnly) {
  console.log("Three workflow artifacts are up to date.");
} else {
  console.log("Rebuilt Scraper, Evaluator & Generator, and Alerter & Mover.");
}
