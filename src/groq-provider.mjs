const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\/v\d+$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/i;

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function groqModelById(policy, modelId) {
  return (policy?.models ?? []).find((model) => model.id === modelId);
}

export function validateGroqProviderPolicy(
  policy,
  now = new Date().toISOString()
) {
  const errors = [];
  if (!policy || typeof policy !== "object") {
    return ["Groq provider policy must be an object"];
  }
  if (policy.schema_version !== 1) {
    errors.push("Groq provider policy schema_version must be 1");
  }
  if (!POLICY_VERSION_PATTERN.test(policy.policy_version ?? "")) {
    errors.push("Groq provider policy_version must use YYYY-MM-DD/vN");
  }
  if (policy.provider !== "groq") {
    errors.push("Groq provider policy provider must be groq");
  }
  if (!validDateOnly(policy.last_verified_on)) {
    errors.push("Groq provider last_verified_on must be a valid date");
  }
  if (!MODEL_ID_PATTERN.test(policy.selected_model ?? "")) {
    errors.push("Groq selected_model is invalid");
  }

  const generation = policy.generation ?? {};
  if (
    !finiteNonNegative(generation.temperature) ||
    generation.temperature > 1
  ) {
    errors.push("Groq generation temperature must be between 0 and 1");
  }
  for (const field of [
    "maximum_output_tokens",
    "maximum_combined_input_characters",
    "repair_reserve_characters",
    "maximum_prompt_proofs",
    "character_estimate_divisor"
  ]) {
    if (!positiveInteger(generation[field])) {
      errors.push(`Groq generation ${field} must be a positive integer`);
    }
  }
  if (
    positiveInteger(generation.maximum_combined_input_characters) &&
    positiveInteger(generation.repair_reserve_characters) &&
    generation.repair_reserve_characters >=
      generation.maximum_combined_input_characters
  ) {
    errors.push("Groq repair reserve must be smaller than the input budget");
  }

  if (!Array.isArray(policy.models) || policy.models.length === 0) {
    errors.push("Groq models must be a non-empty array");
  }
  const modelIds = new Set();
  for (const model of policy.models ?? []) {
    if (!MODEL_ID_PATTERN.test(model?.id ?? "")) {
      errors.push("Groq policy contains an invalid model id");
      continue;
    }
    if (modelIds.has(model.id)) {
      errors.push(`Groq policy contains duplicate model id: ${model.id}`);
    }
    modelIds.add(model.id);
    if (!["production", "preview", "deprecated"].includes(model.lifecycle)) {
      errors.push(`Groq model ${model.id} has an invalid lifecycle`);
    }
    if (typeof model.artifact_approved !== "boolean") {
      errors.push(`Groq model ${model.id} must declare artifact approval`);
    }
    if (
      !["ready", "benchmark_required", "forbidden"].includes(
        model.production_activation
      )
    ) {
      errors.push(`Groq model ${model.id} has an invalid activation status`);
    }
    if (model.shutdown_on !== null && !validDateOnly(model.shutdown_on)) {
      errors.push(`Groq model ${model.id} has an invalid shutdown date`);
    }
    for (const field of [
      "context_window_tokens",
      "provider_maximum_output_tokens"
    ]) {
      if (!positiveInteger(model[field])) {
        errors.push(`Groq model ${model.id} ${field} must be positive`);
      }
    }
    for (const [field, value] of Object.entries(
      model.developer_base_limits ?? {}
    )) {
      if (!positiveInteger(value)) {
        errors.push(`Groq model ${model.id} limit ${field} must be positive`);
      }
    }
    for (const [field, value] of Object.entries(
      model.pricing_usd_per_million_tokens ?? {}
    )) {
      if (value !== null && !finiteNonNegative(value)) {
        errors.push(`Groq model ${model.id} price ${field} is invalid`);
      }
    }
    if (
      !Array.isArray(model.official_sources) ||
      model.official_sources.length === 0 ||
      model.official_sources.some(
        (source) =>
          typeof source !== "string" ||
          !source.startsWith("https://console.groq.com/docs/")
      )
    ) {
      errors.push(`Groq model ${model.id} must cite official Groq sources`);
    }
  }

  const selected = groqModelById(policy, policy.selected_model);
  if (!selected) {
    errors.push("Groq selected_model is absent from models");
  } else {
    if (selected.artifact_approved !== true) {
      errors.push("Groq selected_model is not approved for generated artifacts");
    }
    if (selected.production_activation === "forbidden") {
      errors.push("Groq selected_model is forbidden for production activation");
    }
    if (selected.lifecycle === "deprecated") {
      errors.push("Groq selected_model is deprecated");
    }
    if (
      positiveInteger(generation.maximum_output_tokens) &&
      positiveInteger(selected.provider_maximum_output_tokens) &&
      generation.maximum_output_tokens >
        selected.provider_maximum_output_tokens
    ) {
      errors.push("Groq output cap exceeds the selected provider model limit");
    }
    const nowDate = String(now).slice(0, 10);
    if (
      selected.shutdown_on &&
      validDateOnly(nowDate) &&
      nowDate >= selected.shutdown_on
    ) {
      errors.push("Groq selected_model has reached its shutdown date");
    }
  }

  const gate = policy.activation_gate ?? {};
  if (gate.live_benchmark_required !== true) {
    errors.push("Groq production activation must require a live benchmark");
  }
  if (!positiveInteger(gate.minimum_cases_per_model)) {
    errors.push("Groq benchmark minimum_cases_per_model must be positive");
  }
  if (
    !finiteNonNegative(gate.required_valid_rate) ||
    gate.required_valid_rate > 1
  ) {
    errors.push("Groq benchmark required_valid_rate must be between 0 and 1");
  }
  if (
    !Array.isArray(gate.candidate_models) ||
    gate.candidate_models.length < 2 ||
    gate.candidate_models.some((modelId) => !modelIds.has(modelId))
  ) {
    errors.push("Groq benchmark candidates must name at least two policy models");
  }
  return [...new Set(errors)];
}

