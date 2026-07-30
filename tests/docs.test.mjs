import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const loadJson = async (path) => JSON.parse(await loadText(path));

const readme = await loadText("../README.md");
const architecture = await loadText("../docs/architecture.md");
const analyticsDoc = await loadText("../docs/analytics.md");
const sheetSchema = await loadText("../docs/sheet-schema.md");
const operations = await loadText("../docs/operations.md");
const recommendationsDoc = await loadText("../docs/recommendations.md");
const deploymentDoc = await loadText("../docs/n8n-deployment.md");
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
const reportRetention = await loadJson(
  "../config/report-retention.json"
);
const deploymentPolicy = await loadJson(
  "../config/n8n-deployment-policy.json"
);

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
  assert.match(architecture, /at most 1/i);
  assert.match(architecture, /3 times with 5-second/i);
  assert.match(architecture, /10-minute claim lease/i);
  assert.match(architecture, /partial refresh cannot replace/i);
  assert.match(architecture, /multi-touch full-credit/i);
  assert.match(architecture, /latest identifiable\s+complete report/i);
  assert.match(architecture, /no branch changes search configuration/i);
  for (const document of [readme, architecture]) {
    assert.match(document, /six-field cron/i);
    assert.match(
      document,
      /(?:peak|maximum)[\s\S]{0,40}(?:two|2) simultaneous scheduled executions/i
    );
  }
  for (const document of [architecture, operations, deploymentDoc]) {
    assert.match(document, /01:08/i);
    assert.match(document, /00:01/i);
    assert.match(document, /00:19/i);
  }
  for (const document of [architecture, operations]) {
    assert.match(document, /:13\/:28\/:43\/:58/i);
  }
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

test("runtime documentation preserves failure evidence without successful execution churn", () => {
  for (const document of [readme, architecture, operations]) {
    assert.match(document, /failed production executions/i);
    assert.match(
      document,
      /manual\s+(?:smoke\s+)?executions|manual\s+smoke\s+tests/i
    );
    assert.match(
      document,
      /(?:do|does)\s+not\s+(?:retain|save)\s+successful\s+production\s+executions/i
    );
    assert.match(document, /per-node\s+(?:execution\s+)?progress/i);
  }
  for (const document of [readme, architecture]) {
    assert.match(document, /1,730 (?:normally successful )?scheduled executions per week/i);
  }
  assert.match(operations, /instance-level pruning/i);
});

test("deployment documentation pins bounded self-hosted controls without claiming activation", () => {
  for (const document of [readme, architecture, operations, deploymentDoc]) {
    assert.match(document, /production concurrency[\s\S]{0,100}\b3\b/i);
    assert.match(document, /336 hours/i);
    assert.match(document, /10,000/i);
    assert.match(document, /validate:deployment/i);
  }
  assert.match(deploymentDoc, /0\.685 execution slots/i);
  assert.match(
    deploymentDoc,
    /at least one slot\s+of scheduled-burst headroom/i
  );
  assert.match(deploymentDoc, /3,460 records/i);
  assert.match(deploymentDoc, /metrics endpoint[\s\S]{0,100}internal/i);
  assert.match(deploymentDoc, /instance-assigned workflow/i);
  assert.match(deploymentDoc, /error executions[\s\S]{0,100}bypass/i);
  assert.match(
    operations,
    /oldest due\s+generation or deterministic evaluation exceeds 120 minutes/i
  );
  assert.match(operations, /pending alert\s+exceeds 45 minutes/i);
  assert.match(operations, /manual action exceeds 30 minutes/i);
});

test("Generator documentation preserves separate capacity and bounded fairness", () => {
  for (const document of [readme, architecture, operations]) {
    assert.match(
      document,
      /(?:separate|split)[\s\S]{0,100}(?:deterministic[- ]evaluation|evaluation)/i
    );
    assert.match(document, /evaluation[\s\S]{0,160}(?:cap|slot|at most one)/i);
    assert.match(document, /120-minute maximum\s+priority wait|waited 120 minutes/i);
  }
  assert.match(
    architecture,
    /generation\s+backlog cannot consume the evaluation slot/i
  );
  assert.match(architecture, /oldest-due tier/i);
  assert.match(operations, /due-generation, due-evaluation/i);
});

