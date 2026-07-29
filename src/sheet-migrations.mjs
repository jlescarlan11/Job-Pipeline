export function collectDeclaredVersionFields(...fieldCollections) {
  return [
    ...new Set(
      fieldCollections
        .flat()
        .filter(
          (field) =>
            typeof field === "string" && field.endsWith("_version")
        )
    )
  ].sort();
}

export const LEGACY_MESSAGE_QUARANTINE_IDS = Object.freeze([
  "onlinejobs.ph:1696828",
  "onlinejobs.ph:1696881",
  "onlinejobs.ph:1585711",
  "onlinejobs.ph:1697174",
  "onlinejobs.ph:1697248",
  "onlinejobs.ph:1697386",
  "onlinejobs.ph:1697330",
  "onlinejobs.ph:1697526"
]);

export function classifyVersionCell({
  field,
  value,
  displayValue,
  identity
}) {
  const confirmedProfileVersion = "2026-07-28";
  const confirmedProfileVersionSerial = 46231;
  if (value === "" || value === null || value === undefined) {
    return { status: "unchanged" };
  }
  if (typeof value === "string") {
    return { status: "unchanged" };
  }

  const rawType =
    value instanceof Date
      ? "date"
      : typeof value === "number"
        ? "number"
        : typeof value;
  const isConfirmedProfileVersion =
    field === "profile_version" &&
    Boolean(String(identity || "").trim()) &&
    String(displayValue || "").trim() === confirmedProfileVersion &&
    ((typeof value === "number" &&
      value === confirmedProfileVersionSerial) ||
      (value instanceof Date && Number.isFinite(value.getTime())));

  if (isConfirmedProfileVersion) {
    return {
      status: "repair",
      value: confirmedProfileVersion,
      raw_type: rawType
    };
  }

  return {
    status: "unmapped",
    raw_type: rawType
  };
}

export function classifyOrphanedProcessingClaim({
  record,
  nowMs,
  leaseMs
}) {
  const confirmed = {
    "onlinejobs.ph:1663047": {
      token: "3634:onlinejobs.ph:1663047:evaluation",
      pipeline_status: "not_recommended"
    },
    "onlinejobs.ph:1696973": {
      token: "3634:onlinejobs.ph:1696973:evaluation",
      pipeline_status: "not_recommended"
    },
    "onlinejobs.ph:1696907": {
      token: "3634:onlinejobs.ph:1696907:evaluation",
      pipeline_status: "not_recommended"
    },
    "onlinejobs.ph:1615239": {
      token: "3634:onlinejobs.ph:1615239:evaluation",
      pipeline_status: "review_required"
    },
    "onlinejobs.ph:1697830": {
      token: "3634:onlinejobs.ph:1697830:evaluation",
      pipeline_status: "review_required"
    }
  };
  const identity = String(record?.canonical_job_id || "").trim();
  const token = String(record?.processing_token || "").trim();
  const stage = String(record?.processing_stage || "").trim();
  const startedAt = String(record?.processing_started_at || "").trim();
  const startedMs = Date.parse(startedAt);
  const currentMs = Number(nowMs);
  const lease = Number(leaseMs);

  if (!token) {
    return { status: "skipped", reason: "no_token" };
  }

  const hasUnexpiredActiveMetadata =
    Boolean(stage) &&
    Boolean(startedAt) &&
    Number.isFinite(startedMs) &&
    Number.isFinite(currentMs) &&
    Number.isFinite(lease) &&
    lease > 0 &&
    currentMs - startedMs < lease;
  if (hasUnexpiredActiveMetadata) {
    return { status: "preserved_active", reason: "unexpired_claim" };
  }

  const expected = confirmed[identity];
  if (!expected) {
    return { status: "skipped", reason: "unconfirmed_identity" };
  }
  if (
    token !== expected.token ||
    String(record?.pipeline_status || "").trim() !==
      expected.pipeline_status
  ) {
    return { status: "conflicting", reason: "target_state_changed" };
  }
  if (stage || startedAt) {
    return {
      status: "conflicting",
      reason: "target_has_processing_metadata"
    };
  }

  return { status: "clear", reason: "confirmed_orphan" };
}

export function classifyLegacyMessageQuarantine(record, current) {
  const confirmedIdentities = new Set(LEGACY_MESSAGE_QUARANTINE_IDS);
  const identity = String(record?.canonical_job_id || "").trim();
  if (!confirmedIdentities.has(identity)) {
    return { status: "skipped", reason: "unconfirmed_identity" };
  }

  const decision = String(record?.application_decision || "").trim();
  const status = String(record?.pipeline_status || "").trim();
  const message = String(record?.generated_message || "");
  const profileVersion = String(
    record?.message_profile_version || ""
  ).trim();
  const validationStatus = String(
    record?.message_validation_status || ""
  ).trim();
  const alertStatus = String(record?.alert_status || "").trim();
  const alertSuppressedReason = String(
    record?.alert_suppressed_reason || ""
  ).trim();
  const category = String(record?.error_category || "").trim();
  const currentSafeMetadata =
    Boolean(message.trim()) &&
    !message.includes("johnlesterescarlan.netlify.app") &&
    profileVersion === current?.profile_version &&
    String(record?.message_policy_version || "").trim() ===
      current?.message_policy_version &&
    record?.message_validation_status === "valid" &&
    record?.application_pack_status === "ready" &&
    record?.application_pack_version === current?.pack_version &&
    record?.application_pack_profile_version ===
      current?.profile_version &&
    record?.application_pack_policy_version ===
      current?.pack_policy_version;
  if (currentSafeMetadata) {
    return { status: "current_safe", reason: "current_provenance" };
  }
  const alreadyQuarantined =
    !decision &&
    !message.trim() &&
    profileVersion === "legacy/unknown" &&
    validationStatus === "quarantined" &&
    alertStatus === "not_eligible" &&
    alertSuppressedReason
      .split(",")
      .map((reason) => reason.trim())
      .includes("message_quarantined") &&
    (
      category === "message_quarantined" ||
      [
        "recommended",
        "generating",
        "retryable_error",
        "terminal_error"
      ].includes(status)
    );
  if (alreadyQuarantined) {
    return { status: "already_quarantined", reason: "unsafe_text_removed" };
  }
  if (decision || ["applied", "skipped", "archived"].includes(status)) {
    return { status: "conflicting", reason: "protected_record_changed" };
  }

  const hasReportedUnsafeEvidence =
    status === "ready" &&
    profileVersion === "legacy/unknown" &&
    message.includes(
      "https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf"
    );
  if (hasReportedUnsafeEvidence) {
    return { status: "quarantine", reason: "confirmed_unsafe_legacy_message" };
  }

  return { status: "conflicting", reason: "target_state_changed" };
}
