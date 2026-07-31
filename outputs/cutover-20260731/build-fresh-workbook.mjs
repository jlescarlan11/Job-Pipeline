import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.resolve(import.meta.dirname, "../..");
const outputDir = import.meta.dirname;
const schema = JSON.parse(
  await fs.readFile(path.join(root, "config/pipeline-schema.json"), "utf8")
);
const review = JSON.parse(
  await fs.readFile(path.join(root, "config/review-sheet.json"), "utf8")
);

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

const workbook = Workbook.create();
if (process.argv.includes("--help-visibility")) {
  console.log(
    workbook.help("worksheet visibility", {
      include: "index,examples,notes",
      maxChars: 5000
    }).ndjson
  );
  process.exit(0);
}
const businessSheets = [
  review.sheets.review_queue.name,
  review.sheets.applied_jobs.name,
  review.sheets.archive.name
];

for (const sheetName of businessSheets) {
  const sheet = workbook.worksheets.add(sheetName);
  const headers = schema.fields;
  const endColumn = columnName(headers.length - 1);
  const headerRange = sheet.getRange(`A1:${endColumn}1`);
  headerRange.values = [headers];
  headerRange.format = {
    fill: "#F1F3F4",
    font: { bold: true, color: "#202124" },
    verticalAlignment: "center",
    wrapText: false,
    borders: {
      bottom: { style: "thin", color: "#DADCE0" }
    }
  };
  headerRange.format.rowHeight = 28;
  headerRange.format.columnWidth = 18;
  sheet.freezePanes.freezeRows(1);

  const widerColumns = new Map([
    ["canonical_url", 36],
    ["job_title", 30],
    ["company", 24],
    ["job_description", 48],
    ["decision_reason", 36],
    ["required_input", 34],
    ["error_summary", 34],
    ["generated_message", 52],
    ["notes", 30]
  ]);
  for (const [field, width] of widerColumns) {
    const index = headers.indexOf(field);
    if (index >= 0) {
      sheet.getRange(`${columnName(index)}1`).format.columnWidth = width;
    }
  }
}

const actionIndex = schema.fields.indexOf("user_action");
workbook.worksheets
  .getItem(review.sheets.review_queue.name)
  .getRange(`${columnName(actionIndex)}2:${columnName(actionIndex)}1000`)
  .dataValidation = {
    rule: {
      type: "list",
      values: schema.user_actions
    }
  };

const outcomeIndex = schema.fields.indexOf("outcome");
workbook.worksheets
  .getItem(review.sheets.applied_jobs.name)
  .getRange(`${columnName(outcomeIndex)}2:${columnName(outcomeIndex)}1000`)
  .dataValidation = {
    rule: {
      type: "list",
      values: review.outcome_validation
    }
  };

const systemSheet = workbook.worksheets.add(review.sheets.system.name);
const systemHeaders = review.sheets.system.fields;
const systemEndColumn = columnName(systemHeaders.length - 1);
const systemHeaderRange = systemSheet.getRange(`A1:${systemEndColumn}1`);
systemHeaderRange.values = [systemHeaders];
systemHeaderRange.format = {
  fill: "#F1F3F4",
  font: { bold: true, color: "#202124" },
  verticalAlignment: "center",
  borders: {
    bottom: { style: "thin", color: "#DADCE0" }
  }
};
systemHeaderRange.format.rowHeight = 28;
systemHeaderRange.format.columnWidth = 22;
systemSheet.freezePanes.freezeRows(1);

const expectedSheets = [...businessSheets, review.sheets.system.name];
const sheetCheck = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 6000
});
console.log(sheetCheck.ndjson);

for (const sheetName of expectedSheets) {
  const expectedHeaders =
    sheetName === review.sheets.system.name ? systemHeaders : schema.fields;
  const endColumn = columnName(expectedHeaders.length - 1);
  const check = await workbook.inspect({
    kind: "table",
    range: `'${sheetName}'!A1:${endColumn}2`,
    include: "values,formulas",
    tableMaxRows: 2,
    tableMaxCols: expectedHeaders.length,
    maxChars: 30000
  });
  console.log(check.ndjson);
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
  maxChars: 6000
});
console.log(errors.ndjson);

const previewRanges = {
  "Review Queue": "A1:M3",
  "Applied Jobs": "A1:H3",
  Archive: "A1:G3",
  _System: "A1:F3"
};
for (const [sheetName, range] of Object.entries(previewRanges)) {
  const preview = await workbook.render({
    sheetName,
    range,
    scale: 1.25,
    format: "png"
  });
  await fs.writeFile(
    path.join(outputDir, `${sheetName.replaceAll(" ", "-")}.png`),
    new Uint8Array(await preview.arrayBuffer())
  );
}

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(outputDir, "job-pipeline-fresh-workbook.xlsx"));

console.log(
  JSON.stringify({
    workbook: path.join(outputDir, "job-pipeline-fresh-workbook.xlsx"),
    sheets: expectedSheets,
    business_data_rows: Object.fromEntries(
      businessSheets.map((name) => [name, 0])
    ),
    legacy_rows_imported: false
  })
);
