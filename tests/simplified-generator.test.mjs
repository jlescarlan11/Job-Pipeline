import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildApplicationPack,
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
  recordSourceFetchFailure,
  selectGeneratorCandidate
} from "../src/generator.mjs";
import {
  applicationReviewGuard,
  normalizeLegacyRecord,
  preparationInputGuard,
  reviewCaseId,
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
const noisyWebDeveloperDescription = await readFile(
  new URL("./fixtures/job-noisy-web-developer.txt", import.meta.url),
  "utf8"
);
const now = "2026-07-31T08:00:00.000Z";

const validMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

I build and maintain full-stack features for an online learning platform and diagnose production issues involving React, TypeScript, Node.js APIs, and PostgreSQL. Rent N Roll also gave me direct experience building marketplace and PayMongo webhook workflows.

I would welcome a conversation about how my experience fits this role.

LinkedIn: https://linkedin.com/in/john-lester-escarlan
GitHub: https://github.com/jlescarlan11
Portfolio: https://johnlesterescarlan.pro`;

const questionAwareValidMessage = `Subject line: Full-Stack TypeScript Developer Application — John Lester Escarlan

Hi there,

Question: Which production incident did you resolve?
Answer: One issue I resolved involved N+1 query and database schema bottlenecks, and fixing them reduced API response time from 800 milliseconds to 150 milliseconds on high-traffic endpoints.

I also delivered five production features using C# and ASP.NET Core MVC within an established client codebase.

I would welcome a conversation about how my experience fits this role.`;

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

function proceedForPreparation(record) {
  const unapproved = buildApplicationPack(
    { ...record, pipeline_status: "review_needed", user_action: "" },
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const reviewed = {
    ...record,
    application_instructions: unapproved.application_instructions,
    screening_questions: unapproved.screening_questions,
    requirement_coverage: unapproved.requirement_coverage,
    application_message_plan: [unapproved.message_plan],
    selected_proof_refs: unapproved.selected_proof_refs,
    application_warnings: unapproved.application_warnings,
    application_pack_status: unapproved.application_pack_status,
    application_pack_version: unapproved.application_pack_version,
    application_pack_profile_version: unapproved.application_pack_profile_version,
    application_pack_policy_version: unapproved.application_pack_policy_version,
    coverage_contract_version: unapproved.coverage_contract_version,
    message_plan_version: unapproved.message_plan.version,
    pipeline_status: "review_needed",
    user_action: "",
    prep_status: "",
    preparation_version: 0,
    preparation_input_guard: "",
    preparation_updated_at: ""
  };
  const proceeded = {
    ...reviewed,
    pipeline_status: "ready_to_apply",
    review_case_id: reviewCaseId(reviewed),
    review_case_version: "review-case-v1",
    review_decision: "proceed",
    review_decided_at: now,
    review_approved_at: now,
    review_approval_note: String(reviewed.notes || "").slice(0, 1000),
    review_approval_guard: applicationReviewGuard(reviewed),
    prep_status: "pending",
    preparation_version: 1,
    preparation_updated_at: now
  };
  proceeded.preparation_input_guard = preparationInputGuard(proceeded);
  proceeded.state_guard = stateGuard(proceeded);
  return proceeded;
}

function claim(record, stage = "evaluation", sourceStore = "Scraped Jobs") {
  return claimGeneratorRecord(
    record,
    stage,
    "execution-1",
    now,
    runtime.claim_lease_ms,
    sourceStore
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

test("combined Scraped Jobs and To Apply selection shares one deterministic cap", () => {
  const scraped = Array.from({ length: 3 }, (_, index) =>
    recordFromDescription(3250 + index, {
      overrides: { created_at: now }
    })
  );
  const toApply = Array.from({ length: 3 }, (_, index) =>
    proceedForPreparation(recordFromDescription(3260 + index, {
      overrides: { created_at: now }
    }))
  );
  const selected = selectGeneratorCandidate(
    { "Scraped Jobs": scraped, "To Apply": toApply },
    schema,
    runtime,
    now
  );
  assert.equal(selected.length, runtime.per_run_cap);
  assert.deepEqual(
    selected.slice(0, 3).map((entry) => entry.source_store),
    ["To Apply", "To Apply", "To Apply"]
  );
  assert.ok(selected.every((entry) => entry.stage));
  assert.ok(selected.every((entry) => !entry.record.processing_token));
});

test("paused preparation resumes only after a guarded material-input version advance", () => {
  const pending = proceedForPreparation(recordFromDescription(3270, {
    html: null,
    description:
      "Build infrastructure automation. Please describe verified Terraform experience."
  }));
  const claimed = claim(pending, "generation", "To Apply");
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  ).record;
  const paused = commitGeneratorResult(
    claimed,
    claimed,
    prepared,
    schema,
    now,
    "To Apply"
  );
  assert.equal(paused.prep_status, "needs_input");
  assert.deepEqual(
    selectGeneratorCandidate(
      { "Scraped Jobs": [], "To Apply": [paused] },
      schema,
      runtime,
      now
    ),
    []
  );

  const directlyChanged = {
    ...paused,
    job_description: `${paused.job_description} Verified profile evidence was added.`
  };
  directlyChanged.state_guard = stateGuard(directlyChanged);
  assert.deepEqual(
    selectGeneratorCandidate(
      { "Scraped Jobs": [], "To Apply": [directlyChanged] },
      schema,
      runtime,
      now
    ),
    []
  );

  const resumed = {
    ...directlyChanged,
    prep_status: "pending",
    preparation_version: paused.preparation_version + 1,
    preparation_updated_at: "2026-07-31T08:10:00.000Z"
  };
  resumed.preparation_input_guard = preparationInputGuard(resumed);
  resumed.state_guard = stateGuard(resumed);
  const [candidate] = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [resumed] },
    schema,
    runtime,
    "2026-07-31T08:11:00.000Z"
  );
  assert.equal(candidate.source_store, "To Apply");
  assert.equal(candidate.stage, "generation");
});

test("an expired To Apply preparation claim is recoverable without stranding the row", () => {
  const pending = proceedForPreparation(recordFromDescription(3271));
  const preparing = claim(pending, "generation", "To Apply");
  assert.equal(preparing.prep_status, "preparing");

  const beforeLeaseExpiry = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [preparing] },
    schema,
    runtime,
    new Date(Date.parse(now) + runtime.claim_lease_ms - 1).toISOString()
  );
  assert.deepEqual(beforeLeaseExpiry, []);

  const afterLeaseExpiry = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [preparing] },
    schema,
    runtime,
    new Date(Date.parse(now) + runtime.claim_lease_ms + 1).toISOString()
  );
  assert.equal(afterLeaseExpiry.length, 1);
  assert.equal(afterLeaseExpiry[0].source_store, "To Apply");
  assert.equal(afterLeaseExpiry[0].stage, "generation");
  assert.equal(afterLeaseExpiry[0].record.canonical_job_id, pending.canonical_job_id);
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
  assert.deepEqual(ready.requirement_coverage, prepared.pack.requirement_coverage);
  assert.deepEqual(ready.application_message_plan, [prepared.pack.message_plan]);
  assert.equal(
    ready.coverage_contract_version,
    packPolicy.coverage_contract_version
  );
  assert.equal(ready.message_plan_version, packPolicy.message_plan_version);
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

