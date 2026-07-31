import { readFile, writeFile } from "node:fs/promises";

const [phase, inventoryPath, targetMapPath, outputPath] =
  process.argv.slice(2);
if (
  !["pre_activation", "post_activation"].includes(phase) ||
  !inventoryPath ||
  !targetMapPath ||
  !outputPath
) {
  throw new Error(
    "Usage: node build-local-cutover-evidence.mjs <pre_activation|post_activation> <inventory.json> <target-map.json> <output.json>",
  );
}

const [inventory, targetMap] = await Promise.all([
  readFile(inventoryPath, "utf8").then(JSON.parse),
  readFile(targetMapPath, "utf8").then(JSON.parse),
]);
const bindings = targetMap.workflow_bindings ?? {};
const observations =
  phase === "post_activation"
    ? Object.fromEntries(
        Object.keys(targetMap.observations ?? {}).map((name) => [name, true]),
      )
    : targetMap.observations;

const evidence = {
  schema_version: 2,
  policy_version: "2026-07-31/v1",
  phase,
  captured_at: new Date().toISOString(),
  inventory_scope: "instance_wide",
  inventory_complete: true,
  workflows: inventory.map((workflow) => ({
    id: String(workflow.id || ""),
    name: String(workflow.name || "").slice(0, 200),
    active:
      phase === "pre_activation"
        ? false
        : Boolean(workflow.active),
    nodes: (workflow.nodes ?? []).map((node) =>
      String(node?.name || "").slice(0, 200),
    ),
    spreadsheet_id: String(bindings[workflow.id]?.spreadsheet_id || ""),
  })),
  target_workflow_ids: targetMap.target_workflow_ids,
  fresh_workbook: targetMap.fresh_workbook,
  old_workbook: targetMap.old_workbook,
  workflow_backup: targetMap.workflow_backup,
  smoke: targetMap.smoke,
  observations,
  rollback: targetMap.rollback,
};

await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
