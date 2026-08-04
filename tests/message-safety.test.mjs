import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildApplicationPack } from "../src/evaluation.mjs";
import { evaluatePersistedMessageSafety } from "../src/message-safety.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const profile = await loadJson("../config/candidate-profile.json");
const applicationPolicy = await loadJson(
  "../config/application-policy.json"
);
const packPolicy = await loadJson(
  "../config/application-pack-policy.json"
);
const context = { profile, applicationPolicy, packPolicy };
const now = "2026-07-28T12:00:00.000Z";

const baseJob = {
  canonical_job_id: "onlinejobs.ph:safety-control",
  job_title: "TypeScript Developer",
  source_availability: "active",
  job_description:
    "Build and maintain TypeScript, React, Node.js, and PostgreSQL product features for production workflows."
};
const basePack = buildApplicationPack(
  baseJob,
  profile,
  applicationPolicy,
  packPolicy,
  now
);
const currentSafe = (overrides = {}) => ({
  ...baseJob,
  pipeline_status: "ready_to_apply",
  prep_status: "message_ready",
  preparation_version: 1,
  preparation_input_guard: `prep-v1:${"a".repeat(64)}`,
  preparation_updated_at: now,
  generated_message:
    "Subject line: TypeScript Developer Application — John Lester Escarlan\n\nHi there,\n\nI delivered three client-facing features using React, TypeScript, and Node.js.\n\nI would welcome a conversation about how my experience fits this role.\n\nPortfolio: https://johnlesterescarlan.pro",
  message_profile_version: profile.profile_version,
  message_policy_version: applicationPolicy.policy_version,
  message_validation_status: "valid",
  application_instructions: basePack.application_instructions,
  screening_questions: basePack.screening_questions,
  requirement_coverage: basePack.requirement_coverage,
  application_message_plan: [basePack.message_plan],
  selected_proof_refs: basePack.selected_proof_refs,
  application_warnings: basePack.application_warnings,
  application_pack_status: basePack.application_pack_status,
  application_pack_version: basePack.application_pack_version,
  application_pack_profile_version: basePack.application_pack_profile_version,
  application_pack_policy_version: basePack.application_pack_policy_version,
  coverage_contract_version: basePack.coverage_contract_version,
  message_plan_version: basePack.message_plan.version,
  application_pack_generated_at: basePack.application_pack_generated_at,
  ...overrides
});

test("a current validated persisted message and pack pass the shared gate", () => {
  assert.deepEqual(
    evaluatePersistedMessageSafety(currentSafe(), context),
    { safe: true, reasons: [] }
  );
});

test("persisted safety rejects quantity relationships stitched inside one proof", () => {
  for (const claim of [
    "I resolved 24 production-blocking defects with an average turnaround of 12+ hours.",
    "I rebuilt release automation to remove four manual steps and save 15+ engineering hours per week."
  ]) {
    const result = evaluatePersistedMessageSafety(
      currentSafe({
        generated_message: `Subject line: TypeScript Developer Application — John Lester Escarlan

Hi there,

${claim}

I would welcome a conversation about how my experience fits this role.`
      }),
      context
    );
    assert.equal(result.safe, false, claim);
    assert.ok(result.reasons.includes("message_content_invalid"), claim);
  }
});

test("persisted message safety reports every provenance, content, and pack quarantine reason", () => {
  const cases = [
    ["message_profile_legacy", { message_profile_version: "legacy/unknown" }],
    ["message_profile_missing", { message_profile_version: "" }],
    ["message_profile_mismatch", { message_profile_version: "2025-01-01" }],
    ["message_policy_missing", { message_policy_version: "" }],
    ["message_policy_mismatch", { message_policy_version: "2025-01-01" }],
    ["message_validation_not_valid", { message_validation_status: "" }],
    ["message_missing", { generated_message: "" }],
    [
      "message_content_invalid",
      {
        generated_message:
          "Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf"
      }
    ],
    [
      "message_content_invalid",
      { generated_message: "I have a strong foundation in TypeScript." }
    ],
    ["pack_status_not_ready", { application_pack_status: "review_required" }],
    ["pack_version_mismatch", { application_pack_version: "old/v1" }],
    ["coverage_version_mismatch", { coverage_contract_version: "old/v1" }],
    ["message_plan_version_mismatch", { message_plan_version: "old/v1" }],
    ["coverage_missing", { requirement_coverage: "forged" }],
    ["message_plan_missing", { application_message_plan: [] }],
    [
      "pack_profile_mismatch",
      { application_pack_profile_version: "2025-01-01" }
    ],
    [
      "pack_policy_mismatch",
      { application_pack_policy_version: "old/v1" }
    ],
    ["pack_invalid", { application_pack_generated_at: "not-a-date" }]
  ];
  for (const [reason, overrides] of cases) {
    const result = evaluatePersistedMessageSafety(
      currentSafe(overrides),
      context
    );
    assert.equal(result.safe, false);
    assert.ok(
      result.reasons.includes(reason),
      `${reason} was not reported`
    );
  }
});

test("combined unsafe evidence stays deterministic and fail-closed", () => {
  const result = evaluatePersistedMessageSafety(
    currentSafe({
      generated_message:
        "I have a strong foundation. Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
      message_profile_version: "legacy/unknown",
      message_policy_version: "",
      message_validation_status: "",
      application_pack_status: "",
      application_pack_version: "",
      application_pack_profile_version: "",
      application_pack_policy_version: "",
      coverage_contract_version: "",
      message_plan_version: "",
      application_pack_generated_at: ""
    }),
    context
  );
  assert.deepEqual(result.reasons, [
    "message_profile_legacy",
    "message_policy_missing",
    "message_validation_not_valid",
    "pack_status_not_ready",
    "pack_version_mismatch",
    "pack_profile_mismatch",
    "pack_policy_mismatch",
    "coverage_version_mismatch",
      "message_plan_version_mismatch",
      "pack_not_canonical",
      "pack_invalid",
    "message_content_invalid"
  ]);
});

