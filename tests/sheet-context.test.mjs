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
    applicationPreferenceRows: structuredClone(
      sheets.application_preferences.initial_rows
    )
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
  assert.equal(
    context.pack_policy.candidate_profile_version,
    profile.profile_version
  );
  assert.equal(
    context.pack_policy.application_policy_version,
    context.application_policy.policy_version
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
  preferenceEdit.applicationPreferenceRows.find(
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
});
