import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSearchRequests,
  parseSearchResults,
  reconcileDiscovery,
  summarizeCoverage,
  validateSearchPlan
} from "../src/discovery.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const profile = await loadJson("../config/candidate-profile.json");
const plan = await loadJson("../config/search-plan.json");
const schema = await loadJson("../config/pipeline-schema.json");
const page1Html = await loadText("./fixtures/search-page-1.html");
const page2Html = await loadText("./fixtures/search-page-2.html");
const emptyHtml = await loadText("./fixtures/search-empty.html");
const now = "2026-07-28T04:00:00.000Z";

const request = (queryId, query, roleFamily, pageNumber) => ({
  query_id: queryId,
  query,
  role_family: roleFamily,
  evidence_refs: ["summary"],
  page_number: pageNumber,
  request_url: "https://onlinejobs.ph/example"
});

test("search plan is profile-traceable and emits every configured page", () => {
  assert.deepEqual(validateSearchPlan(plan, profile), []);
  const requests = buildSearchRequests(plan);
  assert.equal(
    requests.length,
    plan.queries.filter((query) => query.enabled).length * plan.max_pages_per_query
  );
  assert.match(requests[1].request_url, /jobsearch\/30/);
  assert.match(requests[1].request_url, /jobkeyword=/);
});

test("search parser preserves card alignment and excludes senior jobs", () => {
  const parsed = parseSearchResults(
    page1Html,
    request("typescript", "typescript developer", "full-stack", 1),
    { now, lookbackDays: 7 }
  );
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0].job_title, "Full Stack TypeScript Developer");
  assert.equal(parsed.jobs[0].source_job_id, "1001");
  assert.equal(parsed.jobs[0].salary_text, "PHP 60,000 / month");
  assert.equal(parsed.excluded.length, 1);
  assert.equal(parsed.excluded[0].source_job_id, "1002");
  assert.equal(parsed.malformed.length, 1);
  assert.equal(parsed.has_next, true);
});

test("multi-page and multi-query discoveries merge into one canonical record", () => {
  const first = parseSearchResults(
    page1Html,
    request("typescript", "typescript developer", "full-stack", 1),
    { now, lookbackDays: 7 }
  );
  const second = parseSearchResults(
    page2Html,
    request("react", "react developer", "frontend", 2),
    { now, lookbackDays: 7 }
  );
  const reconciled = reconcileDiscovery([first, second], [], [], schema, now);
  assert.equal(reconciled.new_jobs.length, 2);
  const duplicate = reconciled.new_jobs.find((job) => job.source_job_id === "1001");
  assert.deepEqual(duplicate.search_queries.sort(), ["react developer", "typescript developer"]);
  assert.deepEqual(duplicate.role_families.sort(), ["frontend", "full-stack"]);
});

test("active and archive legacy records prevent rediscovery without losing manual state", () => {
  const parsed = parseSearchResults(
    page1Html,
    request("typescript", "typescript developer", "full-stack", 1),
    { now, lookbackDays: 7 }
  );
  const active = [
    {
      row_number: 4,
      job_url: "https://www.onlinejobs.ph/jobseekers/job/full-stack-typescript-developer-1001",
      status: "ready",
      generated_message: "Keep this message",
      search_queries: "legacy query"
    }
  ];
  const reconciled = reconcileDiscovery([parsed], active, [], schema, now);
  assert.equal(reconciled.new_jobs.length, 0);
  assert.equal(reconciled.existing_updates.length, 1);
  const update = reconciled.existing_updates[0].record;
  assert.equal(update.pipeline_status, "ready");
  assert.equal(update.generated_message, "Keep this message");
  assert.deepEqual(update.search_queries.sort(), ["legacy query", "typescript developer"]);
});

test("empty, failed, complete, and capped query coverage are distinguishable", () => {
  const localPlan = {
    ...plan,
    max_pages_per_query: 2,
    queries: [
      { id: "complete", query: "complete", role_family: "full-stack", enabled: true },
      { id: "empty", query: "empty", role_family: "frontend", enabled: true },
      { id: "failed", query: "failed", role_family: "backend-api", enabled: true },
      { id: "capped", query: "capped", role_family: "automation", enabled: true }
    ]
  };
  const complete1 = parseSearchResults(page1Html, request("complete", "complete", "full-stack", 1), {
    now,
    lookbackDays: 7
  });
  const complete2 = parseSearchResults(page2Html, request("complete", "complete", "full-stack", 2), {
    now,
    lookbackDays: 7
  });
  const empty = parseSearchResults(emptyHtml, request("empty", "empty", "frontend", 1), {
    now,
    lookbackDays: 7
  });
  const capped1 = { ...complete1, query_id: "capped" };
  const capped2 = { ...complete2, query_id: "capped", has_next: true };
  const failed = {
    ...request("failed", "failed", "backend-api", 1),
    ok: false,
    jobs: [],
    excluded: [],
    malformed: [],
    error_category: "timeout"
  };
  const coverage = summarizeCoverage([complete1, complete2, empty, failed, capped1, capped2], localPlan);
  const byId = Object.fromEntries(coverage.queries.map((query) => [query.query_id, query]));
  assert.equal(byId.complete.status, "complete");
  assert.equal(byId.empty.status, "empty");
  assert.equal(byId.failed.status, "failed");
  assert.equal(byId.capped.status, "partial");
  assert.equal(byId.capped.stop_reason, "page_limit");
  assert.equal(coverage.status, "partial");
});

test("a failed page does not discard successful query results", () => {
  const parsed = parseSearchResults(
    page1Html,
    request("typescript", "typescript developer", "full-stack", 1),
    { now, lookbackDays: 7 }
  );
  const failure = {
    ...request("automation", "automation developer", "automation", 1),
    ok: false,
    jobs: [],
    excluded: [],
    malformed: [],
    error_category: "rate_limit"
  };
  const reconciled = reconcileDiscovery([parsed, failure], [], [], schema, now);
  assert.equal(reconciled.new_jobs.length, 1);
});

test("duplicate query configuration and invalid dates fail deterministically", () => {
  const duplicatePlan = {
    ...plan,
    queries: [
      plan.queries[0],
      { ...plan.queries[1], id: plan.queries[0].id, query: plan.queries[0].query }
    ]
  };
  assert.match(validateSearchPlan(duplicatePlan, profile).join("\n"), /duplicate search query id/);
  assert.match(validateSearchPlan(duplicatePlan, profile).join("\n"), /duplicate search query text/);

  const invalidDateHtml = `
    <a href="/jobseekers/job/invalid-date-9001">
      <div class="jobpost-cat-box">
        <h4>TypeScript Developer</h4>
        <em>Posted on not-a-date</em>
      </div>
    </a>`;
  const parsed = parseSearchResults(
    invalidDateHtml,
    request("typescript", "typescript developer", "full-stack", 1),
    { now, lookbackDays: 7 }
  );
  assert.equal(parsed.jobs.length, 0);
  assert.deepEqual(parsed.malformed, [
    {
      url_path: "/jobseekers/job/invalid-date-9001",
      reason: "invalid_posted_at"
    }
  ]);
});
