import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("../workflows/", import.meta.url);
const files = (await readdir(workflowsDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();
const workflows = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      JSON.parse(await readFile(new URL(file, workflowsDirectory), "utf8"))
    ])
  )
);

function node(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, `${workflow.name} missing ${name}`);
  return found;
}

function allCode(workflow) {
  return workflow.nodes
    .filter((entry) => entry.type === "n8n-nodes-base.code")
    .map((entry) => entry.parameters.jsCode)
    .join("\n");
}

test("build emits exactly the three inactive replacement roles", () => {
  assert.deepEqual(files, [
    "alerter-mover.json",
    "generator.json",
    "scraper.json"
  ]);
  assert.deepEqual(
    Object.values(workflows)
      .map((workflow) => workflow.meta.workflowRole)
      .sort(),
    ["alerter_mover", "evaluator_generator", "scraper"]
  );
  for (const workflow of Object.values(workflows)) {
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.timezone, "Asia/Manila");
    assert.equal(workflow.settings.saveDataSuccessExecution, "none");
    assert.equal(workflow.settings.saveDataErrorExecution, "all");
    assert.equal(workflow.settings.saveExecutionProgress, false);
    assert.equal(workflow.settings.saveManualExecutions, true);
    assert.equal(
      workflow.settings.executionTimeout,
      workflow.meta.executionTimeoutSeconds
    );
  }
  assert.deepEqual(workflows["scraper.json"].meta.authoritativeBusinessSheets, [
    "Scraped Jobs",
    "To Review",
    "To Apply",
    "Applied Jobs",
    "Archive"
  ]);
  assert.equal(workflows["scraper.json"].meta.discoveryWriteSheet, "Scraped Jobs");
  assert.equal(workflows["generator.json"].meta.processingSourceSheet, "Scraped Jobs");
  assert.deepEqual(workflows["alerter-mover.json"].meta.sourceSheets, [
    "Scraped Jobs",
    "To Review",
    "To Apply"
  ]);
  assert.equal(workflows["alerter-mover.json"].meta.alertSourceSheet, "To Apply");
  assert.doesNotMatch(JSON.stringify(workflows), /Review Queue/);
});

test("all generated Code nodes are syntactically valid", () => {
  for (const workflow of Object.values(workflows)) {
    for (const entry of workflow.nodes.filter(
      (candidate) => candidate.type === "n8n-nodes-base.code"
    )) {
      assert.doesNotThrow(
        () => new Function(entry.parameters.jsCode),
        `${workflow.name}/${entry.name}`
      );
      assert.doesNotMatch(
        entry.parameters.jsCode,
        /\bstructuredClone\b/,
        `${workflow.name}/${entry.name} uses an unsupported n8n sandbox global`
      );
    }
  }
});

test("profile helpers are bundled wherever evaluation code uses them", () => {
  for (const workflow of Object.values(workflows)) {
    for (const entry of workflow.nodes.filter(
      (candidate) =>
        candidate.type === "n8n-nodes-base.code" &&
        candidate.parameters.jsCode.includes("knownSkillsInText")
    )) {
      assert.match(
        entry.parameters.jsCode,
        /function approvedSkillNames\(profile\)/,
        `${workflow.name}/${entry.name} missing approvedSkillNames`
      );
      assert.match(
        entry.parameters.jsCode,
        /function profileEvidenceText\(profile\)/,
        `${workflow.name}/${entry.name} missing profileEvidenceText`
      );
    }
  }
});

test("Generator and Alerter freeze Sheet context without embedded personal facts", () => {
  for (const file of ["generator.json", "alerter-mover.json"]) {
    const workflow = workflows[file];
    assert.equal(
      workflow.connections["Schedule Trigger"].main[0][0].node,
      "Get Candidate Context"
    );
    for (const name of [
      "Candidate",
      "Skills",
      "Experience",
      "Projects",
      "Education",
      "Awards",
      "Job Preferences",
      "Application Settings",
      "Required Style",
      "Banned Phrases"
    ]) {
      const read = node(workflow, `Get ${name} Context`);
      assert.equal(read.parameters.sheetName.value, name);
      assert.equal(
        read.parameters.documentId.value,
        "={{ $env.JOB_PIPELINE_CONFIG_SPREADSHEET_ID }}"
      );
    }
    node(workflow, "Compile Candidate Context");
    const serialized = JSON.stringify(workflow);
    for (const personalFact of [
      "John Lester Escarlan",
      "johnlesterescarlan",
      "jlescarlan11@gmail.com",
      "Pharmacy & Acute Care University",
      "FireCheck",
      "PriceCraft"
    ]) {
      assert.doesNotMatch(serialized, new RegExp(personalFact));
    }
  }
});

