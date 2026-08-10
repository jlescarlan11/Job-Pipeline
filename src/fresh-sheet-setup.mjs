import {
  normalizeLegacyRecord,
  normalizeUserAction,
  stateGuard,
  stateGuardMatches,
  validateRecordContract,
  validateRecordStoreContract
} from "./contracts.mjs";

const RECORD_SHEET_KEYS = [
  "scraped_jobs",
  "to_review",
  "to_apply",
  "applied_jobs",
  "archive"
];
const LEGACY_RECORD_STORAGE_VERSION = "2026-08-04-preparation-lifecycle-v4";
const RECORD_HEADER_INSERTIONS = [
  {
    before: "review_case_id",
    fields: [
      "execution_mode",
      "automation_contract_version",
      "autonomous_decision",
      "browser_state",
      "browser_attempt_id",
      "browser_job_digest",
      "browser_context_digest",
      "browser_form_fingerprint",
      "submission_idempotency_key",
      "submission_started_at",
      "submission_confirmed_at",
      "submission_confirmation_kind",
      "submission_confirmation_reference",
      "submission_confirmation_digest",
      "submission_attestation_key_id",
      "submission_attestation_witness_digest",
      "submission_attestation_signature",
      "browser_block_category"
    ]
  }
];
const CONTEXT_SHEET_KEYS = [
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
];
const STEADY_STATE_SHEETS = [
  "Scraped Jobs",
  "To Review",
  "To Apply",
  "Applied Jobs",
  "Archive",
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
  "Prompts",
  "_System"
];
const MIGRATION_REJECT_CATEGORIES = new Set([
  "invalid_snapshot",
  "duplicate_sheet",
  "unexpected_sheet",
  "conflicting_headers",
  "missing_headers",
  "invalid_row",
  "unsupported_status",
  "unsupported_action",
  "unsupported_combination",
  "duplicate_identity",
  "conflicting_source_sheet"
]);

function hasUnexpectedContent(sheet) {
  return (
    (Array.isArray(sheet?.headers) && sheet.headers.some((value) => String(value || "").trim())) ||
    (Array.isArray(sheet?.rows) && sheet.rows.length > 0)
  );
}

function cloneRows(rows) {
  return (rows ?? []).map((row) =>
    Array.isArray(row) ? [...row] : { ...row }
  );
}

function applyHeaderInsertions(headers, insertions) {
  const result = [...headers];
  for (const insertion of insertions) {
    const beforeIndex = result.indexOf(insertion.before);
    if (beforeIndex < 0) {
      throw new Error(
        `Record header upgrade boundary is missing: ${insertion.before}`
      );
    }
    if (insertion.fields.some((field) => result.includes(field))) {
      throw new Error("Record header upgrade would insert a duplicate field");
    }
    result.splice(beforeIndex, 0, ...insertion.fields);
  }
  return result;
}

function expectedLegacyRecordFields(schema) {
  const inserted = new Set(
    RECORD_HEADER_INSERTIONS.flatMap((insertion) => insertion.fields)
  );
  return (schema?.fields ?? []).filter((field) => !inserted.has(field));
}

function recordHeaderVersion(headers, legacyFields, currentFields) {
  if (!Array.isArray(headers) || headers.length === 0) return "empty";
  if (JSON.stringify(headers) === JSON.stringify(currentFields)) return "current";
  if (JSON.stringify(headers) === JSON.stringify(legacyFields)) return "legacy";
  return "conflicting";
}

function assertRowsFitHeaders(sheet, fields) {
  for (const [index, row] of (sheet?.rows ?? []).entries()) {
    if (Array.isArray(row)) {
      if (
        row.slice(fields.length).some((value) => String(value ?? "").trim())
      ) {
        throw new Error(
          `Record header upgrade found row data beyond the declared headers in ${sheet.name} row ${index + 2}`
        );
      }
      continue;
    }
    if (row && typeof row === "object") {
      const extras = Object.entries(row).filter(
        ([field, value]) =>
          !fields.includes(field) && String(value ?? "").trim() !== ""
      );
      if (extras.length > 0) {
        throw new Error(
          `Record header upgrade found unknown row fields in ${sheet.name} row ${index + 2}`
        );
      }
      continue;
    }
    throw new Error(
      `Record header upgrade found an invalid row in ${sheet.name} row ${index + 2}`
    );
  }
}

