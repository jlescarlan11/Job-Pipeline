import {
  validateApplicationPolicy,
  validateCandidateProfile
} from "./profile.mjs";

const SHEET_VERSION_PATTERN = /^sheet\/[a-f0-9]{16}$/;

function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function enabled(value) {
  return value === true || /^(?:true|yes|1)$/i.test(normalizedText(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function sheetContextVersion(value) {
  const input = JSON.stringify(stableValue(value));
  let left = 2166136261;
  let right = 3339675911;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left ^= code;
    left = Math.imul(left, 16777619);
    right ^= code + index;
    right = Math.imul(right, 2246822519);
  }
  return `sheet/${(left >>> 0).toString(16).padStart(8, "0")}${(
    right >>> 0
  )
    .toString(16)
    .padStart(8, "0")}`;
}

function nonemptyRows(rows) {
  return (rows ?? []).filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.entries(row).some(
        ([key, value]) => key !== "row_number" && normalizedText(value)
      )
  );
}

function uniqueFieldRows(rows, sheetName) {
  const values = new Map();
  for (const row of nonemptyRows(rows)) {
    const field = normalizedText(row.field);
    if (!field) throw new Error(`${sheetName} contains a row without field`);
    if (values.has(field)) {
      throw new Error(`${sheetName} contains duplicate field: ${field}`);
    }
    values.set(field, normalizedText(row.value));
  }
  return values;
}

function requireFields(values, fields, sheetName) {
  for (const field of fields) {
    if (!values.get(field)) {
      throw new Error(`${sheetName} is missing required field: ${field}`);
    }
  }
}

function parseList(value) {
  const text = normalizedText(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizedText).filter(Boolean);
      }
    } catch {
      throw new Error("Projects contains an invalid technologies list");
    }
  }
  return text
    .split(",")
    .map(normalizedText)
    .filter(Boolean);
}

function mergeEntities(rows, {
  sheetName,
  idField,
  scalarFields,
  listField,
  outputListField
}) {
  const entities = new Map();
  for (const row of nonemptyRows(rows).filter((entry) => enabled(entry.enabled))) {
    const id = normalizedText(row[idField]);
    if (!id) throw new Error(`${sheetName} contains an enabled row without ${idField}`);
    const scalars = Object.fromEntries(
      scalarFields.map((field) => [field, normalizedText(row[field])])
    );
    const current = entities.get(id);
    if (!current) {
      entities.set(id, {
        id,
        ...scalars,
        [outputListField]: []
      });
    } else {
      for (const field of scalarFields) {
        if (current[field] !== scalars[field]) {
          throw new Error(`${sheetName} has conflicting ${field} values for ${id}`);
        }
      }
    }
    const item = normalizedText(row[listField]);
    if (item && !entities.get(id)[outputListField].includes(item)) {
      entities.get(id)[outputListField].push(item);
    }
  }
  return [...entities.values()];
}

function profileReferenceExists(reference, profile) {
  if (reference === "summary") return Boolean(profile.summary);
  if (reference.startsWith("experience:")) {
    return profile.experience.some(
      (entry) => entry.id === reference.slice("experience:".length)
    );
  }
  if (reference.startsWith("projects:")) {
    return profile.projects.some(
      (entry) => entry.id === reference.slice("projects:".length)
    );
  }
  const skill = reference.match(/^skills\.([^:]+):(.+)$/);
  return skill
    ? profile.skills?.[skill[1]]?.includes(skill[2]) ?? false
    : false;
}

