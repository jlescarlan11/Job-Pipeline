import { readFile, writeFile } from "node:fs/promises";

import { planSegmentedQueueMigration } from "../src/fresh-sheet-setup.mjs";

const [snapshotPath, outputPath, referenceTime] = process.argv.slice(2);
if (!snapshotPath || !outputPath) {
  throw new Error(
    "Usage: npm run plan:segmented-queues -- <private-workbook-snapshot.json> <private-migration-plan.json> [reference-time]"
  );
}

const [snapshot, review, schema] = await Promise.all(
  [
    snapshotPath,
    new URL("../config/review-sheet.json", import.meta.url),
    new URL("../config/pipeline-schema.json", import.meta.url)
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")))
);

const now = referenceTime || new Date().toISOString();
if (!Number.isFinite(Date.parse(now))) {
  throw new Error("reference-time must be a valid timestamp");
}

const plan = planSegmentedQueueMigration(snapshot, review, schema, now);
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600
});

if (!plan.ok) {
  throw new Error(
    `Segmented queue migration refused the snapshot; private rejection plan written to ${outputPath}`
  );
}

console.log(
  `Private deterministic migration plan written to ${outputPath}; it contains job identities and must not be committed.`
);
