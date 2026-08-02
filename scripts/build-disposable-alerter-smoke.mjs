import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [boundWorkflowPath, outputPath] = process.argv.slice(2);
if (!boundWorkflowPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-disposable-alerter-smoke.mjs <bound-workflow.json> <private-output.json>"
  );
}

const raw = JSON.parse(await readFile(boundWorkflowPath, "utf8"));
const workflow = Array.isArray(raw) ? raw[0] : raw;
if (!workflow || !Array.isArray(workflow.nodes) || workflow.active !== false) {
  throw new Error("bound disposable source must be an inactive workflow");
}
if (
  workflow.nodes.some(
    (node) => node.type === "n8n-nodes-base.executeWorkflowTrigger"
  )
) {
  throw new Error("bound disposable source already has an execute-workflow trigger");
}

const schedule = workflow.nodes.find(
  (node) => node.type === "n8n-nodes-base.scheduleTrigger"
);
const scheduleConnections = workflow.connections?.[schedule?.name];
if (!schedule || !scheduleConnections) {
  throw new Error("bound disposable source has no connected schedule trigger");
}

const disposable = structuredClone(workflow);
disposable.name = `NONPROD DISPOSABLE — ${workflow.name}`;
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
  parameters: { inputSource: "passthrough" },
  type: "n8n-nodes-base.executeWorkflowTrigger",
  typeVersion: 1.2,
  position: structuredClone(schedule.position),
  id: randomUUID(),
  name: "Disposable Execute Trigger"
});
disposable.connections["Disposable Execute Trigger"] =
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
    execute_trigger_count: disposable.nodes.filter(
      (node) => node.type === "n8n-nodes-base.executeWorkflowTrigger"
    ).length,
    schedule_trigger_count: disposable.nodes.filter(
      (node) => node.type === "n8n-nodes-base.scheduleTrigger"
    ).length
  })}\n`
);
