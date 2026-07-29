import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  classifyLegacyMessageQuarantine,
  classifyOrphanedProcessingClaim,
  classifyVersionCell,
  collectDeclaredVersionFields,
  LEGACY_MESSAGE_QUARANTINE_IDS
} from "../src/sheet-migrations.mjs";

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const script = await readFile(
  new URL("../google-apps-script/SheetSetup.gs", import.meta.url),
  "utf8"
);
const schema = await loadJson("../config/pipeline-schema.json");
const review = await loadJson("../config/review-sheet.json");
const analytics = await loadJson("../config/analytics-policy.json");
const recommendations = await loadJson(
  "../config/recommendation-policy.json"
);

const embeddedConfigMatch = script.match(
  /const JOB_PIPELINE_SETUP = (\{[\s\S]*?\n\});\n\nconst LEGACY_MESSAGE_QUARANTINE_IDS/
);
assert.ok(embeddedConfigMatch, "generated Sheet setup configuration is missing");
const embedded = JSON.parse(embeddedConfigMatch[1]);

test("Sheet setup artifact is syntactically valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(script));
});

test("generated version classifier runs without module-only dependencies", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}\nglobalThis.classifyVersionCellForTest = classifyVersionCell;`
  ).runInContext(context);
  const result = context.classifyVersionCellForTest({
    field: "profile_version",
    value: 46231,
    displayValue: "2026-07-28",
    identity: "onlinejobs.ph:103"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "repair",
    value: "2026-07-28",
    raw_type: "number"
  });
});

test("generated migration formats before repair and is idempotent on raw values", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.repairAndFormatVersionColumnsForTest =
  repairAndFormatVersionColumns_;`
  ).runInContext(context);
  const headers = ["canonical_job_id", "profile_version", "posted_at"];
  const rawRows = [
    ["onlinejobs.ph:104", 46231, new Date("2026-07-27T00:00:00.000Z")]
  ];
  const displayRows = [
    ["onlinejobs.ph:104", "2026-07-28", "2026-07-27"]
  ];
  const operations = [];
  const sheet = {
    getName: () => "Sheet1",
    getLastColumn: () => headers.length,
    getLastRow: () => rawRows.length + 1,
    getMaxRows: () => 10,
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          if (row === 1) return [headers.slice(column - 1, column - 1 + columnCount)];
          return rawRows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getDisplayValues() {
          if (row === 1) return [headers.slice(column - 1, column - 1 + columnCount)];
          return displayRows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        setNumberFormat(format) {
          operations.push({ action: "format", column, format });
          return this;
        },
        setValue(value) {
          operations.push({ action: "write", row, column, value });
          rawRows[row - 2][column - 1] = value;
          displayRows[row - 2][column - 1] = String(value);
          return this;
        }
      };
    }
  };

  const first = context.repairAndFormatVersionColumnsForTest(sheet);
  assert.deepEqual(JSON.parse(JSON.stringify(first.repaired)), [
    {
      row_number: 2,
      field: "profile_version",
      identity: "onlinejobs.ph:104",
      raw_type: "number",
      value: "2026-07-28"
    }
  ]);
  assert.equal(typeof rawRows[0][1], "string");
  assert.equal(rawRows[0][1], "2026-07-28");
  assert.deepEqual(operations.slice(0, 2), [
    { action: "format", column: 2, format: "@" },
    {
      action: "write",
      row: 2,
      column: 2,
      value: "2026-07-28"
    }
  ]);
  assert.ok(
    operations.every(
      (operation) =>
        operation.action !== "format" || operation.column !== 3
    )
  );

  operations.length = 0;
  const second = context.repairAndFormatVersionColumnsForTest(sheet);
  assert.deepEqual(JSON.parse(JSON.stringify(second.repaired)), []);
  assert.deepEqual(operations, [
    { action: "format", column: 2, format: "@" }
  ]);
});

