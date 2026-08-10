import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = fileURLToPath(
  new URL("../scripts/provision-browser-click-store.mjs", import.meta.url)
);

test("browser click-store provisioning creates private pinned durable anchors once", () => {
  const parent = mkdtempSync(join(tmpdir(), "job-pipeline-provision-click-"));
  const root = join(parent, "runtime");
  try {
    const first = spawnSync(process.execPath, [cli, root], {
      encoding: "utf8"
    });
    assert.equal(first.status, 0, first.stderr);
    const summary = JSON.parse(first.stdout);
    assert.equal(summary.provisioned, true);
    assert.match(summary.store_id, /^browser-click-store-v1:[a-f0-9]{64}$/);
    assert.match(summary.ledger_id, /^browser-click-ledger-v1:[a-f0-9]{64}$/);
    assert.match(
      summary.generation_id,
      /^browser-click-generation-v1:[a-f0-9]{64}$/
    );
    assert.match(summary.manifest_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(summary.directory_binding_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "store")).mode & 0o777, 0o700);
    for (const path of [
      join(root, "binding.json"),
      join(root, "witness.json"),
      join(root, "store", "manifest.json"),
      join(root, "store", "consumed.ndjson")
    ]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const binding = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    assert.equal(binding.store_id, summary.store_id);
    assert.equal(binding.ledger_id, summary.ledger_id);
    assert.equal(binding.generation_id, summary.generation_id);
    assert.equal(binding.manifest_sha256, summary.manifest_sha256);

    const second = spawnSync(process.execPath, [cli, root], {
      encoding: "utf8"
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists; never overwrite it/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