export function planRecordHeaderUpgrade(snapshot, review, schema) {
  const configErrors = validateFreshSheetConfig(review, schema);
  if (configErrors.length > 0) {
    throw new Error(
      `Invalid record header upgrade configuration: ${configErrors.join("; ")}`
    );
  }
  if (!Array.isArray(snapshot?.sheets)) {
    throw new Error("Record header upgrade snapshot sheets must be an array");
  }

  const currentFields = schema.fields;
  const legacyFields = review.record_header_upgrade.legacy_fields;
  const expectedNames = new Set(schema.business_stores);
  const byName = new Map();
  for (const sheet of snapshot.sheets) {
    const name = String(sheet?.name || "").trim();
    if (!expectedNames.has(name)) continue;
    if (byName.has(name)) {
      throw new Error(`Record header upgrade found duplicate sheet: ${name}`);
    }
    byName.set(name, sheet);
  }

  const versions = new Map();
  for (const [name, sheet] of byName) {
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    const version = recordHeaderVersion(headers, legacyFields, currentFields);
    const hasRows = Array.isArray(sheet.rows) && sheet.rows.length > 0;
    if (version === "empty" && hasRows) {
      throw new Error(
        `Record header upgrade found data without headers in ${name}`
      );
    }
    if (version === "conflicting") {
      throw new Error(
        `Record header upgrade found conflicting headers in ${name}`
      );
    }
    assertRowsFitHeaders(sheet, version === "legacy" ? legacyFields : currentFields);
    versions.set(name, version);
  }

  const legacySheets = [...versions]
    .filter(([, version]) => version === "legacy")
    .map(([name]) => name);
  if (legacySheets.length > 0) {
    const everyLegacySheetPresent = schema.business_stores.every(
      (name) => versions.get(name) === "legacy"
    );
    if (!everyLegacySheetPresent) {
      throw new Error(
        "Record header upgrade refused mixed, missing, or partial record-sheet versions"
      );
    }
  }

  const operations = [];
  if (legacySheets.length > 0) {
    for (const name of schema.business_stores) {
      const evolving = [...legacyFields];
      for (const insertion of review.record_header_upgrade.insertions) {
        const beforeIndex = evolving.indexOf(insertion.before);
        operations.push({
          sheet: name,
          before_field: insertion.before,
          before_column: beforeIndex + 1,
          fields: [...insertion.fields]
        });
        evolving.splice(beforeIndex, 0, ...insertion.fields);
      }
      if (JSON.stringify(evolving) !== JSON.stringify(currentFields)) {
        throw new Error(
          `Record header upgrade did not produce the current schema for ${name}`
        );
      }
    }
  }

  return {
    mode: legacySheets.length > 0 ? "legacy_v4_to_v5" : "current_or_empty",
    from_storage_version:
      legacySheets.length > 0
        ? review.record_header_upgrade.from_storage_version
        : schema.storage_version,
    to_storage_version: schema.storage_version,
    operations
  };
}