test("orphan claim classification is identity-bound and preserves live work", () => {
  const reported = {
    canonical_job_id: "onlinejobs.ph:1663047",
    pipeline_status: "not_recommended",
    processing_stage: "",
    processing_token: "3634:onlinejobs.ph:1663047:evaluation",
    processing_started_at: ""
  };
  const options = {
    nowMs: Date.parse("2026-07-28T12:00:00.000Z"),
    leaseMs: 600_000
  };
  assert.deepEqual(
    classifyOrphanedProcessingClaim({ record: reported, ...options }),
    { status: "clear", reason: "confirmed_orphan" }
  );
  assert.deepEqual(
    classifyOrphanedProcessingClaim({
      record: {
        ...reported,
        processing_stage: "evaluation",
        processing_started_at: "2026-07-28T11:55:00.000Z"
      },
      ...options
    }),
    { status: "preserved_active", reason: "unexpired_claim" }
  );
  assert.deepEqual(
    classifyOrphanedProcessingClaim({
      record: { ...reported, processing_token: "newer-token" },
      ...options
    }),
    { status: "conflicting", reason: "target_state_changed" }
  );
  assert.deepEqual(
    classifyOrphanedProcessingClaim({
      record: { ...reported, canonical_job_id: "onlinejobs.ph:unconfirmed" },
      ...options
    }),
    { status: "skipped", reason: "unconfirmed_identity" }
  );
  assert.deepEqual(
    classifyOrphanedProcessingClaim({
      record: { ...reported, processing_token: "" },
      ...options
    }),
    { status: "skipped", reason: "no_token" }
  );
});

