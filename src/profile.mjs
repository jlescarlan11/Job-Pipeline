import {
  isDailyApplicationLimitFieldName,
  parseHttpUrl
} from "./contracts.mjs";

const PROFILE_VERSION_PATTERN = /^(?:\d{4}-\d{2}-\d{2}|sheet\/[a-f0-9]{16})$/;
const APPLICATION_POLICY_VERSION_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}\/autonomous-v\d+|sheet\/[a-f0-9]{16})$/;
function dailyApplicationLimitKeys(value, path = "", output = []) {
  if (Array.isArray(value)) {
    value.forEach((nested, index) =>
      dailyApplicationLimitKeys(nested, `${path}[${index}]`, output)
    );
    return output;
  }
  if (!isPlainObject(value)) return output;
  for (const [key, nested] of Object.entries(value)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const scalar =
      nested === null || typeof nested === "object" ? "" : String(nested);
    if (isDailyApplicationLimitFieldName(`${fieldPath} ${scalar}`)) {
      output.push(fieldPath);
    }
    dailyApplicationLimitKeys(nested, fieldPath, output);
  }
  return output;
}
const UNRESOLVED_PLACEHOLDER_PATTERN =
  /\[(?:add|insert|month|year|tbd|todo|unknown|not provided)\b[^\]]*\]/i;

export const APPLICATION_PROMPT_TEMPLATE_CONTRACT = Object.freeze({
  application_system: [
    "candidate_name",
    "authoritative_identity_json",
    "message_policy_json",
    "maximum_words"
  ],
  application_user: [
    "job_title",
    "company",
    "message_plan_json",
    "selected_proofs_json",
    "safe_employer_formatting_json",
    "screening_questions_to_answer_json",
    "unresolved_screening_questions_json",
    "application_warnings_json",
    "unsupported_requirements_json",
    "operator_review_context_json",
    "safe_job_description"
  ],
  application_repair_system: ["candidate_name"],
  application_repair_user: [
    "selected_proofs_json",
    "message_plan_json",
    "safe_employer_formatting_json",
    "screening_questions_to_answer_json",
    "validation_errors_json",
    "rejected_message"
  ],
  application_repair_user_compact: [
    "selected_proofs_json",
    "message_plan_json",
    "safe_employer_formatting_json",
    "screening_questions_to_answer_json",
    "validation_errors_json",
    "rejected_message"
  ]
});

