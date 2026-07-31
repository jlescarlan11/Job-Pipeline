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
  if (review?.schema_version !== 3) {
    errors.push("review-sheet schema_version must be 3");
  }
  const configuredNames = Object.values(review?.sheets ?? {}).map(
    (sheet) => sheet?.name
  );
  if (
    new Set(configuredNames).size !== 5 ||
    ![
      "Review Queue",
      "Applied Jobs",
      "Archive",
      "Search Keywords",
      "_System"
    ].every((name) => configuredNames.includes(name))
  ) {
    errors.push(
      "exactly Review Queue, Applied Jobs, Archive, Search Keywords, and _System are required"
    );
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
  if (
    JSON.stringify(review?.all_record_columns) !==
    JSON.stringify(schema?.fields)
  ) {
    errors.push("all_record_columns must exactly match schema fields");
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
    [
      review.sheets.review_queue.name,
      {
        headers: schema.fields,
        visible: true,
        editable: review.editable_columns["Review Queue"],
        visibleColumns: review.sheets.review_queue.visible_columns
      }
    ],
    [
      review.sheets.applied_jobs.name,
      {
        headers: schema.fields,
        visible: true,
        editable: review.editable_columns["Applied Jobs"],
        visibleColumns: review.sheets.applied_jobs.visible_columns
      }
    ],
    [
      review.sheets.archive.name,
      {
        headers: schema.fields,
        visible: true,
        editable: review.editable_columns.Archive,
        visibleColumns: review.sheets.archive.visible_columns
      }
    ],
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
      protectedHeader: name === review.sheets.search_keywords.name,
      validations:
        name === "Review Queue"
          ? {
              user_action: structuredClone(review.action_validation)
            }
          : name === "Applied Jobs"
            ? { outcome: [...review.outcome_validation] }
            : name === review.sheets.search_keywords.name
              ? { enabled: "checkbox" }
            : {}
    });
  }

  return {
    timezone: review.timezone,
    sheets
  };
}
