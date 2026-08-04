import {
  buildApplicationPack,
  validateApplicationPack,
  validateGeneratedMessage
} from "./evaluation.mjs";
import { profileEvidenceText } from "./profile.mjs";

function hydratedPersistedPack(record, profile) {
  const planEntries = Array.isArray(record?.application_message_plan)
    ? record.application_message_plan
    : [];
  const messagePlan =
    planEntries.length === 1 &&
    planEntries[0] &&
    typeof planEntries[0] === "object" &&
    !Array.isArray(planEntries[0])
      ? planEntries[0]
      : null;
  const selectedProofs = (record?.selected_proof_refs ?? [])
    .map((reference) => {
      const [kind, id] = String(reference).split(":");
      const entry =
        kind === "projects"
          ? profile.projects?.find((project) => project.id === id)
          : kind === "experience"
            ? profile.experience?.find((experience) => experience.id === id)
            : null;
      if (!entry) return null;
      return {
        reference,
        label:
          kind === "projects"
            ? entry.name
            : `${entry.title} — ${entry.organization}`,
        evidence: profileEvidenceText(entry)
      };
    })
    .filter(Boolean);
  return {
    ...record,
    message_plan: messagePlan,
    selected_proofs: selectedProofs
  };
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

function sameContractValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function evaluatePersistedMessageSafety(
  record,
  { profile, applicationPolicy, packPolicy } = {}
) {
  if (!profile || !applicationPolicy || !packPolicy) {
    return {
      safe: false,
      reasons: ["message_safety_configuration_missing"]
    };
  }

  const reasons = [];
  if (record?.pipeline_status !== "ready_to_apply") {
    reasons.push("message_owner_not_to_apply");
  }
  if (record?.prep_status !== "message_ready") {
    reasons.push("preparation_not_message_ready");
  }
  const messageProfileVersion = String(
    record?.message_profile_version || ""
  ).trim();
  if (messageProfileVersion === "legacy/unknown") {
    reasons.push("message_profile_legacy");
  } else if (!messageProfileVersion) {
    reasons.push("message_profile_missing");
  } else if (messageProfileVersion !== profile.profile_version) {
    reasons.push("message_profile_mismatch");
  }

  const messagePolicyVersion = String(
    record?.message_policy_version || ""
  ).trim();
  if (!messagePolicyVersion) {
    reasons.push("message_policy_missing");
  } else if (messagePolicyVersion !== applicationPolicy.policy_version) {
    reasons.push("message_policy_mismatch");
  }
  if (record?.message_validation_status !== "valid") {
    reasons.push("message_validation_not_valid");
  }
  if (!String(record?.generated_message || "").trim()) {
    reasons.push("message_missing");
  }

  if (record?.application_pack_status !== "ready") {
    reasons.push("pack_status_not_ready");
  }
  if (record?.application_pack_version !== packPolicy.pack_version) {
    reasons.push("pack_version_mismatch");
  }
  if (
    record?.application_pack_profile_version !== profile.profile_version
  ) {
    reasons.push("pack_profile_mismatch");
  }
  if (
    record?.application_pack_policy_version !== packPolicy.policy_version
  ) {
    reasons.push("pack_policy_mismatch");
  }
  if (record?.coverage_contract_version !== packPolicy.coverage_contract_version) {
    reasons.push("coverage_version_mismatch");
  }
  if (record?.message_plan_version !== packPolicy.message_plan_version) {
    reasons.push("message_plan_version_mismatch");
  }
  if (!Array.isArray(record?.requirement_coverage)) {
    reasons.push("coverage_missing");
  }
  if (
    !Array.isArray(record?.application_message_plan) ||
    record.application_message_plan.length !== 1
  ) {
    reasons.push("message_plan_missing");
  }

  let canonicalPack = null;
  try {
    canonicalPack = buildApplicationPack(
      { ...record, user_action: "" },
      profile,
      applicationPolicy,
      packPolicy,
      record?.application_pack_generated_at || new Date(0).toISOString()
    );
  } catch {
    reasons.push("pack_recomputation_failed");
  }
  if (canonicalPack) {
    const canonicalFields = [
      ["application_instructions", canonicalPack.application_instructions],
      ["screening_questions", canonicalPack.screening_questions],
      ["requirement_coverage", canonicalPack.requirement_coverage],
      ["application_message_plan", [canonicalPack.message_plan]],
      ["selected_proof_refs", canonicalPack.selected_proof_refs],
      ["application_warnings", canonicalPack.application_warnings],
      ["application_pack_status", canonicalPack.application_pack_status],
      ["application_pack_version", canonicalPack.application_pack_version],
      [
        "application_pack_profile_version",
        canonicalPack.application_pack_profile_version
      ],
      [
        "application_pack_policy_version",
        canonicalPack.application_pack_policy_version
      ],
      ["coverage_contract_version", canonicalPack.coverage_contract_version],
      ["message_plan_version", canonicalPack.message_plan.version]
    ];
    if (
      canonicalFields.some(([field, expected]) =>
        !sameContractValue(record?.[field], expected)
      )
    ) {
      reasons.push("pack_not_canonical");
    }
  }

  const hydratedPack = hydratedPersistedPack(record, profile);
  const packErrors = validateApplicationPack(hydratedPack, profile, packPolicy);
  if (packErrors.length > 0) reasons.push("pack_invalid");
  const messageValidation = validateGeneratedMessage(
    record?.generated_message,
    {
      job: record,
      profile,
      policy: applicationPolicy,
      pack: hydratedPack
    }
  );
  if (!messageValidation.valid) reasons.push("message_content_invalid");

  return {
    safe: reasons.length === 0,
    reasons
  };
}