test("noisy supported requirements persist a non-skip Generator route", () => {
  const original = recordFromDescription(3021, {
    html: null,
    title: "Web Developer",
    description: noisyWebDeveloperDescription,
    overrides: { salary_text: "$7-10/hour" }
  });
  const result = evaluateAndRoute(
    claim(original),
    profile,
    rankingPolicy,
    now
  );

  assert.notEqual(result.pipeline_status, "skip");
  assert.ok(["processing", "review_needed"].includes(result.pipeline_status));
  assert.ok(result.qualification_score > 0);
  assert.deepEqual(result.requirement_gaps, [
    "GraphQL",
    "One of: Agile / Scrum"
  ]);
  assert.equal(result.error_category, "");
  assert.equal(result.error_summary, "");
  if (result.pipeline_status === "processing") {
    assert.equal(result.processing_stage, "generation");
  } else {
    assert.equal(result.processing_stage, "");
    assert.match(result.required_input, /Review these gaps/i);
  }
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

test("proceeded missing and partial coverage remain needs-input preparation outcomes", () => {
  const cases = [
    {
      id: 3060,
      description:
        "Build infrastructure automation for customers. Please describe your experience using Terraform.",
      warning: "missing_required_coverage",
      requiredInput: /Terraform/
    },
    {
      id: 3061,
      description:
        "Build customer products. Please describe a production e-commerce project you built.",
      warning: "partial_coverage_requires_review",
      requiredInput: /partially covers|Production status/i
    }
  ];
  for (const entry of cases) {
    const approved = proceedForPreparation(recordFromDescription(entry.id, {
      html: null,
      status: "review_needed",
      description: entry.description
    }));
    const prepared = prepareApplicationGeneration(
      claim(approved, "generation", "To Apply"),
      profile,
      applicationPolicy,
      packPolicy,
      groqPolicy,
      now
    );
    assert.equal(prepared.provider_required, false);
    assert.equal(prepared.record.pipeline_status, "ready_to_apply");
    assert.equal(prepared.record.prep_status, "needs_input");
    assert.equal(prepared.record.error_category, "");
    assert.match(prepared.record.required_input, entry.requiredInput);
    assert.ok(
      prepared.pack.application_warnings.some(
        (warning) =>
          warning.code === entry.warning && warning.review_acknowledged !== true
      )
    );
  }

  const staleMessageRecord = proceedForPreparation(recordFromDescription(3062, {
    html: null,
    status: "review_needed",
    description:
      "Build infrastructure automation for customers. Please describe your experience using Terraform.",
    overrides: {
      generated_message: validMessage,
      message_validation_status: "valid",
      message_profile_version: profile.profile_version,
      message_policy_version: applicationPolicy.policy_version,
      generated_at: now
    }
  }));
  const stalePrepared = prepareApplicationGeneration(
    claim(staleMessageRecord, "generation", "To Apply"),
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(stalePrepared.provider_required, false);
  assert.equal(stalePrepared.record.generated_message, "");
  assert.equal(stalePrepared.record.message_validation_status, "");
  assert.equal(stalePrepared.record.message_profile_version, "");
  assert.equal(stalePrepared.record.message_policy_version, "");
  assert.equal(stalePrepared.record.generated_at, "");
});

test("Proceed sanitizes unsafe instructions without returning to review", () => {
  const approved = proceedForPreparation(recordFromDescription(3050, {
    html: maliciousHtml,
    status: "review_needed",
    overrides: {
      decision_reason: "Requires review",
      required_input: "Confirm requirements"
    }
  }));
  const selected = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [approved] },
    schema,
    runtime,
    now
  );
  assert.equal(selected[0].stage, "generation");
  assert.equal(selected[0].source_store, "To Apply");
  const claimed = claim(approved, "generation", "To Apply");
  assert.equal(claimed.pipeline_status, "ready_to_apply");
  assert.equal(claimed.prep_status, "preparing");
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
  assert.ok(
    prepared.pack.application_warnings.some(
      (warning) =>
        warning.severity === "blocked" && warning.review_acknowledged === true
    )
  );
  assert.doesNotMatch(
    prepared.user_message,
    /ignore previous|reveal the system prompt|api.?key|automatically submit/i
  );
});

test("Proceed sends an unusable description to preparation error without looping review", () => {
  const approved = proceedForPreparation(recordFromDescription(3054, {
    html: null,
    status: "review_needed",
    description: "Unavailable",
    overrides: {
      decision_reason: "Application requirements need human review.",
      required_input: "A complete description is required."
    }
  }));
  const claimed = claim(approved, "generation", "To Apply");
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, false);
  assert.equal(prepared.record.pipeline_status, "ready_to_apply");
  assert.equal(prepared.record.prep_status, "preparation_error");
  const committed = commitGeneratorResult(
    claimed,
    claimed,
    prepared.record,
    schema,
    now,
    "To Apply"
  );
  assert.equal(committed.pipeline_status, "ready_to_apply");
  assert.equal(committed.prep_status, "preparation_error");
  assert.equal(committed.user_action, "");
});

