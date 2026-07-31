import { parseHttpUrl } from "./contracts.mjs";

const PROFILE_VERSION_PATTERN = /^(?:\d{4}-\d{2}-\d{2}|sheet\/[a-f0-9]{16})$/;
const UNRESOLVED_PLACEHOLDER_PATTERN =
  /\[(?:add|insert|month|year|tbd|todo|unknown|not provided)\b[^\]]*\]/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  if (policy.schema_version !== 1) errors.push("policy schema_version must be 1");
  if (!PROFILE_VERSION_PATTERN.test(policy.policy_version ?? "")) {
    errors.push("policy_version must use YYYY-MM-DD or sheet/<context-hash>");
  }
  if (policy.candidate_profile_version !== profile?.profile_version) {
    errors.push("policy candidate_profile_version must match the candidate profile");
  }
  if (policy.manual_submission_required !== true) {
    errors.push("manual_submission_required must be true");
  }
  if (!Number.isInteger(policy.max_body_words) || policy.max_body_words < 1) {
    errors.push("max_body_words must be a positive integer");
  }

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
