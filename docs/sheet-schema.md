# Google Sheets schema

`config/pipeline-schema.json` is authoritative. `Sheet1` and `Archive` use the same 45 logical fields; n8n may also return provider-generated `row_number`, which is never canonical identity. Arrays are stored as JSON strings and normalized on read.

## Record fields

| Group | Field | Meaning and ownership |
| --- | --- | --- |
| Identity | `source` | Source key; currently `onlinejobs.ph`. |
| Identity | `source_job_id` | Source-provided posting ID when available. |
| Identity | `canonical_job_id` | Stable source ID, or deterministic normalized-URL fallback. |
| Concurrency | `state_guard` | Composite guard for canonical lifecycle state; generator claim marking matches this value. |
| Identity | `canonical_url` | HTTPS URL with normalized host and no query/fragment/trailing slash. |
| Listing | `job_title` | Listing title. |
| Listing | `company` | Company only when the source provides it; blank means unknown. |
| Listing | `job_description` | Persisted detail-page description for evaluation and reuse. |
| Listing | `salary_text` | Source salary text when present; blank means unknown. |
| Listing | `posted_at` | Parsed source posting timestamp. |
| Discovery | `discovered_at` | First time this pipeline discovered the posting. |
| Discovery | `last_seen_at` | Most recent discovery reconciliation. |
| Discovery | `search_queries` | JSON array of every query that found the posting. |
| Discovery | `role_families` | JSON array of evidence-linked role families. |
| Source | `source_availability` | `active`, `unavailable`, or `unknown`. |
| Evaluation | `match_score` | Sortable deterministic fit score. |
| Evaluation | `match_tier` | Direct, adjacent, or unsupported/unknown tier. |
| Evaluation | `match_decision` | Recommended, review-required, not-recommended, unscorable, or unavailable decision. |
| Evaluation | `match_reasons` | JSON array of concrete profile evidence. |
| Evaluation | `requirement_gaps` | JSON array of material missing/uncertain requirements. |
| Evaluation | `profile_version` | Candidate profile used for evaluation; legacy rows use `legacy/unknown`. |
| Evaluation | `evaluated_at` | Evaluation timestamp. |
| Lifecycle | `pipeline_status` | Current system lifecycle status; separate from application decision/outcome. |
| Processing | `processing_stage` | Current `evaluation` or `generation` stage; blank outside active processing. |
| Processing | `processing_token` | Unique optimistic-concurrency token. A completed stage may retain its last token while stage/start are blank. |
| Processing | `processing_started_at` | Current claim start time; blank after completion. |
| Recovery | `attempt_count` | Failed attempts for the current recovery path. |
| Recovery | `failed_stage` | Stage to retry: normally evaluation or generation. |
| Recovery | `next_retry_at` | Earliest retry time. |
| Recovery | `error_category` | Sanitized error class such as timeout, rate limit, external failure, invalid request, or processing failure. |
| Recovery | `error_summary` | Sanitized, length-limited reason; never raw credentials/provider payloads. |
| Generation | `generated_message` | Validated, copy-ready message with formatting preserved. |
| Generation | `message_profile_version` | Candidate profile used for the message; legacy messages use `legacy/unknown`. |
| Generation | `message_validation_status` | `valid` only after deterministic validation. |
| Generation | `generated_at` | Successful generation timestamp. |
| Review | `manual_action` | Controlled reviewer input consumed by the reviewer workflow. |
| Application | `application_decision` | Blank, `applied`, or `skipped`; never inferred by automation. |
| Application | `application_decided_at` | Explicit decision timestamp. |
| Outcome | `outcome` | Blank, `no_response`, `replied`, `interview`, `offer`, or `rejected`. |
| Outcome | `outcome_at` | Explicit outcome update timestamp. |
| Audit | `created_at` | Canonical record creation time. |
| Audit | `updated_at` | Last workflow lifecycle/data update. |
| Archive | `archived_at` | First confirmed archive-copy time. |
| Archive | `archived_from_status` | Terminal active status preserved during archival. |
| Review | `notes` | Free-form reviewer notes; the only editable field besides `manual_action`. |

