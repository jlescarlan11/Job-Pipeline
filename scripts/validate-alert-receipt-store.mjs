import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  validateAlertReceiptCompatibility,
  validateAlertReceiptPolicy
} from "../src/alert-receipts.mjs";
import {
  alertReceiptDataTableProvisioningPlan,
  validateAlertReceiptDataTableSnapshot
} from "../src/alert-receipt-store.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));

const args = process.argv.slice(2);
const snapshotFlag = args.indexOf("--snapshot");
const planOnly = args.length === 1 && args[0] === "--plan";
const snapshotOnly =
  args.length === 2 && snapshotFlag === 0 && Boolean(args[snapshotFlag + 1]);
if (args.length > 0 && !planOnly && !snapshotOnly) {
  throw new Error(
    "Usage: node scripts/validate-alert-receipt-store.mjs [--plan | --snapshot <sanitized-full-export.json>]"
  );
}

const [policy, alertPolicy] = await Promise.all([
  loadJson("config/alert-receipts.json"),
  loadJson("config/alert-policy.json")
]);
const policyErrors = [
  ...validateAlertReceiptPolicy(policy),
  ...validateAlertReceiptCompatibility(policy, alertPolicy)
];
if (policyErrors.length > 0) {
  throw new Error(`Invalid alert receipt policy:\n- ${policyErrors.join("\n- ")}`);
}

const plan = alertReceiptDataTableProvisioningPlan(policy);
if (snapshotOnly) {
  const snapshot = await loadJson(args[snapshotFlag + 1]);
  const snapshotErrors = validateAlertReceiptDataTableSnapshot(snapshot, policy);
  if (snapshotErrors.length > 0) {
    throw new Error(
      `Invalid alert receipt Data Table snapshot:\n- ${snapshotErrors.join("\n- ")}`
    );
  }
  console.log(
    `Alert receipt Data Table snapshot is valid (${snapshot.rows.length} bounded rows).`
  );
} else if (planOnly) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(
    `Alert receipt policy ${policy.policy_version} defines ${plan.columns.length} bounded Data Table columns; no store was mutated.`
  );
}