test("generated orphan cleanup rechecks identity, reports every class, and is idempotent", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.repairOrphanedProcessingClaimsForTest =
  repairOrphanedProcessingClaims_;`
  ).runInContext(context);
  const headers = [
    "canonical_job_id",
    "pipeline_status",
    "processing_stage",
    "processing_token",
    "processing_started_at"
  ];
  const rows = [
    [
      "onlinejobs.ph:1663047",
      "not_recommended",
      "",
      "3634:onlinejobs.ph:1663047:evaluation",
      ""
    ],
    [
      "onlinejobs.ph:active",
      "evaluating",
      "evaluation",
      "active-token",
      "2999-01-01T00:00:00.000Z"
    ],
    [
      "onlinejobs.ph:unconfirmed",
      "not_recommended",
      "",
      "old-token",
      ""
    ],
    [
      "onlinejobs.ph:1696973",
      "not_recommended",
      "",
      "newer-token",
      ""
    ],
    ["onlinejobs.ph:blank", "review_required", "", "", ""]
  ];
  const sheet = {
    getName: () => "Sheet1",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        setValue(value) {
          rows[row - 2][column - 1] = value;
          return this;
        }
      };
    }
  };

  const first = JSON.parse(
    JSON.stringify(context.repairOrphanedProcessingClaimsForTest(sheet))
  );
  assert.deepEqual(first.counts, {
    cleared: 1,
    preserved_active: 1,
    skipped: 2,
    conflicting: 1
  });
  assert.equal(rows[0][3], "");
  assert.equal(rows[1][3], "active-token");
  assert.equal(rows[3][3], "newer-token");

  const second = JSON.parse(
    JSON.stringify(context.repairOrphanedProcessingClaimsForTest(sheet))
  );
  assert.deepEqual(second.counts, {
    cleared: 0,
    preserved_active: 1,
    skipped: 3,
    conflicting: 1
  });
});

test("legacy message quarantine classification is identity/evidence-bound", () => {
  const reported = {
    canonical_job_id: "onlinejobs.ph:1696828",
    pipeline_status: "ready",
    application_decision: "",
    generated_message:
      "Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
    message_profile_version: "legacy/unknown"
  };
  assert.deepEqual(
    classifyLegacyMessageQuarantine(
      reported,
      embedded.currentMessageVersions
    ),
    {
      status: "quarantine",
      reason: "confirmed_unsafe_legacy_message"
    }
  );
  assert.deepEqual(
    classifyLegacyMessageQuarantine(
      { ...reported, canonical_job_id: "onlinejobs.ph:unconfirmed" },
      embedded.currentMessageVersions
    ),
    { status: "skipped", reason: "unconfirmed_identity" }
  );
  assert.deepEqual(
    classifyLegacyMessageQuarantine(
      {
        ...reported,
        pipeline_status: "applied",
        application_decision: "applied"
      },
      embedded.currentMessageVersions
    ),
    { status: "conflicting", reason: "protected_record_changed" }
  );
  assert.deepEqual(
    classifyLegacyMessageQuarantine(
      {
        ...reported,
        pipeline_status: "recommended",
        generated_message: "",
        message_validation_status: "quarantined",
        alert_status: "pending",
        alert_suppressed_reason: ""
      },
      embedded.currentMessageVersions
    ),
    { status: "conflicting", reason: "target_state_changed" }
  );
  assert.deepEqual(
    classifyLegacyMessageQuarantine(
      {
        ...reported,
        pipeline_status: "review_required",
        generated_message: "",
        message_validation_status: "quarantined",
        alert_status: "not_eligible",
        alert_suppressed_reason: "message_quarantined",
        error_category: ""
      },
      embedded.currentMessageVersions
    ),
    {
      status: "already_quarantined",
      reason: "unsafe_text_removed"
    }
  );
});

test("generated legacy-message migration removes dispatchable text and is idempotent", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.quarantineLegacyMessagesForTest =
  quarantineLegacyMessages_;`
  ).runInContext(context);
  const headers = schema.fields;
  const rowFrom = (record) =>
    headers.map((field) => record[field] ?? "");
  const rows = [
    rowFrom({
      canonical_job_id: "onlinejobs.ph:1696828",
      pipeline_status: "ready",
      application_decision: "",
      generated_message:
        "Resume: https://johnlesterescarlan.netlify.app/john_lester_escarlan_resume.pdf",
      message_profile_version: "legacy/unknown",
      qualification_score: 88,
      opportunity_score: 77,
      alert_status: "pending",
      alert_idempotency_key: "legacy-alert",
      outcome: "replied",
      outcome_events: "[]"
    }),
    rowFrom({
      canonical_job_id: "onlinejobs.ph:1696881",
      pipeline_status: "ready",
      application_decision: "",
      generated_message:
        "Current approved message with no obsolete link.",
      message_profile_version:
        embedded.currentMessageVersions.profile_version,
      message_policy_version:
        embedded.currentMessageVersions.message_policy_version,
      message_validation_status: "valid",
      application_pack_status: "ready",
      application_pack_version:
        embedded.currentMessageVersions.pack_version,
      application_pack_profile_version:
        embedded.currentMessageVersions.profile_version,
      application_pack_policy_version:
        embedded.currentMessageVersions.pack_policy_version
    }),
    rowFrom({
      canonical_job_id: "onlinejobs.ph:control",
      pipeline_status: "ready",
      generated_message: "Unrelated current control"
    })
  ];
  const sheet = {
    getName: () => "Sheet1",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        setValues(values) {
          for (let offset = 0; offset < values.length; offset += 1) {
            rows[row - 2 + offset] = values[offset].slice();
          }
          return this;
        }
      };
    }
  };

  const first = JSON.parse(
    JSON.stringify(context.quarantineLegacyMessagesForTest(sheet))
  );
  assert.deepEqual(first.counts, {
    quarantined: 1,
    already_quarantined: 0,
    current_safe: 1,
    skipped: 1,
    conflicting: 0
  });
  const migrated = Object.fromEntries(
    headers.map((field, index) => [field, rows[0][index]])
  );
  assert.equal(migrated.pipeline_status, "recommended");
  assert.equal(migrated.generated_message, "");
  assert.equal(migrated.message_validation_status, "quarantined");
  assert.equal(migrated.alert_status, "not_eligible");
  assert.equal(migrated.alert_idempotency_key, "");
  assert.equal(
    migrated.alert_suppressed_reason,
    "message_quarantined"
  );
  assert.equal(migrated.failed_stage, "evaluation");
  assert.equal(migrated.qualification_score, 88);
  assert.equal(migrated.opportunity_score, 77);
  assert.equal(migrated.outcome, "replied");
  assert.match(migrated.state_guard, /^onlinejobs\.ph:1696828\|/);

  const second = JSON.parse(
    JSON.stringify(context.quarantineLegacyMessagesForTest(sheet))
  );
  assert.deepEqual(second.counts, {
    quarantined: 0,
    already_quarantined: 1,
    current_safe: 1,
    skipped: 1,
    conflicting: 0
  });
});

