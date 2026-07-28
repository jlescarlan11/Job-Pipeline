# Pipeline Data Contract

`config/pipeline-schema.json` defines the logical contract shared by discovery,
evaluation, generation, review, and archival. Physical Google Sheets headers
may be migrated in stages, but their meaning must stay aligned with this
contract.

## Identity

The canonical identity order is:

1. `onlinejobs.ph:<source_job_id>` when the source ID is available.
2. `onlinejobs.ph:url:<normalized-url-hash>` when it is not.

`row_number` is an n8n/Google Sheets locator, not persistent identity. Workflow
updates must verify canonical identity before relying on a mutable row number.

## State dimensions

- `pipeline_status` records automated lifecycle state.
- `state_guard` is the optimistic-concurrency key for canonical lifecycle
  state.
- `application_decision` records the candidate's explicit applied/skipped
  decision.
- `first_reviewed_at`, application-time ranking fields, actual Apply Points when
  known, and the message-strategy identifier preserve the context of the
  candidate's manual decision.
- `apply_points_input` and `application_message_strategy_input` are controlled,
  temporary reviewer inputs. A successful or duplicate application decision
  clears them; durable values remain generated/protected fields.
- `outcome` is the current compatibility view of the later employer result.
- `outcome_events` is append-safe milestone/audit history. Legacy latest-outcome
  values are not expanded into events because doing so would fabricate history.
- `manual_action` is an input command and must be cleared after it is handled.
  `mark_reviewed` is the explicit first-review instrument; source discovery,
  ranking, generation, alert delivery, and source-link opens never stamp it.

These dimensions are intentionally separate. A network error is not a skip, and
an applied job does not imply a reply, interview, or offer.

The allowed statuses and transitions are machine-readable in
`config/pipeline-schema.json`. Invalid transitions fail closed.

The required `ProcessingClaims` tab is an append-only coordination boundary for
discovery, evaluation, generation, alert, and archival executions. Each claim records
canonical job ID, stage, token, creation time, and expiry. The earliest
unexpired Sheet row for one job and stage owns the work; later claims exit
without performing the guarded write or external generation. Expired claims
remain audit data and are ignored.

Generator claim marking matches `state_guard`. The guard covers lifecycle,
first review, actual Apply Points, message strategy, current outcome, and
outcome events. Evaluation and generation commits match the unique
`processing_token`. This prevents completed manual review/application/outcome
state or a newer processing stage from being overwritten by a stale execution.

## Opportunity-learning dimensions

- `qualification_score` and `opportunity_score` are distinct 0–100 values.
  Blank means the record has not been evaluated under the new policy.
- `ranking_confidence` is blank, `high`, `medium`, or `low`.
- `apply_points_recommendation` is blank, `save_points`, `low_allocation`,
  `normal_allocation`, or `high_allocation`; it never spends points.
- Ranking factors, missing signals, and structured gap details preserve the
  explanation and `scoring_policy_version`.
- Application-pack fields preserve structured instructions, questions, proof
  references, warnings, status, and the profile/policy versions used.
- Alert fields preserve delivery status and sanitized provider metadata. They
  never contain credentials or reusable action tokens.
- `alert_idempotency_key` scopes one initial delivery to canonical identity and
  alert-policy version. `alert_next_retry_at` gates known-safe transient retry;
  `sending` represents an externally ambiguous in-flight boundary and is never
  blindly resent after its claim expires.
- Application snapshot fields preserve the ranking and pack context that
  applied when the candidate made the manual decision.

Structured arrays are serialized as JSON in Sheets and normalized on read.
Invalid score bounds, enums, timestamps, points, or JSON arrays fail contract
validation rather than being silently coerced into a valid value.

At the first successful `mark_applied`, the application snapshot copies the
current qualification/opportunity scores, confidence, ranking policy, Apply
Points recommendation, pack status, message strategy, and calculable posting
age. A blank Apply Points input remains blank/unknown. Once
`application_snapshot_at` exists, later permitted review or regeneration paths
preserve every snapshot field.