export function profileFromSheetRows({
  candidateRows,
  skillRows,
  experienceRows,
  projectRows,
  educationRows,
  awardRows
}) {
  const candidate = uniqueFieldRows(candidateRows, "Candidate");
  requireFields(
    candidate,
    ["name", "location", "email", "summary", "linkedin", "github", "portfolio"],
    "Candidate"
  );

  const skills = {};
  for (const row of nonemptyRows(skillRows).filter((entry) => enabled(entry.enabled))) {
    const category = normalizedText(row.category);
    const skill = normalizedText(row.skill);
    if (!category || !skill) {
      throw new Error("Skills contains an enabled incomplete row");
    }
    skills[category] ??= [];
    if (skills[category].some((value) => value.toLowerCase() === skill.toLowerCase())) {
      throw new Error(`Skills contains duplicate skill: ${skill}`);
    }
    skills[category].push(skill);
  }

  const experience = mergeEntities(experienceRows, {
    sheetName: "Experience",
    idField: "experience_id",
    scalarFields: ["title", "organization", "location", "start", "end"],
    listField: "highlight",
    outputListField: "highlights"
  });

  const projects = mergeEntities(projectRows, {
    sheetName: "Projects",
    idField: "project_id",
    scalarFields: ["name", "description", "url", "technologies"],
    listField: "highlight",
    outputListField: "highlights"
  }).map(({ technologies, ...project }) => ({
    ...project,
    technologies: parseList(technologies)
  }));

  const education = nonemptyRows(educationRows)
    .filter((row) => enabled(row.enabled))
    .map((row) => ({
      program: normalizedText(row.program),
      institution: normalizedText(row.institution),
      start: normalizedText(row.start),
      end: normalizedText(row.end),
      honor: normalizedText(row.honor)
    }));
  const awardsAndCertifications = nonemptyRows(awardRows)
    .filter((row) => enabled(row.enabled))
    .map((row) => normalizedText(row.award))
    .filter(Boolean);

  const profile = {
    schema_version: 1,
    profile_version: "",
    candidate: {
      name: candidate.get("name"),
      location: candidate.get("location"),
      email: candidate.get("email"),
      links: {
        linkedin: candidate.get("linkedin"),
        github: candidate.get("github"),
        portfolio: candidate.get("portfolio")
      }
    },
    summary: candidate.get("summary"),
    skills,
    experience,
    projects,
    education,
    awards_and_certifications: awardsAndCertifications
  };
  profile.profile_version = sheetContextVersion({ ...profile, profile_version: "" });
  const errors = validateCandidateProfile(profile);
  if (errors.length > 0) {
    throw new Error(`Invalid candidate Sheet context: ${errors.join("; ")}`);
  }
  return profile;
}

function enabledTextRows(rows, field, sheetName) {
  const values = [];
  const seen = new Set();
  for (const row of nonemptyRows(rows).filter((entry) => enabled(entry.enabled))) {
    const value = normalizedText(row[field]);
    if (!value) {
      throw new Error(`${sheetName} contains an enabled blank row`);
    }
    const identity = value.toLocaleLowerCase("en-US");
    if (seen.has(identity)) {
      throw new Error(`${sheetName} contains duplicate value: ${value}`);
    }
    seen.add(identity);
    values.push(value);
  }
  return values;
}

function parseApplicationPreferences(
  { applicationSettingRows, requiredStyleRows, bannedPhraseRows },
  profile,
  basePolicy
) {
  const settings = new Map();
  for (const row of nonemptyRows(applicationSettingRows)) {
    const key = normalizedText(row.key);
    const value = normalizedText(row.value);
    if (!key || !value || settings.has(key)) {
      throw new Error("Application Settings contains an invalid or duplicate setting");
    }
    settings.set(key, value);
  }
  const requiredStyle = enabledTextRows(
    requiredStyleRows,
    "style",
    "Required Style"
  );
  const bannedPhrases = enabledTextRows(
    bannedPhraseRows,
    "phrase",
    "Banned Phrases"
  );
  requireFields(
    settings,
    [
      "max_body_words",
      "subject_template",
      "default_greeting",
      "employer_format_overrides_default"
    ],
    "Application Settings"
  );
  const maxBodyWords = Number(settings.get("max_body_words"));
  if (!Number.isInteger(maxBodyWords) || maxBodyWords < 1 || maxBodyWords > 500) {
    throw new Error("Application Settings max_body_words must be from 1 through 500");
  }
  const employerOverride = settings.get("employer_format_overrides_default");
  if (!/^(?:true|false)$/i.test(employerOverride)) {
    throw new Error("Application Settings employer_format_overrides_default must be true or false");
  }
  const source = {
    settings: Object.fromEntries(settings),
    required_style: requiredStyle,
    banned_phrases: bannedPhrases
  };
  const policy = {
    ...structuredClone(basePolicy),
    policy_version: sheetContextVersion(source),
    candidate_profile_version: profile.profile_version,
    max_body_words: maxBodyWords,
    subject_template: settings
      .get("subject_template")
      .replaceAll("{{candidate_name}}", profile.candidate.name),
    default_greeting: settings.get("default_greeting"),
    employer_format_overrides_default: /^true$/i.test(employerOverride),
    approved_candidate_url_keys: Object.keys(profile.candidate.links),
    approved_project_ids: profile.projects.map((project) => project.id),
    required_style: requiredStyle,
    banned_phrases: bannedPhrases
  };
  const errors = validateApplicationPolicy(policy, profile);
  if (errors.length > 0) {
    throw new Error(`Invalid application Sheet context: ${errors.join("; ")}`);
  }
  return policy;
}

