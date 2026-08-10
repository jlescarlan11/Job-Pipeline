#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  commitBrowserResult,
  confirmAutonomousClaim,
  confirmBrowserReady,
  confirmSubmitIntent,
  planAutonomousClaim,
  planSubmitIntent,
  reconcileBrowserResult,
  recoverBrowserRecord,
  selectAutonomousWork,
  validateAutonomousDecision
} from "../src/browser-executor.mjs";
import {
  browserConfirmationPublicKeyDigest
} from "../src/browser-confirmation-attestation.mjs";
import { assertProvisionedBrowserTask } from "../src/browser-task-runtime.mjs";

const COMMANDS = new Set([
  "select",
  "plan-claim",
  "confirm-claim",
  "validate-decision",
  "confirm-browser-ready",
  "plan-submit-intent",
  "confirm-submit-intent",
  "commit-result",
  "reconcile-result",
  "recover"
]);

const [command, ...unexpectedArguments] = process.argv.slice(2);
if (!COMMANDS.has(command) || unexpectedArguments.length > 0) {
  throw new Error(
    `Usage: node scripts/browser-executor.mjs <${[...COMMANDS].join("|")}> < input.json`
  );
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const source = Buffer.concat(chunks).toString("utf8");
  if (!source.trim()) throw new Error("Browser executor requires one JSON object on stdin");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Browser executor stdin must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Browser executor stdin must be one JSON object");
  }
  return parsed;
}

function exactInput(input, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in input));
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    throw new Error(
      `Browser executor input keys are invalid; missing count: ${missing.length}; ` +
        `unsupported count: ${extra.length}`
    );
  }
}

async function loadJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  );
}

const [schema, profile, rankingPolicy, applicationPolicy, packPolicy, sourceBrowserTask] =
  await Promise.all([
    loadJson("../config/pipeline-schema.json"),
    loadJson("../config/candidate-profile.json"),
    loadJson("../config/ranking-policy.json"),
    loadJson("../config/application-policy.json"),
    loadJson("../config/application-pack-policy.json"),
    loadJson("../config/browser-executor-task.json")
  ]);
const publicKeyEnvironmentVariable =
  sourceBrowserTask.confirmation_attestation.public_key_environment_variable;
const publicKeyFileEnvironmentVariable = `${publicKeyEnvironmentVariable}_FILE`;
const publicKeyPath = process.env[publicKeyFileEnvironmentVariable] || "";
if (publicKeyPath && !isAbsolute(publicKeyPath)) {
  throw new Error("Browser attestation public-key path must be absolute");
}
const confirmationPublicKey = publicKeyPath
  ? await readFile(publicKeyPath, "utf8")
  : process.env[publicKeyEnvironmentVariable] || "";
const runtimeTaskPath = process.env.JOB_PIPELINE_BROWSER_TASK_CONFIG_PATH || "";
if (runtimeTaskPath && !isAbsolute(runtimeTaskPath)) {
  throw new Error("Browser runtime task path must be absolute");
}
const browserTask = runtimeTaskPath
  ? assertProvisionedBrowserTask(
      sourceBrowserTask,
      JSON.parse(await readFile(runtimeTaskPath, "utf8")),
      confirmationPublicKey
    )
  : sourceBrowserTask;
const configuration = {
  profile,
  rankingPolicy,
  applicationPolicy,
  packPolicy
};
const input = await readStandardInput();
let output;