test("generated setup accepts confirmed legacy-message targets after archiving", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.inspectArchivedLegacyMessageTargetsForTest =
  inspectArchivedLegacyMessageTargets_;`
  ).runInContext(context);
  const headers = ["canonical_job_id", "pipeline_status"];
  const rows = [
    ["onlinejobs.ph:1697174", "archived"],
    ["onlinejobs.ph:1697386", "archived"],
    ["onlinejobs.ph:1697526", "archived"],
    ["onlinejobs.ph:control", "archived"]
  ];
  const sheet = {
    getName: () => "Archive",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        }
      };
    }
  };

  const result = JSON.parse(
    JSON.stringify(
      context.inspectArchivedLegacyMessageTargetsForTest(sheet)
    )
  );
  assert.deepEqual(
    result.records.archived.map((record) => record.canonical_job_id),
    [
      "onlinejobs.ph:1697174",
      "onlinejobs.ph:1697386",
      "onlinejobs.ph:1697526"
    ]
  );
  assert.deepEqual(result.records.conflicting, []);
  assert.equal(result.records.missing.length, 5);
});

test("generated setup rejects duplicate or non-archived legacy targets", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.inspectArchivedLegacyMessageTargetsForTest =
  inspectArchivedLegacyMessageTargets_;`
  ).runInContext(context);
  const headers = ["canonical_job_id", "pipeline_status"];
  const rows = [
    ["onlinejobs.ph:1697174", "archived"],
    ["onlinejobs.ph:1697174", "archived"],
    ["onlinejobs.ph:1697386", "ready"]
  ];
  const sheet = {
    getName: () => "Archive",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        }
      };
    }
  };

  const result = JSON.parse(
    JSON.stringify(
      context.inspectArchivedLegacyMessageTargetsForTest(sheet)
    )
  );
  assert.deepEqual(
    result.records.conflicting.map((record) => record.reason),
    ["duplicate_archive_records", "unexpected_archive_status"]
  );
});

test("generated setup clears only legacy zero Apply Points sentinels", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.repairLegacyApplyPointsInputsForTest =
  repairLegacyApplyPointsInputs_;`
  ).runInContext(context);
  const headers = ["canonical_job_id", "apply_points_input"];
  const rows = [
    ["onlinejobs.ph:1", 0],
    ["onlinejobs.ph:2", "0"],
    ["onlinejobs.ph:3", ""],
    ["onlinejobs.ph:4", 5]
  ];
  const sheet = {
    getName: () => "Sheet1",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValue() {
          return rows[row - 2][column - 1];
        },
        setValue(value) {
          rows[row - 2][column - 1] = value;
          return this;
        }
      };
    }
  };

  const first = JSON.parse(
    JSON.stringify(
      context.repairLegacyApplyPointsInputsForTest(sheet)
    )
  );
  assert.deepEqual(first.counts, {
    cleared: 2,
    blank: 1,
    valid: 1,
    conflicting: 0
  });
  assert.deepEqual(
    rows.map((row) => row[1]),
    ["", "", "", 5]
  );

  const second = JSON.parse(
    JSON.stringify(
      context.repairLegacyApplyPointsInputsForTest(sheet)
    )
  );
  assert.deepEqual(second.counts, {
    cleared: 0,
    blank: 3,
    valid: 1,
    conflicting: 0
  });
});

test("generated setup leaves legacy Apply Points untouched on conflict", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.repairLegacyApplyPointsInputsForTest =
  repairLegacyApplyPointsInputs_;`
  ).runInContext(context);
  const headers = ["canonical_job_id", "apply_points_input"];
  const rows = [
    ["onlinejobs.ph:1", 0],
    ["onlinejobs.ph:2", 99]
  ];
  const sheet = {
    getName: () => "Sheet1",
    getLastColumn: () => headers.length,
    getLastRow: () => rows.length + 1,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getDisplayValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValues() {
          if (row === 1) {
            return [
              headers.slice(column - 1, column - 1 + columnCount)
            ];
          }
          return rows
            .slice(row - 2, row - 2 + rowCount)
            .map((values) =>
              values.slice(column - 1, column - 1 + columnCount)
            );
        },
        getValue() {
          return rows[row - 2][column - 1];
        },
        setValue(value) {
          rows[row - 2][column - 1] = value;
          return this;
        }
      };
    }
  };

  const result = JSON.parse(
    JSON.stringify(
      context.repairLegacyApplyPointsInputsForTest(sheet)
    )
  );
  assert.equal(result.counts.cleared, 0);
  assert.equal(result.counts.conflicting, 1);
  assert.deepEqual(
    rows.map((row) => row[1]),
    [0, 99]
  );
});

