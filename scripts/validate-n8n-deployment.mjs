import { readFile } from "node:fs/promises";

import {
  validateN8nDeploymentEnvironment,
  validateN8nDeploymentPolicy
} from "../src/n8n-deployment.mjs";

const loadJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  );

const [
  policy,
  runtime,
  searchPlan,
  alertPolicy,
  review,
  analytics,
  recommendations
] = await Promise.all([
  loadJson("../config/n8n-deployment-policy.json"),
  loadJson("../config/runtime.json"),
  loadJson("../config/search-plan.json"),
  loadJson("../config/alert-policy.json"),
  loadJson("../config/review-sheet.json"),
  loadJson("../config/analytics-policy.json"),
  loadJson("../config/recommendation-policy.json")
]);

const policyErrors = validateN8nDeploymentPolicy(policy, {
  runtime,
  searchPlan,
  alertPolicy,
  review,
  analytics,
  recommendations
});
if (policyErrors.length > 0) {
  throw new Error(
    `Invalid n8n deployment policy:\n- ${policyErrors.join("\n- ")}`
  );
}

const environmentErrors = validateN8nDeploymentEnvironment(
  policy,
  process.env
);
if (environmentErrors.length > 0) {
  throw new Error(
    `n8n deployment environment does not match policy:\n- ${environmentErrors.join("\n- ")}`
  );
}

console.log(
  `n8n deployment environment matches ${policy.policy_version}.`
);