switch (command) {
  case "select":
    exactInput(
      input,
      ["stores", "persisted_claims"],
      ["now", "deadline_ms", "minimum_headroom_ms"]
    );
    {
      const work = selectAutonomousWork(input.stores, schema, {
        now: input.now,
        deadline_ms: input.deadline_ms,
        minimum_headroom_ms: input.minimum_headroom_ms,
        persisted_claims: input.persisted_claims,
        runtime: browserTask.runtime
      });
      output = {
        candidate: work[0]?.record ?? null,
        operation: work[0]?.operation ?? null,
        due_count: work.length,
        recovery_count: work.filter((entry) => entry.operation === "recover").length,
        reconciliation_count: work.filter((entry) => entry.operation === "reconcile").length
      };
    }
    break;
  case "plan-claim":
    exactInput(
      input,
      ["record", "execution_id", "now"],
      ["attempt_id"]
    );
    output = planAutonomousClaim(input.record, {
      execution_id: input.execution_id,
      now: input.now,
      attempt_id: input.attempt_id,
      runtime: browserTask.runtime
    });
    break;
  case "confirm-claim":
    exactInput(input, ["plan", "persisted_claims", "fresh_source_rows", "now"]);
    output = confirmAutonomousClaim(
      input.plan,
      {
        persisted_claims: input.persisted_claims,
        fresh_source_rows: input.fresh_source_rows,
        schema,
        now: input.now
      },
      configuration
    );
    break;
  case "validate-decision":
    exactInput(input, ["fresh_record", "decision", "context_digest", "form", "now"]);
    output = validateAutonomousDecision(
      input.fresh_record,
      input.decision,
      {
        ...configuration,
        context_digest: input.context_digest,
        form: input.form
      },
      input.now
    );
    break;
  case "confirm-browser-ready":
    exactInput(input, [
      "planned_record",
      "fresh_source_rows",
      "persisted_claims",
      "form",
      "now"
    ]);
    output = confirmBrowserReady(
      input.planned_record,
      input.fresh_source_rows,
      {
        ...configuration,
        persistedClaims: input.persisted_claims,
        runtime: browserTask.runtime,
        form: input.form
      },
      input.now
    );
    break;
  case "plan-submit-intent":
    exactInput(input, ["fresh_record", "form", "field_receipts", "now"]);
    output = planSubmitIntent(input.fresh_record, {
      form: input.form,
      field_receipts: input.field_receipts,
      profile,
      rankingPolicy,
      now: input.now
    });
    break;
  case "confirm-submit-intent":
    exactInput(input, [
      "plan",
      "fresh_source_rows",
      "persisted_claims",
      "form",
      "field_receipts",
      "now"
    ]);
    output = confirmSubmitIntent(input.plan, input.fresh_source_rows, {
      ...configuration,
      persistedClaims: input.persisted_claims,
      runtime: browserTask.runtime,
      receiptStore: {
        directory:
          process.env[
            browserTask.click_consumption.directory_environment_variable
          ] || "",
        witness_path:
          process.env[
            browserTask.click_consumption.witness_file_environment_variable
          ] || "",
        store_id: browserTask.click_consumption.store_id,
        ledger_id: browserTask.click_consumption.ledger_id,
        generation_id: browserTask.click_consumption.generation_id,
        manifest_sha256: browserTask.click_consumption.manifest_sha256,
        directory_binding_digest:
          browserTask.click_consumption.directory_binding_digest,
        directory_identity:
          browserTask.click_consumption.directory_identity,
        witness_identity:
          browserTask.click_consumption.witness_identity
      },
      form: input.form,
      fieldReceipts: input.field_receipts,
      now: input.now
    });
    break;
  case "commit-result":
    exactInput(input, [
      "fresh_record",
      "fresh_source_rows",
      "persisted_claims",
      "result",
      "now"
    ]);
    {
      const publicKey = confirmationPublicKey;
      const expectedPublicKeyDigest =
        browserTask.confirmation_attestation.public_key_spki_sha256;
      const publicKeyIsPinned =
        /^sha256:[a-f0-9]{64}$/.test(expectedPublicKeyDigest) &&
        browserConfirmationPublicKeyDigest(publicKey) ===
          expectedPublicKeyDigest;
    output = {
      proposed_record: commitBrowserResult(
        input.fresh_record,
        input.result,
        input.now,
        schema,
        {
          publicKey: publicKeyIsPinned ? publicKey : "",
          keyId: browserTask.confirmation_attestation.key_id,
          publicKeySpkiSha256: expectedPublicKeyDigest
        },
        {
          freshSourceRows: input.fresh_source_rows,
          persistedClaims: input.persisted_claims,
          configuration,
          runtime: browserTask.runtime
        }
      )
    };
    }
    break;
  case "reconcile-result":
    exactInput(input, ["fresh_record", "fresh_source_rows", "result", "now"]);
    {
      const publicKey = confirmationPublicKey;
      const expectedPublicKeyDigest =
        browserTask.confirmation_attestation.public_key_spki_sha256;
      const publicKeyIsPinned =
        /^sha256:[a-f0-9]{64}$/.test(expectedPublicKeyDigest) &&
        browserConfirmationPublicKeyDigest(publicKey) === expectedPublicKeyDigest;
      output = {
        proposed_record: reconcileBrowserResult(
          input.fresh_record,
          input.result,
          input.now,
          schema,
          {
            publicKey: publicKeyIsPinned ? publicKey : "",
            keyId: browserTask.confirmation_attestation.key_id,
            publicKeySpkiSha256: expectedPublicKeyDigest
          },
          {
            freshSourceRows: input.fresh_source_rows,
            configuration
          }
        )
      };
    }
    break;
  case "recover":
    exactInput(input, [
      "fresh_record",
      "fresh_source_rows",
      "persisted_claims",
      "now",
      "evidence"
    ]);
    output = {
      proposed_record: recoverBrowserRecord(input.fresh_record, {
        now: input.now,
        evidence: input.evidence,
        freshSourceRows: input.fresh_source_rows,
        persistedClaims: input.persisted_claims,
        configuration,
        runtime: browserTask.runtime
      }, schema)
    };
    break;
}

process.stdout.write(`${JSON.stringify(output)}\n`);
