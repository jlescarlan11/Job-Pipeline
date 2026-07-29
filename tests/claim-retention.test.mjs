import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  planProcessingClaimRetention,
  validateClaimRetentionPolicy
} from "../src/claim-retention.mjs";
import { chooseWinningClaims } from "../src/contracts.mjs";

const policy = JSON.parse(
  await readFile(
    new URL("../config/claim-retention.json", import.meta.url),
    "utf8"
  )
);

function claim(rowNumber, overrides = {}) {
  return {
    canonical_job_id: `onlinejobs.ph:${rowNumber}`,
    processing_stage: "generation",
    processing_token: `run:${rowNumber}:generation`,
    created_at: "2026-04-01T00:00:00.000Z",
    expires_at: "2026-04-01T00:10:00.000Z",
    row_number: rowNumber,
    ...overrides
  };
}

test("claim retention policy is valid and rejects unsafe bounds", () => {
  assert.deepEqual(validateClaimRetentionPolicy(policy), []);

  const unsafe = {
    ...policy,
    retention_days: 0,
    maximum_rows_per_cleanup: 5001,
    allowed_processing_stages: ["generation", "generation"]
  };
  assert.match(
    validateClaimRetentionPolicy(unsafe).join("\n"),
    /retention_days/
  );
  assert.match(
    validateClaimRetentionPolicy(unsafe).join("\n"),
    /maximum_rows_per_cleanup/
  );
  assert.match(
    validateClaimRetentionPolicy(unsafe).join("\n"),
    /must not contain duplicates/
  );
});

test("planner deletes only uniquely addressed claims older than retention", () => {
  const testPolicy = {
    ...policy,
    minimum_rows_before_cleanup: 1,
    maximum_rows_per_cleanup: 4
  };
  const rows = [
    claim(2),
    claim(3, {
      created_at: "2026-04-02T00:00:00.000Z",
      expires_at: "2026-04-02T00:10:00.000Z"
    }),
    claim(4, {
      created_at: "2026-07-29T00:00:00.000Z",
      expires_at: "2026-07-29T00:10:00.000Z"
    }),
    claim(5, {
      created_at: "2026-04-03T00:00:00.000Z",
      expires_at: "2026-04-03T00:10:00.000Z"
    }),
    claim(6, {
      created_at: "2026-04-04T00:00:00.000Z",
      expires_at: "2026-04-04T00:10:00.000Z"
    }),
    claim(7, { expires_at: "not-a-timestamp" }),
    claim(10, { expires_at: "0" }),
    claim(11, {
      created_at: "2026-04-02T00:00:00.000Z",
      expires_at: "2026-04-01T00:10:00.000Z"
    }),
    claim(12, { processing_token: "" }),
    claim(8, { processing_stage: "future_stage" }),
    claim(9),
    claim(9, { processing_token: "duplicate-row-locator" }),
    {}
  ];

  const plan = planProcessingClaimRetention(
    rows,
    testPolicy,
    "2026-07-30T00:00:00.000Z"
  );

  assert.deepEqual(plan.selected_row_numbers, [2, 3, 5, 6]);
  assert.deepEqual(plan.delete_ranges, [
    {
      start_row_number: 5,
      end_row_number: 6,
      start_index: 4,
      end_index: 6
    },
    {
      start_row_number: 2,
      end_row_number: 3,
      start_index: 1,
      end_index: 3
    }
  ]);
  assert.equal(plan.counts.rows_seen, 12);
  assert.equal(plan.counts.preserved_active_or_recent, 1);
  assert.equal(plan.counts.preserved_malformed, 4);
  assert.equal(plan.counts.preserved_unknown_stage, 1);
  assert.equal(plan.counts.preserved_ambiguous_row_number, 2);
  assert.equal(plan.counts.eligible, 4);
});

test("planner remains a no-op below the threshold or when disabled", () => {
  const belowThreshold = planProcessingClaimRetention(
    [claim(2)],
    { ...policy, minimum_rows_before_cleanup: 2 },
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(belowThreshold.threshold_reached, false);
  assert.deepEqual(belowThreshold.delete_ranges, []);
  assert.equal(belowThreshold.counts.deferred, 1);

  const disabled = planProcessingClaimRetention(
    [claim(2), claim(3)],
    { ...policy, enabled: false, minimum_rows_before_cleanup: 1 },
    "2026-07-30T00:00:00.000Z"
  );
  assert.equal(disabled.threshold_reached, true);
  assert.deepEqual(disabled.selected_row_numbers, []);
  assert.equal(disabled.counts.deferred, 2);
});

test("removing expired rows cannot change the active arbitration winner", () => {
  const now = "2026-07-30T00:00:00.000Z";
  const expired = [claim(2), claim(3)];
  const active = [
    claim(4, {
      canonical_job_id: "onlinejobs.ph:active",
      processing_token: "earliest-active",
      created_at: "2026-07-29T23:59:00.000Z",
      expires_at: "2026-07-30T00:09:00.000Z"
    }),
    claim(5, {
      canonical_job_id: "onlinejobs.ph:active",
      processing_token: "later-active",
      created_at: "2026-07-29T23:59:30.000Z",
      expires_at: "2026-07-30T00:09:30.000Z"
    })
  ];
  const proposed = [
    {
      canonical_job_id: "onlinejobs.ph:active",
      work_stage: "generation",
      processing_token: "earliest-active"
    }
  ];
  const before = chooseWinningClaims(proposed, [...expired, ...active], now);
  const plan = planProcessingClaimRetention(
    [...expired, ...active],
    { ...policy, minimum_rows_before_cleanup: 1 },
    now
  );
  const selected = new Set(plan.selected_row_numbers);
  const afterRows = active
    .filter((row) => !selected.has(row.row_number))
    .map((row) => ({ ...row, row_number: row.row_number - selected.size }));
  const after = chooseWinningClaims(proposed, afterRows, now);

  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(before[0].processing_token, after[0].processing_token);
});
