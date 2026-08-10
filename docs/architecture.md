# Simplified architecture

The active replacement contains two n8n workflows and one scheduled Codex
browser task.

```text
OnlineJobs.ph
      |
      v
Scraper (n8n, 4h rolling 24h) <----- Search Keywords
      |
      v
Scraped Jobs
      |
      +--> Browser Executor (scheduled Codex + Chrome, 90m)
      |         |
      |         +--> confirmed ----> Alerter & Mover ----> Applied Jobs
      |         +--> skipped -------> Alerter & Mover --> Archive
      |         +--> blocked / retryable / ambiguous (recover in place)
      |
      +--> Alerter & Mover (15m)
                |
                +--> Slack (copy-ready or bounded action reminder)
                +--> To Apply (proceeded review, prep pending)
                +--> Applied Jobs
                +--> Archive

Legacy To Review / To Apply actions -- Alerter & Mover --> guarded drain/retain
```

## Trust boundaries

The Main workbook has five visible authoritative business stores: `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, and `Archive`. A canonical identity can exist in only one. `Scraped Jobs` owns intake and autonomous browser processing; `To Review` and `To Apply` retain legacy/manual compatibility during migration; `Applied Jobs` and `Archive` are terminal. Alerter & Mover atomically sorts complete business rows in movement-touched stores by their store-specific lifecycle timestamp before rereading those stores and resolving deletion row numbers, so newest records stay directly below each header without weakening copy-confirm-delete. Its hidden `_System` tab contains only expiring append-winner claims used to arbitrate overlapping discovery, browser execution, movement, and alert work. Movement and alert contenders wait ten seconds and reread claims before selecting a winner so a concurrent Google Sheets append that becomes visible after the first read cannot authorize a stale writer.

The separate Configuration workbook contains the twelve visible operator-owned tabs: `Search Keywords`, `Candidate`, `Skills`, `Experience`, `Projects`, `Education`, `Awards`, `Job Preferences`, `Application Settings`, `Required Style`, `Banned Phrases`, and `Prompts`. None is a business-record store. Workflows read these tabs directly from the Configuration workbook; the Main workbook contains no configuration copies or `IMPORTRANGE` bridge.

Google Sheet validation improves usability, but workflow-side contract validation is authoritative. Generated fields use warning-only protection; an API or pasted value is still validated again before any status change, alert, or move.

The retained old workbook is outside the replacement data plane and is never imported. Its ID, `JOB_PIPELINE_SPREADSHEET_ID`, and `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` must all differ. No generated workflow contains a literal workbook ID, and cutover rejects active old/new overlap.

The v5 persistence contract supports an autonomous Chrome executor while keeping
legacy manual rows readable. Autonomous work remains in `Scraped Jobs` through
`queued`, claim, evaluation, generation, fill, persisted submit intent, and
confirmation or a bounded failure state. Job text is untrusted context and can
never set policy, decision, browser authorization, or confirmation fields.
No workflow authorizes an application from job-page text or model output; only
the validated trusted policy can authorize the browser executor.
Alerter & Mover remains the sole owner of cross-store copy-confirm-delete.

The stable submission identity binds canonical job, live job/form digests, and
the persisted full candidate/ranking/application/pack configuration context but
excludes attempt IDs and timestamps. `submit_started` is persisted before the
click and cannot return to fill or ordinary retry. Confirmation is accepted only
with an independent account-history adapter signature over the immutable
submission witness. The bounded key ID, witness digest, and signature are
persisted so Alerter & Mover can verify the receipt independently before
copy-confirm-delete; credentials, cookies, DOM dumps, screenshots, descriptions,
and message copies are never stored as confirmation evidence. Legacy `Proceed`,
`Reject`, `I Applied`, and `Skip` actions do
not grant autonomous authority.

## Scraper

At execution start, Scraper reads `Search Keywords`, validates the exact
`enabled`/`keyword` contract, derives internal keyword identities, and freezes
the enabled normalized keyword snapshot together with:

```text
window_end   = execution reference instant
window_start = window_end - 24 hours
```

Every keyword, page, retry, parser call, and reconciliation receives that exact
snapshot and those exact values. A sheet edit during a run applies only to the
next run. A missing, unreadable, empty, malformed, or duplicate enabled-keyword
configuration fails before source requests or workbook writes, with no embedded
keyword fallback. Timestamps at both boundaries are accepted. Older, future,
missing, or unparseable timestamps are excluded with categorized evidence.

Search is intentionally plain keyword matching. Pagination is source-exhaustion aware and capped at three pages per keyword; requests are paced, timed out, and retried within configuration. Login, challenge, maintenance, and structurally unrecognized pages never produce jobs.

Canonical source ID and canonical URL are compared across all five business stores. Multi-keyword results merge into one record. A new identity is appended only to `Scraped Jobs`. Rediscovery updates discovery-owned fields in whichever active sheet currently owns the record (`Scraped Jobs`, `To Review`, or `To Apply`), but it cannot reset status, action, message, retry, alert, notes, or reviewer state. `Applied Jobs` and `Archive` suppress reinsertion.

## Browser executor

The versioned executor protocol owns deterministic selection, claims, context
exchange, draft validation, submit intent, result commit, and recovery. The
scheduled task explicitly invokes the `job-autopilot` skill and installed
Chrome plugin in the local project. Only the skill operates the visible page;
only the protocol writes executor-owned fields; neither can relocate rows.

The executor treats all job/page content as untrusted, generates messages only
from current approved candidate evidence and trusted policy, and persists a
stable submit identity and `submit_started` state before the final click. It
accepts only definitive independently attested confirmation. An ambiguous post-click result is
reconciled before any retry, preventing duplicate applications. Technical
headroom defers remaining due jobs to later runs without introducing a daily
application quota. There is no daily application cap.

The active n8n build contains no Generator, Groq request, message-generation
node, browser action, or submission path.

## Retired Evaluator & Generator (legacy behavior reference)

The following describes the prior manual compatibility unit only. It remains
useful for classifying and draining legacy rows and for rollback analysis; it
is not built or activated by the current mixed runtime.

The workflow reads both `Scraped Jobs` and `To Apply`, orders all eligible evaluation/preparation candidates deterministically, freezes one global batch of at most five, and never backfills it. It processes those frozen identities sequentially. Each candidate independently appends a source-store-qualified `_System` claim, proves earliest unexpired ownership, writes the claim to that exact source store, and rereads it before evaluation or provider work. A sixth eligible row in either store waits for a later execution.

Each candidate retains its source store, review case/decision, preparation version/input guard, record version, state guard, identity, claim token, user action, and persistence result. A stale value rejects that candidate's commit without ending the batch. The workflow rereads the same source store and verifies every committed machine field; a missing, ambiguous, partial, or mismatched write fails closed for that candidate. Provider, validation, Sheet, and stale-write failures are isolated, so later frozen candidates still run.

Before reading the queue, Generator reads all eleven context tabs from the Configuration workbook and freezes one
validated profile/ranking/application snapshot. Context hashes are derived from
the normalized values, so any edit automatically changes provenance. Invalid
context stops the run before queue claims or provider requests. Deterministic
evaluation then uses the full source description and frozen candidate/ranking
policy:

- a good fit continues through the application-pack and message gates;
- a promising gap, required question, or uncertain instruction becomes `review_needed`;
- a hard disqualifier or low fit becomes `skip`;
- missing source content becomes `unavailable`;
- a permanent source HTTP 404/410 becomes `unavailable` and is archived;
- temporary provider, network, or validation failures become retryable `error`, never `skip`.

`Proceed` in `To Review` is a final resolution of the stable `review_case_id`. Alerter & Mover copies the complete row directly to `To Apply` with `review_decision=proceed` and `prep_status=pending`, confirms it, then deletes the unchanged review source. Generator reads both Scraped Jobs and To Apply under one global five-item cap and prepares the proceeded record in place. Candidate-directed non-sensitive questions enter the bounded generation/repair prompts; missing or partial coverage is positively framed from approved proofs without inventing facts. Sensitive commitments become `needs_input`, and attachments, tests, uploads, or other employer actions become `external_steps`. Neither state is treated as an application submission. An unchanged paused input guard is not reselected; a relevant input/version advance permits one new claim. `Reject` moves directly to Archive. Legacy `Approve` and `Deny` are accepted only as migration aliases; a looped v3 Scraped Jobs alias has one guarded copy-confirm-delete exit and cannot be reproduced by a v4 action.

The application domain converts structured employer instructions into a
versioned requirement-coverage contract and a deterministic message plan
before any provider call. Exact evidence is preferred; materially adjacent
evidence records the requested and actual capability and requires review plus
transparent prose. `Proceed` may approve positive framing for partial or
missing non-sensitive coverage, but never the missing fact itself. The plan is
prompt-priority context and survives compaction;
failure to retain all required elements fails closed.

The model path permits one initial `openai/gpt-oss-120b` request per candidate. If deterministic message validation rejects that draft, it permits exactly one delayed `openai/gpt-oss-20b` repair containing the complete rejected draft, every validation error, and only the compact proof/instruction context needed to validate the repaired message. The full job description is not resent. The repaired draft must pass the same pack and message gates; there is no third request or automatic HTTP retry.

A failed retry retains an earlier valid message/provenance but the row remains `error`, so it cannot alert or be marked applied until a fresh validated result becomes ready.

Coverage, the one-element message-plan array, and their explicit versions are
persisted with every generation result and included in the record state guard.
The guard also covers the outbound message and provenance, source description
and availability, instructions, questions, selected proofs, warnings, pack
state, the review-case resolution, and the preparation input/version guard. Queue movement and rediscovery preserve
those system-owned fields. Before a ready message reaches Slack, message safety
recomputes the pack from the current job description, profile, and policies,
requires every persisted authorization field to match, resolves canonical proof
references, and revalidates the message.
Missing, malformed, stale, unresolved, or forged authorization state is
suppressed without changing terminal historical records.

## Alerter & Mover

Alerter & Mover first reads all five business stores through one Google Sheets batch snapshot, normalizes header-only tabs to empty arrays, and plans outcomes, movement, and potential notifications from persisted fields. A canonical identity in an unrelated second store fails closed. The one allowed overlap is a source plus its exact destination after append/confirm succeeded but delete failed; the next run verifies that destination and retries only the deletion. An idle run exits before `_System`, Configuration, writes, sorting, or Slack. Movement completes before alert selection; only movement-touched stores are confirmed and sorted. If `To Apply` was touched it is refreshed once, otherwise the validated initial snapshot is reused. Configuration is loaded only after persisted fields identify notification work.

Each movement and alert first appends a source/destination-scoped `_System` claim; the earliest unexpired sheet row is the only winner. Individual destination, delete, receipt, or Slack failures continue as bounded result items, so one failed branch cannot cancel unrelated work. The configured movement cap applies to the combined, deterministically ordered route set. The instrumented idle, movement/recovery, and full movement-plus-alert read budgets are two, six, and ten Google Sheets API requests respectively. The initial five-store snapshot has one explicit 65-second quota-window retry. Later reads never use n8n's capped five-second automatic retry; they fail closed and defer recovery to the next 15-minute schedule. Provider work requires 150 seconds of remaining execution headroom. Provider telemetry, rather than visual node count, is authoritative during rollout.

Copy-ready eligibility requires a fresh, unacted `ready_to_apply` row with `prep_status=message_ready`, a current pack, and a validated message. `needs_input` and `external_steps` may produce only their distinct bounded reminder category. Receipt identity includes category, preparation version/input guard, policy version, and message or checklist digest, so an unchanged state is not replayed while a guarded later version/category can notify once. An expired `sending` claim and an ambiguous timeout are terminal because delivery may have occurred.

Delivery evidence has a transport-neutral durable contract in an instance-local n8n Data Table, separate from the quota-sensitive Main workbook. One receipt identity equals one alert idempotency key. Atomic create-if-absent and receipt-version compare-and-swap transitions enforce `pending → sending → delivered → reconciled` plus bounded rejection and terminal-ambiguity outcomes. Every write is reread, and duplicate identity rows fail closed. Startup recovery terminalizes expired `sending` evidence and reconciles all definite provider outcomes before new selection. Slack is reachable only after durable `sending`, a matching fresh Sheet claim, render safety, and a fresh headroom gate. Its outcome is persisted before business reconciliation; an unprovable post-send write is terminal ambiguity. Delivered receipts reconcile into the matching key's single current owner across `To Apply`, `Applied Jobs`, and `Archive` without another provider call. The strict column allowlist excludes message, job-description, profile, credential, webhook, authorization, and raw-provider content. The Data Table is part of the n8n durability and backup boundary; delivered rows cannot be pruned before reconciliation.

Slack contains scores, decision reason, gaps, instructions, questions, proofs, warnings, the exact stored message in a code block, and open-only `To Apply`/source links. It contains no action webhook.

Moves are:

| Source | Status/action | Destination | Reason |
| --- | --- | --- | --- |
| Scraped Jobs | autonomous `browser_state=confirmed` | Applied Jobs | `autonomous_confirmed` |
| Scraped Jobs | autonomous decision `skip`, `browser_state=skipped` | Archive | `autonomous_skip` |
| Scraped Jobs | autonomous blocked/retryable/ambiguous/unavailable | none | retain for bounded recovery |
| Scraped Jobs | `review_needed` / blank | To Review | focused review queue |
| Scraped Jobs | `ready_to_apply` / blank | To Apply | focused manual-application queue |
| Scraped Jobs | `skip` / blank | Archive | `automatic_skip` |
| Scraped Jobs | permanent source 404/410 / blank | Archive | `source_unavailable` |
| To Review | `review_needed` / `Proceed` | To Apply | final decision; `prep_status=pending` |
| To Review | `review_needed` / `Reject` | Archive | `review_denied` |
| To Apply | `ready_to_apply` / `I Applied` | Applied Jobs | manual application fact |
| To Apply | `ready_to_apply` / `Skip` | Archive | `user_skip` |

The destination is upserted by canonical identity first, all non-empty planned fields are confirmed, and only the unchanged source row is then deleted. Confirmed deletions are grouped by source sheet and use descending row order. A partial destination is repaired without overwriting destination-owned actions, notes, alert state, outcomes, or the first terminal timestamp. A write failure keeps the source intact. A delete failure is safe to rerun because an existing complete destination becomes confirmation evidence rather than a second append.

## Runtime

All roles use `Asia/Manila`. The two n8n workflows remain inactive in source
control and the browser task remains unscheduled. n8n retains failed/manual
executions and omits successful production payloads/progress.

| Role | Schedule | Timeout | Claim lease |
| --- | ---: | ---: | ---: |
| Scraper | 240 min, offset 8 | 900 s | 1,200 s |
| Browser Executor (scheduled Codex) | 90 min, offset 2 | 480 s | 600 s |
| Alerter & Mover | 15 min, offset 10 | 300 s | 360 s |

The two n8n roles produce 714 scheduled executions per week and have
timeout-weighted demand of 0.3958 execution slots. Production uses a bounded
two-slot n8n limit; a one-week simulation finds a maximum n8n overlap of two.
The browser task contributes 112 separate scheduled opportunities per week.
Its 120-second minimum attempt headroom leaves unfinished due records eligible
for the next run. There is no per-run application quota, daily application cap,
daily counter, or Groq capacity in the active path. Append-winner claims plus
the bounded contention wait and stabilized reread remain the overlap
correctness boundary.
