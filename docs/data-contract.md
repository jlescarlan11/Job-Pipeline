# Simplified pipeline data contract

The machine-readable source is `config/pipeline-schema.json` (schema version 3, storage contract `2026-07-31-segmented-queues-v3`). This contract applies to records created in the fresh workbook and to legacy `Review Queue` rows accepted by the explicit segmented migration planner. The retained old workbook is never imported.

## Authoritative stores

| Store | Owns | Leaves the store when |
| --- | --- | --- |
| `Scraped Jobs` | New, processing, error, unavailable, and generator result records before focused routing | A blank-action result is copied and confirmed in its focused owner, or an approved review is later reprocessed |
| `To Review` | `review_needed` records awaiting `Approve` or `Deny` | A validated action is copied and confirmed in Scraped Jobs or Archive |
| `To Apply` | `ready_to_apply` records awaiting manual `I Applied` or `Skip` | A validated action is copied and confirmed in Applied Jobs or Archive |
| `Applied Jobs` | Listings the user explicitly marked `I Applied` | Never moved automatically |
| `Archive` | Automatic skips, user skips, and review denials | Never reactivated automatically |
| `_System` (hidden) | Short-lived concurrency claims | Claims expire and are pruned |

Canonical identity is `onlinejobs.ph:<source_job_id>`. When a source ID must be recovered, the canonical OnlineJobs.ph job URL is normalized first. The same identity may appear in only one authoritative store. Ambiguous, malformed, or duplicate identity input stops the affected operation.

## Status and action model

The only business results are:

- `ready_to_apply` — a validated message and application pack are ready for manual submission.
- `review_needed` — promising, but a question, evidence gap, or manual decision prevents readiness.
- `skip` — a deterministic disqualifier or low-fit decision.

Operational conditions are separate from those recommendations:

- `new` — discovered but not claimed.
- `processing` — a worker owns a current evaluation or generation claim.
- `error` — retryable or exhausted technical work, with categorized bounded evidence.
- `unavailable` — the source listing cannot currently provide the input needed to evaluate it.

`user_action` is user-owned and never inferred. Validity is the intersection of sheet ownership and status:

| Store/status | Accepted actions |
| --- | --- |
| Scraped Jobs / any owned operational or result status | blank; `Approve` is retained only for an approved `review_needed` row returned for gated reconsideration |
| To Review / `review_needed` | blank, `Approve`, `Deny` |
| To Apply / `ready_to_apply` | blank, `I Applied`, `Skip` |
| Applied Jobs / `ready_to_apply` | blank |
| Archive / `skip`, `review_needed`, or `ready_to_apply` | blank |

Unsupported store/status/action combinations are invalid even if a Sheet validation rule is bypassed. `Approve` returns a review-needed row to controlled generation; it does not waive pack or message validation. `I Applied` records a fact after the user submits manually; no workflow opens or submits an application form. Terminal movement clears `user_action` after preserving the appropriate audit timestamp/reason.

Archive reasons are exact and machine-readable: `automatic_skip` for a system
skip, `user_skip` for the user’s Skip action, and `review_denied` for Deny.

## Safety and provenance

The active record retains source timestamps and keyword provenance; deterministic evaluation scores and reasons; candidate-profile and policy versions; the generated message; pack and message validation status; processing/retry evidence; Slack delivery evidence; terminal timestamps/reasons; outcome; and notes. Generated fields are protected and hidden where they are not useful for daily review.

Errors and operational logs use bounded categories and sanitized summaries. They must not contain credentials, authorization headers, full private profile payloads, Slack webhook URLs, or unnecessary full job/message content.

`record_version`, `state_guard`, persisted processing/alert claim tokens, and expiring append-winner `_System` claims prevent a stale worker from overwriting a newer user action or duplicating destination/Slack work. Every route upserts by canonical identity, confirms all planned destination fields, and only then deletes unchanged source state. `I Applied` passes the current shared persisted-message gate, or—after a later profile/configuration change—must carry a confirmed successful alert whose idempotency key still matches the exact stored message. Partial active and terminal destinations are repaired without overwriting fields owned by their destination.

An `Approve` action snapshots `review_approved_at` and a bounded `review_approval_note`; that note remains explicitly untrusted prompt context and never becomes candidate evidence. Applied outcomes use `outcome_recorded_value` to distinguish a new operator edit from the last workflow-recorded value without changing the original `applied_at`, message, or notes.

## Fresh-start boundary

The new workbook contains no historical deduplication. A job handled only in the retained old workbook can appear once if it is posted inside a new Scraper run’s 24-hour window. This is an intentional tradeoff of restarting cleanly.

The old workbook is a read-only backup/reference during rollout. Replacement workflows must never receive its spreadsheet ID, and old and replacement workflows must never mutate concurrently.
