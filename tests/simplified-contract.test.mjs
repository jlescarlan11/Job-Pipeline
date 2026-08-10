import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  STATE_GUARD_EXCLUDED_FIELDS,
  STATE_GUARD_FIELDS,
  applicationReviewGuard,
  browserJobDigest,
  canonicalJobId,
  canTransitionPreparation,
  canTransitionBrowser,
  canTransition,
  normalizeCanonicalUrl,
  normalizeLegacyRecord,
  legacyStateGuardV3,
  legacyStateGuardV4,
  preparationInputGuard,
  reviewCaseId,
  stateGuard,
  stateGuardMatches,
  submissionIdempotencyKey,
  transitionBrowserState,
  transitionRecord,
  validatePipelineSchema,
  validateRecordContract,
  validateRecordStoreContract,
  validateUniqueIdentityAcrossStores
} from "../src/contracts.mjs";
import {
  planFreshWorkbookSetup,
  planAutonomousContractMigration,
  planRecordHeaderUpgrade,
  planSegmentedQueueMigration,
  validateFreshSheetConfig
} from "../src/fresh-sheet-setup.mjs";

const schema = JSON.parse(
  await readFile(new URL("../config/pipeline-schema.json", import.meta.url))
);
const review = JSON.parse(
  await readFile(new URL("../config/review-sheet.json", import.meta.url))
);

function validRecord(overrides = {}) {
  const base = {
    source: "onlinejobs.ph",
    source_job_id: "12345",
    canonical_job_id: "onlinejobs.ph:12345",
    record_version: 1,
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-12345",
    pipeline_status: "new",
    user_action: "",
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["react developer"],
    match_reasons: [],
    requirement_gaps: [],
    selected_proof_refs: [],
    application_instructions: [],
    screening_questions: [],
    application_warnings: [],
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z"
  };
  return normalizeLegacyRecord({ ...base, ...overrides }, schema, base.created_at);
}

function autonomousRecord(browserState = "queued", overrides = {}) {
  const attemptStates = new Set([
    "claimed",
    "evaluating",
    "generating",
    "filling",
    "submit_started",
    "confirmed",
    "retryable",
    "ambiguous",
    "blocked"
  ]);
  const formStates = new Set([
    "generating",
    "filling",
    "submit_started",
    "confirmed",
    "ambiguous"
  ]);
  const startedStates = new Set(["submit_started", "confirmed", "ambiguous"]);
  const raw = {
    source: "onlinejobs.ph",
    source_job_id: "54321",
    canonical_job_id: "onlinejobs.ph:54321",
    record_version: 1,
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-54321",
    pipeline_status: browserState === "skipped" ? "skip" : "new",
    user_action: "",
    source_availability: "active",
    attempt_count: 0,
    matched_keywords: ["react developer"],
    match_reasons: [],
    requirement_gaps: [],
    selected_proof_refs: [],
    application_instructions: [],
    screening_questions: [],
    application_warnings: [],
    execution_mode: "autonomous_chrome",
    automation_contract_version: "browser-contract-v1",
    autonomous_decision:
      browserState === "skipped"
        ? "skip"
        : ["generating", ...formStates].includes(browserState)
          ? "apply"
          : "",
    browser_state: browserState,
    browser_attempt_id: attemptStates.has(browserState)
      ? `attempt-v1:${"1".repeat(64)}`
      : "",
    browser_job_digest: `job-v1:${"2".repeat(64)}`,
    browser_context_digest: ["queued", "claimed"].includes(browserState)
      ? ""
      : `context-v1:${"7".repeat(64)}`,
    browser_form_fingerprint: formStates.has(browserState)
      ? `form-v1:${"3".repeat(64)}`
      : "",
    submission_started_at: startedStates.has(browserState)
      ? "2026-08-10T01:00:00.000Z"
      : "",
    submission_confirmed_at:
      browserState === "confirmed" ? "2026-08-10T01:01:00.000Z" : "",
    submission_confirmation_kind:
      browserState === "confirmed" ? "confirmation_page" : "",
    submission_confirmation_reference:
      browserState === "confirmed"
        ? `confirmation-ref-v1:${"4".repeat(64)}`
        : "",
    submission_confirmation_digest:
      browserState === "confirmed"
        ? `confirmation-v1:${"5".repeat(64)}`
        : "",
    submission_attestation_key_id:
      browserState === "confirmed" ? "test-history-adapter-v1" : "",
    submission_attestation_witness_digest:
      browserState === "confirmed" ? `witness-v1:${"8".repeat(64)}` : "",
    submission_attestation_signature:
      browserState === "confirmed" ? "A".repeat(86) : "",
    browser_block_category:
      browserState === "blocked" ? "missing_candidate_fact" : "",
    profile_version: "2026-07-29",
    message_profile_version: "2026-07-29",
    message_policy_version: "2026-08-10/autonomous-v1",
    application_pack_version: "2026-08-10/v4",
    application_pack_policy_version: "2026-08-10/v4",
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    ...overrides
  };
  if (formStates.has(browserState) && !Object.hasOwn(overrides, "submission_idempotency_key")) {
    raw.submission_idempotency_key = submissionIdempotencyKey(raw);
  }
  return normalizeLegacyRecord(raw, schema, raw.created_at);
}

test("simplified schema has exactly three business results and separate operational conditions", () => {
  assert.deepEqual(validatePipelineSchema(schema), []);
  assert.deepEqual(schema.business_results, [
    "ready_to_apply",
    "review_needed",
    "skip"
  ]);
  assert.deepEqual(schema.operational_conditions, [
    "new",
    "processing",
    "error",
    "unavailable"
  ]);
});

