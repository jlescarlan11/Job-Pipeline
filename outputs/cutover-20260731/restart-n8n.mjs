import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";

const n8nPath =
  "/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin/n8n";
const logPath = "/tmp/job-pipeline-n8n-restart.log";
const options = {
  spreadsheetId: "",
  oldSpreadsheetId: "",
  reviewUrl: "",
  publishIds: [],
};
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  const key = separator >= 0 ? argument.slice(0, separator) : argument;
  const value = separator >= 0 ? argument.slice(separator + 1) : "";
  if (key === "--spreadsheet-id") options.spreadsheetId = value;
  else if (key === "--old-spreadsheet-id") options.oldSpreadsheetId = value;
  else if (key === "--review-url") options.reviewUrl = value;
  else if (key === "--publish-ids") {
    options.publishIds = value.split(",").filter(Boolean);
  }
}

function runningN8n() {
  const listeners = execFileSync(
    "lsof",
    ["-nP", "-t", "-iTCP:5678", "-sTCP:LISTEN"],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (listeners.length !== 1) {
    throw new Error(`Expected one n8n listener, found ${listeners.length}`);
  }
  return Number(listeners[0]);
}

function processEnvironment(processId) {
  const command = execFileSync(
    "ps",
    ["eww", "-p", String(processId), "-o", "command="],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const environment = {};
  for (const match of command.matchAll(
    /(?:^|[\s\0])([A-Za-z_][A-Za-z0-9_]*)=([^\s\0]*)/gu,
  )) {
    environment[match[1]] = match[2];
  }
  return environment;
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const previousProcessId = runningN8n();
const capturedEnvironment = processEnvironment(previousProcessId);
const environment = {
  ...process.env,
  ...capturedEnvironment,
};
if (options.spreadsheetId || options.oldSpreadsheetId || options.reviewUrl) {
  if (
    !options.spreadsheetId ||
    !options.oldSpreadsheetId ||
    !options.reviewUrl
  ) {
    throw new Error("Cutover restart requires all workbook arguments");
  }
  const rawCredential = JSON.parse(
    readFileSync(
      "/tmp/job-pipeline-groq-credential-20260731.json",
      "utf8",
    ),
  );
  const credential = Array.isArray(rawCredential)
    ? rawCredential[0]
    : rawCredential;
  const groqApiKey = String(credential?.data?.apiKey || "");
  if (!groqApiKey) throw new Error("Groq API key is unavailable");
  if (!capturedEnvironment.JOB_PIPELINE_SLACK_WEBHOOK_URL) {
    throw new Error("Slack webhook is unavailable in the running environment");
  }
  Object.assign(environment, {
    GENERIC_TIMEZONE: "Asia/Manila",
    N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
    EXECUTIONS_TIMEOUT: "900",
    EXECUTIONS_TIMEOUT_MAX: "900",
    EXECUTIONS_DATA_SAVE_ON_ERROR: "all",
    EXECUTIONS_DATA_SAVE_ON_SUCCESS: "none",
    EXECUTIONS_DATA_SAVE_ON_PROGRESS: "false",
    EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "true",
    EXECUTIONS_DATA_PRUNE: "true",
    EXECUTIONS_DATA_MAX_AGE: "336",
    EXECUTIONS_DATA_PRUNE_MAX_COUNT: "10000",
    N8N_CONCURRENCY_PRODUCTION_LIMIT: "3",
    N8N_METRICS: "true",
    N8N_METRICS_INCLUDE_DEFAULT_METRICS: "true",
    N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL: "true",
    N8N_METRICS_INCLUDE_QUEUE_METRICS: "false",
    N8N_HTTP_RESPONSE_BODY_READ_TIMEOUT: "20000",
    N8N_RUNNERS_MODE: "external",
    N8N_RUNNERS_MAX_CONCURRENCY: "3",
    N8N_RUNNERS_TASK_TIMEOUT: "300",
    N8N_RUNNERS_TASK_REQUEST_TIMEOUT: "60",
    N8N_RUNNERS_HEARTBEAT_INTERVAL: "15",
    JOB_PIPELINE_SPREADSHEET_ID: options.spreadsheetId,
    JOB_PIPELINE_OLD_SPREADSHEET_ID: options.oldSpreadsheetId,
    JOB_PIPELINE_REVIEW_URL: options.reviewUrl,
    JOB_PIPELINE_GROQ_API_KEY: groqApiKey,
  });
}
process.kill(previousProcessId, "SIGTERM");

let stopped = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    runningN8n();
    await delay(500);
  } catch {
    stopped = true;
    break;
  }
}
if (!stopped) throw new Error("n8n listener did not stop within 30 seconds");

for (const workflowId of options.publishIds) {
  execFileSync(n8nPath, ["publish:workflow", `--id=${workflowId}`], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

const logDescriptor = openSync(logPath, "a", 0o600);
const child = spawn(n8nPath, ["start"], {
  cwd: process.cwd(),
  detached: true,
  env: environment,
  stdio: ["ignore", logDescriptor, logDescriptor],
});
child.unref();
closeSync(logDescriptor);

let healthy = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
  await delay(500);
  try {
    const response = await fetch("http://127.0.0.1:5678/healthz");
    if (response.ok) {
      healthy = true;
      break;
    }
  } catch {
    // Continue until the bounded readiness deadline.
  }
}
if (!healthy) throw new Error(`n8n did not become healthy; inspect ${logPath}`);
const replacementProcessId = runningN8n();
if (options.spreadsheetId) {
  const replacementEnvironment = processEnvironment(replacementProcessId);
  const required = {
    GENERIC_TIMEZONE: environment.GENERIC_TIMEZONE,
    EXECUTIONS_TIMEOUT: environment.EXECUTIONS_TIMEOUT,
    EXECUTIONS_TIMEOUT_MAX: environment.EXECUTIONS_TIMEOUT_MAX,
    EXECUTIONS_DATA_SAVE_ON_ERROR: environment.EXECUTIONS_DATA_SAVE_ON_ERROR,
    EXECUTIONS_DATA_SAVE_ON_SUCCESS: environment.EXECUTIONS_DATA_SAVE_ON_SUCCESS,
    EXECUTIONS_DATA_SAVE_ON_PROGRESS:
      environment.EXECUTIONS_DATA_SAVE_ON_PROGRESS,
    EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:
      environment.EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS,
    EXECUTIONS_DATA_PRUNE: environment.EXECUTIONS_DATA_PRUNE,
    EXECUTIONS_DATA_MAX_AGE: environment.EXECUTIONS_DATA_MAX_AGE,
    EXECUTIONS_DATA_PRUNE_MAX_COUNT:
      environment.EXECUTIONS_DATA_PRUNE_MAX_COUNT,
    N8N_CONCURRENCY_PRODUCTION_LIMIT:
      environment.N8N_CONCURRENCY_PRODUCTION_LIMIT,
    N8N_METRICS: environment.N8N_METRICS,
    N8N_METRICS_INCLUDE_DEFAULT_METRICS:
      environment.N8N_METRICS_INCLUDE_DEFAULT_METRICS,
    N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL:
      environment.N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL,
    N8N_METRICS_INCLUDE_QUEUE_METRICS:
      environment.N8N_METRICS_INCLUDE_QUEUE_METRICS,
    N8N_HTTP_RESPONSE_BODY_READ_TIMEOUT:
      environment.N8N_HTTP_RESPONSE_BODY_READ_TIMEOUT,
    N8N_RUNNERS_MODE: environment.N8N_RUNNERS_MODE,
    N8N_RUNNERS_MAX_CONCURRENCY: environment.N8N_RUNNERS_MAX_CONCURRENCY,
    N8N_RUNNERS_TASK_TIMEOUT: environment.N8N_RUNNERS_TASK_TIMEOUT,
    N8N_RUNNERS_TASK_REQUEST_TIMEOUT:
      environment.N8N_RUNNERS_TASK_REQUEST_TIMEOUT,
    N8N_RUNNERS_HEARTBEAT_INTERVAL:
      environment.N8N_RUNNERS_HEARTBEAT_INTERVAL,
    N8N_RUNNERS_AUTH_TOKEN: environment.N8N_RUNNERS_AUTH_TOKEN,
    N8N_BLOCK_ENV_ACCESS_IN_NODE: environment.N8N_BLOCK_ENV_ACCESS_IN_NODE,
    JOB_PIPELINE_SPREADSHEET_ID: environment.JOB_PIPELINE_SPREADSHEET_ID,
    JOB_PIPELINE_OLD_SPREADSHEET_ID:
      environment.JOB_PIPELINE_OLD_SPREADSHEET_ID,
    JOB_PIPELINE_REVIEW_URL: environment.JOB_PIPELINE_REVIEW_URL,
    JOB_PIPELINE_GROQ_API_KEY: environment.JOB_PIPELINE_GROQ_API_KEY,
    JOB_PIPELINE_SLACK_WEBHOOK_URL:
      environment.JOB_PIPELINE_SLACK_WEBHOOK_URL,
  };
  const mismatches = Object.entries(required)
    .filter(([key, value]) => replacementEnvironment[key] !== value)
    .map(([key]) => key);
  if (mismatches.length > 0) {
    throw new Error(
      `Replacement n8n listener has mismatched environment keys: ${mismatches.join(", ")}`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({
    previous_process_id: previousProcessId,
    replacement_process_id: replacementProcessId,
    health: "ok",
    captured_environment_keys: Object.keys(capturedEnvironment).length,
    cutover_environment_configured: Boolean(options.spreadsheetId),
    published_workflow_ids: options.publishIds,
    log_path: logPath,
  })}\n`,
);