test("missing safety configuration cannot authorize dispatch", () => {
  assert.deepEqual(evaluatePersistedMessageSafety(currentSafe()), {
    safe: false,
    reasons: ["message_safety_configuration_missing"]
  });
});

test("stale ready messages retain historical provenance and fail closed after a profile update", () => {
  const historical = currentSafe({
    message_profile_version: "2026-07-28",
    application_pack_profile_version: "2026-07-28"
  });
  const snapshot = structuredClone(historical);

  const result = evaluatePersistedMessageSafety(historical, context);

  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes("message_profile_mismatch"));
  assert.ok(result.reasons.includes("pack_profile_mismatch"));
  assert.deepEqual(historical, snapshot);
  assert.equal(historical.generated_message, snapshot.generated_message);
});

test("persisted coverage cannot forge references, erase differences, or hide missing evidence", () => {
  const requirement = {
    id: "instruction-1",
    type: "content",
    text: "Please include a project summary.",
    required: true,
    ambiguous: false
  };
  const coverageBase = {
    id: "coverage-instruction-1-element-1",
    requirement_id: "instruction-1",
    element_id: "instruction-1-element-1",
    element_kind: "project_summary",
    element: "Project summary",
    required: true,
    evidence_refs: ["projects:job-pipeline"],
    material_differences: []
  };
  const planRequirement = {
    requirement_id: "instruction-1",
    type: "content",
    text: requirement.text,
    required: true,
    disposition: "exact",
    coverage_ids: [coverageBase.id],
    evidence_refs: ["projects:job-pipeline"],
    material_differences: []
  };
  const base = currentSafe({
    application_instructions: [requirement],
    requirement_coverage: [{ ...coverageBase, classification: "exact" }],
    application_message_plan: [
      {
        version: packPolicy.message_plan_version,
        subject_line:
          "Subject line: TypeScript Developer Application — John Lester Escarlan",
        requirements: [planRequirement]
      }
    ]
  });

  const cases = [
    {
      requirement_coverage: [
        { ...coverageBase, required: false, classification: "exact" }
      ],
      application_message_plan: [
        {
          ...base.application_message_plan[0],
          requirements: [{ ...planRequirement, required: false }]
        }
      ]
    },
    {
      requirement_coverage: [
        {
          ...coverageBase,
          classification: "exact",
          evidence_refs: ["projects:not-approved"]
        }
      ]
    },
    {
      requirement_coverage: [
        { ...coverageBase, classification: "adjacent", material_differences: [] }
      ],
      application_message_plan: [
        {
          ...base.application_message_plan[0],
          requirements: [
            { ...planRequirement, disposition: "adjacent", material_differences: [] }
          ]
        }
      ]
    },
    {
      requirement_coverage: [
        {
          ...coverageBase,
          classification: "missing",
          evidence_refs: [],
          required_candidate_input: "Approved candidate evidence for: Project summary"
        }
      ],
      application_message_plan: [
        {
          ...base.application_message_plan[0],
          requirements: [
            {
              ...planRequirement,
              disposition: "missing",
              evidence_refs: []
            }
          ]
        }
      ]
    }
  ];
  for (const overrides of cases) {
    const result = evaluatePersistedMessageSafety({ ...base, ...overrides }, context);
    assert.equal(result.safe, false);
    assert.ok(result.reasons.includes("pack_invalid"));
  }
});

test("persisted safety recomputes requirements instead of trusting a forged exact strategy", () => {
  const forged = currentSafe({
    job_title: "Terraform Engineer",
    job_description:
      "Build infrastructure automation. Please describe one production workflow you built using Terraform.",
    generated_message:
      "Subject line: Terraform Engineer Application — John Lester Escarlan\n\nHi there,\n\nI built Job Pipeline using Terraform and Temporal for production automation.\n\nI would welcome a conversation about how my experience fits this role.",
    application_instructions: [
      {
        id: "instruction-1",
        type: "content",
        text: "Please describe one production workflow you built using Terraform.",
        required: true,
        ambiguous: false
      }
    ],
    requirement_coverage: [
      {
        id: "coverage-instruction-1-element-1",
        requirement_id: "instruction-1",
        element_id: "instruction-1-element-1",
        element_kind: "named_technology",
        element: "Use of Terraform",
        required: true,
        classification: "exact",
        evidence_refs: ["projects:job-pipeline"],
        material_differences: []
      }
    ],
    application_message_plan: [
      {
        version: packPolicy.message_plan_version,
        subject_line:
          "Subject line: Terraform Engineer Application — John Lester Escarlan",
        requirements: [
          {
            requirement_id: "instruction-1",
            type: "content",
            text: "Please describe one production workflow you built using Terraform.",
            required: true,
            disposition: "exact",
            coverage_ids: ["coverage-instruction-1-element-1"],
            evidence_refs: ["projects:job-pipeline"],
            material_differences: []
          }
        ]
      }
    ]
  });
  const result = evaluatePersistedMessageSafety(forged, context);
  assert.equal(result.safe, false);
  assert.ok(result.reasons.includes("pack_not_canonical"));
  assert.ok(result.reasons.includes("pack_invalid"));

  const fallbackPlan = evaluatePersistedMessageSafety(
    {
      ...currentSafe(),
      application_message_plan: [],
      message_plan: currentSafe().application_message_plan[0]
    },
    context
  );
  assert.equal(fallbackPlan.safe, false);
  assert.ok(fallbackPlan.reasons.includes("message_plan_missing"));
});
