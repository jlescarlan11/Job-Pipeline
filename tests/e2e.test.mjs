import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applySlackProviderResult,
  markAlertSending,
  renderSlackAlert,
  selectFreshAlertCandidates
} from "../src/alerter-mover.mjs";
import {
  createDiscoveryWindow,
  parseSearchResults,
  reconcileDiscovery
} from "../src/discovery.mjs";
import { parseJobDetail } from "../src/evaluation.mjs";
import {
  applyValidatedGeneration,
  claimGeneratorRecord,
  commitGeneratorResult,
  evaluateAndRoute,
  prepareApplicationGeneration
} from "../src/generator.mjs";
import {
  confirmMoveDeletions,
  destinationWrites,
  planQueueActions
} from "../src/movement.mjs";
import {
  normalizeLegacyRecord,
  stateGuard
} from "../src/contracts.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const schema = await loadJson("../config/pipeline-schema.json");
const profile = await loadJson("../config/candidate-profile.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const groqPolicy = await loadJson("../config/groq-provider-policy.json");
const runtime = (await loadJson("../config/runtime.json")).generator;
const alertPolicy = await loadJson("../config/alert-policy.json");
const directHtml = await readFile(
  new URL("./fixtures/job-direct.html", import.meta.url),
  "utf8"
);
const now = "2026-07-31T12:00:00.000Z";
const window = createDiscoveryWindow(now);
const safetyContext = { profile, applicationPolicy, packPolicy };
const validMessage = `Hi there,

I reduced API response time from 800 milliseconds to 150 milliseconds by fixing query and schema bottlenecks, and I have shipped production features with TypeScript, React, Node.js, PostgreSQL, and Supabase. Rent N Roll also gave me experience building marketplace and PayMongo webhook workflows.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

function searchCard(id, postedAt) {
  return `<a href="/jobseekers/job/full-stack-${id}">
    <div class="jobpost-cat-box">
      <h4>Full-Stack TypeScript Developer</h4>
      <em data-temp="${postedAt}">Posted on ${postedAt}</em>
      <dd class="col">PHP 70,000 / month</dd>
      <div class="desc">Build production TypeScript applications.</div>
    </div>
  </a>`;
}

test("fresh lifecycle reaches alert, manual applied move, outcome store, and dedup suppression", () => {
  const request = {
    keyword_id: "full-stack",
    keyword: "full stack developer",
    page_number: 1,
    request_url: "https://www.onlinejobs.ph/jobseekers/jobsearch",
    ...window
  };
  const page = parseSearchResults(
    searchCard(6001, "2026-07-31T11:00:00.000Z"),
    request
  );
  const discovery = reconcileDiscovery(
    [page],
    [],
    [],
    [],
    schema,
    now
  );
  assert.equal(discovery.new_jobs.length, 1);
  let active = {
    ...discovery.new_jobs[0],
    row_number: 2
  };
  assert.equal(active.pipeline_status, "new");

  active = parseJobDetail(directHtml, active);
  active.source_job_id = "6001";
  active.canonical_job_id = "onlinejobs.ph:6001";
  active.canonical_url =
    "https://onlinejobs.ph/jobseekers/job/full-stack-6001";
  const claimed = claimGeneratorRecord(
    active,
    "evaluation",
    "generator-e2e",
    now,
    runtime.claim_lease_ms
  ).record;
  const evaluated = evaluateAndRoute(
    claimed,
    profile,
    rankingPolicy,
    now
  );
  assert.equal(evaluated.pipeline_status, "processing");
  const prepared = prepareApplicationGeneration(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, true);
  const proposedReady = applyValidatedGeneration(
    evaluated,
    prepared.pack,
    validMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const ready = commitGeneratorResult(
    claimed,
    claimed,
    proposedReady,
    schema,
    now
  );
  assert.equal(ready.pipeline_status, "ready_to_apply");

  const alerts = selectFreshAlertCandidates(
    [ready],
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(alerts.candidates.length, 1);
  const sending = markAlertSending(
    ready,
    alertPolicy,
    "alerter-e2e",
    now
  );
  const payload = renderSlackAlert(sending, alertPolicy, {
    reviewUrl:
      "https://docs.google.com/spreadsheets/d/fresh-workbook/edit",
    messageSafetyContext: safetyContext
  });
  assert.match(payload.text, /Application message — copy exactly/);
  const sent = applySlackProviderResult(
    sending,
    sending,
    { ok: true, reference: "e2e-slack" },
    alertPolicy,
    now
  );
  assert.equal(sent.alert_status, "sent");

  const actioned = { ...sent, user_action: "I Applied", row_number: 2 };
  actioned.state_guard = stateGuard(actioned);
  const movement = planQueueActions(
    [actioned],
    [],
    [],
    schema,
    now,
    safetyContext
  );
  const writes = destinationWrites(movement);
  assert.equal(writes.applied.length, 1);
  const applied = { ...writes.applied[0], row_number: 2 };
  const confirmation = confirmMoveDeletions(
    movement,
    [actioned],
    [applied],
    [],
    schema
  );
  assert.equal(confirmation.deletions.length, 1);

  const rediscovered = reconcileDiscovery(
    [page],
    [],
    [applied],
    [],
    schema,
    "2026-07-31T13:00:00.000Z"
  );
  assert.equal(rediscovered.new_jobs.length, 0);
  assert.equal(rediscovered.terminal_suppressed, 1);
});

test("review approval never bypasses generation and denial archives once", () => {
  const reviewRecord = {
    source: "onlinejobs.ph",
    source_job_id: "6010",
    canonical_job_id: "onlinejobs.ph:6010",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/application-support-6010",
    row_number: 4,
    record_version: 1,
    pipeline_status: "review_needed",
    user_action: "Approve",
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["application support engineer"],
    match_reasons: ["Promising support experience"],
    requirement_gaps: ["PHP"],
    selected_proof_refs: [],
    application_instructions: [],
    screening_questions: [],
    application_warnings: [],
    decision_reason: "Promising with one preference gap",
    required_input: "Confirm PHP is optional",
    created_at: now,
    updated_at: now
  };
  const approved = normalizeLegacyRecord(reviewRecord, schema, now);
  approved.state_guard = stateGuard(approved);
  const approvalPlan = planQueueActions([approved], [], [], schema, now);
  assert.equal(approvalPlan.moves.length, 0);
  assert.equal(approvalPlan.generation_requests.length, 1);

  const denied = {
    ...approved,
    user_action: "Deny",
    record_version: approved.record_version + 1
  };
  denied.state_guard = stateGuard(denied);
  const denialPlan = planQueueActions([denied], [], [], schema, now);
  const archive = destinationWrites(denialPlan).archive[0];
  assert.equal(archive.archive_reason, "review_denied");
  assert.equal(archive.decision_reason, denied.decision_reason);
  assert.deepEqual(archive.requirement_gaps, denied.requirement_gaps);
  const confirmed = confirmMoveDeletions(
    denialPlan,
    [denied],
    [],
    [{ ...archive, row_number: 2 }],
    schema
  );
  assert.equal(confirmed.deletions.length, 1);
});
