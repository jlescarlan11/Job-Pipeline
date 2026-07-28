import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const script = await readFile(
  new URL("../google-apps-script/SheetSetup.gs", import.meta.url),
  "utf8"
);
const schema = await loadJson("../config/pipeline-schema.json");
const review = await loadJson("../config/review-sheet.json");

const embeddedConfigMatch = script.match(
  /const JOB_PIPELINE_SETUP = (\{[\s\S]*?\n\});\n\nfunction onOpen/
);
assert.ok(embeddedConfigMatch, "generated Sheet setup configuration is missing");
const embedded = JSON.parse(embeddedConfigMatch[1]);

test("Sheet setup artifact embeds the canonical schema and review controls", () => {
  assert.deepEqual(embedded.recordFields, schema.fields);
  assert.deepEqual(embedded.reviewColumns, review.review_columns);
  assert.deepEqual(embedded.manualActions, schema.manual_actions);
  assert.deepEqual(embedded.editableColumns, ["manual_action", "notes"]);
  assert.deepEqual(embedded.hiddenColumns, ["state_guard", "processing_token"]);
  assert.equal(embedded.activeSheet, "Sheet1");
  assert.equal(embedded.archiveSheet, "Archive");
  assert.equal(embedded.claimsSheet, "ProcessingClaims");
  assert.equal(embedded.dashboardSheet, "Dashboard");
});

test("Sheet setup is additive, migrates legacy created_at, and preserves reviewer data", () => {
  assert.match(script, /const missing = requiredHeaders\.filter/);
  assert.match(script, /const merged = headers\.concat\(missing\)/);
  assert.doesNotMatch(script, /\.clear\(|deleteSheet|deleteColumns|deleteRows/);
  assert.match(script, /headers\.indexOf\('created_at '\)/);
  assert.match(script, /row\[0\] \|\| legacy\[index\]\[0\]/);
  assert.match(script, /migrateLegacyIdentityAndState_\(active\)/);
  assert.match(script, /stateGuard_\(canonicalJobId/);
  assert.match(script, /profileVersion = String\(current\.profile_version/);
  assert.match(script, /sheet\.getName\(\) === JOB_PIPELINE_SETUP\.archiveSheet/);
  assert.match(script, /orderReviewColumns_\(active\)/);
  assert.match(script, /sheet\.moveColumns/);
  assert.match(script, /duplicateCanonicalIds_\(active\)/);
  assert.match(script, /Canonical identity collisions require manual reconciliation/);
});

test("Sheet setup protects generated fields and validates explicit manual actions", () => {
  assert.match(script, /requireValueInList\(JOB_PIPELINE_SETUP\.manualActions, true\)/);
  assert.match(script, /\.setAllowInvalid\(false\)/);
  assert.match(script, /JOB_PIPELINE_SETUP\.editableColumns\.includes\(header\)/);
  assert.match(script, /\.setWarningOnly\(true\)/);
  assert.match(script, /retryable_error/);
  assert.match(script, /terminal_error/);
  assert.match(script, /sortPriorityQueue/);
  assert.match(script, /sheet\.hideColumns\(column\)/);
});

test("Sheet setup preserves unrelated conditional formatting rules", () => {
  assert.match(script, /const unrelatedRules = sheet\.getConditionalFormatRules/);
  assert.match(script, /unrelatedRules\.concat\(rules\)/);
});
