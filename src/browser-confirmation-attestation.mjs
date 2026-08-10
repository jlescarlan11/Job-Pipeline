import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import {
  browserSubmitAuthorizationDigest,
  normalizeCanonicalUrl
} from "./contracts.mjs";

export const BROWSER_CONFIRMATION_ATTESTATION_VERSION = "attestation-v1";
export const BROWSER_CONFIRMATION_SIGNATURE_ALGORITHM = "ed25519";
export const BROWSER_EXECUTOR_PROTOCOL_VERSION = "2026-08-10/v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value ?? "";
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function browserConfirmationWitness(record, result) {
  const persistedReferenceDigest = String(
    record?.submission_confirmation_reference || ""
  ).match(/^confirmation-ref-v1:([a-f0-9]{64})$/)?.[1] || "";
  return {
    protocol_version:
      result?.protocol_version ?? BROWSER_EXECUTOR_PROTOCOL_VERSION,
    automation_contract_version: record?.automation_contract_version ?? "",
    canonical_job_id: record?.canonical_job_id ?? "",
    source_job_id: record?.source_job_id ?? "",
    canonical_url: normalizeCanonicalUrl(record?.canonical_url),
    browser_attempt_id: record?.browser_attempt_id ?? "",
    browser_job_digest: record?.browser_job_digest ?? "",
    browser_context_digest: record?.browser_context_digest ?? "",
    browser_form_fingerprint: record?.browser_form_fingerprint ?? "",
    submission_idempotency_key: record?.submission_idempotency_key ?? "",
    submission_started_at: record?.submission_started_at ?? "",
    authorization_digest:
      result?.authorization_digest ?? browserSubmitAuthorizationDigest(record),
    confirmation_kind:
      result?.confirmation_kind ?? record?.submission_confirmation_kind ?? "",
    observed_source_job_id:
      result?.observed_source_job_id ?? record?.source_job_id ?? "",
    observed_canonical_url: normalizeCanonicalUrl(
      result?.observed_canonical_url ?? record?.canonical_url
    ),
    evidence_category:
      result?.evidence?.category ??
      (record?.browser_state === "confirmed" ? "submission_confirmed" : ""),
    evidence_observed_at:
      result?.evidence?.observed_at ?? record?.submission_confirmed_at ?? "",
    evidence_reference_digest:
      result?.evidence?.reference_digest ?? persistedReferenceDigest
  };
}

export function serializeBrowserConfirmationWitness(witness) {
  return JSON.stringify(stableValue(witness));
}

export function browserConfirmationWitnessDigest(witness) {
  return `witness-v1:${digest(witness)}`;
}

export function browserConfirmationPublicKeyDigest(publicKey) {
  try {
    const spki = createPublicKey(publicKey).export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
  } catch {
    return "";
  }
}

export function verifyBrowserConfirmationAttestation(
  witness,
  attestation,
  { publicKey, keyId, publicKeySpkiSha256 }
) {
  if (!isPlainObject(attestation)) return false;
  if (
    JSON.stringify(Object.keys(attestation).sort()) !==
    JSON.stringify(["algorithm", "key_id", "signature", "witness_digest"])
  ) {
    return false;
  }
  if (
    attestation.algorithm !== BROWSER_CONFIRMATION_SIGNATURE_ALGORITHM ||
    attestation.key_id !== keyId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(keyId || "")) ||
    attestation.witness_digest !== browserConfirmationWitnessDigest(witness) ||
    !/^[A-Za-z0-9_-]{80,120}$/.test(String(attestation.signature || "")) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(publicKeySpkiSha256 || "")) ||
    browserConfirmationPublicKeyDigest(publicKey) !== publicKeySpkiSha256 ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(String(publicKey || ""))
  ) {
    return false;
  }
  try {
    return verifySignature(
      null,
      Buffer.from(serializeBrowserConfirmationWitness(witness)),
      createPublicKey(publicKey),
      Buffer.from(attestation.signature, "base64url")
    );
  } catch {
    return false;
  }
}
