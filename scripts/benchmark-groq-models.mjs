import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  buildApplicationPack,
  buildApplicationRepairMessage,
  buildApplicationSystemMessage,
  buildApplicationUserMessage,
  evaluateJob,
  parseJobDetail,
  validateApplicationPack,
  validateGeneratedMessage
} from "../src/evaluation.mjs";
import {
  estimateGroqCostUsd,
  evaluateGroqBenchmark,
  groqInitialUserCharacterBudget,
  groqModelById,
  resolveGroqGenerationModel,
  validateGroqPromptBudget
} from "../src/groq-provider.mjs";

const root = new URL("..", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
const readText = async (path) => readFile(new URL(path, root), "utf8");
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const benchmarkFixtures = [
  {
    id: "direct",
    path: "tests/fixtures/job-direct.html",
    role_families: ["full-stack"]
  },
  {
    id: "adjacent",
    path: "tests/fixtures/job-adjacent.html",
    role_families: ["production-support"]
  },
  {
    id: "instructions",
    path: "tests/fixtures/job-instructions.html",
    role_families: ["full-stack"]
  }
];

function usageFromResponse(response) {
  return {
    input_tokens: Number(response?.usage?.prompt_tokens) || 0,
    cached_input_tokens:
      Number(response?.usage?.prompt_tokens_details?.cached_tokens) || 0,
    output_tokens: Number(response?.usage?.completion_tokens) || 0
  };
}

async function requestCompletion({
  apiKey,
  model,
  policy,
  systemMessage,
  userMessage,
  fetchImpl = fetch
}) {
  const started = performance.now();
  const response = await fetchImpl(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage }
        ],
        temperature: policy.generation.temperature,
        max_tokens: policy.generation.maximum_output_tokens
      })
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const category =
      response.status === 429
        ? "rate_limit"
        : response.status === 403
          ? "model_permission"
          : response.status >= 500
            ? "provider_error"
            : "request_rejected";
    throw new Error(`${category}: HTTP ${response.status}`);
  }
  return {
    message: String(payload?.choices?.[0]?.message?.content || "").trim(),
    usage: usageFromResponse(payload),
    latency_ms: Math.round(performance.now() - started)
  };
}