test("persisted requirement coverage and message plans are bounded JSON contracts", () => {
  const record = validRecord({
    requirement_coverage: [
      {
        id: "coverage-1",
        requirement_id: "instruction-1",
        element: "x".repeat(31000)
      }
    ],
    application_message_plan: []
  });
  assert.match(
    validateRecordContract(record, schema).join("\n"),
    /requirement_coverage exceeds 30000 serialized characters/
  );
  const invalidSchema = structuredClone(schema);
  delete invalidSchema.json_field_maximum_characters.requirement_coverage;
  assert.match(
    validatePipelineSchema(invalidSchema).join("\n"),
    /json field maximum is invalid for requirement_coverage/
  );
});

test("coverage and message-plan changes invalidate the record state guard", () => {
  assert.deepEqual(
    [...STATE_GUARD_FIELDS].sort(),
    schema.fields
      .filter((field) => !STATE_GUARD_EXCLUDED_FIELDS.includes(field))
      .sort(),
    "the guard field allowlist must cover every system-owned synchronous field"
  );
  const record = validRecord({
    requirement_coverage: [{ id: "coverage-1", classification: "exact" }],
    application_message_plan: [{ version: "2026-08-03/v1", requirements: [] }],
    coverage_contract_version: "2026-08-03/v1",
    message_plan_version: "2026-08-03/v1"
  });
  const baseline = stateGuard(record);
  assert.match(baseline, /\|[a-f0-9]{64}$/);
  assert.notEqual(
    stateGuard({
      ...record,
      requirement_coverage: [{ id: "coverage-1", classification: "adjacent" }]
    }),
    baseline
  );
  assert.notEqual(
    stateGuard({
      ...record,
      application_message_plan: [
        { version: "2026-08-03/v1", requirements: [{ id: "forged" }] }
      ]
    }),
    baseline
  );
  const guardedMutations = {
    canonical_url: "https://onlinejobs.ph/jobseekers/job/changed-9999",
    job_title: "Changed outbound title",
    company: "Changed Company",
    job_description: "changed employer requirements",
    salary_text: "PHP 999,999 / month",
    source_availability: "unavailable",
    qualification_score: 1,
    opportunity_score: 2,
    ranking_confidence: "low",
    decision_reason: "changed Slack reason",
    requirement_gaps: ["changed Slack gap"],
    generated_message: "changed outbound message",
    message_validation_status: "invalid",
    application_instructions: [{ id: "instruction-forged" }],
    screening_questions: [{ id: "question-forged" }],
    selected_proof_refs: ["projects:rent-n-roll"],
    application_warnings: [{ code: "forged" }],
    application_pack_status: "blocked",
    application_pack_generated_at: "2026-08-03T01:00:00.000Z",
    review_approval_guard: `review-v1:${"1".repeat(64)}`
  };
  for (const [field, value] of Object.entries(guardedMutations)) {
    assert.notEqual(
      stateGuard({ ...record, [field]: value }),
      baseline,
      `${field} must invalidate the state guard`
    );
  }
  for (const [field, value] of Object.entries({
    user_action: "Proceed",
    outcome: "interview",
    notes: "operator note changed",
    matched_keywords: ["rediscovered keyword"],
    last_seen_at: "2026-08-03T02:00:00.000Z",
    updated_at: "2026-08-03T02:00:00.000Z"
  })) {
    assert.equal(
      stateGuard({ ...record, [field]: value }),
      baseline,
      `${field} is compared by its owning workflow rather than the persisted digest`
    );
  }

  const sparse = {
    source: record.source,
    source_job_id: record.source_job_id,
    canonical_job_id: record.canonical_job_id,
    canonical_url: record.canonical_url
  };
  const sheetRoundTrip = Object.fromEntries(
    schema.fields.map((field) => [field, sparse[field] ?? ""])
  );
  assert.equal(
    stateGuard(sparse),
    stateGuard(sheetRoundTrip),
    "blank Sheet cells and absent sparse fields must produce the same guard"
  );
});

test("autonomous browser lifecycle is guarded and submit intent cannot retry backward", () => {
  for (const state of schema.browser_states) {
    const record = autonomousRecord(state);
    assert.deepEqual(
      validateRecordContract(record, schema),
      [],
      `${state} must be a valid autonomous state`
    );
  }
  assert.equal(canTransitionBrowser(schema, "queued", "claimed"), true);
  assert.equal(canTransitionBrowser(schema, "filling", "submit_started"), true);
  assert.equal(canTransitionBrowser(schema, "submit_started", "confirmed"), true);
  assert.equal(canTransitionBrowser(schema, "submit_started", "ambiguous"), true);
  assert.equal(canTransitionBrowser(schema, "submit_started", "filling"), false);
  assert.equal(canTransitionBrowser(schema, "submit_started", "retryable"), false);
  assert.throws(
    () =>
      transitionBrowserState(
        autonomousRecord("submit_started"),
        "filling",
        schema
      ),
    /Invalid browser transition/
  );

  assert.deepEqual(
    validateRecordContract(
      autonomousRecord("claimed", {
        processing_stage: "browser_executor",
        processing_token: "browser-claim-token",
        processing_started_at: "2026-08-10T00:30:00.000Z"
      }),
      schema
    ),
    []
  );
  assert.match(
    validateRecordContract(
      validRecord({
        processing_stage: "browser_executor",
        processing_token: "forged-browser-claim",
        processing_started_at: "2026-08-10T00:30:00.000Z"
      }),
      schema
    ).join("; "),
    /supported stage/
  );

  const baseline = autonomousRecord("confirmed");
  for (const [field, value] of Object.entries({
    execution_mode: "legacy_manual",
    automation_contract_version: "changed",
    autonomous_decision: "skip",
    browser_state: "ambiguous",
    browser_attempt_id: `attempt-v1:${"6".repeat(64)}`,
    browser_job_digest: `job-v1:${"6".repeat(64)}`,
    browser_context_digest: `context-v1:${"6".repeat(64)}`,
    browser_form_fingerprint: `form-v1:${"6".repeat(64)}`,
    submission_idempotency_key: `submission-v1:${"6".repeat(64)}`,
    submission_started_at: "2026-08-10T02:00:00.000Z",
    submission_confirmed_at: "2026-08-10T02:01:00.000Z",
    submission_confirmation_kind: "application_history",
    submission_confirmation_reference: `confirmation-ref-v1:${"6".repeat(64)}`,
    submission_confirmation_digest: `confirmation-v1:${"6".repeat(64)}`,
    submission_attestation_key_id: "changed-adapter-key",
    submission_attestation_witness_digest: `witness-v1:${"6".repeat(64)}`,
    submission_attestation_signature: "B".repeat(86),
    browser_block_category: "confirmation_mismatch"
  })) {
    assert.notEqual(
      stateGuard({ ...baseline, [field]: value }),
      baseline.state_guard,
      `${field} must invalidate the state guard`
    );
  }
});

