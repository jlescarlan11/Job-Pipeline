import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureWorkflowCutoverEvidence,
  classifyWorkflowForCutover,
  googleCredentialNodeNames,
  validateWorkflowCutoverEvidence,
  validateWorkflowCutoverPolicy,
  workflowDeploymentDigest
} from "../src/workflow-cutover.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const policy = await loadJson("../config/n8n-deployment-policy.json");
const [scraperWorkflow, alerterWorkflow] = await Promise.all(
  ["scraper", "alerter-mover"].map((name) =>
    loadJson(`../workflows/${name}.json`)
  )
);
const legacyGeneratorRole = policy.workflow_cutover.roles.find(
  (entry) => entry.role === "evaluator_generator"
);
const legacyGeneratorWorkflow = {
  name: legacyGeneratorRole.name_markers.join(" — "),
  active: false,
  settings: {
    timezone: legacyGeneratorRole.timezone,
    executionTimeout: legacyGeneratorRole.execution_timeout_seconds
  },
  nodes: [
    {
      name: "Schedule Trigger",
      type: "n8n-nodes-base.scheduleTrigger",
      parameters: {
        rule: {
          interval: legacyGeneratorRole.schedule_expressions.map(
            (expression) => ({ field: "cronExpression", expression })
          )
        }
      }
    },
    ...Array.from(
      { length: legacyGeneratorRole.google_credential_node_count },
      (_, index) => ({
        name:
          legacyGeneratorRole.required_node_names[index] ??
          `Legacy Generator Google Node ${index + 1}`,
        type: "n8n-nodes-base.googleSheets",
        parameters: {
          documentId:
            index % 2 === 0
              ? "={{ $env.JOB_PIPELINE_SPREADSHEET_ID }}"
              : "={{ $env.JOB_PIPELINE_CONFIG_SPREADSHEET_ID }}",
          sheetName: index % 2 === 0 ? "Scraped Jobs" : "Candidate"
        }
      })
    )
  ],
  connections: {}
};
const generatedWorkflows = [
  scraperWorkflow,
  legacyGeneratorWorkflow,
  alerterWorkflow
];
const digest = (character) => `sha256:${character.repeat(64)}`;
const roleFiles = {
  scraper: generatedWorkflows[0],
  evaluator_generator: generatedWorkflows[1],
  alerter_mover: generatedWorkflows[2]
};
// The active build intentionally no longer ships the historical Generator.
// Rebind this isolated legacy-validator harness to its sanitized fixture and
// current two artifacts without changing committed historical policy evidence.
for (const role of policy.workflow_cutover.roles) {
  role.artifact_digest = workflowDeploymentDigest(roleFiles[role.role]);
  role.google_credential_node_count = googleCredentialNodeNames(
    roleFiles[role.role]
  ).length;
}

function boundWorkflow(role, active) {
  const definition = policy.workflow_cutover.roles.find(
    (entry) => entry.role === role
  );
  const artifact = structuredClone(roleFiles[role]);
  const credentialNames = new Set(googleCredentialNodeNames(artifact));
  artifact.id = definition.target_workflow_id;
  artifact.active = active;
  artifact.versionId = `${role}-version`;
  artifact.activeVersionId = active ? artifact.versionId : "";
  artifact.updatedAt = "2026-08-03T10:00:00.000Z";
  artifact.nodes = artifact.nodes.map((node) =>
    credentialNames.has(node.name)
      ? {
          ...node,
          credentials: {
            ...(node.credentials ?? {}),
            googleSheetsOAuth2Api: {
              id: "private-google-credential-id",
              name: "private-google-credential-name"
            }
          }
        }
      : node
  );
  return artifact;
}

const unrelatedWorkflow = {
  id: "unrelated",
  name: "Private unrelated workflow",
  active: false,
  versionId: "unrelated-version",
  activeVersionId: "",
  updatedAt: "2026-08-03T10:00:00.000Z",
  nodes: [
    {
      name: "Private Node",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authorization: "must-not-be-captured" }
    }
  ],
  connections: {},
  settings: {}
};

const renamedPipelineWriter = {
  id: "renamed-writer",
  name: "Renamed utility",
  active: false,
  versionId: "renamed-version",
  activeVersionId: "",
  updatedAt: "2026-08-03T10:00:00.000Z",
  nodes: [
    {
      name: "Write rows",
      type: "n8n-nodes-base.googleSheets",
      parameters: {
        documentId: "={{ $env.JOB_PIPELINE_SPREADSHEET_ID }}",
        sheetName: "Scraped Jobs"
      }
    }
  ],
  connections: {},
  settings: {}
};

