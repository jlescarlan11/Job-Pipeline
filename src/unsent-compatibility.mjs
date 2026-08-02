import { createHash } from "node:crypto";

import {
  canonicalJobId,
  stateGuard,
  validateRecordStoreContract
} from "./contracts.mjs";
import { evaluatePersistedMessageSafety } from "./message-safety.mjs";

const DISPOSITIONS = new Set([
  "regenerate",
  "return_to_review",
  "quarantine"
]);

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function boundedReason(reason) {
  const value = String(reason || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : "record_contract_invalid";
}

function expectedGuard(record) {
  try {
    return stateGuard(record);
  } catch {
    return "";
  }
}

export function buildUnsentCompatibilityInventory({
  records,
  profile,
  applicationPolicy,
  packPolicy,
  pipelineSchema,
  applicationCompatibility,
  dispositions = {},
  capturedAt = new Date().toISOString()
}) {
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("compatibility inventory capturedAt must be a valid timestamp");
  }
  if (!Array.isArray(records)) {
    throw new Error("compatibility inventory records must be an array");
  }
  if (
    !profile ||
    !applicationPolicy ||
    !packPolicy ||
    !pipelineSchema ||
    !applicationCompatibility
  ) {
    throw new Error("compatibility inventory requires current safety context");
  }

  const identities = new Set();
  const sanitized = [];
  for (const record of records) {
    const identity = String(record?.canonical_job_id || canonicalJobId(record) || "").trim();
    if (!identity || identities.has(identity)) {
      throw new Error("compatibility inventory contains a missing or duplicate identity");
    }
    identities.add(identity);

    const reasons = [];
    const contractErrors = validateRecordStoreContract(
      record,
      "To Apply",
      pipelineSchema
    );
    if (contractErrors.length > 0) reasons.push("record_contract_invalid");
    const storedGuard = String(record?.state_guard || "").trim();
    const canonicalGuard = expectedGuard(record);
    if (!storedGuard) reasons.push("state_guard_missing");
    else if (!canonicalGuard || storedGuard !== canonicalGuard) {
      reasons.push("state_guard_mismatch");
    }
    const safety = evaluatePersistedMessageSafety(record, {
      profile,
      applicationPolicy,
      packPolicy
    });
    reasons.push(...safety.reasons);
    const uniqueReasons = [...new Set(reasons.map(boundedReason))].sort();
    const safe = uniqueReasons.length === 0;
    const requestedDisposition = String(dispositions[identity] || "").trim();
    const disposition = safe
      ? "compatible"
      : DISPOSITIONS.has(requestedDisposition)
        ? requestedDisposition
        : "pending";

    sanitized.push({
      identity_digest: digest(identity),
      record_version: Number(record?.record_version),
      state_guard_digest: digest(storedGuard),
      review_digest: record?.review_approval_guard
        ? digest(record.review_approval_guard)
        : "",
      application_versions: structuredClone(applicationCompatibility),
      safe,
      reason_codes: uniqueReasons,
      disposition
    });
  }
  sanitized.sort((left, right) =>
    left.identity_digest.localeCompare(right.identity_digest)
  );
  const compatibleRecords = sanitized.filter((record) => record.safe).length;
  const incompatibleRecords = sanitized.length - compatibleRecords;
  const unhandled = sanitized.filter(
    (record) => !record.safe && record.disposition === "pending"
  ).length;
  return {
    captured_at: capturedAt,
    total_records: sanitized.length,
    compatible_records: compatibleRecords,
    incompatible_records: incompatibleRecords,
    unhandled_incompatible_records: unhandled,
    records: sanitized
  };
}
