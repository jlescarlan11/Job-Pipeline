# Google Sheets schema

`config/pipeline-schema.json` is authoritative. `Sheet1` and `Archive` use the same logical fields; n8n may also return provider-generated `row_number`, which is never canonical identity. Arrays are stored as JSON strings and normalized on read.

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
| Evaluation | `match_score` | Deprecated compatibility score for new evaluations and unchanged legacy fallback value; not the active new-format priority signal. |
| Evaluation | `match_tier` | Direct, adjacent, or unsupported/unknown tier. |
| Evaluation | `match_decision` | Recommended, review-required, not-recommended, unscorable, or unavailable decision. |
| Evaluation | `match_reasons` | JSON array of concrete profile evidence. |
| Evaluation | `requirement_gaps` | JSON array of material missing/uncertain requirements. |
| Ranking | `qualification_score` | 0–100 strength of approved candidate evidence; blank for legacy/unscored records. |
| Ranking | `opportunity_score` | 0–100 apply-now priority; blank for legacy/unscored records. |
| Ranking | `ranking_confidence` | Blank, high, medium, or low confidence based on input completeness. |
| Ranking | `apply_points_recommendation` | Blank, save-points, low, normal, or high manual allocation recommendation. |
| Ranking | `ranking_factors` | JSON array of versioned factor contributions and source states. |
| Ranking | `ranking_missing_signals` | JSON array of missing optional ranking inputs. |
| Ranking | `requirement_gap_details` | JSON array of structured hard, preference, and uncertain gap details. |
| Ranking | `scoring_policy_version` | Version of the deterministic ranking policy. |
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
| Generation | `message_policy_version` | Application-writing policy used for the message. |
| Generation | `message_validation_status` | `valid` only after deterministic validation. |
| Generation | `generated_at` | Successful generation timestamp. |
| Pack | `application_instructions` | JSON array of extracted employer instructions and required/optional state. |
| Pack | `screening_questions` | JSON array of extracted screening questions. |
| Pack | `selected_proof_refs` | JSON array of approved profile/project evidence references. |
| Pack | `application_warnings` | JSON array of unresolved, ambiguous, or policy-conflicting requests. |
| Pack | `application_pack_status` | Blank, ready, review-required, or blocked. |
| Pack | `application_pack_version` | Structured pack contract/version identifier. |
| Pack | `application_pack_profile_version` | Candidate profile used for the pack. |
| Pack | `application_pack_policy_version` | Pack/application policy used for the pack. |
| Pack | `application_pack_generated_at` | Successful pack generation timestamp. |
| Alert | `alert_status` | Blank, not-eligible, pending, sending, sent, retryable failure, terminal failure, or suppressed. |
| Alert | `alert_channel` | Configured Slack transport identifier; never a credential. |
| Alert | `alert_policy_version` | Alert eligibility/rendering policy version. |
| Alert | `alert_idempotency_key` | Canonical job plus alert-policy version; duplicate-delivery suppression key. |
| Alert | `alert_attempt_count` | Bounded delivery-attempt count. |
| Alert | `alert_last_attempt_at` | Most recent delivery-attempt timestamp. |
| Alert | `alert_next_retry_at` | Earliest retry time for a known transient failure; blank for terminal/sent states. |
| Alert | `alert_sent_at` | Confirmed successful delivery timestamp. |
| Alert | `alert_provider_reference` | Non-sensitive provider delivery reference when available. |
| Alert | `alert_error_category` | Sanitized delivery failure category. |
| Alert | `alert_error_summary` | Sanitized, length-limited delivery failure summary. |
| Alert | `alert_suppressed_reason` | Safe reason an otherwise considered alert was not sent. |
| Review input | `apply_points_input` | Optional whole-number Apply Points input, 1–60; blank means unknown. Cleared after application processing. |
| Review input | `application_message_strategy_input` | Optional bounded versioned strategy identifier, such as `instruction-aware/v1`; cleared after application processing. |
| Review | `manual_action` | Controlled reviewer input consumed by the reviewer workflow. |
| Review | `first_reviewed_at` | First observable authorized review timestamp; blank when unobservable. |
| Application | `application_decision` | Blank, `applied`, or `skipped`; never inferred by automation. |
| Application | `application_decided_at` | Explicit decision timestamp. |
| Application | `apply_points_used` | Actual manually reported Apply Points, integer 1–60; blank means unknown. |
| Application | `application_message_strategy` | Versioned identifier for the message strategy used. |
| Application | `application_qualification_score` | Qualification score snapshot at manual application time. |
| Application | `application_opportunity_score` | Opportunity score snapshot at manual application time. |
| Application | `application_ranking_confidence` | Ranking-confidence snapshot at manual application time. |
| Application | `application_scoring_policy_version` | Ranking-policy snapshot at manual application time. |
| Application | `application_apply_points_recommendation` | Apply Points recommendation snapshot at manual application time. |
| Application | `application_pack_status_at_apply` | Pack/instruction completeness snapshot at manual application time. |
| Application | `application_posting_age_days` | Non-negative posting age calculated at application time when timestamps are valid. |
| Application | `application_snapshot_at` | Timestamp of the immutable application-context snapshot. |
| Outcome | `outcome` | Blank, `no_response`, `replied`, `interview`, `offer`, or `rejected`. |
| Outcome | `outcome_at` | Explicit outcome update timestamp. |
| Outcome | `outcome_events` | JSON array of append-safe outcome milestones and corrections; legacy values remain unexpanded. |
| Audit | `created_at` | Canonical record creation time. |
| Audit | `updated_at` | Last workflow lifecycle/data update. |
| Archive | `archived_at` | First confirmed archive-copy time. |
| Archive | `archived_from_status` | Terminal active status preserved during archival. |
| Review | `notes` | Free-form reviewer notes. |