export function validateFreshSheetConfig(review, schema) {
  const errors = [];
  if (review?.schema_version !== 9) {
    errors.push("review-sheet schema_version must be 9");
  }
  const configuredNames = Object.values(review?.sheets ?? {}).map(
    (sheet) => sheet?.name
  );
  if (
    new Set(configuredNames).size !== STEADY_STATE_SHEETS.length ||
    !STEADY_STATE_SHEETS.every((name) => configuredNames.includes(name))
  ) {
    errors.push(
      `exactly ${STEADY_STATE_SHEETS.join(", ")} are required`
    );
  }
  if (configuredNames.includes("Review Queue")) {
    errors.push("Review Queue is retired from the steady-state sheet contract");
  }
  for (const key of RECORD_SHEET_KEYS) {
    const definition = review?.sheets?.[key];
    if (
      definition?.visible !== true ||
      !schema?.business_stores?.includes(definition?.name) ||
      definition?.authoritative_for !==
        Object.entries(schema?.authoritative_stores ?? {}).find(
          ([, name]) => name === definition?.name
        )?.[0]
    ) {
      errors.push(`${key} must be a visible authoritative business sheet`);
    }
    if (
      !Array.isArray(definition?.visible_columns) ||
      definition.visible_columns.some((field) => !schema?.fields?.includes(field))
    ) {
      errors.push(`${key} visible_columns must use pipeline record fields`);
    }
    if (
      !schema?.timestamp_fields?.includes(definition?.latest_first_column)
    ) {
      errors.push(`${key} latest_first_column must use a pipeline timestamp field`);
    }
  }
  const keywordSheet = review?.sheets?.search_keywords;
  if (
    keywordSheet?.visible !== true ||
    JSON.stringify(keywordSheet?.fields) !==
      JSON.stringify(["enabled", "keyword"])
  ) {
    errors.push(
      "Search Keywords must be visible with exact enabled and keyword fields"
    );
  }
  const seedRows = keywordSheet?.initial_rows;
  if (!Array.isArray(seedRows) || seedRows.length !== 10) {
    errors.push("Search Keywords must define exactly ten initial rows");
  } else {
    const normalizedKeywords = new Set();
    for (const row of seedRows) {
      const keyword =
        typeof row?.keyword === "string"
          ? row.keyword.normalize("NFKC").trim()
          : "";
      const normalized = keyword.toLocaleLowerCase("en-US");
      if (row?.enabled !== true || !keyword) {
        errors.push(
          "every initial Search Keywords row must be enabled with a keyword"
        );
        continue;
      }
      if (normalizedKeywords.has(normalized)) {
        errors.push("initial Search Keywords rows must be unique");
      }
      normalizedKeywords.add(normalized);
    }
  }
  const expectedContextFields = {
    candidate: ["field", "value"],
    skills: ["enabled", "category", "skill"],
    experience: [
      "enabled",
      "experience_id",
      "title",
      "organization",
      "location",
      "start",
      "end",
      "highlight"
    ],
    projects: [
      "enabled",
      "project_id",
      "name",
      "description",
      "url",
      "technologies",
      "highlight"
    ],
    education: ["enabled", "program", "institution", "start", "end", "honor"],
    awards: ["enabled", "award"],
    job_preferences: ["enabled", "type", "group", "value", "score"],
    application_settings: ["key", "value"],
    required_style: ["enabled", "style"],
    banned_phrases: ["enabled", "phrase"],
    prompts: ["prompt_key", "template"]
  };
  for (const key of CONTEXT_SHEET_KEYS) {
    const definition = review?.sheets?.[key];
    if (
      definition?.visible !== true ||
      JSON.stringify(definition?.fields) !==
        JSON.stringify(expectedContextFields[key]) ||
      !Array.isArray(definition?.initial_rows) ||
      definition.initial_rows.length === 0
    ) {
      errors.push(`${key} must be a visible seeded context sheet with exact fields`);
    }
  }
  if (
    JSON.stringify(review?.all_record_columns) !==
    JSON.stringify(schema?.fields)
  ) {
    errors.push("all_record_columns must exactly match schema fields");
  }
  const upgrade = review?.record_header_upgrade;
  const expectedLegacyFields = expectedLegacyRecordFields(schema);
  if (upgrade?.from_storage_version !== LEGACY_RECORD_STORAGE_VERSION) {
    errors.push(
      `record_header_upgrade must start from ${LEGACY_RECORD_STORAGE_VERSION}`
    );
  }
  if (
    JSON.stringify(upgrade?.legacy_fields) !==
    JSON.stringify(expectedLegacyFields)
  ) {
    errors.push(
      "record_header_upgrade legacy_fields must exactly match the v4 record layout"
    );
  }
  if (
    JSON.stringify(upgrade?.insertions) !==
    JSON.stringify(RECORD_HEADER_INSERTIONS)
  ) {
    errors.push("record_header_upgrade insertions must match the v5 boundaries");
  } else if (
    JSON.stringify(
      applyHeaderInsertions(expectedLegacyFields, upgrade.insertions)
    ) !== JSON.stringify(schema?.fields)
  ) {
    errors.push("record_header_upgrade must produce the exact current schema");
  }
  const expectedActionValidation = {
    "To Review": { values: ["Proceed", "Reject"], allow_blank: true },
    "To Apply": { values: ["I Applied", "Skip"], allow_blank: true },
    "Scraped Jobs": { values: [], allow_blank: true }
  };
  if (
    JSON.stringify(review?.action_validation) !==
    JSON.stringify(expectedActionValidation)
  ) {
    errors.push("action_validation must match the three queue-specific controls");
  }
  if (
    JSON.stringify(review?.fresh_start?.required_empty_data_sheets) !==
    JSON.stringify(schema?.business_stores)
  ) {
    errors.push("fresh setup must require every business store to start empty");
  }
  if (review?.fresh_start?.imports_legacy_rows !== false) {
    errors.push("fresh setup must explicitly disable legacy imports");
  }
  const forbidden = new Set(review?.fresh_start?.forbidden_legacy_sheets ?? []);
  for (const name of [
    "Sheet1",
    "Dashboard",
    "Analytics",
    "AnalyticsReports",
    "Recommendations",
    "RecommendationReports",
    "ProcessingClaims"
  ]) {
    if (!forbidden.has(name)) {
      errors.push(`fresh setup must retire ${name}`);
    }
  }
  return errors;
}