function backupAssets() {
  return policy.workflow_cutover.evidence_contract.required_backup_kinds.map(
    (kind, index) => ({
      kind,
      reference: `encrypted-backup-${index + 1}`,
      sha256: digest(String((index % 9) + 1)),
      readable: true,
      restore_verified: true
    })
  );
}

function verificationRuns() {
  return policy.workflow_cutover.evidence_contract.required_disposable_cases.map(
    (caseId, index) => ({
      case_id: caseId,
      execution_id: `disposable-${index + 1}`,
      observed_at: "2026-08-03T11:00:00.000Z",
      passed: true
    })
  );
}

function trueChecks(names) {
  return Object.fromEntries(names.map((name) => [name, true]));
}

function targetMap() {
  return {
    deployment_commit: "a".repeat(40),
    main_workbook: {
      id: "main-book",
      schema_version: policy.application_compatibility.pipeline_schema_version,
      storage_version: policy.application_compatibility.storage_version,
      pipeline_contract_digest:
        policy.application_compatibility.pipeline_contract_digest,
      business_sheets: [
        ...policy.workflow_cutover.evidence_contract.business_sheets
      ],
      business_headers_exact: true,
      system_sheet_hidden: true
    },
    configuration_workbook: {
      id: "configuration-book",
      sheets: [
        ...policy.workflow_cutover.evidence_contract.configuration_sheets
      ],
      headers_exact: true,
      context_valid: true
    },
    old_workbook: {
      id: "old-book",
      retained: true,
      active_binding_count: 0
    },
    backup_assets: backupAssets(),
    compatibility_inventory: {
      captured_at: "2026-08-03T10:30:00.000Z",
      total_records: 0,
      compatible_records: 0,
      incompatible_records: 0,
      unhandled_incompatible_records: 0,
      records: []
    },
    verification_runs: verificationRuns(),
    deployment_checks: trueChecks(
      policy.workflow_cutover.evidence_contract.required_deployment_checks
    ),
    observations: {
      ...trueChecks(
        policy.workflow_cutover.evidence_contract.required_post_observations
      ),
      started_at: "2026-08-03T12:00:00.000Z",
      completed_at: "2026-08-03T16:00:00.000Z",
      scheduled_execution_ids: {
        scraper: "production-scraper-1",
        evaluator_generator: "production-generator-1",
        alerter_mover: "production-alerter-1"
      }
    },
    production_record: {
      identity_digest: digest("a"),
      execution_id: "production-generator-1",
      focused_store: "To Apply",
      contract_complete: true,
      coverage_complete: true,
      message_provenance_complete: true,
      required_input_verified: true
    },
    slack_canary: {
      identity_digest: digest("a"),
      execution_id: "production-alerter-1",
      stored_message_digest: digest("b"),
      payload_message_digest: digest("b"),
      receipt_digest: digest("c"),
      delivery_attempts: 1,
      automatic_replays: 0,
      message_safety_passed: true,
      links_open_only: true
    },
    rollback: {
      documented: true,
      verified: true,
      disable_order: ["alerter_mover", "evaluator_generator", "scraper"],
      prior_workflow_versions: policy.workflow_cutover.roles.map((role) => ({
        workflow_id: role.target_workflow_id,
        version_id: `${role.role}-prior-version`
      })),
      old_workbook_id: "old-book"
    }
  };
}