test("Groq requests disable compressed streaming responses", () => {
  const workflow = workflows["generator.json"];
  for (const name of [
    "Generate Initial Application with Groq",
    "Generate Application Repair with Groq"
  ]) {
    const parameters = node(workflow, name).parameters;
    const headers = parameters.headerParameters?.parameters ?? [];
    assert.ok(
      headers.some(
        (header) =>
          header.name === "Accept-Encoding" && header.value === "identity"
      ),
      `${workflow.name}/${name} must request an identity response`
    );
    assert.equal(parameters.specifyBody, "json");
    assert.match(parameters.jsonBody, /JSON\.stringify/);
    assert.equal("body" in parameters, false);
    assert.equal("rawContentType" in parameters, false);
  }
});

test("workflows bind queue and configuration workbooks by environment, never the old workbook", () => {
  const serialized = JSON.stringify(workflows);
  assert.match(serialized, /JOB_PIPELINE_SPREADSHEET_ID/);
  assert.match(serialized, /JOB_PIPELINE_CONFIG_SPREADSHEET_ID/);
  assert.doesNotMatch(serialized, /1ORq6ImOOJ1a0ZLoH8a2PlKHWX5jmQyBu4fRlGQWFkRE/);
  for (const workflow of Object.values(workflows)) {
    for (const sheetNode of workflow.nodes.filter(
      (entry) => entry.type === "n8n-nodes-base.googleSheets"
    )) {
      const isConfigurationRead =
        sheetNode.name === "Get Search Keywords" ||
        /^Get (Candidate|Skills|Experience|Projects|Education|Awards|Job Preferences|Application Settings|Required Style|Banned Phrases) Context$/.test(
          sheetNode.name
        );
      assert.equal(
        sheetNode.parameters.documentId.value,
        isConfigurationRead
          ? "={{ $env.JOB_PIPELINE_CONFIG_SPREADSHEET_ID }}"
          : "={{ $env.JOB_PIPELINE_SPREADSHEET_ID }}",
        `${workflow.name}/${sheetNode.name} has the wrong workbook binding`
      );
    }
  }
  for (const legacy of [
    '"Sheet1"',
    '"Dashboard"',
    '"Analytics"',
    '"AnalyticsReports"',
    '"Recommendations"',
    '"RecommendationReports"',
    '"ProcessingClaims"'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(legacy));
  }
});

