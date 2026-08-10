import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileSheetContext,
  isSheetContextVersion
} from "../src/sheet-context.mjs";
import { validateRankingPolicy } from "../src/evaluation.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const [review, profileSeed, rankingPolicy, applicationPolicy, packPolicy] =
  await Promise.all([
    loadJson("../config/review-sheet.json"),
    loadJson("../config/candidate-profile.json"),
    loadJson("../config/ranking-policy.json"),
    loadJson("../config/application-policy.json"),
    loadJson("../config/application-pack-policy.json")
  ]);

function seedRows() {
  const sheets = review.sheets;
  return {
    candidateRows: structuredClone(sheets.candidate.initial_rows),
    skillRows: structuredClone(sheets.skills.initial_rows),
    experienceRows: structuredClone(sheets.experience.initial_rows),
    projectRows: structuredClone(sheets.projects.initial_rows),
    educationRows: structuredClone(sheets.education.initial_rows),
    awardRows: structuredClone(sheets.awards.initial_rows),
    jobPreferenceRows: structuredClone(sheets.job_preferences.initial_rows),
    applicationSettingRows: structuredClone(
      sheets.application_settings.initial_rows
    ),
    requiredStyleRows: structuredClone(sheets.required_style.initial_rows),
    bannedPhraseRows: structuredClone(sheets.banned_phrases.initial_rows),
    promptTemplateRows: structuredClone(sheets.prompts.initial_rows)
  };
}

function compile(rows = seedRows()) {
  return compileSheetContext(rows, {
    rankingPolicy,
    applicationPolicy,
    packPolicy
  });
}

test("context tabs reconstruct the approved bootstrap profile and valid policies", () => {
  const context = compile();
  const { profile } = context;
  assert.equal(context.source, "google_sheets");
  assert.equal(isSheetContextVersion(profile.profile_version), true);
  assert.equal(
    isSheetContextVersion(context.ranking_policy.policy_version),
    true
  );
  assert.equal(
    isSheetContextVersion(context.application_policy.policy_version),
    true
  );
  assert.deepEqual(
    { ...profile, profile_version: profileSeed.profile_version },
    profileSeed
  );
  assert.deepEqual(validateRankingPolicy(context.ranking_policy, profile), []);
  assert.equal(
    context.application_policy.subject_template,
    "Subject line: {{job_title}} Application — John Lester Escarlan"
  );
  assert.equal(context.application_policy.execution_mode, "autonomous_chrome");
  assert.equal(
    context.application_policy.automation_contract_version,
    "browser-contract-v1"
  );
  assert.equal(
    context.pack_policy.candidate_profile_version,
    profile.profile_version
  );
  assert.equal(
    context.pack_policy.application_policy_version,
    context.application_policy.policy_version
  );
  assert.deepEqual(
    context.application_policy.prompt_templates,
    applicationPolicy.prompt_templates
  );
});

test("Sheet-only edits change the correct context hashes automatically", () => {
  const before = compile();
  const candidateEdit = seedRows();
  candidateEdit.skillRows.push({
    enabled: true,
    category: "backend",
    skill: "GraphQL"
  });
  const afterCandidate = compile(candidateEdit);
  assert.notEqual(
    afterCandidate.profile.profile_version,
    before.profile.profile_version
  );
  assert.ok(afterCandidate.profile.skills.backend.includes("GraphQL"));

  const preferenceEdit = seedRows();
  preferenceEdit.applicationSettingRows.find(
    (row) => row.key === "default_greeting"
  ).value = "Hello,";
  const afterPreference = compile(preferenceEdit);
  assert.equal(
    afterPreference.profile.profile_version,
    before.profile.profile_version
  );
  assert.notEqual(
    afterPreference.application_policy.policy_version,
    before.application_policy.policy_version
  );
  assert.equal(afterPreference.application_policy.default_greeting, "Hello,");

  const phraseEdit = seedRows();
  phraseEdit.bannedPhraseRows.push({
    enabled: true,
    phrase: "generic application wording"
  });
  const afterPhrase = compile(phraseEdit);
  assert.notEqual(
    afterPhrase.application_policy.policy_version,
    before.application_policy.policy_version
  );
  assert.ok(
    afterPhrase.application_policy.banned_phrases.includes(
      "generic application wording"
    )
  );

  const promptEdit = seedRows();
  promptEdit.promptTemplateRows.find(
    (row) => row.prompt_key === "application_system"
  ).template = promptEdit.promptTemplateRows.find(
    (row) => row.prompt_key === "application_system"
  ).template.replace("copy-ready", "concise and copy-ready");
  const afterPrompt = compile(promptEdit);
  assert.notEqual(
    afterPrompt.application_policy.policy_version,
    before.application_policy.policy_version
  );
  assert.match(
    afterPrompt.application_policy.prompt_templates.application_system,
    /concise and copy-ready/
  );
});

test("invalid or conflicting Sheet context fails closed", () => {
  const missingCandidate = seedRows();
  missingCandidate.candidateRows = missingCandidate.candidateRows.filter(
    (row) => row.field !== "email"
  );
  assert.throws(() => compile(missingCandidate), /missing required field: email/);

  const conflictingExperience = seedRows();
  conflictingExperience.experienceRows[1].organization = "Different Company";
  assert.throws(
    () => compile(conflictingExperience),
    /conflicting organization values/
  );

  const invalidPreference = seedRows();
  invalidPreference.jobPreferenceRows.find(
    (row) => row.type === "role_family_evidence"
  ).value = "experience:missing";
  assert.throws(
    () => compile(invalidPreference),
    /invalid role-family evidence reference/
  );

  const blankRequiredStyle = seedRows();
  blankRequiredStyle.requiredStyleRows.push({ enabled: true, style: "" });
  assert.throws(
    () => compile(blankRequiredStyle),
    /Required Style contains an enabled blank row/
  );

  const duplicateBannedPhrase = seedRows();
  duplicateBannedPhrase.bannedPhraseRows.push({
    enabled: true,
    phrase: "SOLID FOUNDATION"
  });
  assert.throws(
    () => compile(duplicateBannedPhrase),
    /Banned Phrases contains duplicate value/
  );

  const missingPrompt = seedRows();
  missingPrompt.promptTemplateRows = missingPrompt.promptTemplateRows.filter(
    (row) => row.prompt_key !== "application_repair_user_compact"
  );
  assert.throws(
    () => compile(missingPrompt),
    /application_repair_user_compact is required/
  );

  const malformedPrompt = seedRows();
  malformedPrompt.promptTemplateRows.find(
    (row) => row.prompt_key === "application_user"
  ).template += "\n{{unknown_prompt_value}}";
  assert.throws(
    () => compile(malformedPrompt),
    /unsupported placeholder: unknown_prompt_value/
  );

  const dailyCap = seedRows();
  dailyCap.applicationSettingRows.push({
    key: "max_applications_per_day",
    value: "10"
  });
  assert.throws(
    () => compile(dailyCap),
    /unsupported setting: max_applications_per_day/
  );
});
