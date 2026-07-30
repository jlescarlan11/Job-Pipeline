import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  advanceSearchPagination,
  buildNextSearchRequest,
  buildSearchRequests,
  createDiscoveryWindow,
  parseSearchResults,
  reconcileDiscovery,
  summarizeCoverage,
  validateSearchPlan
} from "../src/discovery.mjs";
import { normalizeLegacyRecord } from "../src/contracts.mjs";

const plan = JSON.parse(
  await readFile(new URL("../config/search-plan.json", import.meta.url))
);
const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);

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

test("search plan is simple keyword configuration with fixed network bounds", () => {
  assert.deepEqual(validateSearchPlan(plan), []);
  assert.equal(plan.window_hours, 24);
  assert.ok(plan.keywords.every((entry) => !("evidence_refs" in entry)));
  assert.ok(plan.keywords.every((entry) => !("role_family" in entry)));
  assert.equal(plan.max_pages_per_keyword, 3);
  assert.equal(plan.request_timeout_ms, 15000);
  assert.equal(plan.retry.max_attempts, 3);
  assert.ok(plan.request_interval_ms > 0);
});

test("one immutable window is captured before every keyword request", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  assert.deepEqual(window, {
    window_start: "2026-07-30T10:30:00.000Z",
    window_end: "2026-07-31T10:30:00.000Z",
    window_hours: 24
  });
  const requests = buildSearchRequests(plan, window);
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

test("multi-keyword results become one new Review Queue record", () => {
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
    [],
    [],
    [],
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

test("rediscovery updates provenance without resetting downstream state", () => {
  const window = createDiscoveryWindow("2026-07-31T10:30:00.000Z");
  const existing = stored(201, {
    pipeline_status: "ready_to_apply",
    user_action: "I Applied",
    generated_message: "Preserve this safe message",
    attempt_count: 2,
    alert_status: "sent",
    notes: "reviewer note"
  });
  const page = parseSearchResults(
    card(201, "React Developer", "2026-07-31T09:00:00.000Z"),
    request(window)
  );
  const result = reconcileDiscovery(
    [page],
    [{ ...existing, row_number: 7 }],
    [],
    [],
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 0);
  assert.equal(result.review_updates.length, 1);
  const updated = result.review_updates[0];
  assert.equal(updated.pipeline_status, "ready_to_apply");
  assert.equal(updated.user_action, "I Applied");
  assert.equal(updated.generated_message, "Preserve this safe message");
  assert.equal(updated.attempt_count, 2);
  assert.equal(updated.alert_status, "sent");
  assert.equal(updated.notes, "reviewer note");
  assert.equal(updated.record_version, 1);
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
    [],
    [stored(202, { applied_at: window.window_end })],
    [stored(203, { pipeline_status: "skip", archived_at: window.window_end })],
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
    [],
    [],
    [],
    schema,
    window.window_end
  );
  assert.equal(result.new_jobs.length, 1);

  const singleKeywordPlan = {
    ...plan,
    keywords: [{ id: "react", keyword: "react developer", enabled: true }]
  };
  const coverage = summarizeCoverage([first, failed], singleKeywordPlan);
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
        [duplicate],
        [{ ...duplicate }],
        [],
        schema,
        "2026-07-31T10:30:00.000Z"
      ),
    /identity check failed/
  );
});
