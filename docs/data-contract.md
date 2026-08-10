# Simplified pipeline data contract

The machine-readable source is `config/pipeline-schema.json` (schema version 5, storage contract `2026-08-10-autonomous-browser-v5`). It adds an autonomous Chrome lifecycle without removing the bounded v4 manual compatibility path. Deployment compatibility pins the ordered fields, field bounds, timestamps, browser transitions, store ownership, and contract digest, so a mixed contract set fails closed. A blank `execution_mode` normalizes only to `legacy_manual`; it can never manufacture autonomous submission authority.

## Authoritative stores

| Store | Owns | Leaves the store when |
| --- | --- | --- |
| `Scraped Jobs` | New, processing, error, unavailable, and initial Generator results | A blank-action result is copied and confirmed in its focused owner |
| `To Review` | Unresolved `review_needed` cases awaiting `Proceed` or `Reject` | A final decision is copied and confirmed in To Apply or Archive |
| `To Apply` | Every proceeded or direct-ready `ready_to_apply` record throughout preparation | The user selects `I Applied` or `Skip` and guarded movement confirms the terminal owner |
| `Applied Jobs` | Listings the user explicitly marked `I Applied` | Never moved automatically |
| `Archive` | Automatic skips, user skips, review denials, and permanently unavailable source listings | Never reactivated automatically |
| `_System` (hidden) | Short-lived concurrency claims | Claims expire and are pruned |

Canonical identity is `onlinejobs.ph:<source_job_id>`. When a source ID must be recovered, the canonical OnlineJobs.ph job URL is normalized first. The same identity may appear in only one authoritative store. Ambiguous, malformed, or duplicate identity input stops the affected operation.

## Status and action model

The only business results are:

- `ready_to_apply` — ownership is in To Apply. Copy readiness is represented separately by `prep_status=message_ready`.
- `review_needed` — promising, but a question, evidence gap, or manual decision prevents readiness.
- `skip` — a deterministic disqualifier or low-fit decision.

Operational conditions are separate from those recommendations:

- `new` — discovered but not claimed.
- `processing` — a worker owns a current evaluation or generation claim.
- `error` — retryable or exhausted technical work, with categorized bounded evidence.
- `unavailable` — the source listing cannot currently provide the input needed to evaluate it.

`user_action` remains user-owned for `legacy_manual` records and is never inferred. Validity is the intersection of sheet ownership and status:

| Store/status | Accepted actions |
| --- | --- |
| Scraped Jobs / any owned operational or result status | blank |
| To Review / `review_needed` | blank, `Proceed`, `Reject` |
| To Apply / `ready_to_apply` | blank, `I Applied`, `Skip` |
| Applied Jobs / `ready_to_apply` | blank |
| Archive / `skip`, `review_needed`, `ready_to_apply`, or `unavailable` | blank |

Unsupported store/status/action combinations are invalid even if Sheet validation is bypassed. `Proceed`, `Reject`, `I Applied`, and `Skip` remain available only for bounded legacy records. An `autonomous_chrome` record requires a blank `user_action` and cannot use review-case or preparation authorization fields.

## Autonomous browser lifecycle

New autonomous work explicitly persists `execution_mode=autonomous_chrome`, `automation_contract_version=browser-contract-v1`, and one of these guarded states:

`queued → claimed → evaluating → generating → filling → submit_started → confirmed`.

`retryable`, `blocked`, `unavailable`, `skipped`, and `ambiguous` are explicit recovery or terminal branches. `submit_started` is persisted before the browser click. It may advance only to `confirmed`, `ambiguous`, or `blocked`; it can never return directly to filling or ordinary retry because the source may already have accepted the application.

The stable `submission_idempotency_key` binds canonical job identity, the live job digest, form fingerprint, candidate/message provenance, application-pack versions, and automation contract. It deliberately excludes `browser_attempt_id` and timestamps, so retries for compatible inputs derive the same key. Generation and later states require the form fingerprint and matching key.

