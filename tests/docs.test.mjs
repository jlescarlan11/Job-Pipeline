import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const loadJson = async (path) => JSON.parse(await loadText(path));

const readme = await loadText("../README.md");
const architecture = await loadText("../docs/architecture.md");
const sheetSchema = await loadText("../docs/sheet-schema.md");
const operations = await loadText("../docs/operations.md");
const recommendationsDoc = await loadText("../docs/recommendations.md");
const prompt = await loadText("../docs/master-prompt.md");
const groqProviderDoc = await loadText("../docs/groq-provider-policy.md");
const alertsDoc = await loadText("../docs/alerts.md");
const schema = await loadJson("../config/pipeline-schema.json");
const searchPlan = await loadJson("../config/search-plan.json");
const runtime = await loadJson("../config/runtime.json");
const review = await loadJson("../config/review-sheet.json");
const analytics = await loadJson("../config/analytics-policy.json");
const recommendations = await loadJson(
  "../config/recommendation-policy.json"
);
const groqProvider = await loadJson("../config/groq-provider-policy.json");
const alertPolicy = await loadJson("../config/alert-policy.json");
const claimRetention = await loadJson("../config/claim-retention.json");

test("README and architecture document the checked-in schedules, bounds, and manual boundary", () => {
  for (const document of [readme, architecture]) {
    assert.match(document, new RegExp(`${searchPlan.schedule_hours}\\s*hours?`, "i"));
    assert.match(document, new RegExp(`${runtime.generator.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(
      document,
      new RegExp(`${alertPolicy.schedule_minutes}\\s*minutes?`, "i")
    );
    assert.match(document, new RegExp(`${review.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(document, new RegExp(`${runtime.archiver.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(document, new RegExp(`${analytics.schedule_hours}\\s*hours?`, "i"));
    assert.match(
      document,
      new RegExp(`${recommendations.schedule_hours}\\s*hours?`, "i")
    );
    assert.match(document, /manual/i);
    assert.doesNotMatch(document, /three independent n8n workflows|cap(?:ped)? (?:at|of) 10/i);
  }
  assert.match(readme, /all checked-in n8n exports have `active: false`/i);
  assert.match(architecture, /at most 5/i);
  assert.match(architecture, /3 times with 5-second/i);
  assert.match(architecture, /10-minute claim lease/i);
  assert.match(architecture, /partial refresh cannot replace/i);
  assert.match(architecture, /multi-touch full-credit/i);
  assert.match(architecture, /latest identifiable\s+complete report/i);
  assert.match(architecture, /no branch changes search configuration/i);
});

test("runtime documentation matches every workflow timeout and Manila timezone", () => {
  const timeoutSeconds = [
    searchPlan.execution_timeout_seconds,
    runtime.generator.execution_timeout_seconds,
    alertPolicy.execution_timeout_seconds,
    review.execution_timeout_seconds,
    runtime.archiver.execution_timeout_seconds,
    analytics.execution_timeout_seconds,
    recommendations.execution_timeout_seconds
  ];
  for (const document of [readme, architecture, operations]) {
    assert.match(document, new RegExp(runtime.timezone, "i"));
    for (const seconds of timeoutSeconds) {
      assert.match(document, new RegExp(`${seconds}[- ]second`, "i"));
    }
  }
  assert.match(architecture, /outer execution budget/i);
  assert.match(operations, /node-level timeout/i);
});

test("Sheet schema documentation covers every persisted field, status, and manual action", () => {
  for (const field of schema.fields) {
    assert.match(sheetSchema, new RegExp(`\\\`${field}\\\``), `missing field documentation: ${field}`);
  }
  for (const status of schema.pipeline_statuses) {
    assert.match(sheetSchema, new RegExp(`\\b${status}\\b`), `missing status documentation: ${status}`);
  }
  for (const action of schema.manual_actions.filter(Boolean)) {
    const documented = action.startsWith("outcome_") ? "outcome_" : action;
    assert.match(sheetSchema, new RegExp(`\\b${documented}\\b`), `missing action documentation: ${action}`);
  }
});

test("runbook contains every release and rollback safety gate", () => {
  for (const required of [
    "Backup",
    "Schema migration on a copy",
    "Disabled import and rebinding",
    "Dry run and smoke checks",
    "Production activation",
    "Production verification",
    "Rollback",
    "disable every old",
    "canonical identity",
    "ready messages",
    "application decisions",
    "Archive"
  ]) {
    assert.match(operations, new RegExp(required, "i"), `runbook is missing: ${required}`);
  }
  assert.match(operations, /all seven exports/i);
  assert.match(operations, /weekly recommendations/i);
  assert.match(operations, /separately reviewed approval/i);
  assert.match(operations, /Groq benchmark/i);
  assert.match(operations, /model permission/i);
});

test("weekly recommendation documentation preserves evidence and no-mutation boundaries", () => {
  assert.match(
    recommendationsDoc,
    new RegExp(`${recommendations.schedule_hours}\\s*hours?`, "i")
  );
  assert.match(
    recommendationsDoc,
    new RegExp(`${recommendations.minimums.overall_applications}\\s+applied`, "i")
  );
  assert.match(recommendationsDoc, /reply, interview, and offer rates/i);
  assert.match(recommendationsDoc, /newest `status=complete`/i);
  assert.match(recommendationsDoc, /explicit abstention/i);
  assert.match(recommendationsDoc, /never adds a claim/i);
  assert.match(recommendationsDoc, /future automatic calibration requires/i);
  assert.match(recommendationsDoc, /does not write `Sheet1`/i);
});

test("prompt documentation points to generated canonical inputs without embedding obsolete facts", () => {
  assert.match(prompt, /config\/candidate-profile\.json/);
  assert.match(prompt, /config\/application-policy\.json/);
  assert.match(prompt, /deterministic validation/i);
  assert.doesNotMatch(prompt, /netlify|FireCheck|PriceCraft|HEALTH/);
});

test("Groq documentation preserves the model lifecycle, measurement, and activation gates", () => {
  assert.match(groqProviderDoc, /2026-08-16/);
  assert.match(groqProviderDoc, new RegExp(groqProvider.selected_model));
  assert.match(groqProviderDoc, /character-based estimate/i);
  assert.match(groqProviderDoc, /exact provider input/i);
  assert.match(groqProviderDoc, /--live/);
  assert.match(groqProviderDoc, /never prints prompts/i);
  assert.match(groqProviderDoc, /rollback/i);
});

test("claim-retention documentation preserves cleanup bounds and rollback safety", () => {
  for (const document of [architecture, sheetSchema, operations]) {
    assert.match(
      document,
      new RegExp(
        `${claimRetention.minimum_rows_before_cleanup.toLocaleString("en-US")}(?:(?:\\s+data)?\\s+rows?|[- ]row)`,
        "i"
      )
    );
    assert.match(
      document,
      new RegExp(
        `${claimRetention.maximum_rows_per_cleanup.toLocaleString("en-US")}(?:\\s+uniquely\\s+addressed)?(?:\\s+claim)?\\s+rows`,
        "i"
      )
    );
    assert.match(
      document,
      new RegExp(`${claimRetention.retention_days}(?:-|\\s+)days?`, "i")
    );
  }
  assert.match(architecture, /fail-closed retention/i);
  assert.match(sheetSchema, /no automatic retry/i);
  assert.match(operations, /recoverable only from the\s+timestamped workbook backup/i);
});

test("alert documentation keeps retries behind claim expiry and execution timeout", () => {
  for (const document of [alertsDoc, architecture, operations]) {
    assert.match(
      document,
      new RegExp(`${alertPolicy.execution_timeout_seconds}[- ]second`, "i")
    );
    assert.match(
      document,
      new RegExp(`${alertPolicy.claim_lease_ms / 60000}[- ]minute`, "i")
    );
  }
  assert.match(alertsDoc, /backoff\s+to be no\s+shorter than the lease/i);
  assert.match(
    alertsDoc,
    new RegExp(`cap of ${alertPolicy.per_run_cap}\\b`, "i")
  );
  assert.match(alertsDoc, /1,440 to 480 per day/i);
  assert.match(architecture, /starve\s+the\s+due retry/i);
  assert.match(operations, /appends no retry\s+claim/i);
});
