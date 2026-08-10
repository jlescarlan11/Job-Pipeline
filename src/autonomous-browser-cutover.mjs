import { createHash } from "node:crypto";

import {
  normalizeLegacyRecord,
  normalizeUserAction,
  stateGuardMatches,
  validatePipelineSchema,
  validateRecordStoreContract
} from "./contracts.mjs";
import { permanentSourceUnavailable } from "./movement.mjs";

const PHASES = new Set(["pre_cutover", "pre_activation", "post_activation"]);
const ACTIVE_STORES = new Set(["Scraped Jobs", "To Review", "To Apply"]);
const TERMINAL_STORES = new Set(["Applied Jobs", "Archive"]);
const OBSERVATION_OUTCOME_KEYS = [
  "confirmed",
  "skipped",
  "blocked",
  "retryable",
  "ambiguous",
  "unavailable"
];
const BUSINESS_STORE_COUNT_KEYS = [
  "Scraped Jobs",
  "To Review",
  "To Apply",
  "Applied Jobs",
  "Archive"
];
const BROWSER_STATE_COUNT_KEYS = [
  "legacy_blank",
  "queued",
  "claimed",
  "evaluating",
  "generating",
  "filling",
  "submit_started",
  "confirmed",
  "retryable",
  "ambiguous",
  "blocked",
  "unavailable",
  "skipped"
];
const RECEIPT_STATUS_COUNT_KEYS = [
  "pending",
  "sending",
  "delivered",
  "reconciled",
  "retryable_rejection",
  "terminal_rejection",
  "terminal_ambiguity"
];

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value || ""));
}

function bounded(value, maximum = 240) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function identityKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function exactSet(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}

function exactArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function positiveCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function boundedIdentifier(value, maximum = 160) {
  const original = String(value ?? "");
  const normalized = bounded(original, maximum);
  return (
    original === normalized &&
    original.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  )
    ? normalized
    : "";
}

function sha256Digest(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ""));
}