test("browser job identity binds material inputs but excludes observation timestamps", () => {
  const record = autonomousRecord("queued", {
    job_title: "Senior React Developer",
    company: "Example Company",
    job_description: "Build a customer portal.",
    salary_text: "PHP 100,000 / month",
    posted_at: "2026-08-09T00:00:00.000Z",
    role_families: ["full-stack", "frontend"],
    matched_keywords: ["react developer"]
  });
  const baseline = browserJobDigest(record);
  assert.match(baseline, /^job-v1:[a-f0-9]{64}$/);
  assert.equal(
    browserJobDigest({
      ...record,
      last_seen_at: "2026-08-10T04:00:00.000Z",
      updated_at: "2026-08-10T04:00:00.000Z"
    }),
    baseline
  );
  for (const [field, value] of Object.entries({
    source: "another-source.example",
    source_job_id: "different-id",
    canonical_job_id: "onlinejobs.ph:99999",
    canonical_url: "https://onlinejobs.ph/jobseekers/job/changed-99999",
    job_title: "Changed title",
    company: "Changed Company",
    job_description: "Changed requirements",
    salary_text: "PHP 200,000 / month",
    posted_at: "2026-08-08T00:00:00.000Z",
    source_availability: "unavailable",
    role_families: ["automation"],
    matched_keywords: ["automation engineer"]
  })) {
    assert.notEqual(
      browserJobDigest({ ...record, [field]: value }),
      baseline,
      `${field} must change the browser job digest`
    );
  }
});

test("submission identity is stable across attempts and binds trusted inputs", () => {
  const first = autonomousRecord("filling");
  const second = autonomousRecord("filling", {
    browser_attempt_id: `attempt-v1:${"9".repeat(64)}`,
    updated_at: "2026-08-10T03:00:00.000Z"
  });
  assert.equal(
    submissionIdempotencyKey(first),
    submissionIdempotencyKey(second)
  );
  assert.equal(first.submission_idempotency_key, second.submission_idempotency_key);
  assert.notEqual(
    submissionIdempotencyKey({
      ...first,
      browser_form_fingerprint: `form-v1:${"8".repeat(64)}`
    }),
    first.submission_idempotency_key
  );
  assert.notEqual(
    submissionIdempotencyKey({ ...first, profile_version: "sheet/0123456789abcdef" }),
    first.submission_idempotency_key
  );
});

test("confirmation evidence is bounded, allowlisted, and fail-closed", () => {
  const confirmed = autonomousRecord("confirmed");
  assert.deepEqual(validateRecordContract(confirmed, schema), []);
  for (const mutation of [
    { submission_confirmation_kind: "dom_dump" },
    { submission_confirmation_reference: "https://example.com/private" },
    { submission_confirmation_digest: "full generated message" },
    { submission_confirmed_at: "not-a-timestamp" },
    { browser_block_category: "captcha" }
  ]) {
    assert.ok(
      validateRecordContract({ ...confirmed, ...mutation }, schema).length > 0
    );
  }
  assert.equal(
    schema.fields.some((field) =>
      /cookie|credential|screenshot|dom|confirmation_summary/i.test(field)
    ),
    false
  );
});

test("blank execution mode remains bounded legacy compatibility only", () => {
  const legacy = validRecord({ pipeline_status: "review_needed" });
  delete legacy.execution_mode;
  legacy.state_guard = legacyStateGuardV4(legacy);
  const normalized = normalizeLegacyRecord(legacy, schema, legacy.created_at);
  assert.equal(normalized.execution_mode, "legacy_manual");
  assert.equal(stateGuardMatches(normalized), true);
  assert.deepEqual(
    validateRecordStoreContract(normalized, "To Review", schema),
    []
  );

  const forged = {
    ...normalized,
    execution_mode: "autonomous_chrome",
    automation_contract_version: "browser-contract-v1",
    browser_state: "queued",
    browser_job_digest: `job-v1:${"7".repeat(64)}`
  };
  assert.equal(stateGuardMatches(forged), false);
  assert.match(
    validateRecordStoreContract(forged, "To Review", schema).join("; "),
    /does not own autonomous browser_state/
  );
});

