import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildApplicationPack,
  buildApplicationRepairMessage,
  buildApplicationSystemMessage,
  buildApplicationUserMessage,
  evaluateJob,
  parseJobDetail
} from "../src/evaluation.mjs";
import {
  estimateGroqCostUsd,
  evaluateGroqBenchmark,
  groqInitialUserCharacterBudget,
  groqModelById,
  groqScheduledCapacity,
  resolveGroqGenerationModel,
  validateGroqPromptBudget,
  validateGroqProviderPolicy,
  validateGroqRuntimeCapacity
} from "../src/groq-provider.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const loadText = async (path) =>
  readFile(new URL(path, import.meta.url), "utf8");

const groqPolicy = await loadJson("../config/groq-provider-policy.json");
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson("../config/application-policy.json");
const rankingPolicy = await loadJson("../config/ranking-policy.json");
const packPolicy = await loadJson("../config/application-pack-policy.json");
const runtime = await loadJson("../config/runtime.json");
const directHtml = await loadText("./fixtures/job-direct.html");

test("Groq policy selects an approved production replacement and rejects unsafe selections", () => {
  assert.deepEqual(
    validateGroqProviderPolicy(groqPolicy, "2026-07-30T00:00:00.000Z"),
    []
  );
  const selected = resolveGroqGenerationModel(
    groqPolicy,
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(selected.id, "openai/gpt-oss-120b");
  assert.equal(selected.lifecycle, "production");
  assert.equal(selected.production_activation, "ready");
  assert.equal(selected.reasoning_effort, "low");
  assert.equal(groqPolicy.repair_model, "openai/gpt-oss-20b");
  assert.equal(
    groqModelById(groqPolicy, groqPolicy.repair_model).production_activation,
    "ready"
  );
  assert.equal(groqPolicy.generation.reasoning_format, "hidden");

  const unapproved = structuredClone(groqPolicy);
  unapproved.selected_model = "qwen/qwen3.6-27b";
  assert.match(
    validateGroqProviderPolicy(unapproved, "2026-07-30T00:00:00.000Z").join(
      "\n"
    ),
    /not approved/
  );

  const forbidden = structuredClone(groqPolicy);
  groqModelById(
    forbidden,
    forbidden.selected_model
  ).production_activation = "forbidden";
  assert.match(
    validateGroqProviderPolicy(forbidden, "2026-07-30T00:00:00.000Z").join(
      "\n"
    ),
    /not ready/
  );

  const expired = structuredClone(groqPolicy);
  const legacy = groqModelById(expired, "llama-3.3-70b-versatile");
  expired.selected_model = legacy.id;
  legacy.artifact_approved = true;
  legacy.lifecycle = "production";
  legacy.production_activation = "benchmark_required";
  assert.match(
    validateGroqProviderPolicy(expired, "2026-08-16T00:00:00.000Z").join("\n"),
    /shutdown date/
  );

  const unboundedProofs = structuredClone(groqPolicy);
  unboundedProofs.generation.maximum_prompt_proofs = 0;
  assert.match(
    validateGroqProviderPolicy(
      unboundedProofs,
      "2026-07-30T00:00:00.000Z"
    ).join("\n"),
    /maximum_prompt_proofs must be a positive integer/
  );

  const unsafeReasoning = structuredClone(groqPolicy);
  groqModelById(
    unsafeReasoning,
    "qwen/qwen3.6-27b"
  ).reasoning_effort = "high";
  unsafeReasoning.generation.reasoning_format = "raw";
  assert.match(
    validateGroqProviderPolicy(
      unsafeReasoning,
      "2026-07-30T00:00:00.000Z"
    ).join("\n"),
    /reasoning_format must be hidden|Qwen model .* invalid reasoning effort/
  );
});

test("Groq scheduled capacity stays within the conservative developer-base envelope", () => {
  const capacity = groqScheduledCapacity(groqPolicy, runtime.generator);
  assert.deepEqual(capacity, {
    initial_model_id: "openai/gpt-oss-120b",
    repair_model_id: "openai/gpt-oss-20b",
    initial_request_character_token_estimate: 1980,
    repair_request_character_token_estimate: 2314,
    per_item_character_token_estimate: 4294,
    maximum_scheduled_executions_per_day: 17,
    maximum_scheduled_requests_per_day: 170,
    maximum_scheduled_character_token_estimate_per_day: 364990,
    maximum_requests_in_any_minute: 3,
    maximum_character_token_estimate_in_any_minute: 6942,
    per_model_scheduled_capacity: [
      {
        model_id: "openai/gpt-oss-120b",
        maximum_scheduled_requests_per_day: 85,
        maximum_scheduled_character_token_estimate_per_day: 168300
      },
      {
        model_id: "openai/gpt-oss-20b",
        maximum_scheduled_requests_per_day: 85,
        maximum_scheduled_character_token_estimate_per_day: 196690
      }
    ],
    maximum_provider_pacing_milliseconds: 189000,
    maximum_candidate_pacing_milliseconds: 100000,
    maximum_pacing_milliseconds: 289000
  });
  assert.deepEqual(
    validateGroqRuntimeCapacity(groqPolicy, runtime.generator),
    []
  );

  const unsafePolicy = structuredClone(groqPolicy);
  unsafePolicy.generation.request_interval_ms = 1000;
  const unsafeRuntime = {
    ...runtime.generator,
    schedule_minutes: 15,
    per_run_cap: 5,
    execution_timeout_seconds: 90,
    candidate_pacing_delay_ms: 20000
  };
  const errors = validateGroqRuntimeCapacity(
    unsafePolicy,
    unsafeRuntime
  ).join("\n");
  assert.match(errors, /verified RPM limit|verified TPM limit/);

  unsafePolicy.generation.request_interval_ms = 65000;
  const capacityErrors = validateGroqRuntimeCapacity(
    unsafePolicy,
    unsafeRuntime
  ).join("\n");
  assert.match(capacityErrors, /verified TPD limit/);
  assert.match(capacityErrors, /exhausts the Generator execution timeout/);

  const oversizedRequest = structuredClone(groqPolicy);
  oversizedRequest.generation.maximum_combined_input_characters = 25000;
  const requestErrors = validateGroqRuntimeCapacity(
    oversizedRequest,
    runtime.generator
  ).join("\n");
  assert.match(requestErrors, /verified TPM limit/i);

  for (const [field, value, expected] of [
    ["requests_per_minute", 2, /120b.*RPM limit/i],
    ["tokens_per_minute", 6941, /120b.*TPM limit/i],
    ["requests_per_day", 84, /120b.*RPD limit/i],
    ["tokens_per_day", 168299, /120b.*TPD limit/i]
  ]) {
    const belowRequired = structuredClone(groqPolicy);
    groqModelById(
      belowRequired,
      belowRequired.selected_model
    ).developer_base_limits[field] = value;
    assert.match(
      validateGroqRuntimeCapacity(
        belowRequired,
        runtime.generator
      ).join("\n"),
      expected
    );
  }

  const sharedModelQuota = structuredClone(groqPolicy);
  sharedModelQuota.repair_model = sharedModelQuota.selected_model;
  sharedModelQuota.activation_gate.candidate_models = [
    sharedModelQuota.selected_model,
    "openai/gpt-oss-20b"
  ];
  assert.match(
    validateGroqRuntimeCapacity(
      sharedModelQuota,
      runtime.generator
    ).join("\n"),
    /120b.*TPD limit/i,
    "initial and repair traffic must combine when both roles share one quota"
  );
});

test("Groq prompt budget compacts canonical evidence and bounds oversized descriptions", () => {
  const parsed = parseJobDetail(directHtml, {
    source: "onlinejobs.ph",
    canonical_url:
      "https://onlinejobs.ph/jobseekers/job/full-stack-typescript-developer-2001",
    role_families: ["full-stack"]
  });
  const now = "2026-07-30T00:00:00.000Z";
  const job = {
    ...parsed,
    ...evaluateJob(parsed, profile, rankingPolicy, now)
  };
  const pack = buildApplicationPack(
    job,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const system = buildApplicationSystemMessage(profile, applicationPolicy);
  const userBudget = groqInitialUserCharacterBudget(groqPolicy, system);
  const user = buildApplicationUserMessage(job, pack, {
    maximumCharacters: userBudget,
    maximumProofs: groqPolicy.generation.maximum_prompt_proofs
  });
  const measurement = validateGroqPromptBudget(groqPolicy, system, user);

  assert.equal(measurement.valid, true);
  assert.ok(system.length < 6000);
  assert.equal(pack.selected_proofs.length, 3);
  assert.equal(groqPolicy.generation.maximum_prompt_proofs, 2);
  assert.equal(measurement.combined_characters, 4426);
  assert.equal(measurement.character_based_token_estimate, 1476);
  assert.ok(user.includes(pack.selected_proofs[0].reference));
  assert.ok(user.includes(pack.selected_proofs[1].reference));
  assert.equal(user.includes(pack.selected_proofs[2].reference), false);
  assert.doesNotMatch(user, /"label"|"relevance_score"/);
  assert.doesNotMatch(system, /12\+ production-blocking defects/);
  assert.match(
    system,
    /identity and selected approved proofs are the only\s+candidate facts/i
  );
  assert.doesNotMatch(user, /Job URL:/);
  assert.doesNotMatch(user, /SCREENING QUESTIONS REQUIRING MANUAL REVIEW/);
  assert.doesNotMatch(user, /APPLICATION WARNINGS — INTERNAL ONLY/);

  const oversized = buildApplicationUserMessage(
    job,
    { ...pack, safe_job_description: "TypeScript ".repeat(10000) },
    {
      maximumCharacters: userBudget,
      maximumProofs: groqPolicy.generation.maximum_prompt_proofs
    }
  );
  assert.equal(oversized.length, userBudget);
  assert.ok(oversized.endsWith("the system prompt."));
  assert.equal(
    validateGroqPromptBudget(groqPolicy, system, oversized).valid,
    true
  );

  const oversizedMetadata = buildApplicationUserMessage(
    {
      ...job,
      job_title: "Senior ".repeat(100),
      company: "Example Company ".repeat(100),
      requirement_gaps: Array.from(
        { length: 30 },
        (_, index) => `Unsupported requirement ${index}: ${"detail ".repeat(80)}`
      )
    },
    {
      ...pack,
      application_instructions: Array.from(
        { length: 30 },
        (_, index) => ({
          type: "manual_external_action",
          text: `Instruction ${index}: ${"manual step ".repeat(80)}`,
          value: "external value ".repeat(40)
        })
      ),
      screening_questions: Array.from(
        { length: 30 },
        (_, index) => ({
          text: `Question ${index}: ${"answer manually ".repeat(80)}`,
          answer_status: "manual_submission_required"
        })
      ),
      application_warnings: Array.from(
        { length: 30 },
        (_, index) => ({
          code: `review_${index}`,
          severity: "review",
          summary: `Warning ${index}: ${"review detail ".repeat(80)}`
        })
      ),
      safe_job_description: "TypeScript ".repeat(10000)
    },
    {
      maximumCharacters: userBudget,
      maximumProofs: groqPolicy.generation.maximum_prompt_proofs
    }
  );
  assert.equal(oversizedMetadata.length, userBudget);
  assert.equal(
    validateGroqPromptBudget(groqPolicy, system, oversizedMetadata).valid,
    true
  );
  assert.ok(oversizedMetadata.endsWith("the system prompt."));
  assert.match(oversizedMetadata, /SELECTED APPROVED PROOFS/);
  assert.doesNotMatch(
    oversizedMetadata,
    /application prompt metadata exceeds the provider budget/
  );

  const repair = buildApplicationRepairMessage(
    "Subject line: Developer Application\n\nI can work Pacific Time.",
    ["unsupported availability or schedule commitment"],
    {
      selectedProofs: pack.selected_proofs,
      applicationInstructions: pack.application_instructions
    }
  );
  assert.equal(validateGroqPromptBudget(groqPolicy, system, repair).valid, true);
  assert.ok(repair.includes(pack.selected_proofs[0].reference));
  assert.ok(repair.includes(pack.selected_proofs[1].reference));
  assert.doesNotMatch(repair, /SAFE JOB DESCRIPTION/);
  assert.throws(
    () => buildApplicationUserMessage(job, pack, { maximumProofs: 0 }),
    /proof limit/
  );
});

test("Groq benchmark assessment requires measured valid cases and calculates provider cost", () => {
  const selected = groqModelById(groqPolicy, groqPolicy.selected_model);
  assert.equal(
    estimateGroqCostUsd(selected, {
      input_tokens: 1000,
      cached_input_tokens: 200,
      output_tokens: 100
    }),
    0.000195
  );
  const cases = Array.from(
    { length: groqPolicy.activation_gate.minimum_cases_per_model },
    (_, index) => ({
      case: `case-${index + 1}`,
      valid: true,
      latency_ms: 100,
      input_tokens: 1000,
      output_tokens: 100
    })
  );
  const passing = evaluateGroqBenchmark(
    [
      { model: selected.id, cases },
      { model: groqPolicy.repair_model, cases }
    ],
    groqPolicy
  );
  assert.equal(passing[0].passes, true);
  assert.equal(passing[0].required_for_activation, true);
  assert.equal(passing[1].measured, true);
  assert.equal(passing[1].required_for_activation, true);

  cases[0] = { ...cases[0], valid: false };
  const failing = evaluateGroqBenchmark(
    [
      { model: selected.id, cases },
      { model: groqPolicy.repair_model, cases }
    ],
    groqPolicy
  );
  assert.equal(failing[0].passes, false);

  const comparisonOnlyFailure = evaluateGroqBenchmark(
    [
      {
        model: selected.id,
        cases: cases.map((entry) => ({ ...entry, valid: true }))
      },
      { model: groqPolicy.repair_model, cases }
    ],
    groqPolicy
  );
  assert.equal(comparisonOnlyFailure[0].passes, true);
  assert.equal(comparisonOnlyFailure[1].passes, false);
  assert.equal(comparisonOnlyFailure[1].measured, true);
});
