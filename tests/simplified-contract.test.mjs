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
  validateRecordStoreContract,
  validateUniqueIdentityAcrossStores
} from "../src/contracts.mjs";
import {
  planFreshWorkbookSetup,
  planSegmentedQueueMigration,
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

test("five business sheets own the segmented record lifecycle", () => {
  assert.deepEqual(validateFreshSheetConfig(review, schema), []);
  assert.equal(review.sheets.scraped_jobs.authoritative_for, "scraped");
  assert.equal(review.sheets.to_review.authoritative_for, "review");
  assert.equal(review.sheets.to_apply.authoritative_for, "apply");
  assert.equal(review.sheets.applied_jobs.authoritative_for, "applied");
  assert.equal(review.sheets.archive.authoritative_for, "archived");
  assert.equal(
    review.sheets.search_keywords.authoritative_for,
    "scraper_keywords"
  );
  assert.equal(review.sheets.search_keywords.visible, true);
  assert.equal(review.sheets.system.visible, false);
  assert.equal(review.fresh_start.imports_legacy_rows, false);
  assert.deepEqual(schema.business_stores, [
    "Scraped Jobs",
    "To Review",
    "To Apply",
    "Applied Jobs",
    "Archive"
  ]);
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
  for (const [store, statuses] of Object.entries(
    schema.actions_by_store_status
  )) {
    for (const [status, allowed] of Object.entries(statuses)) {
      for (const action of schema.user_actions) {
        const errors = validateRecordStoreContract(
          validRecord({
            pipeline_status: status,
            user_action: action,
            ...(status === "processing"
              ? {
                  processing_stage: "evaluation",
                  processing_token: "owner",
                  processing_started_at: "2026-07-31T00:00:00.000Z"
                }
              : {})
          }),
          store,
          schema
        );
        assert.equal(
          errors.some(
            (error) =>
              error.includes(`not supported for ${store}/`) ||
              error.includes(`${store} does not own`)
          ),
          !allowed.includes(action),
          `${store}/${status}/${action || "(blank)"}`
        );
      }
    }
  }
  assert.match(
    validateRecordStoreContract(
      validRecord({ pipeline_status: "ready_to_apply", user_action: "" }),
      "To Review",
      schema
    ).join(";"),
    /does not own pipeline_status/
  );
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

test("identity duplicates across all five stores are rejected", () => {
  const record = validRecord();
  assert.deepEqual(
    validateUniqueIdentityAcrossStores(
      {
        "Scraped Jobs": [record],
        "To Review": [],
        "To Apply": [],
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
        "Scraped Jobs": [record],
        "To Review": [],
        "To Apply": [],
        "Applied Jobs": [{ ...record }],
        Archive: []
      },
      schema
    ).join(";"),
    /duplicate canonical identity/
  );
});

test("blank setup creates business, configuration, and system sheets", () => {
  const planned = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema
  );
  assert.deepEqual(
    planned.sheets.map((sheet) => sheet.name),
    [
      "Scraped Jobs",
      "To Review",
      "To Apply",
      "Applied Jobs",
      "Archive",
      "Search Keywords",
      "Candidate",
      "Skills",
      "Experience",
      "Projects",
      "Education",
      "Awards",
      "Job Preferences",
      "Application Settings",
      "Required Style",
      "Banned Phrases",
      "_System"
    ]
  );
  assert.equal(planned.sheets.filter((sheet) => !sheet.hidden).length, 16);
  for (const sheet of planned.sheets.filter(
    (sheet) =>
      [
        "Scraped Jobs",
        "To Review",
        "To Apply",
        "Applied Jobs",
        "Archive",
        "_System"
      ].includes(sheet.name)
  )) {
    assert.equal(sheet.rows.length, 0);
    assert.ok(sheet.headers.length > 0);
  }
  const keywords = planned.sheets.find(
    (sheet) => sheet.name === "Search Keywords"
  );
  assert.deepEqual(keywords.headers, ["enabled", "keyword"]);
  assert.equal(keywords.rows.length, 10);
  assert.ok(keywords.rows.every((row) => row.enabled === true));
  assert.deepEqual(keywords.validations, { enabled: "checkbox" });
  assert.equal(keywords.protectedHeader, true);
  assert.deepEqual(keywords.protectedColumns, []);
  for (const key of [
    "candidate",
    "skills",
    "experience",
    "projects",
    "education",
    "awards",
    "job_preferences",
    "application_settings",
    "required_style",
    "banned_phrases"
  ]) {
    const definition = review.sheets[key];
    const contextSheet = planned.sheets.find(
      (sheet) => sheet.name === definition.name
    );
    assert.deepEqual(contextSheet.headers, definition.fields);
    assert.deepEqual(contextSheet.rows, definition.initial_rows);
    assert.equal(contextSheet.protectedHeader, true);
    assert.deepEqual(contextSheet.protectedColumns, []);
    assert.deepEqual(
      contextSheet.validations,
      definition.fields.includes("enabled") ? { enabled: "checkbox" } : {}
    );
  }
  assert.deepEqual(
    planned.sheets.find((sheet) => sheet.name === "To Review").validations,
    {
      user_action: { values: ["Approve", "Deny"], allow_blank: true }
    }
  );
  assert.deepEqual(
    planned.sheets.find((sheet) => sheet.name === "To Apply").validations,
    {
      user_action: { values: ["I Applied", "Skip"], allow_blank: true }
    }
  );
  assert.deepEqual(
    planned.sheets.find((sheet) => sheet.name === "Scraped Jobs").validations,
    {}
  );
});

test("setup is idempotent and preserves valid operator data", () => {
  const first = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema
  );
  first.sheets[0].rows.push(validRecord({ notes: "keep me" }));
  const keywordSheet = first.sheets.find(
    (sheet) => sheet.name === "Search Keywords"
  );
  keywordSheet.rows[0] = {
    enabled: false,
    keyword: "edited full stack developer"
  };
  keywordSheet.rows.splice(1, 1);
  keywordSheet.rows.push({
    enabled: true,
    keyword: "new operator keyword"
  });
  const second = planFreshWorkbookSetup(first, review, schema);
  assert.deepEqual(second, first);
  assert.equal(second.sheets[0].rows[0].notes, "keep me");
  assert.deepEqual(
    second.sheets.find((sheet) => sheet.name === "Search Keywords").rows,
    keywordSheet.rows
  );
});

test("pre-existing empty Search Keywords sheet is not repopulated", () => {
  const planned = planFreshWorkbookSetup(
    {
      sheets: [
        {
          name: "Search Keywords",
          headers: ["enabled", "keyword"],
          rows: []
        }
      ]
    },
    review,
    schema
  );
  assert.deepEqual(
    planned.sheets.find((sheet) => sheet.name === "Search Keywords").rows,
    []
  );
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
            { name: "Scraped Jobs", headers: ["wrong"], rows: [] }
          ]
        },
        review,
        schema
      ),
    /conflicting headers/
  );
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        {
          sheets: [
            {
              name: "Search Keywords",
              headers: ["keyword", "enabled"],
              rows: [{ keyword: "react developer", enabled: true }]
            }
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
  assert.match(artifact, /configureSearchKeywordsSheet_/);
  assert.match(artifact, /requireCheckbox/);
  assert.match(artifact, /Search Keywords:header/);
  assert.match(artifact, /createdSheets\.has/);
  assert.match(artifact, /assertReconciliableHeaders_/);
  assert.match(artifact, /requireValueInList\(rule\.values, true\)/);
  assert.match(artifact, /clearDataValidations/);
  assert.doesNotMatch(artifact, /Review Queue/);
  assert.ok(
    artifact.indexOf("assertReconciliableHeaders_(sheet, definition.headers)") <
      artifact.indexOf("workbook.insertSheet(name)"),
    "existing sheets must be preflighted before structural writes"
  );
  assert.match(
    artifact,
    /function reconcileHeaders_\(sheet, headers\) \{\s+const state = assertReconciliableHeaders_\(sheet, headers\);[\s\S]*?if \(!state\.hasHeader\) \{[\s\S]*?setValues\(\[headers\]\)/
  );
  assert.match(
    artifact,
    /function assertReconciliableHeaders_\(sheet, headers\) \{[\s\S]*?if \(lastRow > 1 && !hasHeader\) \{[\s\S]*?throw new Error\('Fresh setup found data without headers'\)/
  );
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

test("migration planner deterministically routes every supported legacy combination", () => {
  const records = [
    validRecord({ source_job_id: "1", canonical_job_id: "onlinejobs.ph:1", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-1", pipeline_status: "new" }),
    validRecord({ source_job_id: "2", canonical_job_id: "onlinejobs.ph:2", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-2", pipeline_status: "processing", processing_stage: "evaluation", processing_token: "owner", processing_started_at: "2026-07-31T00:00:00.000Z" }),
    validRecord({ source_job_id: "3", canonical_job_id: "onlinejobs.ph:3", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-3", pipeline_status: "review_needed" }),
    validRecord({ source_job_id: "4", canonical_job_id: "onlinejobs.ph:4", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-4", pipeline_status: "review_needed", user_action: "Approve" }),
    validRecord({ source_job_id: "5", canonical_job_id: "onlinejobs.ph:5", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-5", pipeline_status: "review_needed", user_action: "Deny" }),
    validRecord({ source_job_id: "6", canonical_job_id: "onlinejobs.ph:6", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-6", pipeline_status: "ready_to_apply" }),
    validRecord({ source_job_id: "7", canonical_job_id: "onlinejobs.ph:7", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-7", pipeline_status: "ready_to_apply", user_action: "I Applied" }),
    validRecord({ source_job_id: "8", canonical_job_id: "onlinejobs.ph:8", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-8", pipeline_status: "ready_to_apply", user_action: "Skip" }),
    validRecord({ source_job_id: "9", canonical_job_id: "onlinejobs.ph:9", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-9", pipeline_status: "skip" }),
    validRecord({ source_job_id: "10", canonical_job_id: "onlinejobs.ph:10", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-10", pipeline_status: "error" }),
    validRecord({ source_job_id: "11", canonical_job_id: "onlinejobs.ph:11", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-11", pipeline_status: "unavailable" })
  ];
  const snapshot = {
    sheets: [
      { name: "Review Queue", headers: schema.fields, rows: records },
      { name: "Applied Jobs", headers: schema.fields, rows: [] },
      { name: "Archive", headers: schema.fields, rows: [] },
      { name: "Search Keywords", headers: ["enabled", "keyword"], rows: [] },
      { name: "_System", headers: review.sheets.system.fields, rows: [] }
    ]
  };
  const first = planSegmentedQueueMigration(snapshot, review, schema, "2026-07-31T01:00:00.000Z");
  const second = planSegmentedQueueMigration(snapshot, review, schema, "2026-07-31T01:00:00.000Z");
  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.deepEqual(first.counts, {
    "Scraped Jobs": 4,
    "To Review": 3,
    "To Apply": 3,
    "Applied Jobs": 0,
    Archive: 1
  });
  assert.deepEqual(first.planned_source_deletions, []);
  assert.deepEqual(first.sheet_actions[0], {
    type: "rename_sheet",
    from: "Review Queue",
    to: "Scraped Jobs"
  });
});

test("migration planner fails closed for duplicate, stale, malformed, and conflicting input", () => {
  const duplicate = validRecord();
  const base = {
    sheets: [
      { name: "Review Queue", headers: schema.fields, rows: [duplicate, { ...duplicate }] },
      { name: "Applied Jobs", headers: schema.fields, rows: [] },
      { name: "Archive", headers: schema.fields, rows: [] }
    ]
  };
  const duplicatePlan = planSegmentedQueueMigration(base, review, schema);
  assert.equal(duplicatePlan.ok, false);
  assert.deepEqual(duplicatePlan.routes, []);
  assert.deepEqual(duplicatePlan.planned_source_deletions, []);
  assert.ok(duplicatePlan.rejects.some((reject) => reject.category === "duplicate_identity"));

  for (const fixture of [
    {
      sheets: [{ name: "Review Queue", headers: ["wrong"], rows: [duplicate] }],
      category: "conflicting_headers"
    },
    {
      sheets: [{ name: "Review Queue", headers: schema.fields, rows: [{ ...duplicate, pipeline_status: "mystery" }] }],
      category: "unsupported_status"
    },
    {
      sheets: [{ name: "Review Queue", headers: schema.fields, rows: [{ ...duplicate, user_action: "Launch" }] }],
      category: "unsupported_action"
    },
    {
      sheets: [
        { name: "Review Queue", headers: schema.fields, rows: [duplicate] },
        { name: "Scraped Jobs", headers: schema.fields, rows: [] }
      ],
      category: "conflicting_source_sheet"
    },
    {
      sheets: [{ name: "Legacy Data", headers: ["x"], rows: [["private"]] }],
      category: "unexpected_sheet"
    }
  ]) {
    const plan = planSegmentedQueueMigration({ sheets: fixture.sheets }, review, schema);
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.routes, []);
    assert.ok(plan.rejects.some((reject) => reject.category === fixture.category));
  }
});
