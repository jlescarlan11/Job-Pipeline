function normalizeClaimKey(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(value || ""));
}

export function createSystemClaim({
  stage,
  canonicalJobId,
  scope = "",
  executionId,
  now,
  leaseMs
}) {
  const normalizedStage = normalizeClaimKey(stage);
  const normalizedId = normalizeClaimKey(canonicalJobId);
  const normalizedScope = normalizeClaimKey(scope);
  const nowMs = Date.parse(now);
  if (
    !normalizedStage ||
    !normalizedId ||
    !String(executionId || "").trim() ||
    !Number.isFinite(nowMs) ||
    !Number.isInteger(leaseMs) ||
    leaseMs < 1
  ) {
    throw new Error(
      "System claim requires stage, identity, execution, timestamp, and lease"
    );
  }
  const claimKey = [normalizedStage, normalizedId, normalizedScope]
    .filter(Boolean)
    .join(":");
  return {
    claim_key: claimKey,
    canonical_job_id: canonicalJobId,
    stage: normalizedStage,
    token: `${executionId}:${claimKey}`,
    created_at: now,
    expires_at: new Date(nowMs + leaseMs).toISOString()
  };
}

export function selectWinningSystemClaims(
  proposedClaims,
  persistedClaims,
  now = new Date().toISOString()
) {
  if (!Array.isArray(proposedClaims) || !Array.isArray(persistedClaims)) {
    throw new Error("System claim collections must be arrays");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("System claim time is invalid");
  const winners = new Map();
  for (const claim of persistedClaims) {
    const key = normalizeClaimKey(claim?.claim_key);
    const rowNumber = Number(claim?.row_number);
    if (
      !key ||
      !String(claim?.token || "").trim() ||
      !Number.isInteger(rowNumber) ||
      rowNumber < 2 ||
      !validTimestamp(claim?.expires_at) ||
      Date.parse(claim.expires_at) <= nowMs
    ) {
      continue;
    }
    const current = winners.get(key);
    if (!current || rowNumber < Number(current.row_number)) {
      winners.set(key, claim);
    }
  }
  return proposedClaims.filter((claim) => {
    const winner = winners.get(normalizeClaimKey(claim?.claim_key));
    return winner?.token === claim?.token;
  });
}

export function expiredSystemClaimRows(
  persistedClaims,
  now = new Date().toISOString()
) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("System claim time is invalid");
  return (Array.isArray(persistedClaims) ? persistedClaims : [])
    .filter((claim) => {
      const rowNumber = Number(claim?.row_number);
      return (
        Number.isInteger(rowNumber) &&
        rowNumber >= 2 &&
        validTimestamp(claim?.expires_at) &&
        Date.parse(claim.expires_at) <= nowMs
      );
    })
    .sort((left, right) => Number(right.row_number) - Number(left.row_number))
    .map((claim) => ({ row_number: Number(claim.row_number) }));
}
