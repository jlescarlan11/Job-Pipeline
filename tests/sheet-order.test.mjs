import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { latestFirstSortRequests } from "../src/sheet-order.mjs";

const loadJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url)));
const schema = await loadJson("../config/pipeline-schema.json");
const review = await loadJson("../config/review-sheet.json");
const latestFirstBusinessSheets = Object.fromEntries(
  Object.values(review.sheets)
    .filter((definition) => schema.business_stores.includes(definition.name))
    .map((definition) => [definition.name, definition.latest_first_column])
);

function metadata() {
  return {
    sheets: schema.business_stores.map((title, index) => ({
      properties: {
        sheetId: 100 + index,
        title,
        gridProperties: {
          rowCount: 2000,
          columnCount: schema.fields.length
        }
      }
    }))
  };
}

test("all business sheets sort newest lifecycle events first with stable ties", () => {
  const requests = latestFirstSortRequests(
    metadata(),
    schema,
    latestFirstBusinessSheets
  );
  const expectedLatestFields = [
    "discovered_at",
    "evaluated_at",
    "generated_at",
    "applied_at",
    "archived_at"
  ];
  assert.equal(requests.length, schema.business_stores.length);
  requests.forEach((request, index) => {
    assert.deepEqual(request.sortRange.range, {
      sheetId: 100 + index,
      startRowIndex: 1,
      endRowIndex: 2000,
      startColumnIndex: 0,
      endColumnIndex: schema.fields.length
    });
    assert.deepEqual(request.sortRange.sortSpecs, [
      {
        dimensionIndex: schema.fields.indexOf(expectedLatestFields[index]),
        sortOrder: "DESCENDING"
      },
      {
        dimensionIndex: schema.fields.indexOf("created_at"),
        sortOrder: "DESCENDING"
      },
      {
        dimensionIndex: schema.fields.indexOf("canonical_job_id"),
        sortOrder: "ASCENDING"
      }
    ]);
  });
});

test("latest-first sorting can be limited to movement-touched stores", () => {
  const requests = latestFirstSortRequests(metadata(), schema, {
    "Scraped Jobs": "discovered_at",
    "To Review": "evaluated_at"
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.sortRange.range.sheetId),
    [100, 101]
  );
  assert.throws(
    () =>
      latestFirstSortRequests(metadata(), schema, {
        Unknown: "created_at"
      }),
    /unknown business sheets/
  );
});

test("latest-first sorting fails closed on incomplete workbook metadata", () => {
  const incomplete = metadata();
  incomplete.sheets = incomplete.sheets.filter(
    (sheet) => sheet.properties.title !== "Applied Jobs"
  );
  assert.throws(
    () => latestFirstSortRequests(
      incomplete,
      schema,
      latestFirstBusinessSheets
    ),
    /invalid metadata for Applied Jobs/
  );
});