test("five business sheets own the segmented record lifecycle", () => {
  assert.deepEqual(validateFreshSheetConfig(review, schema), []);
  assert.equal(review.sheets.scraped_jobs.authoritative_for, "scraped");
  assert.equal(review.sheets.to_review.authoritative_for, "review");
  assert.equal(review.sheets.to_apply.authoritative_for, "apply");
  assert.equal(review.sheets.applied_jobs.authoritative_for, "applied");
  assert.equal(review.sheets.archive.authoritative_for, "archived");
  assert.deepEqual(
    Object.fromEntries(
      Object.values(review.sheets)
        .filter((definition) => schema.business_stores.includes(definition.name))
        .map((definition) => [definition.name, definition.latest_first_column])
    ),
    {
      "Scraped Jobs": "discovered_at",
      "To Review": "evaluated_at",
      "To Apply": "generated_at",
      "Applied Jobs": "applied_at",
      Archive: "archived_at"
    }
  );
  assert.equal(
    review.sheets.search_keywords.authoritative_for,
    "scraper_keywords"
  );
  assert.equal(review.sheets.search_keywords.visible, true);
  assert.equal(review.sheets.system.visible, false);
  assert.equal(review.fresh_start.imports_legacy_rows, false);
  assert.deepEqual(schema.business_stores, [
    "Scraped Jobs",
    "To Review",
    "To Apply",
    "Applied Jobs",
    "Archive"
  ]);
});

test("operator actions are fail-closed and status specific", () => {
  for (const [status, allowed] of Object.entries(schema.actions_by_status)) {
    for (const action of schema.user_actions) {
      const errors = validateRecordContract(
        validRecord({ pipeline_status: status, user_action: action }),
        schema
      );
      assert.equal(
        errors.some((error) => error.includes("user_action")),
        !allowed.includes(action),
        `${status}/${action || "(blank)"}`
      );
    }
  }
  for (const [store, statuses] of Object.entries(
    schema.actions_by_store_status
  )) {
    for (const [status, allowed] of Object.entries(statuses)) {
      for (const action of schema.user_actions) {
        const errors = validateRecordStoreContract(
          validRecord({
            pipeline_status: status,
            user_action: action,
            ...(status === "processing"
              ? {
                  processing_stage: "evaluation",
                  processing_token: "owner",
                  processing_started_at: "2026-07-31T00:00:00.000Z"
                }
              : {})
          }),
          store,
          schema
        );
        assert.equal(
          errors.some(
            (error) =>
              error.includes(`not supported for ${store}/`) ||
              error.includes(`${store} does not own`)
          ),
          !allowed.includes(action),
          `${store}/${status}/${action || "(blank)"}`
        );
      }
    }
  }
  assert.match(
    validateRecordStoreContract(
      validRecord({ pipeline_status: "ready_to_apply", user_action: "" }),
      "To Review",
      schema
    ).join(";"),
    /does not own pipeline_status/
  );
});

test("review decisions use Proceed and Reject while legacy actions normalize deterministically", () => {
  assert.deepEqual(schema.user_actions, [
    "",
    "I Applied",
    "Skip",
    "Proceed",
    "Reject"
  ]);
  assert.deepEqual(review.action_validation["To Review"], {
    values: ["Proceed", "Reject"],
    allow_blank: true
  });
  assert.equal(
    validRecord({ pipeline_status: "review_needed", user_action: "Approve" })
      .user_action,
    "Proceed"
  );
  assert.equal(
    validRecord({ pipeline_status: "review_needed", user_action: "Deny" })
      .user_action,
    "Reject"
  );
  assert.match(
    validateRecordStoreContract(
      { ...validRecord({ pipeline_status: "review_needed" }), user_action: "Approve" },
      "To Review",
      schema
    ).join(";"),
    /user_action/
  );
});

test("only a raw v3 Scraped Jobs Approve or Deny can use the loop cutover route", () => {
  const rawLegacy = validRecord({
    pipeline_status: "review_needed",
    user_action: ""
  });
  rawLegacy.user_action = "Approve";
  delete rawLegacy.compatibility_legacy_user_action;
  rawLegacy.state_guard = legacyStateGuardV3(rawLegacy);
  const normalizedLegacy = normalizeLegacyRecord(rawLegacy, schema);
  assert.equal(normalizedLegacy.user_action, "Proceed");
  assert.equal(normalizedLegacy.compatibility_legacy_user_action, "Approve");
  assert.deepEqual(
    validateRecordStoreContract(normalizedLegacy, "Scraped Jobs", schema),
    []
  );

  const upgraded = { ...normalizedLegacy, state_guard: "" };
  upgraded.state_guard = stateGuard(upgraded);
  assert.match(
    validateRecordStoreContract(upgraded, "Scraped Jobs", schema).join(";"),
    /user_action/
  );

  const forged = { ...rawLegacy, user_action: "Proceed" };
  delete forged.compatibility_legacy_user_action;
  forged.state_guard = legacyStateGuardV3(forged);
  const normalizedForged = normalizeLegacyRecord(forged, schema);
  assert.match(
    validateRecordStoreContract(
      normalizedForged,
      "Scraped Jobs",
      schema
    ).join(";"),
    /user_action/
  );
});

test("review cases and preparation input guards are stable across retries", () => {
  const record = validRecord({
    pipeline_status: "review_needed",
    decision_reason: "Application requirements need a decision",
    required_input: "Confirm the adjacent evidence strategy",
    application_pack_status: "review_required",
    application_pack_version: "2026-08-03/v1",
    application_pack_profile_version: "profile-v1",
    application_pack_policy_version: "policy-v1"
  });
  const caseId = reviewCaseId(record);
  assert.match(caseId, /^review-case-v1:[a-f0-9]{64}$/);
  assert.equal(
    reviewCaseId({
      ...record,
      review_approved_at: "2026-08-04T01:00:00.000Z",
      notes: "operator note",
      updated_at: "2026-08-04T01:00:00.000Z"
    }),
    caseId
  );
  assert.notEqual(
    reviewCaseId({ ...record, required_input: "A materially new decision" }),
    caseId
  );
  const proceeded = {
    ...record,
    review_case_id: caseId,
    review_case_version: "review-case-v1",
    review_decision: "proceed",
    review_decided_at: "2026-08-04T01:00:00.000Z"
  };
  const prepGuard = preparationInputGuard(proceeded);
  assert.match(prepGuard, /^prep-v1:[a-f0-9]{64}$/);
  assert.equal(
    preparationInputGuard({
      ...proceeded,
      attempt_count: 99,
      next_retry_at: "2026-08-04T02:00:00.000Z",
      updated_at: "2026-08-04T02:00:00.000Z",
      application_pack_status: "ready",
      application_warnings: [{ code: "generated-output" }],
      generated_message: "A newly generated message"
    }),
    prepGuard
  );
  assert.notEqual(
    preparationInputGuard({
      ...proceeded,
      review_approval_guard: `review-v1:${"2".repeat(64)}`
    }),
    prepGuard
  );
  assert.notEqual(
    preparationInputGuard({ ...proceeded, profile_version: "profile-v2" }),
    prepGuard
  );
  assert.match(applicationReviewGuard(record), /^review-v1:[a-f0-9]{64}$/);
});

