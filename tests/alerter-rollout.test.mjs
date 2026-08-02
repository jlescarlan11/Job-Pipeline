import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runScript(script, args) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), "alerter-rollout-test-"));
}

function minimalWorkflow({ active = false, credentialId = "google-credential" } = {}) {
  return {
    id: "QO6OLK3pHetgGIGq",
    name: "Alerter",
    active,
    versionId: "source-version",
    settings: { timezone: "Asia/Manila", executionTimeout: 300 },
    nodes: [
      {
        id: "schedule",
        name: "Schedule Trigger",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1.2,
        position: [0, 0],
        parameters: {
          rule: { interval: [{ field: "cronExpression", expression: "0 10,25,40,55 * * * *" }] }
        }
      },
      {
        id: "batch-read",
        name: "Get Business Snapshot",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.4,
        position: [200, 0],
        parameters: {
          authentication: "predefinedCredentialType",
          nodeCredentialType: "googleSheetsOAuth2Api"
        },
        credentials: {
          googleSheetsOAuth2Api: { id: credentialId, name: "Google Sheets account" }
        }
      },
      {
        id: "code",
        name: "Confirm and Render Alerts",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [400, 0],
        parameters: {}
      }
    ],
    connections: {
      "Schedule Trigger": {
        main: [[{ node: "Get Business Snapshot", type: "main", index: 0 }]]
      },
      "Get Business Snapshot": {
        main: [[{ node: "Confirm and Render Alerts", type: "main", index: 0 }]]
      }
    }
  };
}

