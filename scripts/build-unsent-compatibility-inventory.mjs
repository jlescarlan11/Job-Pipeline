import { readFile, writeFile } from "node:fs/promises";

import { buildUnsentCompatibilityInventory } from "../src/unsent-compatibility.mjs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error(
    "Usage: npm run inventory:unsent -- <private-snapshot.json> <new-sanitized-inventory.json>"
  );
}

const loadJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const [snapshot, pipelineSchema, packPolicy, deploymentPolicy] = await Promise.all([
  loadJson(inputPath),
  loadJson(new URL("../config/pipeline-schema.json", import.meta.url)),
  loadJson(new URL("../config/application-pack-policy.json", import.meta.url)),
  loadJson(new URL("../config/n8n-deployment-policy.json", import.meta.url))
]);

const inventory = buildUnsentCompatibilityInventory({
  records: snapshot.records,
  profile: snapshot.profile,
  applicationPolicy: snapshot.application_policy,
  packPolicy,
  pipelineSchema,
  applicationCompatibility: deploymentPolicy.application_compatibility,
  dispositions: snapshot.dispositions,
  capturedAt: snapshot.captured_at
});

await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600
});
console.log(
  `Sanitized ${inventory.total_records} unsent record(s); ${inventory.unhandled_incompatible_records} incompatible record(s) remain pending.`
);
