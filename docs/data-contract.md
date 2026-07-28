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
- `outcome` records the later employer result.
- `manual_action` is an input command and must be cleared after it is handled.

These dimensions are intentionally separate. A network error is not a skip, and
an applied job does not imply a reply, interview, or offer.

The allowed statuses and transitions are machine-readable in
`config/pipeline-schema.json`. Invalid transitions fail closed.

The required `ProcessingClaims` tab is an append-only coordination boundary for
discovery, evaluation, generation, and archival executions. Each claim records
canonical job ID, stage, token, creation time, and expiry. The earliest
unexpired Sheet row for one job and stage owns the work; later claims exit
without performing the guarded write or external generation. Expired claims
remain audit data and are ignored.

Generator claim marking matches `state_guard`. Evaluation and generation
commits match the unique `processing_token`. This prevents a completed manual
decision or a newer processing stage from being overwritten by a stale
execution.

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
