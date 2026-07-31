import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  fs.readFileSync(path.join(root, "config/pipeline-schema.json"), "utf8")
);
const review = JSON.parse(
  fs.readFileSync(path.join(root, "config/review-sheet.json"), "utf8")
);

const mode = process.argv[2];
const input = JSON.parse(process.argv[3] || "{}");
const sheetIds = input.sheet_ids || {};
const rowCounts = input.row_counts || {};
const maximumRows = 2000;

function color(red, green, blue) {
  return { red: red / 255, green: green / 255, blue: blue / 255 };
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function rangesForHiddenColumns(headers, visibleColumns) {
  const visible = new Set(visibleColumns);
  const ranges = [];
  let start = null;
  for (let index = 0; index <= headers.length; index += 1) {
    const hidden = index < headers.length && !visible.has(headers[index]);
    if (hidden && start === null) start = index;
    if (!hidden && start !== null) {
      ranges.push([start, index]);
      start = null;
    }
  }
  return ranges;
}

function rangesForTextColumns(headers) {
  const numeric = new Set(
    Object.entries(schema.field_rules)
      .filter(([, rule]) => ["integer", "number"].includes(rule.type))
      .map(([field]) => field)
  );
  const ranges = [];
  let start = null;
  for (let index = 0; index <= headers.length; index += 1) {
    const text = index < headers.length && !numeric.has(headers[index]);
    if (text && start === null) start = index;
    if (!text && start !== null) {
      ranges.push([start, index]);
      start = null;
    }
  }
  return ranges;
}

function recordSheetStructureRequests(sheetName, visibleColumns) {
  const sheetId = sheetIds[sheetName];
  if (!Number.isInteger(sheetId)) {
    throw new Error(`Missing sheet id for ${sheetName}`);
  }
  const requests = [];
  const currentRows = Number(rowCounts[sheetName] || 0);
  if (currentRows < maximumRows) {
    requests.push({
      appendDimension: {
        sheetId,
        dimension: "ROWS",
        length: maximumRows - currentRows
      }
    });
  }
  requests.push(
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          hidden: false,
          gridProperties: { frozenRowCount: 1 }
        },
        fields: "hidden,gridProperties.frozenRowCount"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: maximumRows,
          startColumnIndex: 0,
          endColumnIndex: schema.fields.length
        },
        cell: {
          userEnteredFormat: {
            verticalAlignment: "TOP"
          }
        },
        fields: "userEnteredFormat.verticalAlignment"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: schema.fields.length
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: {
              rgbColor: color(217, 234, 211)
            },
            textFormat: { bold: true }
          }
        },
        fields:
          "userEnteredFormat(backgroundColorStyle,textFormat.bold)"
      }
    },
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: maximumRows,
            startColumnIndex: 0,
            endColumnIndex: schema.fields.length
          }
        }
      }
    }
  );

  for (const [startIndex, endIndex] of rangesForTextColumns(schema.fields)) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: maximumRows,
          startColumnIndex: startIndex,
          endColumnIndex: endIndex
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "TEXT" }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    });
  }

  for (const [startIndex, endIndex] of rangesForHiddenColumns(
    schema.fields,
    visibleColumns
  )) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex,
          endIndex
        },
        properties: { hiddenByUser: true },
        fields: "hiddenByUser"
      }
    });
  }

  for (const field of visibleColumns) {
    const index = schema.fields.indexOf(field);
    const wideText = [
      "generated_message",
      "decision_reason",
      "required_input",
      "notes"
    ].includes(field);
    const pixelSize = wideText
      ? 360
      : ["canonical_url", "job_title"].includes(field)
        ? 240
        : 140;
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: index,
          endIndex: index + 1
        },
        properties: {
          hiddenByUser: false,
          pixelSize
        },
        fields: "hiddenByUser,pixelSize"
      }
    });
    if (wideText) {
      requests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: maximumRows,
            startColumnIndex: index,
            endColumnIndex: index + 1
          },
          cell: {
            userEnteredFormat: { wrapStrategy: "WRAP" }
          },
          fields: "userEnteredFormat.wrapStrategy"
        }
      });
    }
  }
  return requests;
}

