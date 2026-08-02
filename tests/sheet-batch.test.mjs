import assert from "node:assert/strict";
import test from "node:test";
import {
  googleSheetsBatchRanges,
  parseBatchSheetRows
} from "../src/sheet-batch.mjs";

const definitions = [
  { name: "Scraped Jobs", fields: ["canonical_job_id", "pipeline_status"] },
  { name: "To Apply", fields: ["canonical_job_id", "pipeline_status"] }
];

test("batch Sheet parsing preserves ownership and reconstructs row numbers", () => {
  const parsed = parseBatchSheetRows(
    {
      valueRanges: [
        {
          range: "'Scraped Jobs'!A1:B4",
          values: [
            ["canonical_job_id", "pipeline_status"],
            ["onlinejobs.ph:1", "new"],
            [],
            ["onlinejobs.ph:2", "review_needed"]
          ]
        },
        {
          range: "'To Apply'!A1:B1",
          values: [["canonical_job_id", "pipeline_status"]]
        }
      ]
    },
    definitions
  );
  assert.deepEqual(parsed, {
    "Scraped Jobs": [
      {
        canonical_job_id: "onlinejobs.ph:1",
        pipeline_status: "new",
        row_number: 2
      },
      {
        canonical_job_id: "onlinejobs.ph:2",
        pipeline_status: "review_needed",
        row_number: 4
      }
    ],
    "To Apply": []
  });
});

test("header-only ranges normalize to empty arrays without blank records", () => {
  const parsed = parseBatchSheetRows(
    {
      valueRanges: definitions.map((definition) => ({
        range: `'${definition.name}'!A1:B1`,
        values: [definition.fields]
      }))
    },
    definitions
  );
  assert.deepEqual(parsed, { "Scraped Jobs": [], "To Apply": [] });
});

test("batch Sheet parsing fails closed on missing, duplicate, or drifted ranges", () => {
  assert.throws(
    () =>
      parseBatchSheetRows(
        {
          valueRanges: [
            {
              range: "'Scraped Jobs'!A1:B1",
              values: [["pipeline_status", "canonical_job_id"]]
            }
          ]
        },
        definitions
      ),
    /headers do not match|missing To Apply/
  );
  assert.throws(
    () =>
      parseBatchSheetRows(
        {
          valueRanges: [
            {
              range: "'Scraped Jobs'!A1:B1",
              values: [definitions[0].fields]
            },
            {
              range: "'Scraped Jobs'!A1:B1",
              values: [definitions[0].fields]
            }
          ]
        },
        definitions
      ),
    /ambiguous range/
  );
});

test("batch range construction is ordered, escaped, and duplicate-safe", () => {
  assert.deepEqual(googleSheetsBatchRanges(["Scraped Jobs", "Owner's Queue"]), [
    "'Scraped Jobs'",
    "'Owner''s Queue'"
  ]);
  assert.throws(
    () => googleSheetsBatchRanges(["To Apply", "To Apply"]),
    /duplicate title/
  );
});
