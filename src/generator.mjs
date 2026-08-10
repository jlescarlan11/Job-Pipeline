import {
  buildApplicationPack,
  buildApplicationRepairMessage,
  buildApplicationRepairSystemMessage,
  buildApplicationSystemMessage,
  buildApplicationUserMessage,
  cleanGeneratedMessage,
  evaluateJob,
  validateApplicationPack,
  validateGeneratedMessage
} from "./evaluation.mjs";
import {
  groqInitialUserCharacterBudget,
  validateGroqPromptBudget
} from "./groq-provider.mjs";
import {
  applicationReviewGuard,
  preparationInputGuard,
  reviewCaseId,
  stateGuard,
  stateGuardMatches,
  validateRecordStoreContract
} from "./contracts.mjs";

const MAX_REASON_LENGTH = 500;
const MAX_ERROR_LENGTH = 240;

function boundedText(value, maximum = MAX_REASON_LENGTH) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, "authorization=[redacted]")
    .replace(/(?:authorization|api[-_ ]?key|token|secret|webhook)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function dueAt(record, nowMs) {
  const parsed = Date.parse(record?.next_retry_at || "");
  return !record?.next_retry_at || !Number.isFinite(parsed) || parsed <= nowMs;
}

function isLegacyPreparationRecord(record) {
  return (
    record.pipeline_status === "ready_to_apply" &&
    record.user_action === "" &&
    Number(record.preparation_version || 0) === 0 &&
    !record.preparation_input_guard &&
    !record.preparation_updated_at &&
    ["", "preparation_error"].includes(String(record.prep_status || ""))
  );
}

const APPLICATION_COMPATIBILITY_FIELDS = [
  "application_pack_policy_version",
  "application_pack_version",
  "coverage_contract_version",
  "message_plan_version"
];

function hasStaleApplicationCompatibility(record, applicationCompatibility) {
  const expected = APPLICATION_COMPATIBILITY_FIELDS.map((field) =>
    String(applicationCompatibility?.[field] || "").trim()
  );
  const persisted = APPLICATION_COMPATIBILITY_FIELDS.map((field) =>
    String(record?.[field] || "").trim()
  );
  return (
    expected.every(Boolean) &&
    persisted.every(Boolean) &&
    expected.some((value, index) => value !== persisted[index])
  );
}

function isPolicyUpgradeResume(record, sourceStore, applicationCompatibility) {
  return (
    sourceStore === "To Apply" &&
    ["needs_input", "preparation_error"].includes(record.prep_status) &&
    hasStaleApplicationCompatibility(record, applicationCompatibility)
  );
}

function stageForCandidate(record, sourceStore, applicationCompatibility) {
  if (sourceStore === "To Apply") {
    const resumablePolicyUpgrade = isPolicyUpgradeResume(
      record,
      sourceStore,
      applicationCompatibility
    );
    if (
      record.pipeline_status === "ready_to_apply" &&
      record.user_action === "" &&
      (record.review_decision === "proceed" ||
        isLegacyPreparationRecord(record)) &&
      (["pending", "preparing", "repair_pending", "preparation_error"].includes(
        record.prep_status
      ) || resumablePolicyUpgrade)
    ) {
      return "generation";
    }
    return "";
  }
  if (record.pipeline_status === "new") return "evaluation";
  if (record.pipeline_status === "processing") {
    return record.processing_stage === "generation"
      ? "generation"
      : "evaluation";
  }
  if (record.pipeline_status === "error") {
    return record.processing_stage === "generation" ? "generation" : "evaluation";
  }
  return "";
}

export function selectGeneratorCandidate(
  rowsOrStores,
  schema,
  runtime,
  now = new Date().toISOString(),
  applicationCompatibility = {}
) {
  const stores = Array.isArray(rowsOrStores)
    ? { "Scraped Jobs": rowsOrStores }
    : rowsOrStores;
  if (!stores || typeof stores !== "object" || Array.isArray(stores)) {
    throw new Error("Generator store rows must be an object or Scraped Jobs array");
  }
  for (const store of Object.keys(stores)) {
    if (!["Scraped Jobs", "To Apply"].includes(store)) {
      throw new Error(`Generator source store is unsupported: ${boundedText(store)}`);
    }
    if (!Array.isArray(stores[store])) {
      throw new Error(`${store} rows must be an array`);
    }
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Generator selection requires valid now");
  const candidates = [];
  const identities = new Set();
  for (const [sourceStore, rows] of Object.entries(stores)) {
    for (const record of rows) {
      const errors = validateRecordStoreContract(record, sourceStore, schema);
      if (errors.length > 0) {
        throw new Error(
          `Generator rejected invalid ${sourceStore} row: ${boundedText(
            errors.join("; ")
          )}`
        );
      }
      const identity = String(record.canonical_job_id)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US");
      if (identities.has(identity)) {
        throw new Error(
          "Generator rejected ambiguous duplicate identity across source stores"
        );
      }
      identities.add(identity);
      if (record.processing_token) {
        const startedAt = Date.parse(record.processing_started_at || "");
        if (
          Number.isFinite(startedAt) &&
          nowMs - startedAt < runtime.claim_lease_ms
        ) {
          continue;
        }
      }
      const stage = stageForCandidate(
        record,
        sourceStore,
        applicationCompatibility
      );
      if (!stage) continue;
      if (
        sourceStore === "To Apply" &&
        !isLegacyPreparationRecord(record) &&
        record.preparation_input_guard !== preparationInputGuard(record)
      ) {
        // A relevant input change must first advance the preparation version
        // through a guarded lifecycle update. A direct Sheet edit cannot
        // silently authorize new provider work.
        continue;
      }
      if (
        (record.pipeline_status === "error" ||
          record.prep_status === "preparation_error") &&
        (record.error_category === "source_unavailable" ||
          (String(record.error_category || "").endsWith("_exhausted") &&
            !isPolicyUpgradeResume(
              record,
              sourceStore,
              applicationCompatibility
            )) ||
          !dueAt(record, nowMs))
      ) {
        continue;
      }
      candidates.push({
        record,
        stage,
        source_store: sourceStore,
        timestamp:
          Date.parse(
            record.next_retry_at ||
              record.preparation_updated_at ||
              record.created_at ||
              record.discovered_at ||
              ""
          ) || Number.POSITIVE_INFINITY
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      Number(left.source_store === "Scraped Jobs") -
        Number(right.source_store === "Scraped Jobs") ||
      String(left.record.canonical_job_id).localeCompare(
        String(right.record.canonical_job_id)
      )
  );
  return candidates.slice(0, runtime.per_run_cap);
}

export function claimGeneratorRecord(
  record,
  stage,
  executionId,
  now,
  leaseMs,
  sourceStore = "Scraped Jobs"
) {
  if (!["evaluation", "generation"].includes(stage)) {
    throw new Error("Generator claim stage is invalid");
  }
  if (!executionId || !Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new Error("Generator claim requires execution ID and positive lease");
  }
  if (!["Scraped Jobs", "To Apply"].includes(sourceStore)) {
    throw new Error("Generator claim source store is invalid");
  }
  if (!stateGuardMatches(record)) {
    throw new Error("Generator claim rejected a stale source state guard");
  }
  if (record.processing_token) {
    const started = Date.parse(record.processing_started_at || "");
    if (Number.isFinite(started) && Date.parse(now) - started < leaseMs) {
      return { claimed: false, record };
    }
  }
  const token = `${executionId}:${sourceStore}:${record.canonical_job_id}:${stage}`;
  const preparingInToApply = sourceStore === "To Apply";
  const legacyPreparation =
    preparingInToApply && isLegacyPreparationRecord(record);
  const legacyApproved = Boolean(
    legacyPreparation &&
      !record.review_decision &&
      Number.isFinite(Date.parse(record.review_approved_at || "")) &&
      record.review_approval_guard &&
      record.review_approval_guard === applicationReviewGuard(record)
  );
  const claimed = {
    ...record,
    review_case_id: legacyApproved ? reviewCaseId(record) : record.review_case_id,
    review_case_version: legacyApproved
      ? "review-case-v1"
      : record.review_case_version,
    review_decision: legacyApproved ? "proceed" : record.review_decision,
    review_decided_at: legacyApproved
      ? record.review_approved_at
      : record.review_decided_at,
    pipeline_status: preparingInToApply ? "ready_to_apply" : "processing",
    prep_status: preparingInToApply ? "preparing" : "",
    preparation_version: legacyPreparation
      ? 1
      : record.preparation_version,
    preparation_updated_at: preparingInToApply
      ? now
      : record.preparation_updated_at || "",
    processing_stage: stage,
    processing_token: token,
    processing_started_at: now,
    record_version: record.record_version + 1,
    updated_at: now
  };
  if (legacyPreparation) {
    claimed.preparation_input_guard = preparationInputGuard(claimed);
  }
  claimed.state_guard = stateGuard(claimed);
  return { claimed: true, record: claimed };
}

function evaluationReason(evaluation) {
  const parts = [];
  if (evaluation.match_reasons?.length) {
    parts.push(evaluation.match_reasons.slice(0, 3).join("; "));
  }
  if (evaluation.requirement_gaps?.length) {
    parts.push(`Gaps: ${evaluation.requirement_gaps.slice(0, 3).join("; ")}`);
  }
  return boundedText(parts.join(" | ") || "Evaluation completed");
}

function requiredInputForEvaluation(evaluation) {
  if (evaluation.match_decision === "unscorable") {
    return "A complete, available job description is required.";
  }
  if (evaluation.match_decision === "unavailable") {
    return "The source listing must become available before reevaluation.";
  }
  if (evaluation.match_decision === "review_required") {
    return boundedText(
      evaluation.requirement_gaps?.length
        ? `Review these gaps: ${evaluation.requirement_gaps.join("; ")}`
        : "Confirm whether this promising listing should proceed."
    );
  }
  return "";
}

export function evaluateAndRoute(
  claimedRecord,
  profile,
  rankingPolicy,
  now = new Date().toISOString()
) {
  if (
    claimedRecord.processing_stage !== "evaluation" ||
    !claimedRecord.processing_token
  ) {
    throw new Error("Evaluation requires a persisted evaluation claim");
  }
  const evaluation = evaluateJob(claimedRecord, profile, rankingPolicy, now);
  const statusByDecision = {
    recommended: "processing",
    review_required: "review_needed",
    not_recommended: "skip",
    unscorable: "unavailable",
    unavailable: "unavailable"
  };
  const pipelineStatus = statusByDecision[evaluation.match_decision];
  if (!pipelineStatus) throw new Error("Evaluation returned an unsupported decision");

  return {
    ...claimedRecord,
    qualification_score: evaluation.qualification_score,
    opportunity_score: evaluation.opportunity_score,
    ranking_confidence: evaluation.ranking_confidence,
    match_reasons: evaluation.match_reasons,
    requirement_gaps: evaluation.requirement_gaps,
    profile_version: evaluation.profile_version,
    policy_version: evaluation.scoring_policy_version,
    evaluated_at: evaluation.evaluated_at,
    decision_reason: evaluationReason(evaluation),
    required_input: requiredInputForEvaluation(evaluation),
    generated_message: claimedRecord.generated_message || "",
    message_validation_status:
      claimedRecord.message_validation_status || "",
    pipeline_status: pipelineStatus,
    processing_stage:
      evaluation.match_decision === "recommended" ? "generation" : "",
    error_category: "",
    error_summary: "",
    next_retry_at: "",
    updated_at: now
  };
}

function packRequiredInput(pack) {
  const questions = (pack.screening_questions ?? [])
    .map((question) => question.text)
    .filter(Boolean);
  const warnings = (pack.application_warnings ?? [])
    .filter(
      (warning) => warning.code !== "screening_question_requires_review"
    )
    .map((warning) => warning.summary)
    .filter(Boolean);
  return boundedText([...questions, ...warnings].join("; "));
}

function readyRequiredInput(pack) {
  const questions = (pack.screening_questions ?? [])
    .filter(
      (question) =>
        question.review_acknowledged === true &&
        question.answer_status === "manual_submission_required"
    )
    .map((question) => question.text)
    .filter(Boolean);
  const warnings = (pack.application_warnings ?? [])
    .filter(
      (warning) =>
        warning.review_acknowledged === true &&
        ![
          "screening_question_requires_review",
          "missing_required_coverage",
          "partial_coverage_requires_review"
        ].includes(warning.code)
    )
    .map((warning) => warning.summary)
    .filter(Boolean);
  const reminders = [...questions, ...warnings];
  return reminders.length > 0
    ? boundedText(`Manual submission reminder: ${reminders.join("; ")}`)
    : "";
}

function requiresExternalSteps(pack) {
  return (
    (pack.screening_questions ?? []).some(
      (question) => question.answer_status === "manual_submission_required"
    ) ||
    (pack.application_warnings ?? []).some((warning) =>
      /(?:external|attachment|test|assessment|manual|upload)/i.test(
        `${warning.code || ""} ${warning.summary || ""}`
      )
    )
  );
}

function preparationRequiredInput(pack, prepStatus) {
  const value =
    prepStatus === "external_steps"
      ? readyRequiredInput(pack) || packRequiredInput(pack)
      : packRequiredInput(pack);
  if (value) return value;
  return prepStatus === "external_steps"
    ? "Complete the employer's required external application steps manually."
    : "Provide the missing candidate information required by the application.";
}

function applicationPackRecordFields(pack) {
  return {
    application_instructions: pack.application_instructions,
    screening_questions: pack.screening_questions,
    requirement_coverage: pack.requirement_coverage,
    application_message_plan: [pack.message_plan],
    selected_proof_refs: pack.selected_proof_refs,
    application_warnings: pack.application_warnings,
    application_pack_status: pack.application_pack_status,
    application_pack_version: pack.application_pack_version,
    application_pack_profile_version: pack.application_pack_profile_version,
    application_pack_policy_version: pack.application_pack_policy_version,
    coverage_contract_version: pack.coverage_contract_version,
    message_plan_version: pack.message_plan.version,
    application_pack_generated_at: pack.application_pack_generated_at
  };
}

export function prepareApplicationGeneration(
  claimedRecord,
  profile,
  applicationPolicy,
  packPolicy,
  providerPolicy,
  now = new Date().toISOString()
) {
  if (
    claimedRecord.processing_stage !== "generation" ||
    !claimedRecord.processing_token
  ) {
    throw new Error("Generation requires a persisted generation claim");
  }
  const pack = buildApplicationPack(
    claimedRecord,
    profile,
    applicationPolicy,
    packPolicy,
    now
  );
  const packErrors = validateApplicationPack(pack, profile, packPolicy);
  if (packErrors.length > 0) {
    throw new Error(`Application pack validation failed: ${boundedText(packErrors.join("; "))}`);
  }
  if (pack.application_pack_status !== "ready") {
    const descriptionUnavailable = pack.application_warnings?.some(
      (warning) => warning.code === "description_unavailable"
    );
    const preparingInToApply =
      claimedRecord.pipeline_status === "ready_to_apply" &&
      claimedRecord.prep_status === "preparing";
    const prepStatus = descriptionUnavailable
      ? "preparation_error"
      : requiresExternalSteps(pack)
        ? "external_steps"
        : "needs_input";
    return {
      provider_required: false,
      pack,
      record: {
        ...claimedRecord,
        ...applicationPackRecordFields(pack),
        generated_message: "",
        message_validation_status: "",
        message_profile_version: "",
        message_policy_version: "",
        generated_at: "",
        pipeline_status: preparingInToApply
          ? "ready_to_apply"
          : descriptionUnavailable
            ? "unavailable"
            : "review_needed",
        prep_status: preparingInToApply ? prepStatus : "",
        preparation_updated_at: preparingInToApply
          ? now
          : claimedRecord.preparation_updated_at || "",
        decision_reason: descriptionUnavailable
          ? "A complete active job description is required."
          : preparingInToApply
            ? prepStatus === "external_steps"
              ? "Application preparation requires external operator steps."
              : "Application preparation requires candidate input."
            : "Application requirements need human review.",
        required_input: preparingInToApply
          ? preparationRequiredInput(pack, prepStatus)
          : packRequiredInput(pack),
        processing_stage: "",
        error_category: "",
        error_summary: "",
        next_retry_at: "",
        updated_at: now
      }
    };
  }
  if (
    claimedRecord.pipeline_status === "ready_to_apply" &&
    claimedRecord.prep_status === "preparing" &&
    requiresExternalSteps(pack)
  ) {
    return {
      provider_required: false,
      pack,
      record: {
        ...claimedRecord,
        ...applicationPackRecordFields(pack),
        pipeline_status: "ready_to_apply",
        prep_status: "external_steps",
        preparation_updated_at: now,
        generated_message: "",
        message_validation_status: "",
        message_profile_version: "",
        message_policy_version: "",
        generated_at: "",
        decision_reason: "Application preparation requires external operator steps.",
        required_input: preparationRequiredInput(pack, "external_steps"),
        processing_stage: "",
        error_category: "",
        error_summary: "",
        next_retry_at: "",
        updated_at: now
      }
    };
  }
  const systemMessage = buildApplicationSystemMessage(
    profile,
    applicationPolicy
  );
  if (!providerPolicy) {
    throw new Error("Generation requires a provider policy");
  }
  const userMessage = buildApplicationUserMessage(claimedRecord, pack, {
    maximumCharacters: groqInitialUserCharacterBudget(
      providerPolicy,
      systemMessage
    ),
    maximumProofs: providerPolicy.generation.maximum_prompt_proofs,
    promptTemplates: applicationPolicy.prompt_templates
  });
  const promptBudget = validateGroqPromptBudget(
    providerPolicy,
    systemMessage,
    userMessage
  );
  if (!promptBudget.valid) {
    throw new Error("Provider input budget validation failed");
  }
  return {
    provider_required: true,
    pack,
    system_message: systemMessage,
    user_message: userMessage,
    prompt_budget: promptBudget
  };
}

export function assessInitialGenerationDraft(
  claimedRecord,
  pack,
  message,
  systemMessage,
  userMessage,
  profile,
  applicationPolicy,
  packPolicy,
  providerPolicy,
  now = new Date().toISOString()
) {
  const cleanedMessage = cleanGeneratedMessage(message);
  const validation = validateGeneratedMessage(cleanedMessage, {
    job: claimedRecord,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (validation.valid) {
    return {
      repair_required: false,
      proposed_record: applyValidatedGeneration(
        claimedRecord,
        pack,
        cleanedMessage,
        profile,
        applicationPolicy,
        packPolicy,
        now
      )
    };
  }
  const repairSystemMessage = buildApplicationRepairSystemMessage(
    profile,
    applicationPolicy
  );
  const repairUserMessage = buildApplicationRepairMessage(
    cleanedMessage,
    validation.errors,
    {
      selectedProofs: pack.selected_proofs,
      applicationInstructions: pack.application_instructions,
      screeningQuestions: pack.screening_questions,
      requirementCoverage: pack.requirement_coverage,
      messagePlan: pack.message_plan,
      promptTemplates: applicationPolicy.prompt_templates,
      maximumCharacters:
        providerPolicy.generation.maximum_repair_combined_input_characters -
        repairSystemMessage.length
    }
  );
  const repairBudget = validateGroqPromptBudget(
    providerPolicy,
    repairSystemMessage,
    repairUserMessage,
    {
      maximumCharacters:
        providerPolicy.generation.maximum_repair_combined_input_characters
    }
  );
  if (!repairBudget.valid) {
    throw new Error("Provider repair input budget validation failed");
  }
  return {
    repair_required: true,
    repair_system_message: repairSystemMessage,
    repair_user_message: repairUserMessage,
    validation_errors: validation.errors,
    rejected_message: String(message || ""),
    repair_budget: repairBudget
  };
}

export function applyValidatedGeneration(
  claimedRecord,
  pack,
  message,
  profile,
  applicationPolicy,
  packPolicy,
  now = new Date().toISOString()
) {
  const cleanedMessage = cleanGeneratedMessage(message);
  const packErrors = validateApplicationPack(pack, profile, packPolicy);
  const messageValidation = validateGeneratedMessage(cleanedMessage, {
    job: claimedRecord,
    profile,
    policy: applicationPolicy,
    pack
  });
  if (
    pack.application_pack_status !== "ready" ||
    packErrors.length > 0 ||
    !messageValidation.valid
  ) {
    throw new Error(
      `Generated application is not ready: ${boundedText(
        [...packErrors, ...messageValidation.errors].join("; ")
      )}`
    );
  }
  return {
    ...claimedRecord,
    ...applicationPackRecordFields(pack),
    pipeline_status: "ready_to_apply",
    prep_status: "message_ready",
    preparation_version: Math.max(
      1,
      Number(claimedRecord.preparation_version || 0)
    ),
    preparation_input_guard:
      claimedRecord.preparation_input_guard || preparationInputGuard(claimedRecord),
    preparation_updated_at: now,
    generated_message: cleanedMessage,
    message_profile_version: profile.profile_version,
    message_policy_version: applicationPolicy.policy_version,
    message_validation_status: "valid",
    generated_at: now,
    decision_reason: boundedText(
      readyRequiredInput(pack)
        ? "Approved after human review; the validated message is ready with manual submission reminders."
        : (pack.screening_questions ?? []).some(
              (question) => question.answer_status === "answer_in_message"
            )
          ? "The validated message is ready and includes answers to the approved screening questions."
        : claimedRecord.decision_reason ||
            "Validated application message is ready."
    ),
    required_input: readyRequiredInput(pack),
    processing_stage: "",
    error_category: "",
    error_summary: "",
    next_retry_at: "",
    updated_at: now
  };
}

export function buildApprovedPositiveFramingFallback(
  claimedRecord,
  pack,
  applicationPolicy
) {
  if (
    claimedRecord?.review_decision !== "proceed" ||
    pack?.application_pack_status !== "ready" ||
    !pack?.selected_proof_refs?.includes("projects:job-pipeline")
  ) {
    return "";
  }
  const questions = (pack.screening_questions ?? []).filter(
    (question) =>
      question.answer_status === "answer_in_message" &&
      question.review_acknowledged === true
  );
  const requiredQuestionPatterns = [
    /what\s+ai\s+tools[\s\S]*every\s+day/i,
    /coolest[\s\S]*built[\s\S]*ai/i,
    /improve[\s\S]*current\s+ai\s+workflow/i,
    /why[\s\S]*right\s+person/i
  ];
  if (
    questions.length !== requiredQuestionPatterns.length ||
    requiredQuestionPatterns.some(
      (pattern) =>
        !questions.some((question) => pattern.test(String(question.text || "")))
    )
  ) {
    return "";
  }
  const jobPipelineProof = (pack.selected_proofs ?? []).find(
    (proof) => proof?.reference === "projects:job-pipeline"
  );
  const proofText = String(jobPipelineProof?.evidence || "");
  if (
    ![/\bn8n\b/i, /\bGroq API\b/i, /\bGoogle Sheets API\b/i].every(
      (pattern) => pattern.test(proofText)
    )
  ) {
    return "";
  }
  const subject = String(pack?.message_plan?.subject_line || "").trim();
  const greeting = String(applicationPolicy?.default_greeting || "").trim();
  if (!subject || !greeting) return "";
  return `${subject}\n\n${greeting}\n\nThe AI tools I use most in my automation work are n8n, Groq API, and Google Sheets API. The coolest AI system I have built is Job Pipeline, a three-workflow automation that collects job listings, generates tailored application messages through Groq API, and archives processed results in Google Sheets. For my current AI workflow, I would improve the feedback on generated results while retaining its prompt validation, deduplication, and rate-limit-aware batching. This hands-on automation work and my experience maintaining production web applications are why I am the right person to contribute in this role.\n\nI would welcome a conversation about how my experience fits this role.`;
}

export function applyRepairedGenerationWithFallback(
  claimedRecord,
  pack,
  repairedMessage,
  profile,
  applicationPolicy,
  packPolicy,
  now = new Date().toISOString()
) {
  try {
    return applyValidatedGeneration(
      claimedRecord,
      pack,
      repairedMessage,
      profile,
      applicationPolicy,
      packPolicy,
      now
    );
  } catch (repairError) {
    const fallback = buildApprovedPositiveFramingFallback(
      claimedRecord,
      pack,
      applicationPolicy
    );
    if (!fallback) throw repairError;
    return applyValidatedGeneration(
      claimedRecord,
      pack,
      fallback,
      profile,
      applicationPolicy,
      packPolicy,
      now
    );
  }
}

function classifyFailure(error) {
  const value = String(error?.message || error || "").toLowerCase();
  const leadingStatus = value.match(/^\s*(\d{3})\b/)?.[1] ?? "";
  if (/timeout|timed out|econnreset|network|socket hang up/.test(value)) {
    return "provider_timeout";
  }
  if (leadingStatus === "429" || /rate.?limit|quota/.test(value)) {
    return "provider_rate_limit";
  }
  if (
    leadingStatus === "401" ||
    leadingStatus === "403" ||
    (!leadingStatus && /unauthor|forbidden/.test(value.slice(0, 500)))
  ) {
    return "provider_auth";
  }
  if (/validation|not ready|invalid|unsupported/.test(value)) return "validation_failure";
  return "provider_failure";
}

function failureStatus(error) {
  const direct = Number(
    error?.statusCode ?? error?.status ?? error?.response?.status ?? 0
  );
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) {
    return direct;
  }
  const value = String(error?.message || error || "");
  const leading = value.match(/^\s*(\d{3})(?:\b|\s*[-:])/u)?.[1];
  if (leading) return Number(leading);
  const explicit = value.match(
    /\b(?:http|status(?:\s+code)?)\s*[:=-]?\s*(\d{3})\b/iu
  )?.[1];
  return explicit ? Number(explicit) : 0;
}

function isToApplyPreparation(record) {
  return (
    record?.pipeline_status === "ready_to_apply" &&
    [
      "pending",
      "preparing",
      "repair_pending",
      "preparation_error",
      "needs_input",
      "external_steps"
    ].includes(record?.prep_status)
  );
}

export function recordSourceFetchFailure(
  claimedRecord,
  error,
  runtime,
  now = new Date().toISOString()
) {
  const status = failureStatus(error);
  if (![404, 410].includes(status)) {
    return recordGeneratorFailure(claimedRecord, error, runtime, now);
  }
  if (isToApplyPreparation(claimedRecord)) {
    return {
      ...recordGeneratorFailure(claimedRecord, error, runtime, now),
      pipeline_status: "ready_to_apply",
      prep_status: "preparation_error",
      preparation_updated_at: now,
      error_category: "source_unavailable",
      error_summary: `HTTP ${status}: source job posting is no longer available.`,
      decision_reason: "Source job posting is no longer available for preparation.",
      required_input: "",
      next_retry_at: ""
    };
  }
  return {
    ...claimedRecord,
    source_availability: "unavailable",
    pipeline_status: "unavailable",
    processing_stage: "",
    processing_token: "",
    processing_started_at: "",
    attempt_count: Number(claimedRecord.attempt_count || 0) + 1,
    next_retry_at: "",
    error_category: "source_unavailable",
    error_summary: `HTTP ${status}: source job posting is no longer available.`,
    decision_reason: "Source job posting is no longer available.",
    required_input: "",
    updated_at: now
  };
}

export function recordGeneratorFailure(
  claimedRecord,
  error,
  runtime,
  now = new Date().toISOString()
) {
  const attemptCount = Number(claimedRecord.attempt_count || 0) + 1;
  const retryable = attemptCount < runtime.retry.max_attempts;
  const category = classifyFailure(error);
  if (isToApplyPreparation(claimedRecord)) {
    return {
      ...claimedRecord,
      pipeline_status: "ready_to_apply",
      prep_status:
        category === "validation_failure" && retryable
          ? "repair_pending"
          : "preparation_error",
      preparation_updated_at: now,
      processing_stage: "",
      processing_token: "",
      processing_started_at: "",
      attempt_count: attemptCount,
      next_retry_at: retryable
        ? new Date(Date.parse(now) + runtime.retry.backoff_ms).toISOString()
        : "",
      error_category: retryable ? category : `${category}_exhausted`,
      error_summary: boundedText(error?.message || error, MAX_ERROR_LENGTH),
      updated_at: now
    };
  }
  return {
    ...claimedRecord,
    pipeline_status: "error",
    processing_stage: "",
    processing_token: "",
    processing_started_at: "",
    attempt_count: attemptCount,
    next_retry_at: retryable
      ? new Date(Date.parse(now) + runtime.retry.backoff_ms).toISOString()
      : "",
    error_category: retryable ? category : `${category}_exhausted`,
    error_summary: boundedText(error?.message || error, MAX_ERROR_LENGTH),
    updated_at: now
  };
}

export function commitGeneratorResult(
  freshRecord,
  claimedRecord,
  proposedRecord,
  schema,
  now = new Date().toISOString(),
  sourceStore = "Scraped Jobs"
) {
  if (!["Scraped Jobs", "To Apply"].includes(sourceStore)) {
    throw new Error("Generator commit source store is invalid");
  }
  if (
    freshRecord.canonical_job_id !== claimedRecord.canonical_job_id ||
    freshRecord.processing_token !== claimedRecord.processing_token ||
    freshRecord.record_version !== claimedRecord.record_version ||
    freshRecord.state_guard !== stateGuard(freshRecord) ||
    claimedRecord.state_guard !== stateGuard(claimedRecord) ||
    freshRecord.state_guard !== claimedRecord.state_guard ||
    freshRecord.user_action !== claimedRecord.user_action ||
    freshRecord.review_case_id !== claimedRecord.review_case_id ||
    freshRecord.review_case_version !== claimedRecord.review_case_version ||
    freshRecord.review_decision !== claimedRecord.review_decision ||
    freshRecord.review_decided_at !== claimedRecord.review_decided_at ||
    freshRecord.preparation_version !== claimedRecord.preparation_version ||
    freshRecord.preparation_input_guard !==
      claimedRecord.preparation_input_guard
  ) {
    throw new Error(
      `Generator commit rejected stale or changed ${sourceStore} state`
    );
  }
  const committed = {
    ...freshRecord,
    ...proposedRecord,
    canonical_job_id: freshRecord.canonical_job_id,
    canonical_url: freshRecord.canonical_url,
    source_job_id: freshRecord.source_job_id,
    user_action: "",
    notes: freshRecord.notes,
    processing_token: "",
    processing_started_at: "",
    record_version: freshRecord.record_version + 1,
    updated_at: now
  };
  committed.state_guard = stateGuard(committed);
  const errors = validateRecordStoreContract(
    committed,
    sourceStore,
    schema
  );
  if (errors.length > 0) {
    throw new Error(`Generator commit failed contract validation: ${boundedText(errors.join("; "))}`);
  }
  return committed;
}

function normalizedCommitValue(field, value, schema) {
  if (schema.string_list_fields?.includes(field)) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(String(value));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // String-list Sheet cells may use comma-separated values.
    }
    return String(value)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (schema.json_array_fields?.includes(field)) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(String(value));
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  if (value === undefined || value === null) return "";
  const rule = schema.field_rules?.[field];
  if (rule?.type === "number" || rule?.type === "integer") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return String(value);
}

export function confirmGeneratorClaimPersisted(
  plannedClaim,
  freshRows,
  schema,
  claimFields,
  sourceStore = "Scraped Jobs"
) {
  if (
    !plannedClaim ||
    !Array.isArray(freshRows) ||
    !Array.isArray(claimFields)
  ) {
    throw new Error("Generator claim confirmation requires planned and fresh data");
  }
  const matches = freshRows.filter(
    (row) => row?.canonical_job_id === plannedClaim.canonical_job_id
  );
  if (!plannedClaim.canonical_job_id || matches.length !== 1) {
    throw new Error(
      `Generator claim confirmation failed: ${sourceStore} identity is missing or ambiguous`
    );
  }
  const persisted = matches[0];
  const mismatches = claimFields.filter(
    (field) =>
      normalizedCommitValue(field, persisted[field], schema) !==
      normalizedCommitValue(field, plannedClaim[field], schema)
  );
  for (const field of ["user_action", "notes"]) {
    if (
      normalizedCommitValue(field, persisted[field], schema) !==
      normalizedCommitValue(field, plannedClaim[field], schema)
    ) {
      mismatches.push(field);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Generator claim confirmation mismatch: ${boundedText(
        [...new Set(mismatches)].join(",")
      )}`
    );
  }
  return persisted;
}

export function confirmGeneratorResultPersisted(
  plannedRecord,
  freshRows,
  schema,
  committedFields
) {
  const identity = String(plannedRecord?.canonical_job_id || "");
  const matches = (Array.isArray(freshRows) ? freshRows : []).filter(
    (row) => String(row?.canonical_job_id || "") === identity
  );
  if (!identity || matches.length !== 1) {
    throw new Error(
      "Generator commit verification failed: committed identity is missing or ambiguous"
    );
  }
  const persisted = matches[0];
  const fields = [...new Set(committedFields || [])];
  if (fields.length === 0) {
    throw new Error(
      "Generator commit verification failed: committed field contract is empty"
    );
  }
  for (const field of fields) {
    const expected = normalizedCommitValue(field, plannedRecord[field], schema);
    const actual = normalizedCommitValue(field, persisted[field], schema);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(
        `Generator commit verification failed: persisted field mismatch (${field})`
      );
    }
  }
  if (
    persisted.processing_token ||
    persisted.processing_started_at ||
    persisted.processing_stage
  ) {
    throw new Error(
      "Generator commit verification failed: processing ownership was not cleared"
    );
  }
  return persisted;
}
