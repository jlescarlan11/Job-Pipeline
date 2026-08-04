import { createHash } from "node:crypto";

import {
  normalizeLegacyRecord,
  normalizeUserAction,
  isGuardedLegacyReviewAction,
  preparationInputGuard,
  reviewCaseId,
  stateGuardMatches,
  validatePipelineSchema,
  validateRecordStoreContract
} from "./contracts.mjs";

export const REVIEW_PREPARATION_REGRESSION_IDS = Object.freeze([
  "1699999",
  "1589947",
  "1701320",
  "1701315",
  "1701179"
]);

const ROLES = ["scraper", "evaluator_generator", "alerter_mover"];
const EVIDENCE_PHASES = new Set(["pre_cutover", "post_cutover"]);
const PREPARATION_OUTCOMES = new Set([
  "pending",
  "message_ready",
  "needs_input",
  "external_steps",
  "repair_pending",
  "preparation_error",
  "applied",
  "skipped",
  "rejected",
  "unresolved_review"
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function bounded(value, maximum = 240) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(
      /(?:authorization|api[-_ ]?key|token|secret|webhook)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
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

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value || ""));
}

function basePlan(schema, capturedAt) {
  return {
    schema_version: 1,
    contract_version: schema?.storage_version || "",
    captured_at: capturedAt,
    ok: false,
    writes_allowed: false,
    manual_business_row_relocation_allowed: false,
    business_row_relocation_mode: "copy_confirm_delete_only",
    write_operations: [],
    routes: [],
    rejects: [],
    counts: {
      examined: 0,
      affected_legacy: 0,
      planned: 0,
      rejected: 0
    },
    named_regression_ids: [...REVIEW_PREPARATION_REGRESSION_IDS]
  };
}

function reject(plan, category, details = {}) {
  plan.rejects.push({
    category,
    source_store: bounded(details.source_store, 40),
    row_number: Number.isInteger(details.row_number)
      ? details.row_number
      : null,
    canonical_job_id: bounded(details.canonical_job_id, 120),
    summary: bounded(details.summary)
  });
}

function messageAuthorization(snapshot, record, schema, capturedAt) {
  const authorizations = Array.isArray(snapshot?.message_authorizations)
    ? snapshot.message_authorizations
    : [];
  const matches = authorizations.filter(
    (entry) =>
      identityKey(entry?.canonical_job_id) ===
      identityKey(record.canonical_job_id)
  );
  if (matches.length !== 1) return false;
  const authorization = matches[0];
  return Boolean(
    authorization.authorized === true &&
      authorization.authorization_kind === "persisted_message_safety" &&
      authorization.contract_version === schema.storage_version &&
      authorization.state_guard === record.state_guard &&
      authorization.preparation_input_guard ===
        preparationInputGuard(record) &&
      authorization.message_sha256 === sha256(record.generated_message) &&
      validTimestamp(authorization.checked_at) &&
      Date.parse(authorization.checked_at) <= Date.parse(capturedAt) &&
      record.application_pack_status === "ready" &&
      record.message_validation_status === "valid" &&
      Boolean(record.generated_message) &&
      Boolean(record.message_profile_version) &&
      Boolean(record.message_policy_version)
  );
}

function isPreparationLess(raw, record) {
  return (
    !String(raw?.prep_status || "").trim() &&
    Number(record.preparation_version || 0) === 0 &&
    !record.preparation_input_guard &&
    !record.preparation_updated_at
  );
}

