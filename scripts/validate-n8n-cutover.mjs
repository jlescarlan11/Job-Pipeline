import { readFile } from "node:fs/promises";

import { reviewedMainDeploymentCommit } from "../src/deployment-provenance.mjs";
import { validateWorkflowCutoverEvidence } from "../src/workflow-cutover.mjs";

const [evidencePath] = process.argv.slice(2);
if (!evidencePath) {
  throw new Error(
    "Usage: npm run validate:cutover -- <cutover-evidence.json>"
  );
}

const [policy, evidence] = await Promise.all(
  [
    new URL("../config/n8n-deployment-policy.json", import.meta.url),
    evidencePath
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")))
);
const expectedDeploymentCommit = await reviewedMainDeploymentCommit();
const errors = validateWorkflowCutoverEvidence(policy, evidence, {
  expectedDeploymentCommit
});
if (errors.length > 0) {
  throw new Error(`Unsafe workflow cutover:\n- ${errors.join("\n- ")}`);
}

console.log(
  `n8n ${evidence.phase} evidence permits this cutover phase for the three replacement roles.`
);
