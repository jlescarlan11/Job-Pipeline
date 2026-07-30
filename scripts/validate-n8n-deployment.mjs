import { readFile } from "node:fs/promises";

import {
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";

const loadJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  );

const [policy, runtime, searchPlan, alertPolicy] = await Promise.all([
  loadJson("../config/n8n-deployment-policy.json"),
  loadJson("../config/runtime.json"),
  loadJson("../config/search-plan.json"),
  loadJson("../config/alert-policy.json")
]);

const policyErrors = validateN8nDeploymentPolicy(policy, {
  runtime,
  searchPlan,
  alertPolicy
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
