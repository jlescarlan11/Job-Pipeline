import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  validateAlertPolicy,
  validateAlertRuntimeCapacity
} from "../src/alerter-mover.mjs";
import {
  ALERT_RECEIPT_PERSISTED_FIELDS,
  alertReceiptDataTableSchema,
  validateAlertReceiptCompatibility,
  validateAlertReceiptPolicy
} from "../src/alert-receipts.mjs";
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
import { googleSheetsBatchRanges } from "../src/sheet-batch.mjs";

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
  alertPolicy,
  alertReceiptPolicy
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
  readJson("config/alert-policy.json"),
  readJson("config/alert-receipts.json")
]);

const runtimeErrors = validateRuntimeConfig(runtime);
if (runtimeErrors.length > 0) {
  throw new Error(`Invalid runtime configuration:\n- ${runtimeErrors.join("\n- ")}`);
}
const searchErrors = validateSearchPlan(searchPlan);
if (searchErrors.length > 0) {
  throw new Error(`Invalid search plan:\n- ${searchErrors.join("\n- ")}`);
}
const alertErrors = [
  ...validateAlertPolicy(alertPolicy),
  ...validateAlertRuntimeCapacity(alertPolicy, runtime.alerter_mover)
];
if (alertErrors.length > 0) {
  throw new Error(`Invalid alert policy:\n- ${alertErrors.join("\n- ")}`);
}
const alertReceiptErrors = [
  ...validateAlertReceiptPolicy(alertReceiptPolicy),
  ...validateAlertReceiptCompatibility(alertReceiptPolicy, alertPolicy)
];
if (alertReceiptErrors.length > 0) {
  throw new Error(
    `Invalid alert receipt policy:\n- ${alertReceiptErrors.join("\n- ")}`
  );
}
const groqErrors = [
  ...validateGroqProviderPolicy(groqPolicy),
  ...validateGroqRuntimeCapacity(groqPolicy, runtime.generator)
];
if (groqErrors.length > 0) {
  throw new Error(`Invalid Groq provider/runtime configuration:\n- ${groqErrors.join("\n- ")}`);
}
if (
  review.sheets.scraped_jobs.name !== "Scraped Jobs" ||
  review.sheets.to_review.name !== "To Review" ||
  review.sheets.to_apply.name !== "To Apply"
) {
  throw new Error("Segmented active sheet configuration is invalid");
}
const latestFirstBusinessSheets = Object.fromEntries(
  Object.values(review.sheets)
    .filter((definition) => schema.business_stores.includes(definition.name))
    .map((definition) => [definition.name, definition.latest_first_column])
);

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
  "src/system-claims.mjs",
  "src/generator.mjs"
);
const sheetContextCore = await bundledCore(
  "src/contracts.mjs",
  "src/profile.mjs",
  "src/sheet-context.mjs"
);
const groqModel = groqPolicy.models.find(
  (model) => model.id === groqPolicy.selected_model
);
const groqRepairModel = groqPolicy.models.find(
  (model) => model.id === groqPolicy.repair_model
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
  "src/movement.mjs",
  "src/alerter-mover.mjs"
);
const receiptCore = await bundledCore("src/alert-receipts.mjs");
const alertReceiptCore = `${alertCore}\n${receiptCore}`;
const sheetOrderCore = await bundledCore("src/sheet-order.mjs");
const sheetBatchCore = await bundledCore("src/sheet-batch.mjs");
const contextSources = [
  ["candidateRows", "candidate", "Candidate", "candidate_rows"],
  ["skillRows", "skills", "Skills", "skill_rows"],
  ["experienceRows", "experience", "Experience", "experience_rows"],
  ["projectRows", "projects", "Projects", "project_rows"],
  ["educationRows", "education", "Education", "education_rows"],
  ["awardRows", "awards", "Awards", "award_rows"],
  [
    "jobPreferenceRows",
    "job_preferences",
    "Job Preferences",
    "job_preference_rows"
  ],
  [
    "applicationSettingRows",
    "application_settings",
    "Application Settings",
    "application_setting_rows"
  ],
  [
    "requiredStyleRows",
    "required_style",
    "Required Style",
    "required_style_rows"
  ],
  [
    "bannedPhraseRows",
    "banned_phrases",
    "Banned Phrases",
    "banned_phrase_rows"
  ]
];

function contextSnapshotNodes(startX, y, idPrefix) {
  const nodes = [];
  for (const [index, [, sheetKey, label, destination]] of contextSources.entries()) {
    const x = startX + index * 400;
    nodes.push(
      readSheet(`Get ${label} Context`, [x, y], review.sheets[sheetKey].name, {
        explicitId: `${idPrefix}-${String(index * 2 + 1).padStart(12, "0")}`,
        workbookEnvironmentVariable: CONFIG_WORKBOOK_ENVIRONMENT_VARIABLE
      }),
      aggregateNode(
        `Aggregate ${label} Context`,
        [x + 200, y],
        destination,
        `${idPrefix}-${String(index * 2 + 2).padStart(12, "0")}`
      )
    );
  }
  const rowExpressions = contextSources
    .map(
      ([property, , label, destination]) =>
        `${property}: ($('Aggregate ${label} Context').all()[0]?.json.${destination} || [])\n` +
        `    .filter((row) => row && Object.keys(row).length)`
    )
    .join(",\n  ");
  nodes.push(
    codeNode(
      "Compile Candidate Context",
      [startX + contextSources.length * 400, y],
      `${sheetContextCore}
const rows = {
  ${rowExpressions}
};
return { json: compileSheetContext(rows, {
  rankingPolicy: ${JSON.stringify(rankingPolicy)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
}) };`,
      undefined,
      `${idPrefix}-${String(contextSources.length * 2 + 1).padStart(12, "0")}`
    )
  );
  return nodes;
}

function connectContextSnapshot(connections, nextNode) {
  for (const [index, [, , label]] of contextSources.entries()) {
    const read = `Get ${label} Context`;
    const aggregate = `Aggregate ${label} Context`;
    const next = contextSources[index + 1];
    connections[read] = { main: [[connection(aggregate)]] };
    connections[aggregate] = {
      main: [[connection(next ? `Get ${next[2]} Context` : "Compile Candidate Context")]]
    };
  }
  connections["Compile Candidate Context"] = {
    main: [[connection(nextNode)]]
  };
}
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
  "review_approval_guard",
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

function codeNode(name, position, jsCode, mode, explicitId) {
  return {
    parameters: {
      ...(mode ? { mode } : {}),
      jsCode
    },
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    id: explicitId || id(),
    name
  };
}

function ifNode(name, position, expression, explicitId) {
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
    id: explicitId || id(),
    name
  };
}

function waitNode(name, position, milliseconds, explicitId) {
  return {
    parameters: {
      resume: "timeInterval",
      amount: milliseconds / 1000,
      unit: "seconds"
    },
    type: "n8n-nodes-base.wait",
    typeVersion: 1.1,
    position,
    id: explicitId || id(),
    name
  };
}

function loopOverItemsNode(name, position, batchSize = 1) {
  return {
    parameters: {
      batchSize,
      options: {}
    },
    type: "n8n-nodes-base.splitInBatches",
    typeVersion: 3,
    position,
    id: id(),
    name
  };
}