test("preparation lifecycle separates To Apply ownership from message readiness", () => {
  assert.deepEqual(schema.preparation_statuses, [
    "",
    "pending",
    "preparing",
    "message_ready",
    "needs_input",
    "external_steps",
    "repair_pending",
    "preparation_error"
  ]);
  assert.equal(canTransitionPreparation(schema, "pending", "preparing"), true);
  assert.equal(canTransitionPreparation(schema, "needs_input", "message_ready"), false);

  const legacyReady = validRecord({ pipeline_status: "ready_to_apply" });
  assert.equal(legacyReady.prep_status, "preparation_error");
  assert.equal(legacyReady.preparation_version, 0);
  assert.deepEqual(
    validateRecordStoreContract(legacyReady, "To Apply", schema),
    []
  );

  const preparationBase = {
    pipeline_status: "ready_to_apply",
    prep_status: "needs_input",
    preparation_version: 1,
    preparation_updated_at: "2026-08-04T01:00:00.000Z",
    preparation_input_guard: `prep-v1:${"1".repeat(64)}`
  };
  assert.match(
    validateRecordContract(validRecord(preparationBase), schema).join(";"),
    /needs_input requires bounded required_input/
  );
  assert.deepEqual(
    validateRecordStoreContract(
      validRecord({
        ...preparationBase,
        required_input: "Provide the missing availability answer."
      }),
      "To Apply",
      schema
    ),
    []
  );
  assert.match(
    validateRecordContract(
      validRecord({
        ...preparationBase,
        prep_status: "external_steps",
        required_input: "Upload the resume.\u202e"
      }),
      schema
    ).join(";"),
    /unsafe control characters/
  );

  const readyBase = {
    pipeline_status: "ready_to_apply",
    prep_status: "message_ready",
    preparation_version: 1,
    preparation_updated_at: "2026-08-04T01:00:00.000Z",
    preparation_input_guard: `prep-v1:${"2".repeat(64)}`,
    application_pack_status: "ready",
    application_pack_version: "2026-08-03/v1",
    application_pack_profile_version: "profile-v1",
    application_pack_policy_version: "policy-v1",
    generated_message: "Subject\n\nValidated application message.",
    message_validation_status: "valid",
    message_profile_version: "profile-v1",
    message_policy_version: "message-v1"
  };
  assert.deepEqual(validateRecordContract(validRecord(readyBase), schema), []);
  assert.match(
    validateRecordContract(
      validRecord({ ...readyBase, generated_message: "" }),
      schema
    ).join(";"),
    /message_ready requires generated_message/
  );
  assert.match(
    validateRecordContract(
      validRecord({ ...readyBase, application_pack_status: "blocked" }),
      schema
    ).join(";"),
    /message_ready requires a ready application pack/
  );
});

test("unsupported transitions and malformed identities fail closed", () => {
  assert.equal(canTransition(schema, "new", "ready_to_apply"), false);
  assert.throws(
    () => transitionRecord(validRecord(), "ready_to_apply", schema),
    /Invalid pipeline transition/
  );
  assert.match(
    validateRecordContract(
      validRecord({
        canonical_job_id: "onlinejobs.ph:999",
        canonical_url: "javascript:alert(1)"
      }),
      schema
    ).join(";"),
    /canonical_url is invalid|canonical_job_id does not match/
  );
});

test("OnlineJobs IDs and canonical URLs retain established identity behavior", () => {
  const canonical = normalizeCanonicalUrl(
    "HTTPS://WWW.ONLINEJOBS.PH/jobseekers/job/example-12345/"
  );
  assert.equal(
    canonical,
    "https://onlinejobs.ph/jobseekers/job/example-12345"
  );
  assert.equal(
    canonicalJobId({ source: "ONLINEJOBS.PH", canonical_url: canonical }),
    "onlinejobs.ph:12345"
  );
});

test("identity duplicates across all five stores are rejected", () => {
  const record = validRecord();
  assert.deepEqual(
    validateUniqueIdentityAcrossStores(
      {
        "Scraped Jobs": [record],
        "To Review": [],
        "To Apply": [],
        "Applied Jobs": [],
        Archive: []
      },
      schema
    ),
    []
  );
  assert.match(
    validateUniqueIdentityAcrossStores(
      {
        "Scraped Jobs": [record],
        "To Review": [],
        "To Apply": [],
        "Applied Jobs": [{ ...record }],
        Archive: []
      },
      schema
    ).join(";"),
    /duplicate canonical identity/
  );
});

