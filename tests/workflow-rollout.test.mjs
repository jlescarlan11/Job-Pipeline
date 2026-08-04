import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  googleCredentialNodeNames,
  workflowDeploymentDigest
} from "../src/workflow-cutover.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const policy = JSON.parse(
  await readFile(new URL("../config/n8n-deployment-policy.json", import.meta.url))
);

function runScript(args) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "build-bound-workflow-rollout.mjs"), ...args],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

function bindLiveCredential(workflow, credentialId = "google-credential") {
  const required = new Set(googleCredentialNodeNames(workflow));
  return {
    ...structuredClone(workflow),
    nodes: workflow.nodes.map((node) =>
      required.has(node.name)
        ? {
            ...structuredClone(node),
            credentials: {
              ...(node.credentials ?? {}),
              googleSheetsOAuth2Api: {
                id: credentialId,
                name: "Google Sheets account"
              }
            }
          }
        : structuredClone(node)
    )
  };
}

test("generic bound rollout preserves every pinned role and one credential", async () => {
  for (const [fileName, roleName] of [
    ["scraper", "scraper"],
    ["generator", "evaluator_generator"],
    ["alerter-mover", "alerter_mover"]
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "workflow-rollout-test-"));
    const artifactPath = join(directory, "artifact.json");
    const livePath = join(directory, "live.json");
    const outputPath = join(directory, "bound.json");
    const artifact = JSON.parse(
      await readFile(new URL(`../workflows/${fileName}.json`, import.meta.url))
    );
    const role = policy.workflow_cutover.roles.find(
      (entry) => entry.role === roleName
    );
    const live = bindLiveCredential(artifact);
    live.id = role.target_workflow_id;
    live.active = true;
    await Promise.all([
      writeFile(artifactPath, JSON.stringify(artifact)),
      writeFile(livePath, JSON.stringify(live))
    ]);
    const result = runScript([artifactPath, livePath, outputPath]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const bound = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(summary.role, roleName);
    assert.equal(summary.workflow_id, role.target_workflow_id);
    assert.equal(
      summary.credential_bound_node_count,
      role.google_credential_node_count
    );
    assert.equal(bound.id, role.target_workflow_id);
    assert.equal(bound.active, false);
    assert.equal(workflowDeploymentDigest(bound), role.artifact_digest);
    for (const node of bound.nodes.filter((entry) =>
      googleCredentialNodeNames(bound).includes(entry.name)
    )) {
      assert.deepEqual(node.credentials.googleSheetsOAuth2Api, {
        id: "google-credential"
      });
    }
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }
});

test("generic rollout upgrades a pinned legacy graph with one unanimous credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-rollout-test-"));
  const artifactPath = join(directory, "artifact.json");
  const livePath = join(directory, "live.json");
  const outputPath = join(directory, "bound.json");
  const artifact = JSON.parse(
    await readFile(new URL("../workflows/generator.json", import.meta.url))
  );
  const role = policy.workflow_cutover.roles.find(
    (entry) => entry.role === "evaluator_generator"
  );
  const live = bindLiveCredential(artifact);
  live.id = role.target_workflow_id;
  live.active = true;
  live.nodes = live.nodes.filter(
    (node) => node.name !== "Get To Apply Preparation"
  );
  const liveCredentialNodeCount = googleCredentialNodeNames(live).length;
  assert.ok(liveCredentialNodeCount < role.google_credential_node_count);
  await Promise.all([
    writeFile(artifactPath, JSON.stringify(artifact)),
    writeFile(livePath, JSON.stringify(live))
  ]);

  const result = runScript([artifactPath, livePath, outputPath]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const bound = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(summary.credential_source_node_count, liveCredentialNodeCount);
  assert.equal(
    summary.credential_bound_node_count,
    role.google_credential_node_count
  );
  assert.equal(workflowDeploymentDigest(bound), role.artifact_digest);
  assert.equal(bound.nodes.length, artifact.nodes.length);
  assert.ok(bound.nodes.some((node) => node.name === "Get To Apply Preparation"));
});

test("generic rollout rejects a wrong target and ambiguous credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-rollout-test-"));
  const artifactPath = join(directory, "artifact.json");
  const livePath = join(directory, "live.json");
  const outputPath = join(directory, "bound.json");
  const artifact = JSON.parse(
    await readFile(new URL("../workflows/generator.json", import.meta.url))
  );
  const live = bindLiveCredential(artifact);
  live.id = "wrong-target";
  await Promise.all([
    writeFile(artifactPath, JSON.stringify(artifact)),
    writeFile(livePath, JSON.stringify(live))
  ]);
  let result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pinned production target/);

  live.id = "TRUqD9atneyDyMNx";
  const credentialNodes = new Set(googleCredentialNodeNames(live));
  const second = live.nodes.find((node) => credentialNodes.has(node.name));
  second.credentials.googleSheetsOAuth2Api = {
    id: "different-google-credential",
    name: "Different account"
  };
  await writeFile(livePath, JSON.stringify(live));
  result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one Google Sheets credential binding/);
});

test("generic rollout rejects embedded secrets, unsafe references, and partial live binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-rollout-test-"));
  const artifactPath = join(directory, "artifact.json");
  const livePath = join(directory, "live.json");
  const outputPath = join(directory, "bound.json");
  const cleanArtifact = JSON.parse(
    await readFile(new URL("../workflows/generator.json", import.meta.url))
  );
  const role = policy.workflow_cutover.roles.find(
    (entry) => entry.role === "evaluator_generator"
  );
  const live = bindLiveCredential(cleanArtifact);
  live.id = role.target_workflow_id;

  const injectedArtifact = structuredClone(cleanArtifact);
  const artifactCredentialNode = injectedArtifact.nodes.find((node) =>
    googleCredentialNodeNames(injectedArtifact).includes(node.name)
  );
  artifactCredentialNode.credentials = {
    googleSheetsOAuth2Api: { id: "gsk_live_privatevalue" }
  };
  await Promise.all([
    writeFile(artifactPath, JSON.stringify(injectedArtifact)),
    writeFile(livePath, JSON.stringify(live))
  ]);
  let result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain credential references/);

  await writeFile(artifactPath, JSON.stringify(cleanArtifact));
  const unsafeLive = structuredClone(live);
  const unsafeNode = unsafeLive.nodes.find((node) =>
    googleCredentialNodeNames(unsafeLive).includes(node.name)
  );
  unsafeNode.credentials.googleSheetsOAuth2Api.accessToken = "gsk_live_privatevalue";
  await writeFile(livePath, JSON.stringify(unsafeLive));
  result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safe credential reference/);

  const privateReferenceLive = structuredClone(live);
  for (const node of privateReferenceLive.nodes.filter((entry) =>
    googleCredentialNodeNames(privateReferenceLive).includes(entry.name)
  )) {
    node.credentials.googleSheetsOAuth2Api = {
      id: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      name: "operator@example.com /Users/operator/private"
    };
  }
  await writeFile(livePath, JSON.stringify(privateReferenceLive));
  result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safe credential reference/);

  const partialLive = structuredClone(live);
  const partialNode = partialLive.nodes.find((node) =>
    googleCredentialNodeNames(partialLive).includes(node.name)
  );
  delete partialNode.credentials;
  await writeFile(livePath, JSON.stringify(partialLive));
  result = runScript([artifactPath, livePath, outputPath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every live Google node/);
});
