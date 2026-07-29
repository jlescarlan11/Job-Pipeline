import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureWorkflowCutoverEvidence,
  validateWorkflowCutoverEvidence,
  validateWorkflowCutoverPolicy
} from "../src/workflow-cutover.mjs";

const policy = JSON.parse(
  await readFile(
    new URL("../config/n8n-deployment-policy.json", import.meta.url),
    "utf8"
  )
);
const roles = policy.workflow_cutover.roles;
const targets = Object.fromEntries(
  roles.map(({ role }) => [role, `${role}-target`])
);

function workflowRecord(definition, { id, active = false } = {}) {
  return {
    id: id || `${definition.role}-target`,
    name: `Job Application Pipeline - ${definition.name_markers[0]}`,
    active,
    isArchived: false,
    triggerCount: active ? 1 : 0,
    nodes: [
      { name: "Schedule Trigger", type: "n8n-nodes-base.scheduleTrigger" },
      ...definition.required_node_names.map((name) => ({
        name,
        type: "n8n-nodes-base.code"
      }))
    ]
  };
}

function inventorySource(endpoint, records) {
  return {
    endpoint,
    limit: 250,
    pages: 1,
    records,
    pagination_complete: true
  };
}

function evidenceFor(phase) {
  const workflows = roles.map((definition) =>
    workflowRecord(definition, {
      active: phase === "post_activation"
    })
  );
  const evidence = {
    schema_version: 1,
    phase,
    captured_at: "2026-07-30T02:01:00.000Z",
    source: {
      public_api_path: "/api/v1",
      workflow_inventory: {
        ...inventorySource("/workflows", workflows.length),
        exclude_pinned_data: true
      }
    },
    runtime_restart: {
      method: "process_restart",
      completed_at: "2026-07-30T02:00:00.000Z",
      readiness_checked_at: "2026-07-30T02:00:30.000Z",
      readiness_recovered: true
    },
    inventory_scope: {
      instance_wide_workflow_list_confirmed: true,
      instance_wide_execution_list_confirmed: true
    },
    targets,
    workflows
  };
  if (phase === "pre_activation") {
    evidence.source.execution_inventories = {};
    evidence.executions = {};
    for (const status of ["new", "running", "waiting"]) {
      evidence.source.execution_inventories[status] = inventorySource(
        `/executions?status=${status}`,
        0
      );
      evidence.source.execution_inventories[status].include_data = false;
      evidence.executions[status] = [];
    }
  }
  return evidence;
}

test("cutover policy and both seven-role phase gates are valid", () => {
  assert.deepEqual(validateWorkflowCutoverPolicy(policy), []);
  assert.deepEqual(
    validateWorkflowCutoverEvidence(policy, evidenceFor("pre_activation")),
    []
  );
  assert.deepEqual(
    validateWorkflowCutoverEvidence(policy, evidenceFor("post_activation")),
    []
  );
});

test("cutover role signatures remain present in every generated export", async () => {
  for (const definition of roles) {
    const workflow = JSON.parse(
      await readFile(
        new URL(`../workflows/${definition.role}.json`, import.meta.url),
        "utf8"
      )
    );
    const nodeNames = new Set(workflow.nodes.map(({ name }) => name));
    assert.ok(
      definition.required_node_names.every((name) => nodeNames.has(name)),
      `${definition.role} structural cutover signature drifted`
    );
    assert.match(workflow.name, /Job Application Pipeline/i);
  }
});

test("post-activation gate rejects an older active workflow copy", () => {
  const evidence = evidenceFor("post_activation");
  evidence.workflows.push(
    workflowRecord(roles.find(({ role }) => role === "alerter"), {
      id: "alerter-old",
      active: true
    })
  );
  evidence.source.workflow_inventory.records = evidence.workflows.length;
  const errors = validateWorkflowCutoverEvidence(policy, evidence).join("\n");
  assert.match(
    errors,
    /post-activation alerter must have exactly its target workflow active/
  );
});

test("cutover gate rejects an archived target workflow", () => {
  const evidence = evidenceFor("post_activation");
  evidence.workflows[0].isArchived = true;
  const errors = validateWorkflowCutoverEvidence(policy, evidence).join("\n");
  assert.match(errors, /cutover target scraper is archived/);
});

test("inventory gate fails closed on incomplete or unclassified pipeline copies", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.source.workflow_inventory.pagination_complete = false;
  evidence.inventory_scope.instance_wide_workflow_list_confirmed = false;
  evidence.workflows.push({
    id: "unknown-pipeline-copy",
    name: "Job Application Pipeline - Legacy Worker",
    active: false,
    isArchived: false,
    triggerCount: 0,
    nodes: [
      { name: "Schedule Trigger", type: "n8n-nodes-base.scheduleTrigger" }
    ]
  });
  evidence.source.workflow_inventory.records = evidence.workflows.length;
  const errors = validateWorkflowCutoverEvidence(policy, evidence).join("\n");
  assert.match(errors, /inventory pagination must be complete/);
  assert.match(errors, /instance-wide workflow-list access/);
  assert.match(errors, /unrecognized or ambiguous role/);
});