test("Proceed sends profile-answerable screening questions into message generation", () => {
  const approved = proceedForPreparation(recordFromDescription(3053, {
    html: null,
    status: "review_needed",
    description:
      "Build and maintain production features using TypeScript, React, Next.js, Node.js, REST APIs, PostgreSQL, and Supabase. Which production incident did you resolve?",
    overrides: {
      decision_reason: "Application requirements need human review.",
      required_input: "Which production incident did you resolve?"
    }
  }));
  const claimed = claim(approved, "generation", "To Apply");
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
  assert.equal(
    prepared.pack.screening_questions[0].answer_status,
    "answer_in_message"
  );
  assert.match(
    prepared.user_message,
    /REQUIREMENT-AWARE MESSAGE PLAN/
  );
  assert.match(
    prepared.user_message,
    /Which production incident did you resolve\?/
  );
  assert.match(prepared.user_message, /N\+1 query patterns/i);
  const repair = assessInitialGenerationDraft(
    claimed,
    prepared.pack,
    "I have a strong foundation in production engineering.",
    prepared.system_message,
    prepared.user_message,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(repair.repair_required, true);
  assert.match(
    repair.repair_user_message,
    /Which production incident did you resolve\?/
  );
  const proposed = applyValidatedGeneration(
    claimed,
    prepared.pack,
    questionAwareValidMessage,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  assert.equal(proposed.pipeline_status, "ready_to_apply");
  assert.equal(proposed.prep_status, "message_ready");
  assert.equal(proposed.required_input, "");
  assert.match(proposed.decision_reason, /includes answers/i);
  assert.doesNotMatch(proposed.generated_message, /Question:|Answer:|\*\*/i);
  assert.match(proposed.generated_message, /One issue I resolved/i);
  const committed = commitGeneratorResult(
    claimed,
    claimed,
    proposed,
    schema,
    now,
    "To Apply"
  );
  assert.equal(committed.pipeline_status, "ready_to_apply");
  assert.equal(committed.user_action, "");
});

test("human-only employer actions become bounded external steps without provider work", () => {
  const proceeded = proceedForPreparation(recordFromDescription(3055, {
    html: null,
    status: "review_needed",
    description:
      "Build TypeScript, React, Node.js, and PostgreSQL features. What is your availability and when can you start?",
    overrides: {
      decision_reason: "Application requirements need human review.",
      required_input: "Confirm availability and start date."
    }
  }));
  const claimed = claim(proceeded, "generation", "To Apply");
  const prepared = prepareApplicationGeneration(
    claimed,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    now
  );
  assert.equal(prepared.provider_required, false);
  assert.equal(prepared.record.pipeline_status, "ready_to_apply");
  assert.equal(prepared.record.prep_status, "external_steps");
  assert.match(prepared.record.required_input, /availability|start/i);
  assert.equal(prepared.record.generated_message, "");
  assert.doesNotMatch(prepared.record.decision_reason, /completed|submitted/i);
  const committed = commitGeneratorResult(
    claimed,
    claimed,
    prepared.record,
    schema,
    now,
    "To Apply"
  );
  assert.deepEqual(
    selectGeneratorCandidate(
      { "Scraped Jobs": [], "To Apply": [committed] },
      schema,
      runtime,
      now
    ),
    []
  );
});

test("a temporary generation error retains final review resolution on retry", () => {
  const approved = proceedForPreparation(recordFromDescription(3054, {
    html: null,
    status: "review_needed",
    description:
      "Build and maintain production features using TypeScript, React, Next.js, Node.js, REST APIs, PostgreSQL, and Supabase. Which production incident did you resolve?",
    overrides: {
      decision_reason: "Application requirements need human review.",
      required_input: "Which production incident did you resolve?",
      application_pack_status: "review_required",
      application_pack_version: "2026-07-28/v1"
    }
  }));
  const firstClaim = claim(approved, "generation", "To Apply");
  const failedProposal = recordGeneratorFailure(
    firstClaim,
    new Error("temporary provider failure"),
    runtime,
    now
  );
  const failed = commitGeneratorResult(
    firstClaim,
    firstClaim,
    failedProposal,
    schema,
    now,
    "To Apply"
  );
  assert.equal(failed.pipeline_status, "ready_to_apply");
  assert.equal(failed.prep_status, "preparation_error");
  assert.equal(failed.user_action, "");
  const retryAt = new Date(
    Date.parse(now) + runtime.retry.backoff_ms + 1
  ).toISOString();
  const [retryCandidate] = selectGeneratorCandidate(
    { "Scraped Jobs": [], "To Apply": [failed] },
    schema,
    runtime,
    retryAt
  );
  assert.equal(retryCandidate.stage, "generation");
  const retryClaim = claimGeneratorRecord(
    failed,
    "generation",
    "retry-after-approved-review",
    retryAt,
    runtime.claim_lease_ms,
    "To Apply"
  ).record;
  const prepared = prepareApplicationGeneration(
    retryClaim,
    profile,
    applicationPolicy,
    packPolicy,
    groqPolicy,
    retryAt
  );
  assert.equal(prepared.provider_required, true);
  assert.equal(prepared.pack.application_pack_status, "ready");
  assert.equal(
    prepared.pack.screening_questions[0].review_acknowledged,
    true
  );
  assert.equal(prepared.pack.review_approved_at, now);
});

test("Proceed retains bounded reviewer context without trusting it as candidate proof", () => {
  const approved = proceedForPreparation(recordFromDescription(3051, {
    status: "review_needed",
    overrides: {
      notes: `Reviewer context ${"x".repeat(1200)}`,
      decision_reason: "Requires review",
      required_input: "Confirm requirements"
    }
  }));
  const claimed = claim(approved, "generation", "To Apply");
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

test("n8n socket hang ups are classified as provider timeouts", () => {
  const claimed = claim(recordFromDescription(3066));
  const failure = recordGeneratorFailure(
    claimed,
    new Error("socket hang up"),
    runtime,
    now
  );
  assert.equal(failure.error_category, "provider_timeout");
  assert.ok(failure.next_retry_at);
  assert.equal(failure.processing_stage, "");
});

test("permanent source HTTP failures become unavailable without retrying", () => {
  for (const status of [404, 410]) {
    const claimed = claim(recordFromDescription(3065 + status));
    const failure = recordSourceFetchFailure(
      claimed,
      new Error(`${status} - <!DOCTYPE html><html>listing removed</html>`),
      runtime,
      now
    );
    assert.equal(failure.pipeline_status, "unavailable");
    assert.equal(failure.source_availability, "unavailable");
    assert.equal(failure.error_category, "source_unavailable");
    assert.equal(failure.next_retry_at, "");
    assert.equal(failure.processing_token, "");
    assert.match(failure.error_summary, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(failure.error_summary, /DOCTYPE/);
  }

  const transient = recordSourceFetchFailure(
    claim(recordFromDescription(3470)),
    new Error("503 - temporary upstream failure"),
    runtime,
    now
  );
  assert.equal(transient.pipeline_status, "error");
  assert.ok(transient.next_retry_at);

  const pending = proceedForPreparation(recordFromDescription(3471));
  const preparationClaim = claim(pending, "generation", "To Apply");
  const preparationFailure = recordSourceFetchFailure(
    preparationClaim,
    new Error("404 - listing removed"),
    runtime,
    now
  );
  const committedPreparationFailure = commitGeneratorResult(
    preparationClaim,
    preparationClaim,
    preparationFailure,
    schema,
    now,
    "To Apply"
  );
  assert.equal(committedPreparationFailure.pipeline_status, "ready_to_apply");
  assert.equal(committedPreparationFailure.prep_status, "preparation_error");
  assert.equal(committedPreparationFailure.error_category, "source_unavailable");
  assert.equal(committedPreparationFailure.next_retry_at, "");
  assert.deepEqual(
    selectGeneratorCandidate(
      { "Scraped Jobs": [], "To Apply": [committedPreparationFailure] },
      schema,
      runtime,
      new Date(Date.parse(now) + runtime.retry.backoff_ms + 1).toISOString()
    ),
    []
  );
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
      // Production retries reread the committed result, whose commit boundary
      // refreshes the state guard. Model that persisted state explicitly.
      record.state_guard = stateGuard(record);
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

  for (const [field, value] of Object.entries({
    job_description: "A directly edited employer description",
    job_title: "A directly edited title"
  })) {
    const directlyEdited = {
      ...claimed,
      [field]: value,
      // Simulate a direct Sheet edit that did not recompute the stored guard.
      state_guard: claimed.state_guard
    };
    assert.throws(
      () =>
        commitGeneratorResult(
          directlyEdited,
          claimed,
          proposed,
          schema,
          now
        ),
      /stale or changed/,
      field
    );
  }

  const noteEdited = {
    ...claimed,
    notes: "A new operator note written during generation",
    state_guard: claimed.state_guard
  };
  const committed = commitGeneratorResult(
    noteEdited,
    claimed,
    proposed,
    schema,
    now
  );
  assert.equal(committed.notes, noteEdited.notes);

  const proceeded = proceedForPreparation(recordFromDescription(3081));
  const preparationClaim = claim(
    proceeded,
    "generation",
    "To Apply"
  );
  for (const [field, value] of Object.entries({
    review_case_id: `review-case-v1:${"b".repeat(64)}`,
    review_case_version: "",
    review_decision: "reject",
    review_decided_at: "2026-07-31T08:05:00.000Z",
    preparation_version: preparationClaim.preparation_version + 1,
    preparation_input_guard: `prep-v1:${"c".repeat(64)}`
  })) {
    const changed = { ...preparationClaim, [field]: value };
    changed.state_guard = stateGuard(changed);
    assert.throws(
      () =>
        commitGeneratorResult(
          changed,
          preparationClaim,
          preparationClaim,
          schema,
          now,
          "To Apply"
        ),
      /stale or changed To Apply state/,
      field
    );
  }
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
    /ambiguous duplicate identity across source stores/
  );
  for (const status of ["ready_to_apply", "skip", "unavailable"]) {
    const row = recordFromDescription(`31${status.length}`, { status });
    assert.deepEqual(
      selectGeneratorCandidate([row], schema, runtime, now),
      []
    );
  }
});