function aggregateNode(name, position, destinationFieldName, explicitId) {
  return {
    parameters: {
      aggregate: "aggregateAllItemData",
      destinationFieldName,
      options: {}
    },
    type: "n8n-nodes-base.aggregate",
    typeVersion: 1,
    position,
    id: explicitId || id(),
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
    interval,
    credentialType
  }
) {
  return {
    parameters: {
      method,
      url,
      ...(credentialType
        ? {
            authentication: "predefinedCredentialType",
            nodeCredentialType: credentialType
          }
        : {}),
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

const QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE =
  "JOB_PIPELINE_SPREADSHEET_ID";
const CONFIG_WORKBOOK_ENVIRONMENT_VARIABLE =
  "JOB_PIPELINE_CONFIG_SPREADSHEET_ID";

function documentId(
  environmentVariable = QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE
) {
  return {
    __rl: true,
    value: `={{ $env.${environmentVariable} }}`,
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

function readSheet(
  name,
  position,
  sheet,
  {
    continueOnError = false,
    explicitId,
    workbookEnvironmentVariable = QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE,
    retry = runtime.google_sheets.read_retry
  } = {}
) {
  return {
    parameters: {
      documentId: documentId(workbookEnvironmentVariable),
      sheetName: sheetName(sheet),
      options: {}
    },
    type: "n8n-nodes-base.googleSheets",
    typeVersion: 4.7,
    position,
    id: explicitId || id(),
    name,
    alwaysOutputData: true,
    ...(retry
      ? {
          retryOnFail: true,
          maxTries: retry.max_attempts,
          waitBetweenTries: retry.backoff_ms
        }
      : {}),
    ...(continueOnError ? { onError: "continueRegularOutput" } : {})
  };
}

function batchReadSheets(
  name,
  position,
  sheetNames,
  {
    workbookEnvironmentVariable = QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE,
    urlExpression,
    continueOnError = false,
    retry = runtime.google_sheets.read_retry
  } = {}
) {
  const ranges = googleSheetsBatchRanges(sheetNames);
  const query = ranges
    .map((range) => `ranges=${encodeURIComponent(range)}`)
    .join("&");
  const url = urlExpression ||
    `=https://sheets.googleapis.com/v4/spreadsheets/{{$env.${workbookEnvironmentVariable}}}/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&${query}`;
  return httpNode(name, position, {
    url,
    timeout: 10000,
    retry,
    responseFormat: "json",
    continueOnError,
    credentialType: "googleSheetsOAuth2Api"
  });
}

function dataTableResourceSchema() {
  const types = new Map(
    alertReceiptDataTableSchema().map((column) => [column.name, column.type])
  );
  return ALERT_RECEIPT_PERSISTED_FIELDS.map((field) => ({
    id: field,
    displayName: field,
    required: false,
    defaultMatch: false,
    display: true,
    type: types.get(field),
    canBeUsedToMatch: true
  }));
}

function dataTableFilter(keyName, keyValue) {
  return { keyName, condition: "eq", keyValue };
}

function alertReceiptDataTableNode(
  name,
  position,
  operation,
  {
    filters = [],
    matchType = "allConditions",
    continueOnError = true,
    alwaysOutputData = true
  } = {}
) {
  const parameters = {
    resource: "row",
    operation,
    dataTableId: {
      __rl: true,
      mode: "id",
      value: `={{ $env.${alertReceiptPolicy.store.environment_variable} }}`
    },
    matchType,
    filters: { conditions: filters },
    ...(operation === "get"
      ? { returnAll: true }
      : {
          columns: {
            mappingMode: "defineBelow",
            value: Object.fromEntries(
              ALERT_RECEIPT_PERSISTED_FIELDS.map((field) => [
                field,
                sheetExpression(field)
              ])
            ),
            matchingColumns: [],
            schema: dataTableResourceSchema(),
            attemptToConvertTypes: false,
            convertFieldsToString: false
          },
          options: {}
        })
  };
  return {
    parameters,
    type: "n8n-nodes-base.dataTable",
    typeVersion: 1.1,
    position,
    id: id(),
    name,
    ...(alwaysOutputData ? { alwaysOutputData: true } : {}),
    ...(continueOnError ? { onError: "continueRegularOutput" } : {})
  };
}

function writeSheet(
  name,
  position,
  sheet,
  operation,
  fields,
  matchingColumns = [],
  { continueOnError = false, explicitId } = {}
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
    id: explicitId || id(),
    name,
    ...(continueOnError ? { onError: "continueRegularOutput" } : {})
  };
}

function deleteRowsNode(
  name,
  position,
  sheet,
  { continueOnError = false, explicitId } = {}
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
    id: explicitId || id(),
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
  const scraped = review.sheets.scraped_jobs.name;
  const toReview = review.sheets.to_review.name;
  const toApply = review.sheets.to_apply.name;
  const applied = review.sheets.applied_jobs.name;
  const archive = review.sheets.archive.name;
  const keywords = review.sheets.search_keywords.name;
  const system = review.sheets.system.name;
  const config = runtime.scraper;
  const nodes = [
    scheduleNode("scraper", [-2000, 200], config),
    readSheet(
      "Get Search Keywords",
      [-1800, 200],
      keywords,
      {
        continueOnError: true,
        workbookEnvironmentVariable: CONFIG_WORKBOOK_ENVIRONMENT_VARIABLE,
        // Keep all existing workflow node IDs stable. This new ID is outside
        // the generator's sequential range and therefore does not renumber
        // unrelated workflows or production execution history.
        explicitId: "f3a00000-0000-4000-8000-000000009999"
      }
    ),
    codeNode(
      "Capture Fixed Window and Keywords",
      [-1600, 200],
      `${discoveryCore}
const SEARCH_POLICY = ${JSON.stringify(searchPlan)};
const errors = validateSearchPlan(SEARCH_POLICY);
if (errors.length) throw new Error('Invalid search plan: ' + errors.join('; '));
const keywordSnapshot = createKeywordSnapshot(
  $input.all().map((item) => item.json || {})
);
const window = createDiscoveryWindow(new Date().toISOString());
return buildSearchRequests(SEARCH_POLICY, keywordSnapshot, window)
  .map((request) => ({ json: request }));`
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
const SEARCH_POLICY = ${JSON.stringify(searchPlan)};
let previous;
try {
  previous = $('Pace Next Page').item.json;
} catch {
  previous = $('Capture Fixed Window and Keywords').item.json;
}
const providerStatus = Number(
  $json?.error?.status ?? $json?.error?.statusCode ??
  $json?.status ?? $json?.statusCode ?? 0
);
const providerError =
  $json?.error?.message || $json?.error?.description ||
  $json?.message || $json?.errorMessage ||
  (typeof $json?.error === 'string' ? $json.error : '');
const errorMessage = providerStatus
  ? String(providerStatus) + ': ' + (providerError || 'Provider request failed')
  : providerError;
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
return { json: advanceSearchPagination(previous, page, SEARCH_POLICY) };`,
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
    readSheet("Get Scraped Jobs", [-600, 300], scraped),
    aggregateNode("Aggregate Scraped Jobs", [-400, 300], "scraped_rows"),
    readSheet("Get To Review", [-200, 460], toReview, {
      explicitId: "f3a10000-0000-4000-8000-000000000001"
    }),
    aggregateNode(
      "Aggregate To Review",
      [0, 460],
      "to_review_rows",
      "f3a10000-0000-4000-8000-000000000002"
    ),
    readSheet("Get To Apply", [200, 460], toApply, {
      explicitId: "f3a10000-0000-4000-8000-000000000003"
    }),
    aggregateNode(
      "Aggregate To Apply",
      [400, 460],
      "to_apply_rows",
      "f3a10000-0000-4000-8000-000000000004"
    ),
    readSheet("Get Applied Jobs", [-200, 300], applied),
    aggregateNode("Aggregate Applied Jobs", [0, 300], "applied_rows"),
    readSheet("Get Archive", [200, 300], archive),
    aggregateNode("Aggregate Archive", [400, 300], "archive_rows"),
    codeNode(
      "Reconcile Discovery",
      [600, 300],
      `${discoveryCore}
const SCHEMA = ${JSON.stringify(schema)};
const SEARCH_POLICY = ${JSON.stringify(searchPlan)};
const KEYWORD_SNAPSHOT = $('Capture Fixed Window and Keywords').all()
  .map((item) => ({
    id: item.json.keyword_id,
    keyword: item.json.keyword,
    enabled: true
  }));
const states = $('Aggregate Search Pages').first().json.search_states || [];
const pageResults = states.flatMap((state) => state.page_results || []);
const nonempty = (row) => row && Object.keys(row).length;
const scrapedRows = ($('Aggregate Scraped Jobs').first().json.scraped_rows || []).filter(nonempty);
const toReviewRows = ($('Aggregate To Review').first().json.to_review_rows || []).filter(nonempty);
const toApplyRows = ($('Aggregate To Apply').first().json.to_apply_rows || []).filter(nonempty);
const appliedRows = ($('Aggregate Applied Jobs').first().json.applied_rows || []).filter(nonempty);
const archiveRows = ($('Aggregate Archive').first().json.archive_rows || []).filter(nonempty);
const now = states[0]?.window_end || new Date().toISOString();
const reconciliation = reconcileDiscovery(pageResults, {
  'Scraped Jobs': scrapedRows,
  'To Review': toReviewRows,
  'To Apply': toApplyRows,
  'Applied Jobs': appliedRows,
  Archive: archiveRows
}, SCHEMA, now);
const coverage = summarizeCoverage(pageResults, SEARCH_POLICY, KEYWORD_SNAPSHOT);
console.log(JSON.stringify({
  event: 'discovery_run',
  window_start: states[0]?.window_start,
  window_end: states[0]?.window_end,
  coverage_status: coverage.status,
  new_jobs: reconciliation.new_jobs.length,
  rediscovery_updates: reconciliation.active_updates.length,
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
      "Append New Scraped Jobs Rows",
      [2000, 160],
      scraped,
      "append",
      schema.fields
    ),
    codeNode(
      "Emit Scraped Jobs Seen Updates",
      [800, 440],
      `const updates = $('Reconcile Discovery').first().json.active_updates || [];
return updates.filter((record) =>
  record.owner_sheet === 'Scraped Jobs' &&
  Number.isInteger(Number(record.row_number)))
  .map((record) => ({ json: record }));`
    ),
    writeSheet(
      "Update Scraped Jobs Seen",
      [1000, 440],
      scraped,
      "update",
      discoveryUpdateFields,
      ["canonical_job_id"]
    ),
    codeNode(
      "Emit To Review Seen Updates",
      [1200, 520],
      `const updates = $('Reconcile Discovery').first().json.active_updates || [];
return updates.filter((record) =>
  record.owner_sheet === 'To Review' &&
  Number.isInteger(Number(record.row_number)))
  .map((record) => ({ json: record }));`,
      undefined,
      "f3a10000-0000-4000-8000-000000000005"
    ),
    writeSheet(
      "Update To Review Seen",
      [1400, 520],
      toReview,
      "update",
      discoveryUpdateFields,
      ["canonical_job_id"],
      { explicitId: "f3a10000-0000-4000-8000-000000000006" }
    ),
    codeNode(
      "Emit To Apply Seen Updates",
      [1600, 600],
      `const updates = $('Reconcile Discovery').first().json.active_updates || [];
return updates.filter((record) =>
  record.owner_sheet === 'To Apply' &&
  Number.isInteger(Number(record.row_number)))
  .map((record) => ({ json: record }));`,
      undefined,
      "f3a10000-0000-4000-8000-000000000007"
    ),
    writeSheet(
      "Update To Apply Seen",
      [1800, 600],
      toApply,
      "update",
      discoveryUpdateFields,
      ["canonical_job_id"],
      { explicitId: "f3a10000-0000-4000-8000-000000000008" }
    )
  ];
  const connections = {
    "Schedule Trigger": {
      main: [[connection("Get Search Keywords")]]
    },
    "Get Search Keywords": {
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
    "Aggregate Search Pages": { main: [[connection("Get Scraped Jobs")]] },
    "Get Scraped Jobs": { main: [[connection("Aggregate Scraped Jobs")]] },
    "Aggregate Scraped Jobs": { main: [[connection("Get To Review")]] },
    "Get To Review": { main: [[connection("Aggregate To Review")]] },
    "Aggregate To Review": { main: [[connection("Get To Apply")]] },
    "Get To Apply": { main: [[connection("Aggregate To Apply")]] },
    "Aggregate To Apply": { main: [[connection("Get Applied Jobs")]] },
    "Get Applied Jobs": { main: [[connection("Aggregate Applied Jobs")]] },
    "Aggregate Applied Jobs": { main: [[connection("Get Archive")]] },
    "Get Archive": { main: [[connection("Aggregate Archive")]] },
    "Aggregate Archive": { main: [[connection("Reconcile Discovery")]] },
    "Reconcile Discovery": {
      main: [
        [
          connection("Emit Discovery Claims"),
          connection("Emit Scraped Jobs Seen Updates"),
          connection("Emit To Review Seen Updates"),
          connection("Emit To Apply Seen Updates")
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
      main: [[connection("Append New Scraped Jobs Rows")]]
    },
    "Emit Scraped Jobs Seen Updates": {
      main: [[connection("Update Scraped Jobs Seen")]]
    },
    "Emit To Review Seen Updates": {
      main: [[connection("Update To Review Seen")]]
    },
    "Emit To Apply Seen Updates": {
      main: [[connection("Update To Apply Seen")]]
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
      workflowContractVersion: "2026-08-04/v1",
      legacyStateGuardCompatibility: false,
      searchPlanVersion: searchPlan.plan_version,
      runtimeKeywordSource: keywords,
      pipelineSchemaVersion: schema.storage_version,
      windowHours: 24,
      authoritativeBusinessSheets: schema.business_stores,
      discoveryWriteSheet: scraped,
      executionTimeoutSeconds: config.execution_timeout_seconds,
      scheduleOffsetMinutes: config.schedule_offset_minutes
    },
    pinData: {},
    tags: []
  };
}

function buildGenerator() {
  const queue = review.sheets.scraped_jobs.name;
  const system = review.sheets.system.name;
  const config = runtime.generator;
  const nodes = [
    scheduleNode("generator", [-6000, 240], config),
    ...contextSnapshotNodes(
      -5800,
      240,
      "f3ac0000-0000-4000-8000"
    ),
    readSheet("Get Scraped Jobs", [-2000, 240], queue),
    aggregateNode("Aggregate Scraped Jobs", [-1800, 240], "scraped_rows"),
    codeNode(
      "Select Generator Candidates",
      [-1600, 240],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const RUNTIME = ${JSON.stringify(config)};
const now = new Date().toISOString();
const rows = ($input.first().json.scraped_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, SCHEMA, now));
const selected = selectGeneratorCandidate(rows, SCHEMA, RUNTIME, now);
return selected.map(({ record, stage }, selectionIndex) => ({
  json: {
    candidate_record: record,
    candidate_stage: stage,
    selection_index: selectionIndex,
    selected_at: now
  }
}));`
    ),
    loopOverItemsNode("Process Candidates Sequentially", [-1400, 240], 1),
    codeNode(
      "Create Generator System Claim",
      [-1200, 240],
      `${generatorCore}
const RUNTIME = ${JSON.stringify(config)};
const candidate = $json;
const systemClaim = createSystemClaim({
  stage: 'generator',
  canonicalJobId: candidate.candidate_record.canonical_job_id,
  scope: candidate.candidate_stage,
  executionId: String($execution.id),
  now: new Date().toISOString(),
  leaseMs: RUNTIME.claim_lease_ms
});
return { json: {
  ...systemClaim,
  candidate
} };`,
      "runOnceForEachItem"
    ),
    writeSheet(
      "Append Generator System Claim",
      [-1000, 240],
      system,
      "append",
      review.sheets.system.fields,
      [],
      { continueOnError: true }
    ),
    readSheet(
      "Get Generator System Claims",
      [-800, 240],
      system,
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Generator System Claims",
      [-600, 240],
      "system_claims"
    ),
    codeNode(
      "Confirm Generator System Claim",
      [-400, 240],
      `${generatorCore}
const proposed = $('Create Generator System Claim').item.json;
const persisted = ($input.first().json.system_claims || [])
  .filter((row) => row && Object.keys(row).length);
const winners = selectWinningSystemClaims(
  [proposed],
  persisted,
  new Date().toISOString()
);
const won = winners.some((claim) => claim.token === proposed.token);
return { json: {
  system_claim_won: won,
  candidate: proposed.candidate,
  canonical_job_id: proposed.canonical_job_id,
  selection_index: proposed.candidate.selection_index,
  processing_outcome: won ? 'system_claim_won' : 'system_claim_lost'
} };`
    ),
    ifNode(
      "Generator System Claim Won",
      [-200, 240],
      "={{ $json.system_claim_won === true }}"
    ),
    readSheet(
      "Get Scraped Jobs Before Candidate Claim",
      [0, 40],
      queue,
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Scraped Jobs Before Candidate Claim",
      [200, 40],
      "fresh_rows"
    ),
    codeNode(
      "Claim Current Candidate",
      [400, 40],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const RUNTIME = ${JSON.stringify(config)};
const candidate = $('Confirm Generator System Claim').item.json.candidate;
try {
  const matches = ($json.fresh_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA))
    .filter(
      (row) =>
        row.canonical_job_id === candidate.candidate_record.canonical_job_id
    );
  if (matches.length !== 1) {
    throw new Error(
      'Generator claim rejected because Scraped Jobs identity is missing or ambiguous'
    );
  }
  const current = selectGeneratorCandidate(matches, SCHEMA, RUNTIME, new Date().toISOString());
  if (
    current.length !== 1 ||
    current[0].stage !== candidate.candidate_stage
  ) {
    throw new Error(
      'Generator claim rejected because the selected row is no longer eligible in the frozen stage'
    );
  }
  const claim = claimGeneratorRecord(
    current[0].record,
    current[0].stage,
    String($execution.id),
    new Date().toISOString(),
    RUNTIME.claim_lease_ms
  );
  return { json: {
    ...claim.record,
    claim_created: claim.claimed,
    claimed_record: claim.record,
    selection_index: candidate.selection_index,
    provider_requests: 0,
    processing_outcome: claim.claimed ? 'scraped_jobs_claim_created' : 'scraped_jobs_claim_rejected'
  } };
} catch (error) {
  return { json: {
    claim_created: false,
    canonical_job_id: candidate.candidate_record.canonical_job_id,
    selection_index: candidate.selection_index,
    provider_requests: 0,
    processing_outcome: 'scraped_jobs_claim_rejected',
    error_summary: String(error?.message || error).slice(0, 240)
  } };
}`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Scraped Jobs Claim Created",
      [600, 40],
      "={{ $json.claim_created === true }}"
    ),
    writeSheet(
      "Persist Generator Claim",
      [800, -40],
      queue,
      "update",
      generatorClaimFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    readSheet(
      "Get Scraped Jobs After Claim",
      [1000, -40],
      queue,
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Scraped Jobs After Claim",
      [1200, -40],
      "fresh_rows"
    ),
    codeNode(
      "Confirm Generator Claim Persisted",
      [1400, -40],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const CLAIM_FIELDS = ${JSON.stringify(generatorClaimFields)};
const planned = $('Claim Current Candidate').item.json.claimed_record;
const selectionIndex = $('Claim Current Candidate').item.json.selection_index;
try {
  const fresh = ($input.first().json.fresh_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA));
  confirmGeneratorClaimPersisted(planned, fresh, SCHEMA, CLAIM_FIELDS);
  return { json: {
    claim_verified: true,
    claimed_record: planned,
    canonical_job_id: planned.canonical_job_id,
    selection_index: selectionIndex,
    provider_requests: 0,
    processing_outcome: 'scraped_jobs_claim_verified'
  } };
} catch (error) {
  return { json: {
    claim_verified: false,
    canonical_job_id: planned.canonical_job_id,
    selection_index: selectionIndex,
    provider_requests: 0,
    processing_outcome: 'scraped_jobs_claim_unverified',
    error_summary: String(error?.message || error).slice(0, 240)
  } };
}`
    ),
    ifNode(
      "Scraped Jobs Claim Verified",
      [1600, -40],
      "={{ $json.claim_verified === true }}"
    ),
    ifNode(
      "Needs Fresh Job Detail",
      [1800, -80],
      "={{ $json.claimed_record.processing_stage === 'evaluation' }}"
    ),
    httpNode("Fetch Job Detail", [1600, -160], {
      url: "={{ $json.claimed_record.canonical_url }}",
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
      [2000, 40],
      "return { json: $json };",
      "runOnceForEachItem"
    ),
    codeNode(
      "Evaluate and Prepare Application",
      [2200, -80],
      `${generatorCore}
const SHEET_CONTEXT = $('Compile Candidate Context').all()[0].json;
const PROFILE = SHEET_CONTEXT.profile;
const RANKING_POLICY = SHEET_CONTEXT.ranking_policy;
const APPLICATION_POLICY = SHEET_CONTEXT.application_policy;
const PACK_POLICY = SHEET_CONTEXT.pack_policy;
const PROVIDER_POLICY = ${JSON.stringify(groqPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const context = $('Confirm Generator Claim Persisted').item.json;
const claimed = context.claimed_record;
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
    proposed_record: recordSourceFetchFailure(claimed, new Error(errorMessage), RUNTIME, now),
    selection_index: context.selection_index,
    provider_requests: 0
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
    proposed_record: working,
    selection_index: context.selection_index,
    provider_requests: 0
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
    proposed_record: prepared.record,
    selection_index: context.selection_index,
    provider_requests: 0
  } };
} catch (error) {
  return { json: {
    provider_required: false,
    claimed_record: claimed,
    proposed_record: recordGeneratorFailure(working, error, RUNTIME, now),
    selection_index: context.selection_index,
    provider_requests: 0
  } };
}`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Provider Required",
      [2400, -80],
      "={{ $json.provider_required === true }}"
    ),
    ifNode(
      "Needs Provider Pacing Delay",
      [2600, -200],
      "={{ $json.selection_index > 0 }}"
    ),
    waitNode(
      "Wait Before Initial Provider Request",
      [2800, -300],
      groqPolicy.generation.request_interval_ms
    ),
    httpNode("Generate Initial Application with Groq", [3000, -200], {
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
      [3200, -200],
      `${generatorCore}
const SHEET_CONTEXT = $('Compile Candidate Context').all()[0].json;
const PROFILE = SHEET_CONTEXT.profile;
const APPLICATION_POLICY = SHEET_CONTEXT.application_policy;
const PACK_POLICY = SHEET_CONTEXT.pack_policy;
const PROVIDER_POLICY = ${JSON.stringify(groqPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const prepared = $('Evaluate and Prepare Application').item.json;
const providerStatus = Number(
  $json?.error?.status ?? $json?.error?.statusCode ??
  $json?.status ?? $json?.statusCode ?? 0
);
const providerError = externalResultErrorMessage($json);
const errorMessage = providerStatus
  ? String(providerStatus) + ': ' + (providerError || 'Provider request failed')
  : providerError;
const message = $json?.choices?.[0]?.message?.content || $json?.data?.choices?.[0]?.message?.content || '';
try {
  if (errorMessage || !message) {
    throw new Error(
      errorMessage || 'Invalid provider response contained no message'
    );
  }
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
    initial_user_message: prepared.user_message,
    selection_index: prepared.selection_index,
    provider_requests: 1
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
    ),
    selection_index: prepared.selection_index,
    provider_requests: 1
  } };
}
`,
      "runOnceForEachItem"
    ),
    ifNode(
      "Needs One Repair",
      [3400, -200],
      "={{ $json.repair_required === true }}"
    ),
    waitNode(
      "Wait Before Repair",
      [3600, -320],
      groqPolicy.generation.request_interval_ms
    ),
    httpNode("Generate Application Repair with Groq", [3800, -320], {
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
        JSON.stringify(groqPolicy.repair_model) +
        ", temperature: " +
        JSON.stringify(groqPolicy.generation.temperature) +
        ", max_tokens: " +
        JSON.stringify(groqPolicy.generation.maximum_output_tokens) +
        ", reasoning_effort: " +
        JSON.stringify(groqRepairModel.reasoning_effort) +
        ", reasoning_format: " +
        JSON.stringify(groqPolicy.generation.reasoning_format) +
        ", messages: [{ role: 'system', content: $json.repair_system_message }, { role: 'user', content: $json.repair_user_message }] }) }}",
      responseFormat: "json"
    }),
    codeNode(
      "Validate Repaired Draft",
      [4000, -320],
      `${generatorCore}
const SHEET_CONTEXT = $('Compile Candidate Context').all()[0].json;
const PROFILE = SHEET_CONTEXT.profile;
const APPLICATION_POLICY = SHEET_CONTEXT.application_policy;
const PACK_POLICY = SHEET_CONTEXT.pack_policy;
const RUNTIME = ${JSON.stringify(config)};
const staged = $('Validate Initial Draft').item.json;
const providerStatus = Number(
  $json?.error?.status ?? $json?.error?.statusCode ??
  $json?.status ?? $json?.statusCode ?? 0
);
const providerError = externalResultErrorMessage($json);
const errorMessage = providerStatus
  ? String(providerStatus) + ': ' + (providerError || 'Provider request failed')
  : providerError;
const message = $json?.choices?.[0]?.message?.content || $json?.data?.choices?.[0]?.message?.content || '';
let proposed;
try {
  if (errorMessage || !message) {
    throw new Error(
      errorMessage || 'Invalid repair response contained no message'
    );
  }
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
  proposed_record: proposed,
  selection_index: staged.selection_index,
  provider_requests: 2
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Use Valid Initial Draft",
      [3600, -120],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record,
  selection_index: $json.selection_index,
  provider_requests: $json.provider_requests
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Use Non-Provider Result",
      [2600, 40],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record,
  selection_index: $json.selection_index,
  provider_requests: 0
} };`,
      "runOnceForEachItem"
    ),
    codeNode(
      "Stage Generator Result",
      [4200, -80],
      `return { json: {
  claimed_record: $json.claimed_record,
  proposed_record: $json.proposed_record,
  selection_index: $json.selection_index,
  provider_requests: $json.provider_requests
} };`,
      "runOnceForEachItem"
    ),
    readSheet(
      "Get Scraped Jobs Before Commit",
      [4400, -80],
      queue,
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Fresh Scraped Jobs", [4600, -80], "fresh_rows"),
    codeNode(
      "Guard and Commit Generator Result",
      [4800, -80],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const staged = $('Stage Generator Result').item.json;
try {
  const fresh = ($input.first().json.fresh_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA))
    .find((row) => row.canonical_job_id === staged.claimed_record.canonical_job_id);
  if (!fresh) throw new Error('Generator commit could not find claimed Scraped Jobs row');
  const planned = commitGeneratorResult(
    fresh,
    staged.claimed_record,
    staged.proposed_record,
    SCHEMA,
    new Date().toISOString()
  );
  return { json: {
    ...planned,
    commit_allowed: true,
    planned_record: planned,
    selection_index: staged.selection_index,
    provider_requests: staged.provider_requests
  } };
} catch (error) {
  return { json: {
    commit_allowed: false,
    canonical_job_id: staged.claimed_record.canonical_job_id,
    selection_index: staged.selection_index,
    provider_requests: staged.provider_requests,
    processing_outcome: 'commit_rejected',
    error_summary: String(error?.message || error).slice(0, 240)
  } };
}`
    ),
    ifNode(
      "Generator Commit Authorized",
      [5000, -80],
      "={{ $json.commit_allowed === true }}"
    ),
    writeSheet(
      "Update Scraped Jobs Result",
      [5200, -200],
      queue,
      "update",
      reviewMachineFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    readSheet(
      "Get Scraped Jobs After Commit",
      [5400, -200],
      queue,
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Scraped Jobs After Commit",
      [5600, -200],
      "fresh_rows"
    ),
    codeNode(
      "Confirm Generator Result Persisted",
      [5800, -200],
      `${generatorCore}
const SCHEMA = ${JSON.stringify(schema)};
const COMMIT_FIELDS = ${JSON.stringify(reviewMachineFields)};
const staged = $('Guard and Commit Generator Result').item.json;
const planned = staged.planned_record;
try {
  const fresh = ($input.first().json.fresh_rows || [])
    .filter((row) => row && Object.keys(row).length)
    .map((row) => normalizeLegacyRecord(row, SCHEMA));
  const persisted = confirmGeneratorResultPersisted(
    planned,
    fresh,
    SCHEMA,
    COMMIT_FIELDS
  );
  return { json: {
    canonical_job_id: persisted.canonical_job_id,
    pipeline_status: persisted.pipeline_status,
    selection_index: staged.selection_index,
    provider_requests: staged.provider_requests,
    commit_verified: true,
    processing_outcome: 'commit_verified'
  } };
} catch (error) {
  return { json: {
    canonical_job_id: planned.canonical_job_id,
    selection_index: staged.selection_index,
    provider_requests: staged.provider_requests,
    commit_verified: false,
    processing_outcome: 'persistence_unverified',
    error_summary: String(error?.message || error).slice(0, 240)
  } };
}`
    ),
    codeNode(
      "Finalize Candidate",
      [6000, 40],
      `const result = {
  canonical_job_id: String($json.canonical_job_id || $json.claimed_record?.canonical_job_id || ''),
  selection_index: Number.isInteger($json.selection_index) ? $json.selection_index : -1,
  pipeline_status: String($json.pipeline_status || ''),
  provider_requests: Number($json.provider_requests || 0),
  commit_verified: $json.commit_verified === true,
  processing_outcome: String($json.processing_outcome || 'candidate_handled'),
  error_summary: String($json.error_summary || '').slice(0, 240)
};
console.log(JSON.stringify({
  event: 'generator_result',
  canonical_job_id: result.canonical_job_id,
  status: result.pipeline_status || result.processing_outcome,
  provider_requests: result.provider_requests,
  commit_verified: result.commit_verified
}));
return { json: result };`,
      "runOnceForEachItem"
    ),
    waitNode(
      "Wait After Generator Candidate",
      [6200, 40],
      config.candidate_pacing_delay_ms,
      "f3a09999-0000-4000-8000-000000000001"
    ),
    codeNode(
      "Summarize Generator Run",
      [-1200, 520],
      `const results = $input.all().map((item) => item.json);
return { json: {
  selected_count: results.length,
  commit_verified_count: results.filter((result) => result.commit_verified === true).length,
  provider_request_count: results.reduce(
    (total, result) => total + Number(result.provider_requests || 0),
    0
  ),
  results
} };`
    )
  ];
  const connections = {
    "Schedule Trigger": { main: [[connection("Get Candidate Context")]] },
    "Get Scraped Jobs": { main: [[connection("Aggregate Scraped Jobs")]] },
    "Aggregate Scraped Jobs": {
      main: [[connection("Select Generator Candidates")]]
    },
    "Select Generator Candidates": {
      main: [[connection("Process Candidates Sequentially")]]
    },
    "Process Candidates Sequentially": {
      main: [
        [connection("Summarize Generator Run")],
        [connection("Create Generator System Claim")]
      ]
    },
    "Create Generator System Claim": {
      main: [[connection("Append Generator System Claim")]]
    },
    "Append Generator System Claim": {
      main: [[connection("Get Generator System Claims")]]
    },
    "Get Generator System Claims": {
      main: [[connection("Aggregate Generator System Claims")]]
    },
    "Aggregate Generator System Claims": {
      main: [[connection("Confirm Generator System Claim")]]
    },
    "Confirm Generator System Claim": {
      main: [[connection("Generator System Claim Won")]]
    },
    "Generator System Claim Won": {
      main: [
        [connection("Get Scraped Jobs Before Candidate Claim")],
        [connection("Finalize Candidate")]
      ]
    },
    "Get Scraped Jobs Before Candidate Claim": {
      main: [[connection("Aggregate Scraped Jobs Before Candidate Claim")]]
    },
    "Aggregate Scraped Jobs Before Candidate Claim": {
      main: [[connection("Claim Current Candidate")]]
    },
    "Claim Current Candidate": {
      main: [[connection("Scraped Jobs Claim Created")]]
    },
    "Scraped Jobs Claim Created": {
      main: [
        [connection("Persist Generator Claim")],
        [connection("Finalize Candidate")]
      ]
    },
    "Persist Generator Claim": {
      main: [[connection("Get Scraped Jobs After Claim")]]
    },
    "Get Scraped Jobs After Claim": {
      main: [[connection("Aggregate Scraped Jobs After Claim")]]
    },
    "Aggregate Scraped Jobs After Claim": {
      main: [[connection("Confirm Generator Claim Persisted")]]
    },
    "Confirm Generator Claim Persisted": {
      main: [[connection("Scraped Jobs Claim Verified")]]
    },
    "Scraped Jobs Claim Verified": {
      main: [
        [connection("Needs Fresh Job Detail")],
        [connection("Finalize Candidate")]
      ]
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
        [connection("Needs Provider Pacing Delay")],
        [connection("Use Non-Provider Result")]
      ]
    },
    "Needs Provider Pacing Delay": {
      main: [
        [connection("Wait Before Initial Provider Request")],
        [connection("Generate Initial Application with Groq")]
      ]
    },
    "Wait Before Initial Provider Request": {
      main: [[connection("Generate Initial Application with Groq")]]
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
      main: [[connection("Get Scraped Jobs Before Commit")]]
    },
    "Get Scraped Jobs Before Commit": {
      main: [[connection("Aggregate Fresh Scraped Jobs")]]
    },
    "Aggregate Fresh Scraped Jobs": {
      main: [[connection("Guard and Commit Generator Result")]]
    },
    "Guard and Commit Generator Result": {
      main: [[connection("Generator Commit Authorized")]]
    },
    "Generator Commit Authorized": {
      main: [
        [connection("Update Scraped Jobs Result")],
        [connection("Finalize Candidate")]
      ]
    },
    "Update Scraped Jobs Result": {
      main: [[connection("Get Scraped Jobs After Commit")]]
    },
    "Get Scraped Jobs After Commit": {
      main: [[connection("Aggregate Scraped Jobs After Commit")]]
    },
    "Aggregate Scraped Jobs After Commit": {
      main: [[connection("Confirm Generator Result Persisted")]]
    },
    "Confirm Generator Result Persisted": {
      main: [[connection("Finalize Candidate")]]
    },
    "Finalize Candidate": {
      main: [[connection("Wait After Generator Candidate")]]
    },
    "Wait After Generator Candidate": {
      main: [[connection("Process Candidates Sequentially")]]
    }
  };
  connectContextSnapshot(connections, "Get Scraped Jobs");
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
      workflowContractVersion: "2026-08-04/v1",
      legacyStateGuardCompatibility: false,
      pipelineSchemaVersion: schema.storage_version,
      candidateProfileSource: "Candidate, Skills, Experience, Projects, Education, Awards",
      preferenceSource: "Job Preferences, Application Settings, Required Style, Banned Phrases",
      applicationPackPolicyVersion: packPolicy.policy_version,
      groqProviderPolicyVersion: groqPolicy.policy_version,
      processingSourceSheet: queue,
      manualSubmissionOnly: true,
      maximumModelRequestsPerItem:
        groqPolicy.generation.maximum_requests_per_item,
      maximumItemsPerExecution: config.per_run_cap,
      sequentialBatchSize: 1,
      candidatePacingDelayMs: config.candidate_pacing_delay_ms,
      initialModel: groqPolicy.selected_model,
      repairModel: groqPolicy.repair_model,
      boundedRepairEnabled: true,
      executionTimeoutSeconds: config.execution_timeout_seconds,
      scheduleOffsetMinutes: config.schedule_offset_minutes
    },
    pinData: {},
    tags: []
  };
}

function buildAlerterMover() {
  const scraped = review.sheets.scraped_jobs.name;
  const toReview = review.sheets.to_review.name;
  const toApply = review.sheets.to_apply.name;
  const applied = review.sheets.applied_jobs.name;
  const archive = review.sheets.archive.name;
  const system = review.sheets.system.name;
  const config = runtime.alerter_mover;
  const businessDefinitions = schema.business_stores.map((name) => ({
    name,
    fields: schema.fields
  }));
  const alertContextDefinitions = contextSources.map(([, sheetKey]) => ({
    name: review.sheets[sheetKey].name,
    fields: review.sheets[sheetKey].fields
  }));
  const nodes = [
    scheduleNode("alerter_mover", [-6000, 240], config),
    codeNode(
      "Capture Alerter Execution Start",
      [-5900, 240],
      `return [{ json: { execution_started_at: new Date().toISOString() } }];`
    ),
    batchReadSheets(
      "Get Business Snapshot",
      [-5800, 240],
      schema.business_stores,
      { retry: null, continueOnError: true }
    ),
    ifNode(
      "Business Snapshot Quota Limited",
      [-5700, 240],
      "={{ Number($json?.error?.statusCode || $json?.error?.status || $json?.statusCode || $json?.status || 0) === 429 }}"
    ),
    {
      parameters: {
        resume: "timeInterval",
        amount: config.google_sheets_read_retry.quota_window_delay_ms / 1000,
        unit: "seconds"
      },
      type: "n8n-nodes-base.wait",
      typeVersion: 1.1,
      position: [-5600, 120],
      id: id(),
      name: "Wait for Sheets Quota Window"
    },
    batchReadSheets(
      "Retry Business Snapshot",
      [-5500, 120],
      schema.business_stores,
      { retry: null, continueOnError: false }
    ),
    codeNode(
      "Normalize Business Snapshot",
      [-5300, 240],
      `${sheetBatchCore}
${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const DEFINITIONS = ${JSON.stringify(businessDefinitions)};
const now = new Date().toISOString();
let quotaRetryCount = 0;
try {
  quotaRetryCount = $('Retry Business Snapshot').all().length > 0 ? 1 : 0;
} catch {}
const rawStores = parseBatchSheetRows($json, DEFINITIONS);
const stores = Object.fromEntries(
  SCHEMA.business_stores.map((store) => [
    store,
    rawStores[store].map((row) => normalizeLegacyRecord(row, SCHEMA, now))
  ])
);
return [{ json: {
  stores,
  now,
  execution_started_at: $('Capture Alerter Execution Start').first().json.execution_started_at,
  sheet_read_request_count: 1,
  quota_retry_count: quotaRetryCount
} }];`
    ),
    alertReceiptDataTableNode(
      "Get Receipt Recovery Snapshot",
      [-5520, 40],
      "get"
    ),
    codeNode(
      "Plan Expired Sending Receipts",
      [-5360, 40],
      `${alertReceiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const snapshot = $('Normalize Business Snapshot').first().json;
const raw = $input.all().map((item) => item.json || {});
const nonRows = raw.filter((row) => !row.receipt_id && Object.keys(row).length > 0);
const rows = raw.filter((row) => row.receipt_id);
const errors = [];
const receipts = [];
const identities = new Set();
if (nonRows.length) errors.push('receipt_store_read_failed');
for (const row of rows) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    const validation = validateAlertReceipt(receipt, POLICY);
    if (validation.length) throw new Error('invalid receipt');
    if (identities.has(receipt.receipt_id)) throw new Error('duplicate receipt identity');
    identities.add(receipt.receipt_id);
    receipts.push(receipt);
  } catch (error) {
    errors.push('receipt_store_invalid');
  }
}
const nowMs = Date.parse(snapshot.now);
const transitions = [];
const providerOutcomes = [];
let activeSending = 0;
if (!errors.length) {
  for (const receipt of receipts) {
    if (receipt.status === 'sending') {
      const started = Date.parse(receipt.attempt_started_at || '');
      if (!Number.isFinite(started) || nowMs - started >= RUNTIME.claim_lease_ms) {
        try {
          const next = transitionAlertReceipt(receipt, {
            expectedVersion: receipt.receipt_version,
            status: 'terminal_ambiguity',
            providerStatus: 0,
            errorCategory: 'ambiguous_delivery',
            now: snapshot.now
          }, POLICY);
          transitions.push({ ...alertReceiptPersistenceRow(next, POLICY), expected_receipt_version: receipt.receipt_version });
        } catch (error) {
          errors.push('receipt_recovery_transition_invalid');
        }
      } else {
        activeSending += 1;
      }
    } else if (['delivered', 'retryable_rejection', 'terminal_rejection', 'terminal_ambiguity'].includes(receipt.status)) {
      providerOutcomes.push(receipt);
    }
  }
}
return [{ json: {
  transitions,
  provider_outcomes: providerOutcomes,
  active_sending: activeSending,
  receipt_store_available: errors.length === 0,
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare Expired Sending Receipt Transitions",
      [-5200, 40],
      `const rows = $('Plan Expired Sending Receipts').first().json.transitions || [];
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Expired Sending Receipt Transitions",
      [-5040, 40],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Expired Sending Receipts",
      [-4880, -80],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter(
            "receipt_version",
            "={{ $json.expected_receipt_version }}"
          )
        ]
      }
    ),
    aggregateNode(
      "Aggregate Expired Sending Receipt Transitions",
      [-4720, -80],
      "writes"
    ),
    alertReceiptDataTableNode(
      "Verify Receipt Recovery Transitions",
      [-4560, 40],
      "get"
    ),
    codeNode(
      "Plan Receipt Business Recovery",
      [-4400, 40],
      `${alertReceiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const SCHEMA = ${JSON.stringify(schema)};
const snapshot = $('Normalize Business Snapshot').first().json;
const preliminary = $('Plan Expired Sending Receipts').first().json;
const raw = $input.all().map((item) => item.json || {});
const rows = raw.filter((row) => row.receipt_id);
const byId = new Map();
const errors = [...(preliminary.error_categories || [])];
for (const row of rows) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    const validation = validateAlertReceipt(receipt, POLICY);
    if (validation.length || byId.has(receipt.receipt_id)) throw new Error('invalid receipt snapshot');
    byId.set(receipt.receipt_id, receipt);
  } catch (error) {
    errors.push('receipt_store_invalid');
  }
}
const verifiedExpired = [];
for (const expected of preliminary.transitions || []) {
  const actual = byId.get(expected.receipt_id);
  if (actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(expected[field] ?? ''))) {
    verifiedExpired.push(actual);
  } else {
    errors.push('receipt_recovery_transition_unconfirmed');
  }
}
const outcomes = [...(preliminary.provider_outcomes || []), ...verifiedExpired];
const plans = [];
const ownerIdentities = new Set();
if (!errors.length) {
  for (const receipt of outcomes) {
    try {
      const plan = planAlertReceiptBusinessReconciliation(receipt, snapshot.stores, SCHEMA, POLICY, snapshot.now);
      if (plan.owner_store && plan.business_update) {
        const ownerKey = receipt.canonical_job_id.toLocaleLowerCase('en-US');
        if (ownerIdentities.has(ownerKey)) throw new Error('duplicate recovery owner');
        ownerIdentities.add(ownerKey);
      }
      plans.push({ receipt, ...plan });
    } catch (error) {
      errors.push('receipt_business_recovery_blocked');
    }
  }
}
const updates = plans.filter((plan) => plan.business_update);
return [{ json: {
  plans,
  updates,
  touched_stores: [...new Set(updates.map((plan) => plan.owner_store))],
  receipt_store_available: preliminary.receipt_store_available && errors.length === 0,
  skip_new_alerts: outcomes.length > 0 || preliminary.active_sending > 0 || errors.length > 0,
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare Recovery To Apply Updates",
      [-4240, 40],
      `const rows = ($('Plan Receipt Business Recovery').first().json.updates || [])
  .filter((plan) => plan.owner_store === 'To Apply')
  .map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Recovery To Apply Updates",
      [-4080, 40],
      "={{ $json._noop !== true }}"
    ),
    writeSheet(
      "Persist Recovery To Apply Updates",
      [-3920, -80],
      toApply,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Recovery To Apply Updates",
      [-3760, -80],
      "writes"
    ),
    codeNode(
      "Prepare Recovery Applied Updates",
      [-3600, 40],
      `const rows = ($('Plan Receipt Business Recovery').first().json.updates || [])
  .filter((plan) => plan.owner_store === 'Applied Jobs')
  .map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Recovery Applied Updates",
      [-3440, 40],
      "={{ $json._noop !== true }}"
    ),
    writeSheet(
      "Persist Recovery Applied Updates",
      [-3280, -80],
      applied,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Recovery Applied Updates",
      [-3120, -80],
      "writes"
    ),
    codeNode(
      "Prepare Recovery Archive Updates",
      [-2960, 40],
      `const rows = ($('Plan Receipt Business Recovery').first().json.updates || [])
  .filter((plan) => plan.owner_store === 'Archive')
  .map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Recovery Archive Updates",
      [-2800, 40],
      "={{ $json._noop !== true }}"
    ),
    writeSheet(
      "Persist Recovery Archive Updates",
      [-2640, -80],
      archive,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode(
      "Aggregate Recovery Archive Updates",
      [-2480, -80],
      "writes"
    ),
    ifNode(
      "Has Recovery Business Updates",
      [-2320, 40],
      "={{ $('Plan Receipt Business Recovery').first().json.updates.length > 0 }}"
    ),
    batchReadSheets(
      "Get Recovery Business Confirmation",
      [-2160, -80],
      [toApply, applied, archive],
      {
        retry: null,
        continueOnError: true,
        urlExpression: `={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $env.${QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE} + '/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&' + $('Plan Receipt Business Recovery').first().json.touched_stores.map((sheet) => 'ranges=' + encodeURIComponent("'" + sheet.replace(/'/g, "''") + "'")).join('&') }}`
      }
    ),
    codeNode(
      "Confirm Receipt Business Recovery",
      [-2000, -80],
      `${sheetBatchCore}
${alertReceiptCore}
const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const ALERT_STATE_FIELDS = ${JSON.stringify(alertStateFields)};
const snapshot = $('Normalize Business Snapshot').first().json;
const recovery = $('Plan Receipt Business Recovery').first().json;
if (!Array.isArray($json.valueRanges)) {
  return [{ json: {
    stores: snapshot.stores,
    confirmed: (recovery.plans || []).filter((plan) => !plan.business_update),
    error_categories: [...new Set([...(recovery.error_categories || []), 'receipt_business_confirmation_read_failed'])],
    sheet_read_request_count: Number(snapshot.sheet_read_request_count || 1) + 1,
    quota_retry_count: Number(snapshot.quota_retry_count || 0)
  } }];
}
const definitions = ${JSON.stringify(businessDefinitions)}.filter((entry) => recovery.touched_stores.includes(entry.name));
const parsed = parseBatchSheetRows($json, definitions);
const stores = { ...snapshot.stores };
for (const definition of definitions) {
  stores[definition.name] = parsed[definition.name].map((row) => normalizeLegacyRecord(row, SCHEMA, snapshot.now));
}
const confirmed = [];
const errors = [...(recovery.error_categories || [])];
for (const plan of recovery.plans || []) {
  if (!plan.business_update) {
    confirmed.push(plan);
    continue;
  }
  const matches = (stores[plan.owner_store] || []).filter((row) => row.canonical_job_id === plan.business_update.canonical_job_id);
  if (matches.length === 1 && ALERT_STATE_FIELDS.every((field) => String(matches[0][field] ?? '') === String(plan.business_update[field] ?? ''))) {
    confirmed.push(plan);
  } else {
    errors.push('receipt_business_recovery_unconfirmed');
  }
}
return [{ json: {
  stores,
  confirmed,
  error_categories: [...new Set(errors)],
  sheet_read_request_count: Number(snapshot.sheet_read_request_count || 1) + 1,
  quota_retry_count: Number(snapshot.quota_retry_count || 0)
} }];`
    ),
    codeNode(
      "Use Unchanged Recovery Snapshot",
      [-2000, 120],
      `const snapshot = $('Normalize Business Snapshot').first().json;
const recovery = $('Plan Receipt Business Recovery').first().json;
return [{ json: {
  stores: snapshot.stores,
  confirmed: recovery.plans || [],
  error_categories: recovery.error_categories || [],
  sheet_read_request_count: snapshot.sheet_read_request_count,
  quota_retry_count: snapshot.quota_retry_count
} }];`
    ),
    codeNode(
      "Prepare Delivered Receipt Reconciliation",
      [-1840, 40],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const rows = ($json.confirmed || []).flatMap((plan) => {
  if (!plan.receipt_update) return [];
  return [{
    ...alertReceiptPersistenceRow(plan.receipt_update, POLICY),
    expected_receipt_version: plan.receipt.receipt_version
  }];
});
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Delivered Receipt Reconciliation",
      [-1680, 40],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Delivered Receipt Reconciliation",
      [-1520, -80],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode(
      "Aggregate Delivered Receipt Reconciliation",
      [-1360, -80],
      "writes"
    ),
    alertReceiptDataTableNode(
      "Verify Delivered Receipt Reconciliation",
      [-1200, 40],
      "get"
    ),
    codeNode(
      "Finalize Receipt Recovery",
      [-1040, 40],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const base = (() => {
  try { return $('Confirm Receipt Business Recovery').first().json; }
  catch { return $('Use Unchanged Recovery Snapshot').first().json; }
})();
const preliminary = $('Plan Expired Sending Receipts').first().json;
const recovery = $('Plan Receipt Business Recovery').first().json;
const expected = (() => {
  try {
    return $('Prepare Delivered Receipt Reconciliation').all().map((item) => item.json).filter((row) => row._noop !== true);
  } catch { return []; }
})();
const actualRows = $input.all().map((item) => item.json || {}).filter((row) => row.receipt_id);
const errors = [...(base.error_categories || [])];
if (expected.length) {
  const byId = new Map();
  for (const row of actualRows) {
    try {
      const receipt = normalizeAlertReceipt(row, POLICY);
      if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
      byId.set(receipt.receipt_id, receipt);
    } catch { errors.push('receipt_reconciliation_verification_failed'); }
  }
  for (const wanted of expected) {
    const actual = byId.get(wanted.receipt_id);
    if (!actual || !ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(wanted[field] ?? ''))) {
      errors.push('receipt_reconciliation_unconfirmed');
    }
  }
}
return [{ json: {
  ...base,
  now: $('Normalize Business Snapshot').first().json.now,
  execution_started_at: $('Normalize Business Snapshot').first().json.execution_started_at,
  receipt_store_available: recovery.receipt_store_available && errors.length === 0,
  skip_new_alerts: recovery.skip_new_alerts,
  recovery_counts: {
    examined: (recovery.plans || []).length,
    delivered: (recovery.plans || []).filter((plan) => plan.receipt?.status === 'delivered').length,
    reconciled: expected.length,
    retryable: (recovery.plans || []).filter((plan) => plan.receipt?.status === 'retryable_rejection').length,
    terminal: (recovery.plans || []).filter((plan) => ['terminal_rejection', 'terminal_ambiguity'].includes(plan.receipt?.status)).length
  },
  provider_classifications: [...new Set((recovery.plans || []).map((plan) => plan.receipt?.provider_classification).filter(Boolean))],
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Plan Independent Moves",
      [-5400, 240],
      `${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(alertPolicy)};
const RUNTIME = ${JSON.stringify(config)};
const snapshot = $('Finalize Receipt Recovery').first().json;
const plan = planAlerterMoverPhases(
  snapshot.stores,
  SCHEMA,
  POLICY,
  snapshot.now,
  { movementPerRunCap: RUNTIME.movement_per_run_cap }
);
console.log(JSON.stringify({
  event: 'movement_plan',
  moves: plan.movement.moves.length,
  rejected: plan.movement.rejected.map((entry) => entry.reason),
  outcome_updates: plan.outcome.updates.length,
  potential_alerts: plan.potential_alerts.candidates.length,
  sheet_read_requests: snapshot.sheet_read_request_count
}));
return [{ json: {
  ...plan,
  stores: snapshot.stores,
  now: snapshot.now,
  execution_started_at: snapshot.execution_started_at,
  receipt_store_available: snapshot.receipt_store_available,
  skip_new_alerts: snapshot.skip_new_alerts,
  recovery_counts: snapshot.recovery_counts,
  provider_classifications: snapshot.provider_classifications,
  error_categories: snapshot.error_categories,
  sheet_read_request_count: snapshot.sheet_read_request_count,
  quota_retry_count: snapshot.quota_retry_count
} }];`
    ),
    ifNode(
      "Has Eligible Work",
      [-5200, 240],
      "={{ $json.has_work === true }}"
    ),
    codeNode(
      "Summarize Alerter & Mover Run",
      [-5000, 520],
      `${alertCore}
const plan = $('Plan Independent Moves').first().json;
const current = $json || {};
const all = (name) => {
  try { return $(name).all().map((item) => item.json || {}); }
  catch { return []; }
};
const first = (name) => all(name)[0] || {};
const ran = (name) => all(name).length > 0;
const finalDelivery = first('Finalize Alert Delivery Results');
const recovery = plan.recovery_counts || {};
const currentAlerts = finalDelivery.alerts || current.alerts || {};
const alerts = {
  selected: Number(currentAlerts.selected || 0),
  delivered: Number(currentAlerts.delivered || 0) + Number(recovery.delivered || 0),
  reconciled: Number(currentAlerts.reconciled || 0) + Number(recovery.reconciled || 0),
  retryable: Number(currentAlerts.retryable || 0) + Number(recovery.retryable || 0),
  terminal: Number(currentAlerts.terminal || 0) + Number(recovery.terminal || 0)
};
const readNodes = [
  'Get Business Snapshot',
  'Get Recovery Business Confirmation',
  'Get System Claims',
  'Get Main Workbook Layout',
  'Get Touched Business Stores After Copies',
  'Get Fresh To Apply Snapshot',
  'Get Alert Configuration Snapshot',
  'Get Alert System Claims',
  'Get To Apply After Alert Claims',
  'Get Alert Owners After Provider',
  'Get Provider Business Confirmation'
];
const observations = [
  current,
  plan,
  first('Evaluate Provider Commit Headroom'),
  first('Authorize Pending Alert Receipts'),
  first('Verify Pending Alert Receipts'),
  first('Verify Sending Alert Receipts'),
  first('Recheck Provider Commit Headroom'),
  first('Finalize Provider Receipt Outcomes'),
  first('Plan Provider Business Reconciliation'),
  finalDelivery
];
const errors = observations.flatMap((entry) => Array.isArray(entry.error_categories) ? entry.error_categories : []);
const providerClassifications = [
  ...(plan.provider_classifications || []),
  ...(finalDelivery.provider_classifications || current.provider_classifications || [])
];
const summary = summarizeAlerterMoverRun({
  plan,
  sheetReadRequests: readNodes.filter(ran).length,
  quotaRetries: Math.max(0, ...observations.map((entry) => Number(entry.quota_retry_count || 0))),
  alerts,
  errorCategories: errors,
  providerClassifications
});
console.log(JSON.stringify({ event: 'alerter_mover_summary', ...summary }));
return [{ json: summary }];`
    ),
    codeNode(
      "Prepare Outcome Updates",
      [-5000, 240],
      `const rows = $('Plan Independent Moves').first().json.outcome.updates || [];
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Outcome Updates", [-4800, 240], "={{ $json._noop !== true }}"),
    writeSheet(
      "Update Applied Outcomes",
      [-4600, 120],
      applied,
      "update",
      outcomeStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    ifNode(
      "Has Movement Work",
      [-4400, 240],
      "={{ $('Plan Independent Moves').first().json.has_movement_work === true }}"
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
    scope: movementPlan.claim_scope,
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
    readSheet("Get System Claims", [800, 240], system, {
      retry: null
    }),
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
      "Prepare Scraped Jobs Writes",
      [1300, 360],
      `${movementCore}
const writes = destinationWrites(
  $('Keep Winning Movement Claims').first().json.movement
);
return writes.scraped_jobs.length
  ? writes.scraped_jobs.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`,
      undefined,
      "f3a20000-0000-4000-8000-000000000005"
    ),
    ifNode(
      "Has Scraped Jobs Writes",
      [1400, 360],
      "={{ $json._noop !== true }}",
      "f3a20000-0000-4000-8000-000000000006"
    ),
    writeSheet(
      "Upsert Scraped Jobs",
      [1500, 360],
      scraped,
      "appendOrUpdate",
      schema.fields,
      ["canonical_job_id"],
      {
        continueOnError: true,
        explicitId: "f3a20000-0000-4000-8000-000000000007"
      }
    ),
    aggregateNode(
      "Aggregate Scraped Jobs Writes",
      [1600, 360],
      "scraped_writes",
      "f3a20000-0000-4000-8000-000000000008"
    ),
    codeNode(
      "Prepare To Review Writes",
      [1650, 420],
      `${movementCore}
const writes = destinationWrites(
  $('Keep Winning Movement Claims').first().json.movement
);
return writes.to_review.length
  ? writes.to_review.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`,
      undefined,
      "f3a20000-0000-4000-8000-000000000009"
    ),
    ifNode(
      "Has To Review Writes",
      [1750, 420],
      "={{ $json._noop !== true }}",
      "f3a20000-0000-4000-8000-000000000010"
    ),
    writeSheet(
      "Upsert To Review",
      [1850, 420],
      toReview,
      "appendOrUpdate",
      schema.fields,
      ["canonical_job_id"],
      {
        continueOnError: true,
        explicitId: "f3a20000-0000-4000-8000-000000000011"
      }
    ),
    aggregateNode(
      "Aggregate To Review Writes",
      [1950, 420],
      "to_review_writes",
      "f3a20000-0000-4000-8000-000000000012"
    ),
    codeNode(
      "Prepare To Apply Writes",
      [2000, 480],
      `${movementCore}
const writes = destinationWrites(
  $('Keep Winning Movement Claims').first().json.movement
);
return writes.to_apply.length
  ? writes.to_apply.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`,
      undefined,
      "f3a20000-0000-4000-8000-000000000013"
    ),
    ifNode(
      "Has To Apply Writes",
      [2100, 480],
      "={{ $json._noop !== true }}",
      "f3a20000-0000-4000-8000-000000000014"
    ),
    writeSheet(
      "Upsert To Apply",
      [2200, 480],
      toApply,
      "appendOrUpdate",
      schema.fields,
      ["canonical_job_id"],
      {
        continueOnError: true,
        explicitId: "f3a20000-0000-4000-8000-000000000015"
      }
    ),
    aggregateNode(
      "Aggregate To Apply Writes",
      [2300, 480],
      "to_apply_writes",
      "f3a20000-0000-4000-8000-000000000016"
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
    httpNode("Get Main Workbook Layout", [2900, 360], {
      url: `=https://sheets.googleapis.com/v4/spreadsheets/{{$env.${QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE}}}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`,
      timeout: 10000,
      responseFormat: "json",
      retry: null,
      continueOnError: false,
      credentialType: "googleSheetsOAuth2Api"
    }),
    codeNode(
      "Prepare Latest-First Sort",
      [3100, 360],
      `${sheetOrderCore}
const requests = latestFirstSortRequests(
  $json,
  ${JSON.stringify(schema)},
  Object.fromEntries(
    Object.entries(${JSON.stringify(latestFirstBusinessSheets)})
      .filter(([sheet]) => $('Plan Independent Moves').first().json.touched_sheets.includes(sheet))
  )
);
return [{ json: { requests } }];`
    ),
    httpNode("Sort Business Sheets Latest First", [3300, 360], {
      url: `=https://sheets.googleapis.com/v4/spreadsheets/{{$env.${QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE}}}:batchUpdate`,
      method: "POST",
      timeout: 10000,
      jsonBody: "={{ JSON.stringify($json) }}",
      responseFormat: "json",
      continueOnError: false,
      credentialType: "googleSheetsOAuth2Api"
    }),
    batchReadSheets(
      "Get Touched Business Stores After Copies",
      [3500, 360],
      schema.business_stores,
      {
        retry: null,
        urlExpression: `={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $env.${QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE} + '/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&' + $('Plan Independent Moves').first().json.touched_sheets.map((sheet) => 'ranges=' + encodeURIComponent("'" + sheet.replace(/'/g, "''") + "'")).join('&') }}`
      }
    ),
    codeNode(
      "Normalize Touched Business Snapshot",
      [3700, 360],
      `${sheetBatchCore}
${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const allDefinitions = ${JSON.stringify(businessDefinitions)};
const plan = $('Plan Independent Moves').first().json;
const definitions = allDefinitions.filter((entry) => plan.touched_sheets.includes(entry.name));
const touched = parseBatchSheetRows($json, definitions);
const stores = { ...plan.stores };
for (const definition of definitions) {
  stores[definition.name] = touched[definition.name]
    .map((row) => normalizeLegacyRecord(row, SCHEMA, plan.now));
}
return [{ json: {
  stores,
  sheet_read_request_count: Number(plan.sheet_read_request_count || 1) + 3,
  quota_retry_count: Number(plan.quota_retry_count || 0)
} }];`
    ),
    codeNode(
      "Confirm Destination Copies",
      [4200, 240],
      `${movementCore}
const SCHEMA = ${JSON.stringify(schema)};
const plans = $('Keep Winning Movement Claims').first().json.movement;
const result = confirmMoveDeletions(
  plans,
  $('Normalize Touched Business Snapshot').first().json.stores,
  SCHEMA
);
console.log(JSON.stringify({
  event: 'movement_confirmation',
  confirmed: result.deletions.length,
  rejected: result.rejected.map((entry) => entry.reason)
}));
return [{ json: {
  ...result,
  sheet_read_request_count: $('Normalize Touched Business Snapshot').first().json.sheet_read_request_count,
  quota_retry_count: $('Normalize Touched Business Snapshot').first().json.quota_retry_count
} }];`
    ),
    codeNode(
      "Prepare Scraped Jobs Deletions",
      [4400, 240],
      `const rows = $('Confirm Destination Copies').first().json.deletions || [];
const selected = rows.filter((row) => row.source_sheet === 'Scraped Jobs');
return selected.length
  ? selected.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Scraped Jobs Deletions",
      [4600, 240],
      "={{ $json._noop !== true }}"
    ),
    deleteRowsNode(
      "Delete Confirmed Scraped Jobs Rows",
      [4800, 120],
      scraped,
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Scraped Deletion Attempts", [5000, 240], "deletions"),
    codeNode(
      "Prepare To Review Deletions",
      [5050, 320],
      `const rows = $('Confirm Destination Copies').first().json.deletions || [];
const selected = rows.filter((row) => row.source_sheet === 'To Review');
return selected.length
  ? selected.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`,
      undefined,
      "f3a20000-0000-4000-8000-000000000021"
    ),
    ifNode(
      "Has To Review Deletions",
      [5100, 320],
      "={{ $json._noop !== true }}",
      "f3a20000-0000-4000-8000-000000000022"
    ),
    deleteRowsNode(
      "Delete Confirmed To Review Rows",
      [5150, 200],
      toReview,
      {
        continueOnError: true,
        explicitId: "f3a20000-0000-4000-8000-000000000023"
      }
    ),
    aggregateNode(
      "Aggregate To Review Deletion Attempts",
      [5200, 320],
      "deletions",
      "f3a20000-0000-4000-8000-000000000024"
    ),
    codeNode(
      "Prepare To Apply Deletions",
      [5250, 400],
      `const rows = $('Confirm Destination Copies').first().json.deletions || [];
const selected = rows.filter((row) => row.source_sheet === 'To Apply');
return selected.length
  ? selected.map((row) => ({ json: row }))
  : [{ json: { _noop: true } }];`,
      undefined,
      "f3a20000-0000-4000-8000-000000000025"
    ),
    ifNode(
      "Has To Apply Deletions",
      [5300, 400],
      "={{ $json._noop !== true }}",
      "f3a20000-0000-4000-8000-000000000026"
    ),
    deleteRowsNode(
      "Delete Confirmed To Apply Rows",
      [5350, 280],
      toApply,
      {
        continueOnError: true,
        explicitId: "f3a20000-0000-4000-8000-000000000027"
      }
    ),
    aggregateNode(
      "Aggregate To Apply Deletion Attempts",
      [5400, 400],
      "deletions",
      "f3a20000-0000-4000-8000-000000000028"
    ),
    codeNode(
      "Prepare Post-Movement Alert Snapshot",
      [5500, 400],
      `const plan = $('Plan Independent Moves').first().json;
return [{ json: {
  needs_fresh_to_apply: plan.touched_sheets.includes('To Apply'),
  sheet_read_request_count: Number($json.sheet_read_request_count || 4),
  quota_retry_count: Number($json.quota_retry_count || 0)
} }];`
    ),
    ifNode(
      "Needs Fresh To Apply Snapshot",
      [5700, 400],
      "={{ $json.needs_fresh_to_apply === true }}"
    ),
    batchReadSheets(
      "Get Fresh To Apply Snapshot",
      [5900, 300],
      [toApply],
      { retry: null }
    ),
    codeNode(
      "Normalize Fresh To Apply Snapshot",
      [6100, 300],
      `${sheetBatchCore}
${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const plan = $('Plan Independent Moves').first().json;
const parsed = parseBatchSheetRows($json, ${JSON.stringify([
        { name: toApply, fields: schema.fields }
      ])});
return [{ json: {
  to_apply_rows: parsed['To Apply'].map((row) => normalizeLegacyRecord(row, SCHEMA, plan.now)),
  sheet_read_request_count: Number($('Prepare Post-Movement Alert Snapshot').first().json.sheet_read_request_count || 4) + 1,
  quota_retry_count: Number($('Prepare Post-Movement Alert Snapshot').first().json.quota_retry_count || 0)
} }];`
    ),
    codeNode(
      "Use Initial To Apply Snapshot",
      [5900, 500],
      `const plan = $('Plan Independent Moves').first().json;
return [{ json: {
  to_apply_rows: plan.stores['To Apply'] || [],
  sheet_read_request_count: Number($json.sheet_read_request_count || plan.sheet_read_request_count || 1),
  quota_retry_count: Number($json.quota_retry_count || plan.quota_retry_count || 0)
} }];`
    ),
    codeNode(
      "Preselect Persisted Alert Work",
      [6300, 400],
      `${alertCore}
const selected = preselectPersistedAlertCandidates(
  $json.to_apply_rows || [],
  ${JSON.stringify(schema)},
  ${JSON.stringify(alertPolicy)},
  new Date().toISOString()
);
const plan = $('Plan Independent Moves').first().json;
const providerBlocked = plan.skip_new_alerts === true || plan.receipt_store_available !== true;
return [{ json: {
  ...$json,
  potential_alerts: selected,
  has_potential_alerts: selected.candidates.length > 0 && !providerBlocked,
  provider_blocked: providerBlocked,
  error_categories: plan.error_categories || []
} }];`
    ),
    ifNode(
      "Has Potential Alert Work",
      [6500, 400],
      "={{ $json.has_potential_alerts === true }}"
    ),
    batchReadSheets(
      "Get Alert Configuration Snapshot",
      [6700, 300],
      contextSources.map(([, sheetKey]) => review.sheets[sheetKey].name),
      {
        workbookEnvironmentVariable: CONFIG_WORKBOOK_ENVIRONMENT_VARIABLE,
        retry: null
      }
    ),
    codeNode(
      "Compile Alert Configuration",
      [6900, 300],
      `${sheetBatchCore}
${sheetContextCore}
const parsed = parseBatchSheetRows($json, ${JSON.stringify(alertContextDefinitions)});
const rows = {
${contextSources.map(([property, , label]) => `  ${property}: parsed[${JSON.stringify(label)}] || []`).join(",\n")}
};
const context = compileSheetContext(rows, {
  rankingPolicy: ${JSON.stringify(rankingPolicy)},
  applicationPolicy: ${JSON.stringify(applicationPolicy)},
  packPolicy: ${JSON.stringify(packPolicy)}
});
const preselection = $('Preselect Persisted Alert Work').first().json;
return [{ json: {
  context,
  to_apply_rows: preselection.to_apply_rows,
  sheet_read_request_count: Number(preselection.sheet_read_request_count || 1) + 1,
  quota_retry_count: Number(preselection.quota_retry_count || 0)
} }];`
    ),
    codeNode(
      "Select Fresh Alerts",
      [7100, 300],
      `${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(alertPolicy)};
const SHEET_CONTEXT = $('Compile Alert Configuration').first().json.context;
const PROFILE = SHEET_CONTEXT.profile;
const APPLICATION_POLICY = SHEET_CONTEXT.application_policy;
const PACK_POLICY = SHEET_CONTEXT.pack_policy;
const rows = $('Compile Alert Configuration').first().json.to_apply_rows || [];
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
return [{ json: {
  ...selected,
  sheet_read_request_count: $('Compile Alert Configuration').first().json.sheet_read_request_count,
  quota_retry_count: $('Compile Alert Configuration').first().json.quota_retry_count
} }];`
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
      toApply,
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
    readSheet("Get Alert System Claims", [7200, 240], system, {
      retry: null
    }),
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
      "Evaluate Provider Commit Headroom",
      [7740, 40],
      `${alertCore}
const RUNTIME = ${JSON.stringify(config)};
const plan = $('Plan Independent Moves').first().json;
const candidates = $('Keep Winning Alert Claims').first().json.candidates || [];
const gate = evaluateProviderCommitHeadroom({
  executionStartedAt: plan.execution_started_at,
  now: new Date().toISOString(),
  executionTimeoutSeconds: RUNTIME.execution_timeout_seconds,
  minimumHeadroomMs: RUNTIME.minimum_provider_commit_headroom_ms
});
const errors = [...(plan.error_categories || [])];
if (candidates.length && !gate.eligible) errors.push(gate.classification);
if (candidates.length && plan.receipt_store_available !== true) errors.push('receipt_store_unavailable');
return [{ json: {
  candidates,
  gate,
  authorized: candidates.length > 0 && gate.eligible && plan.receipt_store_available === true && plan.skip_new_alerts !== true,
  error_categories: [...new Set(errors)]
} }];`
    ),
    ifNode(
      "Has Provider Commit Headroom",
      [7900, 40],
      "={{ $json.authorized === true }}"
    ),
    alertReceiptDataTableNode(
      "Get Alert Receipt Authorization Snapshot",
      [8060, -80],
      "get"
    ),
    codeNode(
      "Authorize Pending Alert Receipts",
      [8220, -80],
      `${alertReceiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const headroom = $('Evaluate Provider Commit Headroom').first().json;
const now = new Date().toISOString();
const raw = $input.all().map((item) => item.json || {});
const nonRows = raw.filter((row) => !row.receipt_id && Object.keys(row).length > 0);
const errors = [...(headroom.error_categories || [])];
if (nonRows.length) errors.push('receipt_store_read_failed');
const byId = new Map();
for (const row of raw.filter((entry) => entry.receipt_id)) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid receipt');
    byId.set(receipt.receipt_id, receipt);
  } catch (error) {
    errors.push('receipt_store_invalid');
  }
}
const newReceipts = [];
const retryReceipts = [];
const expectedPending = [];
const candidateByReceipt = {};
if (!errors.length) {
  for (const record of headroom.candidates || []) {
    try {
      const idempotencyKey = alertIdempotencyKey(record, ALERT_POLICY);
      const receiptId = alertReceiptId(idempotencyKey, POLICY);
      const current = byId.get(receiptId);
      let pending;
      if (!current) {
        pending = createPendingAlertReceipt({
          idempotencyKey,
          canonicalJobId: record.canonical_job_id,
          executionId: String($execution.id),
          attemptCount: Number(record.alert_attempt_count || 0) + 1,
          now
        }, POLICY);
        newReceipts.push(alertReceiptPersistenceRow(pending, POLICY));
      } else {
        if (current.idempotency_key !== idempotencyKey || current.canonical_job_id !== record.canonical_job_id) {
          throw new Error('receipt identity conflict');
        }
        if (current.status === 'pending') {
          pending = current;
        } else if (current.status === 'retryable_rejection' && Date.parse(current.next_retry_at || '') <= Date.parse(now)) {
          pending = transitionAlertReceipt(current, {
            expectedVersion: current.receipt_version,
            status: 'pending',
            executionId: String($execution.id),
            now
          }, POLICY);
          retryReceipts.push({
            ...alertReceiptPersistenceRow(pending, POLICY),
            expected_receipt_version: current.receipt_version
          });
        } else {
          continue;
        }
      }
      if (pending.attempt_count !== Number(record.alert_attempt_count || 0) + 1) {
        throw new Error('receipt attempt does not match business state');
      }
      expectedPending.push(alertReceiptPersistenceRow(pending, POLICY));
      candidateByReceipt[pending.receipt_id] = record;
    } catch (error) {
      errors.push('receipt_authorization_rejected');
    }
  }
}
return [{ json: {
  new_receipts: errors.length ? [] : newReceipts,
  retry_receipts: errors.length ? [] : retryReceipts,
  expected_pending: errors.length ? [] : expectedPending,
  candidate_by_receipt: errors.length ? {} : candidateByReceipt,
  receipt_store_available: errors.length === 0,
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare New Pending Receipts",
      [8380, -80],
      `const rows = $('Authorize Pending Alert Receipts').first().json.new_receipts || [];
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has New Pending Receipts",
      [8540, -80],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "Upsert New Pending Receipts",
      [8700, -200],
      "upsert",
      {
        filters: [dataTableFilter("receipt_id", "={{ $json.receipt_id }}")]
      }
    ),
    aggregateNode(
      "Aggregate New Pending Receipts",
      [8860, -200],
      "writes"
    ),
    codeNode(
      "Prepare Retry Pending Receipts",
      [9020, -80],
      `const rows = $('Authorize Pending Alert Receipts').first().json.retry_receipts || [];
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Retry Pending Receipts",
      [9180, -80],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Retry Pending Receipts",
      [9340, -200],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode(
      "Aggregate Retry Pending Receipts",
      [9500, -200],
      "writes"
    ),
    alertReceiptDataTableNode(
      "Verify Pending Alert Receipt Snapshot",
      [9660, -80],
      "get"
    ),
    codeNode(
      "Verify Pending Alert Receipts",
      [9820, -80],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const authorization = $('Authorize Pending Alert Receipts').first().json;
const errors = [...(authorization.error_categories || [])];
const byId = new Map();
for (const row of $input.all().map((item) => item.json || {}).filter((entry) => entry.receipt_id)) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
    byId.set(receipt.receipt_id, receipt);
  } catch { errors.push('receipt_pending_verification_failed'); }
}
const sendable = [];
for (const expected of authorization.expected_pending || []) {
  const actual = byId.get(expected.receipt_id);
  if (actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(expected[field] ?? ''))) {
    sendable.push({ receipt: actual, candidate: authorization.candidate_by_receipt[actual.receipt_id] });
  } else {
    errors.push('receipt_pending_unconfirmed');
  }
}
return [{ json: {
  sendable,
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare Sending Receipt Transitions",
      [9980, -80],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const now = new Date().toISOString();
const rows = ($('Verify Pending Alert Receipts').first().json.sendable || []).map(({ receipt }) => {
  const next = transitionAlertReceipt(receipt, {
    expectedVersion: receipt.receipt_version,
    status: 'sending',
    now
  }, POLICY);
  return {
    ...alertReceiptPersistenceRow(next, POLICY),
    expected_receipt_version: receipt.receipt_version
  };
});
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Sending Receipt Transitions",
      [10140, -80],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Sending Alert Receipts",
      [10300, -200],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode(
      "Aggregate Sending Alert Receipts",
      [10460, -200],
      "writes"
    ),
    alertReceiptDataTableNode(
      "Verify Sending Alert Receipt Snapshot",
      [10620, -80],
      "get"
    ),
    codeNode(
      "Verify Sending Alert Receipts",
      [10780, -80],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const pending = $('Verify Pending Alert Receipts').first().json;
const expected = $('Prepare Sending Receipt Transitions').all().map((item) => item.json).filter((row) => row._noop !== true);
const candidateByReceipt = Object.fromEntries((pending.sendable || []).map((entry) => [entry.receipt.receipt_id, entry.candidate]));
const errors = [...(pending.error_categories || [])];
const byId = new Map();
for (const row of $input.all().map((item) => item.json || {}).filter((entry) => entry.receipt_id)) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
    byId.set(receipt.receipt_id, receipt);
  } catch { errors.push('receipt_sending_verification_failed'); }
}
const sendable = [];
for (const wanted of expected) {
  const actual = byId.get(wanted.receipt_id);
  if (actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(wanted[field] ?? ''))) {
    sendable.push({ receipt: actual, candidate: candidateByReceipt[actual.receipt_id] });
  } else {
    errors.push('receipt_sending_unconfirmed');
  }
}
return [{ json: { sendable, error_categories: [...new Set(errors)] } }];`
    ),
    codeNode(
      "Prepare Alert Sending States",
      [7800, 240],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const rows = $('Verify Sending Alert Receipts').first().json.sendable || [];
const marked = [];
for (const { candidate, receipt } of rows) {
  try {
    const record = markAlertSending(
      candidate,
      POLICY,
      String($execution.id),
      receipt.attempt_started_at
    );
    if (record.alert_idempotency_key !== receipt.idempotency_key ||
        record.alert_attempt_count !== receipt.attempt_count ||
        receipt.status !== 'sending') throw new Error('receipt mismatch');
    marked.push(record);
  } catch (error) {
    console.log(JSON.stringify({ event: 'alert_receipt_guard', category: 'sending_state_rejected' }));
  }
}
return marked.length
  ? marked.map((record) => ({ json: record }))
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
      toApply,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Alert Sending States", [8400, 240], "claims"),
    readSheet("Get To Apply After Alert Claims", [8600, 240], toApply, {
      continueOnError: true,
      retry: null
    }),
    aggregateNode("Aggregate Fresh Alert Claims", [8800, 240], "to_apply_rows"),
    codeNode(
      "Confirm and Render Alerts",
      [9000, 240],
      `${alertCore}
const POLICY = ${JSON.stringify(alertPolicy)};
const SHEET_CONTEXT = $('Compile Alert Configuration').first().json.context;
const PROFILE = SHEET_CONTEXT.profile;
const APPLICATION_POLICY = SHEET_CONTEXT.application_policy;
const PACK_POLICY = SHEET_CONTEXT.pack_policy;
const proposed = $('Prepare Alert Sending States').all()
  .map((item) => item.json)
  .filter((item) => item._noop !== true);
const fresh = ($input.first().json.to_apply_rows || [])
  .filter((row) => row && Object.keys(row).length)
  .map((row) => normalizeLegacyRecord(row, ${JSON.stringify(schema)}));
if (($input.first().json.to_apply_rows || []).some((row) => row?.error)) {
  return [{ json: {
    _noop: true,
    defer_all: true,
    quota_retry_count: Number($('Compile Alert Configuration').first().json.quota_retry_count || 0),
    error_categories: ['alert_guard_read_failed']
  } }];
}
const byId = new Map(fresh.map((row) => [String(row.canonical_job_id).toLowerCase(), row]));
const receipts = new Map(
  ($('Verify Sending Alert Receipts').first().json.sendable || [])
    .map((entry) => [entry.receipt.idempotency_key, entry.receipt])
);
const rendered = proposed.flatMap((claim) => {
  try {
    const persisted = byId.get(String(claim.canonical_job_id).toLowerCase());
    const receipt = receipts.get(claim.alert_idempotency_key);
    if (!persisted ||
        !receipt ||
        persisted.record_version !== claim.record_version ||
        persisted.state_guard !== claim.state_guard ||
        persisted.alert_status !== 'sending' ||
        persisted.alert_claim_token !== claim.alert_claim_token ||
        persisted.alert_idempotency_key !== receipt.idempotency_key ||
        persisted.alert_attempt_count !== receipt.attempt_count ||
        receipt.status !== 'sending' ||
        persisted.user_action) return [];
    const payload = renderSlackAlert(persisted, POLICY, {
      reviewUrl: $env[POLICY.environment.review_url],
      messageSafetyContext: { profile: PROFILE, applicationPolicy: APPLICATION_POLICY, packPolicy: PACK_POLICY }
    });
    return [{ json: { claim: persisted, payload, receipt } }];
  } catch (error) {
    console.log(JSON.stringify({
      event: 'alert_render_rejected',
      canonical_job_id: claim.canonical_job_id,
      category: 'stale_or_unsafe'
    }));
    return [];
  }
});
if (rendered.length !== proposed.length) {
  return [{ json: { _noop: true, defer_all: true, error_categories: ['pre_provider_guard_rejected'] } }];
}
return rendered.length ? rendered : [{ json: { _noop: true } }];`
    ),
    codeNode(
      "Recheck Provider Commit Headroom",
      [9160, 240],
      `${alertCore}
const RUNTIME = ${JSON.stringify(config)};
const plan = $('Plan Independent Moves').first().json;
const gate = evaluateProviderCommitHeadroom({
  executionStartedAt: plan.execution_started_at,
  now: new Date().toISOString(),
  executionTimeoutSeconds: RUNTIME.execution_timeout_seconds,
  minimumHeadroomMs: RUNTIME.minimum_provider_commit_headroom_ms
});
const input = $input.all().map((item) => item.json);
const rows = input.filter((row) => row._noop !== true);
const inputErrors = input.flatMap((row) => row.error_categories || []);
if (!gate.eligible) {
  console.log(JSON.stringify({ event: 'provider_headroom', category: gate.classification }));
  return [{ json: { _noop: true, error_categories: [...new Set([...inputErrors, gate.classification])] } }];
}
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true, error_categories: inputErrors } }];`
    ),
    ifNode("Has Provider Alerts", [9200, 240], "={{ $json._noop !== true }}"),
    codeNode(
      "Prepare Unsent Receipt Deferrals",
      [9360, 320],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const now = new Date().toISOString();
const rows = ($('Verify Sending Alert Receipts').first().json.sendable || []).map(({ receipt }) => {
  const retryable = receipt.attempt_count < POLICY.maximum_attempts;
  const next = transitionAlertReceipt(receipt, {
    expectedVersion: receipt.receipt_version,
    status: retryable ? 'retryable_rejection' : 'terminal_rejection',
    providerStatus: 0,
    providerClassification: 'retryable_rejection',
    errorCategory: 'provider_retryable',
    nextRetryAt: retryable
      ? new Date(Date.parse(now) + ALERT_POLICY.retry.backoff_ms).toISOString()
      : '',
    now
  }, POLICY);
  return {
    ...alertReceiptPersistenceRow(next, POLICY),
    expected_receipt_version: receipt.receipt_version
  };
});
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Unsent Receipt Deferrals",
      [9520, 320],
      "={{ $json._noop !== true }}"
    ),
    httpNode("Send Slack Alert", [9400, 120], {
      url: `={{ $env.${alertPolicy.environment.provider_webhook_url} }}`,
      method: "POST",
      timeout: alertPolicy.provider_timeout_ms,
      interval: alertPolicy.provider_request_interval_ms,
      jsonBody: "={{ JSON.stringify({ text: $json.payload.text }) }}",
      responseFormat: "text",
      fullResponse: false,
      continueOnError: true
    }),
    codeNode(
      "Stage Slack Result",
      [9600, 120],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const ALERT_POLICY = ${JSON.stringify(alertPolicy)};
const request = $('Recheck Provider Commit Headroom').item.json;
const now = new Date().toISOString();
const providerResult = String($json?.data || '').trim() === 'ok'
  ? { ok: true, statusCode: 200, reference: 'accepted' }
  : $json;
const next = applyProviderResultToAlertReceipt(
  request.receipt,
  providerResult,
  {
    expectedVersion: request.receipt.receipt_version,
    retryAt: new Date(Date.parse(now) + ALERT_POLICY.retry.backoff_ms).toISOString(),
    now
  },
  POLICY
);
return { json: {
  ...alertReceiptPersistenceRow(next, POLICY),
  expected_receipt_version: request.receipt.receipt_version
} };`,
      "runOnceForEachItem"
    ),
    alertReceiptDataTableNode(
      "CAS Provider Receipt Outcomes",
      [9760, 120],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode("Aggregate Provider Receipt Outcomes", [9920, 120], "writes"),
    alertReceiptDataTableNode(
      "Verify Provider Receipt Outcome Snapshot",
      [10080, 120],
      "get"
    ),
    codeNode(
      "Verify Provider Receipt Outcomes",
      [10240, 120],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const safeAll = (name) => { try { return $(name).all().map((item) => item.json || {}); } catch { return []; } };
const expected = [
  ...safeAll('Stage Slack Result'),
  ...safeAll('Prepare Unsent Receipt Deferrals').filter((row) => row._noop !== true)
];
const requests = safeAll('Recheck Provider Commit Headroom').filter((row) => row._noop !== true);
for (const entry of $('Verify Sending Alert Receipts').first().json.sendable || []) {
  if (!requests.some((request) => request.receipt?.receipt_id === entry.receipt.receipt_id)) {
    requests.push({ receipt: entry.receipt, claim: entry.candidate });
  }
}
const requestById = Object.fromEntries(requests.map((request) => [request.receipt.receipt_id, request]));
const errors = [...safeAll('Recheck Provider Commit Headroom').flatMap((row) => row.error_categories || [])];
const byId = new Map();
for (const row of $input.all().map((item) => item.json || {}).filter((entry) => entry.receipt_id)) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
    byId.set(receipt.receipt_id, receipt);
  } catch { errors.push('provider_receipt_snapshot_invalid'); }
}
const confirmed = [];
const fallbacks = [];
for (const wanted of expected) {
  const actual = byId.get(wanted.receipt_id);
  const request = requestById[wanted.receipt_id];
  if (actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(wanted[field] ?? ''))) {
    confirmed.push({ receipt: actual, claim: request.claim, receipt_durable: true });
    continue;
  }
  errors.push('provider_receipt_outcome_unconfirmed');
  try {
    const current = actual && actual.status === 'sending'
      ? actual
      : request.receipt;
    const fallback = transitionAlertReceipt(current, {
      expectedVersion: current.receipt_version,
      status: 'terminal_ambiguity',
      providerStatus: 0,
      errorCategory: 'ambiguous_delivery',
      now: new Date().toISOString()
    }, POLICY);
    fallbacks.push({
      ...alertReceiptPersistenceRow(fallback, POLICY),
      expected_receipt_version: current.receipt_version,
      claim: request.claim,
      can_cas: actual?.status === 'sending' && actual.receipt_version === current.receipt_version
    });
  } catch (error) {
    errors.push('provider_ambiguity_fallback_invalid');
  }
}
return [{ json: {
  confirmed,
  fallbacks,
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare Provider Ambiguity Fallbacks",
      [10400, 120],
      `const rows = ($('Verify Provider Receipt Outcomes').first().json.fallbacks || []).filter((row) => row.can_cas);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Provider Ambiguity Fallbacks",
      [10560, 120],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Provider Ambiguity Fallbacks",
      [10720, 0],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode(
      "Aggregate Provider Ambiguity Fallbacks",
      [10880, 0],
      "writes"
    ),
    alertReceiptDataTableNode(
      "Verify Provider Ambiguity Snapshot",
      [11040, 120],
      "get"
    ),
    codeNode(
      "Finalize Provider Receipt Outcomes",
      [11200, 120],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const verification = $('Verify Provider Receipt Outcomes').first().json;
const errors = [...(verification.error_categories || [])];
const outcomes = [...(verification.confirmed || [])];
const raw = $input.all().map((item) => item.json || {});
const byId = new Map();
for (const row of raw.filter((entry) => entry.receipt_id)) {
  try {
    const receipt = normalizeAlertReceipt(row, POLICY);
    if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
    byId.set(receipt.receipt_id, receipt);
  } catch { errors.push('provider_ambiguity_snapshot_invalid'); }
}
for (const fallback of verification.fallbacks || []) {
  const actual = byId.get(fallback.receipt_id);
  const durable = fallback.can_cas && actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(fallback[field] ?? ''));
  if (!durable) errors.push('provider_ambiguity_receipt_unconfirmed');
  outcomes.push({
    receipt: durable ? actual : normalizeAlertReceipt(fallback, POLICY),
    claim: fallback.claim,
    receipt_durable: Boolean(durable)
  });
}
console.log(JSON.stringify({
  event: 'provider_receipt_outcomes',
  classifications: outcomes.map((entry) => entry.receipt.provider_classification),
  durable: outcomes.filter((entry) => entry.receipt_durable).length,
  error_categories: [...new Set(errors)]
}));
return [{ json: { outcomes, error_categories: [...new Set(errors)] } }];`
    ),
    batchReadSheets(
      "Get Alert Owners After Provider",
      [11360, 120],
      [toApply, applied, archive],
      {
        continueOnError: true,
        retry: null
      }
    ),
    codeNode(
      "Plan Provider Business Reconciliation",
      [11520, 120],
      `${sheetBatchCore}
${alertReceiptCore}
const SCHEMA = ${JSON.stringify(schema)};
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const final = $('Finalize Provider Receipt Outcomes').first().json;
if (!Array.isArray($json.valueRanges)) {
  return [{ json: {
    stores: Object.fromEntries(SCHEMA.business_stores.map((store) => [store, []])),
    plans: [],
    updates: [],
    touched_stores: [],
    error_categories: [...new Set([...(final.error_categories || []), 'provider_owner_read_failed'])]
  } }];
}
const parsed = parseBatchSheetRows($json, ${JSON.stringify(
        businessDefinitions.filter((definition) =>
          [toApply, applied, archive].includes(definition.name)
        )
      )});
const now = new Date().toISOString();
const stores = Object.fromEntries(SCHEMA.business_stores.map((store) => [
  store,
  (parsed[store] || []).map((row) => normalizeLegacyRecord(row, SCHEMA, now))
]));
const plans = [];
const errors = [...(final.error_categories || [])];
for (const outcome of final.outcomes || []) {
  try {
    const plan = planAlertReceiptBusinessReconciliation(outcome.receipt, stores, SCHEMA, POLICY, now);
    if (!plan.owner_store) throw new Error('owner unavailable');
    plans.push({ ...outcome, ...plan });
  } catch (error) {
    errors.push('provider_business_reconciliation_blocked');
  }
}
const updates = plans.filter((plan) => plan.business_update);
return [{ json: {
  stores,
  plans,
  updates,
  touched_stores: [...new Set(updates.map((plan) => plan.owner_store))],
  error_categories: [...new Set(errors)]
} }];`
    ),
    codeNode(
      "Prepare Provider To Apply Updates",
      [11680, 120],
      `const rows = ($('Plan Provider Business Reconciliation').first().json.updates || []).filter((plan) => plan.owner_store === 'To Apply').map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Provider To Apply Updates", [11840, 120], "={{ $json._noop !== true }}"),
    writeSheet(
      "Persist Provider To Apply Updates",
      [12000, 0],
      toApply,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Provider To Apply Updates", [12160, 0], "writes"),
    codeNode(
      "Prepare Provider Applied Updates",
      [12320, 120],
      `const rows = ($('Plan Provider Business Reconciliation').first().json.updates || []).filter((plan) => plan.owner_store === 'Applied Jobs').map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Provider Applied Updates", [12480, 120], "={{ $json._noop !== true }}"),
    writeSheet(
      "Persist Provider Applied Updates",
      [12640, 0],
      applied,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Provider Applied Updates", [12800, 0], "writes"),
    codeNode(
      "Prepare Provider Archive Updates",
      [12960, 120],
      `const rows = ($('Plan Provider Business Reconciliation').first().json.updates || []).filter((plan) => plan.owner_store === 'Archive').map((plan) => plan.business_update);
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode("Has Provider Archive Updates", [13120, 120], "={{ $json._noop !== true }}"),
    writeSheet(
      "Persist Provider Archive Updates",
      [13280, 0],
      archive,
      "update",
      alertStateFields,
      ["canonical_job_id"],
      { continueOnError: true }
    ),
    aggregateNode("Aggregate Provider Archive Updates", [13440, 0], "writes"),
    ifNode(
      "Has Provider Business Updates",
      [13600, 120],
      "={{ $('Plan Provider Business Reconciliation').first().json.updates.length > 0 }}"
    ),
    batchReadSheets(
      "Get Provider Business Confirmation",
      [13760, 0],
      [toApply, applied, archive],
      {
        retry: null,
        continueOnError: true,
        urlExpression: `={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $env.${QUEUE_WORKBOOK_ENVIRONMENT_VARIABLE} + '/values:batchGet?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&' + $('Plan Provider Business Reconciliation').first().json.touched_stores.map((sheet) => 'ranges=' + encodeURIComponent("'" + sheet.replace(/'/g, "''") + "'")).join('&') }}`
      }
    ),
    codeNode(
      "Confirm Provider Business Reconciliation",
      [13920, 0],
      `${sheetBatchCore}
${alertCore}
const SCHEMA = ${JSON.stringify(schema)};
const ALERT_STATE_FIELDS = ${JSON.stringify(alertStateFields)};
const planned = $('Plan Provider Business Reconciliation').first().json;
if (!Array.isArray($json.valueRanges)) {
  return [{ json: {
    confirmed: (planned.plans || []).filter((plan) => !plan.business_update),
    error_categories: [...new Set([...(planned.error_categories || []), 'provider_business_confirmation_read_failed'])],
    sheet_read_request_count: 10,
    quota_retry_count: Number($('Normalize Business Snapshot').first().json.quota_retry_count || 0)
  } }];
}
const definitions = ${JSON.stringify(businessDefinitions)}.filter((entry) => planned.touched_stores.includes(entry.name));
const parsed = parseBatchSheetRows($json, definitions);
const stores = { ...planned.stores };
for (const definition of definitions) {
  stores[definition.name] = parsed[definition.name].map((row) => normalizeLegacyRecord(row, SCHEMA));
}
const confirmed = [];
const errors = [...(planned.error_categories || [])];
for (const plan of planned.plans || []) {
  if (!plan.business_update) { confirmed.push(plan); continue; }
  const matches = (stores[plan.owner_store] || []).filter((row) => row.canonical_job_id === plan.business_update.canonical_job_id);
  if (matches.length === 1 && ALERT_STATE_FIELDS.every((field) => String(matches[0][field] ?? '') === String(plan.business_update[field] ?? ''))) confirmed.push(plan);
  else errors.push('provider_business_reconciliation_unconfirmed');
}
return [{ json: {
  confirmed,
  error_categories: [...new Set(errors)],
  sheet_read_request_count: 10,
  quota_retry_count: 0
} }];`
    ),
    codeNode(
      "Use Already Reconciled Provider Business",
      [13920, 200],
      `const planned = $('Plan Provider Business Reconciliation').first().json;
return [{ json: {
  confirmed: planned.plans || [],
  error_categories: planned.error_categories || [],
  sheet_read_request_count: 9,
  quota_retry_count: 0
} }];`
    ),
    codeNode(
      "Prepare Provider Delivered Reconciliation",
      [14080, 120],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const rows = ($json.confirmed || []).flatMap((plan) => {
  if (!plan.receipt_durable || !plan.receipt_update) return [];
  return [{ ...alertReceiptPersistenceRow(plan.receipt_update, POLICY), expected_receipt_version: plan.receipt.receipt_version }];
});
return rows.length ? rows.map((row) => ({ json: row })) : [{ json: { _noop: true } }];`
    ),
    ifNode(
      "Has Provider Delivered Reconciliation",
      [14240, 120],
      "={{ $json._noop !== true }}"
    ),
    alertReceiptDataTableNode(
      "CAS Provider Delivered Reconciliation",
      [14400, 0],
      "update",
      {
        filters: [
          dataTableFilter("receipt_id", "={{ $json.receipt_id }}"),
          dataTableFilter("receipt_version", "={{ $json.expected_receipt_version }}")
        ]
      }
    ),
    aggregateNode("Aggregate Provider Delivered Reconciliation", [14560, 0], "writes"),
    alertReceiptDataTableNode(
      "Verify Provider Delivered Reconciliation",
      [14720, 120],
      "get"
    ),
    codeNode(
      "Finalize Alert Delivery Results",
      [14880, 120],
      `${receiptCore}
const POLICY = ${JSON.stringify(alertReceiptPolicy)};
const base = (() => {
  try { return $('Confirm Provider Business Reconciliation').first().json; }
  catch { return $('Use Already Reconciled Provider Business').first().json; }
})();
const expected = (() => {
  try { return $('Prepare Provider Delivered Reconciliation').all().map((item) => item.json).filter((row) => row._noop !== true); }
  catch { return []; }
})();
const errors = [...(base.error_categories || [])];
let reconciled = 0;
if (expected.length) {
  const byId = new Map();
  for (const row of $input.all().map((item) => item.json || {}).filter((entry) => entry.receipt_id)) {
    try {
      const receipt = normalizeAlertReceipt(row, POLICY);
      if (validateAlertReceipt(receipt, POLICY).length || byId.has(receipt.receipt_id)) throw new Error('invalid');
      byId.set(receipt.receipt_id, receipt);
    } catch { errors.push('delivered_receipt_reconciliation_invalid'); }
  }
  for (const wanted of expected) {
    const actual = byId.get(wanted.receipt_id);
    if (actual && ALERT_RECEIPT_PERSISTED_FIELDS.every((field) => String(actual[field] ?? '') === String(wanted[field] ?? ''))) reconciled += 1;
    else errors.push('delivered_receipt_reconciliation_unconfirmed');
  }
}
const outcomes = $('Finalize Provider Receipt Outcomes').first().json.outcomes || [];
return [{ json: {
  alerts: {
    selected: outcomes.length,
    delivered: outcomes.filter((entry) => entry.receipt.status === 'delivered').length,
    reconciled,
    retryable: outcomes.filter((entry) => entry.receipt.status === 'retryable_rejection').length,
    terminal: outcomes.filter((entry) => ['terminal_rejection', 'terminal_ambiguity'].includes(entry.receipt.status)).length
  },
  provider_classifications: outcomes.map((entry) => entry.receipt.provider_classification),
  sheet_read_request_count: base.sheet_read_request_count,
  quota_retry_count: Math.max(
    Number(base.quota_retry_count || 0),
    errors.includes('alert_guard_read_failed') ? 1 : 0
  ),
  error_categories: [...new Set(errors)]
} }];`
    )
  ];
  const connections = {
    "Schedule Trigger": {
      main: [[connection("Capture Alerter Execution Start")]]
    },
    "Capture Alerter Execution Start": {
      main: [[connection("Get Business Snapshot")]]
    },
    "Get Business Snapshot": {
      main: [[connection("Business Snapshot Quota Limited")]]
    },
    "Business Snapshot Quota Limited": {
      main: [
        [connection("Wait for Sheets Quota Window")],
        [connection("Normalize Business Snapshot")]
      ]
    },
    "Wait for Sheets Quota Window": {
      main: [[connection("Retry Business Snapshot")]]
    },
    "Retry Business Snapshot": {
      main: [[connection("Normalize Business Snapshot")]]
    },
    "Normalize Business Snapshot": {
      main: [[connection("Get Receipt Recovery Snapshot")]]
    },
    "Get Receipt Recovery Snapshot": {
      main: [[connection("Plan Expired Sending Receipts")]]
    },
    "Plan Expired Sending Receipts": {
      main: [[connection("Prepare Expired Sending Receipt Transitions")]]
    },
    "Prepare Expired Sending Receipt Transitions": {
      main: [[connection("Has Expired Sending Receipt Transitions")]]
    },
    "Has Expired Sending Receipt Transitions": {
      main: [
        [connection("CAS Expired Sending Receipts")],
        [connection("Verify Receipt Recovery Transitions")]
      ]
    },
    "CAS Expired Sending Receipts": {
      main: [[connection("Aggregate Expired Sending Receipt Transitions")]]
    },
    "Aggregate Expired Sending Receipt Transitions": {
      main: [[connection("Verify Receipt Recovery Transitions")]]
    },
    "Verify Receipt Recovery Transitions": {
      main: [[connection("Plan Receipt Business Recovery")]]
    },
    "Plan Receipt Business Recovery": {
      main: [[connection("Prepare Recovery To Apply Updates")]]
    },
    "Prepare Recovery To Apply Updates": {
      main: [[connection("Has Recovery To Apply Updates")]]
    },
    "Has Recovery To Apply Updates": {
      main: [
        [connection("Persist Recovery To Apply Updates")],
        [connection("Prepare Recovery Applied Updates")]
      ]
    },
    "Persist Recovery To Apply Updates": {
      main: [[connection("Aggregate Recovery To Apply Updates")]]
    },
    "Aggregate Recovery To Apply Updates": {
      main: [[connection("Prepare Recovery Applied Updates")]]
    },
    "Prepare Recovery Applied Updates": {
      main: [[connection("Has Recovery Applied Updates")]]
    },
    "Has Recovery Applied Updates": {
      main: [
        [connection("Persist Recovery Applied Updates")],
        [connection("Prepare Recovery Archive Updates")]
      ]
    },
    "Persist Recovery Applied Updates": {
      main: [[connection("Aggregate Recovery Applied Updates")]]
    },
    "Aggregate Recovery Applied Updates": {
      main: [[connection("Prepare Recovery Archive Updates")]]
    },
    "Prepare Recovery Archive Updates": {
      main: [[connection("Has Recovery Archive Updates")]]
    },
    "Has Recovery Archive Updates": {
      main: [
        [connection("Persist Recovery Archive Updates")],
        [connection("Has Recovery Business Updates")]
      ]
    },
    "Persist Recovery Archive Updates": {
      main: [[connection("Aggregate Recovery Archive Updates")]]
    },
    "Aggregate Recovery Archive Updates": {
      main: [[connection("Has Recovery Business Updates")]]
    },
    "Has Recovery Business Updates": {
      main: [
        [connection("Get Recovery Business Confirmation")],
        [connection("Use Unchanged Recovery Snapshot")]
      ]
    },
    "Get Recovery Business Confirmation": {
      main: [[connection("Confirm Receipt Business Recovery")]]
    },
    "Confirm Receipt Business Recovery": {
      main: [[connection("Prepare Delivered Receipt Reconciliation")]]
    },
    "Use Unchanged Recovery Snapshot": {
      main: [[connection("Prepare Delivered Receipt Reconciliation")]]
    },
    "Prepare Delivered Receipt Reconciliation": {
      main: [[connection("Has Delivered Receipt Reconciliation")]]
    },
    "Has Delivered Receipt Reconciliation": {
      main: [
        [connection("CAS Delivered Receipt Reconciliation")],
        [connection("Finalize Receipt Recovery")]
      ]
    },
    "CAS Delivered Receipt Reconciliation": {
      main: [[connection("Aggregate Delivered Receipt Reconciliation")]]
    },
    "Aggregate Delivered Receipt Reconciliation": {
      main: [[connection("Verify Delivered Receipt Reconciliation")]]
    },
    "Verify Delivered Receipt Reconciliation": {
      main: [[connection("Finalize Receipt Recovery")]]
    },
    "Finalize Receipt Recovery": {
      main: [[connection("Plan Independent Moves")]]
    },
    "Plan Independent Moves": {
      main: [[connection("Has Eligible Work")]]
    },
    "Has Eligible Work": {
      main: [
        [connection("Prepare Outcome Updates")],
        [connection("Summarize Alerter & Mover Run")]
      ]
    },
    "Prepare Outcome Updates": {
      main: [[connection("Has Outcome Updates")]]
    },
    "Has Outcome Updates": {
      main: [
        [connection("Update Applied Outcomes")],
        [connection("Has Movement Work")]
      ]
    },
    "Update Applied Outcomes": {
      main: [[connection("Has Movement Work")]]
    },
    "Has Movement Work": {
      main: [
        [connection("Emit Movement Claims")],
        [connection("Use Initial To Apply Snapshot")]
      ]
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
      main: [[connection("Prepare Scraped Jobs Writes")]]
    },
    "Prepare Scraped Jobs Writes": {
      main: [[connection("Has Scraped Jobs Writes")]]
    },
    "Has Scraped Jobs Writes": {
      main: [
        [connection("Upsert Scraped Jobs")],
        [connection("Prepare To Review Writes")]
      ]
    },
    "Upsert Scraped Jobs": {
      main: [[connection("Aggregate Scraped Jobs Writes")]]
    },
    "Aggregate Scraped Jobs Writes": {
      main: [[connection("Prepare To Review Writes")]]
    },
    "Prepare To Review Writes": {
      main: [[connection("Has To Review Writes")]]
    },
    "Has To Review Writes": {
      main: [
        [connection("Upsert To Review")],
        [connection("Prepare To Apply Writes")]
      ]
    },
    "Upsert To Review": {
      main: [[connection("Aggregate To Review Writes")]]
    },
    "Aggregate To Review Writes": {
      main: [[connection("Prepare To Apply Writes")]]
    },
    "Prepare To Apply Writes": {
      main: [[connection("Has To Apply Writes")]]
    },
    "Has To Apply Writes": {
      main: [
        [connection("Upsert To Apply")],
        [connection("Prepare Applied Writes")]
      ]
    },
    "Upsert To Apply": {
      main: [[connection("Aggregate To Apply Writes")]]
    },
    "Aggregate To Apply Writes": {
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
        [connection("Get Main Workbook Layout")]
      ]
    },
    "Upsert Archive": {
      main: [[connection("Aggregate Archive Writes")]]
    },
    "Aggregate Archive Writes": {
      main: [[connection("Get Main Workbook Layout")]]
    },
    "Get Main Workbook Layout": {
      main: [[connection("Prepare Latest-First Sort")]]
    },
    "Prepare Latest-First Sort": {
      main: [[connection("Sort Business Sheets Latest First")]]
    },
    "Sort Business Sheets Latest First": {
      main: [[connection("Get Touched Business Stores After Copies")]]
    },
    "Get Touched Business Stores After Copies": {
      main: [[connection("Normalize Touched Business Snapshot")]]
    },
    "Normalize Touched Business Snapshot": {
      main: [[connection("Confirm Destination Copies")]]
    },
    "Confirm Destination Copies": {
      main: [[connection("Prepare Scraped Jobs Deletions")]]
    },
    "Prepare Scraped Jobs Deletions": {
      main: [[connection("Has Scraped Jobs Deletions")]]
    },
    "Has Scraped Jobs Deletions": {
      main: [
        [connection("Delete Confirmed Scraped Jobs Rows")],
        [connection("Aggregate Scraped Deletion Attempts")]
      ]
    },
    "Delete Confirmed Scraped Jobs Rows": {
      main: [[connection("Aggregate Scraped Deletion Attempts")]]
    },
    "Aggregate Scraped Deletion Attempts": {
      main: [[connection("Prepare To Review Deletions")]]
    },
    "Prepare To Review Deletions": {
      main: [[connection("Has To Review Deletions")]]
    },
    "Has To Review Deletions": {
      main: [
        [connection("Delete Confirmed To Review Rows")],
        [connection("Aggregate To Review Deletion Attempts")]
      ]
    },
    "Delete Confirmed To Review Rows": {
      main: [[connection("Aggregate To Review Deletion Attempts")]]
    },
    "Aggregate To Review Deletion Attempts": {
      main: [[connection("Prepare To Apply Deletions")]]
    },
    "Prepare To Apply Deletions": {
      main: [[connection("Has To Apply Deletions")]]
    },
    "Has To Apply Deletions": {
      main: [
        [connection("Delete Confirmed To Apply Rows")],
        [connection("Aggregate To Apply Deletion Attempts")]
      ]
    },
    "Delete Confirmed To Apply Rows": {
      main: [[connection("Aggregate To Apply Deletion Attempts")]]
    },
    "Aggregate To Apply Deletion Attempts": {
      main: [[connection("Prepare Post-Movement Alert Snapshot")]]
    },
    "Prepare Post-Movement Alert Snapshot": {
      main: [[connection("Needs Fresh To Apply Snapshot")]]
    },
    "Needs Fresh To Apply Snapshot": {
      main: [
        [connection("Get Fresh To Apply Snapshot")],
        [connection("Use Initial To Apply Snapshot")]
      ]
    },
    "Get Fresh To Apply Snapshot": {
      main: [[connection("Normalize Fresh To Apply Snapshot")]]
    },
    "Normalize Fresh To Apply Snapshot": {
      main: [[connection("Preselect Persisted Alert Work")]]
    },
    "Use Initial To Apply Snapshot": {
      main: [[connection("Preselect Persisted Alert Work")]]
    },
    "Preselect Persisted Alert Work": {
      main: [[connection("Has Potential Alert Work")]]
    },
    "Has Potential Alert Work": {
      main: [
        [connection("Get Alert Configuration Snapshot")],
        [connection("Summarize Alerter & Mover Run")]
      ]
    },
    "Get Alert Configuration Snapshot": {
      main: [[connection("Compile Alert Configuration")]]
    },
    "Compile Alert Configuration": {
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
        [connection("Summarize Alerter & Mover Run")]
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
      main: [[connection("Evaluate Provider Commit Headroom")]]
    },
    "Evaluate Provider Commit Headroom": {
      main: [[connection("Has Provider Commit Headroom")]]
    },
    "Has Provider Commit Headroom": {
      main: [
        [connection("Get Alert Receipt Authorization Snapshot")],
        [connection("Summarize Alerter & Mover Run")]
      ]
    },
    "Get Alert Receipt Authorization Snapshot": {
      main: [[connection("Authorize Pending Alert Receipts")]]
    },
    "Authorize Pending Alert Receipts": {
      main: [[connection("Prepare New Pending Receipts")]]
    },
    "Prepare New Pending Receipts": {
      main: [[connection("Has New Pending Receipts")]]
    },
    "Has New Pending Receipts": {
      main: [
        [connection("Upsert New Pending Receipts")],
        [connection("Prepare Retry Pending Receipts")]
      ]
    },
    "Upsert New Pending Receipts": {
      main: [[connection("Aggregate New Pending Receipts")]]
    },
    "Aggregate New Pending Receipts": {
      main: [[connection("Prepare Retry Pending Receipts")]]
    },
    "Prepare Retry Pending Receipts": {
      main: [[connection("Has Retry Pending Receipts")]]
    },
    "Has Retry Pending Receipts": {
      main: [
        [connection("CAS Retry Pending Receipts")],
        [connection("Verify Pending Alert Receipt Snapshot")]
      ]
    },
    "CAS Retry Pending Receipts": {
      main: [[connection("Aggregate Retry Pending Receipts")]]
    },
    "Aggregate Retry Pending Receipts": {
      main: [[connection("Verify Pending Alert Receipt Snapshot")]]
    },
    "Verify Pending Alert Receipt Snapshot": {
      main: [[connection("Verify Pending Alert Receipts")]]
    },
    "Verify Pending Alert Receipts": {
      main: [[connection("Prepare Sending Receipt Transitions")]]
    },
    "Prepare Sending Receipt Transitions": {
      main: [[connection("Has Sending Receipt Transitions")]]
    },
    "Has Sending Receipt Transitions": {
      main: [
        [connection("CAS Sending Alert Receipts")],
        [connection("Summarize Alerter & Mover Run")]
      ]
    },
    "CAS Sending Alert Receipts": {
      main: [[connection("Aggregate Sending Alert Receipts")]]
    },
    "Aggregate Sending Alert Receipts": {
      main: [[connection("Verify Sending Alert Receipt Snapshot")]]
    },
    "Verify Sending Alert Receipt Snapshot": {
      main: [[connection("Verify Sending Alert Receipts")]]
    },
    "Verify Sending Alert Receipts": {
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
      main: [[connection("Get To Apply After Alert Claims")]]
    },
    "Get To Apply After Alert Claims": {
      main: [[connection("Aggregate Fresh Alert Claims")]]
    },
    "Aggregate Fresh Alert Claims": {
      main: [[connection("Confirm and Render Alerts")]]
    },
    "Confirm and Render Alerts": {
      main: [[connection("Recheck Provider Commit Headroom")]]
    },
    "Recheck Provider Commit Headroom": {
      main: [[connection("Has Provider Alerts")]]
    },
    "Has Provider Alerts": {
      main: [
        [connection("Send Slack Alert")],
        [connection("Prepare Unsent Receipt Deferrals")]
      ]
    },
    "Prepare Unsent Receipt Deferrals": {
      main: [[connection("Has Unsent Receipt Deferrals")]]
    },
    "Has Unsent Receipt Deferrals": {
      main: [
        [connection("CAS Provider Receipt Outcomes")],
        [connection("Summarize Alerter & Mover Run")]
      ]
    },
    "Send Slack Alert": { main: [[connection("Stage Slack Result")]] },
    "Stage Slack Result": {
      main: [[connection("CAS Provider Receipt Outcomes")]]
    },
    "CAS Provider Receipt Outcomes": {
      main: [[connection("Aggregate Provider Receipt Outcomes")]]
    },
    "Aggregate Provider Receipt Outcomes": {
      main: [[connection("Verify Provider Receipt Outcome Snapshot")]]
    },
    "Verify Provider Receipt Outcome Snapshot": {
      main: [[connection("Verify Provider Receipt Outcomes")]]
    },
    "Verify Provider Receipt Outcomes": {
      main: [[connection("Prepare Provider Ambiguity Fallbacks")]]
    },
    "Prepare Provider Ambiguity Fallbacks": {
      main: [[connection("Has Provider Ambiguity Fallbacks")]]
    },
    "Has Provider Ambiguity Fallbacks": {
      main: [
        [connection("CAS Provider Ambiguity Fallbacks")],
        [connection("Finalize Provider Receipt Outcomes")]
      ]
    },
    "CAS Provider Ambiguity Fallbacks": {
      main: [[connection("Aggregate Provider Ambiguity Fallbacks")]]
    },
    "Aggregate Provider Ambiguity Fallbacks": {
      main: [[connection("Verify Provider Ambiguity Snapshot")]]
    },
    "Verify Provider Ambiguity Snapshot": {
      main: [[connection("Finalize Provider Receipt Outcomes")]]
    },
    "Finalize Provider Receipt Outcomes": {
      main: [[connection("Get Alert Owners After Provider")]]
    },
    "Get Alert Owners After Provider": {
      main: [[connection("Plan Provider Business Reconciliation")]]
    },
    "Plan Provider Business Reconciliation": {
      main: [[connection("Prepare Provider To Apply Updates")]]
    },
    "Prepare Provider To Apply Updates": {
      main: [[connection("Has Provider To Apply Updates")]]
    },
    "Has Provider To Apply Updates": {
      main: [
        [connection("Persist Provider To Apply Updates")],
        [connection("Prepare Provider Applied Updates")]
      ]
    },
    "Persist Provider To Apply Updates": {
      main: [[connection("Aggregate Provider To Apply Updates")]]
    },
    "Aggregate Provider To Apply Updates": {
      main: [[connection("Prepare Provider Applied Updates")]]
    },
    "Prepare Provider Applied Updates": {
      main: [[connection("Has Provider Applied Updates")]]
    },
    "Has Provider Applied Updates": {
      main: [
        [connection("Persist Provider Applied Updates")],
        [connection("Prepare Provider Archive Updates")]
      ]
    },
    "Persist Provider Applied Updates": {
      main: [[connection("Aggregate Provider Applied Updates")]]
    },
    "Aggregate Provider Applied Updates": {
      main: [[connection("Prepare Provider Archive Updates")]]
    },
    "Prepare Provider Archive Updates": {
      main: [[connection("Has Provider Archive Updates")]]
    },
    "Has Provider Archive Updates": {
      main: [
        [connection("Persist Provider Archive Updates")],
        [connection("Has Provider Business Updates")]
      ]
    },
    "Persist Provider Archive Updates": {
      main: [[connection("Aggregate Provider Archive Updates")]]
    },
    "Aggregate Provider Archive Updates": {
      main: [[connection("Has Provider Business Updates")]]
    },
    "Has Provider Business Updates": {
      main: [
        [connection("Get Provider Business Confirmation")],
        [connection("Use Already Reconciled Provider Business")]
      ]
    },
    "Get Provider Business Confirmation": {
      main: [[connection("Confirm Provider Business Reconciliation")]]
    },
    "Confirm Provider Business Reconciliation": {
      main: [[connection("Prepare Provider Delivered Reconciliation")]]
    },
    "Use Already Reconciled Provider Business": {
      main: [[connection("Prepare Provider Delivered Reconciliation")]]
    },
    "Prepare Provider Delivered Reconciliation": {
      main: [[connection("Has Provider Delivered Reconciliation")]]
    },
    "Has Provider Delivered Reconciliation": {
      main: [
        [connection("CAS Provider Delivered Reconciliation")],
        [connection("Finalize Alert Delivery Results")]
      ]
    },
    "CAS Provider Delivered Reconciliation": {
      main: [[connection("Aggregate Provider Delivered Reconciliation")]]
    },
    "Aggregate Provider Delivered Reconciliation": {
      main: [[connection("Verify Provider Delivered Reconciliation")]]
    },
    "Verify Provider Delivered Reconciliation": {
      main: [[connection("Finalize Alert Delivery Results")]]
    },
    "Finalize Alert Delivery Results": {
      main: [[connection("Summarize Alerter & Mover Run")]]
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
      workflowContractVersion: "2026-08-04/v1",
      legacyStateGuardCompatibility: false,
      alertPolicyVersion: alertPolicy.policy_version,
      alertReceiptPolicyVersion: alertReceiptPolicy.policy_version,
      alertReceiptStoreEnvironmentVariable:
        alertReceiptPolicy.store.environment_variable,
      pipelineSchemaVersion: schema.storage_version,
      candidateProfileSource: "Candidate, Skills, Experience, Projects, Education, Awards",
      preferenceSource: "Job Preferences, Application Settings, Required Style, Banned Phrases",
      sourceSheets: [scraped, toReview, toApply],
      destinationSheets: schema.business_stores,
      alertSourceSheet: toApply,
      manualSubmissionOnly: true,
      movementIndependentOfSlack: true,
      movementBeforeAlertSelection: true,
      consolidatedBusinessSnapshot: true,
      lazyConfigurationSnapshot: true,
      touchedSheetConfirmationOnly: true,
      googleSheetsReadRequestBudgets: {
        idle: 2,
        movementOnly: 6,
        fullAlert: 10
      },
      latestFirstBusinessSheets,
      googleSheetsHttpCredentialType: "googleSheetsOAuth2Api",
      googleSheetsReadRetry: config.google_sheets_read_retry,
      minimumProviderCommitHeadroomMs:
        config.minimum_provider_commit_headroom_ms,
      durableReceiptBeforeProvider: true,
      recoverProviderOutcomesBeforeSelection: true,
      terminalizeAmbiguousProviderOutcomes: true,
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

const forbiddenLegacyStateGuardMarkers = [
  "legacyMovementStateGuard",
  "validMovementSourceGuard",
  "legacy-protected edits",
  "Rows written before the 2026-08-03 SHA-256 guard cutover"
];
for (const [path, workflow] of outputs) {
  const serialized = JSON.stringify(workflow);
  if (workflow?.meta?.legacyStateGuardCompatibility !== false) {
    throw new Error(`${path} must explicitly reject legacy state guards`);
  }
  const marker = forbiddenLegacyStateGuardMarkers.find((value) =>
    serialized.includes(value)
  );
  if (marker) {
    throw new Error(`${path} contains forbidden legacy state-guard code: ${marker}`);
  }
}

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