export function resolveGroqGenerationModel(
  policy,
  now = new Date().toISOString()
) {
  const errors = validateGroqProviderPolicy(policy, now);
  if (errors.length > 0) {
    throw new Error(`Invalid Groq provider policy:\n- ${errors.join("\n- ")}`);
  }
  return groqModelById(policy, policy.selected_model);
}

export function groqInitialUserCharacterBudget(policy, systemMessage) {
  const budget =
    policy.generation.maximum_combined_input_characters -
    String(systemMessage || "").length -
    policy.generation.repair_reserve_characters;
  if (budget < 1000) {
    throw new Error("Groq policy leaves less than 1,000 characters for the job prompt");
  }
  return budget;
}

export function validateGroqPromptBudget(policy, systemMessage, userMessage) {
  const combinedCharacters =
    String(systemMessage || "").length + String(userMessage || "").length;
  const maximum = policy?.generation?.maximum_combined_input_characters;
  return {
    valid: positiveInteger(maximum) && combinedCharacters <= maximum,
    combined_characters: combinedCharacters,
    maximum_characters: maximum,
    character_based_token_estimate: Math.ceil(
      combinedCharacters /
        Math.max(1, policy?.generation?.character_estimate_divisor || 1)
    )
  };
}

export function estimateGroqCostUsd(model, usage = {}) {
  const prices = model?.pricing_usd_per_million_tokens ?? {};
  const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, Number(usage.cached_input_tokens) || 0)
  );
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
  return (
    (uncachedInputTokens * (prices.input ?? 0) +
      cachedInputTokens * (prices.cached_input ?? prices.input ?? 0) +
      outputTokens * (prices.output ?? 0)) /
    1_000_000
  );
}

export function evaluateGroqBenchmark(modelResults, policy) {
  const requiredCases = policy.activation_gate.minimum_cases_per_model;
  const requiredRate = policy.activation_gate.required_valid_rate;
  return (modelResults ?? []).map((result) => {
    const cases = Array.isArray(result.cases) ? result.cases : [];
    const valid = cases.filter((entry) => entry.valid === true).length;
    const validRate = cases.length === 0 ? 0 : valid / cases.length;
    return {
      model: result.model,
      case_count: cases.length,
      valid_count: valid,
      valid_rate: validRate,
      passes:
        cases.length >= requiredCases &&
        validRate >= requiredRate &&
        cases.every(
          (entry) =>
            finiteNonNegative(entry.latency_ms) &&
            positiveInteger(entry.input_tokens) &&
            positiveInteger(entry.output_tokens)
        )
    };
  });
}