A confirmed record requires `autonomous_decision=apply`, start and confirmation timestamps, a persisted full-configuration `browser_context_digest`, and bounded confirmation/attestation fields: an allowlisted confirmation kind, hashed confirmation reference, confirmation digest, pinned adapter key ID, witness digest, and Ed25519 signature. `commit-result` verifies the receipt first, and Alerter & Mover independently reconstructs and verifies it again before copy-confirm-delete. No confirmation summary, DOM, screenshot, cookie, credential, generated message, or job description is added to the evidence fields. A skipped record requires `autonomous_decision=skip`. Missing candidate facts, login/security challenges, CAPTCHA, unexpected agreements, unsafe uploads, invalid forms, policy mismatch, and confirmation uncertainty remain categorized blockers rather than review approvals.

Active autonomous records remain in `Scraped Jobs`. `To Review` and `To Apply` reject autonomous browser states. Alerter & Mover remains the only component permitted to relocate a confirmed record to `Applied Jobs` or a skipped/unavailable record to `Archive` through copy-confirm-delete.

Preparation is monotonic and independently versioned:

- `pending` and `preparing` are active work;
- `message_ready` is the only copy-ready state and requires current pack/message provenance;
- `needs_input` contains a bounded candidate-input checklist;
- `external_steps` contains bounded employer actions that the workflow will not perform;
- `repair_pending` and `preparation_error` retain bounded retry/error evidence.

An unchanged paused preparation is not reselected. A relevant input change must advance `preparation_version` and persist a matching `preparation_input_guard` before exactly one new claim can run.

Archive reasons are exact and machine-readable: `autonomous_skip` for a v5
browser decision with `browser_state=skipped`, `automatic_skip` for a legacy
system skip, `user_skip` for the user’s Skip action, `review_denied` for Reject,
and `source_unavailable` for a permanently removed source listing such as HTTP
404 or 410. Temporary provider, network, and source failures remain retryable
errors.

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

`record_version`, `state_guard`, persisted processing/alert claim tokens, and expiring append-winner `_System` claims prevent stale overwrites and duplicate work. The SHA-256 guard includes review-case resolution plus preparation status/version/input identity. Operator-owned `user_action`, `outcome`, and `notes` remain outside the digest because Sheet edits cannot atomically refresh it; their owning commit boundary compares them explicitly. Every route upserts by canonical identity, confirms the complete destination record, and only then deletes unchanged source state. A surviving destination copy after a failed delete is recovery evidence, not an ownership error: the next guarded run rereads both records and retries only the confirmed source deletion. Other cross-store duplicates fail closed.

The migration compatibility is `guarded_v3_claim_once`: it accepts only a v3 digest with no persisted v4 lifecycle state, then the Generator or Alerter & Mover claim writes a v4 guard. This includes one explicit exit for looped Scraped Jobs rows only when their fresh raw action is the retired `Approve` or `Deny` spelling; the normalized guarded route proceeds to To Apply or rejects to Archive. A newly supplied `Proceed`/`Reject`, or a v3 digest attached to any v4 review/preparation field, fails closed.

A `Proceed` action persists `review_case_id`, `review_case_version`, `review_decision=proceed`, and `review_decided_at`, together with the compatibility audit fields `review_approved_at`, bounded `review_approval_note`, and `review_approval_guard`. The case fingerprint is stable across retries but changes when material review inputs change. A resolved fingerprint cannot reopen as an undecided copy. The note remains explicitly untrusted prompt context and never becomes candidate evidence. Applied outcomes use `outcome_recorded_value` to distinguish a new operator edit from the last workflow-recorded value without changing the original `applied_at`, message, or notes.

## Fresh-start boundary

The new workbook contains no historical deduplication. A job handled only in the retained old workbook can appear once if it is posted inside a new Scraper run’s 24-hour window. This is an intentional tradeoff of restarting cleanly.

The old workbook is a read-only backup/reference during rollout. Replacement workflows must never receive its spreadsheet ID, and old and replacement workflows must never mutate concurrently.