test("pre-activation gate rejects stale registration and in-flight work", () => {
  const evidence = evidenceFor("pre_activation");
  evidence.runtime_restart.method = "api_unpublish";
  evidence.workflows[0].active = true;
  evidence.executions.running.push({
    id: "9001",
    workflowId: evidence.workflows[0].id,
    status: "running",
    startedAt: "2026-07-30T01:59:00.000Z",
    waitTill: null
  });
  evidence.source.execution_inventories.running.records = 1;
  const errors = validateWorkflowCutoverEvidence(policy, evidence).join("\n");
  assert.match(errors, /requires a completed runtime restart/);
  assert.match(errors, /is still active/);
  assert.match(errors, /still has a running execution/);
});

test("capture paginates GET inventories and removes workflow parameters", async () => {
  const rawWorkflows = roles.map((definition) => ({
    ...workflowRecord(definition),
    nodes: [
      {
        name: "Schedule Trigger",
        type: "n8n-nodes-base.scheduleTrigger",
        parameters: { hidden: "sensitive-node-value" },
        credentials: { googleSheetsOAuth2Api: { id: "sensitive-id" } }
      },
      ...definition.required_node_names.map((name) => ({
        name,
        type: "n8n-nodes-base.code",
        parameters: { jsCode: "sensitive-code" }
      }))
    ]
  }));
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({
      url: url.toString(),
      apiKey: options.headers["X-N8N-API-KEY"]
    });
    if (url.pathname.endsWith("/workflows")) {
      if (!url.searchParams.has("cursor")) {
        return {
          ok: true,
          json: async () => ({
            data: rawWorkflows.slice(0, 4),
            nextCursor: "workflow-page-2"
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: rawWorkflows.slice(4),
          nextCursor: null
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ data: [], nextCursor: null })
    };
  };
  const evidence = await captureWorkflowCutoverEvidence({
    policy,
    phase: "pre_activation",
    apiBaseUrl: "https://n8n.example.test/api/v1/",
    apiKey: "secret-api-key",
    targetMap: {
      schema_version: 1,
      targets,
      inventory_scope: {
        instance_wide_workflow_list_confirmed: true,
        instance_wide_execution_list_confirmed: true
      },
      runtime_restart: {
        method: "process_restart",
        completed_at: "2026-07-30T02:00:00.000Z",
        readiness_checked_at: "2026-07-30T02:00:30.000Z",
        readiness_recovered: true
      }
    },
    capturedAt: new Date("2026-07-30T02:01:00.000Z"),
    fetchImpl
  });

  assert.equal(requested.length, 5);
  assert.ok(requested.every(({ apiKey }) => apiKey === "secret-api-key"));
  assert.equal(evidence.source.workflow_inventory.pages, 2);
  assert.equal(evidence.workflows.length, 7);
  assert.deepEqual(validateWorkflowCutoverEvidence(policy, evidence), []);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /secret-api-key/);
  assert.doesNotMatch(serialized, /sensitive-node-value|sensitive-id|sensitive-code/);
  assert.doesNotMatch(serialized, /parameters|credentials/);
});

test("capture rejects non-TLS remote API endpoints", async () => {
  await assert.rejects(
    captureWorkflowCutoverEvidence({
      policy,
      phase: "post_activation",
      apiBaseUrl: "http://n8n.example.test/api/v1/",
      apiKey: "secret-api-key",
      targetMap: {
        schema_version: 1,
        targets,
        inventory_scope: {
          instance_wide_workflow_list_confirmed: true,
          instance_wide_execution_list_confirmed: true
        },
        runtime_restart: {}
      },
      fetchImpl: async () => {
        throw new Error("must not be called");
      }
    }),
    /must use HTTPS or loopback HTTP/
  );
});

test("capture rejects credentials and a noncanonical Public API path", async () => {
  const input = {
    policy,
    phase: "post_activation",
    apiKey: "secret-api-key",
    targetMap: {
      schema_version: 1,
      targets,
      inventory_scope: {
        instance_wide_workflow_list_confirmed: true,
        instance_wide_execution_list_confirmed: true
      },
      runtime_restart: {}
    },
    fetchImpl: async () => {
      throw new Error("must not be called");
    }
  };
  await assert.rejects(
    captureWorkflowCutoverEvidence({
      ...input,
      apiBaseUrl: "https://user:password@n8n.example.test/api/v1/"
    }),
    /must not contain credentials/
  );
  await assert.rejects(
    captureWorkflowCutoverEvidence({
      ...input,
      apiBaseUrl: "https://n8n.example.test/"
    }),
    /must end with \/api\/v1\//
  );
});

test("capture rejects incomplete scope assertions before any API request", async () => {
  let requests = 0;
  await assert.rejects(
    captureWorkflowCutoverEvidence({
      policy,
      phase: "pre_activation",
      apiBaseUrl: "https://n8n.example.test/api/v1/",
      apiKey: "secret-api-key",
      targetMap: {
        schema_version: 1,
        targets,
        inventory_scope: {
          instance_wide_workflow_list_confirmed: true,
          instance_wide_execution_list_confirmed: false
        },
        runtime_restart: {
          method: "process_restart",
          completed_at: "2026-07-30T02:00:00.000Z",
          readiness_checked_at: "2026-07-30T02:00:30.000Z",
          readiness_recovered: true
        }
      },
      capturedAt: new Date("2026-07-30T02:01:00.000Z"),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("must not be called");
      }
    }),
    /required instance-wide inventory scopes/
  );
  assert.equal(requests, 0);
});
