function normalizedSheetTitle(range) {
  const text = String(range || "").trim();
  const separator = text.indexOf("!");
  if (separator < 1) return "";
  const raw = text.slice(0, separator);
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function nonBlankRow(values) {
  return Array.isArray(values) && values.some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim() !== "";
  });
}

function assertDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("Batch Sheet definitions must be a non-empty array");
  }
  const names = new Set();
  for (const definition of definitions) {
    const name = String(definition?.name || "");
    if (!name || names.has(name)) {
      throw new Error("Batch Sheet definitions contain a missing or duplicate title");
    }
    if (
      !Array.isArray(definition?.fields) ||
      definition.fields.length === 0 ||
      new Set(definition.fields).size !== definition.fields.length
    ) {
      throw new Error(`${name} has an invalid field contract`);
    }
    names.add(name);
  }
}

export function parseBatchSheetRows(response, definitions) {
  assertDefinitions(definitions);
  const valueRanges = response?.valueRanges;
  if (!Array.isArray(valueRanges)) {
    throw new Error("Google Sheets batch response is missing valueRanges");
  }
  const byTitle = new Map();
  for (const valueRange of valueRanges) {
    const title = normalizedSheetTitle(valueRange?.range);
    if (!title || byTitle.has(title)) {
      throw new Error("Google Sheets batch response contains an ambiguous range");
    }
    byTitle.set(title, valueRange);
  }

  const result = {};
  for (const definition of definitions) {
    const valueRange = byTitle.get(definition.name);
    if (!valueRange) {
      throw new Error(`Google Sheets batch response is missing ${definition.name}`);
    }
    const values = Array.isArray(valueRange.values) ? valueRange.values : [];
    if (values.length === 0) {
      throw new Error(`${definition.name} is missing its header row`);
    }
    const headers = Array.isArray(values[0])
      ? values[0].map((value) => String(value || "").trim())
      : [];
    if (JSON.stringify(headers) !== JSON.stringify(definition.fields)) {
      throw new Error(`${definition.name} headers do not match the configured contract`);
    }
    result[definition.name] = values.slice(1).flatMap((row, index) => {
      if (!nonBlankRow(row)) return [];
      const record = Object.fromEntries(
        definition.fields.map((field, column) => [field, row?.[column] ?? ""])
      );
      return [{ ...record, row_number: index + 2 }];
    });
  }
  return result;
}

export function googleSheetsBatchRanges(sheetNames) {
  if (!Array.isArray(sheetNames) || sheetNames.length === 0) {
    throw new Error("At least one Sheet range is required");
  }
  const seen = new Set();
  return sheetNames.map((name) => {
    const title = String(name || "");
    if (!title || seen.has(title)) {
      throw new Error("Sheet ranges contain a missing or duplicate title");
    }
    seen.add(title);
    return `'${title.replace(/'/g, "''")}'`;
  });
}
