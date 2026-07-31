import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sourceDir = process.argv[2];
if (!sourceDir) {
  throw new Error("Usage: node build-smoke-workflows.mjs <source-directory>");
}
const workflowIds = process.env.JOB_PIPELINE_SMOKE_ID_MAP
  ? JSON.parse(process.env.JOB_PIPELINE_SMOKE_ID_MAP)
  : {};

const sources = [
  ["scraper.json", "scraper-smoke.json"],
  ["generator.json", "generator-smoke.json"],
  ["alerter-mover.json", "alerter-mover-smoke.json"],
];

const outputDir = await mkdtemp(join(tmpdir(), "job-pipeline-smoke-workflows."));

for (const [sourceName, outputName] of sources) {
  const workflow = JSON.parse(
    await readFile(join(sourceDir, sourceName), "utf8"),
  );
  const schedule = workflow.nodes.find(
    (node) => node.type === "n8n-nodes-base.scheduleTrigger",
  );
  const scheduleConnection = workflow.connections[schedule?.name];

  if (!schedule || !scheduleConnection) {
    throw new Error(`${sourceName} has no connected Schedule Trigger`);
  }

  workflow.name =
    `NONPROD SMOKE 2026-07-31 — disposable ${sourceName.replace(".json", "")}`;
  workflow.active = false;
  workflow.nodes.push({
    parameters: {},
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    position: [schedule.position[0], schedule.position[1] + 180],
    id: crypto.randomUUID(),
    name: "Nonprod Manual Trigger",
  });
  workflow.connections["Nonprod Manual Trigger"] = structuredClone(
    scheduleConnection,
  );
  if (sourceName === "generator.json") {
    const repairWait = workflow.nodes.find(
      (node) => node.name === "Wait Before Repair",
    );
    if (!repairWait) throw new Error("Generator smoke copy has no repair wait");
    repairWait.type = "n8n-nodes-base.code";
    repairWait.typeVersion = 2;
    repairWait.parameters = {
      mode: "runOnceForAllItems",
      jsCode: "return $input.all();",
    };
  }
  workflow.id =
    workflowIds[sourceName] ??
    crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  workflow.versionId = crypto.randomUUID();

  await writeFile(
    join(outputDir, outputName),
    `${JSON.stringify(workflow, null, 2)}\n`,
    { mode: 0o600 },
  );
}

process.stdout.write(`${outputDir}\n`);
