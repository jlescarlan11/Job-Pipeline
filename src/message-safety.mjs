import {
  validateApplicationPack,
  validateGeneratedMessage
} from "./evaluation.mjs";

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

  const packErrors = validateApplicationPack(record, profile, packPolicy);
  if (packErrors.length > 0) reasons.push("pack_invalid");
  const messageValidation = validateGeneratedMessage(
    record?.generated_message,
    {
      job: record,
      profile,
      policy: applicationPolicy,
      pack: record
    }
  );
  if (!messageValidation.valid) reasons.push("message_content_invalid");

  return {
    safe: reasons.length === 0,
    reasons
  };
}