function classifyRow(sourceStore, raw, record, snapshot, schema, capturedAt) {
  const rawAction = String(raw?.user_action || "").trim();
  const normalizedAction = normalizeUserAction(rawAction, schema);
  const base = {
    source_store: sourceStore,
    source_row_number: Number.isInteger(raw?.row_number)
      ? raw.row_number
      : null,
    canonical_job_id: record.canonical_job_id,
    canonical_identity_sha256: sha256(identityKey(record.canonical_job_id)),
    raw_action: rawAction,
    normalized_decision: "retain",
    target_store: sourceStore,
    target_pipeline_status: record.pipeline_status,
    target_review_case_id: record.review_case_id || "",
    target_review_decision: record.review_decision || "",
    target_prep_status: record.prep_status || "",
    required_guarded_workflow_path: "none_no_business_transition",
    bounded_reject_reason: "",
    source_record_version: record.record_version,
    source_state_guard: record.state_guard
  };

  if (sourceStore === "To Review") {
    if (record.pipeline_status !== "review_needed") {
      throw new Error("To Review requires review_needed");
    }
    base.target_review_case_id = record.review_case_id || reviewCaseId(record);
    if (normalizedAction === "") {
      return {
        ...base,
        normalized_decision: "unresolved",
        target_review_decision: "",
        required_guarded_workflow_path:
          "operator_review_then_alerter_mover_copy_confirm_delete"
      };
    }
    if (normalizedAction === "Proceed") {
      return {
        ...base,
        normalized_decision: "proceed",
        target_store: "To Apply",
        target_pipeline_status: "ready_to_apply",
        target_review_decision: "proceed",
        target_prep_status: "pending",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete_then_generator_prepare_in_place"
      };
    }
    if (normalizedAction === "Reject") {
      return {
        ...base,
        normalized_decision: "reject",
        target_store: "Archive",
        target_review_decision: "reject",
        target_prep_status: "",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete",
        bounded_reject_reason: "review_denied"
      };
    }
    throw new Error("To Review action is unsupported");
  }

  if (sourceStore === "To Apply") {
    if (record.pipeline_status !== "ready_to_apply") {
      throw new Error("To Apply requires ready_to_apply");
    }
    if (normalizedAction === "I Applied") {
      return {
        ...base,
        normalized_decision: "applied",
        target_store: "Applied Jobs",
        target_prep_status: "",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete"
      };
    }
    if (normalizedAction === "Skip") {
      return {
        ...base,
        normalized_decision: "skip",
        target_store: "Archive",
        target_prep_status: "",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete",
        bounded_reject_reason: "user_skip"
      };
    }
    if (normalizedAction !== "") {
      throw new Error("To Apply action is unsupported");
    }
    if (isPreparationLess(raw, record)) {
      const authorized = messageAuthorization(
        snapshot,
        record,
        schema,
        capturedAt
      );
      return {
        ...base,
        normalized_decision: record.review_approved_at
          ? "legacy_proceed"
          : "legacy_direct_ready",
        target_review_case_id:
          record.review_case_id ||
          (record.review_approved_at ? reviewCaseId(record) : ""),
        target_review_decision: record.review_approved_at
          ? "proceed"
          : record.review_decision,
        target_prep_status: authorized
          ? "message_ready"
          : "preparation_error",
        required_guarded_workflow_path:
          "generator_guarded_legacy_claim_and_reauthorization",
        bounded_reject_reason: authorized
          ? ""
          : "current_message_authorization_missing_or_stale"
      };
    }
    return base;
  }

  if (sourceStore === "Scraped Jobs") {
    if (isGuardedLegacyReviewAction(record, sourceStore, schema)) {
      if (normalizedAction === "Proceed") {
        return {
          ...base,
          normalized_decision: "proceed",
          target_store: "To Apply",
          target_pipeline_status: "ready_to_apply",
          target_review_case_id: record.review_case_id || reviewCaseId(record),
          target_review_decision: "proceed",
          target_prep_status: "pending",
          required_guarded_workflow_path:
            "alerter_mover_copy_confirm_delete_then_generator_prepare_in_place"
        };
      }
      return {
        ...base,
        normalized_decision: "reject",
        target_store: "Archive",
        target_review_case_id: record.review_case_id || reviewCaseId(record),
        target_review_decision: "reject",
        target_prep_status: "",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete",
        bounded_reject_reason: "review_denied"
      };
    }
    if (normalizedAction !== "") {
      throw new Error("Scraped Jobs cannot contain a non-legacy operator action");
    }
    if (record.pipeline_status === "ready_to_apply") {
      return {
        ...base,
        normalized_decision: "direct_ready",
        target_store: "To Apply",
        required_guarded_workflow_path:
          "alerter_mover_copy_confirm_delete"
      };
    }
    return base;
  }

  if (["Applied Jobs", "Archive"].includes(sourceStore)) {
    if (normalizedAction !== "") {
      throw new Error(`${sourceStore} cannot contain an operator action`);
    }
    return base;
  }
  throw new Error("Business store is unsupported");
}

