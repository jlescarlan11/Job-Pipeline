#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  commitBrowserResult,
  confirmAutonomousClaim,
  confirmBrowserReady,
  confirmSubmitIntent,
  planAutonomousClaim,
  planSubmitIntent,
  recoverBrowserRecord,
  selectAutonomousCandidates,
  validateAutonomousDecision
} from "../src/browser-executor.mjs";
import {
  browserConfirmationPublicKeyDigest
} from "../src/browser-confirmation-attestation.mjs";

const COMMANDS = new Set([
  "select",
  "plan-claim",
  "confirm-claim",
  "validate-decision",
  "confirm-browser-ready",
  "plan-submit-intent",
  "confirm-submit-intent",
  "commit-result",
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
      `Browser executor input keys are invalid` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${extra.length ? `; unsupported: ${extra.join(", ")}` : ""}`
    );
  }
}

async function loadJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  );
}

const [schema, profile, rankingPolicy, applicationPolicy, packPolicy, browserTask] =
  await Promise.all([
    loadJson("../config/pipeline-schema.json"),
    loadJson("../config/candidate-profile.json"),
    loadJson("../config/ranking-policy.json"),
    loadJson("../config/application-policy.json"),
    loadJson("../config/application-pack-policy.json"),
    loadJson("../config/browser-executor-task.json")
  ]);
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
    exactInput(input, ["stores"], ["now", "deadline_ms", "minimum_headroom_ms"]);
    {
      const candidates = selectAutonomousCandidates(input.stores, schema, {
        now: input.now,
        deadline_ms: input.deadline_ms,
        minimum_headroom_ms: input.minimum_headroom_ms
      });
      output = {
        candidate: candidates[0] ?? null,
        due_count: candidates.length
      };
    }
    break;
  case "plan-claim":
    exactInput(
      input,
      ["record", "execution_id", "now", "lease_ms"],
      ["attempt_id"]
    );
    output = planAutonomousClaim(input.record, {
      execution_id: input.execution_id,
      now: input.now,
      lease_ms: input.lease_ms,
      attempt_id: input.attempt_id
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
      "now"
    ]);
    output = confirmBrowserReady(
      input.planned_record,
      input.fresh_source_rows,
      { ...configuration, persistedClaims: input.persisted_claims },
      input.now
    );
    break;
  case "plan-submit-intent":
    exactInput(input, ["fresh_record", "form", "field_receipts", "now"]);
    output = planSubmitIntent(input.fresh_record, {
      form: input.form,
      field_receipts: input.field_receipts,
      now: input.now
    });
    break;
  case "confirm-submit-intent":
    exactInput(input, ["plan", "fresh_source_rows", "persisted_claims", "now"]);
    output = confirmSubmitIntent(input.plan, input.fresh_source_rows, {
      ...configuration,
      persistedClaims: input.persisted_claims,
      now: input.now
    });
    break;
  case "commit-result":
    exactInput(input, ["fresh_record", "result", "now"]);
    {
      const publicKey =
        process.env.JOB_PIPELINE_BROWSER_ATTESTATION_PUBLIC_KEY || "";
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
        }
      )
    };
    }
    break;
  case "recover":
    exactInput(input, ["fresh_record", "now", "retry_at", "evidence"]);
    output = {
      proposed_record: recoverBrowserRecord(input.fresh_record, {
        now: input.now,
        retry_at: input.retry_at,
        evidence: input.evidence
      }, schema)
    };
    break;
}

process.stdout.write(`${JSON.stringify(output)}\n`);
