import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [workflowPath, outputPath, endpoint = "http://127.0.0.1:5800/values:batchGet"] =
  process.argv.slice(2);
if (!workflowPath || !outputPath || !/^http:\/\/127\.0\.0\.1:\d+\//.test(endpoint)) {
  throw new Error(
    "Usage: node scripts/build-disposable-sheets-quota-probe.mjs <inactive-disposable-workflow.json> <private-output.json> [loopback-endpoint]"
  );
}
const raw = JSON.parse(await readFile(workflowPath, "utf8"));
const workflow = Array.isArray(raw) ? raw[0] : raw;
if (!workflow || !Array.isArray(workflow.nodes) || workflow.active !== false) {
  throw new Error("Sheets quota probe source must be an inactive disposable workflow");
}
if (workflow.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger")) {
  throw new Error("Sheets quota injection is forbidden on a scheduled workflow");
}
const disposable = structuredClone(workflow);
disposable.name = `NONPROD SHEETS-429 — ${workflow.name}`;
disposable.versionId = randomUUID();
const targets = disposable.nodes.filter((node) =>
  ["Get Business Snapshot", "Retry Business Snapshot"].includes(node.name)
);
const quotaWait = disposable.nodes.find(
  (node) => node.name === "Wait for Sheets Quota Window"
);
if (
  targets.length !== 2 ||
  targets.some((node) => node.type !== "n8n-nodes-base.httpRequest") ||
  quotaWait?.type !== "n8n-nodes-base.wait" ||
  quotaWait.parameters?.unit !== "seconds" ||
  Number(quotaWait.parameters?.amount || 0) < 60
) {
  throw new Error("Sheets quota probe requires the explicit bounded quota retry path");
}
for (const target of targets) {
  target.parameters.url = `=${endpoint}`;
  target.parameters.authentication = "none";
  delete target.parameters.nodeCredentialType;
  delete target.credentials;
}

await writeFile(outputPath, `${JSON.stringify(disposable, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
});
await chmod(outputPath, 0o600);
process.stdout.write(
  `${JSON.stringify({
    workflow_id: disposable.id,
    active: disposable.active,
    schedule_trigger_count: 0,
    injected_node_count: targets.length,
    maximum_attempts: 2,
    quota_wait_seconds: quotaWait.parameters.amount
  })}\n`
);
