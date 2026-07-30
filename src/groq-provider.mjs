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
    "character_estimate_divisor",
    "maximum_requests_per_item",
    "request_interval_ms"
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
  if (
    positiveInteger(generation.request_interval_ms) &&
    generation.request_interval_ms <= 60_000
  ) {
    errors.push("Groq request interval must exceed the one-minute rate window");
  }
  if (generation.maximum_requests_per_item !== 1) {
    errors.push("Simplified Generator maximum_requests_per_item must be 1");
  }
  if (generation.reasoning_format !== "hidden") {
    errors.push("Groq generation reasoning_format must be hidden");
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
    if (
      model.id.startsWith("openai/gpt-oss-") &&
      !["low", "medium", "high"].includes(model.reasoning_effort)
    ) {
      errors.push(`Groq GPT-OSS model ${model.id} has an invalid reasoning effort`);
    }
    if (
      model.id.startsWith("qwen/") &&
      !["none", "default"].includes(model.reasoning_effort)
    ) {
      errors.push(`Groq Qwen model ${model.id} has an invalid reasoning effort`);
    }
    if (
      !model.id.startsWith("openai/gpt-oss-") &&
      !model.id.startsWith("qwen/") &&
      model.reasoning_effort !== null
    ) {
      errors.push(
        `Groq model ${model.id} must not declare an unsupported reasoning effort`
      );
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
    for (const field of [
      "requests_per_minute",
      "requests_per_day",
      "tokens_per_minute",
      "tokens_per_day"
    ]) {
      if (!positiveInteger(model.developer_base_limits?.[field])) {
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
    gate.candidate_models.some((modelId) => !modelIds.has(modelId)) ||
    !gate.candidate_models.includes(policy.selected_model)
  ) {
    errors.push(
      "Groq benchmark candidates must name the selected model and at least one comparison policy model"
    );
  }
  if (gate.comparison_models_must_be_measured !== true) {
    errors.push("Groq benchmark comparison models must be measured");
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

export function groqScheduledCapacity(policy, generatorRuntime) {
  const model = resolveGroqGenerationModel(policy);
  for (const field of [
    "schedule_minutes",
    "per_run_cap",
    "execution_timeout_seconds"
  ]) {
    if (!positiveInteger(generatorRuntime?.[field])) {
      throw new Error(`Generator runtime ${field} must be a positive integer`);
    }
  }
  const generation = policy.generation;
  const initialRequestEstimate =
    Math.ceil(
      (generation.maximum_combined_input_characters -
        generation.repair_reserve_characters) /
        generation.character_estimate_divisor
    ) + generation.maximum_output_tokens;
  const repairRequestEstimate =
    Math.ceil(
      generation.maximum_combined_input_characters /
        generation.character_estimate_divisor
    ) + generation.maximum_output_tokens;
  const maximumScheduledExecutionsPerDay =
    Math.ceil((24 * 60) / generatorRuntime.schedule_minutes) + 1;
  const maximumScheduledRequestsPerDay =
    maximumScheduledExecutionsPerDay *
    generatorRuntime.per_run_cap *
    generation.maximum_requests_per_item;
  const perItemEstimate =
    generation.maximum_requests_per_item === 1
      ? initialRequestEstimate
      : initialRequestEstimate + repairRequestEstimate;
  return {
    model_id: model.id,
    initial_request_character_token_estimate: initialRequestEstimate,
    repair_request_character_token_estimate: repairRequestEstimate,
    per_item_character_token_estimate: perItemEstimate,
    maximum_scheduled_executions_per_day:
      maximumScheduledExecutionsPerDay,
    maximum_scheduled_requests_per_day: maximumScheduledRequestsPerDay,
    maximum_scheduled_character_token_estimate_per_day:
      maximumScheduledExecutionsPerDay *
      generatorRuntime.per_run_cap *
      perItemEstimate,
    maximum_pacing_milliseconds:
      (generation.maximum_requests_per_item * generatorRuntime.per_run_cap - 1) *
      generation.request_interval_ms
  };
}

export function validateGroqRuntimeCapacity(policy, generatorRuntime) {
  const errors = validateGroqProviderPolicy(policy);
  for (const field of [
    "schedule_minutes",
    "per_run_cap",
    "execution_timeout_seconds"
  ]) {
    if (!positiveInteger(generatorRuntime?.[field])) {
      errors.push(`Generator runtime ${field} must be a positive integer`);
    }
  }
  if (errors.length > 0) return [...new Set(errors)];

  const model = groqModelById(policy, policy.selected_model);
  const limits = model.developer_base_limits;
  const capacity = groqScheduledCapacity(policy, generatorRuntime);
  if (
    capacity.initial_request_character_token_estimate >
    limits.tokens_per_minute
  ) {
    errors.push(
      "Groq initial-request character token estimate exceeds the selected model TPM limit"
    );
  }
  if (
    capacity.repair_request_character_token_estimate >
    limits.tokens_per_minute
  ) {
    errors.push(
      "Groq repair-request character token estimate exceeds the selected model TPM limit"
    );
  }
  if (
    capacity.maximum_scheduled_requests_per_day > limits.requests_per_day
  ) {
    errors.push(
      "Groq scheduled request ceiling exceeds the selected model RPD limit"
    );
  }
  if (
    capacity.maximum_scheduled_character_token_estimate_per_day >
    limits.tokens_per_day
  ) {
    errors.push(
      "Groq scheduled character token estimate exceeds the selected model TPD limit"
    );
  }
  if (
    capacity.maximum_pacing_milliseconds >=
    generatorRuntime.execution_timeout_seconds * 1000
  ) {
    errors.push("Groq request pacing exhausts the Generator execution timeout");
  }
  return [...new Set(errors)];
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
  const resultsByModel = new Map(
    (modelResults ?? []).map((result) => [result.model, result])
  );
  return policy.activation_gate.candidate_models.map((modelId) => {
    const result = resultsByModel.get(modelId) ?? { model: modelId, cases: [] };
    const cases = Array.isArray(result.cases) ? result.cases : [];
    const valid = cases.filter((entry) => entry.valid === true).length;
    const validRate = cases.length === 0 ? 0 : valid / cases.length;
    const measured =
      cases.length >= requiredCases &&
      cases.every(
        (entry) =>
          finiteNonNegative(entry.latency_ms) &&
          positiveInteger(entry.input_tokens) &&
          positiveInteger(entry.output_tokens)
      );
    return {
      model: result.model,
      case_count: cases.length,
      valid_count: valid,
      valid_rate: validRate,
      measured,
      required_for_activation: result.model === policy.selected_model,
      passes: measured && validRate >= requiredRate
    };
  });
}
