import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [repositoryDirectory, previousBoundDirectory] = process.argv.slice(2);
if (!repositoryDirectory || !previousBoundDirectory) {
  throw new Error(
    "Usage: node build-bound-replacements.mjs <repository-directory> <previous-bound-directory>",
  );
}

const targets = [
  ["scraper.json", "qxPbOzNs5StaPY8B"],
  ["generator.json", "TRUqD9atneyDyMNx"],
  ["alerter-mover.json", "QO6OLK3pHetgGIGq"],
];
const outputDirectory = await mkdtemp(
  join(tmpdir(), "job-pipeline-bound-replacements."),
);

for (const [fileName, workflowId] of targets) {
  const [workflowExport, previousBoundExport] = await Promise.all([
    readFile(join(repositoryDirectory, fileName), "utf8").then(JSON.parse),
    readFile(join(previousBoundDirectory, fileName), "utf8").then(JSON.parse),
  ]);
  const workflow = Array.isArray(workflowExport)
    ? workflowExport[0]
    : workflowExport;
  const previousBound = Array.isArray(previousBoundExport)
    ? previousBoundExport[0]
    : previousBoundExport;
  const credentialsByNode = new Map(
    previousBound.nodes
      .filter((node) => node.credentials)
      .map((node) => [node.name, node.credentials]),
  );
  const googleSheetsCredentials = previousBound.nodes.find(
    (node) =>
      node.type === "n8n-nodes-base.googleSheets" &&
      node.credentials,
  )?.credentials;

  workflow.id = workflowId;
  workflow.versionId = crypto.randomUUID();
  workflow.active = false;
  for (const node of workflow.nodes) {
    const credentials =
      credentialsByNode.get(node.name) ||
      (node.type === "n8n-nodes-base.googleSheets"
        ? googleSheetsCredentials
        : undefined);
    if (credentials) node.credentials = structuredClone(credentials);
  }
  const unboundGoogleSheetsNodes = workflow.nodes
    .filter(
      (node) =>
        node.type === "n8n-nodes-base.googleSheets" &&
        !node.credentials,
    )
    .map((node) => node.name);
  if (unboundGoogleSheetsNodes.length > 0) {
    throw new Error(
      `${workflowId} has unbound Google Sheets nodes: ${unboundGoogleSheetsNodes.join(", ")}`,
    );
  }

  await writeFile(
    join(outputDirectory, fileName),
    `${JSON.stringify(workflow, null, 2)}\n`,
    { mode: 0o600 },
  );
}

process.stdout.write(`${outputDirectory}\n`);
