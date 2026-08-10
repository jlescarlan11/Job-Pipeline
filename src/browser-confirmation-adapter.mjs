import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

import {
  BROWSER_CONFIRMATION_SIGNATURE_ALGORITHM,
  BROWSER_EXECUTOR_PROTOCOL_VERSION,
  browserConfirmationPublicKeyDigest,
  browserConfirmationWitness,
  browserConfirmationWitnessDigest,
  serializeBrowserConfirmationWitness
} from "./browser-confirmation-attestation.mjs";
import {
  browserSubmitAuthorizationDigest,
  extractOnlineJobsId,
  normalizeCanonicalUrl
} from "./contracts.mjs";

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be one object`);
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys are invalid`);
  }
}

function valueDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function browserConfirmationAdapterPublicKey(privateKey) {
  try {
    return createPublicKey(createPrivateKey(privateKey)).export({
      type: "spki",
      format: "pem"
    });
  } catch {
    return "";
  }
}

export function attestApplicationHistoryConfirmation(
  record,
  observation,
  { privateKey, keyId, publicKeySpkiSha256 }
) {
  exactKeys(
    observation,
    [
      "thread_reference",
      "observed_source_job_id",
      "observed_canonical_url",
      "observed_at"
    ],
    "application-history observation"
  );
  if (!record || !["submit_started", "ambiguous"].includes(record.browser_state)) {
    throw new Error("Application-history confirmation requires a post-submit record");
  }
  const observedAt = String(observation.observed_at || "");
  const observedUrl = normalizeCanonicalUrl(observation.observed_canonical_url);
  const expectedUrl = normalizeCanonicalUrl(record.canonical_url);
  const sourceJobId = String(observation.observed_source_job_id || "");
  const threadReference = String(observation.thread_reference || "");
  if (
    !Number.isFinite(Date.parse(observedAt)) ||
    Date.parse(observedAt) < Date.parse(record.submission_started_at) ||
    !/^message\/conversation\/[A-Za-z0-9_-]{6,80}$/.test(threadReference) ||
    sourceJobId !== String(record.source_job_id || "") ||
    extractOnlineJobsId(observedUrl) !== sourceJobId ||
    observedUrl !== expectedUrl
  ) {
    throw new Error("Application-history observation does not match submit intent");
  }
  const publicKey = browserConfirmationAdapterPublicKey(privateKey);
  if (
    !publicKey ||
    browserConfirmationPublicKeyDigest(publicKey) !== publicKeySpkiSha256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(keyId || ""))
  ) {
    throw new Error("Application-history adapter signing identity is invalid");
  }
  const confirmationReference = `application-history/${threadReference}`;
  const result = {
    protocol_version: BROWSER_EXECUTOR_PROTOCOL_VERSION,
    attempt_id: record.browser_attempt_id,
    job_digest: record.browser_job_digest,
    form_fingerprint: record.browser_form_fingerprint,
    submission_idempotency_key: record.submission_idempotency_key,
    authorization_digest: browserSubmitAuthorizationDigest(record),
    result: "confirmed",
    evidence: {
      category: "submission_confirmed",
      observed_at: observedAt,
      reference_digest: valueDigest(confirmationReference)
    },
    confirmation_kind: "application_history",
    confirmation_reference: confirmationReference,
    observed_source_job_id: sourceJobId,
    observed_canonical_url: observedUrl
  };
  const witness = browserConfirmationWitness(record, result);
  return {
    ...result,
    confirmation_attestation: {
      algorithm: BROWSER_CONFIRMATION_SIGNATURE_ALGORITHM,
      key_id: keyId,
      witness_digest: browserConfirmationWitnessDigest(witness),
      signature: sign(
        null,
        Buffer.from(serializeBrowserConfirmationWitness(witness)),
        createPrivateKey(privateKey)
      ).toString("base64url")
    }
  };
}
