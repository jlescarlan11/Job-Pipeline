# Simplified pipeline data contract

The machine-readable source is `config/pipeline-schema.json` (schema version 2). This contract applies only to records created in the fresh workbook. No old-workbook row is imported.

## Authoritative stores

| Store | Owns | Leaves the store when |
| --- | --- | --- |
| `Review Queue` | Every active discovered listing | A validated operator action or automatic `skip` is copied and confirmed in a terminal store |
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

`user_action` is user-owned and never inferred:

| Current status | Accepted actions |
| --- | --- |
| `ready_to_apply` | blank, `I Applied`, `Skip` |
| `review_needed` | blank, `Approve`, `Deny` |
| every other status | blank only |

Unsupported status/action pairs are invalid even if a Sheet validation rule is bypassed. `Approve` returns a review-needed row to controlled generation; it does not waive pack or message validation. `I Applied` records a fact after the user submits manually; no workflow opens or submits an application form.

Archive reasons are exact and machine-readable: `automatic_skip` for a system
skip, `user_skip` for the user’s Skip action, and `review_denied` for Deny.

## Safety and provenance

The active record retains source timestamps and keyword provenance; deterministic evaluation scores and reasons; candidate-profile and policy versions; the generated message; pack and message validation status; processing/retry evidence; Slack delivery evidence; terminal timestamps/reasons; outcome; and notes. Generated fields are protected and hidden where they are not useful for daily review.

Errors and operational logs use bounded categories and sanitized summaries. They must not contain credentials, authorization headers, full private profile payloads, Slack webhook URLs, or unnecessary full job/message content.

`record_version`, `state_guard`, persisted processing/alert claim tokens, and expiring append-winner `_System` claims prevent a stale worker from overwriting a newer user action or duplicating destination/Slack work. A terminal move always passes the shared persisted-message gate for `I Applied`, upserts by canonical identity, confirms the destination copy, and only then deletes unchanged Review Queue state.

An `Approve` action snapshots `review_approved_at` and a bounded `review_approval_note`; that note remains explicitly untrusted prompt context and never becomes candidate evidence. Applied outcomes use `outcome_recorded_value` to distinguish a new operator edit from the last workflow-recorded value without changing the original `applied_at`, message, or notes.

## Fresh-start boundary

The new workbook contains no historical deduplication. A job handled only in the retained old workbook can appear once if it is posted inside a new Scraper run’s 24-hour window. This is an intentional tradeoff of restarting cleanly.

The old workbook is a read-only backup/reference during rollout. Replacement workflows must never receive its spreadsheet ID, and old and replacement workflows must never mutate concurrently.
