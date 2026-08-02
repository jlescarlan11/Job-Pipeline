import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [workflowPath, outputPath] = process.argv.slice(2);
if (!workflowPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-disposable-provider-sheet-failure.mjs <inactive-disposable-workflow.json> <private-output.json>"
  );
}

const raw = JSON.parse(await readFile(workflowPath, "utf8"));
const workflow = Array.isArray(raw) ? raw[0] : raw;
if (!workflow || !Array.isArray(workflow.nodes) || workflow.active !== false) {
  throw new Error("provider Sheet failure source must be an inactive disposable workflow");
}
if (workflow.nodes.some((node) => node.type === "n8n-nodes-base.scheduleTrigger")) {
  throw new Error("provider Sheet failure injection is forbidden on a scheduled workflow");
}

const targetNames = [
  "Persist Provider To Apply Updates",
  "Persist Provider Applied Updates",
  "Persist Provider Archive Updates"
];
const disposable = structuredClone(workflow);
disposable.name = `NONPROD SHEET-FAIL — ${workflow.name}`;
disposable.versionId = randomUUID();
let changed = 0;
for (const node of disposable.nodes) {
  if (!targetNames.includes(node.name)) continue;
  if (node.type !== "n8n-nodes-base.googleSheets") {
    throw new Error(`${node.name} is not a Google Sheets node`);
  }
  node.parameters.documentId = {
    __rl: true,
    mode: "id",
    value: "disposable-provider-sheet-failure"
  };
  changed += 1;
}
if (changed !== targetNames.length) {
  throw new Error("provider Sheet failure injection targets are incomplete");
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
    schedule_trigger_count: disposable.nodes.filter(
      (node) => node.type === "n8n-nodes-base.scheduleTrigger"
    ).length,
    injected_node_count: changed
  })}\n`
);
