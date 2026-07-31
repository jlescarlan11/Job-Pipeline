# Five-job Generator repository verification — 2026-07-31

This record covers the repository, provider, deployment, and production smoke
evidence for Issues #47, #48, and #49.

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

## Production deployment and smoke

The final generated artifact was present on `main` before production import.
A fresh read-only pre-deployment baseline is recorded at
`outputs/generator-batch-20260731/production-predeployment-baseline.json`.
It confirms the original three-workflow inventory, one-row Generator
definition, restricted rollback backup, production workbook binding, row
counts, and deterministic controls. Capturing the baseline did not execute a
workflow or mutate n8n, Google Sheets, or Slack.

Two live gates failed safely before the successful smoke:

1. execution `6634` exposed an n8n 2.32.6 per-item `$input.first()` runtime
   restriction; one append-only claim was written, no Review Queue row was
   changed, and the prior definition was restored;
2. execution `6635` selected all five candidates and continued after a fourth
   item persistence-verification failure, but Google Sheets throttled the
   fifth claim append; the four controlled row changes were restored and the
   prior definition was restored again.

The second finding produced the checked-in 20-second per-candidate Sheet
pacing floor. Final execution `6636` then:

- selected exactly five identities and left `onlinejobs.ph:1699683`
  untouched as the sixth control;
- appended five unique claims at a minimum spacing of 33,572 milliseconds;
- persisted and exactly confirmed five independent claims and five guarded
  results;
- completed with five valid `skip` outcomes, five confirmed commits, zero
  error items, and zero Groq calls because no candidate reached generation;
- finished successfully in 172,117 milliseconds on workflow version
  `16bd5c9a-876c-426e-a494-d378747e59b3`.

Scheduled Alerter execution `6637` archived the five smoke results and the
pre-existing automatic skip once. Manual replay `6638` made no business-row
write, deletion, alert claim, or Slack provider call. Review Queue retained
only the untouched control, Applied Jobs remained empty, and Archive contained
each expected identity once. After the claim leases elapsed, no-op execution
`6639` pruned all five expired Generator claims without a business-row or Slack
side effect, leaving `_System` empty. No application submission was attempted
and no Apply Points were spent.

The permanent sanitized evidence is
`outputs/generator-batch-20260731/production-deployment-verification.json`.