## Tabs

### `Sheet1`

Active source of truth for discovery, evaluation, generation, review, and retryable recovery. The Apps Script orders `config/review-sheet.json` fields first, freezes the first three columns, wraps message/evidence/gap/notes cells, applies status colors, adds the manual-action dropdown, and rejects non-integer/out-of-range Apply Points or malformed strategy identifiers in the controlled input columns. Only the two temporary application inputs, `manual_action`, and `notes` are intended for editing. Generated columns use warning-only protection so recovery remains possible without silently blocking the workflow service account.

`state_guard` and `processing_token` are placed inside the first 26 physical columns for n8n match-key compatibility and hidden from the normal reviewer view. They remain available to operators by unhiding columns.

### `Archive`

One row per canonical job after idempotent reconciliation. It retains all supported active fields plus `archived_at` and `archived_from_status`. Applied rows remain editable through `manual_action` for outcome follow-up. Archive upserts match `canonical_job_id`, but source deletion also requires a fresh active snapshot and complete archive-field comparison.

### `ProcessingClaims`

| Field | Meaning |
| --- | --- |
| `canonical_job_id` | Claimed job. |
| `processing_stage` | `discovery`, `evaluation`, `generation`, `alert`, or `archival`. |
| `processing_token` | Execution/job/stage token. |
| `created_at` | Claim creation time. |
| `expires_at` | End of the 10-minute lease. |

Claims are append-only arbitration history. For one canonical job/stage, the lowest non-expired Sheet row wins. Expired rows may be purged only during an operator-controlled maintenance window with all workflows disabled.

### `Dashboard`

One row matched by `metric_key=current`: `generated_at`, `total_unique_jobs`, `discovered`, `recommended`, `review_required`, `ready`, `applied`, `skipped`, `replied`, `interview`, `offer`, `rejected`, `retryable_error`, `terminal_error`, and `unavailable`.

Counts deduplicate active/archive identity. Reply/interview/offer/rejection counts require explicit persisted outcomes.

### `Analytics`

Derived report detail keyed by `analytics_row_id`. Each row contains
`report_id`, metric/band versions, generation/window timestamps, section,
dimension, segment key/label, metric key, numerator, denominator, value, unit,
sample size, coverage numerator/denominator, attribution mode, non-additive
flag, and a bounded note. Multi-touch query/role/skill/gap segments are
full-credit and non-additive. No row contains a canonical job ID, description,
generated message, credential, provider payload, or contact detail.

### `AnalyticsReports`

One idempotent completion row per `report_id`: status, definition/band
versions, timestamps/window, analysis timezone, deduplicated record/application
counts, expected detail count, attribution policy, and warning summary. A
consumer selects the newest valid `status=complete` row and filters `Analytics`
to its report ID. Detail rows without complete metadata are a failed/partial
refresh and are not authoritative.

### `Recommendations`

Internal weekly evidence keyed by `recommendation_id`. Each row joins to one
`run_id` and retains the stable `analysis_key`, analytics/policy versions,
window, result status, affected dimension/segment, advisory direction,
numerator, denominator, sample, comparison, baseline, difference, coverage,
operator action, and caveat. Values are formula-neutralized and bounded. The
tab contains no job-level descriptions, messages, contact details, credentials,
provider payloads, or automatic action tokens.

### `RecommendationReports`

One append-safe row per execution `run_id`, including `analysis_key`, status,
result, analytics and recommendation versions, window, configured thresholds,
detail/recommendation/abstention counts, and sanitized failure data. The
internal current view is the newest valid `status=complete` row by
`generated_at` and `run_id`; filter `Recommendations` to that run. Failed or
partial runs remain history and do not replace the last complete report.

## Manual actions

| Action | Valid context | Result |
| --- | --- | --- |
| `mark_reviewed` | Any supported active/archive record | Records `first_reviewed_at` once; repeated use preserves the original timestamp. |
| `promote` | `review_required`, `unscorable` | Routes to recommended/generation eligibility. |
| `regenerate` | `ready` | Returns to recommended without deleting the historical message before a replacement succeeds. |
| `mark_applied` | `ready` | Validates optional inputs, stores applied decision/time, and freezes the application-time snapshot. Repeats preserve the first decision and snapshot. |
| `mark_skipped` | `ready`, `recommended`, `review_required`, `unscorable` | Stores skipped decision and timestamp; repeats preserve the first decision time. |
| `retry` | `retryable_error`, `terminal_error`, `unavailable` | Clears sanitized error fields, resets attempts, and schedules the failed stage. |
| `outcome_*` | Any active/archived record with `application_decision=applied` | Appends the explicit milestone and updates the current outcome view. `no_response` is never inferred. |
| `clear_outcome` | Applied record | Appends a correction and clears the current view without deleting milestone history. |

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
