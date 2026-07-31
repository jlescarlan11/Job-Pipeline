import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  advanceSearchPagination,
  buildNextSearchRequest,
  buildSearchRequests,
  createDiscoveryWindow,
  createKeywordSnapshot,
  parseSearchResults,
  reconcileDiscovery,
  summarizeCoverage,
  validateKeywordSheetRows,
  validateSearchPlan
} from "../src/discovery.mjs";
import { normalizeLegacyRecord } from "../src/contracts.mjs";

const plan = JSON.parse(
  await readFile(new URL("../config/search-plan.json", import.meta.url))
);
const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);
const review = JSON.parse(
  await readFile(new URL("../config/review-sheet.json", import.meta.url))
);
const keywordRows = review.sheets.search_keywords.initial_rows;
const keywordSnapshot = createKeywordSnapshot(keywordRows);

function card(id, title, postedAt, { omitDate = false } = {}) {
  return `<a href="/jobseekers/job/example-${id}">
    <div class="jobpost-cat-box">
      <h4>${title}</h4>
      ${omitDate ? "" : `<em data-temp="${postedAt}">Posted on ${postedAt}</em>`}
      <dd class="col">PHP 50,000</dd>
      <div class="desc">A plain listing description.</div>
    </div>
  </a>`;
}

function request(window, overrides = {}) {
  return {
    keyword_id: "react",
    keyword: "react developer",
    page_number: 1,
    request_url:
      "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=react%20developer",
    ...window,
    ...overrides
  };
}

function stored(id, overrides = {}) {
  const now = "2026-07-31T00:00:00.000Z";
  return normalizeLegacyRecord(
    {
      source: "onlinejobs.ph",
      source_job_id: String(id),
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url: `https://onlinejobs.ph/jobseekers/job/example-${id}`,
      record_version: 1,
      pipeline_status: "new",
      user_action: "",
      source_availability: "active",
      attempt_count: 0,
      matched_keywords: ["web developer"],
      created_at: now,
      updated_at: now,
      ...overrides
    },
    schema,
    now
  );
}

function businessStores(overrides = {}) {
  return {
    "Scraped Jobs": [],
    "To Review": [],
    "To Apply": [],
    "Applied Jobs": [],
    Archive: [],
    ...overrides
  };
}

test("search plan contains only fixed operational network bounds", () => {
  assert.deepEqual(validateSearchPlan(plan), []);
  assert.equal(plan.window_hours, 24);
  assert.equal("keywords" in plan, false);
  assert.equal(plan.max_pages_per_keyword, 3);
  assert.equal(plan.request_timeout_ms, 15000);
  assert.equal(plan.retry.max_attempts, 3);
  assert.ok(plan.request_interval_ms > 0);
  assert.match(
    validateSearchPlan({ ...plan, keywords: keywordSnapshot })[0],
    /must not embed runtime keywords/
  );
});

