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
  buildSearchRequests,
  createKeywordSnapshot,
  createDiscoveryWindow,
  parseSearchResults,
  reconcileDiscovery
} from "../src/discovery.mjs";
import { buildApplicationPack, parseJobDetail } from "../src/evaluation.mjs";
import {
  applyValidatedGeneration,
  claimGeneratorRecord,
  commitGeneratorResult,
  evaluateAndRoute,
  prepareApplicationGeneration,
  recordGeneratorFailure,
  selectGeneratorCandidate
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
const searchPlan = await loadJson("../config/search-plan.json");
const directHtml = await readFile(
  new URL("./fixtures/job-direct.html", import.meta.url),
  "utf8"
);
const now = "2026-07-31T12:00:00.000Z";
const window = createDiscoveryWindow(now);
const safetyContext = { profile, applicationPolicy, packPolicy };

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
const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I build and maintain full-stack features for an online learning platform and diagnose production issues involving React, TypeScript, Node.js APIs, and PostgreSQL. Rent N Roll also gave me direct experience building marketplace and PayMongo webhook workflows.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

const questionAwareValidMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

The production incident I resolved involved N+1 query and database schema bottlenecks, and fixing them reduced API response time from 800 milliseconds to 150 milliseconds on high-traffic endpoints.

I also delivered five production features using C# and ASP.NET Core MVC within an established client codebase.

I would welcome a conversation about how my experience fits this role.`;

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
  const keywordSnapshot = createKeywordSnapshot([
    { enabled: true, keyword: " full stack developer " },
    { enabled: false, keyword: "disabled keyword" }
  ]);
  const [request] = buildSearchRequests(
    searchPlan,
    keywordSnapshot,
    window
  );
  assert.equal(request.keyword, "full stack developer");
  assert.doesNotMatch(request.request_url, /disabled/i);
  const page = parseSearchResults(
    searchCard(6001, "2026-07-31T11:00:00.000Z"),
    request
  );
  const discovery = reconcileDiscovery(
    [page],
    businessStores(),
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

  const readyRoute = planQueueActions(
    businessStores({ "Scraped Jobs": [ready] }),
    schema,
    now,
    safetyContext
  );
  const readyToApply = {
    ...destinationWrites(readyRoute).to_apply[0],
    row_number: 2
  };
  assert.equal(readyRoute.moves[0].destination, "To Apply");

  const alerts = selectFreshAlertCandidates(
    [readyToApply],
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(alerts.candidates.length, 1);
  const sending = markAlertSending(
    readyToApply,
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
    businessStores({ "To Apply": [actioned] }),
    schema,
    now,
    safetyContext
  );
  const writes = destinationWrites(movement);
  assert.equal(writes.applied.length, 1);
  const applied = { ...writes.applied[0], row_number: 2 };
  const confirmation = confirmMoveDeletions(
    movement,
    businessStores({
      "To Apply": [actioned],
      "Applied Jobs": [applied]
    }),
    schema
  );
  assert.equal(confirmation.deletions.length, 1);

  const rediscovered = reconcileDiscovery(
    [page],
    businessStores({ "Applied Jobs": [applied] }),
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
  const approvalPlan = planQueueActions(
    businessStores({ "To Review": [approved] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(approvalPlan.moves.length, 1);
  assert.equal(approvalPlan.moves[0].destination, "Scraped Jobs");
  const returned = destinationWrites(approvalPlan).scraped_jobs[0];
  assert.equal(returned.user_action, "Approve");
  assert.equal(returned.review_approved_at, now);
  assert.equal(
    selectGeneratorCandidate([returned], schema, runtime, now).length,
    1
  );

  const denied = {
    ...approved,
    user_action: "Deny",
    record_version: approved.record_version + 1
  };
  denied.state_guard = stateGuard(denied);
  const denialPlan = planQueueActions(
    businessStores({ "To Review": [denied] }),
    schema,
    now,
    safetyContext
  );
  const archive = destinationWrites(denialPlan).archive[0];
  assert.equal(archive.archive_reason, "review_denied");
  assert.equal(archive.decision_reason, denied.decision_reason);
  assert.deepEqual(archive.requirement_gaps, denied.requirement_gaps);
  const confirmed = confirmMoveDeletions(
    denialPlan,
    businessStores({
      "To Review": [denied],
      Archive: [{ ...archive, row_number: 2 }]
    }),
    schema
  );
  assert.equal(confirmed.deletions.length, 1);
});

test("approved review-only questions complete the route to To Apply", () => {
  const parsed = parseJobDetail(directHtml, {
    source: "onlinejobs.ph",
    source_job_id: "6011",
    canonical_job_id: "onlinejobs.ph:6011",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/full-stack-6011",
    row_number: 5,
    record_version: 1,
    pipeline_status: "review_needed",
    user_action: "Approve",
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["full stack developer"],
    decision_reason: "Application requirements need human review.",
    required_input: "Which production incident did you resolve?",
    created_at: now,
    updated_at: now
  });
  parsed.source_job_id = "6011";
  parsed.canonical_job_id = "onlinejobs.ph:6011";
  parsed.canonical_url =
    "https://onlinejobs.ph/jobseekers/job/full-stack-6011";
  parsed.job_description +=
    " Which production incident did you resolve? You must attach a PDF resume.";
  const reviewPack = buildApplicationPack(
    { ...parsed, user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  Object.assign(parsed, {
    application_instructions: reviewPack.application_instructions,
    screening_questions: reviewPack.screening_questions,
    requirement_coverage: reviewPack.requirement_coverage,
    application_message_plan: [reviewPack.message_plan],
    selected_proof_refs: reviewPack.selected_proof_refs,
    application_warnings: reviewPack.application_warnings,
    application_pack_status: reviewPack.application_pack_status,
    application_pack_version: reviewPack.application_pack_version,
    application_pack_profile_version: reviewPack.application_pack_profile_version,
    application_pack_policy_version: reviewPack.application_pack_policy_version,
    coverage_contract_version: reviewPack.coverage_contract_version,
    message_plan_version: reviewPack.message_plan.version,
    application_pack_generated_at: reviewPack.application_pack_generated_at
  });
  const approved = normalizeLegacyRecord(parsed, schema, now);
  approved.state_guard = stateGuard(approved);

  const approvalPlan = planQueueActions(
    businessStores({ "To Review": [approved] }),
    schema,
    now,
    safetyContext
  );
  const returned = destinationWrites(approvalPlan).scraped_jobs[0];
  const claimed = claimGeneratorRecord(
    returned,
    "generation",
    "generator-approved-review",
    now,
    runtime.claim_lease_ms
  ).record;
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, true);
  assert.equal(prepared.pack.application_pack_status, "ready");
  assert.match(prepared.user_message, /REQUIREMENT-AWARE MESSAGE PLAN/);
  assert.match(
    prepared.user_message,
    /Which production incident did you resolve\?/
  );
  assert.match(prepared.user_message, /Delivered five production features/i);
  assert.match(prepared.user_message, /N\+1 query patterns/i);
  const proposed = applyValidatedGeneration(
    claimed,
    prepared.pack,
    questionAwareValidMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const ready = commitGeneratorResult(
    claimed,
    claimed,
    proposed,
    schema,
    now
  );
  const applyPlan = planQueueActions(
    businessStores({ "Scraped Jobs": [ready] }),
    schema,
    now,
    safetyContext
  );
  assert.equal(applyPlan.moves.length, 1);
  assert.equal(applyPlan.moves[0].destination, "To Apply");
  const toApply = {
    ...destinationWrites(applyPlan).to_apply[0],
    row_number: 2
  };
  assert.equal(toApply.pipeline_status, "ready_to_apply");
  assert.match(toApply.required_input, /manual submission/i);
  assert.match(toApply.required_input, /required attachment/i);
  assert.equal(
    toApply.screening_questions[0].answer_status,
    "answer_in_message"
  );
  const alerts = selectFreshAlertCandidates(
    [toApply],
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(alerts.candidates.length, 1);
  const payload = renderSlackAlert(toApply, alertPolicy, {
    reviewUrl:
      "https://docs.google.com/spreadsheets/d/fresh-workbook/edit",
    messageSafetyContext: safetyContext
  });
  assert.match(payload.text, /Which production incident did you resolve\?/);
});

test("a five-job Generator batch isolates one failure and downstream alerts never replay", () => {
  const rows = Array.from({ length: 6 }, (_, index) => {
    const id = 6101 + index;
    const parsed = parseJobDetail(directHtml, {
      source: "onlinejobs.ph",
      source_job_id: String(id),
      canonical_job_id: `onlinejobs.ph:${id}`,
      canonical_url:
        `https://onlinejobs.ph/jobseekers/job/full-stack-${id}`,
      record_version: 1,
      pipeline_status: "new",
      user_action: "",
      source_availability: "active",
      attempt_count: 0,
      alert_attempt_count: 0,
      matched_keywords: ["full stack developer"],
      posted_at: "2026-07-31T11:00:00.000Z",
      discovered_at: "2026-07-31T11:05:00.000Z",
      created_at: new Date(
        Date.parse("2026-07-31T11:05:00.000Z") + index * 1000
      ).toISOString(),
      updated_at: "2026-07-31T11:05:00.000Z"
    });
    parsed.source_job_id = String(id);
    parsed.canonical_job_id = `onlinejobs.ph:${id}`;
    parsed.canonical_url =
      `https://onlinejobs.ph/jobseekers/job/full-stack-${id}`;
    const normalized = normalizeLegacyRecord(parsed, schema, now);
    normalized.state_guard = stateGuard(normalized);
    return normalized;
  });

  const selected = selectGeneratorCandidate(rows, schema, runtime, now);
  assert.equal(selected.length, 5);
  assert.equal(
    selected.some(
      (entry) =>
        entry.record.canonical_job_id === rows[5].canonical_job_id
    ),
    false
  );

  const completed = selected.map((entry, index) => {
    const claimed = claimGeneratorRecord(
      entry.record,
      entry.stage,
      `generator-batch-e2e-${index}`,
      now,
      runtime.claim_lease_ms
    ).record;
    let proposed;
    if (index === 2) {
      proposed = recordGeneratorFailure(
        claimed,
        new Error("controlled provider timeout"),
        runtime,
        now
      );
    } else {
      const evaluated = evaluateAndRoute(
        claimed,
        profile,
        rankingPolicy,
        now
      );
      const prepared = prepareApplicationGeneration(
        evaluated,
        profile,
        applicationPolicy,
        packPolicy,
        groqPolicy,
        now
      );
      proposed = applyValidatedGeneration(
        evaluated,
        prepared.pack,
        validMessage,
        profile,
        applicationPolicy,
        packPolicy,
        now
      );
    }
    return commitGeneratorResult(
      claimed,
      claimed,
      proposed,
      schema,
      now
    );
  });

  assert.deepEqual(
    completed.map((record) => record.pipeline_status),
    [
      "ready_to_apply",
      "ready_to_apply",
      "error",
      "ready_to_apply",
      "ready_to_apply"
    ]
  );
  assert.equal(
    new Set(completed.map((record) => record.canonical_job_id)).size,
    5
  );
  assert.equal(rows[5].pipeline_status, "new");
  assert.equal(rows[5].processing_token || "", "");

  const routing = planQueueActions(
    businessStores({ "Scraped Jobs": completed }),
    schema,
    now,
    safetyContext
  );
  const toApply = destinationWrites(routing).to_apply;
  assert.equal(toApply.length, 4);
  const firstAlertRun = selectFreshAlertCandidates(
    toApply,
    schema,
    alertPolicy,
    now,
    safetyContext
  );
  assert.equal(firstAlertRun.candidates.length, 4);
  const sent = firstAlertRun.candidates.map(({ record }, index) => {
    const sending = markAlertSending(
      record,
      alertPolicy,
      `alerter-batch-e2e-${index}`,
      now
    );
    return applySlackProviderResult(
      sending,
      sending,
      { ok: true, reference: `batch-slack-${index}` },
      alertPolicy,
      now
    );
  });
  const repeatedAlertRun = selectFreshAlertCandidates(
    sent,
    schema,
    alertPolicy,
    "2026-07-31T12:01:00.000Z",
    safetyContext
  );
  assert.equal(repeatedAlertRun.candidates.length, 0);
  assert.equal(
    repeatedAlertRun.rejected.filter((entry) =>
      entry.reasons.includes("already_sent")
    ).length,
    4
  );
});
