import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const options = {
  spreadsheetId: "",
  oldSpreadsheetId: "",
  reviewUrl: "",
  workflowId: ""
};
for (let index = 2; index < process.argv.length; index += 1) {
  const [key, value = ""] = process.argv[index].split("=", 2);
  if (key === "--spreadsheet-id") options.spreadsheetId = value;
  else if (key === "--old-spreadsheet-id") options.oldSpreadsheetId = value;
  else if (key === "--review-url") options.reviewUrl = value;
  else if (key === "--workflow-id") options.workflowId = value;
}

for (const [key, value] of Object.entries(options)) {
  if (!value) throw new Error(`Missing ${key}`);
}

const processList = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024
});
const processLine = processList
  .split(/\r?\n/u)
  .find((line) =>
    /node .*\/n8n start(?:\s|$)/u.test(line) &&
    !line.includes("run-n8n-with-cutover-env")
  );
if (!processLine) throw new Error("Running n8n process was not found");
const processId = processLine.trim().split(/\s+/u)[0];
const processEnvironment = execFileSync(
  "ps",
  ["eww", "-p", processId, "-o", "command="],
  {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  }
);
const slackMatch = processEnvironment.match(
  /(?:^|\s)JOB_PIPELINE_SLACK_WEBHOOK_URL=([^\s]+)/u
);
if (!slackMatch?.[1]) {
  throw new Error("Running n8n process has no Slack webhook environment value");
}

const rawCredential = JSON.parse(
  fs.readFileSync("/tmp/job-pipeline-groq-credential-20260731.json", "utf8")
);
const credential = Array.isArray(rawCredential)
  ? rawCredential[0]
  : rawCredential;
const groqApiKey = String(credential?.data?.apiKey || "");
if (!groqApiKey) throw new Error("Groq API key is unavailable");

const environment = {
  ...process.env,
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
  N8N_RUNNERS_ENABLED: "false",
  N8N_RUNNERS_MODE: "internal",
  N8N_RUNNERS_BROKER_PORT: "5681",
  N8N_RUNNERS_MAX_CONCURRENCY: "3",
  N8N_RUNNERS_TASK_TIMEOUT: "300",
  JOB_PIPELINE_SPREADSHEET_ID: options.spreadsheetId,
  JOB_PIPELINE_OLD_SPREADSHEET_ID: options.oldSpreadsheetId,
  JOB_PIPELINE_REVIEW_URL: options.reviewUrl,
  JOB_PIPELINE_GROQ_API_KEY: groqApiKey,
  JOB_PIPELINE_SLACK_WEBHOOK_URL: slackMatch[1]
};

const child = spawnSync(
  "/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin/n8n",
  ["execute", `--id=${options.workflowId}`],
  {
    env: environment,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 20 * 60 * 1000
  }
);

function sanitize(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .slice(-4000);
}

const interesting = `${child.stdout || ""}\n${child.stderr || ""}`
  .split(/\r?\n/u)
  .filter((line) =>
    /success|succeed|error|fail|execution|workflow|finished|started/iu.test(line)
  )
  .slice(-30)
  .join("\n");
const diagnostic =
  child.status === 0
    ? ""
    : sanitize(`${child.stdout || ""}\n${child.stderr || ""}`);

process.stdout.write(
  JSON.stringify(
    {
      workflow_id: options.workflowId,
      exit_code: child.status,
      signal: child.signal || "",
      timed_out: child.error?.code === "ETIMEDOUT",
      summary: sanitize(interesting),
      diagnostic
    },
    null,
    2
  )
);
process.exitCode = child.status ?? 1;
