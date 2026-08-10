#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { attestApplicationHistoryConfirmation } from "../src/browser-confirmation-adapter.mjs";
import { assertProvisionedBrowserTask } from "../src/browser-task-runtime.mjs";

const [command, ...extra] = process.argv.slice(2);
if (command !== "attest" || extra.length) {
  throw new Error(
    "Usage: node scripts/browser-confirmation-adapter.mjs attest < input.json"
  );
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must be readable valid JSON`);
  }
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Confirmation adapter stdin must be valid JSON");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(["observation", "record"])
  ) {
    throw new Error("Confirmation adapter stdin keys are invalid");
  }
  return input;
}

const sourceTask = await readJson(
  new URL("../config/browser-executor-task.json", import.meta.url),
  "browser task source contract"
);
const runtimeTaskPath = process.env.JOB_PIPELINE_BROWSER_TASK_CONFIG_PATH || "";
const publicKeyPath =
  process.env.JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY_FILE || "";
const privateKeyPath =
  process.env.JOB_PIPELINE_BROWSER_ATTESTATION_PRIVATE_KEY_FILE || "";
for (const [path, label] of [
  [runtimeTaskPath, "runtime task"],
  [publicKeyPath, "attestation public key"],
  [privateKeyPath, "attestation private key"]
]) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} path must be absolute`);
}
const privateMode = (await stat(privateKeyPath)).mode & 0o777;
if (privateMode !== 0o600) {
  throw new Error("Attestation private key permissions must be 0600");
}
const [runtimeTask, publicKey, privateKey, input] = await Promise.all([
  readJson(runtimeTaskPath, "runtime task"),
  readFile(publicKeyPath, "utf8"),
  readFile(privateKeyPath, "utf8"),
  readInput()
]);
assertProvisionedBrowserTask(sourceTask, runtimeTask, publicKey);
const result = attestApplicationHistoryConfirmation(
  input.record,
  input.observation,
  {
    privateKey,
    keyId: runtimeTask.confirmation_attestation.key_id,
    publicKeySpkiSha256:
      runtimeTask.confirmation_attestation.public_key_spki_sha256
  }
);
process.stdout.write(`${JSON.stringify({ result })}\n`);