test("Sheet setup artifact embeds the canonical schema and review controls", () => {
  assert.equal(LEGACY_MESSAGE_QUARANTINE_IDS.length, 8);
  assert.deepEqual(embedded.recordFields, schema.fields);
  assert.deepEqual(embedded.reviewColumns, review.review_columns);
  assert.deepEqual(embedded.reviewQueue, review.review_queue);
  assert.deepEqual(embedded.manualActions, schema.manual_actions);
  assert.deepEqual(embedded.editableColumns, [
    "apply_points_input",
    "application_message_strategy_input",
    "manual_action",
    "notes"
  ]);
  assert.equal(embedded.reviewInputRules.applyPoints.minimum, 1);
  assert.equal(embedded.reviewInputRules.applyPoints.maximum, 60);
  assert.deepEqual(embedded.hiddenColumns, [
    "state_guard",
    "processing_commit_guard",
    "processing_token"
  ]);
  assert.equal(embedded.maximumClaimLeaseMs, 600_000);
  assert.deepEqual(embedded.currentMessageVersions, {
    profile_version: "2026-07-29",
    message_policy_version: "2026-07-28",
    pack_version: "2026-07-28/v1",
    pack_policy_version: "2026-07-28/v1"
  });
  assert.equal(embedded.activeSheet, "Sheet1");
  assert.equal(embedded.archiveSheet, "Archive");
  assert.equal(embedded.claimsSheet, "ProcessingClaims");
  assert.equal(embedded.dashboardSheet, "Dashboard");
  assert.equal(embedded.analyticsSheet, analytics.detail_sheet);
  assert.equal(embedded.analyticsReportsSheet, analytics.reports_sheet);
  assert.deepEqual(embedded.analyticsFields, analytics.detail_fields);
  assert.deepEqual(embedded.analyticsReportFields, analytics.report_fields);
  assert.equal(
    embedded.recommendationsSheet,
    recommendations.recommendations_sheet
  );
  assert.equal(
    embedded.recommendationReportsSheet,
    recommendations.reports_sheet
  );
  assert.deepEqual(
    embedded.recommendationFields,
    recommendations.recommendation_fields
  );
  assert.deepEqual(
    embedded.recommendationReportFields,
    recommendations.report_fields
  );
  assert.deepEqual(
    embedded.versionFields,
    collectDeclaredVersionFields(
      schema.fields,
      analytics.detail_fields,
      analytics.report_fields,
      recommendations.recommendation_fields,
      recommendations.report_fields
    )
  );
});

