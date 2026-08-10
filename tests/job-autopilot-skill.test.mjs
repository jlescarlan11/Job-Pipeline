import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const skillRoot = new URL("../.agents/skills/job-autopilot/", import.meta.url);
const readSkill = (path) => readFile(new URL(path, skillRoot), "utf8");

test("job-autopilot skill is explicit, Chrome-only, and capability ordered", async () => {
  const [skill, protocol, boundary, metadata] = await Promise.all([
    readSkill("SKILL.md"),
    readSkill("references/executor-protocol.md"),
    readSkill("references/onlinejobs-form-boundary.md"),
    readSkill("agents/openai.yaml")
  ]);
  assert.match(skill, /^---\nname: job-autopilot\n/);
  assert.match(skill, /installed Chrome plugin/);
  assert.match(skill, /Do not\n\s+substitute the in-app browser, Computer Use/);
  assert.match(skill, /persist submit intent/i);
  assert.match(skill, /Click the final submit control exactly once/);
  assert.match(skill, /Never move a row between business stores/);
  assert.match(skill, /CAPTCHA/);
  assert.match(protocol, /select[\s\S]+plan-claim[\s\S]+confirm-claim/);
  assert.match(protocol, /plan-submit-intent[\s\S]+confirm-submit-intent[\s\S]+commit-result/);
  assert.match(protocol, /no item\/day\/date cap/);
  assert.match(boundary, /same-origin\s+POST forms/);
  assert.match(boundary, /Never persist raw DOM/);
  assert.match(metadata, /allow_implicit_invocation: false/);
});

test("job-autopilot fixture replay covers normal, blocked, and ambiguous states", async () => {
  const fixtureRoot = new URL("./fixtures/onlinejobs/", import.meta.url);
  const replay = JSON.parse(await readFile(new URL("replay.json", fixtureRoot)));
  const files = new Set(await readdir(fixtureRoot));
  assert.equal(replay.cases.length, 12);
  for (const entry of replay.cases) assert.ok(files.has(entry.fixture));
  assert.deepEqual(
    [...new Set(replay.cases.map((entry) => entry.expected))].sort(),
    ["ambiguous", "blocked", "confirmed", "fillable", "unavailable"]
  );
  const combined = (
    await Promise.all(
      replay.cases.map((entry) => readFile(new URL(entry.fixture, fixtureRoot), "utf8"))
    )
  ).join("\n");
  assert.doesNotMatch(combined, /(?:api[-_ ]?key|bearer\s+[a-z0-9]|session_cookie|johnlesterescarlan)/i);
});
