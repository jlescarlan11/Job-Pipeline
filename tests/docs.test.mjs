import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const loadText = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const loadJson = async (path) => JSON.parse(await loadText(path));

const readme = await loadText("../README.md");
const architecture = await loadText("../docs/architecture.md");
const sheetSchema = await loadText("../docs/sheet-schema.md");
const operations = await loadText("../docs/operations.md");
const prompt = await loadText("../docs/master-prompt.md");
const schema = await loadJson("../config/pipeline-schema.json");
const searchPlan = await loadJson("../config/search-plan.json");
const runtime = await loadJson("../config/runtime.json");
const review = await loadJson("../config/review-sheet.json");

test("README and architecture document the checked-in schedules, bounds, and manual boundary", () => {
  for (const document of [readme, architecture]) {
    assert.match(document, new RegExp(`${searchPlan.schedule_hours}\\s*hours?`, "i"));
    assert.match(document, new RegExp(`${runtime.generator.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(document, new RegExp(`${review.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(document, new RegExp(`${runtime.archiver.schedule_minutes}\\s*minutes?`, "i"));
    assert.match(document, /manual/i);
    assert.doesNotMatch(document, /three independent n8n workflows|cap(?:ped)? (?:at|of) 10/i);
  }
  assert.match(readme, /all checked-in n8n exports have `active: false`/i);
  assert.match(architecture, /at most 5/i);
  assert.match(architecture, /3 times with 5-second/i);
  assert.match(architecture, /10-minute claim lease/i);
});

test("Sheet schema documentation covers every persisted field, status, and manual action", () => {
  for (const field of schema.fields) {
    assert.match(sheetSchema, new RegExp(`\\\`${field}\\\``), `missing field documentation: ${field}`);
  }
  for (const status of schema.pipeline_statuses) {
    assert.match(sheetSchema, new RegExp(`\\b${status}\\b`), `missing status documentation: ${status}`);
  }
  for (const action of schema.manual_actions.filter(Boolean)) {
    const documented = action.startsWith("outcome_") ? "outcome_" : action;
    assert.match(sheetSchema, new RegExp(`\\b${documented}\\b`), `missing action documentation: ${action}`);
  }
});

test("runbook contains every release and rollback safety gate", () => {
  for (const required of [
    "Backup",
    "Schema migration on a copy",
    "Disabled import and rebinding",
    "Dry run and smoke checks",
    "Production activation",
    "Production verification",
    "Rollback",
    "disable every old",
    "canonical identity",
    "ready messages",
    "application decisions",
    "Archive"
  ]) {
    assert.match(operations, new RegExp(required, "i"), `runbook is missing: ${required}`);
  }
});

test("prompt documentation points to generated canonical inputs without embedding obsolete facts", () => {
  assert.match(prompt, /config\/candidate-profile\.json/);
  assert.match(prompt, /config\/application-policy\.json/);
  assert.match(prompt, /deterministic validation/i);
  assert.doesNotMatch(prompt, /netlify|FireCheck|PriceCraft|HEALTH/);
});
