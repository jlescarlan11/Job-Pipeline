# Simplified architecture

The replacement contains exactly three scheduled workflows.

```text
OnlineJobs.ph
      |
      v
Scraper (4h, rolling 24h) <----- Search Keywords
      |
      v
Scraped Jobs
      |
      +--> Evaluator & Generator (90m, up to five rows)
      |         |
      |         +--> ready_to_apply ----> To Apply <---- I Applied / Skip
      |         +--> review_needed -----> To Review <--- Approve / Deny
      |         +--> skip --------------> Archive
      |         +--> error / unavailable
      |
      +--> Alerter & Mover (15m)
                |
                +--> Slack (copy/open only)
                +--> Scraped Jobs (approved review)
                +--> Applied Jobs
                +--> Archive
```

## Trust boundaries

The Main workbook has five visible authoritative business stores: `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, and `Archive`. A canonical identity can exist in only one. `Scraped Jobs` owns intake and machine processing, `To Review` owns review decisions, and `To Apply` owns manual-application decisions. `Applied Jobs` and `Archive` are terminal. Alerter & Mover atomically sorts complete business rows in movement-touched stores by their store-specific lifecycle timestamp before rereading those stores and resolving deletion row numbers, so newest records stay directly below each header without weakening copy-confirm-delete. Its hidden `_System` tab contains only expiring append-winner claims used to arbitrate overlapping discovery, generation, movement, and alert work.

The separate Configuration workbook contains the eleven visible operator-owned tabs: `Search Keywords`, `Candidate`, `Skills`, `Experience`, `Projects`, `Education`, `Awards`, `Job Preferences`, `Application Settings`, `Required Style`, and `Banned Phrases`. None is a business-record store. Workflows read these tabs directly from the Configuration workbook; the Main workbook contains no configuration copies or `IMPORTRANGE` bridge.

Google Sheet validation improves usability, but workflow-side contract validation is authoritative. Generated fields use warning-only protection; an API or pasted value is still validated again before any status change, alert, or move.

The retained old workbook is outside the replacement data plane. Its ID, `JOB_PIPELINE_SPREADSHEET_ID`, and `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` must all differ. No generated workflow contains a literal workbook ID, and cutover rejects active old/new overlap.

No workflow submits a job application. The user reviews, copies, and submits the message manually.

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

## Evaluator & Generator

The workflow reads only `Scraped Jobs`, freezes the first five due rows, or every due row when fewer than five exist, and never backfills that batch. It then processes the frozen identities sequentially, one at a time. Each candidate independently appends a scoped `_System` claim, proves that it owns the earliest unexpired claim, writes the `Scraped Jobs` claim, and exactly rereads the persisted claim before evaluation or provider work. The sixth eligible row is untouched until a later execution.

Each candidate retains its own version, state guard, identity, claim token, user action, and persistence result. A stale token, version, state guard, identity, or user action rejects that candidate's commit without ending the loop. The workflow then rereads the saved row and verifies every committed machine field; a missing, ambiguous, partial, or mismatched write fails closed for that candidate. Provider, validation, Sheet, and stale-write failures are isolated, so later frozen candidates still run.

Before reading the queue, Generator reads all ten context tabs from the Configuration workbook and freezes one
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

`Approve` in `To Review` means “return to `Scraped Jobs`, acknowledge allow-listed warnings, and reconsider through normal generation.” The approval timestamp and a bounded snapshot of the reviewer note are retained; the note remains untrusted operator context. Candidate-directed, profile-answerable screening questions are passed to the next initial and repair prompts and must be answered from selected approved proofs. Questions requesting salary, availability, schedules, time zones, start dates, phone details, or work authorization remain visible as manual-submission reminders; external actions do too, while rhetorical headings are ignored. Unsafe employer segments stay excluded from the provider prompt, and approval does not waive proof selection, pack validation, or message validation. A missing or unusable description becomes `unavailable` instead of cycling through review again.

The model path permits one initial `openai/gpt-oss-120b` request per candidate. If deterministic message validation rejects that draft, it permits exactly one delayed `openai/gpt-oss-20b` repair containing the complete rejected draft, every validation error, and only the compact proof/instruction context needed to validate the repaired message. The full job description is not resent. The repaired draft must pass the same pack and message gates; there is no third request or automatic HTTP retry.

A failed retry retains an earlier valid message/provenance but the row remains `error`, so it cannot alert or be marked applied until a fresh validated result becomes ready.

## Alerter & Mover

Alerter & Mover first reads all five business stores through one Google Sheets batch snapshot, normalizes header-only tabs to empty arrays, rejects ambiguous canonical ownership, and plans outcomes, movement, and potential alerts from persisted fields. An idle run exits before `_System`, Configuration, writes, sorting, or Slack. Movement completes before alert selection; only movement-touched stores are confirmed and sorted. If `To Apply` was touched it is refreshed once, otherwise the validated initial snapshot is reused. The same ten-tab Configuration context is loaded through one batch request only after persisted fields identify potential alert work, so invalid Configuration can block alert delivery without cancelling completed movement or outcome work.

Each movement and alert first appends a source/destination-scoped `_System` claim; the earliest unexpired sheet row is the only winner. Individual destination, delete, or Slack failures continue as bounded result items, so one failed branch cannot cancel unrelated work. The configured movement cap applies to the combined, deterministically ordered route set. The instrumented idle and movement-only read budgets are two and six Google Sheets API requests respectively; provider telemetry, rather than visual node count, is authoritative during rollout.

Alert eligibility requires a fresh, unacted `ready_to_apply` row with a current ready pack and validated message. The idempotency key includes canonical identity, policy version, generation timestamp, and message digest. A successful key is never replayed. An expired `sending` claim and an ambiguous timeout are terminal because delivery may have occurred; neither is automatically resent.

Slack contains scores, decision reason, gaps, instructions, questions, proofs, warnings, the exact stored message in a code block, and open-only `To Apply`/source links. It contains no action webhook.

Moves are:

| Source | Status/action | Destination | Reason |
| --- | --- | --- | --- |
| Scraped Jobs | `review_needed` / blank | To Review | focused review queue |
| Scraped Jobs | `ready_to_apply` / blank | To Apply | focused manual-application queue |
| Scraped Jobs | `skip` / blank | Archive | `automatic_skip` |
| Scraped Jobs | permanent source 404/410 / blank | Archive | `source_unavailable` |
| To Review | `review_needed` / `Approve` | Scraped Jobs | gated reconsideration |
| To Review | `review_needed` / `Deny` | Archive | `review_denied` |
| To Apply | `ready_to_apply` / `I Applied` | Applied Jobs | manual application fact |
| To Apply | `ready_to_apply` / `Skip` | Archive | `user_skip` |

The destination is upserted by canonical identity first, all non-empty planned fields are confirmed, and only the unchanged source row is then deleted. Confirmed deletions are grouped by source sheet and use descending row order. A partial destination is repaired without overwriting destination-owned actions, notes, alert state, outcomes, or the first terminal timestamp. A write failure keeps the source intact. A delete failure is safe to rerun because an existing complete destination becomes confirmation evidence rather than a second append.

## Runtime

All workflows use `Asia/Manila`, remain inactive in source control, retain failed/manual executions, and omit successful production payloads/progress.

| Role | Schedule | Timeout | Claim lease |
| --- | ---: | ---: | ---: |
| Scraper | 240 min, offset 8 | 900 s | 1,200 s |
| Evaluator & Generator | 90 min, offset 2 | 480 s | 600 s |
| Alerter & Mover | 15 min, offset 14 | 120 s | 180 s |

The timeout-weighted demand is 0.2847 execution slots. A one-week phase-aware simulation finds a maximum scheduled overlap of two against an instance concurrency limit of three, leaving one slot of burst headroom.

The Generator has 17 conservative daily trigger boundaries and a nominal
capacity of 80 jobs per 24 hours. At five jobs and at most two model requests
per job, the schedule permits at most 170 logical Groq requests across those
boundaries. Twenty-one-second request pacing bounds the all-repair provider
path to 189 seconds. A 20-second post-candidate Sheet pacing interval adds at
most 100 seconds, keeping the combined 289-second pacing ceiling inside the
unchanged 480-second execution timeout.