/**
 * Produces a deterministic private plan. It performs no writes and never
 * authorizes direct row relocation; execution must reread every source guard
 * and use the generated Alerter & Mover or Generator path named by each route.
 */
export function planReviewPreparationMigration(snapshot, schema) {
  const capturedAt = snapshot?.captured_at || "";
  const plan = basePlan(schema, capturedAt);
  const schemaErrors = validatePipelineSchema(schema);
  if (schemaErrors.length > 0) {
    for (const summary of schemaErrors) reject(plan, "invalid_schema", { summary });
    plan.counts.rejected = plan.rejects.length;
    return plan;
  }
  if (!validTimestamp(capturedAt)) {
    reject(plan, "invalid_snapshot", {
      summary: "captured_at must be a valid exact-reread timestamp"
    });
  }
  if (snapshot?.contract_version !== schema.storage_version) {
    reject(plan, "contract_mismatch", {
      summary: "snapshot contract does not match the pinned release"
    });
  }
  const stores = snapshot?.stores;
  if (!stores || typeof stores !== "object" || Array.isArray(stores)) {
    reject(plan, "invalid_snapshot", {
      summary: "snapshot stores must be an object"
    });
    plan.counts.rejected = plan.rejects.length;
    return plan;
  }
  const actualStores = Object.keys(stores).sort();
  const expectedStores = [...schema.business_stores].sort();
  if (JSON.stringify(actualStores) !== JSON.stringify(expectedStores)) {
    reject(plan, "contract_mismatch", {
      summary: "snapshot must contain exactly the five business stores"
    });
  }
  for (const store of schema.business_stores) {
    if (!Array.isArray(stores[store])) {
      reject(plan, "invalid_snapshot", {
        source_store: store,
        summary: "business store rows must be an array"
      });
    }
  }

  const claims = Array.isArray(snapshot?.active_claims)
    ? snapshot.active_claims
    : null;
  if (!claims) {
    reject(plan, "invalid_snapshot", {
      summary: "active_claims must be an array"
    });
  } else if (validTimestamp(capturedAt)) {
    for (const claim of claims) {
      const expiry = Date.parse(claim?.expires_at || "");
      if (!Number.isFinite(expiry)) {
        reject(plan, "unsupported_claim", {
          canonical_job_id: claim?.canonical_job_id,
          summary: "claim expiry is missing or invalid"
        });
      } else if (expiry > Date.parse(capturedAt)) {
        reject(plan, "active_claim", {
          canonical_job_id: claim?.canonical_job_id,
          summary:
            claim?.contract_version === schema.storage_version
              ? "an unexpired claim must drain before migration"
              : "an incompatible unexpired claim must drain before migration"
        });
      }
    }
  }

  const owners = new Map();
  if (schema.business_stores.every((store) => Array.isArray(stores[store]))) {
    for (const store of schema.business_stores) {
      for (const [index, raw] of stores[store].entries()) {
        plan.counts.examined += 1;
        const rowNumber = Number.isInteger(raw?.row_number)
          ? raw.row_number
          : index + 2;
        const rawStatus = String(raw?.pipeline_status || "")
          .trim()
          .toLowerCase();
        if (
          !rawStatus ||
          (!schema.pipeline_statuses.includes(rawStatus) &&
            !schema.legacy_status_mapping?.[rawStatus])
        ) {
          reject(plan, "unsupported_state_action", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: raw?.canonical_job_id,
            summary: "pipeline status is missing or unsupported"
          });
          continue;
        }
        if (!String(raw?.state_guard || "").trim()) {
          reject(plan, "stale_state_guard", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: raw?.canonical_job_id,
            summary: "persisted state guard is missing"
          });
          continue;
        }
        const record = normalizeLegacyRecord(raw, schema, capturedAt);
        const identity = identityKey(record.canonical_job_id);
        if (!identity) {
          reject(plan, "invalid_identity", {
            source_store: store,
            row_number: rowNumber,
            summary: "canonical identity is missing"
          });
          continue;
        }
        const previous = owners.get(identity);
        if (previous) {
          reject(plan, "duplicate_identity", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id,
            summary: `identity also exists at ${previous.store} row ${previous.row}`
          });
          continue;
        }
        owners.set(identity, { store, row: rowNumber });
        if (record.processing_token || record.alert_claim_token) {
          reject(plan, "active_claim", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id,
            summary: "a persisted business-row claim must be drained before migration"
          });
          continue;
        }
        if (!stateGuardMatches(record)) {
          reject(plan, "stale_state_guard", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id,
            summary: "persisted guard does not match the fresh row"
          });
          continue;
        }
        const contractErrors = validateRecordStoreContract(record, store, schema);
        if (contractErrors.length > 0) {
          reject(plan, "unsupported_state_action", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id,
            summary: contractErrors.join("; ")
          });
          continue;
        }
        try {
          const route = classifyRow(
            store,
            { ...raw, row_number: rowNumber },
            record,
            snapshot,
            schema,
            capturedAt
          );
          plan.routes.push(route);
          if (
            ["Approve", "Deny"].includes(String(raw?.user_action || "")) ||
            (store === "To Review" && !record.review_case_id) ||
            (store === "To Apply" && isPreparationLess(raw, record))
          ) {
            plan.counts.affected_legacy += 1;
          }
        } catch (error) {
          reject(plan, "unsupported_state_action", {
            source_store: store,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id,
            summary: error?.message || error
          });
        }
      }
    }
  }
  plan.routes.sort(
    (left, right) =>
      schema.business_stores.indexOf(left.source_store) -
        schema.business_stores.indexOf(right.source_store) ||
      Number(left.source_row_number || 0) - Number(right.source_row_number || 0) ||
      left.canonical_job_id.localeCompare(right.canonical_job_id)
  );
  plan.counts.planned = plan.routes.length;
  plan.counts.rejected = plan.rejects.length;
  plan.ok = plan.rejects.length === 0;
  return plan;
}

