# Simplified pipeline data contract

The machine-readable source is `config/pipeline-schema.json` (schema version 3, storage contract `2026-07-31-segmented-queues-v3`). This contract applies to records created in the fresh workbook and to legacy `Review Queue` rows accepted by the explicit segmented migration planner. The retained old workbook is never imported. Queue ownership and transitions remain on the segmented v3 contract; deployment compatibility additionally pins a digest of the ordered fields, JSON bounds, timestamps, and field rules, so an older v3 schema shape cannot pass merely because its numeric version matches.

## Authoritative stores

| Store | Owns | Leaves the store when |
| --- | --- | --- |
| `Scraped Jobs` | New, processing, error, unavailable, and generator result records before focused routing | A blank-action result is copied and confirmed in its focused owner, or an approved review is later reprocessed |
| `To Review` | `review_needed` records awaiting `Approve` or `Deny` | A validated action is copied and confirmed in Scraped Jobs or Archive |
| `To Apply` | `ready_to_apply` records awaiting manual `I Applied` or `Skip` | A validated action is copied and confirmed in Applied Jobs or Archive |
| `Applied Jobs` | Listings the user explicitly marked `I Applied` | Never moved automatically |
| `Archive` | Automatic skips, user skips, review denials, and permanently unavailable source listings | Never reactivated automatically |
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
| Archive / `skip`, `review_needed`, `ready_to_apply`, or `unavailable` | blank |

Unsupported store/status/action combinations are invalid even if a Sheet validation rule is bypassed. `Approve` returns a review-needed row to controlled generation and acknowledges only warning codes allow-listed by the active application-pack policy. Acknowledged profile-answerable screening questions become `answer_in_message` and enter the next initial and repair prompts; sensitive commitment questions and external actions remain stored as manual-submission reminders. Unsafe employer segments stay excluded, and proof and message validation cannot be overridden. A missing or unusable description remains non-generatable. `I Applied` records a fact after the user submits manually; no workflow opens or submits an application form. Terminal movement clears `user_action` after preserving the appropriate audit timestamp/reason.

Archive reasons are exact and machine-readable: `automatic_skip` for a system
skip, `user_skip` for the user’s Skip action, `review_denied` for Deny, and
`source_unavailable` for a permanently removed source listing such as HTTP 404
or 410. Temporary provider, network, and source failures remain retryable errors.

## Safety and provenance

The active record retains source timestamps and keyword provenance;
deterministic evaluation scores and reasons; candidate-profile and policy
versions; the generated message; source-ordered application instructions;
screening questions; bounded requirement-level coverage; a one-element
versioned application-message-plan array; canonical selected-proof references;
pack and message validation status; processing/retry evidence; Slack delivery
evidence; terminal timestamps/reasons; outcome; and notes. Generated fields are
protected and hidden where they are not useful for daily review.

`application_instructions`, `screening_questions`, `requirement_coverage`,
`application_message_plan`, and `application_warnings` are serialized JSON
arrays with per-field character maxima declared in the schema. A ready record
requires current pack, coverage, message-plan, profile, application-policy,
and message-policy versions. Legacy or incompatible unsent ready rows are
identifiable by version or missing-state failures and remain suppressed until
they are regenerated or routed to review; terminal historical rows are not
rewritten merely because the application contract changed.

Errors and operational logs use bounded categories and sanitized summaries. They must not contain credentials, authorization headers, full private profile payloads, Slack webhook URLs, or unnecessary full job/message content.

`record_version`, `state_guard`, persisted processing/alert claim tokens, and expiring append-winner `_System` claims prevent a stale worker from overwriting newer protected state or duplicating destination/Slack work. `state_guard` is a SHA-256 digest over the synchronous system-owned durable fields. It covers Generator inputs, the message and its validation/provenance, instructions, questions, coverage, plan, selected proofs, warnings, pack status/timestamp/versions, review authorization, and every Slack-rendered field. It intentionally excludes `user_action`, `outcome`, and `notes`, because a direct operator Sheet edit cannot atomically rewrite the guard cell; those values are validated against their owning store and compared explicitly at the relevant Generator, movement, outcome, and Slack boundaries. It also excludes independently written rediscovery metadata (`matched_keywords`, `last_seen_at`, and `updated_at`) so a stale scraper snapshot cannot replace a newer workflow guard. Every fresh-read commit boundary recomputes the digest rather than trusting the stored cell, so a direct edit to protected system state with a stale guard fails closed. Every route upserts by canonical identity, confirms all planned destination fields, and only then deletes unchanged source state. A Scraped Jobs approval destination is incomplete until it has both a valid approval timestamp and the exact review-strategy digest. `I Applied` records the user's manual application fact independently of the current message-safety result; message safety continues to gate outbound Slack alerts. Partial active and terminal destinations are repaired without overwriting fields owned by their destination.

An `Approve` action snapshots `review_approved_at`, a bounded `review_approval_note`, and `review_approval_guard`. The digest binds authorization to the exact reviewed instructions, questions, canonical coverage, message plan, selected proofs, warnings, status, profile, and policy versions. A timestamp without a matching digest cannot acknowledge a rebuilt strategy. The note remains explicitly untrusted prompt context and never becomes candidate evidence. Applied outcomes use `outcome_recorded_value` to distinguish a new operator edit from the last workflow-recorded value without changing the original `applied_at`, message, or notes.

## Fresh-start boundary

The new workbook contains no historical deduplication. A job handled only in the retained old workbook can appear once if it is posted inside a new Scraper run’s 24-hour window. This is an intentional tradeoff of restarting cleanly.

The old workbook is a read-only backup/reference during rollout. Replacement workflows must never receive its spreadsheet ID, and old and replacement workflows must never mutate concurrently.
