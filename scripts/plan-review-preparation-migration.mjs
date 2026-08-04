import { readFile } from "node:fs/promises";

import { planReviewPreparationMigration } from "../src/review-preparation-cutover.mjs";

const [snapshotPath] = process.argv.slice(2);
if (!snapshotPath) {
  throw new Error(
    "Usage: npm run plan:review-preparation -- <private-fresh-snapshot.json>"
  );
}

const [snapshot, schema] = await Promise.all(
  [snapshotPath, new URL("../config/pipeline-schema.json", import.meta.url)].map(
    async (path) => JSON.parse(await readFile(path, "utf8"))
  )
);
const plan = planReviewPreparationMigration(snapshot, schema);
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
if (!plan.ok) process.exitCode = 2;