function parseJobPreferences(rows, profile, basePolicy) {
  const sourceRows = nonemptyRows(rows).filter((entry) => enabled(entry.enabled));
  const roleFamilyEvidence = {};
  const unsupportedTechnologies = [];
  const salaryBands = [];
  for (const row of sourceRows) {
    const type = normalizedText(row.type);
    const group = normalizedText(row.group);
    const value = normalizedText(row.value);
    if (type === "role_family_evidence") {
      if (!group || !value || !profileReferenceExists(value, profile)) {
        throw new Error("Job Preferences contains an invalid role-family evidence reference");
      }
      roleFamilyEvidence[group] ??= [];
      if (!roleFamilyEvidence[group].includes(value)) {
        roleFamilyEvidence[group].push(value);
      }
    } else if (type === "unsupported_technology") {
      if (!value) throw new Error("Job Preferences contains a blank unsupported technology");
      unsupportedTechnologies.push(value);
    } else if (type === "salary_band") {
      const minimum = Number(value);
      const score = Number(row.score);
      if (!Number.isFinite(minimum) || minimum < 0 || !Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error("Job Preferences contains an invalid salary band");
      }
      salaryBands.push({ minimum, score });
    } else {
      throw new Error("Job Preferences contains an unsupported enabled row");
    }
  }
  if (salaryBands.length === 0) {
    throw new Error("Job Preferences requires at least one enabled salary band");
  }
  salaryBands.sort((left, right) => right.minimum - left.minimum);
  const policy = structuredClone(basePolicy);
  policy.policy_version = sheetContextVersion(sourceRows.map((row) => ({
    type: normalizedText(row.type),
    group: normalizedText(row.group),
    value: normalizedText(row.value),
    score: normalizedText(row.score)
  })));
  policy.candidate_profile_version = profile.profile_version;
  policy.qualification.role_family_evidence = roleFamilyEvidence;
  policy.qualification.unsupported_technologies = [
    ...new Set(unsupportedTechnologies)
  ];
  policy.opportunity.salary.bands = salaryBands;
  return policy;
}

export function compileSheetContext(
  rows,
  { rankingPolicy, applicationPolicy, packPolicy }
) {
  const profile = profileFromSheetRows(rows);
  const effectiveApplicationPolicy = parseApplicationPreferences(
    {
      applicationSettingRows: rows.applicationSettingRows,
      requiredStyleRows: rows.requiredStyleRows,
      bannedPhraseRows: rows.bannedPhraseRows
    },
    profile,
    applicationPolicy
  );
  const effectiveRankingPolicy = parseJobPreferences(
    rows.jobPreferenceRows,
    profile,
    rankingPolicy
  );
  const effectivePackPolicy = {
    ...structuredClone(packPolicy),
    candidate_profile_version: profile.profile_version,
    application_policy_version: effectiveApplicationPolicy.policy_version
  };
  return {
    source: "google_sheets",
    captured_at: new Date().toISOString(),
    profile,
    ranking_policy: effectiveRankingPolicy,
    application_policy: effectiveApplicationPolicy,
    pack_policy: effectivePackPolicy
  };
}

export function isSheetContextVersion(value) {
  return SHEET_VERSION_PATTERN.test(normalizedText(value));
}
