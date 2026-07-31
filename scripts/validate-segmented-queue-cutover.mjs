import { readFile } from "node:fs/promises";

import { validateSegmentedQueueCutoverEvidence } from "../src/segmented-queue-cutover.mjs";

const [evidencePath] = process.argv.slice(2);
if (!evidencePath) {
  throw new Error(
    "Usage: npm run validate:segmented-cutover -- <sanitized-production-evidence.json>"
  );
}

const [schema, review, evidence] = await Promise.all(
  [
    new URL("../config/pipeline-schema.json", import.meta.url),
    new URL("../config/review-sheet.json", import.meta.url),
    evidencePath
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")))
);
const errors = validateSegmentedQueueCutoverEvidence(schema, review, evidence);
if (errors.length > 0) {
  throw new Error(`Unsafe segmented queue cutover:\n- ${errors.join("\n- ")}`);
}

console.log(
  `Segmented queue ${evidence.phase} evidence satisfies the production safety contract.`
);