function safeReference(value) {
  const text = String(value || "");
  return (
    text.length > 0 &&
    text.length <= 200 &&
    !/https?:\/\/|[?&](?:token|signature|sig|key)=|[\r\n\t]/i.test(text)
  );
}

function sensitiveMaterialPresent(value) {
  const serialized = JSON.stringify(value ?? {});
  return /hooks\.slack\.com\/services|bearer\s+[a-z0-9._-]+|api[-_ ]?key\s*[:=]|authorization\s*[:=]|-----begin [a-z ]+private key-----|"(?:generated_message|job_description|canonical_url|job_url)"\s*:|@(?:gmail|yahoo|outlook)\./i.test(
    serialized
  );
}

function requireTrue(object, fields, label, errors) {
  for (const field of fields) {
    if (object?.[field] !== true) errors.push(`${label}.${field} must be true`);
  }
}

function exactNonNegativeCounts(object, fields, label, errors) {
  for (const field of fields) {
    if (!Number.isInteger(object?.[field]) || object[field] < 0) {
      errors.push(`${label}.${field} must be a non-negative integer`);
    }
  }
}

export function validateReviewPreparationCutoverEvidence(
  schema,
  runtime,
  deploymentPolicy,
  alertReceiptPolicy,
  evidence
) {
  const errors = [];
  const post = evidence?.phase === "post_cutover";
  if (evidence?.schema_version !== 1) {
    errors.push("review/preparation evidence schema_version must be 1");
  }
  if (!EVIDENCE_PHASES.has(evidence?.phase)) {
    errors.push("review/preparation evidence phase is invalid");
  }
  if (evidence?.environment !== "production") {
    errors.push("review/preparation evidence must identify production");
  }
  if (evidence?.contract_version !== schema?.storage_version) {
    errors.push("review/preparation evidence contract is stale");
  }
  if (!validTimestamp(evidence?.captured_at)) {
    errors.push("review/preparation captured_at must be a valid timestamp");
  }
  requireTrue(evidence?.privacy, ["sanitized", "secret_scan_clean"], "privacy", errors);
  for (const field of [
    "credentials_included",
    "generated_messages_included",
    "job_descriptions_included",
    "complete_sheet_rows_included"
  ]) {
    if (evidence?.privacy?.[field] !== false) {
      errors.push(`privacy.${field} must be false`);
    }
  }
  if (sensitiveMaterialPresent(evidence)) {
    errors.push("review/preparation evidence contains sensitive material");
  }

  const commit = String(evidence?.release?.commit || "");
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    errors.push("release.commit must be a full commit SHA");
  }
  for (const issue of [75, 76, 77]) {
    if (evidence?.release?.[`issue_${issue}_commit`] !== commit) {
      errors.push(`release.issue_${issue}_commit must equal the pinned commit`);
    }
  }
  requireTrue(
    evidence?.release,
    ["build_passed", "validate_passed", "artifact_drift_clean", "commits_reviewed"],
    "release",
    errors
  );

  const expectedRoles = deploymentPolicy?.workflow_cutover?.roles ?? [];
  const workflows = Array.isArray(evidence?.workflows) ? evidence.workflows : [];
  if (
    workflows.length !== ROLES.length ||
    new Set(workflows.map((workflow) => workflow.role)).size !== ROLES.length
  ) {
    errors.push("exactly one workflow evidence record per role is required");
  }
  for (const role of ROLES) {
    const expected = expectedRoles.find((entry) => entry.role === role);
    const actual = workflows.find((entry) => entry.role === role);
    if (!expected || !actual) continue;
    if (
      actual.id !== expected.target_workflow_id ||
      !safeReference(actual.version_id) ||
      actual.artifact_digest !== expected.artifact_digest ||
      actual.timezone !== runtime?.timezone ||
      actual.execution_timeout_seconds !== expected.execution_timeout_seconds ||
      JSON.stringify(actual.schedule_expressions) !==
        JSON.stringify(expected.schedule_expressions) ||
      actual.queue_binding_environment_variable !==
        deploymentPolicy.workbook_binding
          .queue_spreadsheet_environment_variable ||
      actual.configuration_binding_environment_variable !==
        deploymentPolicy.workbook_binding
          .configuration_spreadsheet_environment_variable
    ) {
      errors.push(`${role} workflow identity or binding evidence is incomplete`);
    }
    if (post ? actual.active !== true : actual.active !== false) {
      errors.push(`${role} active state does not match the evidence phase`);
    }
  }
  requireTrue(
    evidence?.workflow_inventory,
    ["instance_wide", "stale_and_verification_copies_inactive"],
    "workflow_inventory",
    errors
  );
  if (
    evidence?.workflow_inventory?.unrecognized_active_pipeline_writer_count !==
      0 ||
    (post && evidence?.workflow_inventory?.active_role_count !== 3) ||
    (!post && evidence?.workflow_inventory?.active_role_count !== 0)
  ) {
    errors.push("workflow inventory does not prove exact active-role ownership");
  }

  const rowCounts = evidence?.workbook?.row_counts;
  if (
    evidence?.workbook?.pipeline_schema_version !== schema?.schema_version ||
    evidence?.workbook?.storage_version !== schema?.storage_version ||
    !rowCounts ||
    schema.business_stores.some(
      (store) => !Number.isInteger(rowCounts?.[store]) || rowCounts[store] < 0
    ) ||
    evidence?.workbook?.receipt_schema_version !==
      alertReceiptPolicy?.schema_version
  ) {
    errors.push("workbook schema, receipt version, and row counts are incomplete");
  }
  const preIdentityCount = evidence?.workbook?.pre_cutover_identity_count;
  const currentIdentityCount = evidence?.workbook?.authoritative_identity_count;
  const uniqueIdentityCount = evidence?.workbook?.unique_identity_count;
  if (
    !Number.isInteger(preIdentityCount) ||
    preIdentityCount < 0 ||
    !Number.isInteger(currentIdentityCount) ||
    currentIdentityCount < 0 ||
    schema.business_stores.reduce(
      (total, store) => total + Number(rowCounts?.[store] || 0),
      0
    ) !== currentIdentityCount ||
    uniqueIdentityCount !== currentIdentityCount ||
    evidence?.workbook?.duplicate_identity_count !== 0 ||
    evidence?.workbook?.unexplained_loss_count !== 0 ||
    (post && currentIdentityCount !== preIdentityCount)
  ) {
    errors.push("workbook canonical-owner reconciliation is incomplete");
  }
  requireTrue(
    evidence?.workbook,
    ["operator_values_preserved", "business_rows_preserved_by_setup", "zero_seed_rows_created", "setup_idempotent"],
    "workbook",
    errors
  );

  const requiredBackups = new Set(
    deploymentPolicy?.workflow_cutover?.evidence_contract
      ?.required_backup_kinds ?? []
  );
  const backups = Array.isArray(evidence?.backups) ? evidence.backups : [];
  for (const kind of requiredBackups) {
    const backup = backups.find((entry) => entry.kind === kind);
    if (
      !backup ||
      !safeReference(backup.reference) ||
      !/^[a-f0-9]{64}$/i.test(backup.sha256 || "") ||
      backup.readable !== true ||
      backup.restore_identifier_verified !== true
    ) {
      errors.push(`backup ${kind} is missing or not restore-ready`);
    }
  }

  const preflight = evidence?.preflight;
  requireTrue(preflight, ["fresh_exact_reread", "passed", "all_identities_indexed"], "preflight", errors);
  exactNonNegativeCounts(
    preflight,
    [
      "duplicate_identity_count",
      "unsupported_state_action_count",
      "stale_guard_count",
      "active_claim_count",
      "contract_mismatch_count",
      "partial_move_count"
    ],
    "preflight",
    errors
  );
  if (
    [
      "duplicate_identity_count",
      "unsupported_state_action_count",
      "stale_guard_count",
      "active_claim_count",
      "contract_mismatch_count",
      "partial_move_count"
    ].some((field) => preflight?.[field] !== 0)
  ) {
    errors.push("preflight must stop with zero unresolved safety conflicts");
  }

  requireTrue(
    evidence?.migration,
    [
      "planner_repeat_equal",
      "planner_made_no_writes",
      "every_legacy_row_classified",
      "copy_confirm_delete_only",
      "no_manual_relocation",
      "stale_duplicate_rule_observed"
    ],
    "migration",
    errors
  );
  exactNonNegativeCounts(
    evidence?.migration,
    [
      "legacy_blank_count",
      "legacy_proceed_count",
      "legacy_reject_count",
      "legacy_to_apply_count",
      "migration_reject_count",
      "planned_legacy_count",
      "executed_legacy_count"
    ],
    "migration",
    errors
  );
  const classifiedLegacyCount = [
    "legacy_blank_count",
    "legacy_proceed_count",
    "legacy_reject_count",
    "legacy_to_apply_count"
  ].reduce(
    (total, field) => total + Number(evidence?.migration?.[field] || 0),
    0
  );
  if (evidence?.migration?.planned_legacy_count !== classifiedLegacyCount) {
    errors.push("migration plan counts do not reconcile every legacy row");
  }
  if (
    post
      ? evidence?.migration?.executed_legacy_count !== classifiedLegacyCount
      : evidence?.migration?.executed_legacy_count !== 0
  ) {
    errors.push("migration execution count does not match the evidence phase");
  }
  if (post && evidence?.migration?.migration_reject_count !== 0) {
    errors.push("post-cutover migration rejects must be resolved or rolled back");
  }

  requireTrue(
    evidence?.disposable,
    [
      "append_confirm_delete_partial_failure_passed",
      "stale_action_rejected",
      "duplicate_owner_not_created",
      "setup_rerun_idempotent",
      "no_auto_application"
    ],
    "disposable",
    errors
  );
  requireTrue(
    evidence?.execution_parity,
    [
      "same_generated_workflow",
      "same_route_table",
      "same_claims_guards_caps",
      "same_receipt_contract",
      "same_audit_outputs"
    ],
    "execution_parity",
    errors
  );

  const named = Array.isArray(evidence?.named_records)
    ? evidence.named_records
    : [];
  if (
    named.length !== REVIEW_PREPARATION_REGRESSION_IDS.length ||
    JSON.stringify(named.map((entry) => String(entry.source_job_id)).sort()) !==
      JSON.stringify([...REVIEW_PREPARATION_REGRESSION_IDS].sort())
  ) {
    errors.push("all five named regression records are required exactly once");
  }
  for (const record of named) {
    if (
      !safeReference(record.owner_store) ||
      !schema.business_stores.includes(record.owner_store) ||
      !PREPARATION_OUTCOMES.has(record.outcome) ||
      (post && record.authoritative_owner_count !== 1) ||
      (post && record.repeated_undecided_review_case_count !== 0)
    ) {
      errors.push(`named record ${bounded(record?.source_job_id, 20)} is incomplete`);
    }
  }

  exactNonNegativeCounts(
    evidence?.observations,
    [
      "preparation_pending_count",
      "message_ready_count",
      "needs_input_count",
      "external_steps_count",
      "repair_or_error_count",
      "repeated_case_suppression_count",
      "partial_recovery_count",
      "provider_failure_count",
      "reminder_count",
      "copy_ready_alert_count",
      "unresolved_migration_reject_count",
      "scheduled_boundaries_observed",
      "observation_minutes"
    ],
    "observations",
    errors
  );
  if (post) {
    if (
      evidence?.observations?.scheduled_boundaries_observed < 3 ||
      evidence?.observations?.observation_minutes <
        deploymentPolicy?.workflow_cutover?.evidence_contract
          ?.minimum_observation_minutes ||
      evidence?.observations?.unresolved_migration_reject_count !== 0
    ) {
      errors.push("post-cutover bounded observation is incomplete");
    }
    requireTrue(
      evidence?.observations,
      [
        "unchanged_paused_records_not_reprepared",
        "unchanged_paused_records_not_rereminded",
        "controlled_input_change_resumed_once",
        "copy_ready_alert_at_most_once",
        "reminder_categories_policy_exact"
      ],
      "observations",
      errors
    );
  } else if (
    evidence?.observations?.scheduled_boundaries_observed !== 0 ||
    evidence?.observations?.observation_minutes !== 0
  ) {
    errors.push("pre-cutover evidence cannot claim post-cutover observation");
  }

  requireTrue(
    evidence?.regressions,
    [
      "rediscovery",
      "direct_ready",
      "applied",
      "skip",
      "reject",
      "archive",
      "claim_recovery",
      "slack_receipts",
      "no_auto_application"
    ],
    "regressions",
    errors
  );
  requireTrue(
    evidence?.rollback,
    [
      "triggers_documented",
      "order_documented",
      "compatibility_limits_documented",
      "restores_compatibility_unit",
      "no_manual_row_relocation"
    ],
    "rollback",
    errors
  );
  if (!safeReference(evidence?.rollback?.runbook_reference)) {
    errors.push("rollback.runbook_reference must be a sanitized reference");
  }
  return errors;
}