test("keyword sheet rows create one immutable normalized runtime snapshot", () => {
  const snapshot = createKeywordSnapshot([
    {},
    { row_number: 2, enabled: false },
    { row_number: 3, enabled: "FALSE", keyword: "paused developer" },
    { row_number: 4, enabled: true, keyword: "  Ｒｅａｃｔ Developer  " },
    { row_number: 5, enabled: "TRUE", keyword: "web developer" }
  ]);
  assert.deepEqual(snapshot, [
    {
      id: "sheet:react%20developer",
      keyword: "React Developer",
      enabled: true
    },
    {
      id: "sheet:web%20developer",
      keyword: "web developer",
      enabled: true
    }
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.ok(snapshot.every((entry) => Object.isFrozen(entry)));
  assert.equal(
    createKeywordSnapshot([
      { enabled: true, keyword: "React Developer" }
    ])[0].id,
    snapshot[0].id
  );
});

test("keyword sheet validation fails closed with bounded categories", () => {
  for (const [rows, expected] of [
    [[{}], "no_enabled_keywords"],
    [[{ enabled: true, keyword: " " }], "missing_enabled_keyword"],
    [[{ keyword: "react developer" }], "invalid_enabled_value"],
    [[{ enabled: "yes", keyword: "react developer" }], "invalid_enabled_value"],
    [[{ enabled: true, keyword: 123 }], "invalid_keyword_value"],
    [
      [
        { enabled: true, keyword: "React Developer" },
        { enabled: true, keyword: "ｒｅａｃｔ developer" }
      ],
      "duplicate_enabled_keyword"
    ],
    [[{ enabled: true, keyword: "react\u200bdeveloper" }], "keyword_contains_control_character"],
    [[{ enabled: true, keyword: "x".repeat(201) }], "keyword_too_long"],
    [[{ enabled: true, keyword: "react developer", extra: "unsafe" }], "invalid_keyword_headers"]
  ]) {
    const result = validateKeywordSheetRows(rows);
    assert.ok(result.errors.includes(expected), expected);
    assert.throws(
      () => createKeywordSnapshot(rows),
      (error) => {
        assert.match(error.message, new RegExp(expected));
        assert.doesNotMatch(error.message, /react developer|x{20}/i);
        return true;
      }
    );
  }
});

test("one immutable window is captured before every keyword request", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  assert.deepEqual(window, {
    window_start: "2026-07-30T10:30:00.000Z",
    window_end: "2026-07-31T10:30:00.000Z",
    window_hours: 24
  });
  const requests = buildSearchRequests(plan, keywordSnapshot, window);
  assert.ok(requests.length > 1);
  assert.ok(
    requests.every(
      (entry) =>
        entry.window_start === window.window_start &&
        entry.window_end === window.window_end
    )
  );
  assert.equal(Object.isFrozen(window), true);
});

test("inclusive 24-hour boundaries exclude one-millisecond-old and future jobs", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const html = [
    card(100, "At start", "2026-07-30T10:30:00.000Z"),
    card(101, "Inside", "2026-07-30T10:30:00.001Z"),
    card(102, "At end", "2026-07-31T10:30:00.000Z"),
    card(103, "Too old", "2026-07-30T10:29:59.999Z"),
    card(104, "Future", "2026-07-31T10:30:00.001Z")
  ].join("");
  const result = parseSearchResults(html, request(window));
  assert.deepEqual(
    result.jobs.map((job) => job.source_job_id),
    ["100", "101", "102"]
  );
  assert.deepEqual(
    result.excluded.map((entry) => entry.reason),
    ["outside_window_old", "future_dated"]
  );
});

test("missing and malformed source timestamps are reported distinctly", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const result = parseSearchResults(
    `${card(105, "Missing", "", { omitDate: true })}
     ${card(106, "Malformed", "not-a-date")}`,
    request(window)
  );
  assert.equal(result.jobs.length, 0);
  assert.deepEqual(
    result.malformed.map((entry) => entry.reason),
    ["missing_posted_at", "invalid_posted_at"]
  );
});

test("pagination retains the captured window and rejects window drift", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const page = {
    ...request(window),
    ok: true,
    has_next: true,
    jobs: [],
    excluded: [],
    malformed: []
  };
  const next = buildNextSearchRequest(page, plan);
  assert.equal(next.page_number, 2);
  assert.equal(next.window_start, window.window_start);
  assert.equal(next.window_end, window.window_end);
  assert.throws(
    () =>
      advanceSearchPagination(
        { ...window, page_results: [] },
        { ...page, window_end: "2026-07-31T10:31:00.000Z" },
        plan
      ),
    /changed the immutable execution window/
  );
});

test("multi-keyword results become one new Scraped Jobs record", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const first = parseSearchResults(
    card(200, "React Developer", "2026-07-31T09:00:00.000Z"),
    request(window)
  );
  const second = parseSearchResults(
    card(200, "React Developer", "2026-07-31T09:00:00.000Z"),
    request(window, {
      keyword_id: "web",
      keyword: "web developer",
      page_number: 2
    })
  );
  const result = reconcileDiscovery(
    [first, second],
    businessStores(),
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 1);
  assert.equal(result.new_jobs[0].pipeline_status, "new");
  assert.deepEqual(result.new_jobs[0].matched_keywords, [
    "react developer",
    "web developer"
  ]);
  assert.equal(result.new_jobs[0].posted_at, "2026-07-31T09:00:00.000Z");
  assert.equal(result.new_jobs[0].discovered_at, window.window_end);
});