function evidence(phase = "pre_activation") {
  const map = targetMap();
  const active = phase !== "pre_activation";
  const environment = {
    JOB_PIPELINE_SPREADSHEET_ID: "main-book",
    JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "configuration-book",
    JOB_PIPELINE_OLD_SPREADSHEET_ID: "old-book"
  };
  const workflows = [
    ...policy.workflow_cutover.roles.map((role) => {
      const workflow = boundWorkflow(role.role, active);
      return {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        nodes: workflow.nodes.map((node) => node.name),
        version_id: workflow.versionId,
        active_version_id: workflow.activeVersionId,
        updated_at: workflow.updatedAt,
        artifact_digest: workflowDeploymentDigest(workflow),
        timezone: workflow.settings.timezone,
        execution_timeout_seconds: workflow.settings.executionTimeout,
        schedule_expressions: role.schedule_expressions,
        ...classifyWorkflowForCutover(workflow, policy, environment),
        google_credential_node_count: role.google_credential_node_count,
        google_credential_bound_node_count: role.google_credential_node_count,
        google_credential_binding_digest: digest("d")
      };
    }),
    {
      id: "unrelated",
      name: "",
      active: false,
      nodes: [],
      version_id: "unrelated-version",
      active_version_id: "",
      updated_at: "2026-08-03T10:00:00.000Z",
      artifact_digest: digest("e"),
      timezone: "",
      execution_timeout_seconds: 0,
      schedule_expressions: [],
      ...classifyWorkflowForCutover(unrelatedWorkflow, policy, environment),
      google_credential_node_count: 0,
      google_credential_bound_node_count: 0,
      google_credential_binding_digest: ""
    }
  ];
  if (phase === "pre_deployment") {
    map.rollback.prior_workflow_versions = workflows.slice(0, 3).map((workflow) => ({
      workflow_id: workflow.id,
      version_id: workflow.active_version_id
    }));
  }
  return {
    schema_version: 3,
    policy_version: policy.policy_version,
    deployment_commit: map.deployment_commit,
    application_compatibility: policy.application_compatibility,
    phase,
    captured_at:
      phase === "post_activation"
        ? "2026-08-03T16:05:00.000Z"
        : "2026-08-03T12:00:00.000Z",
    inventory_scope: "instance_wide",
    inventory_complete: true,
    workflows,
    target_workflow_ids: Object.fromEntries(
      policy.workflow_cutover.roles.map((role) => [role.role, role.target_workflow_id])
    ),
    main_workbook: map.main_workbook,
    configuration_workbook: map.configuration_workbook,
    old_workbook: map.old_workbook,
    backup_assets: map.backup_assets,
    compatibility_inventory: map.compatibility_inventory,
    verification_runs: map.verification_runs,
    deployment_checks: map.deployment_checks,
    observations: map.observations,
    production_record: map.production_record,
    slack_canary: map.slack_canary,
    rollback: map.rollback
  };
}

test("cutover policy and complete three-phase evidence use the segmented in-place contract", () => {
  assert.deepEqual(validateWorkflowCutoverPolicy(policy), []);
  for (const phase of ["pre_deployment", "pre_activation", "post_activation"]) {
    assert.deepEqual(validateWorkflowCutoverEvidence(policy, evidence(phase)), []);
  }
});

test("legacy cutover validator harness pins its isolated workflow artifacts", () => {
  for (const role of policy.workflow_cutover.roles) {
    const workflow = roleFiles[role.role];
    assert.equal(workflow.active, false);
    assert.equal(workflowDeploymentDigest(workflow), role.artifact_digest);
    assert.equal(
      googleCredentialNodeNames(workflow).length,
      role.google_credential_node_count
    );
  }
});

test("stale artifacts, retired sheets, wrong bindings, and pending records fail before activation", () => {
  const cases = [
    (() => {
      const value = evidence();
      value.workflows[0].artifact_digest = digest("0");
      return value;
    })(),
    (() => {
      const value = evidence();
      value.main_workbook.business_sheets[0] = "Review Queue";
      return value;
    })(),
    (() => {
      const value = evidence();
      value.workflows[1].configuration_spreadsheet_binding = "none";
      return value;
    })(),
    (() => {
      const value = evidence();
      value.compatibility_inventory = {
        captured_at: "2026-08-03T10:30:00.000Z",
        total_records: 1,
        compatible_records: 0,
        incompatible_records: 1,
        unhandled_incompatible_records: 1,
        records: [
          {
            identity_digest: digest("f"),
            record_version: 1,
            state_guard_digest: digest("1"),
            review_digest: "",
            application_versions: policy.application_compatibility,
            safe: false,
            reason_codes: ["pack_version_mismatch"],
            disposition: "pending"
          }
        ]
      };
      return value;
    })()
  ];
  for (const [index, value] of cases.entries()) {
    assert.ok(
      validateWorkflowCutoverEvidence(policy, value).length > 0,
      `negative case ${index + 1} unexpectedly passed`
    );
  }
});

