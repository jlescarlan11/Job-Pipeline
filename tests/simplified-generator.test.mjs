import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseJobDetail
} from "../src/evaluation.mjs";
import {
  assessInitialGenerationDraft,
  applyValidatedGeneration,
  claimGeneratorRecord,
  commitGeneratorResult,
  confirmGeneratorClaimPersisted,
  confirmGeneratorResultPersisted,
  evaluateAndRoute,
  prepareApplicationGeneration,
  recordGeneratorFailure,
  selectGeneratorCandidate
} from "../src/generator.mjs";
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
const runtimeConfig = await loadJson("../config/runtime.json");
const runtime = runtimeConfig.generator;
const directHtml = await readFile(
  new URL("./fixtures/job-direct.html", import.meta.url),
  "utf8"
);
const maliciousHtml = await readFile(
  new URL("./fixtures/job-pack-malicious.html", import.meta.url),
  "utf8"
);
const now = "2026-07-31T08:00:00.000Z";

const validMessage = `Hi there,

I reduced API response time from 800 milliseconds to 150 milliseconds by fixing query and schema bottlenecks, and I have shipped production features with TypeScript, React, Node.js, PostgreSQL, and Supabase. Rent N Roll also gave me experience building marketplace and PayMongo webhook workflows.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

function recordFromDescription(
  id,
  {
    title = "Full-Stack TypeScript Developer",
    description,
    status = "new",
    action = "",
    html = directHtml,
    overrides = {}
  } = {}
) {
  const base = {
    source: "onlinejobs.ph",
    source_job_id: String(id),
    canonical_job_id: `onlinejobs.ph:${id}`,
    canonical_url: `https://onlinejobs.ph/jobseekers/job/example-${id}`,
    record_version: 1,
    pipeline_status: status,
    user_action: action,
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["full stack developer"],
    posted_at: "2026-07-31T07:00:00.000Z",
    discovered_at: "2026-07-31T07:10:00.000Z",
    created_at: "2026-07-31T07:10:00.000Z",
    updated_at: "2026-07-31T07:10:00.000Z",
    ...overrides
  };
  const detailed = html
    ? parseJobDetail(html, base)
    : { ...base, job_title: title, job_description: description };
  detailed.source_job_id = String(id);
  detailed.canonical_job_id = `onlinejobs.ph:${id}`;
  detailed.canonical_url =
    `https://onlinejobs.ph/jobseekers/job/example-${id}`;
  const normalized = normalizeLegacyRecord(detailed, schema, now);
  normalized.state_guard = stateGuard(normalized);
  return normalized;
}

function claim(record, stage = "evaluation") {
  return claimGeneratorRecord(
    record,
    stage,
    "execution-1",
    now,
    runtime.claim_lease_ms
  ).record;
}

test("new rows are claimed once in deterministic order", () => {
  const later = recordFromDescription(3002, {
    overrides: { created_at: "2026-07-31T07:20:00.000Z" }
  });
  const earlier = recordFromDescription(3001);
  const selected = selectGeneratorCandidate(
    [later, earlier],
    schema,
    runtime,
    now
  );
  assert.equal(selected.length, 2);
  assert.equal(selected[0].record.canonical_job_id, earlier.canonical_job_id);
  assert.equal(selected[0].stage, "evaluation");
  const firstClaim = claimGeneratorRecord(
    earlier,
    "evaluation",
    "execution-1",
    now,
    runtime.claim_lease_ms
  );
  assert.equal(firstClaim.claimed, true);
  const overlap = claimGeneratorRecord(
    firstClaim.record,
    "evaluation",
    "execution-2",
    "2026-07-31T08:01:00.000Z",
    runtime.claim_lease_ms
  );
  assert.equal(overlap.claimed, false);
  assert.deepEqual(
    selectGeneratorCandidate(
      [firstClaim.record, later],
      schema,
      runtime,
      "2026-07-31T08:01:00.000Z"
    ).map((entry) => entry.record.canonical_job_id),
    [later.canonical_job_id]
  );
  const expired = selectGeneratorCandidate(
    [firstClaim.record],
    schema,
    runtime,
    new Date(Date.parse(now) + runtime.claim_lease_ms + 1).toISOString()
  );
  assert.equal(expired.length, 1);
  assert.equal(expired[0].record.canonical_job_id, earlier.canonical_job_id);
  assert.equal(expired[0].stage, "evaluation");
});

