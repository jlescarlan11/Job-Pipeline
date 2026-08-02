import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [boundWorkflowPath, outputPath] = process.argv.slice(2);
if (!boundWorkflowPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-rollout-observation-workflow.mjs <bound-workflow.json> <private-output.json>"
  );
}
const raw = JSON.parse(await readFile(boundWorkflowPath, "utf8"));
const workflow = Array.isArray(raw) ? raw[0] : raw;
if (!workflow || !Array.isArray(workflow.nodes) || workflow.active !== false) {
  throw new Error("rollout observation source must be an inactive bound workflow");
}
if (
  workflow.nodes.filter((node) => node.type === "n8n-nodes-base.scheduleTrigger")
    .length !== 1
) {
  throw new Error("rollout observation requires exactly one schedule trigger");
}
const observation = structuredClone(workflow);
observation.versionId = randomUUID();
observation.active = false;
observation.settings = {
  ...(observation.settings ?? {}),
  saveDataSuccessExecution: "all",
  saveDataErrorExecution: "all",
  saveExecutionProgress: true,
  saveManualExecutions: true
};
await writeFile(outputPath, `${JSON.stringify(observation, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600
});
await chmod(outputPath, 0o600);
process.stdout.write(
  `${JSON.stringify({
    workflow_id: observation.id,
    node_count: observation.nodes.length,
    success_evidence_enabled: true,
    schedule_trigger_count: 1
  })}\n`
);
