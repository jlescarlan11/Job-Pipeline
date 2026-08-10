#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { provisionedBrowserTask } from "../src/browser-task-runtime.mjs";

const [rootArgument, clickBindingArgument] = process.argv.slice(2);
if (
  !rootArgument ||
  !clickBindingArgument ||
  !isAbsolute(rootArgument) ||
  !isAbsolute(clickBindingArgument)
) {
  throw new Error(
    "Usage: node scripts/provision-browser-automation-runtime.mjs <new-absolute-private-root> <absolute-click-binding.json>"
  );
}
const root = resolve(rootArgument);
const clickBindingPath = resolve(clickBindingArgument);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

try {
  await stat(root);
  throw new Error("Private browser runtime root already exists; never overwrite it");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function writeExclusive(path, source, mode = 0o600) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const [sourceTask, clickBinding] = await Promise.all([
  readFile(new URL("../config/browser-executor-task.json", import.meta.url), "utf8")
    .then(JSON.parse),
  readFile(clickBindingPath, "utf8").then(JSON.parse)
]);
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const keyId = `onlinejobs-history-v1:${randomBytes(32).toString("hex")}`;
const runtimeTask = provisionedBrowserTask(sourceTask, {
  clickBinding,
  publicKey,
  keyId
});

await mkdir(root, { mode: 0o700 });
await chmod(root, 0o700);
const privateKeyPath = join(root, "adapter-private-key.pem");
const publicKeyPath = join(root, "attestation-public-key.pem");
const runtimeTaskPath = join(root, "browser-task.json");
const bindingPath = join(root, "binding.json");
const executorLauncherPath = join(root, "run-browser-executor.zsh");
const adapterLauncherPath = join(root, "run-confirmation-adapter.zsh");
await writeExclusive(privateKeyPath, privateKey);
await writeExclusive(publicKeyPath, publicKey);
await writeExclusive(runtimeTaskPath, `${JSON.stringify(runtimeTask, null, 2)}\n`);
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const sharedEnvironment = [
  `export JOB_PIPELINE_BROWSER_TASK_CONFIG_PATH=${quote(runtimeTaskPath)}`,
  `export JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY_FILE=${quote(publicKeyPath)}`,
  `export JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR=${quote(clickBinding.directory)}`,
  `export JOB_PIPELINE_BROWSER_CLICK_WITNESS_FILE=${quote(clickBinding.witness_path)}`
].join("\n");
await writeExclusive(
  executorLauncherPath,
  `#!/bin/zsh\nset -euo pipefail\n${sharedEnvironment}\nexec ${quote(process.execPath)} ${quote(join(repositoryRoot, "scripts/browser-executor.mjs"))} "$@"\n`,
  0o700
);
await writeExclusive(
  adapterLauncherPath,
  `#!/bin/zsh\nset -euo pipefail\n${sharedEnvironment}\nexport JOB_PIPELINE_BROWSER_ATTESTATION_PRIVATE_KEY_FILE=${quote(privateKeyPath)}\nexec ${quote(process.execPath)} ${quote(join(repositoryRoot, "scripts/browser-confirmation-adapter.mjs"))} "$@"\n`,
  0o700
);
const binding = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  runtime_task_path: await realpath(runtimeTaskPath),
  public_key_path: await realpath(publicKeyPath),
  private_key_path: await realpath(privateKeyPath),
  executor_launcher_path: await realpath(executorLauncherPath),
  adapter_launcher_path: await realpath(adapterLauncherPath),
  click_binding_path: await realpath(clickBindingPath),
  click_directory: await realpath(clickBinding.directory),
  click_witness_path: await realpath(clickBinding.witness_path),
  attestation_key_id: runtimeTask.confirmation_attestation.key_id,
  attestation_public_key_spki_sha256:
    runtimeTask.confirmation_attestation.public_key_spki_sha256
};
await writeExclusive(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
await syncDirectory(root);

process.stdout.write(
  `${JSON.stringify({
    provisioned: true,
    binding_path: bindingPath,
    runtime_task_path: binding.runtime_task_path,
    public_key_path: binding.public_key_path,
    executor_launcher_path: binding.executor_launcher_path,
    adapter_launcher_path: binding.adapter_launcher_path,
    attestation_key_id: binding.attestation_key_id,
    attestation_public_key_spki_sha256:
      binding.attestation_public_key_spki_sha256
  })}\n`
);