test("rollback assets, disposable executions, observation, Slack, and privacy evidence are mandatory", () => {
  const value = evidence("post_activation");
  value.backup_assets[0].restore_verified = false;
  value.verification_runs[0].execution_id = "";
  value.observations.completed_at = "2026-08-03T12:30:00.000Z";
  value.slack_canary.payload_message_digest = digest("9");
  value.notes = "generated_message: private content";
  const errors = validateWorkflowCutoverEvidence(policy, value).join(";");
  assert.match(errors, /backup asset/);
  assert.match(errors, /verification run/);
  assert.match(errors, /observation window/);
  assert.match(errors, /Slack canary/);
  assert.match(errors, /unsupported field|sensitive or private/);
});

test("nested cutover evidence rejects fields outside the privacy allow-list in every phase", () => {
  for (const phase of ["pre_deployment", "pre_activation", "post_activation"]) {
    const value = evidence(phase);
    value.target_workflow_ids.internal_alias = "private";
    value.deployment_checks.operator_notes = true;
    value.observations.operator_notes = "private";
    value.production_record.operator_notes = "private";
    value.slack_canary.payload_preview = "private";
    value.verification_runs[0].response_preview = "private";
    const errors = validateWorkflowCutoverEvidence(policy, value).join(";");
    assert.match(errors, /target_workflow_ids contains unsupported field/);
    assert.match(errors, /deployment_checks contains unsupported field/);
    assert.match(errors, /observations contains unsupported field/);
    assert.match(errors, /production_record contains unsupported field/);
    assert.match(errors, /slack_canary contains unsupported field/);
    assert.match(errors, /verification run contains unsupported field/);
  }
});

test("version lineage, active duplicates, observation time, and execution provenance fail closed", () => {
  const pre = evidence("pre_deployment");
  pre.rollback.prior_workflow_versions[0].version_id = "fabricated-prior";
  assert.match(
    validateWorkflowCutoverEvidence(policy, pre).join(";"),
    /rollback versions must match/
  );

  const post = evidence("post_activation");
  post.workflows[0].active_version_id = "stale-active-version";
  post.captured_at = "2026-08-03T15:59:00.000Z";
  post.production_record.execution_id = "unrelated-generator-execution";
  post.slack_canary.execution_id = "unrelated-alert-execution";
  post.slack_canary.identity_digest = digest("9");
  post.workflows.push({
    ...structuredClone(post.workflows[3]),
    id: "rogue-pipeline-copy",
    active: true,
    active_version_id: "rogue-active-version",
    pipeline_marker_match: true,
    pipeline_binding_count: 1,
    pipeline_binding_kinds: ["main_workbook"],
    pipeline_surface_digest: digest("8")
  });
  const errors = validateWorkflowCutoverEvidence(policy, post).join(";");
  assert.match(errors, /active version does not match/);
  assert.match(errors, /exactly three active pipeline workflows/);
  assert.match(errors, /captured prematurely/);
  assert.match(errors, /must match one identity and their scheduled role executions/);

  const inactiveGate = evidence("pre_activation");
  inactiveGate.workflows.push({
    ...structuredClone(inactiveGate.workflows[3]),
    id: "rogue-pipeline-copy",
    active: true,
    active_version_id: "rogue-active-version",
    pipeline_binding_count: 1,
    pipeline_binding_kinds: ["main_workbook"],
    pipeline_surface_digest: digest("7")
  });
  assert.match(
    validateWorkflowCutoverEvidence(policy, inactiveGate).join(";"),
    /every pipeline workflow inactive/
  );

  const wrongCommit = evidence();
  assert.match(
    validateWorkflowCutoverEvidence(policy, wrongCommit, {
      expectedDeploymentCommit: "b".repeat(40)
    }).join(";"),
    /does not match repository HEAD/
  );
});

test("evidence rejects private strings and policy requires every rollback asset", () => {
  const value = evidence();
  value.workflows[0].name =
    "Generator gsk_live_privatevalue /opt/customer/private";
  value.backup_assets[0].reference = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  value.verification_runs[0].execution_id = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const errors = validateWorkflowCutoverEvidence(policy, value).join(";");
  assert.match(errors, /sensitive or private material/);
  assert.match(errors, /backup asset/);
  assert.match(errors, /verification run/);

  const missingBackupPolicy = structuredClone(policy);
  missingBackupPolicy.workflow_cutover.evidence_contract.required_backup_kinds.pop();
  assert.match(
    validateWorkflowCutoverPolicy(missingBackupPolicy).join(";"),
    /exact nine rollback assets|backup_kinds/
  );
});

