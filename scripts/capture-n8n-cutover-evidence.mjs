import { readFile, writeFile } from "node:fs/promises";

import {
  captureWorkflowCutoverEvidence,
  validateWorkflowCutoverEvidence
} from "../src/workflow-cutover.mjs";

const [phase, targetMapPath, outputPath] = process.argv.slice(2);
if (!phase || !targetMapPath || !outputPath) {
  throw new Error(
    "Usage: npm run capture:cutover -- <pre_activation|post_activation> <target-map.json> <new-evidence.json>"
  );
}

const [policy, targetMap] = await Promise.all(
  [
    new URL("../config/n8n-deployment-policy.json", import.meta.url),
    targetMapPath
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")))
);

const evidence = await captureWorkflowCutoverEvidence({
  policy,
  phase,
  apiBaseUrl: process.env.N8N_PUBLIC_API_URL,
  apiKey: process.env.N8N_API_KEY,
  targetMap
});
const errors = validateWorkflowCutoverEvidence(policy, evidence);
if (errors.length > 0) {
  throw new Error(`Unsafe workflow cutover:\n- ${errors.join("\n- ")}`);
}

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600
});
console.log(`Sanitized ${phase} cutover evidence written to ${outputPath}.`);