function structureRequests() {
  const requests = [
    {
      updateSpreadsheetProperties: {
        properties: { timeZone: review.timezone },
        fields: "timeZone"
      }
    }
  ];
  for (const key of ["review_queue", "applied_jobs", "archive"]) {
    const definition = review.sheets[key];
    requests.push(
      ...recordSheetStructureRequests(
        definition.name,
        definition.visible_columns
      )
    );
  }

  const systemName = review.sheets.system.name;
  const systemId = sheetIds[systemName];
  const currentRows = Number(rowCounts[systemName] || 0);
  if (currentRows < maximumRows) {
    requests.push({
      appendDimension: {
        sheetId: systemId,
        dimension: "ROWS",
        length: maximumRows - currentRows
      }
    });
  }
  requests.push(
    {
      updateSheetProperties: {
        properties: {
          sheetId: systemId,
          hidden: true,
          gridProperties: { frozenRowCount: 1 }
        },
        fields: "hidden,gridProperties.frozenRowCount"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId: systemId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: review.sheets.system.fields.length
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: {
              rgbColor: color(238, 238, 238)
            },
            textFormat: { bold: true }
          }
        },
        fields:
          "userEnteredFormat(backgroundColorStyle,textFormat.bold)"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId: systemId,
          startRowIndex: 1,
          endRowIndex: maximumRows,
          startColumnIndex: 0,
          endColumnIndex: review.sheets.system.fields.length
        },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: "TEXT" }
          }
        },
        fields: "userEnteredFormat.numberFormat"
      }
    }
  );

  const reviewSheetId = sheetIds[review.sheets.review_queue.name];
  const statusIndex = schema.fields.indexOf("pipeline_status");
  const actionIndex = schema.fields.indexOf("user_action");
  const statusCell = `${columnLetter(statusIndex)}2`;
  const actionCell = `${columnLetter(actionIndex)}2`;
  requests.push({
    setDataValidation: {
      range: {
        sheetId: reviewSheetId,
        startRowIndex: 1,
        endRowIndex: maximumRows,
        startColumnIndex: actionIndex,
        endColumnIndex: actionIndex + 1
      },
      rule: {
        condition: {
          type: "CUSTOM_FORMULA",
          values: [
            {
              userEnteredValue:
                `=OR(${actionCell}="",` +
                `AND(${statusCell}="ready_to_apply",OR(${actionCell}="I Applied",${actionCell}="Skip")),` +
                `AND(${statusCell}="review_needed",OR(${actionCell}="Approve",${actionCell}="Deny")))`
            }
          ]
        },
        inputMessage:
          "ready_to_apply: I Applied or Skip; review_needed: Approve or Deny",
        strict: true,
        showCustomUi: false
      }
    }
  });

  const appliedSheetId = sheetIds[review.sheets.applied_jobs.name];
  const outcomeIndex = schema.fields.indexOf("outcome");
  requests.push({
    setDataValidation: {
      range: {
        sheetId: appliedSheetId,
        startRowIndex: 1,
        endRowIndex: maximumRows,
        startColumnIndex: outcomeIndex,
        endColumnIndex: outcomeIndex + 1
      },
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: review.outcome_validation
            .filter(Boolean)
            .map((value) => ({ userEnteredValue: value }))
        },
        strict: true,
        showCustomUi: true
      }
    }
  });

  return requests;
}

function protectionRequests() {
  const requests = [];
  for (const key of ["review_queue", "applied_jobs", "archive"]) {
    const sheetName = review.sheets[key].name;
    const sheetId = sheetIds[sheetName];
    const editable = new Set(review.editable_columns[sheetName] || []);
    for (const [index, field] of schema.fields.entries()) {
      if (editable.has(field)) continue;
      requests.push({
        addProtectedRange: {
          protectedRange: {
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: maximumRows,
              startColumnIndex: index,
              endColumnIndex: index + 1
            },
            description: `Job Pipeline generated:${sheetName}:${field}`,
            warningOnly: true
          }
        }
      });
    }
  }
  requests.push({
    addProtectedRange: {
      protectedRange: {
        range: { sheetId: sheetIds[review.sheets.system.name] },
        description: "Job Pipeline generated:_System",
        warningOnly: true
      }
    }
  });
  return requests;
}

if (mode === "structure") {
  process.stdout.write(JSON.stringify({ requests: structureRequests() }));
} else if (mode === "protections") {
  process.stdout.write(JSON.stringify({ requests: protectionRequests() }));
} else {
  throw new Error("Expected structure or protections mode");
}
