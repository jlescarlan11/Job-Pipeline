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

test("Generator freezes context eagerly while Alerter loads it lazily without embedded personal facts", () => {
  const generator = workflows["generator.json"];
  assert.equal(
    generator.connections["Schedule Trigger"].main[0][0].node,
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
    const read = node(generator, `Get ${name} Context`);
    assert.equal(read.parameters.sheetName.value, name);
    assert.equal(
      read.parameters.documentId.value,
      "={{ $env.JOB_PIPELINE_CONFIG_SPREADSHEET_ID }}"
    );
  }
  node(generator, "Compile Candidate Context");

  const alerter = workflows["alerter-mover.json"];
  assert.equal(
    alerter.connections["Schedule Trigger"].main[0][0].node,
    "Capture Alerter Execution Start"
  );
  assert.equal(
    alerter.connections["Capture Alerter Execution Start"].main[0][0].node,
    "Get Business Snapshot"
  );
  const contextRead = node(alerter, "Get Alert Configuration Snapshot");
  assert.match(contextRead.parameters.url, /JOB_PIPELINE_CONFIG_SPREADSHEET_ID/);
  assert.equal(
    alerter.connections["Has Potential Alert Work"].main[0][0].node,
    "Get Alert Configuration Snapshot"
  );
  assert.equal(
    alerter.connections["Has Potential Alert Work"].main[1][0].node,
    "Summarize Alerter & Mover Run"
  );
  node(alerter, "Compile Alert Configuration");

  for (const workflow of [generator, alerter]) {
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
  assert.match(repairBody, /repair_system_message/);
  assert.doesNotMatch(repairBody, /content: \$json\.system_message/);
  for (const name of ["Validate Initial Draft", "Validate Repaired Draft"]) {
    const validationCode = node(workflow, name).parameters.jsCode;
    assert.match(validationCode, /error\?\.status/);
    assert.match(validationCode, /externalResultErrorMessage/);
  }
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
    "Get Business Snapshot",
    "Normalize Business Snapshot",
    "Plan Independent Moves",
    "Has Eligible Work",
    "Has Movement Work",
    "Append Movement Claims",
    "Keep Winning Movement Claims",
    "Upsert Scraped Jobs",
    "Upsert To Review",
    "Upsert To Apply",
    "Upsert Applied Jobs",
    "Upsert Archive",
    "Get Main Workbook Layout",
    "Prepare Latest-First Sort",
    "Sort Business Sheets Latest First",
    "Get Touched Business Stores After Copies",
    "Normalize Touched Business Snapshot",
    "Confirm Destination Copies",
    "Delete Confirmed Scraped Jobs Rows",
    "Delete Confirmed To Review Rows",
    "Delete Confirmed To Apply Rows",
    "Prepare Post-Movement Alert Snapshot",
    "Needs Fresh To Apply Snapshot",
    "Get Fresh To Apply Snapshot",
    "Use Initial To Apply Snapshot",
    "Preselect Persisted Alert Work",
    "Has Potential Alert Work",
    "Get Alert Configuration Snapshot",
    "Compile Alert Configuration",
    "Select Fresh Alerts",
    "Append Alert Claims",
    "Keep Winning Alert Claims",
    "Evaluate Provider Commit Headroom",
    "Get Alert Receipt Authorization Snapshot",
    "Authorize Pending Alert Receipts",
    "Upsert New Pending Receipts",
    "Verify Pending Alert Receipts",
    "CAS Sending Alert Receipts",
    "Verify Sending Alert Receipts",
    "Persist Alert Sending States",
    "Get To Apply After Alert Claims",
    "Confirm and Render Alerts",
    "Recheck Provider Commit Headroom",
    "Send Slack Alert",
    "CAS Provider Receipt Outcomes",
    "Verify Provider Receipt Outcomes",
    "CAS Provider Ambiguity Fallbacks",
    "Get Alert Owners After Provider",
    "Plan Provider Business Reconciliation",
    "Persist Provider To Apply Updates",
    "Persist Provider Applied Updates",
    "Persist Provider Archive Updates",
    "Get Provider Business Confirmation",
    "CAS Provider Delivered Reconciliation",
    "Finalize Alert Delivery Results",
    "Get Receipt Recovery Snapshot",
    "Plan Expired Sending Receipts",
    "Plan Receipt Business Recovery",
    "Get Recovery Business Confirmation",
    "CAS Delivered Receipt Reconciliation",
    "Finalize Receipt Recovery"
  ]) {
    node(workflow, name);
  }
  assert.match(code, /planQueueActions/);
  assert.match(code, /confirmMoveDeletions/);
  assert.match(code, /selectFreshAlertCandidates/);
  assert.match(code, /renderSlackAlert/);
  assert.match(code, /createPendingAlertReceipt/);
  assert.match(code, /applyProviderResultToAlertReceipt/);
  assert.match(code, /planAlertReceiptBusinessReconciliation/);
  assert.match(code, /selectWinningSystemClaims/);
  assert.equal(workflow.meta.movementBeforeAlertSelection, true);
  assert.equal(workflow.meta.appendWinnerClaims, true);
  assert.deepEqual(workflow.meta.latestFirstBusinessSheets, {
    "Scraped Jobs": "discovered_at",
    "To Review": "evaluated_at",
    "To Apply": "generated_at",
    "Applied Jobs": "applied_at",
    Archive: "archived_at"
  });
  const metadataRead = node(workflow, "Get Main Workbook Layout");
  const latestFirstSort = node(workflow, "Sort Business Sheets Latest First");
  for (const entry of [metadataRead, latestFirstSort]) {
    assert.equal(entry.parameters.authentication, "predefinedCredentialType");
    assert.equal(entry.parameters.nodeCredentialType, "googleSheetsOAuth2Api");
    assert.equal(entry.onError, undefined);
  }
  assert.equal(latestFirstSort.parameters.method, "POST");
  assert.match(latestFirstSort.parameters.url, /:batchUpdate$/);
  assert.match(
    node(workflow, "Prepare Latest-First Sort").parameters.jsCode,
    /latestFirstSortRequests/
  );
  assert.equal(
    workflow.connections["Aggregate Archive Writes"].main[0][0].node,
    "Get Main Workbook Layout"
  );
  assert.equal(
    workflow.connections["Sort Business Sheets Latest First"].main[0][0].node,
    "Get Touched Business Stores After Copies"
  );
  assert.equal(
    workflow.connections["Aggregate To Apply Deletion Attempts"].main[0][0].node,
    "Prepare Post-Movement Alert Snapshot"
  );
  assert.equal(
    workflow.connections["Use Initial To Apply Snapshot"].main[0][0].node,
    "Preselect Persisted Alert Work"
  );
  assert.equal(
    workflow.connections["Has Eligible Work"].main[1][0].node,
    "Summarize Alerter & Mover Run"
  );
  assert.equal(
    workflow.connections["Has Movement Work"].main[1][0].node,
    "Use Initial To Apply Snapshot"
  );
  assert.match(
    node(workflow, "Get Business Snapshot").parameters.url,
    /values:batchGet/
  );
  assert.match(
    node(workflow, "Get Business Snapshot").parameters.url,
    /Scraped%20Jobs.*To%20Review.*To%20Apply.*Applied%20Jobs.*Archive/
  );
  assert.match(
    node(workflow, "Normalize Business Snapshot").parameters.jsCode,
    /sheet_read_request_count:\s*1/
  );
  assert.match(
    node(workflow, "Prepare Latest-First Sort").parameters.jsCode,
    /touched_sheets/
  );
  assert.deepEqual(workflow.meta.googleSheetsReadRequestBudgets, {
    idle: 2,
    movementOnly: 6,
    fullAlert: 10
  });
  assert.equal(workflow.meta.consolidatedBusinessSnapshot, true);
  assert.equal(workflow.meta.lazyConfigurationSnapshot, true);
  assert.equal(workflow.meta.touchedSheetConfirmationOnly, true);
  assert.equal(workflow.meta.durableReceiptBeforeProvider, true);
  assert.equal(workflow.meta.recoverProviderOutcomesBeforeSelection, true);
  assert.equal(workflow.meta.terminalizeAmbiguousProviderOutcomes, true);
  assert.equal(
    workflow.meta.alertReceiptStoreEnvironmentVariable,
    "JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID"
  );
  const idleReadNodes = ["Get Business Snapshot"];
  const maximumMovementOnlyReadNodes = [
    "Get Business Snapshot",
    "Get System Claims",
    "Get Main Workbook Layout",
    "Get Touched Business Stores After Copies",
    "Get Fresh To Apply Snapshot"
  ];
  assert.ok(idleReadNodes.length <= workflow.meta.googleSheetsReadRequestBudgets.idle);
  assert.ok(
    maximumMovementOnlyReadNodes.length <=
      workflow.meta.googleSheetsReadRequestBudgets.movementOnly
  );
  for (const readName of maximumMovementOnlyReadNodes) node(workflow, readName);
  for (const excluded of [
    "Get System Claims",
    "Get Main Workbook Layout",
    "Sort Business Sheets Latest First",
    "Get Touched Business Stores After Copies",
    "Get Alert Configuration Snapshot",
    "Send Slack Alert"
  ]) {
    assert.notEqual(
      workflow.connections["Has Eligible Work"].main[1][0].node,
      excluded,
      `idle branch must bypass ${excluded}`
    );
  }
  assert.match(
    node(workflow, "Send Slack Alert").parameters.url,
    /JOB_PIPELINE_SLACK_WEBHOOK_URL/
  );
  for (const updateName of [
    "Persist Alert Sending States",
    "Persist Provider To Apply Updates",
    "Persist Provider Applied Updates",
    "Persist Provider Archive Updates"
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
    false
  );
  assert.match(
    node(workflow, "Stage Slack Result").parameters.jsCode,
    /String\(\$json\?\.data \|\| ''\)\.trim\(\) === 'ok'/
  );

  for (const retired of [
    "Aggregate Slack Results",
    "Get To Apply Before Alert Commit",
    "Guard and Commit Slack Results",
    "Update Alert Results"
  ]) {
    assert.equal(
      workflow.nodes.some((entry) => entry.name === retired),
      false,
      retired
    );
  }

  const receiptNodes = workflow.nodes.filter(
    (entry) => entry.type === "n8n-nodes-base.dataTable"
  );
  assert.ok(receiptNodes.length >= 10);
  for (const receiptNode of receiptNodes) {
    assert.equal(receiptNode.typeVersion, 1.1, receiptNode.name);
    assert.equal(
      receiptNode.parameters.dataTableId.value,
      "={{ $env.JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID }}",
      receiptNode.name
    );
    assert.equal(receiptNode.onError, "continueRegularOutput", receiptNode.name);
  }
  for (const name of [
    "CAS Expired Sending Receipts",
    "CAS Retry Pending Receipts",
    "CAS Sending Alert Receipts",
    "CAS Provider Receipt Outcomes",
    "CAS Provider Ambiguity Fallbacks",
    "CAS Delivered Receipt Reconciliation",
    "CAS Provider Delivered Reconciliation"
  ]) {
    assert.deepEqual(
      node(workflow, name).parameters.filters.conditions.map((entry) => entry.keyName),
      ["receipt_id", "receipt_version"],
      name
    );
  }

  const predecessor = new Map();
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    for (const branch of outputs.main || []) {
      for (const destination of branch) {
        const entries = predecessor.get(destination.node) || [];
        entries.push(source);
        predecessor.set(destination.node, entries);
      }
    }
  }
  const ancestors = new Set();
  const queue = [...(predecessor.get("Send Slack Alert") || [])];
  while (queue.length) {
    const current = queue.shift();
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    queue.push(...(predecessor.get(current) || []));
  }
  for (const required of [
    "Verify Pending Alert Receipts",
    "Verify Sending Alert Receipts",
    "Persist Alert Sending States",
    "Get To Apply After Alert Claims",
    "Confirm and Render Alerts",
    "Recheck Provider Commit Headroom"
  ]) {
    assert.ok(ancestors.has(required), required);
  }

  const alerterReadNames = [
    "Get Business Snapshot",
    "Get Recovery Business Confirmation",
    "Get System Claims",
    "Get Main Workbook Layout",
    "Get Touched Business Stores After Copies",
    "Get Fresh To Apply Snapshot",
    "Get Alert Configuration Snapshot",
    "Get Alert System Claims",
    "Get To Apply After Alert Claims",
    "Get Alert Owners After Provider",
    "Get Provider Business Confirmation"
  ];
  for (const name of alerterReadNames) {
    const read = node(workflow, name);
    assert.equal(read.retryOnFail, undefined, name);
    assert.equal(read.maxTries, undefined, name);
    assert.equal(read.waitBetweenTries, undefined, name);
  }
  assert.equal(
    node(workflow, "Get Business Snapshot").onError,
    "continueRegularOutput"
  );
  const quotaWait = node(workflow, "Wait for Sheets Quota Window");
  assert.equal(quotaWait.type, "n8n-nodes-base.wait");
  assert.equal(quotaWait.parameters.amount, 65);
  assert.equal(quotaWait.parameters.unit, "seconds");
  const quotaRetry = node(workflow, "Retry Business Snapshot");
  assert.equal(quotaRetry.retryOnFail, undefined);
  assert.equal(
    workflow.connections["Schedule Trigger"].main[0][0].node,
    "Capture Alerter Execution Start"
  );
  assert.equal(
    workflow.connections["Capture Alerter Execution Start"].main[0][0].node,
    "Get Business Snapshot"
  );
  assert.match(
    node(workflow, "Normalize Business Snapshot").parameters.jsCode,
    /Capture Alerter Execution Start/
  );
  assert.equal(
    workflow.connections["Business Snapshot Quota Limited"].main[0][0].node,
    "Wait for Sheets Quota Window"
  );
  const fullMovementAndAlertReads = alerterReadNames.filter(
    (name) => name !== "Get Recovery Business Confirmation"
  );
  assert.equal(fullMovementAndAlertReads.length, 10);
  const recoveryAndMovementReads = [
    "Get Business Snapshot",
    "Get Recovery Business Confirmation",
    "Get System Claims",
    "Get Main Workbook Layout",
    "Get Touched Business Stores After Copies",
    "Get Fresh To Apply Snapshot"
  ];
  assert.equal(recoveryAndMovementReads.length, 6);
  assert.match(
    node(workflow, "Preselect Persisted Alert Work").parameters.jsCode,
    /skip_new_alerts/
  );
  assert.ok(workflow.meta.googleSheetsReadRetry.quota_window_delay_ms >= 60_000);
  assert.ok(workflow.meta.minimumProviderCommitHeadroomMs >= 120_000);
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