test("selection freezes the first five eligible jobs and leaves a sixth untouched", () => {
  const rows = Array.from({ length: 6 }, (_, index) =>
    recordFromDescription(3201 + index, {
      overrides: {
        created_at: new Date(
          Date.parse("2026-07-31T07:00:00.000Z") + index * 60_000
        ).toISOString()
      }
    })
  );
  const selected = selectGeneratorCandidate(rows, schema, runtime, now);
  assert.deepEqual(
    selected.map((entry) => entry.record.canonical_job_id),
    rows.slice(0, 5).map((row) => row.canonical_job_id)
  );
  assert.equal(selected.length, 5);
  assert.equal(rows[5].pipeline_status, "new");
  assert.equal(rows[5].processing_token || "", "");

  for (let count = 0; count <= 4; count += 1) {
    assert.equal(
      selectGeneratorCandidate(rows.slice(0, count), schema, runtime, now)
        .length,
      count
    );
  }
});

test("five sequential candidates isolate a failed job and persist mixed outcomes", () => {
  const inputs = [
    recordFromDescription(3210),
    recordFromDescription(3211, {
      html: null,
      title: "Application Support Developer",
      description:
        "Maintain production JavaScript and SQL services. PHP is preferred."
    }),
    recordFromDescription(3212),
    recordFromDescription(3213, {
      html: null,
      title: "Senior WordPress Lead",
      description:
        "Five years of WordPress, Shopify, PHP, and Laravel are required."
    }),
    recordFromDescription(3214, {
      html: null,
      description: "",
      overrides: { source_availability: "unavailable" }
    })
  ].map((row, index) => ({
    ...row,
    created_at: new Date(
      Date.parse("2026-07-31T07:00:00.000Z") + index * 60_000
    ).toISOString()
  }));
  for (const row of inputs) row.state_guard = stateGuard(row);

  const selected = selectGeneratorCandidate(inputs, schema, runtime, now);
  const results = [];
  for (const [index, entry] of selected.entries()) {
    const claimed = claimGeneratorRecord(
      entry.record,
      entry.stage,
      `batch-execution:${index}`,
      now,
      runtime.claim_lease_ms
    ).record;
    let proposed;
    try {
      if (index === 2) throw new Error("provider timeout");
      const evaluated = evaluateAndRoute(
        claimed,
        profile,
        rankingPolicy,
        now
      );
      if (
        evaluated.pipeline_status === "processing" &&
        evaluated.processing_stage === "generation"
      ) {
        const prepared = prepareApplicationGeneration(
          evaluated,
          profile,
          applicationPolicy,
          packPolicy,
          groqPolicy,
          now
        );
        proposed = prepared.provider_required
          ? applyValidatedGeneration(
              evaluated,
              prepared.pack,
              validMessage,
              profile,
              applicationPolicy,
              packPolicy,
              now
            )
          : prepared.record;
      } else {
        proposed = evaluated;
      }
    } catch (error) {
      proposed = recordGeneratorFailure(claimed, error, runtime, now);
    }
    results.push(
      commitGeneratorResult(claimed, claimed, proposed, schema, now)
    );
  }

  assert.equal(results.length, 5);
  assert.deepEqual(
    new Set(results.map((record) => record.pipeline_status)),
    new Set([
      "ready_to_apply",
      "review_needed",
      "error",
      "skip",
      "unavailable"
    ])
  );
  assert.equal(
    results.filter((record) => record.generated_message).length,
    1
  );
  assert.equal(new Set(results.map((record) => record.canonical_job_id)).size, 5);
  assert.equal(results[2].pipeline_status, "error");
  assert.equal(results.filter((_, index) => index !== 2).length, 4);
});

