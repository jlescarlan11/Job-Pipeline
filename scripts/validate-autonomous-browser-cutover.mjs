import { readFile } from "node:fs/promises";

import { reviewedMainDeploymentCommit } from "../src/deployment-provenance.mjs";
import { validateAutonomousBrowserCutoverEvidence } from "../src/autonomous-browser-cutover.mjs";

const [evidencePath] = process.argv.slice(2);
if (!evidencePath) {
  throw new Error(
    "Usage: node scripts/validate-autonomous-browser-cutover.mjs <sanitized-evidence.json>"
  );
}
const [policy, evidence] = await Promise.all(
  [
    new URL("../config/n8n-deployment-policy.json", import.meta.url),
    evidencePath
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")))
);
const expectedCommit = await reviewedMainDeploymentCommit();
if (evidence.deployment_commit !== expectedCommit) {
  throw new Error("autonomous cutover evidence commit does not match reviewed main");
}
const errors = validateAutonomousBrowserCutoverEvidence(policy, evidence);
if (errors.length > 0) {
  throw new Error(`Unsafe autonomous browser cutover:\n- ${errors.join("\n- ")}`);
}
console.log(`Autonomous browser ${evidence.phase} evidence passed its source gate.`);