export function planFreshWorkbookSetup(
  snapshot,
  review,
  schema,
  workbookRole
) {
  const configErrors = validateFreshSheetConfig(review, schema);
  if (configErrors.length > 0) {
    throw new Error(`Invalid fresh sheet configuration: ${configErrors.join("; ")}`);
  }
  if (!Array.isArray(snapshot?.sheets)) {
    throw new Error("Workbook snapshot sheets must be an array");
  }
  if (!new Set(["main", "configuration"]).has(workbookRole)) {
    throw new Error("Workbook role must be main or configuration");
  }

  const recordDefinitions = RECORD_SHEET_KEYS.map((key) => {
      const definition = review.sheets[key];
      return [
        definition.name,
        {
          headers: schema.fields,
          visible: true,
          editable: review.editable_columns[definition.name],
          visibleColumns: definition.visible_columns
        }
      ];
    });
  const configurationDefinitions = [
    [
      review.sheets.search_keywords.name,
      {
        headers: review.sheets.search_keywords.fields,
        visible: true,
        editable: review.sheets.search_keywords.fields,
        visibleColumns: review.sheets.search_keywords.fields,
        seedRows: review.sheets.search_keywords.initial_rows
      }
    ],
    ...CONTEXT_SHEET_KEYS.map((key) => {
      const definition = review.sheets[key];
      return [
        definition.name,
        {
          headers: definition.fields,
          visible: true,
          editable: definition.fields,
          visibleColumns: definition.fields,
          seedRows: definition.initial_rows,
          contextSheet: true
        }
      ];
    }),
    [
      review.sheets.system.name,
      {
        headers: review.sheets.system.fields,
        visible: false,
        editable: [],
        visibleColumns: []
      }
    ]
  ];
  const expected = new Map(
    workbookRole === "main"
      ? [...recordDefinitions, configurationDefinitions.at(-1)]
      : configurationDefinitions.slice(0, -1)
  );
  const recordHeaderPlan = workbookRole === "main"
    ? planRecordHeaderUpgrade(snapshot, review, schema)
    : null;

  const currentByName = new Map();
  for (const sheet of snapshot.sheets) {
    const name = String(sheet?.name || "").trim();
    if (!name || currentByName.has(name)) {
      throw new Error("Workbook contains a missing or duplicate sheet name");
    }
    currentByName.set(name, sheet);
  }

  for (const [name, sheet] of currentByName) {
    if (!expected.has(name) && hasUnexpectedContent(sheet)) {
      throw new Error(`Fresh setup refused non-empty unexpected sheet: ${name.slice(0, 120)}`);
    }
  }

  const sheets = [];
  for (const [name, definition] of expected) {
    const current = currentByName.get(name);
    const existingHeaders = current?.headers ?? [];
    const isLegacyRecordSheet =
      recordHeaderPlan?.mode === "legacy_v4_to_v5" &&
      schema.business_stores.includes(name);
    if (
      existingHeaders.some((value) => String(value || "").trim()) &&
      JSON.stringify(existingHeaders) !== JSON.stringify(definition.headers) &&
      !(
        isLegacyRecordSheet &&
        JSON.stringify(existingHeaders) ===
          JSON.stringify(review.record_header_upgrade.legacy_fields)
      )
    ) {
      throw new Error(`Fresh setup found conflicting headers in ${name}`);
    }
    let rows = current
      ? cloneRows(current.rows)
      : cloneRows(definition.seedRows);
    if (isLegacyRecordSheet) {
      const operations = recordHeaderPlan.operations.filter(
        (operation) => operation.sheet === name
      );
      rows = rows.map((row) => {
        if (!Array.isArray(row)) {
          return Object.fromEntries(
            definition.headers.map((field) => [field, row?.[field] ?? ""])
          );
        }
        const upgraded = row.slice(
          0,
          review.record_header_upgrade.legacy_fields.length
        );
        for (const operation of operations) {
          upgraded.splice(
            operation.before_column - 1,
            0,
            ...operation.fields.map(() => "")
          );
        }
        return upgraded;
      });
    }
    const hiddenColumns = definition.headers.filter(
      (field) => !definition.visibleColumns.includes(field)
    );
    const protectedColumns = definition.headers.filter(
      (field) => !definition.editable.includes(field)
    );
    sheets.push({
      name,
      headers: [...definition.headers],
      rows,
      hidden: !definition.visible,
      hiddenColumns,
      protectedColumns,
      protectedHeader:
        name === review.sheets.search_keywords.name ||
        definition.contextSheet === true,
      validations:
        name === "To Review" || name === "To Apply"
          ? { user_action: structuredClone(review.action_validation[name]) }
          : name === "Applied Jobs"
            ? { outcome: [...review.outcome_validation] }
            : name === review.sheets.search_keywords.name ||
                (definition.contextSheet === true &&
                  definition.headers.includes("enabled"))
              ? { enabled: "checkbox" }
            : {}
    });
  }

  return {
    timezone: review.timezone,
    sheets
  };
}

