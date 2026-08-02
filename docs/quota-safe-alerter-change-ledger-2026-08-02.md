# Quota-safe Alerter & Mover change ledger

Disposition vocabulary follows the autonomous issue-loop contract. Issue #60 is
anchored at `3954a59`; issue #61 is anchored at `de04bf6`; issue #62 is reviewed
against the integrated working tree before its scoped commit.

## Issue #60

| Change unit | Purpose / boundary inspected | Risk | Disposition |
| --- | --- | --- | --- |
| `README.md` | Expose the batched Alerter contract; primary docs caller checked | Low | REVIEWED_CLEAN |
| `docs/alerts.md` | Document lazy context, no-work, and touched-only phases | Low | REVIEWED_AFTER_FIX |
| `docs/architecture.md` | Record request budgets and phase ownership | Low | REVIEWED_AFTER_FIX |
| `src/sheet-batch.mjs` | Parse exact ordered multi-range Sheet responses and header-only tabs | High data contract | REVIEWED_AFTER_FIX |
| `src/sheet-order.mjs` | Restrict sort requests to movement-touched stores | High row safety | REVIEWED_AFTER_FIX |
| `src/alerter-mover.mjs` | Plan persisted-only phases, counts, gates, and summary | High state selection | REVIEWED_AFTER_FIX |
| `scripts/build-workflows.mjs` | Generate consolidated reads, branch gates, touched confirmation/sort | High workflow topology | REVIEWED_AFTER_FIX |
| `workflows/alerter-mover.json` | Deterministic inactive generated graph; graph/code/bindings inspected | High generated runtime | REVIEWED_AFTER_FIX |
| `tests/sheet-batch.test.mjs` | Header, range, ownership, missing/duplicate regression coverage | Moderate | REVIEWED_CLEAN |
| `tests/sheet-order.test.mjs` | Touched-only sort coverage | Moderate | REVIEWED_CLEAN |
| `tests/simplified-alerter-mover.test.mjs` | Phase/count/idle/movement direct behavior | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-workflows.test.mjs` | Bypass topology and two/six read-budget enforcement | Moderate | REVIEWED_AFTER_FIX |

## Issue #61

| Change unit | Purpose / boundary inspected | Risk | Disposition |
| --- | --- | --- | --- |
| `README.md` | Route operators to receipt policy/validation | Low | REVIEWED_CLEAN |
| `config/alert-receipts.json` | Exact lifecycle, limits, table binding, attempts, retention | Critical delivery evidence | REVIEWED_AFTER_FIX |
| `src/alert-receipts.mjs` | Normalize, validate, transition, redact, and reconcile receipts | Critical idempotency | REVIEWED_AFTER_FIX |
| `src/alert-receipt-store.mjs` | Atomic backend contract, create/CAS/reread/duplicate checks | Critical persistence | REVIEWED_AFTER_FIX |
| `scripts/validate-alert-receipt-store.mjs` | Non-mutating policy and sanitized snapshot verification | High operations | REVIEWED_AFTER_FIX |
| `scripts/build-workflows.mjs` | Validate receipt and alert-policy compatibility at build time | High producer/consumer contract | REVIEWED_AFTER_FIX |
| `package.json` | Expose receipt validation command | Low | REVIEWED_CLEAN |
| `docs/alerts.md` | Explain lifecycle, ambiguity, privacy, and no replay | Moderate | REVIEWED_AFTER_FIX |
| `docs/architecture.md` | Place Data Table inside durability/backup boundary | Moderate | REVIEWED_AFTER_FIX |
| `docs/operations.md` | Provision, validate, back up, restore, and never mutate production via validator | High operations | REVIEWED_AFTER_FIX |
| `tests/alert-receipts.test.mjs` | Valid/invalid lifecycle, concurrency, corruption, restart, moved-owner, redaction | High assurance | REVIEWED_AFTER_FIX |
| `tests/docs.test.mjs` | Preserve receipt durability/privacy/runbook requirements | Low | REVIEWED_CLEAN |

## Issue #62

| Change unit | Purpose / direct boundaries inspected | Risk | Disposition |
| --- | --- | --- | --- |
| `config/runtime.json` | 300 s runtime, 360 s lease, 150 s provider headroom, one 65 s Sheet retry | High runtime capacity | REVIEWED_AFTER_FIX |
| `config/alert-policy.json` | Match schedule/timeout/lease/retry producer contract | High retry/idempotency | REVIEWED_AFTER_FIX |
| `config/n8n-deployment-policy.json` | Recalculate timeout-weighted concurrency | High production capacity | REVIEWED_AFTER_FIX |
| `src/runtime.mjs` | Reject retry windows below 60 s and invalid headroom | High configuration safety | REVIEWED_AFTER_FIX |
| `src/alerter-mover.mjs` | Validate capacity, calculate deadline headroom, emit complete sanitized summary | High provider gate | REVIEWED_AFTER_FIX |
| `src/alert-receipts.mjs` | Reconcile delivered/retryable/terminal outcomes and clear stale sent evidence | Critical eventual consistency | REVIEWED_AFTER_FIX |
| `src/alert-receipt-store.mjs` | Rename bundled private assertion to prevent Code-node symbol collision | Critical generated runtime | REVIEWED_AFTER_FIX |
| `scripts/build-workflows.mjs` | Generate recovery-first receipt/Data Table graph, CAS+rereads, deferral, owner reconciliation, quota retry, summary | Critical external send/state | REVIEWED_AFTER_FIX |
| `workflows/alerter-mover.json` | Inactive 175-node artifact; all 17 Data Table nodes, 10-read path, reachability, expressions, import/export inspected | Critical generated runtime | REVIEWED_AFTER_FIX |
| `tests/alert-receipts.test.mjs` | Rejection reconciliation and Slack-2xx/Sheet-failure/restart one-call proof | High assurance | REVIEWED_AFTER_FIX |
| `tests/simplified-alerter-mover.test.mjs` | Headroom bounds and summary provider classifications | High provider gate | REVIEWED_AFTER_FIX |
| `tests/simplified-workflows.test.mjs` | Slack ancestors, CAS filters, retired path removal, 65 s retries, read budgets | High assurance | REVIEWED_AFTER_FIX |
| `tests/runtime.test.mjs` | New offset/overlap regression | Moderate | REVIEWED_CLEAN |
| `tests/n8n-deployment.test.mjs` | Updated capacity regression | Moderate | REVIEWED_CLEAN |
| `docs/alerts.md` | Exact pre/post-provider receipt sequence, no-replay failure policy, budgets | Moderate | REVIEWED_AFTER_FIX |
| `docs/architecture.md` | Recovery ordering, durability boundary, headroom and request budgets | Moderate | REVIEWED_AFTER_FIX |
| `docs/n8n-deployment.md` | 300 s runtime and 0.4847 concurrency demand | Moderate operations | REVIEWED_CLEAN |
| `docs/operations.md` | Disposable Data Table import/CAS/Slack-ancestor gates | High operations | REVIEWED_AFTER_FIX |
| `docs/acceptance-matrix.md` | Criterion-level evidence for #60–#62 | Low accounting | REVIEWED_CLEAN |
| `docs/quota-safe-alerter-change-ledger-2026-08-02.md` | File-level provenance and review accounting | Low accounting | REVIEWED_CLEAN |

## High-assurance review lanes

### Lane A — delivery state, replay, and privacy

- Inspected every receipt transition and its Sheet projection, including prior
  sent evidence, retry cap, stale version, duplicate identity, moved owner,
  post-send uncertainty, and restart recovery.
- Verified Slack has one guarded path and that durable `sending` precedes it;
  the outcome CAS precedes every business-result write.
- Verified the 20-field Data Table allowlist and structured events contain no
  complete message, description, profile, webhook, credential, authorization,
  or raw response.
- Findings fixed: bundled helper-name collisions, unsupported Sheet retry
  status, provider-result classification edge cases, unattempted headroom
  deferral, and stale `alert_sent_at` retention.
- Fresh disposition: REVIEWED_AFTER_FIX.

### Lane B — n8n graph, quota, and failure isolation

- Parsed all generated Code nodes; traversed the complete graph with no missing
  or unreachable node; verified receipt CAS filters and Slack ancestors.
- Imported and exported an inactive disposable copy with n8n, retaining 175
  nodes and 17 Data Table nodes.
- Enumerated exactly ten full movement-plus-alert Sheet reads and six
  movement-plus-recovery reads; every Alerter read has two total attempts and a
  65,000 ms interval.
- Findings fixed: undefined generated `ALERT_STATE_FIELDS`, stale old post-Slack
  read topology, read-failure continuation gaps, and summary branch/count loss.
- Fresh disposition: REVIEWED_AFTER_FIX.
