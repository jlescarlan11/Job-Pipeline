import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [artifactPath, liveExportPath, outputPath] = process.argv.slice(2);
if (!artifactPath || !liveExportPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-bound-alerter-rollout.mjs <artifact.json> <live-export.json> <private-output.json>"
  );
}

const TARGET_WORKFLOW_ID = "QO6OLK3pHetgGIGq";
const GOOGLE_CREDENTIAL_TYPE = "googleSheetsOAuth2Api";

function unwrapWorkflow(value, label) {
  const workflow = Array.isArray(value) ? value[0] : value;
  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.nodes)) {
    throw new Error(`${label} is not a workflow export`);
  }
  return workflow;
}

function requiresGoogleSheetsCredential(node) {
  return (
    node?.type === "n8n-nodes-base.googleSheets" ||
    (node?.type === "n8n-nodes-base.httpRequest" &&
      node?.parameters?.authentication === "predefinedCredentialType" &&
      node?.parameters?.nodeCredentialType === GOOGLE_CREDENTIAL_TYPE)
  );
}

const [artifactText, liveText] = await Promise.all([
  readFile(artifactPath, "utf8"),
  readFile(liveExportPath, "utf8")
]);
const artifact = unwrapWorkflow(JSON.parse(artifactText), "generated artifact");
const live = unwrapWorkflow(JSON.parse(liveText), "live workflow export");

if (String(live.id || "") !== TARGET_WORKFLOW_ID) {
  throw new Error("live workflow export does not match the production target ID");
}
if (artifact.active !== false) {
  throw new Error("generated artifact must be inactive before binding");
}

const nodeNames = artifact.nodes.map((node) => String(node?.name || ""));
if (nodeNames.some((name) => !name) || new Set(nodeNames).size !== nodeNames.length) {
  throw new Error("generated artifact has missing or duplicate node names");
}

const credentialCandidates = live.nodes
  .map((node) => node?.credentials?.[GOOGLE_CREDENTIAL_TYPE])
  .filter(Boolean);
const credentialFingerprints = new Map(
  credentialCandidates.map((credential) => [
    createHash("sha256").update(JSON.stringify(credential)).digest("hex"),
    credential
  ])
);
if (credentialFingerprints.size !== 1) {
  throw new Error("live workflow must expose exactly one Google Sheets credential binding");
}
const googleSheetsCredential = structuredClone(
  credentialFingerprints.values().next().value
);

const bound = structuredClone(artifact);
bound.id = TARGET_WORKFLOW_ID;
bound.versionId = randomUUID();
bound.active = false;
let credentialBoundNodeCount = 0;
for (const node of bound.nodes) {
  if (!requiresGoogleSheetsCredential(node)) continue;
  node.credentials = {
    ...(node.credentials ?? {}),
    [GOOGLE_CREDENTIAL_TYPE]: structuredClone(googleSheetsCredential)
  };
  credentialBoundNodeCount += 1;
}

const missingCredentialNodes = bound.nodes
  .filter(requiresGoogleSheetsCredential)
  .filter((node) => !node.credentials?.[GOOGLE_CREDENTIAL_TYPE])
  .map((node) => node.name);
if (missingCredentialNodes.length > 0) {
  throw new Error(
    `bound workflow has missing Google Sheets credentials: ${missingCredentialNodes.join(", ")}`
  );
}

const serialized = `${JSON.stringify(bound, null, 2)}\n`;
await writeFile(outputPath, serialized, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);

process.stdout.write(
  `${JSON.stringify({
    workflow_id: TARGET_WORKFLOW_ID,
    node_count: bound.nodes.length,
    credential_bound_node_count: credentialBoundNodeCount,
    schedule_expression:
      bound.nodes.find((node) => node.type === "n8n-nodes-base.scheduleTrigger")
        ?.parameters?.rule?.interval?.[0]?.expression ?? "",
    timezone: bound.settings?.timezone ?? "",
    execution_timeout_seconds: bound.settings?.executionTimeout ?? null,
    deployable_sha256: createHash("sha256").update(serialized).digest("hex")
  })}\n`
);