test("unresolved dynamic Google writers are pipeline-ambiguous unless explicitly approved", () => {
  const dynamicWriter = {
    id: "dynamic-writer",
    name: "Renamed utility",
    active: true,
    versionId: "dynamic-version",
    activeVersionId: "dynamic-version",
    updatedAt: "2026-08-03T15:00:00.000Z",
    nodes: [
      {
        name: "Append dynamic rows",
        type: "n8n-nodes-base.googleSheets",
        parameters: {
          operation: "append",
          documentId: "={{ $json.book }}",
          sheetName: "={{ $json.tab }}"
        }
      }
    ],
    connections: {},
    settings: {}
  };
  const classification = classifyWorkflowForCutover(dynamicWriter, policy, {});
  assert.ok(
    classification.pipeline_binding_kinds.includes("ambiguous_google_writer")
  );
  const value = evidence("post_activation");
  value.workflows.push({
    id: dynamicWriter.id,
    name: "",
    active: true,
    nodes: [],
    version_id: dynamicWriter.versionId,
    active_version_id: dynamicWriter.activeVersionId,
    updated_at: dynamicWriter.updatedAt,
    artifact_digest: workflowDeploymentDigest(dynamicWriter),
    timezone: "",
    execution_timeout_seconds: 0,
    schedule_expressions: [],
    ...classification,
    google_credential_node_count: 1,
    google_credential_bound_node_count: 0,
    google_credential_binding_digest: ""
  });
  assert.match(
    validateWorkflowCutoverEvidence(policy, value).join(";"),
    /exactly three active pipeline workflows/
  );

  const approvedPolicy = structuredClone(policy);
  approvedPolicy.workflow_cutover.approved_unrelated_dynamic_writer_ids = [
    dynamicWriter.id
  ];
  assert.ok(
    !classifyWorkflowForCutover(dynamicWriter, approvedPolicy, {}).pipeline_binding_kinds.includes(
      "ambiguous_google_writer"
    )
  );
});

test("capture refuses an unapproved API origin before sending the API key", async () => {
  let called = false;
  await assert.rejects(
    captureWorkflowCutoverEvidence({
      policy,
      phase: "pre_activation",
      apiBaseUrl: "https://attacker.example/api/v1",
      apiKey: "must-not-be-sent",
      targetMap: targetMap(),
      fetchImpl: async () => {
        called = true;
        throw new Error("unexpected request");
      }
    }),
    /origin is not approved/
  );
  assert.equal(called, false);
});

test("capture paginates, hashes credential references, and stores only allow-listed fields", async () => {
  const roleWorkflows = policy.workflow_cutover.roles.map((role) =>
    boundWorkflow(role.role, false)
  );
  const pages = [
    { data: roleWorkflows.slice(0, 2), nextCursor: "page-2" },
    {
      data: [
        ...roleWorkflows.slice(2),
        unrelatedWorkflow,
        renamedPipelineWriter
      ],
      nextCursor: ""
    }
  ];
  let request = 0;
  const captured = await captureWorkflowCutoverEvidence({
    policy,
    phase: "pre_activation",
    apiBaseUrl: "http://127.0.0.1:5678/api/v1",
    apiKey: "private-key",
    targetMap: targetMap(),
    environment: {
      JOB_PIPELINE_SPREADSHEET_ID: "main-book",
      JOB_PIPELINE_CONFIG_SPREADSHEET_ID: "configuration-book"
    },
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        json: async () => pages[request++]
      };
    }
  });
  assert.equal(request, 2);
  assert.equal(captured.workflows[0].google_credential_bound_node_count, 13);
  assert.ok(validDigest(captured.workflows[0].google_credential_binding_digest));
  assert.doesNotMatch(
    JSON.stringify(captured),
    /private-google|must-not-be-captured|private-key|authorization|Private unrelated/
  );
  assert.equal(captured.workflows.at(-1).name, "");
  assert.deepEqual(captured.workflows.at(-1).nodes, []);
  assert.ok(captured.workflows.at(-1).pipeline_binding_count > 0);
  assert.ok(
    captured.workflows.at(-1).pipeline_binding_kinds.includes("main_workbook")
  );
  assert.deepEqual(validateWorkflowCutoverEvidence(policy, captured), []);
});

function validDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
