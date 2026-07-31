# Five-job Generator repository verification — 2026-07-31

This record covers the repository and authorized provider prerequisites for
Issues #47 and #48. It is not Issue #49 production deployment evidence and
does not authorize mutation of the active workflow or workbook.

## Runtime and capacity

- Generator cap: 5 frozen eligible rows per execution.
- Processing order: sequential, one loop item at a time.
- Schedule: 90 minutes at offset 2 in `Asia/Manila`.
- Timeout: 480 seconds.
- Claim lease: 600 seconds.
- Nominal daily throughput: 16 executions and 80 jobs.
- Conservative provider envelope: 17 trigger boundaries, 85 jobs, and 170
  logical requests.
- Initial route: `openai/gpt-oss-120b`, maximum 85 requests and 168,300
  character-estimated tokens per day.
- Repair route: `openai/gpt-oss-20b`, maximum 85 requests and 196,690
  character-estimated tokens per day.
- Per-minute maximum: 3 requests and 6,942 character-estimated tokens.
- Five-job all-repair provider pacing: 189 seconds.
- Per-candidate Google Sheets pacing: 20 seconds after every handled item,
  adding at most 100 seconds per five-item run.
- Combined configured pacing ceiling: 289 seconds within the 480-second
  execution timeout.

## Authorized Groq prerequisite

Minimal authenticated requests to both scheduled models succeeded. Sanitized
response headers confirmed 1,000 RPD and 8,000 TPM for each model, matching or
exceeding the checked-in planning envelope. No key, authorization header,
prompt, response body, or generated application message is stored in this
record. The final sanitized measurements are checked in at
`outputs/generator-batch-20260731/groq-live-benchmark.json`.
The separate permission/header summary is checked in at
`outputs/generator-batch-20260731/groq-permission-validation.json`.

The full three-case live benchmark completed successfully for both scheduled
models before the route was marked ready. Each case had non-zero provider
usage, avoided the output limit, and passed deterministic application-message
validation. A separate hybrid exercise demonstrated a rejected 120B initial
draft reaching a valid result through the one allowed 20B repair.

## Generated workflow structure

The generated Evaluator & Generator contains an explicit batch-one loop over a
fixed selection of at most five candidates. Each loop item:

1. appends and wins its own `_System` claim;
2. rereads the selected Review Queue identity, rejects missing, ambiguous,
   ineligible, or stage-changed state, then persists and exactly confirms its
   claim;
3. evaluates and, when required, makes one initial request;
4. makes at most one delayed repair after deterministic rejection;
5. guards the proposed commit against current identity, version, state, token,
   and operator action;
6. persists without automatic write retry;
7. rereads and exactly confirms committed fields; and
8. returns a bounded result, waits 20 seconds to stay within production
   Google Sheets request capacity, and then advances the loop.

All handled failure branches return to the loop and each attempted candidate
emits exactly one sanitized `generator_result` event. Generated-workflow tests scan
for job-local `.first()` and fixed-index references, implicit multi-item
fan-out, automatic Groq retry, and missing failure continuations.

## Verification completed

- Domain tests cover zero through six eligible jobs, the fixed first-five
  selection, a sixth untouched row, mixed routing outcomes, one failed job
  followed by four completed jobs, stale state, repeated execution, and
  overlapping append-winner claims.
- Workflow tests cover loop topology, item-local linkage, distinct model
  routes, pacing, bounded mutation failures, and exact confirmations.
- Adjacent regression suites preserve approval safety, unavailable and retry
  behavior, previous-safe-message retention, alert idempotency, movement
  idempotency, the three-workflow inventory, and the manual submission
  boundary.
- The generated workflow imported successfully into an isolated temporary n8n
  2.32.6 profile after assigning a temporary import-only ID and re-exported
  with its 47 nodes, cap, batch size, models, timeout, and timezone intact. The
  sanitized result is checked in at
  `outputs/generator-batch-20260731/n8n-import-validation.json`. No production
  workflow or credential was changed.

## Production gate

Issue #49 requires the exact generated artifact commit to be present on
`main` before updating active workflow `TRUqD9atneyDyMNx` or running the live
five-plus-one smoke. The production deployment, Sheet row verification,
Alerter replay observation, rollback result, and post-deployment evidence
remain open until that prerequisite is satisfied.

A fresh read-only pre-deployment baseline is recorded at
`outputs/generator-batch-20260731/production-predeployment-baseline.json`.
It confirms the current three active workflow identities, the one-row
Generator definition and restricted rollback backup, the production workbook
binding and row counts, seven eligible unclaimed Review Queue rows, the
deterministic first-five selection, and sixth/seventh controls. Capturing this
baseline did not execute a workflow or mutate n8n, Google Sheets, or Slack.