/**
 * Classifies an exact five-store snapshot for the v5 contract. The plan is
 * deliberately read-only: structural setup may add columns, but no business
 * row gains autonomous authority or changes stores through this planner.
 */
export function planAutonomousContractMigration(snapshot, schema) {
  const capturedAt = String(snapshot?.captured_at || "");
  const plan = {
    contract_version: schema?.storage_version || "",
    captured_at: capturedAt,
    ok: false,
    writes_allowed: false,
    business_row_relocation_allowed: false,
    classifications: [],
    counts: {
      autonomous_compatible: 0,
      legacy_manual: 0,
      blocked: 0,
      rejected: 0
    }
  };
  if (!Number.isFinite(Date.parse(capturedAt))) {
    plan.classifications.push({
      classification: "rejected",
      store: "",
      row_number: null,
      canonical_job_id: "",
      reason: "captured_at must be a valid exact-reread timestamp"
    });
    plan.counts.rejected += 1;
    return plan;
  }
  const stores = snapshot?.stores;
  if (!stores || typeof stores !== "object" || Array.isArray(stores)) {
    plan.classifications.push({
      classification: "rejected",
      store: "",
      row_number: null,
      canonical_job_id: "",
      reason: "stores must contain the exact five-store snapshot"
    });
    plan.counts.rejected += 1;
    return plan;
  }
  const actualStores = Object.keys(stores).sort();
  const expectedStores = [...(schema?.business_stores ?? [])].sort();
  if (JSON.stringify(actualStores) !== JSON.stringify(expectedStores)) {
    plan.classifications.push({
      classification: "rejected",
      store: "",
      row_number: null,
      canonical_job_id: "",
      reason: "snapshot must contain exactly the five business stores"
    });
    plan.counts.rejected += 1;
    return plan;
  }
  const owners = new Map();
  for (const store of schema.business_stores) {
    if (!Array.isArray(stores[store])) {
      plan.classifications.push({
        classification: "rejected",
        store,
        row_number: null,
        canonical_job_id: "",
        reason: "store rows must be an array"
      });
      plan.counts.rejected += 1;
      continue;
    }
    for (const [index, raw] of stores[store].entries()) {
      const rowNumber = Number.isInteger(raw?.row_number)
        ? raw.row_number
        : index + 2;
      const record = normalizeLegacyRecord(raw, schema, capturedAt);
      const canonicalId = String(record.canonical_job_id || "");
      const errors = validateRecordStoreContract(record, store, schema);
      if (!String(raw?.state_guard || "") || !stateGuardMatches(record)) {
        errors.push("state_guard is missing or stale");
      }
      const identityKey = canonicalId
        .normalize("NFKC")
        .toLocaleLowerCase("en-US");
      if (identityKey && owners.has(identityKey)) {
        errors.push("canonical identity has more than one store owner");
      } else if (identityKey) {
        owners.set(identityKey, { store, row_number: rowNumber });
      }
      let classification = "legacy_manual";
      let reason = "blank or legacy execution mode remains manual-only";
      if (errors.length > 0) {
        classification = "rejected";
        reason = errors.join("; ").slice(0, 500);
      } else if (record.execution_mode === "autonomous_chrome") {
        classification = record.browser_state === "blocked"
          ? "blocked"
          : "autonomous_compatible";
        reason = record.browser_state === "blocked"
          ? "bounded autonomous blocker remains non-submittable"
          : "current autonomous record is contract-compatible";
      }
      plan.classifications.push({
        classification,
        store,
        row_number: rowNumber,
        canonical_job_id: canonicalId,
        reason
      });
      plan.counts[classification] += 1;
    }
  }
  plan.ok = plan.counts.rejected === 0;
  return plan;
}