test("blank setup creates separate Main and Configuration workbooks", () => {
  const main = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema,
    "main"
  );
  const configuration = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema,
    "configuration"
  );
  assert.deepEqual(
    main.sheets.map((sheet) => sheet.name),
    [
      "Scraped Jobs",
      "To Review",
      "To Apply",
      "Applied Jobs",
      "Archive",
      "_System"
    ]
  );
  assert.deepEqual(
    configuration.sheets.map((sheet) => sheet.name),
    [
      "Search Keywords",
      "Candidate",
      "Skills",
      "Experience",
      "Projects",
      "Education",
      "Awards",
      "Job Preferences",
      "Application Settings",
      "Required Style",
      "Banned Phrases",
      "Prompts"
    ]
  );
  assert.equal(main.sheets.filter((sheet) => !sheet.hidden).length, 5);
  assert.equal(configuration.sheets.filter((sheet) => !sheet.hidden).length, 12);
  for (const sheet of main.sheets.filter(
    (sheet) =>
      [
        "Scraped Jobs",
        "To Review",
        "To Apply",
        "Applied Jobs",
        "Archive",
        "_System"
      ].includes(sheet.name)
  )) {
    assert.equal(sheet.rows.length, 0);
    assert.ok(sheet.headers.length > 0);
  }
  const keywords = configuration.sheets.find(
    (sheet) => sheet.name === "Search Keywords"
  );
  assert.deepEqual(keywords.headers, ["enabled", "keyword"]);
  assert.equal(keywords.rows.length, 10);
  assert.ok(keywords.rows.every((row) => row.enabled === true));
  assert.deepEqual(keywords.validations, { enabled: "checkbox" });
  assert.equal(keywords.protectedHeader, true);
  assert.deepEqual(keywords.protectedColumns, []);
  for (const key of [
    "candidate",
    "skills",
    "experience",
    "projects",
    "education",
    "awards",
    "job_preferences",
    "application_settings",
    "required_style",
    "banned_phrases",
    "prompts"
  ]) {
    const definition = review.sheets[key];
    const contextSheet = configuration.sheets.find(
      (sheet) => sheet.name === definition.name
    );
    assert.deepEqual(contextSheet.headers, definition.fields);
    assert.deepEqual(contextSheet.rows, definition.initial_rows);
    assert.equal(contextSheet.protectedHeader, true);
    assert.deepEqual(contextSheet.protectedColumns, []);
    assert.deepEqual(
      contextSheet.validations,
      definition.fields.includes("enabled") ? { enabled: "checkbox" } : {}
    );
  }
  assert.deepEqual(
    main.sheets.find((sheet) => sheet.name === "To Review").validations,
    {
      user_action: { values: ["Proceed", "Reject"], allow_blank: true }
    }
  );
  assert.deepEqual(
    main.sheets.find((sheet) => sheet.name === "To Apply").validations,
    {
      user_action: { values: ["I Applied", "Skip"], allow_blank: true }
    }
  );
  const toApply = main.sheets.find((sheet) => sheet.name === "To Apply");
  assert.equal(toApply.hiddenColumns.includes("required_input"), false);
  assert.equal(toApply.protectedColumns.includes("required_input"), true);
  assert.equal(toApply.protectedColumns.includes("notes"), false);
  assert.deepEqual(
    main.sheets.find((sheet) => sheet.name === "Scraped Jobs").validations,
    {}
  );
});

test("setup is idempotent and preserves valid operator data", () => {
  const firstMain = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema,
    "main"
  );
  const firstConfiguration = planFreshWorkbookSetup(
    { sheets: [{ name: "Sheet1", headers: [], rows: [] }] },
    review,
    schema,
    "configuration"
  );
  firstMain.sheets[0].rows.push(validRecord({ notes: "keep me" }));
  const keywordSheet = firstConfiguration.sheets.find(
    (sheet) => sheet.name === "Search Keywords"
  );
  keywordSheet.rows[0] = {
    enabled: false,
    keyword: "edited full stack developer"
  };
  keywordSheet.rows.splice(1, 1);
  keywordSheet.rows.push({
    enabled: true,
    keyword: "new operator keyword"
  });
  const secondMain = planFreshWorkbookSetup(
    firstMain,
    review,
    schema,
    "main"
  );
  const secondConfiguration = planFreshWorkbookSetup(
    firstConfiguration,
    review,
    schema,
    "configuration"
  );
  assert.deepEqual(secondMain, firstMain);
  assert.deepEqual(secondConfiguration, firstConfiguration);
  assert.equal(secondMain.sheets[0].rows[0].notes, "keep me");
  assert.deepEqual(
    secondConfiguration.sheets.find(
      (sheet) => sheet.name === "Search Keywords"
    ).rows,
    keywordSheet.rows
  );
});

test("record header setup upgrades the exact v4 layout without moving row data", () => {
  const legacyFields = review.record_header_upgrade.legacy_fields;
  const legacyValues = legacyFields.map((field) => `value:${field}`);
  const legacySnapshot = {
    sheets: schema.business_stores.map((name, index) => ({
      name,
      headers: [...legacyFields],
      rows: index === 0 ? [legacyValues] : []
    }))
  };

  const headerPlan = planRecordHeaderUpgrade(legacySnapshot, review, schema);
  assert.equal(headerPlan.mode, "legacy_v4_to_v5");
  assert.equal(headerPlan.operations.length, 5);
  assert.deepEqual(
    headerPlan.operations
      .filter((operation) => operation.sheet === "Scraped Jobs")
      .map((operation) => [operation.before_field, operation.before_column]),
    [["review_case_id", 20]]
  );

  const upgraded = planFreshWorkbookSetup(
    legacySnapshot,
    review,
    schema,
    "main"
  );
  const upgradedRow = upgraded.sheets.find(
    (sheet) => sheet.name === "Scraped Jobs"
  ).rows[0];
  assert.equal(upgradedRow.length, schema.fields.length);
  for (const [index, field] of schema.fields.entries()) {
    assert.equal(
      upgradedRow[index],
      legacyFields.includes(field) ? `value:${field}` : "",
      `column ${field} must preserve its v4 value or be introduced blank`
    );
  }
  assert.equal(
    planRecordHeaderUpgrade(upgraded, review, schema).mode,
    "current_or_empty"
  );
});