function promptTemplateTags(template) {
  const tags = [];
  const pattern = /\{\{([#^\/]?)([a-z][a-z0-9_]*)\}\}/g;
  let match;
  while ((match = pattern.exec(template)) !== null) {
    tags.push({ marker: match[1], name: match[2] });
  }
  return tags;
}

export function validateApplicationPromptTemplates(templates) {
  const errors = [];
  if (!isPlainObject(templates)) return ["prompt_templates must be an object"];
  const expectedKeys = Object.keys(APPLICATION_PROMPT_TEMPLATE_CONTRACT);
  const actualKeys = Object.keys(templates);
  for (const key of expectedKeys) {
    const template = templates[key];
    if (typeof template !== "string" || !template.trim()) {
      errors.push(`prompt template ${key} is required`);
      continue;
    }
    if (template.length > 45000) {
      errors.push(`prompt template ${key} exceeds the Google Sheets cell limit`);
      continue;
    }
    const recognizedText = template.replace(
      /\{\{[#^\/]?[a-z][a-z0-9_]*\}\}/g,
      ""
    );
    if (/\{\{|\}\}/.test(recognizedText)) {
      errors.push(`prompt template ${key} contains malformed placeholders`);
      continue;
    }
    const allowed = new Set(APPLICATION_PROMPT_TEMPLATE_CONTRACT[key]);
    const interpolations = new Set();
    const stack = [];
    for (const tag of promptTemplateTags(template)) {
      if (!allowed.has(tag.name)) {
        errors.push(`prompt template ${key} contains unsupported placeholder: ${tag.name}`);
        continue;
      }
      if (tag.marker === "#" || tag.marker === "^") {
        stack.push(tag.name);
      } else if (tag.marker === "/") {
        if (stack.pop() !== tag.name) {
          errors.push(`prompt template ${key} contains unbalanced block: ${tag.name}`);
        }
      } else {
        interpolations.add(tag.name);
      }
    }
    if (stack.length > 0) {
      errors.push(`prompt template ${key} contains an unclosed conditional block`);
    }
    for (const placeholder of allowed) {
      if (!interpolations.has(placeholder)) {
        errors.push(`prompt template ${key} is missing placeholder: ${placeholder}`);
      }
    }
  }
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) {
      errors.push(`unsupported prompt template key: ${key}`);
    }
  }
  return errors;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsupportedObjectKeys(value, allowed, path) {
  if (!isPlainObject(value)) return [];
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .map((key) => `${path}.${key} is unsupported`);
}

const APPLICATION_POLICY_KEYS = [
  "schema_version",
  "policy_version",
  "candidate_profile_version",
  "execution_mode",
  "automation_contract_version",
  "manual_submission_required",
  "selection_mode",
  "allowed_browser_hosts",
  "apply_points",
  "max_body_words",
  "subject_template",
  "default_greeting",
  "employer_format_overrides_default",
  "approved_candidate_url_keys",
  "approved_project_ids",
  "required_style",
  "prompt_templates",
  "prohibited_claims",
  "banned_phrases"
];

const APPLICATION_PACK_POLICY_KEYS = [
  "schema_version",
  "policy_version",
  "pack_version",
  "candidate_profile_version",
  "application_policy_version",
  "minimum_preferred_proofs",
  "maximum_proofs",
  "maximum_instructions",
  "maximum_questions",
  "maximum_answer_elements_per_requirement",
  "maximum_item_characters",
  "maximum_description_characters",
  "persistence_json_limits",
  "coverage_contract_version",
  "message_plan_version",
  "autonomous_resolution",
  "coverage_classifications",
  "review_approval",
  "required_markers",
  "ambiguous_markers",
  "instruction_markers",
  "unsafe_instruction_categories"
];

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
  } else if (isPlainObject(value)) {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
  return output;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    const normalized = String(value).trim().toLowerCase();
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  return [...duplicates];
}

function validateHttpsUrl(value, field, errors) {
  const url = parseHttpUrl(value);
  if (!url) {
    errors.push(`${field} must be a valid URL`);
  } else if (url.protocol !== "https:") {
    errors.push(`${field} must use https`);
  }
}

export function approvedCandidateUrls(profile) {
  const contactLinks = Object.values(profile?.candidate?.links ?? {});
  const projectLinks = (profile?.projects ?? []).map((project) => project.url).filter(Boolean);
  return [...new Set([...contactLinks, ...projectLinks])];
}

export function approvedSkillNames(profile) {
  return [
    ...new Set(
      Object.values(profile?.skills ?? {})
        .flat()
        .map((skill) => String(skill).trim())
        .filter(Boolean)
    )
  ];
}

export function approvedProjectNames(profile) {
  return (profile?.projects ?? []).map((project) => project.name);
}

export function profileEvidenceText(profile) {
  return collectStrings(profile).join("\n");
}

export function validateCandidateProfile(profile) {
  const errors = [];

  if (!isPlainObject(profile)) return ["profile must be an object"];
  if (profile.schema_version !== 1) errors.push("schema_version must be 1");
  if (!PROFILE_VERSION_PATTERN.test(profile.profile_version ?? "")) {
    errors.push("profile_version must use YYYY-MM-DD or sheet/<context-hash>");
  }
  if (!profile.candidate?.name) errors.push("candidate.name is required");
  if (!profile.candidate?.email) errors.push("candidate.email is required");
  if (!isPlainObject(profile.candidate?.links)) errors.push("candidate.links is required");
  if (!profile.summary) errors.push("summary is required");
  if (!isPlainObject(profile.skills) || Object.keys(profile.skills).length === 0) {
    errors.push("skills are required");
  }
  if (!Array.isArray(profile.experience) || profile.experience.length === 0) {
    errors.push("experience is required");
  }
  if (!Array.isArray(profile.projects) || profile.projects.length === 0) {
    errors.push("projects are required");
  }

  for (const [key, value] of Object.entries(profile.candidate?.links ?? {})) {
    validateHttpsUrl(value, `candidate.links.${key}`, errors);
  }
  for (const project of profile.projects ?? []) {
    if (!project.id || !project.name) errors.push("every project requires id and name");
    if (project.url) validateHttpsUrl(project.url, `projects.${project.id || "unknown"}.url`, errors);
    const technologyDuplicates = findDuplicates(project.technologies ?? []);
    if (technologyDuplicates.length > 0) {
      errors.push(
        `duplicate project technologies for ${project.id || "unknown"}: ${technologyDuplicates.join(", ")}`
      );
    }
  }

  const projectIdDuplicates = findDuplicates((profile.projects ?? []).map((project) => project.id));
  if (projectIdDuplicates.length > 0) errors.push(`duplicate project ids: ${projectIdDuplicates.join(", ")}`);

  const skills = approvedSkillNames(profile);
  const skillDuplicates = findDuplicates(Object.values(profile.skills ?? {}).flat());
  if (skillDuplicates.length > 0) errors.push(`duplicate skills: ${skillDuplicates.join(", ")}`);
  if (skills.length === 0) errors.push("at least one skill is required");

  const profileText = profileEvidenceText(profile);
  if (UNRESOLVED_PLACEHOLDER_PATTERN.test(profileText)) {
    errors.push("resume placeholders are not allowed");
  }

  return errors;
}

export function validateApplicationPolicy(policy, profile) {
  const errors = [];
  if (!isPlainObject(policy)) return ["policy must be an object"];
  errors.push(
    ...unsupportedObjectKeys(policy, APPLICATION_POLICY_KEYS, "policy"),
    ...unsupportedObjectKeys(
      policy.apply_points,
      [
        "mode",
        "value_source",
        "allocation_points",
        "save_points_behavior",
        "maximum_per_application"
      ],
      "policy.apply_points"
    ),
    ...unsupportedObjectKeys(
      policy.apply_points?.allocation_points,
      ["low_allocation", "normal_allocation", "high_allocation"],
      "policy.apply_points.allocation_points"
    )
  );
  if (policy.schema_version !== 2) errors.push("policy schema_version must be 2");
  if (!APPLICATION_POLICY_VERSION_PATTERN.test(policy.policy_version ?? "")) {
    errors.push(
      "policy_version must use YYYY-MM-DD/autonomous-vN or sheet/<context-hash>"
    );
  }
  if (policy.candidate_profile_version !== profile?.profile_version) {
    errors.push("policy candidate_profile_version must match the candidate profile");
  }
  if (!["legacy_manual", "autonomous_chrome"].includes(policy.execution_mode)) {
    errors.push("execution_mode must be legacy_manual or autonomous_chrome");
  }
  if (
    policy.execution_mode === "autonomous_chrome" &&
    policy.automation_contract_version !== "browser-contract-v1"
  ) {
    errors.push(
      "autonomous_chrome requires automation_contract_version browser-contract-v1"
    );
  }
  if (
    policy.execution_mode === "legacy_manual" &&
    String(policy.automation_contract_version || "")
  ) {
    errors.push("legacy_manual cannot authorize an automation contract");
  }
  if (
    Object.hasOwn(policy, "manual_submission_required") &&
    policy.manual_submission_required !== (policy.execution_mode === "legacy_manual")
  ) {
    errors.push("manual_submission_required contradicts execution_mode");
  }
  if (policy.selection_mode !== "truthful_apply_by_default") {
    errors.push("selection_mode must be truthful_apply_by_default");
  }
  for (const key of dailyApplicationLimitKeys(policy)) {
    errors.push(`daily application limit field is unsupported: ${key}`);
  }
  if (
    JSON.stringify(policy.allowed_browser_hosts) !==
    JSON.stringify(["onlinejobs.ph", "www.onlinejobs.ph"])
  ) {
    errors.push("allowed_browser_hosts must contain only the OnlineJobs hosts");
  }
  if (
    JSON.stringify(policy.apply_points) !==
    JSON.stringify({
      mode: "deterministic_per_application_allocation",
      value_source: "repository_owned_allocation_map",
      allocation_points: {
        low_allocation: 1,
        normal_allocation: 5,
        high_allocation: 10
      },
      save_points_behavior: "use_low_allocation",
      maximum_per_application: 10
    })
  ) {
    errors.push("apply_points must use the trusted per-application allocation map");
  }
  if (!Number.isInteger(policy.max_body_words) || policy.max_body_words < 1) {
    errors.push("max_body_words must be a positive integer");
  }
  errors.push(...validateApplicationPromptTemplates(policy.prompt_templates));

  const linkKeys = new Set(Object.keys(profile?.candidate?.links ?? {}));
  for (const key of policy.approved_candidate_url_keys ?? []) {
    if (!linkKeys.has(key)) errors.push(`unsupported approved_candidate_url_key: ${key}`);
  }

  const projectIds = new Set((profile?.projects ?? []).map((project) => project.id));
  for (const projectId of policy.approved_project_ids ?? []) {
    if (!projectIds.has(projectId)) errors.push(`unsupported approved_project_id: ${projectId}`);
  }

  return errors;
}

export function validateAutonomousResolutionPolicy(
  packPolicy,
  applicationPolicy
) {
  const errors = [];
  if (!isPlainObject(packPolicy)) {
    return ["application-pack policy must be an object"];
  }
  errors.push(
    ...unsupportedObjectKeys(
      packPolicy,
      APPLICATION_PACK_POLICY_KEYS,
      "application_pack_policy"
    ),
    ...unsupportedObjectKeys(
      packPolicy.persistence_json_limits,
      [
        "application_instructions",
        "screening_questions",
        "requirement_coverage",
        "application_message_plan",
        "application_warnings"
      ],
      "application_pack_policy.persistence_json_limits"
    ),
    ...unsupportedObjectKeys(
      packPolicy.autonomous_resolution,
      [
        "ready_and_answerable",
        "low_fit",
        "deterministically_unsupported",
        "missing_required_candidate_fact",
        "unsafe_external_action",
        "ambiguous_instruction"
      ],
      "application_pack_policy.autonomous_resolution"
    ),
    ...unsupportedObjectKeys(
      packPolicy.review_approval,
      ["acknowledgeable_warning_codes", "screening_question_answer_status"],
      "application_pack_policy.review_approval"
    ),
    ...unsupportedObjectKeys(
      packPolicy.instruction_markers,
      ["subject", "format", "submission", "attachment", "test", "evidence", "content"],
      "application_pack_policy.instruction_markers"
    ),
    ...unsupportedObjectKeys(
      packPolicy.unsafe_instruction_categories,
      ["policy_bypass", "hidden_configuration", "private_data", "automatic_action"],
      "application_pack_policy.unsafe_instruction_categories"
    )
  );
  if (
    packPolicy.application_policy_version !== applicationPolicy?.policy_version
  ) {
    errors.push("application-pack policy must match the application policy version");
  }
  const expected = {
    ready_and_answerable: "apply",
    low_fit: "apply",
    deterministically_unsupported: "apply",
    missing_required_candidate_fact: "blocked",
    unsafe_external_action: "blocked",
    ambiguous_instruction: "blocked"
  };
  if (
    JSON.stringify(packPolicy.autonomous_resolution) !== JSON.stringify(expected)
  ) {
    errors.push("autonomous_resolution must match the fail-closed decision contract");
  }
  for (const key of dailyApplicationLimitKeys(packPolicy)) {
    errors.push(`daily application limit field is unsupported: ${key}`);
  }
  return errors;
}

export function assertValidProfileConfiguration(profile, policy) {
  const errors = [
    ...validateCandidateProfile(profile),
    ...validateApplicationPolicy(policy, profile)
  ];
  if (errors.length > 0) {
    throw new Error(`Invalid candidate configuration:\n- ${errors.join("\n- ")}`);
  }
  return true;
}