## Tabs

### `Sheet1`

Active source of truth for discovery, evaluation, generation, review, and retryable recovery. The Apps Script orders `config/review-sheet.json` fields first, freezes the first three columns, wraps message/evidence/gap/notes cells, applies status colors, and adds the manual-action dropdown. Generated columns use warning-only protection so recovery remains possible without silently blocking the workflow service account.

`state_guard` and `processing_token` are placed inside the first 26 physical columns for n8n match-key compatibility and hidden from the normal reviewer view. They remain available to operators by unhiding columns.

### `Archive`

One row per canonical job after idempotent reconciliation. It retains all supported active fields plus `archived_at` and `archived_from_status`. Applied rows remain editable through `manual_action` for outcome follow-up. Archive upserts match `canonical_job_id`, but source deletion also requires a fresh active snapshot and complete archive-field comparison.

### `ProcessingClaims`

| Field | Meaning |
| --- | --- |
| `canonical_job_id` | Claimed job. |
| `processing_stage` | `discovery`, `evaluation`, `generation`, or `archival`. |
| `processing_token` | Execution/job/stage token. |
| `created_at` | Claim creation time. |
| `expires_at` | End of the 10-minute lease. |

Claims are append-only arbitration history. For one canonical job/stage, the lowest non-expired Sheet row wins. Expired rows may be purged only during an operator-controlled maintenance window with all workflows disabled.

### `Dashboard`

One row matched by `metric_key=current`: `generated_at`, `total_unique_jobs`, `discovered`, `recommended`, `review_required`, `ready`, `applied`, `skipped`, `replied`, `interview`, `offer`, `rejected`, `retryable_error`, `terminal_error`, and `unavailable`.

Counts deduplicate active/archive identity. Reply/interview/offer/rejection counts require explicit persisted outcomes.

## Manual actions

| Action | Valid context | Result |
| --- | --- | --- |
| `promote` | `review_required`, `unscorable` | Routes to recommended/generation eligibility. |
| `regenerate` | `ready` | Returns to recommended without deleting the historical message before a replacement succeeds. |
| `mark_applied` | `ready` | Stores applied decision and timestamp. |
| `mark_skipped` | `ready`, `recommended`, `review_required`, `unscorable` | Stores skipped decision and timestamp. |
| `retry` | `retryable_error`, `terminal_error`, `unavailable` | Clears sanitized error fields, resets attempts, and schedules the failed stage. |
| `outcome_*` | Any active/archived record with `application_decision=applied` | Stores the explicit outcome and timestamp. |
| `clear_outcome` | Applied record | Clears outcome while retaining application history. |

Blank means no action. Unsupported or invalid values produce an execution log and no update. `unavailable` cannot be promoted directly; it must be retried and reevaluated.

## Lifecycle states

The complete transition map is in `config/pipeline-schema.json`. Key paths are:

```text
discovered -> evaluating
evaluating -> recommended | review_required | not_recommended | unscorable
           -> unavailable | retryable_error | terminal_error
recommended -> generating -> ready | retryable_error | terminal_error
review_required -> recommended (explicit promote) | skipped
ready -> generating (explicit regenerate) | applied | skipped
retryable_error -> evaluating | generating | terminal_error
applied | skipped | not_recommended | terminal_error -> archived
```

Processing status, application decision, and employer outcome remain separate dimensions.

## Legacy compatibility

- `job_url` maps to `canonical_url`.
- `status` maps `pending`, `processing`, `ready`, `applied`, `skipped`, and `error` to the new lifecycle.
- `created_at ` copies into `created_at` only when the canonical cell is blank.
- Archive rows with a legacy terminal status migrate to `pipeline_status=archived` and retain the mapped value in `archived_from_status`.
- Existing ready messages are preserved and tagged `message_profile_version=legacy/unknown`.
- Existing applied/skipped decisions are preserved.
- Legacy URLs remain part of active/archive deduplication.

`google-apps-script/SheetSetup.gs` performs the additive migration. It does not delete legacy headers, rows, messages, decisions, outcomes, notes, or unrelated conditional formatting.