test("rediscovery updates each active owner without resetting downstream state", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const page = parseSearchResults(
    [
      card(201, "New React Developer", "2026-07-31T09:00:00.000Z"),
      card(211, "Review React Developer", "2026-07-31T09:00:00.000Z"),
      card(221, "Ready React Developer", "2026-07-31T09:00:00.000Z")
    ].join(""),
    request(window)
  );
  const result = reconcileDiscovery(
    [page],
    businessStores({
      "Scraped Jobs": [
        { ...stored(201, { notes: "intake note" }), row_number: 7 }
      ],
      "To Review": [
        {
          ...stored(211, {
            pipeline_status: "review_needed",
            user_action: "Approve",
            decision_reason: "Needs a decision",
            required_input: "Confirm scope",
            review_approved_at: window.window_end,
            review_approval_note: "keep approval context",
            notes: "reviewer note"
          }),
          row_number: 8
        }
      ],
      "To Apply": [
        {
          ...stored(221, {
            pipeline_status: "ready_to_apply",
            user_action: "I Applied",
            generated_message: "Preserve this safe message",
            application_pack_status: "ready",
            alert_status: "sent",
            notes: "application note"
          }),
          row_number: 9
        }
      ]
    }),
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 0);
  assert.equal(result.active_updates.length, 3);
  const reviewUpdate = result.active_updates.find(
    (record) => record.owner_sheet === "To Review"
  );
  assert.equal(reviewUpdate.pipeline_status, "review_needed");
  assert.equal(reviewUpdate.user_action, "Approve");
  assert.equal(reviewUpdate.decision_reason, "Needs a decision");
  assert.equal(reviewUpdate.required_input, "Confirm scope");
  assert.equal(reviewUpdate.review_approval_note, "keep approval context");
  assert.equal(reviewUpdate.notes, "reviewer note");
  const applyUpdate = result.active_updates.find(
    (record) => record.owner_sheet === "To Apply"
  );
  assert.equal(applyUpdate.pipeline_status, "ready_to_apply");
  assert.equal(applyUpdate.user_action, "I Applied");
  assert.equal(applyUpdate.generated_message, "Preserve this safe message");
  assert.equal(applyUpdate.application_pack_status, "ready");
  assert.equal(applyUpdate.alert_status, "sent");
  assert.equal(applyUpdate.notes, "application note");
  assert.ok(result.active_updates.every((record) => record.record_version === 1));
});

test("Applied Jobs and Archive identities suppress rediscovery", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const pages = [
    parseSearchResults(
      `${card(202, "Applied", "2026-07-31T09:00:00.000Z")}
       ${card(203, "Archived", "2026-07-31T09:00:00.000Z")}`,
      request(window)
    )
  ];
  const result = reconcileDiscovery(
    pages,
    businessStores({
      "Applied Jobs": [
        stored(202, {
          pipeline_status: "ready_to_apply",
          user_action: "",
          applied_at: window.window_end
        })
      ],
      Archive: [
        stored(203, {
          pipeline_status: "skip",
          archived_at: window.window_end,
          archive_reason: "automatic_skip"
        })
      ]
    }),
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 0);
  assert.equal(result.terminal_suppressed, 2);
});

test("empty and unrecognized pages produce no placeholder jobs", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const empty = parseSearchResults(
    "<main>No jobs found</main>",
    request(window)
  );
  assert.equal(empty.ok, true);
  assert.equal(empty.jobs.length, 0);
  const login = parseSearchResults(
    "<form><h1>Sign in</h1></form>",
    request(window)
  );
  assert.equal(login.ok, false);
  assert.equal(login.error_category, "unexpected_search_page");
  assert.equal(login.jobs.length, 0);
});

test("failed later page retains earlier valid results and reports partial coverage", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const first = {
    ...parseSearchResults(
      card(204, "Valid", "2026-07-31T09:00:00.000Z"),
      request(window)
    ),
    has_next: true
  };
  const failed = {
    ...request(window, { page_number: 2 }),
    ok: false,
    jobs: [],
    excluded: [],
    malformed: [],
    result_card_count: 0,
    has_next: false,
    error_category: "request_timeout"
  };
  const result = reconcileDiscovery(
    [first, failed],
    businessStores(),
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 1);

  const singleKeywordSnapshot = [
    { id: "react", keyword: "react developer", enabled: true }
  ];
  const coverage = summarizeCoverage(
    [first, failed],
    plan,
    singleKeywordSnapshot
  );
  assert.equal(coverage.status, "partial");
  assert.equal(coverage.keywords[0].pages_succeeded, 1);
  assert.equal(coverage.keywords[0].pages_failed, 1);
});

test("cross-store ambiguity stops discovery before writes", () => {
  const duplicate = stored(205);
  assert.throws(
    () =>
      reconcileDiscovery(
        [],
        businessStores({
          "Scraped Jobs": [duplicate, { ...duplicate }]
        }),
        schema,
        "2026-07-31T10:30:00.000Z"
      ),
    /identity check failed/
  );
});

test("distinct discovered identities cannot alias the same canonical URL", () => {
  const first = stored(501, {
    matched_keywords: ["react developer"]
  });
  const second = stored(502, {
    canonical_url: first.canonical_url,
    matched_keywords: ["web developer"]
  });
  assert.throws(
    () =>
      reconcileDiscovery(
        [
          {
            ok: true,
            jobs: [first, second],
            malformed: [],
            excluded: []
          }
        ],
        businessStores(),
        schema,
        "2026-07-31T10:30:00.000Z"
      ),
    /ambiguous canonical URL identity/
  );
});