test("Scraper owns one fixed inclusive 24-hour keyword window and five-store reconciliation", () => {
  const workflow = workflows["scraper.json"];
  const code = allCode(workflow);
  const keywordRead = node(workflow, "Get Search Keywords");
  assert.equal(keywordRead.parameters.sheetName.value, "Search Keywords");
  assert.equal(
    keywordRead.parameters.documentId.value,
    "={{ $env.JOB_PIPELINE_CONFIG_SPREADSHEET_ID }}"
  );
  assert.equal(keywordRead.alwaysOutputData, true);
  assert.equal(keywordRead.onError, "continueRegularOutput");
  assert.equal(
    workflow.connections["Schedule Trigger"].main[0][0].node,
    "Get Search Keywords"
  );
  assert.equal(
    workflow.connections["Get Search Keywords"].main[0][0].node,
    "Capture Fixed Window and Keywords"
  );
  assert.match(code, /createDiscoveryWindow/);
  assert.match(code, /createKeywordSnapshot/);
  assert.match(
    node(workflow, "Capture Fixed Window and Keywords").parameters.jsCode,
    /\$input\.all\(\)/
  );
  assert.match(code, /no_enabled_keywords/);
  assert.match(code, /duplicate_enabled_keyword/);
  assert.match(code, /window_start/);
  assert.match(code, /window_end/);
  assert.match(code, /window_hours:\s*24|windowHours/);
  assert.match(code, /future_dated/);
  assert.match(code, /outside_window_old/);
  assert.match(code, /missing_posted_at/);
  assert.match(code, /max_pages_per_keyword/);
  assert.doesNotMatch(
    node(workflow, "Capture Fixed Window and Keywords").parameters.jsCode,
    /"evidence_refs"\s*:|"role_family"\s*:|"lookback_days"\s*:|"queries"\s*:/
  );
  for (const seed of [
    "full stack developer",
    "web developer",
    "react developer",
    "nextjs developer",
    "nodejs developer",
    "backend developer",
    "flutter developer",
    "n8n developer",
    "automation developer",
    "application support engineer"
  ]) {
    assert.doesNotMatch(
      JSON.stringify(workflow),
      new RegExp(seed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `Scraper must not embed seed keyword: ${seed}`
    );
  }
  assert.equal(workflow.meta.runtimeKeywordSource, "Search Keywords");
  for (const name of [
    "Get Scraped Jobs",
    "Get To Review",
    "Get To Apply",
    "Get Applied Jobs",
    "Get Archive",
    "Append New Scraped Jobs Rows",
    "Update Scraped Jobs Seen",
    "Update To Review Seen",
    "Update To Apply Seen"
  ]) {
    node(workflow, name);
  }
  assert.equal(
    node(workflow, "Append New Scraped Jobs Rows").parameters.sheetName.value,
    "Scraped Jobs"
  );
  for (const updateName of [
    "Update Scraped Jobs Seen",
    "Update To Review Seen",
    "Update To Apply Seen"
  ]) {
    const seenUpdate = node(workflow, updateName);
    assert.deepEqual(seenUpdate.parameters.columns.matchingColumns, [
      "canonical_job_id"
    ]);
    assert.equal("pipeline_status" in seenUpdate.parameters.columns.value, false);
    assert.equal("user_action" in seenUpdate.parameters.columns.value, false);
    assert.equal("notes" in seenUpdate.parameters.columns.value, false);
  }
  node(workflow, "Append Discovery Claims");
  node(workflow, "Keep Winning Discovery Claims");
  node(workflow, "Select Expired Discovery Claims");
  node(workflow, "Delete Expired Discovery Claims");
  assert.match(
    node(workflow, "Keep Winning Discovery Claims").parameters.jsCode,
    /Emit Discovery Claims/
  );
});

test("Evaluator & Generator persists claims and gates readiness after pack and message validation", () => {
  const workflow = workflows["generator.json"];
  const code = allCode(workflow);
  for (const symbol of [
    "selectGeneratorCandidate",
    "claimGeneratorRecord",
    "confirmGeneratorClaimPersisted",
    "createSystemClaim",
    "selectWinningSystemClaims",
    "evaluateAndRoute",
    "prepareApplicationGeneration",
    "applyValidatedGeneration",
    "assessInitialGenerationDraft",
    "commitGeneratorResult",
    "confirmGeneratorResultPersisted",
    "recordGeneratorFailure"
  ]) {
    assert.match(code, new RegExp(symbol));
  }
  node(workflow, "Persist Generator Claim");
  node(workflow, "Append Generator System Claim");
  node(workflow, "Confirm Generator System Claim");
  node(workflow, "Get Scraped Jobs Before Candidate Claim");
  node(workflow, "Aggregate Scraped Jobs Before Candidate Claim");
  node(workflow, "Confirm Generator Claim Persisted");
  node(workflow, "Get Scraped Jobs Before Commit");
  node(workflow, "Guard and Commit Generator Result");
  node(workflow, "Get Scraped Jobs After Commit");
  node(workflow, "Confirm Generator Result Persisted");
  node(workflow, "Needs One Repair");
  node(workflow, "Wait Before Repair");
  assert.equal(workflow.meta.manualSubmissionOnly, true);
  assert.equal(
    node(workflow, "Generate Initial Application with Groq").parameters.url,
    "https://api.groq.com/openai/v1/chat/completions"
  );
  assert.match(
    JSON.stringify(node(workflow, "Generate Initial Application with Groq")),
    /JOB_PIPELINE_GROQ_API_KEY/
  );
  assert.equal(
    node(workflow, "Generate Initial Application with Groq").maxTries,
    undefined
  );
  assert.equal(
    node(workflow, "Generate Application Repair with Groq").maxTries,
    undefined
  );
  assert.equal(workflow.meta.maximumModelRequestsPerItem, 2);
  assert.equal(workflow.meta.maximumItemsPerExecution, 5);
  assert.equal(workflow.meta.sequentialBatchSize, 1);
  assert.equal(workflow.meta.candidatePacingDelayMs, 20000);
  assert.equal(workflow.meta.initialModel, "openai/gpt-oss-120b");
  assert.equal(workflow.meta.repairModel, "openai/gpt-oss-20b");
  assert.equal(workflow.meta.boundedRepairEnabled, true);
  assert.equal(node(workflow, "Fetch Job Detail").maxTries, 3);
  const claimUpdate = node(workflow, "Persist Generator Claim");
  assert.deepEqual(claimUpdate.parameters.columns.matchingColumns, [
    "canonical_job_id"
  ]);
  assert.equal("user_action" in claimUpdate.parameters.columns.value, false);
  assert.equal("notes" in claimUpdate.parameters.columns.value, false);

  const resultUpdate = node(workflow, "Update Scraped Jobs Result");
  assert.deepEqual(resultUpdate.parameters.columns.matchingColumns, [
    "canonical_job_id"
  ]);
  assert.equal("user_action" in resultUpdate.parameters.columns.value, true);
  assert.equal("notes" in resultUpdate.parameters.columns.value, false);
});

test("Evaluator & Generator loops over a fixed batch sequentially without cross-item first references", () => {
  const workflow = workflows["generator.json"];
  const loop = node(workflow, "Process Candidates Sequentially");
  assert.equal(loop.type, "n8n-nodes-base.splitInBatches");
  assert.equal(loop.typeVersion, 3);
  assert.equal(loop.parameters.batchSize, 1);
  assert.equal(
    workflow.connections["Select Generator Candidates"].main[0][0].node,
    loop.name
  );
  assert.equal(
    workflow.connections[loop.name].main[0][0].node,
    "Summarize Generator Run"
  );
  assert.equal(
    workflow.connections[loop.name].main[1][0].node,
    "Create Generator System Claim"
  );
  const candidatePacing = node(workflow, "Wait After Generator Candidate");
  assert.equal(candidatePacing.type, "n8n-nodes-base.wait");
  assert.equal(candidatePacing.parameters.amount, 20);
  assert.equal(candidatePacing.parameters.unit, "seconds");
  assert.equal(
    workflow.connections["Finalize Candidate"].main[0][0].node,
    candidatePacing.name
  );
  assert.equal(
    workflow.connections[candidatePacing.name].main[0][0].node,
    loop.name
  );
  assert.equal(
    [
      ...node(
        workflow,
        "Select Generator Candidates"
      ).parameters.jsCode.matchAll(/claimGeneratorRecord\(/g)
    ].length,
    1,
    "selection may bundle the helper definition but must not invoke it"
  );
  assert.equal(
    workflow.connections["Confirm Generator System Claim"].main[0][0].node,
    "Generator System Claim Won"
  );
  assert.equal(
    workflow.connections["Generator System Claim Won"].main[0][0].node,
    "Get Scraped Jobs Before Candidate Claim"
  );
  assert.equal(
    workflow.connections["Aggregate Scraped Jobs Before Candidate Claim"]
      .main[0][0].node,
    "Claim Current Candidate"
  );
  assert.match(
    node(workflow, "Claim Current Candidate").parameters.jsCode,
    /Scraped Jobs identity is missing or ambiguous/
  );
  assert.match(
    node(workflow, "Claim Current Candidate").parameters.jsCode,
    /no longer eligible in the frozen stage/
  );
  assert.equal(
    workflow.connections["Confirm Generator Claim Persisted"].main[0][0].node,
    "Scraped Jobs Claim Verified"
  );
  for (const entry of workflow.nodes.filter(
    (candidate) => candidate.type === "n8n-nodes-base.code"
  )) {
    assert.doesNotMatch(
      entry.parameters.jsCode,
      /\$\('[^']+'\)\.first\(\)/,
      `${entry.name} must use current-item linkage instead of .first()`
    );
    if (entry.parameters.mode === "runOnceForEachItem") {
      assert.doesNotMatch(
        entry.parameters.jsCode,
        /\$input\.first\(\)/,
        `${entry.name} must use $json in per-item mode instead of $input.first()`
      );
    }
  }
  assert.match(
    node(workflow, "Claim Current Candidate").parameters.jsCode,
    /\(\$json\.fresh_rows \|\| \[\]\)/
  );
  const initialBody = node(
    workflow,
    "Generate Initial Application with Groq"
  ).parameters.jsonBody;
  const repairBody = node(
    workflow,
    "Generate Application Repair with Groq"
  ).parameters.jsonBody;
  assert.match(initialBody, /openai\/gpt-oss-120b/);
  assert.doesNotMatch(initialBody, /openai\/gpt-oss-20b/);
  assert.match(repairBody, /openai\/gpt-oss-20b/);
  assert.doesNotMatch(repairBody, /openai\/gpt-oss-120b/);
  assert.equal(
    workflow.connections["Provider Required"].main[0][0].node,
    "Needs Provider Pacing Delay"
  );
  assert.equal(
    workflow.connections["Needs One Repair"].main[0][0].node,
    "Wait Before Repair"
  );
  assert.equal(
    [
      ...allCode(workflow).matchAll(/event:\s*'generator_result'/g)
    ].length,
    1,
    "every attempted candidate must emit exactly one sanitized result event"
  );
});

test("Alerter & Mover routes focused queues independently of Slack and confirms before delete", () => {
  const workflow = workflows["alerter-mover.json"];
  const code = allCode(workflow);
  assert.equal(workflow.meta.movementIndependentOfSlack, true);
  for (const name of [
    "Plan Independent Moves",
    "Append Movement Claims",
    "Keep Winning Movement Claims",
    "Upsert Scraped Jobs",
    "Upsert To Review",
    "Upsert To Apply",
    "Upsert Applied Jobs",
    "Upsert Archive",
    "Get Scraped Jobs After Copies",
    "Get To Review After Copies",
    "Get To Apply After Copies",
    "Get Applied Jobs After Copies",
    "Get Archive After Copies",
    "Confirm Destination Copies",
    "Delete Confirmed Scraped Jobs Rows",
    "Delete Confirmed To Review Rows",
    "Delete Confirmed To Apply Rows",
    "Get To Apply After Moves",
    "Select Fresh Alerts",
    "Append Alert Claims",
    "Keep Winning Alert Claims",
    "Persist Alert Sending States",
    "Get To Apply After Alert Claims",
    "Confirm and Render Alerts",
    "Send Slack Alert",
    "Get To Apply Before Alert Commit",
    "Guard and Commit Slack Results"
  ]) {
    node(workflow, name);
  }
  assert.match(code, /planQueueActions/);
  assert.match(code, /confirmMoveDeletions/);
  assert.match(code, /selectFreshAlertCandidates/);
  assert.match(code, /renderSlackAlert/);
  assert.match(code, /applySlackProviderResult/);
  assert.match(code, /selectWinningSystemClaims/);
  assert.equal(workflow.meta.movementBeforeAlertSelection, true);
  assert.equal(workflow.meta.appendWinnerClaims, true);
  assert.equal(
    workflow.connections["Aggregate To Apply Deletion Attempts"].main[0][0].node,
    "Get To Apply After Moves"
  );
  assert.equal(
    workflow.connections["Aggregate To Apply After Moves"].main[0][0].node,
    "Select Fresh Alerts"
  );
  assert.match(
    node(workflow, "Send Slack Alert").parameters.url,
    /JOB_PIPELINE_SLACK_WEBHOOK_URL/
  );
  for (const updateName of [
    "Persist Alert Sending States",
    "Update Alert Results"
  ]) {
    const update = node(workflow, updateName);
    assert.deepEqual(update.parameters.columns.matchingColumns, [
      "canonical_job_id"
    ]);
    assert.equal("user_action" in update.parameters.columns.value, false);
    assert.equal("notes" in update.parameters.columns.value, false);
  }
  const slack = node(workflow, "Send Slack Alert");
  assert.equal(
    slack.parameters.options.response.response.responseFormat,
    "text"
  );
  assert.equal(
    slack.parameters.options.response.response.fullResponse,
    true
  );
});

test("network calls and critical Sheet writes remain bounded and fail closed", () => {
  for (const workflow of Object.values(workflows)) {
    for (const entry of workflow.nodes) {
      if (entry.type === "n8n-nodes-base.httpRequest") {
        assert.ok(entry.parameters.options.timeout > 0, entry.name);
        if (entry.retryOnFail) {
          assert.ok(entry.maxTries > 0, entry.name);
          assert.ok(entry.waitBetweenTries > 0, entry.name);
        }
      }
      if (
        entry.type === "n8n-nodes-base.googleSheets" &&
        ["append", "appendOrUpdate", "update", "delete"].includes(
          entry.parameters.operation
        )
      ) {
        assert.equal(entry.retryOnFail, undefined, entry.name);
        if (
          ["alerter_mover", "evaluator_generator"].includes(
            workflow.meta.workflowRole
          )
        ) {
          assert.equal(
            entry.onError,
            "continueRegularOutput",
            entry.name
          );
        } else {
          assert.equal(entry.onError, undefined, entry.name);
        }
        assert.equal(entry.continueOnFail, undefined, entry.name);
      }
    }
  }
});

test("no workflow automates OnlineJobs application or spends Apply Points", () => {
  const serialized = JSON.stringify(workflows).toLowerCase();
  assert.doesNotMatch(
    serialized,
    /onlinejobs\.ph\/(?:apply|jobseekers\/apply)|submitapplication|mark_applied|apply_points_used/
  );
  assert.match(serialized, /manualsubmissiononly/);
});