test("autonomous contract migration preflight is deterministic and never writes", () => {
  const legacy = validRecord({
    source_job_id: "100",
    canonical_job_id: "onlinejobs.ph:100",
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-100"
  });
  delete legacy.execution_mode;
  legacy.state_guard = legacyStateGuardV4(legacy);
  const current = autonomousRecord("queued", {
    source_job_id: "101",
    canonical_job_id: "onlinejobs.ph:101",
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-101"
  });
  const blocked = autonomousRecord("blocked", {
    source_job_id: "102",
    canonical_job_id: "onlinejobs.ph:102",
    canonical_url: "https://onlinejobs.ph/jobseekers/job/example-102"
  });
  const snapshot = {
    captured_at: "2026-08-10T04:00:00.000Z",
    stores: {
      "Scraped Jobs": [legacy, current, blocked],
      "To Review": [],
      "To Apply": [],
      "Applied Jobs": [],
      Archive: []
    }
  };
  const first = planAutonomousContractMigration(snapshot, schema);
  const second = planAutonomousContractMigration(snapshot, schema);
  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.equal(first.writes_allowed, false);
  assert.equal(first.business_row_relocation_allowed, false);
  assert.deepEqual(first.counts, {
    autonomous_compatible: 1,
    legacy_manual: 1,
    blocked: 1,
    rejected: 0
  });

  const duplicate = structuredClone(snapshot);
  duplicate.stores["To Review"].push({ ...legacy });
  const rejected = planAutonomousContractMigration(duplicate, schema);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.counts.rejected > 0);
});

test("record header setup fails closed on mixed, partial, and extra-data layouts", () => {
  const legacyFields = review.record_header_upgrade.legacy_fields;
  const mixed = {
    sheets: schema.business_stores.map((name, index) => ({
      name,
      headers: index === 0 ? [...schema.fields] : [...legacyFields],
      rows: []
    }))
  };
  assert.throws(
    () => planRecordHeaderUpgrade(mixed, review, schema),
    /mixed, missing, or partial/
  );

  const partial = structuredClone(mixed);
  partial.sheets = partial.sheets.map((sheet) => ({
    ...sheet,
    headers: [...legacyFields]
  }));
  partial.sheets[2].headers.splice(20, 1);
  assert.throws(
    () => planRecordHeaderUpgrade(partial, review, schema),
    /conflicting headers/
  );

  const extraData = structuredClone(mixed);
  extraData.sheets = extraData.sheets.map((sheet) => ({
    ...sheet,
    headers: [...legacyFields]
  }));
  extraData.sheets[0].rows = [
    [...legacyFields.map(() => ""), "unexpected-value"]
  ];
  assert.throws(
    () => planRecordHeaderUpgrade(extraData, review, schema),
    /row data beyond the declared headers/
  );
});

test("pre-existing empty Search Keywords sheet is not repopulated", () => {
  const planned = planFreshWorkbookSetup(
    {
      sheets: [
        {
          name: "Search Keywords",
          headers: ["enabled", "keyword"],
          rows: []
        }
      ]
    },
    review,
    schema,
    "configuration"
  );
  assert.deepEqual(
    planned.sheets.find((sheet) => sheet.name === "Search Keywords").rows,
    []
  );
});

test("fresh setup refuses conflicting or non-empty unexpected sheets", () => {
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        { sheets: [{ name: "Sheet1", headers: ["legacy"], rows: [["data"]] }] },
        review,
        schema,
        "main"
      ),
    /refused non-empty unexpected sheet/
  );
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        {
          sheets: [
            { name: "Scraped Jobs", headers: ["wrong"], rows: [] }
          ]
        },
        review,
        schema,
        "main"
      ),
    /conflicting headers/
  );
  assert.throws(
    () =>
      planFreshWorkbookSetup(
        {
          sheets: [
            {
              name: "Search Keywords",
              headers: ["keyword", "enabled"],
              rows: [{ keyword: "react developer", enabled: true }]
            }
          ]
        },
        review,
        schema,
        "configuration"
      ),
    /conflicting headers/
  );
});

