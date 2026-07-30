import assert from "node:assert/strict";
import test from "node:test";
import {
  createSystemClaim,
  expiredSystemClaimRows,
  selectWinningSystemClaims
} from "../src/system-claims.mjs";

const now = "2026-07-31T10:00:00.000Z";

test("append-winner claims serialize overlapping movement and alert work", () => {
  const first = createSystemClaim({
    stage: "movement",
    canonicalJobId: "onlinejobs.ph:7001",
    scope: "Applied Jobs",
    executionId: "run-1",
    now,
    leaseMs: 180000
  });
  const second = createSystemClaim({
    stage: "movement",
    canonicalJobId: "onlinejobs.ph:7001",
    scope: "Applied Jobs",
    executionId: "run-2",
    now,
    leaseMs: 180000
  });
  const winners = selectWinningSystemClaims(
    [first, second],
    [
      { ...second, row_number: 9 },
      { ...first, row_number: 8 }
    ],
    now
  );
  assert.deepEqual(winners.map((claim) => claim.token), [first.token]);
});

test("expired claims cannot win and are pruned in descending row order", () => {
  const active = createSystemClaim({
    stage: "alert",
    canonicalJobId: "onlinejobs.ph:7002",
    scope: "message-v1",
    executionId: "run-3",
    now,
    leaseMs: 180000
  });
  const expired = {
    ...active,
    token: "old-token",
    expires_at: "2026-07-31T09:59:00.000Z"
  };
  assert.deepEqual(
    selectWinningSystemClaims(
      [active],
      [
        { ...expired, row_number: 2 },
        { ...active, row_number: 3 }
      ],
      now
    ),
    [active]
  );
  assert.deepEqual(
    expiredSystemClaimRows(
      [
        { ...expired, row_number: 4 },
        { ...expired, row_number: 7 },
        { ...active, row_number: 8 }
      ],
      now
    ),
    [{ row_number: 7 }, { row_number: 4 }]
  );
});
