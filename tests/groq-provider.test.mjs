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
  resolveGroqGenerationModel,
  validateGroqPromptBudget,
  validateGroqProviderPolicy
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
  assert.equal(selected.production_activation, "benchmark_required");

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
    /forbidden/
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
    maximumCharacters: userBudget
  });
  const measurement = validateGroqPromptBudget(groqPolicy, system, user);

  assert.equal(measurement.valid, true);
  assert.ok(system.length < 6000);
  assert.ok(measurement.combined_characters < 10000);
  assert.doesNotMatch(system, /12\+ production-blocking defects/);
  assert.match(system, /selected approved proofs are the only candidate facts/i);
  assert.doesNotMatch(user, /Job URL:/);
  assert.doesNotMatch(user, /SCREENING QUESTIONS REQUIRING MANUAL REVIEW/);
  assert.doesNotMatch(user, /APPLICATION WARNINGS — INTERNAL ONLY/);

  const oversized = buildApplicationUserMessage(
    job,
    { ...pack, safe_job_description: "TypeScript ".repeat(10000) },
    { maximumCharacters: userBudget }
  );
  assert.equal(oversized.length, userBudget);
  assert.match(oversized, /final message satisfying the system prompt\.$/);
  assert.equal(
    validateGroqPromptBudget(groqPolicy, system, oversized).valid,
    true
  );

  const repair = `${user}\n\n${buildApplicationRepairMessage(
    "Subject line: Developer Application\n\nI can work Pacific Time.",
    ["unsupported availability or schedule commitment"]
  )}`;
  assert.equal(validateGroqPromptBudget(groqPolicy, system, repair).valid, true);
  assert.ok(repair.includes(user), "repair must reuse the exact initial evidence packet");
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
    [{ model: selected.id, cases }],
    groqPolicy
  );
  assert.equal(passing[0].passes, true);

  cases[0] = { ...cases[0], valid: false };
  const failing = evaluateGroqBenchmark(
    [{ model: selected.id, cases }],
    groqPolicy
  );
  assert.equal(failing[0].passes, false);
});
