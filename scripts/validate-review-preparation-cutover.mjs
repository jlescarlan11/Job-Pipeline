import { readFile } from "node:fs/promises";

import { validateReviewPreparationCutoverEvidence } from "../src/review-preparation-cutover.mjs";

const [evidencePath] = process.argv.slice(2);
if (!evidencePath) {
  throw new Error(
    "Usage: npm run validate:review-preparation-cutover -- <sanitized-evidence.json>"
  );
}

const paths = [
  new URL("../config/pipeline-schema.json", import.meta.url),
  new URL("../config/runtime.json", import.meta.url),
  new URL("../config/n8n-deployment-policy.json", import.meta.url),
  new URL("../config/alert-receipts.json", import.meta.url),
  evidencePath
];
const [schema, runtime, deploymentPolicy, receiptPolicy, evidence] =
  await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, "utf8")))
  );
const errors = validateReviewPreparationCutoverEvidence(
  schema,
  runtime,
  deploymentPolicy,
  receiptPolicy,
  evidence
);
if (errors.length > 0) {
  throw new Error(`Unsafe review/preparation cutover:\n- ${errors.join("\n- ")}`);
}
console.log(
  `Review/preparation ${evidence.phase} evidence satisfies the safety contract.`
);
