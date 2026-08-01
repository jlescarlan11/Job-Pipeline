function integer(value) {
  return Number.isInteger(value);
}

export function latestFirstSortRequests(metadata, schema, latestFirstBySheet) {
  if (!Array.isArray(metadata?.sheets)) {
    throw new Error("Latest-first sorting requires workbook sheet metadata");
  }
  if (!Array.isArray(schema?.fields) || !Array.isArray(schema?.business_stores)) {
    throw new Error("Latest-first sorting requires the pipeline schema");
  }

  const fields = schema.fields;
  const metadataByTitle = new Map(
    metadata.sheets.map((sheet) => [sheet?.properties?.title, sheet?.properties])
  );
  const createdAtIndex = fields.indexOf("created_at");
  const identityIndex = fields.indexOf("canonical_job_id");
  if (createdAtIndex < 0 || identityIndex < 0) {
    throw new Error("Latest-first sorting requires created_at and canonical_job_id");
  }

  return schema.business_stores.map((name) => {
    const properties = metadataByTitle.get(name);
    const latestIndex = fields.indexOf(latestFirstBySheet?.[name]);
    const rowCount = Number(properties?.gridProperties?.rowCount);
    const columnCount = Number(properties?.gridProperties?.columnCount);
    if (
      latestIndex < 0 ||
      !integer(properties?.sheetId) ||
      !integer(rowCount) ||
      rowCount < 2 ||
      !integer(columnCount) ||
      columnCount < fields.length
    ) {
      throw new Error(`Latest-first sorting found invalid metadata for ${name}`);
    }

    return {
      sortRange: {
        range: {
          sheetId: properties.sheetId,
          startRowIndex: 1,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: fields.length
        },
        sortSpecs: [
          { dimensionIndex: latestIndex, sortOrder: "DESCENDING" },
          { dimensionIndex: createdAtIndex, sortOrder: "DESCENDING" },
          { dimensionIndex: identityIndex, sortOrder: "ASCENDING" }
        ]
      }
    };
  });
}