test("bound rollout preserves the target ID and binds only Google-capable nodes", async () => {
  const directory = await fixtureDirectory();
  const artifactPath = join(directory, "artifact.json");
  const livePath = join(directory, "live.json");
  const outputPath = join(directory, "bound.json");
  const artifact = minimalWorkflow();
  delete artifact.nodes[1].credentials;
  await Promise.all([
    writeFile(artifactPath, JSON.stringify(artifact)),
    writeFile(livePath, JSON.stringify(minimalWorkflow()))
  ]);

  const result = runScript("build-bound-alerter-rollout.mjs", [
    artifactPath,
    livePath,
    outputPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const bound = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(summary.workflow_id, "QO6OLK3pHetgGIGq");
  assert.equal(summary.credential_bound_node_count, 1);
  assert.equal(bound.id, "QO6OLK3pHetgGIGq");
  assert.equal(bound.active, false);
  assert.equal(
    bound.nodes[1].credentials.googleSheetsOAuth2Api.id,
    "google-credential"
  );
  assert.equal(bound.nodes[2].credentials, undefined);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});

test("bound rollout rejects an ambiguous live Google credential", async () => {
  const directory = await fixtureDirectory();
  const artifactPath = join(directory, "artifact.json");
  const livePath = join(directory, "live.json");
  const outputPath = join(directory, "bound.json");
  const artifact = minimalWorkflow();
  delete artifact.nodes[1].credentials;
  const live = minimalWorkflow();
  live.nodes.push({
    ...structuredClone(live.nodes[1]),
    id: "second-read",
    name: "Second read",
    credentials: {
      googleSheetsOAuth2Api: { id: "other-google-credential", name: "Other" }
    }
  });
  await Promise.all([
    writeFile(artifactPath, JSON.stringify(artifact)),
    writeFile(livePath, JSON.stringify(live))
  ]);

  const result = runScript("build-bound-alerter-rollout.mjs", [
    artifactPath,
    livePath,
    outputPath
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one Google Sheets credential binding/);
});

test("disposable builders preserve the production artifact and isolate their trigger", async () => {
  const directory = await fixtureDirectory();
  const sourcePath = join(directory, "bound.json");
  const smokePath = join(directory, "smoke.json");
  const webhookPath = join(directory, "webhook.json");
  const source = minimalWorkflow();
  const original = JSON.stringify(source);
  await writeFile(sourcePath, original);

  const smokeResult = runScript("build-disposable-alerter-smoke.mjs", [
    sourcePath,
    smokePath
  ]);
  const webhookResult = runScript("build-disposable-alerter-webhook.mjs", [
    sourcePath,
    webhookPath,
    "quota-safe-alerter-test"
  ]);
  assert.equal(smokeResult.status, 0, smokeResult.stderr);
  assert.equal(webhookResult.status, 0, webhookResult.stderr);
  assert.equal(await readFile(sourcePath, "utf8"), original);

  const smoke = JSON.parse(await readFile(smokePath, "utf8"));
  const webhook = JSON.parse(await readFile(webhookPath, "utf8"));
  assert.equal(smoke.active, false);
  assert.equal(smoke.settings.saveDataSuccessExecution, "all");
  assert.equal(smoke.settings.saveExecutionProgress, true);
  assert.equal(
    smoke.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger").length,
    0
  );
  assert.equal(
    smoke.nodes.filter(
      (node) => node.type === "n8n-nodes-base.executeWorkflowTrigger"
    ).length,
    1
  );
  assert.equal(webhook.active, false);
  assert.equal(webhook.settings.saveDataSuccessExecution, "all");
  assert.equal(webhook.settings.saveExecutionProgress, true);
  assert.equal(
    webhook.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger").length,
    0
  );
  assert.equal(
    webhook.nodes.filter((node) => node.type === "n8n-nodes-base.webhook").length,
    1
  );
  assert.equal(
    webhook.connections["Disposable Webhook Trigger"].main[0][0].node,
    "Get Business Snapshot"
  );
});

test("provider Sheet failure injection is disposable-only and narrowly targeted", async () => {
  const directory = await fixtureDirectory();
  const sourcePath = join(directory, "source.json");
  const outputPath = join(directory, "sheet-failure.json");
  const source = minimalWorkflow();
  source.nodes = source.nodes.filter(
    (node) => node.type !== "n8n-nodes-base.scheduleTrigger"
  );
  delete source.connections["Schedule Trigger"];
  for (const name of [
    "Persist Provider To Apply Updates",
    "Persist Provider Applied Updates",
    "Persist Provider Archive Updates"
  ]) {
    source.nodes.push({
      id: name,
      name,
      type: "n8n-nodes-base.googleSheets",
      typeVersion: 4.7,
      position: [0, 0],
      parameters: { documentId: { __rl: true, mode: "id", value: "production" } }
    });
  }
  await writeFile(sourcePath, JSON.stringify(source));
  const result = runScript("build-disposable-provider-sheet-failure.mjs", [
    sourcePath,
    outputPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  const injected = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(injected.active, false);
  assert.equal(
    injected.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger"),
    false
  );
  const changed = injected.nodes.filter((node) =>
    node.name.startsWith("Persist Provider ")
  );
  assert.equal(changed.length, 3);
  assert.ok(
    changed.every(
      (node) =>
        node.parameters.documentId.value === "disposable-provider-sheet-failure"
    )
  );
});

test("Sheets 429 probe is loopback-only, unscheduled, and bounded", async () => {
  const directory = await fixtureDirectory();
  const sourcePath = join(directory, "source.json");
  const outputPath = join(directory, "quota.json");
  const source = minimalWorkflow();
  source.nodes = source.nodes.filter(
    (node) => node.type !== "n8n-nodes-base.scheduleTrigger"
  );
  delete source.connections["Schedule Trigger"];
  source.nodes.push(
    {
      ...structuredClone(source.nodes[0]),
      id: "retry-read",
      name: "Retry Business Snapshot"
    },
    {
      id: "quota-wait",
      name: "Wait for Sheets Quota Window",
      type: "n8n-nodes-base.wait",
      typeVersion: 1.1,
      position: [0, 0],
      parameters: { resume: "timeInterval", amount: 65, unit: "seconds" }
    }
  );
  await writeFile(sourcePath, JSON.stringify(source));
  const result = runScript("build-disposable-sheets-quota-probe.mjs", [
    sourcePath,
    outputPath,
    "http://127.0.0.1:5800/values:batchGet"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const injected = JSON.parse(await readFile(outputPath, "utf8"));
  const target = injected.nodes.find((node) => node.name === "Get Business Snapshot");
  const retry = injected.nodes.find((node) => node.name === "Retry Business Snapshot");
  assert.equal(injected.active, false);
  assert.equal(target.parameters.url, "=http://127.0.0.1:5800/values:batchGet");
  assert.equal(target.parameters.authentication, "none");
  assert.equal(target.credentials, undefined);
  assert.equal(retry.parameters.url, "=http://127.0.0.1:5800/values:batchGet");
  assert.equal(retry.credentials, undefined);
});

test("rollout observation enables evidence without activating the bound workflow", async () => {
  const directory = await fixtureDirectory();
  const sourcePath = join(directory, "bound.json");
  const outputPath = join(directory, "observation.json");
  await writeFile(sourcePath, JSON.stringify(minimalWorkflow()));
  const result = runScript("build-rollout-observation-workflow.mjs", [
    sourcePath,
    outputPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(observation.active, false);
  assert.equal(observation.settings.saveDataSuccessExecution, "all");
  assert.equal(observation.settings.saveDataErrorExecution, "all");
  assert.equal(observation.settings.saveExecutionProgress, true);
  assert.equal(
    observation.nodes.filter(
      (node) => node.type === "n8n-nodes-base.scheduleTrigger"
    ).length,
    1
  );
});

test("mock Slack stores only bounded metadata and a payload hash", async (t) => {
  const directory = await fixtureDirectory();
  const modePath = join(directory, "mode.txt");
  const eventPath = join(directory, "events.ndjson");
  const port = 20_000 + (process.pid % 20_000);
  await Promise.all([writeFile(modePath, "success\n"), writeFile(eventPath, "")]);
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, "scripts", "mock-slack-server.mjs"),
      `--port=${port}`,
      `--mode-file=${modePath}`,
      `--event-log=${eventPath}`
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(() => child.kill("SIGTERM"));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock Slack did not start")), 5_000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => reject(new Error(`mock Slack exited ${code}`)));
  });

  const secretPayload = JSON.stringify({ text: "private canary payload" });
  const response = await fetch(`http://127.0.0.1:${port}/slack`, {
    method: "POST",
    body: secretPayload,
    headers: { "content-type": "application/json" }
  });
  assert.equal(response.status, 200);
  const event = JSON.parse((await readFile(eventPath, "utf8")).trim());
  assert.equal(event.content_length, Buffer.byteLength(secretPayload));
  assert.match(event.body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(event).includes("private canary payload"), false);
  assert.equal((await stat(eventPath)).mode & 0o777, 0o600);
});
