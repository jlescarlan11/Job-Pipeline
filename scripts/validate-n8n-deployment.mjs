import { readFile } from "node:fs/promises";

import {
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";

const loadJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  );
const loadText = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const [
  policy,
  runtime,
  searchPlan,
  alertPolicy,
  pipelineSchema,
  candidateProfile,
  rankingPolicy,
  applicationPolicy,
  applicationPackPolicy,
  browserTask,
  browserTaskPrompt
] = await Promise.all([
  loadJson("../config/n8n-deployment-policy.json"),
  loadJson("../config/runtime.json"),
  loadJson("../config/search-plan.json"),
  loadJson("../config/alert-policy.json"),
  loadJson("../config/pipeline-schema.json"),
  loadJson("../config/candidate-profile.json"),
  loadJson("../config/ranking-policy.json"),
  loadJson("../config/application-policy.json"),
  loadJson("../config/application-pack-policy.json"),
  loadJson("../config/browser-executor-task.json"),
  readFile(new URL("../docs/browser-executor-task-prompt.md", import.meta.url), "utf8")
]);
const generatedWorkflows = await Promise.all(
  ["scraper", "alerter-mover"].map((name) =>
    loadJson(`../workflows/${name}.json`)
  )
);
const browserSkillBundle = await Promise.all(
  [
    "../.agents/skills/job-autopilot/SKILL.md",
    "../.agents/skills/job-autopilot/references/executor-protocol.md",
    "../.agents/skills/job-autopilot/references/onlinejobs-form-boundary.md",
    "../.agents/skills/job-autopilot/agents/openai.yaml"
  ].map(async (path) => ({ path, content: await loadText(path) }))
);
const browserProtocolBundle = await Promise.all(
  [
    "../AGENTS.md",
    "../src/browser-confirmation-adapter.mjs",
    "../src/browser-confirmation-attestation.mjs",
    "../src/browser-executor.mjs",
    "../src/browser-task-runtime.mjs",
    "../src/contracts.mjs",
    "../src/evaluation.mjs",
    "../src/profile.mjs",
    "../src/system-claims.mjs",
    "../scripts/browser-confirmation-adapter.mjs",
    "../scripts/browser-executor.mjs"
  ].map(
    async (path) => ({ path, content: await loadText(path) })
  )
);

const policyErrors = validateN8nDeploymentPolicy(policy, {
  runtime,
  searchPlan,
  alertPolicy,
  pipelineSchema,
  candidateProfile,
  rankingPolicy,
  applicationPolicy,
  applicationPackPolicy,
  generatedWorkflows,
  browserTask,
  browserTaskPrompt,
  browserSkillBundle,
  browserProtocolBundle
});
if (policyErrors.length > 0) {
  throw new Error(
    `Invalid n8n deployment policy:\n- ${policyErrors.join("\n- ")}`
  );
}

if (!process.argv.includes("--policy-only")) {
  const environmentErrors = validateN8nDeploymentEnvironment(
    policy,
    process.env
  );
  if (environmentErrors.length > 0) {
    throw new Error(
      `n8n deployment environment does not match policy:\n- ${environmentErrors.join("\n- ")}`
    );
  }
}

console.log(
  process.argv.includes("--policy-only")
    ? `n8n deployment policy ${policy.policy_version} is internally consistent.`
    : `n8n deployment environment matches ${policy.policy_version}.`
);