async function benchmarkCase({
  apiKey,
  model,
  policy,
  profile,
  applicationPolicy,
  rankingPolicy,
  packPolicy,
  systemMessage,
  fixture,
  fetchImpl
}) {
  const html = await readText(fixture.path);
  const parsed = parseJobDetail(html, {
    source: "onlinejobs.ph",
    canonical_url: `https://onlinejobs.ph/jobseekers/job/benchmark-${fixture.id}-1`,
    role_families: fixture.role_families
  });
  const now = new Date().toISOString();
  const evaluated = {
    ...parsed,
    ...evaluateJob(parsed, profile, rankingPolicy, now)
  };
  const pack = buildApplicationPack(
    evaluated,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const packErrors = validateApplicationPack(pack, profile, packPolicy);
  if (pack.application_pack_status !== "ready" || packErrors.length > 0) {
    throw new Error(`benchmark fixture ${fixture.id} does not produce a ready pack`);
  }
  const userBudget = groqInitialUserCharacterBudget(policy, systemMessage);
  const initialPrompt = buildApplicationUserMessage(evaluated, pack, {
    maximumCharacters: userBudget
  });
  if (!validateGroqPromptBudget(policy, systemMessage, initialPrompt).valid) {
    throw new Error(`benchmark fixture ${fixture.id} exceeds the input budget`);
  }

  const initial = await requestCompletion({
    apiKey,
    model,
    policy,
    systemMessage,
    userMessage: initialPrompt,
    fetchImpl
  });
  let finalMessage = initial.message;
  let validation = validateGeneratedMessage(finalMessage, {
    job: evaluated,
    profile,
    policy: applicationPolicy,
    pack
  });
  const calls = [initial];
  if (!validation.valid) {
    const repairPrompt = `${initialPrompt}\n\n${buildApplicationRepairMessage(
      finalMessage,
      validation.errors
    )}`;
    if (!validateGroqPromptBudget(policy, systemMessage, repairPrompt).valid) {
      return {
        case: fixture.id,
        valid: false,
        repaired: false,
        failure_category: "repair_prompt_budget",
        validation_error_count: validation.errors.length,
        latency_ms: initial.latency_ms,
        input_tokens: initial.usage.input_tokens,
        output_tokens: initial.usage.output_tokens,
        cost_usd: estimateGroqCostUsd(model, initial.usage)
      };
    }
    await wait(rateLimitDelayMilliseconds(model, initial.usage.input_tokens));
    const repair = await requestCompletion({
      apiKey,
      model,
      policy,
      systemMessage,
      userMessage: repairPrompt,
      fetchImpl
    });
    calls.push(repair);
    finalMessage = repair.message;
    validation = validateGeneratedMessage(finalMessage, {
      job: evaluated,
      profile,
      policy: applicationPolicy,
      pack
    });
  }
  const usage = calls.reduce(
    (total, call) => ({
      input_tokens: total.input_tokens + call.usage.input_tokens,
      cached_input_tokens:
        total.cached_input_tokens + call.usage.cached_input_tokens,
      output_tokens: total.output_tokens + call.usage.output_tokens
    }),
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
  );
  return {
    case: fixture.id,
    valid: validation.valid,
    repaired: calls.length === 2,
    failure_category: validation.valid ? "" : "deterministic_validation",
    validation_error_count: validation.errors.length,
    latency_ms: calls.reduce((total, call) => total + call.latency_ms, 0),
    ...usage,
    cost_usd: estimateGroqCostUsd(model, usage)
  };
}

function rateLimitDelayMilliseconds(model, inputTokens) {
  const limits = model.developer_base_limits;
  const tokenDelay =
    (Math.max(1, inputTokens) / limits.tokens_per_minute) * 60_000;
  const requestDelay = 60_000 / limits.requests_per_minute;
  return Math.ceil(Math.max(tokenDelay, requestDelay) + 1000);
}

async function runLiveBenchmark(modelIds) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is required for an explicitly authorized live run");
  }
  const [
    policy,
    profile,
    applicationPolicy,
    rankingPolicy,
    packPolicy
  ] = await Promise.all([
    readJson("config/groq-provider-policy.json"),
    readJson("config/candidate-profile.json"),
    readJson("config/application-policy.json"),
    readJson("config/ranking-policy.json"),
    readJson("config/application-pack-policy.json")
  ]);
  resolveGroqGenerationModel(policy);
  const systemMessage = buildApplicationSystemMessage(
    profile,
    applicationPolicy
  );
  const models = modelIds.map((modelId) => {
    const model = groqModelById(policy, modelId);
    if (!model) throw new Error(`Unknown benchmark model: ${modelId}`);
    return model;
  });
  const results = [];
  for (const model of models) {
    const cases = [];
    for (const fixture of benchmarkFixtures) {
      if (cases.length > 0) {
        const previous = cases.at(-1);
        await wait(
          rateLimitDelayMilliseconds(model, previous.input_tokens || 1)
        );
      }
      try {
        cases.push(
          await benchmarkCase({
            apiKey,
            model,
            policy,
            profile,
            applicationPolicy,
            rankingPolicy,
            packPolicy,
            systemMessage,
            fixture
          })
        );
      } catch (error) {
        cases.push({
          case: fixture.id,
          valid: false,
          repaired: false,
          failure_category: String(error.message || error).split(":")[0],
          validation_error_count: 0,
          latency_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0
        });
      }
    }
    results.push({ model: model.id, cases });
  }
  return {
    benchmark_version: policy.policy_version,
    generated_at: new Date().toISOString(),
    live_external_calls: true,
    raw_prompts_or_messages_included: false,
    results,
    activation_assessment: evaluateGroqBenchmark(results, policy)
  };
}

function printUsage() {
  console.log(`Usage:
  npm run benchmark:groq -- --live
  node scripts/benchmark-groq-models.mjs --live --models openai/gpt-oss-120b,qwen/qwen3.6-27b

This command makes live Groq API calls only when --live is present. It prints
sanitized correctness, latency, exact provider token usage, and estimated cost;
it never prints prompts, generated application messages, or the API key.`);
}

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    models: { type: "string" }
  }
});

if (values.help || !values.live) {
  printUsage();
  if (!values.help) process.exitCode = 2;
} else {
  const policy = await readJson("config/groq-provider-policy.json");
  const modelIds = values.models
    ? values.models.split(",").map((value) => value.trim()).filter(Boolean)
    : policy.activation_gate.candidate_models;
  const report = await runLiveBenchmark(modelIds);
  console.log(JSON.stringify(report, null, 2));
  if (report.activation_assessment.some((entry) => !entry.passes)) {
    process.exitCode = 1;
  }
}
