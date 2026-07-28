import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const script = await readFile(
  new URL("../google-apps-script/SheetSetup.gs", import.meta.url),
  "utf8"
);
const schema = await loadJson("../config/pipeline-schema.json");
const review = await loadJson("../config/review-sheet.json");
const analytics = await loadJson("../config/analytics-policy.json");
const recommendations = await loadJson(
  "../config/recommendation-policy.json"
);

const embeddedConfigMatch = script.match(
  /const JOB_PIPELINE_SETUP = (\{[\s\S]*?\n\});\n\nfunction onOpen/
);
assert.ok(embeddedConfigMatch, "generated Sheet setup configuration is missing");
const embedded = JSON.parse(embeddedConfigMatch[1]);

test("Sheet setup artifact is syntactically valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(script));
});

test("Sheet setup artifact embeds the canonical schema and review controls", () => {
  assert.deepEqual(embedded.recordFields, schema.fields);
  assert.deepEqual(embedded.reviewColumns, review.review_columns);
  assert.deepEqual(embedded.manualActions, schema.manual_actions);
  assert.deepEqual(embedded.editableColumns, [
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "notes"
  ]);
  assert.equal(embedded.reviewInputRules.applyPoints.minimum, 1);
  assert.equal(embedded.reviewInputRules.applyPoints.maximum, 60);
  assert.deepEqual(embedded.hiddenColumns, ["state_guard", "processing_token"]);
  assert.equal(embedded.activeSheet, "Sheet1");
  assert.equal(embedded.archiveSheet, "Archive");
  assert.equal(embedded.claimsSheet, "ProcessingClaims");
  assert.equal(embedded.dashboardSheet, "Dashboard");
  assert.equal(embedded.analyticsSheet, analytics.detail_sheet);
  assert.equal(embedded.analyticsReportsSheet, analytics.reports_sheet);
  assert.deepEqual(embedded.analyticsFields, analytics.detail_fields);
  assert.deepEqual(embedded.analyticsReportFields, analytics.report_fields);
  assert.equal(
    embedded.recommendationsSheet,
    recommendations.recommendations_sheet
  );
  assert.equal(
    embedded.recommendationReportsSheet,
    recommendations.reports_sheet
  );
  assert.deepEqual(
    embedded.recommendationFields,
    recommendations.recommendation_fields
  );
  assert.deepEqual(
    embedded.recommendationReportFields,
    recommendations.report_fields
  );
});

test("Sheet setup is additive, migrates legacy created_at, and preserves reviewer data", () => {
  assert.match(script, /const missing = requiredHeaders\.filter/);
  assert.match(script, /const merged = headers\.concat\(missing\)/);
  assert.doesNotMatch(script, /\.clear\(|deleteSheet|deleteColumns|deleteRows/);
  assert.match(script, /headers\.indexOf\('created_at '\)/);
  assert.match(script, /row\[0\] \|\| legacy\[index\]\[0\]/);
  assert.match(script, /migrateLegacyIdentityAndState_\(active\)/);
  assert.match(script, /JOB_PIPELINE_SETUP\.analyticsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.analyticsReportsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.recommendationsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.recommendationReportsSheet/);
  assert.match(script, /stateGuard_\(\s*canonicalJobId/);
  assert.match(script, /canonicalUrl\.match\(\/\\\/jobseekers\\\/job\\\//);
  assert.match(script, /\.replace\(\/\^http:\\\/\\\//);
  assert.match(script, /profileVersion = String\(current\.profile_version/);
  assert.match(script, /firstReviewedAt = String\(current\.first_reviewed_at/);
  assert.match(script, /applicationMessageStrategy/);
  assert.match(script, /outcomeEvents/);
  assert.match(script, /sheet\.getName\(\) === JOB_PIPELINE_SETUP\.archiveSheet/);
  assert.match(script, /orderReviewColumns_\(active\)/);
  assert.match(script, /sheet\.moveColumns/);
  assert.match(script, /duplicateCanonicalIds_\(active\)/);
  assert.match(script, /Canonical identity collisions require manual reconciliation/);
});

test("Sheet setup protects generated fields and validates explicit manual actions", () => {
  assert.match(script, /requireValueInList\(JOB_PIPELINE_SETUP\.manualActions, true\)/);
  assert.match(script, /headers\.indexOf\('apply_points_input'\)/);
  assert.match(script, /ISNUMBER/);
  assert.match(script, /INT\(/);
  assert.match(script, /application_message_strategy_input/);
  assert.match(script, /REGEXMATCH/);
  assert.match(script, /\.setAllowInvalid\(false\)/);
  assert.match(script, /JOB_PIPELINE_SETUP\.editableColumns\.includes\(header\)/);
  assert.match(script, /\.setWarningOnly\(true\)/);
  assert.match(script, /retryable_error/);
  assert.match(script, /terminal_error/);
  assert.match(script, /sortPriorityQueue/);
  assert.match(script, /index\.opportunity_score/);
  assert.match(script, /statusPriority/);
  assert.match(script, /confidencePriority/);
  assert.match(script, /LockService\.getDocumentLock/);
  assert.match(script, /range\.setValues\(rows\)/);
  assert.match(script, /sheet\.hideColumns\(column\)/);
});

test("Sheet setup preserves unrelated conditional formatting rules", () => {
  assert.match(script, /const unrelatedRules = sheet\.getConditionalFormatRules/);
  assert.match(script, /unrelatedRules\.concat\(rules\)/);
});