test("Reviewer idle-path documentation preserves the fail-closed operation bound", () => {
  for (const document of [readme, architecture]) {
    assert.match(document, /six (?:Sheet )?reads/i);
    assert.match(document, /at least 14 Sheet\/Sheets API\s+requests/i);
    assert.match(document, /one[\s\S]{0,40}claim/i);
    assert.match(document, /Dashboard mutation/i);
  }
  assert.match(architecture, /768\s+avoided\s+requests/i);
  assert.match(architecture, /35,040\s+rows/i);
  assert.match(architecture, /70,080 Reviewer executions/i);
  assert.match(architecture, /420,480 mandatory six-surface reads/i);
  assert.match(architecture, /17,520\s+executions/i);
  assert.match(architecture, /105,120\s+mandatory reads/i);
  assert.match(operations, /review_snapshot_unchanged/i);
  assert.match(operations, /exactly\s+six Sheet reads/i);
  assert.match(
    operations,
    /generated_at[\s\S]{0,80}last\s+material summary publication/i
  );
});

test("learning schedule documentation preserves fixed ordering and safe fallback", () => {
  for (const document of [readme, architecture, operations]) {
    assert.match(document, /02:00/i);
    assert.match(document, /Monday(?:s)?[\s\S]{0,80}02:45/i);
    assert.match(document, /15-minute\s+completion buffer/i);
  }
  assert.match(analyticsDoc, /fixed 02:00 start/i);
  assert.match(recommendationsDoc, /Mondays at 02:45/i);
  assert.match(recommendationsDoc, /15-minute completion buffer/i);
  assert.match(recommendationsDoc, /latest complete[\s\S]{0,80}report/i);
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

test("runbook gates old and new versions for all seven workflow roles", () => {
  for (const role of [
    "Scraper",
    "Generator",
    "Alerter",
    "Reviewer",
    "Archiver",
    "Analytics",
    "Recommender"
  ]) {
    assert.match(
      operations,
      new RegExp(`old[\\s\\S]{0,160}${role}|${role}[\\s\\S]{0,160}old`, "i"),
      `cutover omits old ${role} copies`
    );
  }
  assert.match(operations, /capture:cutover -- pre_activation/i);
  assert.match(operations, /capture:cutover -- post_activation/i);
  assert.match(
    operations,
    /restart[\s\S]{0,100}cached\s+schedule\s+registrations?/i
  );
  assert.match(operations, /new`, `running`,\s+or `waiting`/i);
  assert.match(
    operations,
    /Exactly the recorded target ID[\s\S]{0,100}seven roles/i
  );
  assert.match(deploymentDoc, /unrecognized or multiply matching/i);
  assert.match(
    architecture,
    /exactly one active workflow[\s\S]{0,100}seven\s+roles/i
  );
  assert.equal(deploymentPolicy.workflow_cutover.roles.length, 7);
});

test("runbook preserves fail-closed learning-report recovery", () => {
  assert.match(operations, /Recovery after a post-write report preparation failure/i);
  assert.match(operations, /do not delete or rewrite it manually/i);
  assert.match(operations, /35 minutes after the\s+Analytics claim/i);
  assert.match(operations, /20 minutes after the Recommender claim/i);
  assert.match(
    operations,
    /stable\s+`analytics_row_id`, `report_id`, `recommendation_id`, and\s+`run_id`/i
  );
  assert.match(operations, /failed Recommender attempt[\s\S]{0,100}execution-scoped/i);
  assert.match(
    operations,
    /Execute Analytics first[\s\S]{0,300}execute Recommender/i
  );
  assert.match(operations, /action=unchanged/);
  assert.match(
    operations,
    /Analytics must publish no completion metadata;[\s\S]{0,120}detail_write_failure/i
  );
  assert.match(operations, /helper-resolution `ReferenceError`/i);
  assert.match(
    operations,
    /every old Analytics and Recommender copy is\s+inactive/i
  );
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
  assert.match(groqProviderDoc, /two highest-ranked selected profile proofs/i);
  assert.match(groqProviderDoc, /170,816 character-estimated tokens/i);
  assert.match(groqProviderDoc, /34 requests/i);
  assert.match(groqProviderDoc, /65 seconds/i);
  assert.match(groqProviderDoc, /no cache hits/i);
  assert.match(groqProviderDoc, /account-specific limits/i);
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

test("report-retention documentation preserves leases, bounds, and fail-closed recovery", () => {
  const analyticsRetention = reportRetention.analytics;
  const recommendationRetention = reportRetention.recommendations;
  for (const document of [
    readme,
    architecture,
    analyticsDoc,
    sheetSchema,
    operations
  ]) {
    assert.match(
      document,
      new RegExp(`${analyticsRetention.retention_days}(?:-|\\s+)days?`, "i")
    );
    assert.match(
      document,
      new RegExp(
        `${analyticsRetention.minimum_reports_before_cleanup}(?:\\s+\\w+){0,3}\\s+rows`,
        "i"
      )
    );
    assert.match(
      document,
      new RegExp(
        `${analyticsRetention.maximum_reports_per_cleanup}\\s+expired\\s+reports`,
        "i"
      )
    );
  }
  for (const document of [
    readme,
    architecture,
    recommendationsDoc,
    sheetSchema,
    operations
  ]) {
    assert.match(
      document,
      new RegExp(
        `${recommendationRetention.retention_days}(?:-|\\s+)days?`,
        "i"
      )
    );
    assert.match(
      document,
      new RegExp(
        `${recommendationRetention.minimum_reports_before_cleanup}(?:\\s+\\w+){0,3}\\s+rows`,
        "i"
      )
    );
    assert.match(
      document,
      new RegExp(
        `${recommendationRetention.maximum_reports_per_cleanup}\\s+expired`,
        "i"
      )
    );
  }
  assert.match(analyticsDoc, /analytics_report_store/);
  assert.match(recommendationsDoc, /recommendation_report_store/);
  assert.match(architecture, /formulas visible/i);
  assert.match(operations, /response-\s*ambiguous batch/i);
  assert.match(
    operations,
    /report groups[\s\S]{0,120}recoverable only from the timestamped workbook backup/i
  );
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
  assert.match(alertsDoc, /480 to 96 per day/i);
  assert.match(alertsDoc, /140,160\s+scheduled\s+executions/i);
  assert.match(alertsDoc, /capacity for 30\s+alerts/i);
  for (const document of [readme, alertsDoc, architecture, operations]) {
    assert.match(document, /1\.1\s+seconds?/i);
  }
  assert.match(alertsDoc, /one message per second/i);
  assert.match(
    operations,
    /request\s+starts are at least 1\.1\s+seconds apart/i
  );
  assert.match(
    alertsDoc,
    /retain their attempt\s+count, due time, and original delivery key/i
  );
  assert.match(
    alertsDoc,
    /never\s+reopened merely because a policy version changed/i
  );
  assert.match(alertsDoc, /deployment-stable n8n\s+workflow ID/i);
  assert.match(architecture, /starve\s+the\s+due retry/i);
  assert.match(operations, /appends no retry\s+claim/i);
});

test("operational monitoring documentation defines observable backlog clocks", () => {
  const thresholds = deploymentPolicy.monitoring.thresholds;
  for (const document of [architecture, operations, deploymentDoc]) {
    assert.match(document, /operational_backlog/);
    assert.match(document, /manual[\s-]+action[\s\S]{0,100}fingerprint/i);
    assert.match(document, /generator_result/);
    assert.match(document, /alert_delivery/);
    assert.match(document, /category=rate_limit/);
  }
  assert.match(
    deploymentDoc,
    new RegExp(
      `${thresholds.operational_backlog_event_stale_minutes}\\s+minutes`,
      "i"
    )
  );
  assert.match(
    deploymentDoc,
    new RegExp(`${thresholds.oldest_due_generation_minutes}\\s+minutes`, "i")
  );
  assert.match(
    deploymentDoc,
    new RegExp(`${thresholds.oldest_pending_alert_minutes}\\s+minutes`, "i")
  );
  assert.match(
    deploymentDoc,
    new RegExp(`${thresholds.oldest_manual_action_minutes}\\s+minutes`, "i")
  );
  assert.match(deploymentDoc, /does not count expired append-only/i);
  assert.match(deploymentDoc, /remove it when absent/i);
});