test("generated setup has no legacy import surface or placeholder writes", async () => {
  const artifact = await readFile(
    new URL("../google-apps-script/SheetSetup.gs", import.meta.url),
    "utf8"
  );
  assert.match(artifact, /setupFreshJobPipeline/);
  assert.match(artifact, /hideSheet\(\)/);
  assert.match(artifact, /ensureSheetCapacity_/);
  assert.match(artifact, /insertRowsAfter/);
  assert.match(artifact, /insertColumnsAfter/);
  assert.match(artifact, /insertColumnsBefore/);
  assert.match(artifact, /configureSearchKeywordsSheet_/);
  assert.match(artifact, /requireCheckbox/);
  assert.match(artifact, /Search Keywords:header/);
  assert.match(artifact, /createdSheets\.has/);
  assert.match(artifact, /assertReconciliableHeaders_/);
  assert.match(artifact, /assertConsistentRecordHeaderVersions_/);
  assert.match(artifact, /upgradeLegacyRecordHeaders_/);
  assert.match(artifact, /requireValueInList\(rule\.values, true\)/);
  assert.match(artifact, /clearDataValidations/);
  assert.doesNotMatch(artifact, /Review Queue/);
  assert.ok(
    artifact.indexOf("assertReconciliableHeaders_(sheet, definition.headers)") <
      artifact.indexOf("workbook.insertSheet(name)"),
    "existing sheets must be preflighted before structural writes"
  );
  assert.match(
    artifact,
    /function reconcileHeaders_\(sheet, headers\) \{\s+const state = assertReconciliableHeaders_\(sheet, headers\);[\s\S]*?if \(!state\.hasHeader\) \{[\s\S]*?setValues\(\[headers\]\)/
  );
  assert.match(
    artifact,
    /function assertReconciliableHeaders_\(sheet, headers, legacyHeaders\) \{[\s\S]*?if \(lastRow > 1 && !hasHeader\) \{[\s\S]*?throw new Error\('Fresh setup found data without headers'\)/
  );
  assert.doesNotMatch(artifact, /openById|IMPORTRANGE|copyTo\(/i);
  assert.doesNotMatch(artifact, /appendRow|placeholder/i);
  for (const legacy of [
    "Dashboard",
    "AnalyticsReports",
    "RecommendationReports",
    "ProcessingClaims"
  ]) {
    assert.doesNotMatch(
      artifact.slice(artifact.indexOf("function setupFreshJobPipeline")),
      new RegExp(`insertSheet\\(['\"]${legacy}`)
    );
  }
});

test("migration planner deterministically routes every supported legacy combination", () => {
  const records = [
    validRecord({ source_job_id: "1", canonical_job_id: "onlinejobs.ph:1", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-1", pipeline_status: "new" }),
    validRecord({ source_job_id: "2", canonical_job_id: "onlinejobs.ph:2", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-2", pipeline_status: "processing", processing_stage: "evaluation", processing_token: "owner", processing_started_at: "2026-07-31T00:00:00.000Z" }),
    validRecord({ source_job_id: "3", canonical_job_id: "onlinejobs.ph:3", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-3", pipeline_status: "review_needed" }),
    validRecord({ source_job_id: "4", canonical_job_id: "onlinejobs.ph:4", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-4", pipeline_status: "review_needed", user_action: "Approve" }),
    validRecord({ source_job_id: "5", canonical_job_id: "onlinejobs.ph:5", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-5", pipeline_status: "review_needed", user_action: "Deny" }),
    validRecord({ source_job_id: "6", canonical_job_id: "onlinejobs.ph:6", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-6", pipeline_status: "ready_to_apply" }),
    validRecord({ source_job_id: "7", canonical_job_id: "onlinejobs.ph:7", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-7", pipeline_status: "ready_to_apply", user_action: "I Applied" }),
    validRecord({ source_job_id: "8", canonical_job_id: "onlinejobs.ph:8", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-8", pipeline_status: "ready_to_apply", user_action: "Skip" }),
    validRecord({ source_job_id: "9", canonical_job_id: "onlinejobs.ph:9", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-9", pipeline_status: "skip" }),
    validRecord({ source_job_id: "10", canonical_job_id: "onlinejobs.ph:10", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-10", pipeline_status: "error" }),
    validRecord({ source_job_id: "11", canonical_job_id: "onlinejobs.ph:11", canonical_url: "https://onlinejobs.ph/jobseekers/job/a-11", pipeline_status: "unavailable" })
  ];
  const snapshot = {
    sheets: [
      { name: "Review Queue", headers: schema.fields, rows: records },
      { name: "Applied Jobs", headers: schema.fields, rows: [] },
      { name: "Archive", headers: schema.fields, rows: [] },
      { name: "Search Keywords", headers: ["enabled", "keyword"], rows: [] },
      { name: "_System", headers: review.sheets.system.fields, rows: [] }
    ]
  };
  const first = planSegmentedQueueMigration(snapshot, review, schema, "2026-07-31T01:00:00.000Z");
  const second = planSegmentedQueueMigration(snapshot, review, schema, "2026-07-31T01:00:00.000Z");
  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.deepEqual(first.counts, {
    "Scraped Jobs": 4,
    "To Review": 3,
    "To Apply": 3,
    "Applied Jobs": 0,
    Archive: 1
  });
  assert.deepEqual(first.planned_source_deletions, []);
  assert.deepEqual(first.sheet_actions[0], {
    type: "rename_sheet",
    from: "Review Queue",
    to: "Scraped Jobs"
  });
});

test("migration planner fails closed for duplicate, stale, malformed, and conflicting input", () => {
  const duplicate = validRecord();
  const base = {
    sheets: [
      { name: "Review Queue", headers: schema.fields, rows: [duplicate, { ...duplicate }] },
      { name: "Applied Jobs", headers: schema.fields, rows: [] },
      { name: "Archive", headers: schema.fields, rows: [] }
    ]
  };
  const duplicatePlan = planSegmentedQueueMigration(base, review, schema);
  assert.equal(duplicatePlan.ok, false);
  assert.deepEqual(duplicatePlan.routes, []);
  assert.deepEqual(duplicatePlan.planned_source_deletions, []);
  assert.ok(duplicatePlan.rejects.some((reject) => reject.category === "duplicate_identity"));

  for (const fixture of [
    {
      sheets: [{ name: "Review Queue", headers: ["wrong"], rows: [duplicate] }],
      category: "conflicting_headers"
    },
    {
      sheets: [{ name: "Review Queue", headers: schema.fields, rows: [{ ...duplicate, pipeline_status: "mystery" }] }],
      category: "unsupported_status"
    },
    {
      sheets: [{ name: "Review Queue", headers: schema.fields, rows: [{ ...duplicate, user_action: "Launch" }] }],
      category: "unsupported_action"
    },
    {
      sheets: [
        { name: "Review Queue", headers: schema.fields, rows: [duplicate] },
        { name: "Scraped Jobs", headers: schema.fields, rows: [] }
      ],
      category: "conflicting_source_sheet"
    },
    {
      sheets: [{ name: "Legacy Data", headers: ["x"], rows: [["private"]] }],
      category: "unexpected_sheet"
    }
  ]) {
    const plan = planSegmentedQueueMigration({ sheets: fixture.sheets }, review, schema);
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.routes, []);
    assert.ok(plan.rejects.some((reject) => reject.category === fixture.category));
  }
});
