import { readFile } from "node:fs/promises";

import { planAutonomousBrowserMigration } from "../src/autonomous-browser-cutover.mjs";

const [snapshotPath] = process.argv.slice(2);
if (!snapshotPath) {
  throw new Error(
    "Usage: node scripts/plan-autonomous-browser-migration.mjs <private-fresh-snapshot.json>"
  );
}

const [snapshot, schema] = await Promise.all(
  [snapshotPath, new URL("../config/pipeline-schema.json", import.meta.url)].map(
    async (path) => JSON.parse(await readFile(path, "utf8"))
  )
);
const plan = planAutonomousBrowserMigration(snapshot, schema);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
if (!plan.ok) process.exitCode = 2;