test("Review Queue creation is additive, ordered, idempotent, and fail-closed", () => {
  const context = vm.createContext({});
  new vm.Script(
    `${script}
globalThis.ensureReviewQueueSheetForTest = ensureReviewQueueSheet_;`
  ).runInContext(context);

  const createSheet = (initialHeaders = []) => {
    const headers = [...initialHeaders];
    const operations = [];
    const sheet = {
      getLastColumn: () => headers.length,
      getMaxRows: () => 100,
      getRange(row, column, rowCount, columnCount) {
        return {
          column,
          getDisplayValues: () => [
            Array.from(
              { length: columnCount },
              (_, offset) => headers[column - 1 + offset] || ""
            )
          ],
          setValues(values) {
            operations.push({ action: "write", values: values[0] });
            values[0].forEach((value, offset) => {
              headers[column - 1 + offset] = value;
            });
            return this;
          }
        };
      },
      moveColumns(range, destination) {
        operations.push({
          action: "move",
          from: range.column,
          destination
        });
        const [header] = headers.splice(range.column - 1, 1);
        headers.splice(destination - 1, 0, header);
      },
      setFrozenRows(rows) {
        operations.push({ action: "freeze", rows });
      }
    };
    return { sheet, headers, operations };
  };

  const created = createSheet();
  const spreadsheet = {
    getSheetByName: () => created.sheet,
    insertSheet: () => created.sheet
  };
  context.ensureReviewQueueSheetForTest(
    spreadsheet,
    review.review_queue.sheet,
    review.review_queue.fields
  );
  assert.deepEqual(created.headers, review.review_queue.fields);
  const firstOperationCount = created.operations.length;
  context.ensureReviewQueueSheetForTest(
    spreadsheet,
    review.review_queue.sheet,
    review.review_queue.fields
  );
  assert.deepEqual(created.headers, review.review_queue.fields);
  assert.equal(
    created.operations
      .slice(firstOperationCount)
      .filter((operation) => operation.action === "move").length,
    0
  );

  const unsupported = createSheet(["Status", "Unexpected operator column"]);
  assert.throws(
    () =>
      context.ensureReviewQueueSheetForTest(
        {
          getSheetByName: () => unsupported.sheet,
          insertSheet: () => unsupported.sheet
        },
        review.review_queue.sheet,
        review.review_queue.fields
      ),
    /unsupported headers and requires manual reconciliation/
  );
  assert.deepEqual(unsupported.headers, [
    "Status",
    "Unexpected operator column"
  ]);

  const duplicate = createSheet(["Status", "Status"]);
  assert.throws(
    () =>
      context.ensureReviewQueueSheetForTest(
        {
          getSheetByName: () => duplicate.sheet,
          insertSheet: () => duplicate.sheet
        },
        review.review_queue.sheet,
        review.review_queue.fields
      ),
    /duplicate headers and requires manual reconciliation/
  );
  assert.deepEqual(duplicate.headers, ["Status", "Status"]);
});

test("version fields are contract-derived, text-formatted before migration, and exclude timestamps", () => {
  const expected = collectDeclaredVersionFields(
    schema.fields,
    analytics.detail_fields,
    analytics.report_fields,
    recommendations.recommendation_fields,
    recommendations.report_fields
  );
  assert.ok(expected.includes("profile_version"));
  assert.ok(expected.includes("application_pack_policy_version"));
  assert.ok(expected.includes("metric_definition_version"));
  assert.ok(expected.includes("recommendation_policy_version"));
  assert.deepEqual(
    expected.filter((field) => schema.timestamp_fields.includes(field)),
    []
  );
  assert.match(script, /repairAndFormatVersionColumns_\(active\)/);
  assert.match(script, /\.setNumberFormat\('@'\)/);
  assert.ok(
    script.indexOf("repairAndFormatVersionColumns_(active)") <
      script.indexOf("migrateLegacyIdentityAndState_(active)")
  );
});

test("version repair is exact, identity-guarded, idempotent, and fail-closed", () => {
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: 46231,
      displayValue: "2026-07-28",
      identity: "onlinejobs.ph:101"
    }),
    {
      status: "repair",
      value: "2026-07-28",
      raw_type: "number"
    }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: new Date("2026-07-28T00:00:00.000Z"),
      displayValue: "2026-07-28",
      identity: "onlinejobs.ph:102"
    }),
    {
      status: "repair",
      value: "2026-07-28",
      raw_type: "date"
    }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: "2026-07-28",
      displayValue: "2026-07-28",
      identity: "onlinejobs.ph:101"
    }),
    { status: "unchanged" }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: "",
      displayValue: "",
      identity: "onlinejobs.ph:101"
    }),
    { status: "unchanged" }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: 46231,
      displayValue: "2026-07-28",
      identity: ""
    }),
    { status: "unmapped", raw_type: "number" }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "message_policy_version",
      value: 46231,
      displayValue: "2026-07-28",
      identity: "onlinejobs.ph:101"
    }),
    { status: "unmapped", raw_type: "number" }
  );
  assert.deepEqual(
    classifyVersionCell({
      field: "profile_version",
      value: 46000,
      displayValue: "2025-12-09",
      identity: "onlinejobs.ph:101"
    }),
    { status: "unmapped", raw_type: "number" }
  );
});