function migrationReject(category, details = {}) {
  if (!MIGRATION_REJECT_CATEGORIES.has(category)) {
    throw new Error(`Unknown migration rejection category: ${category}`);
  }
  const summary = String(details.summary || "")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
  return { category, ...details, summary };
}

function rowObject(row, headers) {
  if (Array.isArray(row)) {
    return Object.fromEntries(headers.map((field, index) => [field, row[index] ?? ""]));
  }
  if (row && typeof row === "object") return { ...row };
  return null;
}

function migrationDestination(status, action) {
  if (["new", "processing", "error", "unavailable"].includes(status)) {
    return action === "" ? { sheet: "Scraped Jobs", reason: "operational" } : null;
  }
  if (status === "review_needed") {
    return ["", "Proceed", "Reject"].includes(action)
      ? { sheet: "To Review", reason: action ? "pending_review_action" : "review_needed" }
      : null;
  }
  if (status === "ready_to_apply") {
    return ["", "I Applied", "Skip"].includes(action)
      ? { sheet: "To Apply", reason: action ? "pending_application_action" : "ready_to_apply" }
      : null;
  }
  if (status === "skip" && action === "") {
    return { sheet: "Archive", reason: "automatic_skip" };
  }
  return null;
}

export function planSegmentedQueueMigration(
  snapshot,
  review,
  schema,
  now = new Date().toISOString()
) {
  const rejects = [];
  const configErrors = validateFreshSheetConfig(review, schema);
  if (configErrors.length > 0) {
    return {
      ok: false,
      contract_version: schema?.storage_version || "",
      sheet_actions: [],
      routes: [],
      planned_source_deletions: [],
      counts: {},
      rejects: configErrors.map((summary) =>
        migrationReject("invalid_snapshot", { summary })
      )
    };
  }
  if (!Array.isArray(snapshot?.sheets)) {
    return {
      ok: false,
      contract_version: schema.storage_version,
      sheet_actions: [],
      routes: [],
      planned_source_deletions: [],
      counts: {},
      rejects: [
        migrationReject("invalid_snapshot", {
          summary: "Workbook snapshot sheets must be an array"
        })
      ]
    };
  }

  const byName = new Map();
  for (const sheet of snapshot.sheets) {
    const name = String(sheet?.name || "").trim();
    if (!name) {
      rejects.push(
        migrationReject("invalid_snapshot", { summary: "Sheet name is missing" })
      );
      continue;
    }
    if (byName.has(name)) {
      rejects.push(
        migrationReject("duplicate_sheet", { sheet: name, summary: "Duplicate sheet name" })
      );
      continue;
    }
    byName.set(name, sheet);
  }

  const known = new Set([...STEADY_STATE_SHEETS, "Review Queue"]);
  for (const [name, sheet] of byName) {
    if (!known.has(name) && hasUnexpectedContent(sheet)) {
      rejects.push(
        migrationReject("unexpected_sheet", {
          sheet: name,
          summary: "Unexpected non-empty sheet"
        })
      );
    }
  }
  if (byName.has("Review Queue") && byName.has("Scraped Jobs")) {
    rejects.push(
      migrationReject("conflicting_source_sheet", {
        sheet: "Review Queue",
        summary: "Review Queue and Scraped Jobs cannot coexist during migration"
      })
    );
  }

  for (const definition of [
    review.sheets.search_keywords,
    review.sheets.system
  ]) {
    const sheet = byName.get(definition.name);
    if (!sheet) continue;
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    if ((sheet.rows ?? []).length > 0 && headers.length === 0) {
      rejects.push(
        migrationReject("missing_headers", {
          sheet: definition.name,
          summary: "Sheet rows exist without headers"
        })
      );
    } else if (
      headers.length > 0 &&
      JSON.stringify(headers) !== JSON.stringify(definition.fields)
    ) {
      rejects.push(
        migrationReject("conflicting_headers", {
          sheet: definition.name,
          summary: "Sheet headers do not match the authoritative configuration"
        })
      );
    }
  }

  const recordSheetNames = ["Review Queue", ...schema.business_stores];
  const normalizedRows = [];
  for (const name of recordSheetNames) {
    const sheet = byName.get(name);
    if (!sheet) continue;
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    const hasRows = Array.isArray(sheet.rows) && sheet.rows.length > 0;
    if (hasRows && headers.length === 0) {
      rejects.push(
        migrationReject("missing_headers", {
          sheet: name,
          summary: "Record rows exist without headers"
        })
      );
      continue;
    }
    if (
      headers.length > 0 &&
      JSON.stringify(headers) !== JSON.stringify(schema.fields)
    ) {
      rejects.push(
        migrationReject("conflicting_headers", {
          sheet: name,
          summary: "Record headers do not match the authoritative schema"
        })
      );
      continue;
    }
    for (const [index, rawRow] of (sheet.rows ?? []).entries()) {
      const raw = rowObject(rawRow, schema.fields);
      const rowNumber = index + 2;
      if (!raw) {
        rejects.push(
          migrationReject("invalid_row", {
            sheet: name,
            row_number: rowNumber,
            summary: "Record row must be an object or ordered field array"
          })
        );
        continue;
      }
      const status = String(raw.pipeline_status || "").trim().toLowerCase();
      const action = normalizeUserAction(raw.user_action, schema);
      if (!schema.pipeline_statuses.includes(status)) {
        rejects.push(
          migrationReject("unsupported_status", {
            sheet: name,
            row_number: rowNumber,
            summary: "Record has an unsupported pipeline status"
          })
        );
        continue;
      }
      if (!schema.user_actions.includes(action)) {
        rejects.push(
          migrationReject("unsupported_action", {
            sheet: name,
            row_number: rowNumber,
            summary: "Record has an unsupported user action"
          })
        );
        continue;
      }
      const record = normalizeLegacyRecord(
        { ...raw, pipeline_status: status, user_action: action },
        schema,
        now
      );
      const contractErrors =
        name === "Review Queue"
          ? validateRecordContract(record, schema)
          : validateRecordStoreContract(record, name, schema);
      if (contractErrors.length > 0) {
        rejects.push(
          migrationReject("invalid_row", {
            sheet: name,
            row_number: rowNumber,
            canonical_job_id: record.canonical_job_id || "",
            summary: contractErrors.join("; ")
          })
        );
        continue;
      }
      normalizedRows.push({ sheet: name, row_number: rowNumber, record });
    }
  }

  const identities = new Map();
  for (const entry of normalizedRows) {
    const key = String(entry.record.canonical_job_id || "")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    const previous = identities.get(key);
    if (previous) {
      rejects.push(
        migrationReject("duplicate_identity", {
          sheet: entry.sheet,
          row_number: entry.row_number,
          canonical_job_id: entry.record.canonical_job_id,
          summary: `Duplicate identity also appears at ${previous.sheet} row ${previous.row_number}`
        })
      );
    } else {
      identities.set(key, entry);
    }
  }

  const sourceRows = normalizedRows.filter((entry) => entry.sheet === "Review Queue");
  const routes = [];
  for (const entry of sourceRows) {
    const destination = migrationDestination(
      entry.record.pipeline_status,
      entry.record.user_action
    );
    if (!destination) {
      rejects.push(
        migrationReject("unsupported_combination", {
          sheet: entry.sheet,
          row_number: entry.row_number,
          canonical_job_id: entry.record.canonical_job_id,
          summary: "Status and action cannot be migrated without coercion"
        })
      );
      continue;
    }
    routes.push({
      canonical_job_id: entry.record.canonical_job_id,
      source_sheet: "Review Queue",
      source_row_number: entry.row_number,
      expected_record_version: entry.record.record_version,
      expected_state_guard: stateGuard(entry.record),
      destination_sheet: destination.sheet,
      route_reason: destination.reason
    });
  }

  if (rejects.length > 0) {
    return {
      ok: false,
      contract_version: schema.storage_version,
      sheet_actions: [],
      routes: [],
      planned_source_deletions: [],
      counts: {},
      rejects
    };
  }

  const sheetActions = [];
  if (byName.has("Review Queue")) {
    sheetActions.push({
      type: "rename_sheet",
      from: "Review Queue",
      to: "Scraped Jobs"
    });
  }
  for (const name of STEADY_STATE_SHEETS) {
    if (name === "Scraped Jobs" && byName.has("Review Queue")) continue;
    if (!byName.has(name)) sheetActions.push({ type: "create_sheet", name });
  }
  const counts = Object.fromEntries(
    schema.business_stores.map((name) => [
      name,
      routes.filter((route) => route.destination_sheet === name).length
    ])
  );
  return {
    ok: true,
    contract_version: schema.storage_version,
    sheet_actions: sheetActions,
    routes,
    planned_source_deletions: [],
    counts,
    rejects: []
  };
}