test("a Generator claim must be reread exactly before model or commit work", () => {
  const original = recordFromDescription(3220);
  const planned = claim(original);
  const claimFields = [
    "canonical_job_id",
    "pipeline_status",
    "record_version",
    "state_guard",
    "processing_stage",
    "processing_token",
    "processing_started_at",
    "review_approved_at",
    "review_approval_note",
    "updated_at"
  ];
  assert.equal(
    confirmGeneratorClaimPersisted(
      planned,
      [{ ...planned }],
      schema,
      claimFields
    ).processing_token,
    planned.processing_token
  );
  assert.throws(
    () =>
      confirmGeneratorClaimPersisted(
        planned,
        [{ ...planned, processing_token: "another-owner" }],
        schema,
        claimFields
      ),
    /claim confirmation mismatch/
  );
  assert.throws(
    () =>
      confirmGeneratorClaimPersisted(
        planned,
        [{ ...planned, notes: "operator changed this row" }],
        schema,
        claimFields
    ),
    /claim confirmation mismatch/
  );
  assert.throws(
    () =>
      confirmGeneratorClaimPersisted(
        planned,
        [{ ...planned }, { ...planned, row_number: 8 }],
        schema,
        claimFields
      ),
    /identity is missing or ambiguous/
  );
});

test("strong fit proceeds to generation, then only validated output becomes ready", () => {
  const original = recordFromDescription(3010);
  const claimed = claim(original);
  const evaluated = evaluateAndRoute(claimed, profile, rankingPolicy, now);
  assert.equal(evaluated.pipeline_status, "processing");
  assert.equal(evaluated.processing_stage, "generation");
  assert.ok(evaluated.qualification_score >= 0);
  assert.ok(evaluated.decision_reason);

  const prepared = prepareApplicationGeneration(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, true);
  assert.equal(prepared.pack.application_pack_status, "ready");
  const ready = applyValidatedGeneration(
    evaluated,
    prepared.pack,
    validMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  assert.equal(ready.pipeline_status, "ready_to_apply");
  assert.equal(ready.message_validation_status, "valid");
  assert.equal(ready.message_profile_version, profile.profile_version);
  assert.equal(
    ready.message_policy_version,
    applicationPolicy.policy_version
  );
  const committed = commitGeneratorResult(
    claimed,
    claimed,
    ready,
    schema,
    now
  );
  assert.equal(committed.pipeline_status, "ready_to_apply");
  assert.equal(committed.processing_token, "");
  assert.equal(committed.record_version, claimed.record_version + 1);
});

test("promising gaps route to review_needed with reason and required input", () => {
  const original = recordFromDescription(3020, {
    html: null,
    title: "Application Support Developer",
    description:
      "Maintain a production application, monitor incidents, and support JavaScript and SQL services. Experience with PHP would be useful."
  });
  const claimed = claim(original);
  const result = evaluateAndRoute(claimed, profile, rankingPolicy, now);
  assert.equal(result.pipeline_status, "review_needed");
  assert.match(result.decision_reason, /PHP|Gaps/i);
  assert.match(result.required_input, /Review these gaps/i);
  assert.equal(result.generated_message, "");
});

test("hard disqualifiers become skip, while unavailable input is distinct", () => {
  const hard = recordFromDescription(3030, {
    html: null,
    title: "Senior WordPress Lead",
    description:
      "Lead the team. Five years of WordPress, Shopify, PHP, and Laravel production experience is required."
  });
  assert.equal(
    evaluateAndRoute(claim(hard), profile, rankingPolicy, now).pipeline_status,
    "skip"
  );

  const unavailable = recordFromDescription(3031, {
    html: null,
    description: "",
    overrides: { source_availability: "unavailable" }
  });
  const unavailableResult = evaluateAndRoute(
    claim(unavailable),
    profile,
    rankingPolicy,
    now
  );
  assert.equal(unavailableResult.pipeline_status, "unavailable");
  assert.match(unavailableResult.required_input, /source listing/i);
});

test("unsafe or incomplete application packs never call the provider", () => {
  const malicious = recordFromDescription(3040, { html: maliciousHtml });
  const claimed = claim(malicious);
  const evaluated = {
    ...claimed,
    pipeline_status: "processing",
    processing_stage: "generation",
    decision_reason: "Promising match"
  };
  const prepared = prepareApplicationGeneration(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, false);
  assert.equal(prepared.record.pipeline_status, "review_needed");
  assert.notEqual(prepared.record.application_pack_status, "ready");
  assert.equal(prepared.record.generated_message, "");
  assert.doesNotMatch(
    JSON.stringify(prepared.record.application_warnings),
    /ignore previous|system prompt|api.?key/i
  );
});

test("Approve reconsiders through the same pack and message gates", () => {
  const approved = recordFromDescription(3050, {
    html: maliciousHtml,
    status: "review_needed",
    action: "Approve",
    overrides: {
      decision_reason: "Requires review",
      required_input: "Confirm requirements"
    }
  });
  const selected = selectGeneratorCandidate(
    [approved],
    schema,
    runtime,
    now
  );
  assert.equal(selected[0].stage, "generation");
  const claimed = claim(approved, "generation");
  assert.equal(claimed.pipeline_status, "review_needed");
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, false);
  assert.equal(prepared.record.pipeline_status, "review_needed");
});