test("Sheet setup is additive, migrates legacy created_at, and preserves reviewer data", () => {
  assert.match(script, /const missing = requiredHeaders\.filter/);
  assert.match(script, /const merged = headers\.concat\(missing\)/);
  assert.doesNotMatch(script, /\.clear\(|deleteSheet|deleteColumns|deleteRows/);
  assert.match(script, /headers\.indexOf\('created_at '\)/);
  assert.match(script, /row\[0\] \|\| legacy\[index\]\[0\]/);
  assert.match(script, /migrateLegacyIdentityAndState_\(active\)/);
  assert.match(script, /JOB_PIPELINE_SETUP\.analyticsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.analyticsReportsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.recommendationsSheet/);
  assert.match(script, /JOB_PIPELINE_SETUP\.recommendationReportsSheet/);
  assert.match(script, /stateGuard_\(\s*canonicalJobId/);
  assert.match(script, /canonicalUrl\.match\(\/\\\/jobseekers\\\/job\\\//);
  assert.match(script, /\.replace\(\/\^http:\\\/\\\//);
  assert.match(script, /profileVersion = String\(current\.profile_version/);
  assert.match(script, /firstReviewedAt = String\(current\.first_reviewed_at/);
  assert.match(script, /applicationMessageStrategy/);
  assert.match(script, /outcomeEvents/);
  assert.match(script, /sheet\.getName\(\) === JOB_PIPELINE_SETUP\.archiveSheet/);
  assert.match(script, /orderReviewColumns_\(active\)/);
  assert.match(script, /sheet\.moveColumns/);
  assert.match(script, /duplicateCanonicalIds_\(active\)/);
  assert.match(script, /Canonical identity collisions require manual reconciliation/);
});

test("Sheet setup protects generated fields and validates explicit manual actions", () => {
  assert.match(script, /requireValueInList\(JOB_PIPELINE_SETUP\.manualActions, true\)/);
  assert.match(script, /headers\.indexOf\('apply_points_input'\)/);
  assert.match(script, /ISNUMBER/);
  assert.match(script, /INT\(/);
  assert.match(script, /application_message_strategy_input/);
  assert.match(script, /REGEXMATCH/);
  assert.match(script, /\.setAllowInvalid\(false\)/);
  assert.match(script, /JOB_PIPELINE_SETUP\.editableColumns\.includes\(header\)/);
  assert.match(script, /\.setWarningOnly\(true\)/);
  assert.match(script, /retryable_error/);
  assert.match(script, /terminal_error/);
  assert.match(script, /sortPriorityQueue/);
  assert.match(script, /index\.opportunity_score/);
  assert.match(script, /statusPriority/);
  assert.match(script, /confidencePriority/);
  assert.match(script, /LockService\.getDocumentLock/);
  assert.match(script, /range\.setValues\(rows\)/);
  assert.match(script, /sheet\.hideColumns\(column\)/);
});

test("Review Queue layout exposes only the friendly contract and protects derived fields", () => {
  assert.match(
    script,
    /ensureReviewQueueSheet_\(\s*spreadsheet,\s*JOB_PIPELINE_SETUP\.reviewQueue\.sheet/
  );
  assert.match(script, /applyReviewQueueLayout_\(reviewQueue\)/);
  assert.match(
    script,
    /applyReviewQueueActionValidation_\(sheet\)/
  );
  assert.match(script, /Generate Application, I Applied, or Skip/);
  assert.match(
    script,
    /\['', 'Generate Application', 'Skip'\]/
  );
  assert.match(
    script,
    /I Applied is unavailable until a validated message is ready/
  );
  assert.match(script, /function onSelectionChange\(event\)/);
  assert.match(script, /queue\.generation_recovery\.statuses/);
  assert.match(script, /setDataValidations\(validations\)/);
  assert.match(script, /"retryable_error"/);
  assert.match(script, /"terminal_error"/);
  assert.match(script, /queue\.visible_columns\.forEach/);
  assert.match(script, /sheet\.showColumns\(column\)/);
  assert.match(script, /queue\.hidden_columns\.forEach/);
  assert.match(script, /sheet\.hideColumns\(column\)/);
  assert.match(script, /if \(header === 'Action'\) return/);
  assert.match(
    script,
    /Job Pipeline Review Queue generated field:/
  );
  assert.match(script, /protection\.setWarningOnly\(true\)/);
});

test("Sheet setup preserves unrelated conditional formatting rules", () => {
  assert.match(script, /const unrelatedRules = sheet\.getConditionalFormatRules/);
  assert.match(script, /unrelatedRules\.concat\(rules\)/);
});