function requireExactObjectKeys(value, expectedKeys, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an exact object`);
    return;
  }
  if (!exactSet(Object.keys(value), expectedKeys)) {
    errors.push(`${label} contains missing or unsupported fields`);
  }
}

function sensitiveMaterialPresent(value) {
  return /hooks\.slack\.com\/services|bearer\s+[a-z0-9._-]+|api[-_ ]?key\s*[:=]|authorization\s*[:=]|-----begin [a-z ]+private key-----|"(?:generated_message|job_description|canonical_url|job_url|dom|screenshot|cookie|browser_history)"\s*:/i.test(
    JSON.stringify(value ?? {})
  );
}

function planReject(plan, category, details = {}) {
  plan.rejects.push({
    category,
    source_store: bounded(details.source_store, 40),
    source_row_number: Number.isInteger(details.source_row_number)
      ? details.source_row_number
      : null,
    canonical_job_id: bounded(details.canonical_job_id, 120),
    summary: bounded(details.summary)
  });
}

export function migrationDisposition(store, record, schema) {
  const action = normalizeUserAction(record.user_action, schema);
  if (TERMINAL_STORES.has(store)) {
    return {
      disposition: "retain_terminal",
      guarded_path: "none_terminal_owner"
    };
  }
  if (record.browser_state === "ambiguous") {
    return {
      disposition: "reconcile_ambiguous",
      guarded_path: "browser_executor_recover_before_any_retry"
    };
  }
  if (["blocked", "retryable", "unavailable"].includes(record.browser_state)) {
    return {
      disposition: "retain_browser_blocker",
      guarded_path: "browser_executor_bounded_recovery"
    };
  }
  if (
    record.execution_mode === "autonomous_chrome" &&
    ["confirmed", "skipped"].includes(record.browser_state)
  ) {
    return {
      disposition: "consume_autonomous_terminal",
      guarded_path: "alerter_mover_copy_confirm_delete"
    };
  }
  if (store === "To Review") {
    if (["Proceed", "Reject"].includes(action)) {
      return {
        disposition: "drain_legacy_review_action",
        guarded_path: "alerter_mover_copy_confirm_delete"
      };
    }
    return {
      disposition: "retain_legacy_review_blocked",
      guarded_path: "no_automatic_transition_without_compatible_decision"
    };
  }
  if (store === "To Apply" && ["I Applied", "Skip"].includes(action)) {
    return {
      disposition: "drain_legacy_application_action",
      guarded_path: "alerter_mover_copy_confirm_delete"
    };
  }
  if (record.execution_mode !== "autonomous_chrome") {
    if (store === "Scraped Jobs" && permanentSourceUnavailable(record)) {
      return {
        disposition: "drain_legacy_source_unavailable",
        guarded_path: "alerter_mover_copy_confirm_delete"
      };
    }
    if (
      store === "Scraped Jobs" &&
      ["ready_to_apply", "review_needed", "skip"].includes(
        record.pipeline_status
      )
    ) {
      return {
        disposition: "drain_legacy_scraped_route",
        guarded_path: "alerter_mover_copy_confirm_delete"
      };
    }
    return {
      disposition: "retain_legacy_manual",
      guarded_path: "no_autonomous_claim_without_guarded_mode_upgrade"
    };
  }
  return {
    disposition: "claim_for_autonomous_executor",
    guarded_path: "browser_executor_claim_validate_commit"
  };
}

/**
 * Build a private, deterministic migration plan from an exact fresh reread.
 * This function never performs a write and never authorizes direct row moves.
 */
export function planAutonomousBrowserMigration(snapshot, schema) {
  const capturedAt = String(snapshot?.captured_at || "");
  const plan = {
    schema_version: 1,
    contract_version: String(schema?.storage_version || ""),
    captured_at: capturedAt,
    ok: false,
    writes_allowed: false,
    manual_business_row_relocation_allowed: false,
    business_row_relocation_mode: "copy_confirm_delete_only",
    routes: [],
    rejects: [],
    counts: { examined: 0, active: 0, terminal: 0, planned: 0, rejected: 0 }
  };
  const schemaErrors = validatePipelineSchema(schema);
  for (const summary of schemaErrors) {
    planReject(plan, "invalid_schema", { summary });
  }
  if (!validTimestamp(capturedAt)) {
    planReject(plan, "invalid_snapshot", {
      summary: "captured_at must be a valid exact-reread timestamp"
    });
  }
  if (snapshot?.contract_version !== schema?.storage_version) {
    planReject(plan, "contract_mismatch", {
      summary: "snapshot contract does not match the pinned release"
    });
  }
  const stores = snapshot?.stores;
  const expectedStores = [...(schema?.business_stores || [])].sort();
  if (
    !stores ||
    typeof stores !== "object" ||
    Array.isArray(stores) ||
    JSON.stringify(Object.keys(stores).sort()) !== JSON.stringify(expectedStores)
  ) {
    planReject(plan, "invalid_snapshot", {
      summary: "snapshot must contain exactly the authoritative business stores"
    });
    plan.counts.rejected = plan.rejects.length;
    return plan;
  }
  const claims = Array.isArray(snapshot?.active_claims)
    ? snapshot.active_claims
    : null;
  if (!claims) {
    planReject(plan, "invalid_snapshot", {
      summary: "active_claims must be an array"
    });
  } else if (validTimestamp(capturedAt)) {
    for (const claim of claims) {
      if (!validTimestamp(claim?.expires_at)) {
        planReject(plan, "malformed_claim", {
          canonical_job_id: claim?.canonical_job_id,
          summary: "claim expiry is invalid"
        });
      } else if (Date.parse(claim.expires_at) > Date.parse(capturedAt)) {
        planReject(plan, "active_claim", {
          canonical_job_id: claim?.canonical_job_id,
          summary: "unexpired claim must drain before migration"
        });
      }
    }
  }
  const owners = new Map();
  for (const store of schema.business_stores || []) {
    if (!Array.isArray(stores[store])) {
      planReject(plan, "invalid_snapshot", {
        source_store: store,
        summary: "business store rows must be arrays"
      });
      continue;
    }
    for (const [index, raw] of stores[store].entries()) {
      plan.counts.examined += 1;
      const rowNumber = Number.isInteger(raw?.row_number)
        ? raw.row_number
        : index + 2;
      const record = normalizeLegacyRecord(raw, schema, capturedAt);
      const identity = identityKey(record.canonical_job_id);
      if (!identity) {
        planReject(plan, "invalid_identity", {
          source_store: store,
          source_row_number: rowNumber,
          summary: "canonical identity is missing"
        });
        continue;
      }
      if (owners.has(identity)) {
        planReject(plan, "duplicate_identity", {
          source_store: store,
          source_row_number: rowNumber,
          canonical_job_id: record.canonical_job_id,
          summary: "canonical identity has more than one source owner"
        });
        continue;
      }
      owners.set(identity, { store, rowNumber });
      if (record.processing_token || record.alert_claim_token) {
        planReject(plan, "active_claim", {
          source_store: store,
          source_row_number: rowNumber,
          canonical_job_id: record.canonical_job_id,
          summary: "persisted row claim must drain before migration"
        });
        continue;
      }
      if (!stateGuardMatches(record)) {
        planReject(plan, "stale_state_guard", {
          source_store: store,
          source_row_number: rowNumber,
          canonical_job_id: record.canonical_job_id,
          summary: "persisted state guard does not match the exact reread"
        });
        continue;
      }
      const contractErrors = validateRecordStoreContract(record, store, schema);
      if (contractErrors.length > 0) {
        planReject(plan, "unsupported_record", {
          source_store: store,
          source_row_number: rowNumber,
          canonical_job_id: record.canonical_job_id,
          summary: contractErrors.join("; ")
        });
        continue;
      }
      const disposition = migrationDisposition(store, record, schema);
      plan.routes.push({
        source_store: store,
        source_row_number: rowNumber,
        canonical_job_id: record.canonical_job_id,
        canonical_identity_sha256: sha256(identity),
        source_record_version: record.record_version,
        source_state_guard: record.state_guard,
        ...disposition
      });
      if (ACTIVE_STORES.has(store)) plan.counts.active += 1;
      if (TERMINAL_STORES.has(store)) plan.counts.terminal += 1;
    }
  }
  plan.routes.sort(
    (left, right) =>
      schema.business_stores.indexOf(left.source_store) -
        schema.business_stores.indexOf(right.source_store) ||
      left.source_row_number - right.source_row_number ||
      left.canonical_job_id.localeCompare(right.canonical_job_id)
  );
  plan.counts.planned = plan.routes.length;
  plan.counts.rejected = plan.rejects.length;
  plan.ok = plan.rejects.length === 0;
  return plan;
}

export function validateAutonomousBrowserCutoverEvidence(policy, evidence) {
  const errors = [];
  const mixed = policy?.mixed_cutover ?? {};
  const phase = evidence?.phase;
  const post = phase === "post_activation";
  const prepared = phase === "pre_activation" || post;
  requireExactObjectKeys(
    evidence,
    [
      "schema_version",
      "phase",
      "policy_version",
      "deployment_commit",
      "captured_at",
      "privacy",
      "n8n_workflows",
      "retired_generator",
      "scheduled_task",
      "instance_inventory",
      "backups",
      "preflight",
      "migration",
      "capability",
      "activation",
      "controls",
      "rollback",
      "observations"
    ],
    "autonomous cutover evidence",
    errors
  );
  requireExactObjectKeys(
    evidence?.privacy,
    [
      "sanitized",
      "secret_scan_clean",
      "messages_included",
      "descriptions_included",
      "dom_included",
      "screenshots_included",
      "cookies_or_credentials_included",
      "browser_history_included"
    ],
    "privacy",
    errors
  );
  if (evidence?.schema_version !== 1) {
    errors.push("autonomous cutover evidence schema_version must be 1");
  }
  if (!PHASES.has(phase)) errors.push("autonomous cutover evidence phase is invalid");
  if (evidence?.policy_version !== policy?.policy_version) {
    errors.push("autonomous cutover evidence policy_version is stale");
  }
  if (!/^[0-9a-f]{40}$/.test(String(evidence?.deployment_commit || ""))) {
    errors.push("deployment_commit must be an exact 40-character commit");
  }
  if (!validTimestamp(evidence?.captured_at)) {
    errors.push("captured_at must be a valid timestamp");
  }
  const capturedAtMs = Date.parse(evidence?.captured_at || "");
  if (sensitiveMaterialPresent(evidence)) {
    errors.push("autonomous cutover evidence contains private or secret material");
  }
  for (const field of ["sanitized", "secret_scan_clean"]) {
    if (evidence?.privacy?.[field] !== true) {
      errors.push(`privacy.${field} must be true`);
    }
  }
  for (const field of [
    "messages_included",
    "descriptions_included",
    "dom_included",
    "screenshots_included",
    "cookies_or_credentials_included",
    "browser_history_included"
  ]) {
    if (evidence?.privacy?.[field] !== false) {
      errors.push(`privacy.${field} must be false`);
    }
  }

  const expectedRoles = mixed.n8n_roles ?? [];
  const workflows = Array.isArray(evidence?.n8n_workflows)
    ? evidence.n8n_workflows
    : [];
  if (
    workflows.length !== expectedRoles.length ||
    !exactSet(
      workflows.map((entry) => entry.role),
      expectedRoles.map((entry) => entry.role)
    )
  ) {
    errors.push("evidence must contain exactly the two n8n role records");
  }
  for (const [index, workflow] of workflows.entries()) {
    requireExactObjectKeys(
      workflow,
      [
        "role",
        "workflow_id",
        "workflow_version",
        "artifact_digest",
        "binding_digest",
        "timezone",
        "execution_timeout_seconds",
        "active",
        "observed_at"
      ],
      `n8n_workflows[${index}]`,
      errors
    );
  }
  requireExactObjectKeys(
    evidence?.retired_generator,
    ["workflow_id", "artifact_digest", "active", "observed_at"],
    "retired_generator",
    errors
  );
  for (const expected of expectedRoles) {
    const actual = workflows.find((entry) => entry.role === expected.role);
    if (!actual) continue;
    const commonInvalid =
      !boundedIdentifier(actual.workflow_id) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(actual.artifact_digest || "")) ||
      !boundedIdentifier(actual.workflow_version) ||
      !sha256Digest(actual.binding_digest) ||
      actual.timezone !== expected.timezone ||
      actual.execution_timeout_seconds !== expected.execution_timeout_seconds ||
      !validTimestamp(actual.observed_at) ||
      Date.parse(actual.observed_at) > capturedAtMs;
    const targetInvalid =
      prepared &&
      (actual.workflow_id !== expected.target_workflow_id ||
        actual.artifact_digest !== expected.artifact_digest);
    if (commonInvalid || targetInvalid) {
      errors.push(`${expected.role} n8n identity or runtime evidence is stale`);
    }
    const expectedActive = phase === "pre_activation" ? false : true;
    if (actual.active !== expectedActive) {
      errors.push(`${expected.role} active state does not match ${phase}`);
    }
  }
  if (
    evidence?.retired_generator?.workflow_id !==
      mixed?.retired_generator?.target_workflow_id ||
    evidence?.retired_generator?.artifact_digest !==
      mixed?.retired_generator?.last_manual_contract_artifact_digest ||
    (prepared && evidence?.retired_generator?.active !== false) ||
    !validTimestamp(evidence?.retired_generator?.observed_at) ||
    Date.parse(evidence?.retired_generator?.observed_at) > capturedAtMs
  ) {
    errors.push("retired Generator state is incomplete or unsafe");
  }

  const task = evidence?.scheduled_task ?? {};
  requireExactObjectKeys(
    task,
    [
      "task_id",
      "state",
      "contract_version",
      "artifact_digest",
      "prompt_digest",
      "skill_version",
      "protocol_version",
      "task_version",
      "binding_digest",
      "attestation_key_id",
      "attestation_public_key_spki_sha256",
      "click_receipt_store_id",
      "click_receipt_ledger_id",
      "click_receipt_generation_id",
      "click_receipt_manifest_sha256",
      "click_receipt_binding_digest",
      "click_receipt_directory_identity",
      "click_receipt_witness_identity",
      "observed_at"
    ],
    "scheduled_task",
    errors
  );
  if (
    task.contract_version !== mixed?.scheduled_task?.contract_version ||
    task.artifact_digest !== mixed?.scheduled_task?.artifact_digest ||
    task.prompt_digest !== mixed?.scheduled_task?.prompt_digest ||
    task.skill_version !== mixed?.scheduled_task?.skill_version ||
    task.protocol_version !== mixed?.scheduled_task?.protocol_version
    || task.attestation_key_id !== mixed?.scheduled_task?.attestation_key_id
    || task.attestation_public_key_spki_sha256 !==
      mixed?.scheduled_task?.attestation_public_key_spki_sha256
    || task.click_receipt_store_id !==
      mixed?.scheduled_task?.click_receipt_store_id
    || task.click_receipt_ledger_id !==
      mixed?.scheduled_task?.click_receipt_ledger_id
    || task.click_receipt_generation_id !==
      mixed?.scheduled_task?.click_receipt_generation_id
    || task.click_receipt_manifest_sha256 !==
      mixed?.scheduled_task?.click_receipt_manifest_sha256
    || task.click_receipt_binding_digest !==
      mixed?.scheduled_task?.click_receipt_directory_binding_digest
    || task.click_receipt_directory_identity !==
      mixed?.scheduled_task?.click_receipt_directory_identity
    || task.click_receipt_witness_identity !==
      mixed?.scheduled_task?.click_receipt_witness_identity
  ) {
    errors.push("scheduled browser task compatibility evidence is stale");
  }
  if (
    prepared &&
    (
      !/^browser-click-store-v1:[a-f0-9]{64}$/.test(
        String(task.click_receipt_store_id || "")
      ) ||
      !/^browser-click-ledger-v1:[a-f0-9]{64}$/.test(
        String(task.click_receipt_ledger_id || "")
      ) ||
      !/^browser-click-generation-v1:[a-f0-9]{64}$/.test(
        String(task.click_receipt_generation_id || "")
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(
        String(task.click_receipt_manifest_sha256 || "")
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(
        String(task.click_receipt_binding_digest || "")
      ) ||
      !/^fs-object-v1:[0-9]+:[0-9]+:[0-9]+$/.test(
        String(task.click_receipt_directory_identity || "")
      ) ||
      !/^fs-object-v1:[0-9]+:[0-9]+:[0-9]+$/.test(
        String(task.click_receipt_witness_identity || "")
      )
    )
  ) {
    errors.push("scheduled browser click-receipt store is not provisioned and bound");
  }
  const expectedTaskState =
    phase === "pre_cutover" ? "absent" : post ? "active" : "paused";
  if (task.state !== expectedTaskState) {
    errors.push(`scheduled browser task must be ${expectedTaskState} in ${phase}`);
  }
  if (task.state !== "absent" && !boundedIdentifier(task.task_id, 120)) {
    errors.push("scheduled browser task ID is missing");
  }
  if (task.state !== "absent" && !validTimestamp(task.observed_at)) {
    errors.push("scheduled browser task observation timestamp is missing");
  }
  if (task.state !== "absent" && Date.parse(task.observed_at) > capturedAtMs) {
    errors.push("scheduled browser task observation cannot be after capture");
  }
  if (
    task.state !== "absent" &&
    (!boundedIdentifier(task.task_version) || !sha256Digest(task.binding_digest))
  ) {
    errors.push("scheduled browser task version or binding evidence is missing");
  }
  if (
    prepared &&
    (!boundedIdentifier(task.attestation_key_id, 120) ||
      task.attestation_key_id === "unprovisioned" ||
      !/^sha256:[a-f0-9]{64}$/.test(
        String(task.attestation_public_key_spki_sha256 || "")
      ))
  ) {
    errors.push("scheduled browser task attestation trust root is unprovisioned");
  }

  const inventory = evidence?.instance_inventory ?? {};
  requireExactObjectKeys(
    inventory,
    [
      "scraper_active_count",
      "alerter_mover_active_count",
      "browser_task_count",
      "retired_generator_active_count",
      "duplicate_role_or_task_count",
      "active_verification_copy_count",
      "observed_at"
    ],
    "instance_inventory",
    errors
  );
  const expectedActiveCount = phase === "pre_activation" ? 0 : 1;
  if (
    inventory.scraper_active_count !== expectedActiveCount ||
    inventory.alerter_mover_active_count !== expectedActiveCount ||
    inventory.browser_task_count !== (prepared ? 1 : 0) ||
    inventory.retired_generator_active_count !== (phase === "pre_cutover" ? 1 : 0) ||
    inventory.duplicate_role_or_task_count !== 0 ||
    inventory.active_verification_copy_count !== 0 ||
    !validTimestamp(inventory.observed_at) ||
    Date.parse(inventory.observed_at) > capturedAtMs
  ) {
    errors.push("instance workflow/task inventory is incomplete or unsafe");
  }

  const backupKinds = (evidence?.backups ?? []).map((entry) => entry?.kind);
  const requiredBackups = mixed?.evidence_contract?.required_backup_kinds ?? [];
  if (!exactSet(backupKinds, requiredBackups)) {
    errors.push("backup evidence must cover every mixed-contract asset exactly once");
  }
  for (const [index, backup] of (evidence?.backups ?? []).entries()) {
    requireExactObjectKeys(
      backup,
      ["kind", "reference", "sha256", "readable", "restore_identifier_verified"],
      `backups[${index}]`,
      errors
    );
    if (
      !boundedIdentifier(backup?.reference, 160) ||
      !/^[0-9a-f]{64}$/.test(String(backup?.sha256 || "")) ||
      backup?.readable !== true ||
      backup?.restore_identifier_verified !== true
    ) {
      errors.push(`backup ${String(backup?.kind || "(missing)")} is not restore-ready`);
    }
  }

  requireExactObjectKeys(
    evidence?.preflight,
    [
      "duplicate_owner_count",
      "active_claim_count",
      "partial_unknown_move_count",
      "malformed_receipt_count",
      "unsupported_manual_action_count",
      "policy_or_schema_drift_count",
      "wrong_binding_count",
      "fresh_exact_reread",
      "all_writers_frozen",
      "passed",
      "snapshot_digest",
      "ownership_digest",
      "store_row_counts",
      "browser_state_counts",
      "receipt_status_counts",
      "compatibility"
    ],
    "preflight",
    errors
  );

  for (const field of [
    "duplicate_owner_count",
    "active_claim_count",
    "partial_unknown_move_count",
    "malformed_receipt_count",
    "unsupported_manual_action_count",
    "policy_or_schema_drift_count",
    "wrong_binding_count"
  ]) {
    if (!positiveCount(evidence?.preflight?.[field])) {
      errors.push(`preflight.${field} must be a non-negative integer`);
    } else if (evidence.preflight[field] !== 0) {
      errors.push(`preflight.${field} must be zero before cutover`);
    }
  }
  for (const field of ["fresh_exact_reread", "all_writers_frozen", "passed"]) {
    if (evidence?.preflight?.[field] !== true) {
      errors.push(`preflight.${field} must be true`);
    }
  }
  if (
    !sha256Digest(evidence?.preflight?.snapshot_digest) ||
    !sha256Digest(evidence?.preflight?.ownership_digest)
  ) {
    errors.push("preflight snapshot and ownership digests must be exact SHA-256 values");
  }
  for (const [field, keys] of [
    ["store_row_counts", BUSINESS_STORE_COUNT_KEYS],
    ["browser_state_counts", BROWSER_STATE_COUNT_KEYS],
    ["receipt_status_counts", RECEIPT_STATUS_COUNT_KEYS]
  ]) {
    const counts = evidence?.preflight?.[field];
    requireExactObjectKeys(counts, keys, `preflight.${field}`, errors);
    if (Object.values(counts ?? {}).some((value) => !positiveCount(value))) {
      errors.push(`preflight.${field} must contain only non-negative integers`);
    }
  }
  const storeCounts = evidence?.preflight?.store_row_counts ?? {};
  const browserStateCounts = evidence?.preflight?.browser_state_counts ?? {};
  if (
    Object.keys(storeCounts).length === BUSINESS_STORE_COUNT_KEYS.length &&
    Object.keys(browserStateCounts).length === BROWSER_STATE_COUNT_KEYS.length &&
    Object.values(storeCounts).every(positiveCount) &&
    Object.values(browserStateCounts).every(positiveCount) &&
    Object.values(storeCounts).reduce((total, count) => total + count, 0) !==
      Object.values(browserStateCounts).reduce((total, count) => total + count, 0)
  ) {
    errors.push(
      "preflight business-store and browser-state row totals must match"
    );
  }
  const expectedCompatibility = policy?.application_compatibility ?? {};
  requireExactObjectKeys(
    evidence?.preflight?.compatibility,
    Object.keys(expectedCompatibility),
    "preflight.compatibility",
    errors
  );
  for (const [field, expected] of Object.entries(expectedCompatibility)) {
    if (evidence?.preflight?.compatibility?.[field] !== expected) {
      errors.push(`preflight.compatibility.${field} is stale`);
    }
  }

  const migration = evidence?.migration ?? {};
  requireExactObjectKeys(
    migration,
    [
      "active_legacy_rows",
      "classified_rows",
      "executed_rows",
      "route_count",
      "rejected_rows",
      "duplicate_owner_count",
      "preserved_field_mismatch_count",
      "plan_digest",
      "copy_confirm_delete_only",
      "no_manual_relocation"
    ],
    "migration",
    errors
  );
  for (const field of [
    "active_legacy_rows",
    "classified_rows",
    "executed_rows",
    "route_count",
    "rejected_rows",
    "duplicate_owner_count",
    "preserved_field_mismatch_count"
  ]) {
    if (!positiveCount(migration[field])) {
      errors.push(`migration.${field} must be a non-negative integer`);
    }
  }
  if (
    migration.active_legacy_rows !== migration.classified_rows ||
    migration.route_count !== migration.classified_rows ||
    migration.rejected_rows !== 0 ||
    migration.duplicate_owner_count !== 0 ||
    migration.preserved_field_mismatch_count !== 0 ||
    !sha256Digest(migration.plan_digest) ||
    (post
      ? migration.executed_rows > migration.classified_rows
      : migration.executed_rows !== 0) ||
    migration.copy_confirm_delete_only !== true ||
    migration.no_manual_relocation !== true
  ) {
    errors.push("legacy migration accounting or movement boundary is incomplete");
  }

  const capability = evidence?.capability ?? {};
  requireExactObjectKeys(
    capability,
    [
      "chrome_plugin_enabled",
      "correct_profile",
      "onlinejobs_allowlisted",
      "signed_in_session_valid",
      "local_project_selected",
      "skill_invocation_verified",
      "mock_sequence_passed",
      "single_use_click_receipt_verified",
      "dual_anchor_rollback_verified",
      "effective_form_submitter_verified",
      "deterministic_apply_points_verified",
      "independent_attestation_adapter_verified",
      "attestation_public_key_verified",
      "unattended_submit_status",
      "activation_allowed"
    ],
    "capability",
    errors
  );
  if (prepared) {
    for (const field of [
      "chrome_plugin_enabled",
      "correct_profile",
      "onlinejobs_allowlisted",
      "signed_in_session_valid",
      "local_project_selected",
      "skill_invocation_verified",
      "mock_sequence_passed",
      "single_use_click_receipt_verified",
      "dual_anchor_rollback_verified",
      "effective_form_submitter_verified",
      "deterministic_apply_points_verified",
      "independent_attestation_adapter_verified",
      "attestation_public_key_verified"
    ]) {
      if (capability[field] !== true) {
        errors.push(`capability.${field} must be true before activation`);
      }
    }
  }
  if (!new Set(["not_tested", "proven", "blocked_confirmation"]).has(
    capability.unattended_submit_status
  )) {
    errors.push("capability unattended_submit_status is invalid");
  }
  if (
    (prepared && capability.unattended_submit_status !== "proven") ||
    (capability.unattended_submit_status === "blocked_confirmation" &&
      capability.activation_allowed !== false) ||
    (prepared && capability.activation_allowed !== true)
  ) {
    errors.push("unattended submit capability does not permit this phase");
  }

  const activation = evidence?.activation ?? {};
  requireExactObjectKeys(
    activation,
    [
      "order",
      "retired_generator_inactive_before_browser",
      "no_mixed_writer_window",
      "completed"
    ],
    "activation",
    errors
  );
  if (!exactArray(activation.order, mixed?.activation_order ?? [])) {
    errors.push("activation order does not match the reviewed contract");
  }
  if (
    activation.retired_generator_inactive_before_browser !== true ||
    activation.no_mixed_writer_window !== true ||
    activation.completed !== post
  ) {
    errors.push("activation ordering evidence is incomplete");
  }

  const requiredCases = mixed?.evidence_contract?.required_control_cases ?? [];
  const controls = Array.isArray(evidence?.controls) ? evidence.controls : [];
  if (!exactSet(controls.map((entry) => entry.case_id), requiredCases)) {
    errors.push("control evidence must cover every required case exactly once");
  }
  if (prepared && controls.some((entry) => entry.passed !== true)) {
    errors.push("every pre-activation and post-activation control must pass");
  }
  for (const [index, control] of controls.entries()) {
    requireExactObjectKeys(
      control,
      ["case_id", "passed", "evidence_reference", "result_digest", "observed_at"],
      `controls[${index}]`,
      errors
    );
    if (
      !boundedIdentifier(control?.evidence_reference) ||
      !sha256Digest(control?.result_digest) ||
      !validTimestamp(control?.observed_at) ||
      Date.parse(control?.observed_at) > capturedAtMs
    ) {
      errors.push(`control ${String(control?.case_id || "(missing)")} evidence is incomplete`);
    }
  }

  const rollback = evidence?.rollback ?? {};
  requireExactObjectKeys(
    rollback,
    [
      "documented",
      "verified_without_execution",
      "disable_order",
      "restore_order",
      "compatibility_limits_recorded",
      "manual_row_relocation_required",
      "prior_assets"
    ],
    "rollback",
    errors
  );
  if (
    rollback.documented !== true ||
    rollback.verified_without_execution !== true ||
    !exactArray(rollback.disable_order, mixed?.rollback_disable_order ?? []) ||
    !exactArray(rollback.restore_order, mixed?.rollback_restore_order ?? []) ||
    rollback.compatibility_limits_recorded !== true ||
    rollback.manual_row_relocation_required !== false
  ) {
    errors.push("rollback evidence is incomplete or unsafe");
  }
  const priorAssets = Array.isArray(rollback.prior_assets)
    ? rollback.prior_assets
    : [];
  const restoreOrder = mixed?.rollback_restore_order ?? [];
  if (!exactArray(priorAssets.map((asset) => asset.kind), restoreOrder)) {
    errors.push("rollback prior assets are incomplete");
  }
  const backupsByKind = new Map(
    (Array.isArray(evidence?.backups) ? evidence.backups : []).map((backup) => [
      backup?.kind,
      backup
    ])
  );
  for (const [index, asset] of priorAssets.entries()) {
    requireExactObjectKeys(
      asset,
      ["kind", "restore_id", "version", "sha256", "compatibility_verified"],
      `rollback.prior_assets[${index}]`,
      errors
    );
    const backup = backupsByKind.get(asset?.kind);
    if (
      !boundedIdentifier(asset?.restore_id) ||
      !boundedIdentifier(asset?.version) ||
      !sha256Digest(asset?.sha256) ||
      asset?.compatibility_verified !== true ||
      asset?.restore_id !== backup?.reference ||
      asset?.sha256 !== backup?.sha256
    ) {
      errors.push(`rollback asset ${String(asset?.kind || "(missing)")} is not exact or compatible`);
    }
  }

  if (post) {
    requireExactObjectKeys(
      evidence?.observations,
      [
        "started_at",
        "completed_at",
        "scheduled_run_ids",
        "outcome_counts",
        "confirmation_digest_count",
        "duplicate_submission_count",
        "movement_recovery_count",
        "claim_recovery_count",
        "rollback_status",
        "retired_generator_run_count"
      ],
      "observations",
      errors
    );
    requireExactObjectKeys(
      evidence?.observations?.scheduled_run_ids,
      ["scraper", "browser_executor", "alerter_mover"],
      "observations.scheduled_run_ids",
      errors
    );
    requireExactObjectKeys(
      evidence?.observations?.outcome_counts,
      OBSERVATION_OUTCOME_KEYS,
      "observations.outcome_counts",
      errors
    );
    const observationMs =
      Date.parse(evidence?.observations?.completed_at || "") -
      Date.parse(evidence?.observations?.started_at || "");
    const scheduledRunIds = Object.values(
      evidence?.observations?.scheduled_run_ids ?? {}
    );
    const outcomeCounts = evidence?.observations?.outcome_counts ?? {};
    if (
      !Number.isFinite(observationMs) ||
      Date.parse(evidence?.observations?.started_at || "") >
        Date.parse(evidence?.observations?.completed_at || "") ||
      Date.parse(evidence?.observations?.completed_at || "") > capturedAtMs ||
      observationMs <
        Number(mixed?.evidence_contract?.minimum_observation_minutes || 0) *
          60_000 ||
      !exactSet(Object.keys(evidence?.observations?.scheduled_run_ids ?? {}), [
        "scraper",
        "browser_executor",
        "alerter_mover"
      ]) ||
      scheduledRunIds.some((value) => !boundedIdentifier(value)) ||
      new Set(scheduledRunIds).size !== scheduledRunIds.length ||
      !exactSet(Object.keys(outcomeCounts), OBSERVATION_OUTCOME_KEYS) ||
      Object.values(outcomeCounts).some((value) => !positiveCount(value)) ||
      !positiveCount(evidence?.observations?.confirmation_digest_count) ||
      evidence.observations.confirmation_digest_count < 1 ||
      evidence?.observations?.duplicate_submission_count !== 0 ||
      !positiveCount(evidence?.observations?.movement_recovery_count) ||
      evidence.observations.movement_recovery_count < 1 ||
      !positiveCount(evidence?.observations?.claim_recovery_count) ||
      evidence?.observations?.rollback_status !== "not_triggered" ||
      evidence?.observations?.retired_generator_run_count !== 0
    ) {
      errors.push("post-activation scheduled observation is incomplete");
    }
  } else {
    requireExactObjectKeys(evidence?.observations, [], "observations", errors);
  }
  return errors;
}
