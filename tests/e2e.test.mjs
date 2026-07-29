import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  confirmArchiveDeletions,
  prepareArchiveCandidates
} from "../src/archive.mjs";
import {
  parseSearchResults,
  reconcileDiscovery,
  summarizeCoverage
} from "../src/discovery.mjs";
import {
  applyEvaluation,
  applyGeneratedApplicationPack,
  buildApplicationPack,
  evaluateJob,
  parseJobDetail,
  recordStageFailure,
  validateGeneratedMessage
} from "../src/evaluation.mjs";
import {
  applyManualAction,
  buildFunnelSummary,
  buildReviewQueueProjection,
  processReviewActions,
  reconcileReviewQueue
} from "../src/review.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");

const profile = await loadJson("../config/candidate-profile.json");
const policy = await loadJson("../config/application-policy.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const schema = await loadJson("../config/pipeline-schema.json");
const review = await loadJson("../config/review-sheet.json");
const plan = await loadJson("../config/search-plan.json");
const searchHtml = await loadText("./fixtures/search-page-1.html");
const detailHtml = await loadText("./fixtures/job-direct.html");

const discoveredAt = "2026-07-28T04:00:00.000Z";
const evaluatedAt = "2026-07-28T05:00:00.000Z";
const generatedAt = "2026-07-28T05:05:00.000Z";
const appliedAt = "2026-07-28T06:00:00.000Z";
const archivedAt = "2026-07-28T06:45:00.000Z";
const outcomeAt = "2026-07-30T03:00:00.000Z";

const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I reduced API response time from 800 milliseconds to 150 milliseconds by fixing N+1 query and schema bottlenecks, and I have shipped production features with TypeScript, React, Node.js, PostgreSQL, and Supabase. Rent N Roll also gave me direct experience building marketplace and PayMongo webhook workflows.

I can walk through the relevant implementation decisions in a short call.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

test("one job traverses discovery through archived outcome with one canonical identity", () => {
  const page = parseSearchResults(
    searchHtml,
    {
      query_id: "typescript",
      query: "typescript developer",
      role_family: "full-stack",
      evidence_refs: ["skills.languages:TypeScript"],
      page_number: 1,
      request_url: "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=typescript+developer"
    },
    { now: discoveredAt, lookbackDays: plan.lookback_days }
  );
  const discovery = reconcileDiscovery([page], [], [], schema, discoveredAt);
  assert.equal(discovery.new_jobs.length, 1);
  const discovered = { ...discovery.new_jobs[0], row_number: 2 };
  assert.equal(discovered.pipeline_status, "discovered");

  const parsedDetail = parseJobDetail(
    detailHtml.replaceAll("2001", "1001"),
    discovered
  );
  const enriched = {
    ...parsedDetail,
    job_description: `${parsedDetail.job_description} Choose any language: TypeScript, PHP, or Ruby.`
  };
  assert.equal(enriched.canonical_job_id, discovered.canonical_job_id);
  const evaluation = evaluateJob(enriched, profile, rankingPolicy, evaluatedAt);
  assert.equal(
    evaluation.requirement_gap_details.some((gap) =>
      /PHP|Ruby/.test(gap.requirement)
    ),
    false
  );
  const recommended = applyEvaluation(enriched, evaluation, evaluatedAt);
  assert.equal(recommended.pipeline_status, "recommended");
  assert.equal(recommended.canonical_job_id, discovered.canonical_job_id);

  assert.deepEqual(
    validateGeneratedMessage(validMessage, { job: recommended, profile, policy }),
    { valid: true, errors: [] }
  );
  const generating = { ...recommended, pipeline_status: "generating" };
  const pack = buildApplicationPack(
    generating,
    profile,
    policy,
    packPolicy,
    generatedAt
  );
  const ready = applyGeneratedApplicationPack(
    generating,
    pack,
    validMessage,
    profile,
    policy,
    packPolicy,
    generatedAt
  );
  assert.equal(ready.pipeline_status, "ready");
  assert.equal(ready.application_pack_status, "ready");
  assert.ok(ready.selected_proof_refs.length >= 2);
  assert.equal(ready.canonical_job_id, discovered.canonical_job_id);

  const activeReady = {
    ...ready,
    row_number: 2,
    apply_points_input: 10,
    application_message_strategy_input: "instruction-aware/v1"
  };
  const queue = buildReviewQueueProjection(
    [activeReady],
    schema,
    review,
    appliedAt
  );
  assert.equal(queue.rows.length, 1);
  assert.equal(queue.rows[0].Status, "ready");
  const queueAction = {
    ...queue.rows[0],
    row_number: 2,
    Action: "I Applied"
  };
  const reviewPlan = processReviewActions(
    [activeReady],
    [],
    schema,
    appliedAt,
    {
      profile,
      applicationPolicy: policy,
      packPolicy
    },
    {
      queueRows: [queueAction],
      reviewConfig: review,
      executionId: "e2e-review"
    }
  );
  assert.equal(reviewPlan.invalid_actions.length, 0);
  assert.equal(reviewPlan.active_updates.length, 1);
  const activeApplied = reviewPlan.active_updates[0];
  assert.equal(activeApplied.application_decision, "applied");
  assert.equal(activeApplied.apply_points_used, 10);
  assert.equal(activeApplied.application_snapshot_at, appliedAt);
  assert.equal(
    activeApplied.application_qualification_score,
    ready.qualification_score
  );
  const reconciledQueue = reconcileReviewQueue(
    [activeApplied],
    [queueAction],
    [queueAction],
    schema,
    review,
    appliedAt
  );
  assert.deepEqual(reconciledQueue.queue_rows, []);
  assert.deepEqual(reconciledQueue.delete_rows, [{ row_number: 2 }]);

  const archivePlan = prepareArchiveCandidates([activeApplied], [], schema, { now: archivedAt });
  assert.equal(archivePlan.candidates.length, 1);
  const archiveRecord = archivePlan.candidates[0].archive_record;
  assert.equal(archiveRecord.canonical_job_id, discovered.canonical_job_id);
  const confirmation = confirmArchiveDeletions(
    archivePlan.candidates,
    [activeApplied],
    [archiveRecord],
    schema,
    archivedAt
  );
  assert.deepEqual(confirmation.confirmed, [
    { row_number: 2, canonical_job_id: discovered.canonical_job_id }
  ]);

  const outcomeResult = applyManualAction(
    { ...archiveRecord, row_number: 2, manual_action: "outcome_offer" },
    schema,
    outcomeAt
  );
  assert.equal(outcomeResult.valid, true);
  assert.equal(outcomeResult.record.outcome, "offer");
  assert.equal(outcomeResult.record.application_decision, "applied");
  assert.equal(outcomeResult.record.generated_message, validMessage);
  assert.deepEqual(
    outcomeResult.record.outcome_events.map((event) => event.type),
    ["offer"]
  );

  const rediscovered = reconcileDiscovery(
    [page],
    [],
    [outcomeResult.record],
    schema,
    outcomeAt
  );
  assert.equal(rediscovered.new_jobs.length, 0);
  assert.equal(rediscovered.existing_updates.length, 1);
  assert.equal(rediscovered.existing_updates[0].record.outcome, "offer");

  const funnel = buildFunnelSummary([], [outcomeResult.record], schema, outcomeAt);
  assert.equal(funnel.total_unique_jobs, 1);
  assert.equal(funnel.recommended, 1);
  assert.equal(funnel.ready, 1);
  assert.equal(funnel.applied, 1);
  assert.equal(funnel.offer, 1);
});

test("partial discovery and invalid generation remain visibly incomplete", () => {
  const failedPage = {
    query_id: "react",
    query: "react developer",
    role_family: "frontend",
    page_number: 1,
    ok: false,
    jobs: [],
    excluded: [],
    malformed: [],
    error_category: "rate_limit"
  };
  const localPlan = {
    ...plan,
    queries: [
      {
        id: "react",
        query: "react developer",
        role_family: "frontend",
        enabled: true
      }
    ]
  };
  assert.equal(summarizeCoverage([failedPage], localPlan).status, "partial");

  const job = parseJobDetail(detailHtml, {
    canonical_url: "https://onlinejobs.ph/jobseekers/job/full-stack-typescript-developer-2001",
    pipeline_status: "generating",
    processing_stage: "generation",
    processing_token: "claim"
  });
  const invalid = validateGeneratedMessage(
    "I built FireCheck with WordPress. https://example.invalid",
    { job, profile, policy }
  );
  assert.equal(invalid.valid, false);
  const failed = recordStageFailure(
    { ...job, generated_message: "" },
    new Error(`validation: ${invalid.errors.join("; ")}`),
    {
      stage: "generation",
      now: generatedAt,
      maxAttempts: 3,
      backoffMs: 300000
    }
  );
  assert.equal(failed.pipeline_status, "terminal_error");
  assert.equal(failed.generated_message, "");
  assert.notEqual(failed.message_validation_status, "valid");
});
