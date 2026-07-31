import {
  normalizeLegacyRecord,
  stateGuard,
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
const CONTEXT_SHEET_KEYS = [
  "candidate",
  "skills",
  "experience",
  "projects",
  "education",
  "awards",
  "job_preferences",
  "application_preferences"
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
  "Application Preferences",
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

export function validateFreshSheetConfig(review, schema) {
  const errors = [];
  if (review?.schema_version !== 5) {
    errors.push("review-sheet schema_version must be 5");
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
    application_preferences: ["enabled", "type", "key", "value"]
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
  const expectedActionValidation = {
    "To Review": { values: ["Approve", "Deny"], allow_blank: true },
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

export function planFreshWorkbookSetup(snapshot, review, schema) {
  const configErrors = validateFreshSheetConfig(review, schema);
  if (configErrors.length > 0) {
    throw new Error(`Invalid fresh sheet configuration: ${configErrors.join("; ")}`);
  }
  if (!Array.isArray(snapshot?.sheets)) {
    throw new Error("Workbook snapshot sheets must be an array");
  }

  const expected = new Map([
    ...RECORD_SHEET_KEYS.map((key) => {
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
    }),
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
  ]);

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
    if (
      existingHeaders.some((value) => String(value || "").trim()) &&
      JSON.stringify(existingHeaders) !== JSON.stringify(definition.headers)
    ) {
      throw new Error(`Fresh setup found conflicting headers in ${name}`);
    }
    const rows = current
      ? cloneRows(current.rows)
      : cloneRows(definition.seedRows);
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
    return ["", "Approve", "Deny"].includes(action)
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
      const action = String(raw.user_action || "").trim();
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
