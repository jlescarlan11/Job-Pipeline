#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  realpath,
  stat
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { browserClickReceiptStoreProvisioning } from "../src/browser-executor.mjs";

const [rootArgument] = process.argv.slice(2);
if (!rootArgument || !isAbsolute(rootArgument)) {
  throw new Error(
    "Usage: node scripts/provision-browser-click-store.mjs <new-absolute-private-root>"
  );
}

const root = resolve(rootArgument);
const directory = join(root, "store");
const witnessPath = join(root, "witness.json");
const bindingPath = join(root, "binding.json");
const createdAt = new Date().toISOString();
const identifier = (kind) =>
  `browser-click-${kind}-v1:${randomBytes(32).toString("hex")}`;

async function writeExclusiveDurable(path, source) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function replaceDurable(path, source) {
  const handle = await open(path, "r+", 0o600);
  try {
    await handle.truncate(0);
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

try {
  await stat(root);
  throw new Error("Private click-receipt root already exists; never overwrite it");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await mkdir(root, { mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
await chmod(root, 0o700);
await chmod(directory, 0o700);
await writeExclusiveDurable(witnessPath, "");

const provisioning = browserClickReceiptStoreProvisioning({
  directory,
  witness_path: witnessPath,
  store_id: identifier("store"),
  ledger_id: identifier("ledger"),
  generation_id: identifier("generation"),
  created_at: createdAt
});

await writeExclusiveDurable(
  join(directory, "manifest.json"),
  provisioning.manifest_source
);
await writeExclusiveDurable(
  join(directory, "consumed.ndjson"),
  provisioning.ledger_source
);
await replaceDurable(witnessPath, provisioning.witness_source);

const binding = {
  schema_version: 1,
  created_at: createdAt,
  directory: await realpath(directory),
  witness_path: await realpath(witnessPath),
  store_id: provisioning.manifest.store_id,
  ledger_id: provisioning.manifest.ledger_id,
  generation_id: provisioning.manifest.generation_id,
  manifest_sha256: provisioning.manifest_sha256,
  directory_binding_digest:
    provisioning.manifest.directory_binding_digest,
  directory_identity: provisioning.directory_identity,
  witness_identity: provisioning.witness_identity
};
await writeExclusiveDurable(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
await syncDirectory(directory);
await syncDirectory(root);

process.stdout.write(
  `${JSON.stringify({
    provisioned: true,
    binding_path: bindingPath,
    store_id: binding.store_id,
    ledger_id: binding.ledger_id,
    generation_id: binding.generation_id,
    manifest_sha256: binding.manifest_sha256,
    directory_binding_digest: binding.directory_binding_digest,
    directory_identity: binding.directory_identity,
    witness_identity: binding.witness_identity
  })}\n`
);
