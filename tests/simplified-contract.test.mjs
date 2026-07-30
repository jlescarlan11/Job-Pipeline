import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalJobId,
  canTransition,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  transitionRecord,
  validatePipelineSchema,
  validateRecordContract,
  validateUniqueIdentityAcrossStores
} from "../src/contracts.mjs";
import {
  planFreshWorkbookSetup,
  validateFreshSheetConfig
} from "../src/fresh-sheet-setup.mjs";

const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);
const review = JSON.parse(
  await readFile(new URL("../config/review-sheet.json", import.meta.url))
);

function validRecord(overrides = {}) {
  const base = {
    source: "onlinejobs.ph",
    source_job_id: "12345",
    canonical_job_id: "onlinejobs.ph:12345",
    record_version: 1,
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-12345",
    pipeline_status: "new",
    user_action: "",
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["react developer"],
    match_reasons: [],
    requirement_gaps: [],
    selected_proof_refs: [],
    application_instructions: [],
    screening_questions: [],
    application_warnings: [],
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z"
  };
  return normalizeLegacyRecord({ ...base, ...overrides }, schema, base.created_at);
}

test("simplified schema has exactly three business results and separate operational conditions", () => {
  assert.deepEqual(validatePipelineSchema(schema), []);
  assert.deepEqual(schema.business_results, [
    "ready_to_apply",
    "review_needed",
    "skip"
  ]);
  assert.deepEqual(schema.operational_conditions, [
    "new",
    "processing",
    "error",
    "unavailable"
  ]);
});

test("Review Queue, Applied Jobs, and Archive own the three record lifecycles", () => {
  assert.deepEqual(validateFreshSheetConfig(review, schema), []);
  assert.equal(review.sheets.review_queue.authoritative_for, "active");
  assert.equal(review.sheets.applied_jobs.authoritative_for, "applied");
  assert.equal(review.sheets.archive.authoritative_for, "archived");
  assert.equal(review.sheets.system.visible, false);
  assert.equal(review.fresh_start.imports_legacy_rows, false);
});

test("operator actions are fail-closed and status specific", () => {
  for (const [status, allowed] of Object.entries(schema.actions_by_status)) {
    for (const action of schema.user_actions) {
      const errors = validateRecordContract(
        validRecord({ pipeline_status: status, user_action: action }),
        schema
      );
      assert.equal(
        errors.some((error) => error.includes("user_action")),
        !allowed.includes(action),
        `${status}/${action || "(blank)"}`
      );
    }
  }
});

test("unsupported transitions and malformed identities fail closed", () => {
  assert.equal(canTransition(schema, "new", "ready_to_apply"), false);
  assert.throws(
    () => transitionRecord(validRecord(), "ready_to_apply", schema),
    /Invalid pipeline transition/
  );
  assert.match(
    validateRecordContract(
      validRecord({
        canonical_job_id: "onlinejobs.ph:999",
        canonical_url: "javascript:alert(1)"
      }),
      schema
    ).join(";"),
    /canonical_url is invalid|canonical_job_id does not match/
  );
});

test("OnlineJobs IDs and canonical URLs retain established identity behavior", () => {
  const canonical = normalizeCanonicalUrl(
    "HTTPS://WWW.ONLINEJOBS.PH/jobseekers/job/example-12345/"
  );
  assert.equal(
    canonical,
    "https://onlinejobs.ph/jobseekers/job/example-12345"
  );
  assert.equal(
    canonicalJobId({ source: "ONLINEJOBS.PH", canonical_url: canonical }),
    "onlinejobs.ph:12345"
  );
});

test("identity duplicates across all three stores are rejected", () => {
  const record = validRecord();
  assert.deepEqual(
    validateUniqueIdentityAcrossStores(
      {
        "Review Queue": [record],
        "Applied Jobs": [],
        Archive: []
      },
      schema
    ),
    []
  );
  assert.match(
    validateUniqueIdentityAcrossStores(
      {
        "Review Queue": [record],
        "Applied Jobs": [{ ...record }],
        Archive: []
      },
      schema
    ).join(";"),
    /duplicate canonical identity/
  );
});

test("blank setup creates only intended sheets with headers and no rows", () => {
  const planned = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema
  );
  assert.deepEqual(
    planned.sheets.map((sheet) => sheet.name),
    ["Review Queue", "Applied Jobs", "Archive", "_System"]
  );
  assert.equal(planned.sheets.filter((sheet) => !sheet.hidden).length, 3);
  for (const sheet of planned.sheets) {
    assert.equal(sheet.rows.length, 0);
    assert.ok(sheet.headers.length > 0);
  }
});

test("setup is idempotent and preserves valid operator data", () => {
  const first = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema
  );
  first.sheets[0].rows.push(validRecord({ notes: "keep me" }));
  const second = planFreshWorkbookSetup(first, review, schema);
  assert.deepEqual(second, first);
  assert.equal(second.sheets[0].rows[0].notes, "keep me");
});

test("fresh setup refuses conflicting or non-empty legacy sheets", () => {
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        { sheets: [{ name: "Sheet1", headers: ["legacy"], rows: [["data"]] }] },
        review,
        schema
      ),
    /refused non-empty unexpected sheet/
  );
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        {
          sheets: [
            { name: "Review Queue", headers: ["wrong"], rows: [] }
          ]
        },
        review,
        schema
      ),
    /conflicting headers/
  );
});

test("generated setup has no legacy import surface or placeholder writes", async () => {
  const artifact = await readFile(
    new URL("../google-apps-script/SheetSetup.gs", import.meta.url),
    "utf8"
  );
  assert.match(artifact, /setupFreshJobPipeline/);
  assert.match(artifact, /hideSheet\(\)/);
  assert.match(artifact, /ensureSheetCapacity_/);
  assert.match(artifact, /insertRowsAfter/);
  assert.match(artifact, /insertColumnsAfter/);
  assert.doesNotMatch(artifact, /openById|IMPORTRANGE|copyTo\(/i);
  assert.doesNotMatch(artifact, /appendRow|placeholder/i);
  for (const legacy of [
    "Dashboard",
    "AnalyticsReports",
    "RecommendationReports",
    "ProcessingClaims"
  ]) {
    assert.doesNotMatch(
      artifact.slice(artifact.indexOf("function setupFreshJobPipeline")),
      new RegExp(`insertSheet\\(['\"]${legacy}`)
    );
  }
});