Each distinct explicit outcome or correction appends a stable-ID event while
`outcome`/`outcome_at` retain the latest compatibility view. Repeating the
current outcome or clearing an already blank outcome consumes the command
without adding another event or replacing the original outcome timestamp.
Archive reconciliation unions event IDs and chooses the latest timestamped
current view; legacy outcome values do not fabricate historical events.

## Analytics reports

`Analytics` and `AnalyticsReports` are derived append-safe reporting state, not
part of the canonical job record. `analytics_row_id` is the idempotent detail
key; `report_id` joins detail to its metadata. A report is authoritative only
when `AnalyticsReports.status=complete` and its recorded `detail_row_count`
matches the persisted detail cohort. Partial/orphan detail rows remain
diagnostic evidence and never change source records or the existing Dashboard.

Every detail row records metric/band versions, all-time window boundaries,
dimension/segment, numerator, denominator, value, unit, sample size, coverage,
and attribution/additivity metadata. Numeric zero is distinct from a blank
undefined ratio. The source of score/confidence/recommendation/pack/strategy
dimensions is the immutable application snapshot; no analytic output is fed
back into ranking or search policy.

The active ranker is configured by `config/ranking-policy.json`. New-format
queues use `opportunity_score`, then confidence, posting time, creation time,
and canonical identity within each lifecycle priority. A legacy row with no
opportunity score may use its unchanged `match_score` as a documented queue
fallback; this does not copy or relabel the legacy value.

## Weekly recommendation reports

`Recommendations` and `RecommendationReports` are derived advisory state. They
consume only the newest compatible, complete analytics report. A
`recommendation_id` is the idempotent detail key; `run_id` joins detail to one
attempt; and `analysis_key` groups superseding attempts that use the same
analytics report, recommendation policy, and candidate-profile version.

Each detail row records its affected dimension/segment, direction, evidence
metric, numerator, denominator, sample size, comparison/baseline/difference,
coverage, all-time window, versions, proposed operator action, and caveat. Its
status is `recommendation`, `abstained`, or `empty`. Report status is
`complete` or `failed`; a complete result is `recommendations`, `abstained`, or
`empty`. Consumers select the newest complete report and ignore failed or
partial detail when determining the current view.

A recommendation is not canonical job state and cannot authorize a write to
the search plan, ranking policy, candidate profile, application strategy,
application decision, outcome, or Apply Points. Empty, abstained, partial, and
failed runs preserve that boundary. Future automated calibration is a separate
contract and requires explicit approval.

## Compatibility

Legacy headers and statuses are normalized as follows:

| Legacy value | Canonical value |
| --- | --- |
| `job_url` | `canonical_url` |
| `created_at ` | `created_at` |
| `status=pending` | `pipeline_status=discovered` |
| `status=processing` | `pipeline_status=evaluating` |
| `status=error` | `pipeline_status=terminal_error` |

Existing `ready`, `applied`, and `skipped` records retain their message and
manual decision. Records with generated content but no version receive
`message_profile_version=legacy/unknown`.

Legacy `match_score` remains a legacy value. It is not copied into
`qualification_score` or `opportunity_score`. Legacy outcomes remain the
current compatibility value and do not create fabricated `outcome_events`.

## Migration

1. Export recoverable copies of Sheet1 and Archive.
2. Add canonical columns without deleting or renaming legacy columns.
3. Normalize records into a copy and validate counts, identity uniqueness,
   generated messages, and manual decisions.
4. Enable new workflow writers only after legacy and canonical readers agree.
5. Keep the old writer disabled during the cutover to prevent conflicting
   state updates.
6. Retain the trailing-space legacy header through this rollout; only the
   canonical `created_at` column is written by the new workflows.

## Rollback

Rollback restores the previous disabled workflow exports but does not delete
new columns or canonical IDs. Preserve:

- active and archived rows;
- canonical identities and URL fallback identity;
- existing ready messages and their profile versions;
- application decisions and outcomes;
- legacy columns required by the previous exports.

If a rollback cannot read a newly created status, leave the row untouched and
handle it manually rather than coercing it to `pending` or `error`.
