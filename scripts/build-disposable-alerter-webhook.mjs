import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [boundWorkflowPath, outputPath, webhookPath = "quota-safe-alerter-disposable"] =
  process.argv.slice(2);
if (!boundWorkflowPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-disposable-alerter-webhook.mjs <bound-workflow.json> <private-output.json> [webhook-path]"
  );
}
if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(webhookPath)) {
  throw new Error("disposable webhook path is invalid");
}

const raw = JSON.parse(await readFile(boundWorkflowPath, "utf8"));
const workflow = Array.isArray(raw) ? raw[0] : raw;
if (!workflow || !Array.isArray(workflow.nodes) || workflow.active !== false) {
  throw new Error("bound disposable source must be an inactive workflow");
}

const schedule = workflow.nodes.find(
  (node) => node.type === "n8n-nodes-base.scheduleTrigger"
);
const scheduleConnections = workflow.connections?.[schedule?.name];
if (!schedule || !scheduleConnections) {
  throw new Error("bound disposable source has no connected schedule trigger");
}

const disposable = structuredClone(workflow);
disposable.name = `NONPROD WEBHOOK — ${workflow.name}`;
disposable.versionId = randomUUID();
disposable.active = false;
disposable.settings = {
  ...(disposable.settings ?? {}),
  saveDataSuccessExecution: "all",
  saveDataErrorExecution: "all",
  saveExecutionProgress: true,
  saveManualExecutions: true
};
disposable.nodes = disposable.nodes.filter((node) => node.name !== schedule.name);
delete disposable.connections[schedule.name];
disposable.nodes.push({
  parameters: {
    httpMethod: "POST",
    path: webhookPath,
    authentication: "none",
    responseMode: "onReceived",
    options: { noResponseBody: true }
  },
  type: "n8n-nodes-base.webhook",
  typeVersion: 2.1,
  position: structuredClone(schedule.position),
  id: randomUUID(),
  webhookId: randomUUID(),
  name: "Disposable Webhook Trigger"
});
disposable.connections["Disposable Webhook Trigger"] =
  structuredClone(scheduleConnections);

await writeFile(outputPath, `${JSON.stringify(disposable, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
});
await chmod(outputPath, 0o600);

process.stdout.write(
  `${JSON.stringify({
    workflow_id: disposable.id,
    active: disposable.active,
    node_count: disposable.nodes.length,
    schedule_trigger_count: disposable.nodes.filter(
      (node) => node.type === "n8n-nodes-base.scheduleTrigger"
    ).length,
    webhook_trigger_count: disposable.nodes.filter(
      (node) => node.type === "n8n-nodes-base.webhook"
    ).length,
    webhook_path: webhookPath
  })}\n`
);