test("Approve snapshots bounded reviewer evidence without trusting it as candidate proof", () => {
  const approved = recordFromDescription(3051, {
    status: "review_needed",
    action: "Approve",
    overrides: {
      notes: `Reviewer context ${"x".repeat(1200)}`,
      decision_reason: "Requires review",
      required_input: "Confirm requirements"
    }
  });
  const claimed = claim(approved, "generation");
  assert.equal(claimed.review_approved_at, now);
  assert.equal(claimed.review_approval_note.length, 1000);
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  if (prepared.provider_required) {
    assert.match(prepared.user_message, /OPERATOR REVIEW CONTEXT/);
    assert.match(prepared.user_message, /UNTRUSTED, NOT CANDIDATE EVIDENCE/);
  }
});

test("one invalid initial draft gets one bounded repair and no validation bypass", () => {
  const claimed = claim(recordFromDescription(3052));
  const evaluated = evaluateAndRoute(claimed, profile, rankingPolicy, now);
  const prepared = prepareApplicationGeneration(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  const invalidDraft = "I have a strong foundation in every required skill.";
  const repair = assessInitialGenerationDraft(
    evaluated,
    prepared.pack,
    invalidDraft,
    prepared.system_message,
    prepared.user_message,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(repair.repair_required, true);
  assert.match(repair.repair_user_message, new RegExp(invalidDraft));
  assert.ok(repair.validation_errors.length > 0);
  assert.throws(
    () =>
      applyValidatedGeneration(
        evaluated,
        prepared.pack,
        invalidDraft,
        profile,
        applicationPolicy,
        packPolicy,
        now
      ),
    /not ready/
  );
  const repaired = applyValidatedGeneration(
    evaluated,
    prepared.pack,
    validMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  assert.equal(repaired.pipeline_status, "ready_to_apply");

  const validInitial = assessInitialGenerationDraft(
    evaluated,
    prepared.pack,
    validMessage,
    prepared.system_message,
    prepared.user_message,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(validInitial.repair_required, false);
  assert.equal(validInitial.proposed_record.generated_message, validMessage);
});

test("exhausted rows are not selected and committed writes are verified exactly", () => {
  const exhausted = recordFromDescription(3053, {
    status: "error",
    overrides: {
      processing_stage: "generation",
      error_category: "provider_failure_exhausted",
      next_retry_at: ""
    }
  });
  assert.deepEqual(
    selectGeneratorCandidate([exhausted], schema, runtime, now),
    []
  );

  const committed = recordFromDescription(3054, {
    status: "review_needed",
    overrides: { decision_reason: "Persisted result" }
  });
  const fields = schema.fields.filter((field) => field !== "notes");
  assert.equal(
    confirmGeneratorResultPersisted(
      committed,
      [{ ...committed }],
      schema,
      fields
    ).canonical_job_id,
    committed.canonical_job_id
  );
  assert.throws(
    () =>
      confirmGeneratorResultPersisted(
        committed,
        [{ ...committed, decision_reason: "Partial write" }],
        schema,
        fields
      ),
    /persisted field mismatch/
  );
});

test("invalid model output is error evidence and preserves a prior safe message", () => {
  const prior = recordFromDescription(3060, {
    status: "error",
    overrides: {
      processing_stage: "generation",
      generated_message: "Previously validated message",
      message_validation_status: "valid",
      next_retry_at: ""
    }
  });
  const claimed = claim(prior, "generation");
  const failure = recordGeneratorFailure(
    claimed,
    new Error("validation failed: unsupported skill"),
    runtime,
    now
  );
  assert.equal(failure.pipeline_status, "error");
  assert.equal(failure.generated_message, "Previously validated message");
  assert.equal(failure.message_validation_status, "valid");
  assert.match(failure.error_category, /validation_failure/);
  assert.ok(failure.next_retry_at);
  assert.equal(failure.processing_stage, "");
  assert.equal(failure.processing_token, "");
  assert.equal(failure.processing_started_at, "");
});

test("HTTP 404 bodies cannot be misclassified as provider authentication failures", () => {
  const claimed = claim(recordFromDescription(3065));
  const failure = recordGeneratorFailure(
    claimed,
    new Error("404 - <html><body>unrelated 403 forbidden footer text</body></html>"),
    runtime,
    now
  );
  assert.equal(failure.error_category, "provider_failure");
  assert.equal(failure.processing_stage, "");
});

test("provider failures are bounded, observable, and sanitized", () => {
  let record = claim(recordFromDescription(3070));
  for (let attempt = 1; attempt <= runtime.retry.max_attempts; attempt += 1) {
    record = recordGeneratorFailure(
      record,
      new Error(
        "Authorization: Bearer secret-token timeout https://private.example/hook"
      ),
      runtime,
      now
    );
    assert.equal(record.attempt_count, attempt);
    assert.doesNotMatch(record.error_summary, /secret-token|private\.example/);
    if (attempt < runtime.retry.max_attempts) {
      assert.ok(record.next_retry_at);
      record = claimGeneratorRecord(
        record,
        "evaluation",
        `retry-${attempt}`,
        new Date(Date.parse(now) + runtime.retry.backoff_ms + 1).toISOString(),
        runtime.claim_lease_ms
      ).record;
    }
  }
  assert.match(record.error_category, /exhausted/);
  assert.equal(record.next_retry_at, "");
});

test("stale or concurrent state cannot be committed over a user edit", () => {
  const claimed = claim(recordFromDescription(3080));
  const proposed = {
    ...claimed,
    pipeline_status: "review_needed",
    decision_reason: "Needs confirmation",
    required_input: "Confirm the gap",
    processing_stage: ""
  };
  assert.throws(
    () =>
      commitGeneratorResult(
        {
          ...claimed,
          user_action: "Deny",
          record_version: claimed.record_version + 1
        },
        claimed,
        proposed,
        schema,
        now
      ),
    /stale or changed/
  );
});

test("forged actions and terminal rows never enter generator selection", () => {
  const forged = recordFromDescription(3090, {
    status: "new",
    action: "Approve"
  });
  assert.throws(
    () => selectGeneratorCandidate([forged], schema, runtime, now),
    /rejected invalid Scraped Jobs row/
  );
  const duplicate = recordFromDescription(3091);
  assert.throws(
    () =>
      selectGeneratorCandidate(
        [duplicate, { ...duplicate }],
        schema,
        runtime,
        now
      ),
    /duplicate Scraped Jobs identity/
  );
  for (const status of ["ready_to_apply", "skip", "unavailable"]) {
    const row = recordFromDescription(`31${status.length}`, { status });
    assert.deepEqual(
      selectGeneratorCandidate([row], schema, runtime, now),
      []
    );
  }
});
