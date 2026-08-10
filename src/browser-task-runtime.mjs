import { browserConfirmationPublicKeyDigest } from "./browser-confirmation-attestation.mjs";

const PROVISIONED_SOURCE_CONTROL_STATE = "provisioned_runtime";
const CLICK_PIN_FIELDS = [
  "store_id",
  "ledger_id",
  "generation_id",
  "manifest_sha256",
  "directory_binding_digest",
  "directory_identity",
  "witness_identity"
];

function clone(value) {
  return structuredClone(value);
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

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function requireSourceContract(sourceTask) {
  if (
    !sourceTask ||
    sourceTask.source_control_state !== "inactive_unscheduled" ||
    sourceTask.confirmation_attestation?.key_id !== "unprovisioned" ||
    sourceTask.confirmation_attestation?.public_key_spki_sha256 !==
      "unprovisioned" ||
    CLICK_PIN_FIELDS.some(
      (field) => sourceTask.click_consumption?.[field] !== "unprovisioned"
    )
  ) {
    throw new Error("Browser task source contract is not inert and unprovisioned");
  }
}

function requireClickBinding(binding) {
  if (
    !binding ||
    binding.schema_version !== 1 ||
    !/^browser-click-store-v1:[a-f0-9]{64}$/.test(
      String(binding.store_id || "")
    ) ||
    !/^browser-click-ledger-v1:[a-f0-9]{64}$/.test(
      String(binding.ledger_id || "")
    ) ||
    !/^browser-click-generation-v1:[a-f0-9]{64}$/.test(
      String(binding.generation_id || "")
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(binding.manifest_sha256 || "")) ||
    !/^sha256:[a-f0-9]{64}$/.test(
      String(binding.directory_binding_digest || "")
    ) ||
    !/^fs-object-v1:[A-Za-z0-9._:-]{1,180}$/.test(
      String(binding.directory_identity || "")
    ) ||
    !/^fs-object-v1:[A-Za-z0-9._:-]{1,180}$/.test(
      String(binding.witness_identity || "")
    )
  ) {
    throw new Error("Browser click-receipt binding is invalid or unprovisioned");
  }
}

export function provisionedBrowserTask(
  sourceTask,
  { clickBinding, publicKey, keyId }
) {
  requireSourceContract(sourceTask);
  requireClickBinding(clickBinding);
  const publicKeySpkiSha256 = browserConfirmationPublicKeyDigest(publicKey);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(publicKeySpkiSha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(keyId || "")) ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(String(publicKey || ""))
  ) {
    throw new Error("Browser confirmation public trust root is invalid");
  }
  const runtimeTask = clone(sourceTask);
  runtimeTask.source_control_state = PROVISIONED_SOURCE_CONTROL_STATE;
  runtimeTask.confirmation_attestation.key_id = keyId;
  runtimeTask.confirmation_attestation.public_key_spki_sha256 =
    publicKeySpkiSha256;
  for (const field of CLICK_PIN_FIELDS) {
    runtimeTask.click_consumption[field] = clickBinding[field];
  }
  return runtimeTask;
}

export function validateProvisionedBrowserTask(sourceTask, runtimeTask, publicKey) {
  try {
    requireSourceContract(sourceTask);
    if (runtimeTask?.source_control_state !== PROVISIONED_SOURCE_CONTROL_STATE) {
      return ["browser runtime task is not provisioned"];
    }
    const expected = provisionedBrowserTask(sourceTask, {
      clickBinding: {
        schema_version: 1,
        ...Object.fromEntries(
          CLICK_PIN_FIELDS.map((field) => [
            field,
            runtimeTask?.click_consumption?.[field]
          ])
        )
      },
      publicKey,
      keyId: runtimeTask?.confirmation_attestation?.key_id
    });
    return sameValue(expected, runtimeTask)
      ? []
      : ["browser runtime task changes fields outside the provisioning boundary"];
  } catch (error) {
    return [String(error?.message || "browser runtime task is invalid")];
  }
}

export function assertProvisionedBrowserTask(sourceTask, runtimeTask, publicKey) {
  const errors = validateProvisionedBrowserTask(sourceTask, runtimeTask, publicKey);
  if (errors.length) {
    throw new Error(`Invalid provisioned browser task: ${errors.join("; ")}`);
  }
  return runtimeTask;
}

export const BROWSER_RUNTIME_SOURCE_CONTROL_STATE =
  PROVISIONED_SOURCE_CONTROL_STATE;
