import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

import {
  googleCredentialNodeNames,
  safeGoogleCredentialReference,
  workflowDeploymentDigest
} from "../src/workflow-cutover.mjs";

const [artifactPath, liveExportPath, outputPath] = process.argv.slice(2);
if (!artifactPath || !liveExportPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/build-bound-workflow-rollout.mjs <artifact.json> <live-export.json> <private-output.json>"
  );
}

const GOOGLE_CREDENTIAL_TYPE = "googleSheetsOAuth2Api";

function unwrapWorkflow(value, label) {
  const workflow = Array.isArray(value) ? value[0] : value;
  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.nodes)) {
    throw new Error(`${label} is not a workflow export`);
  }
  return workflow;
}

function roleMatches(workflow, role) {
  const names = new Set((workflow?.nodes ?? []).map((node) => node?.name));
  return (
    role.name_markers.every((marker) =>
      String(workflow?.name || "").includes(marker)
    ) && role.required_node_names.every((name) => names.has(name))
  );
}

function liveTargetMatches(workflow, role) {
  return role.name_markers.every((marker) =>
    String(workflow?.name || "").includes(marker)
  );
}

const [artifactText, liveText, policyText] = await Promise.all([
  readFile(artifactPath, "utf8"),
  readFile(liveExportPath, "utf8"),
  readFile(new URL("../config/n8n-deployment-policy.json", import.meta.url), "utf8")
]);
const artifact = unwrapWorkflow(JSON.parse(artifactText), "generated artifact");
const live = unwrapWorkflow(JSON.parse(liveText), "live workflow export");
const policy = JSON.parse(policyText);
const matches = policy.workflow_cutover.roles.filter((role) =>
  roleMatches(artifact, role)
);
if (matches.length !== 1) {
  throw new Error("generated artifact must match exactly one deployment role");
}
const role = matches[0];
if (
  !liveTargetMatches(live, role) ||
  String(live.id || "") !== role.target_workflow_id
) {
  throw new Error("live workflow export does not match the pinned production target");
}
if (artifact.active !== false) {
  throw new Error("generated artifact must be inactive before binding");
}
if (
  artifact.nodes.some(
    (node) => node?.credentials && Object.keys(node.credentials).length > 0
  )
) {
  throw new Error("generated artifact must not contain credential references");
}
if (workflowDeploymentDigest(artifact) !== role.artifact_digest) {
  throw new Error("generated artifact does not match the deployment policy digest");
}

const requiredNames = new Set(googleCredentialNodeNames(artifact));
if (requiredNames.size !== role.google_credential_node_count) {
  throw new Error("generated artifact Google credential-node count is stale");
}
const liveCredentialNames = new Set(googleCredentialNodeNames(live));
if (liveCredentialNames.size === 0) {
  throw new Error("live workflow must expose at least one Google credential node");
}
const credentialCandidates = live.nodes
  .filter((node) => liveCredentialNames.has(node.name))
  .map((node) =>
    safeGoogleCredentialReference(node?.credentials?.[GOOGLE_CREDENTIAL_TYPE])
  );
if (credentialCandidates.some((credential) => credential === null)) {
  throw new Error("every live Google node must expose one safe credential reference");
}
const credentialFingerprints = new Map(
  credentialCandidates.map((credential) => [
    createHash("sha256").update(JSON.stringify(credential)).digest("hex"),
    credential
  ])
);
if (credentialFingerprints.size !== 1) {
  throw new Error("live workflow must expose exactly one Google Sheets credential binding");
}
const googleCredential = structuredClone(
  credentialFingerprints.values().next().value
);

const bound = structuredClone(artifact);
bound.id = role.target_workflow_id;
bound.versionId = randomUUID();
bound.active = false;
let credentialBoundNodeCount = 0;
for (const node of bound.nodes) {
  if (!requiredNames.has(node.name)) continue;
  node.credentials = {
    [GOOGLE_CREDENTIAL_TYPE]: structuredClone(googleCredential)
  };
  credentialBoundNodeCount += 1;
}
if (
  credentialBoundNodeCount !== role.google_credential_node_count ||
  workflowDeploymentDigest(bound) !== role.artifact_digest
) {
  throw new Error("bound workflow failed credential or artifact verification");
}

const serialized = `${JSON.stringify(bound, null, 2)}\n`;
await writeFile(outputPath, serialized, { flag: "wx", mode: 0o600 });
await chmod(outputPath, 0o600);
process.stdout.write(
  `${JSON.stringify({
    role: role.role,
    workflow_id: role.target_workflow_id,
    artifact_digest: role.artifact_digest,
    node_count: bound.nodes.length,
    credential_source_node_count: liveCredentialNames.size,
    credential_bound_node_count: credentialBoundNodeCount,
    schedule_expressions: role.schedule_expressions,
    timezone: bound.settings?.timezone ?? "",
    execution_timeout_seconds: bound.settings?.executionTimeout ?? null,
    deployable_sha256: createHash("sha256").update(serialized).digest("hex")
  })}\n`
);
