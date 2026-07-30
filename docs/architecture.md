# Simplified architecture

The replacement contains exactly three scheduled workflows.

```text
OnlineJobs.ph
      |
      v
Scraper (4h, rolling 24h)
      |
      v
Review Queue  <----- user actions
      |
      +--> Evaluator & Generator (90m, one row)
      |         |
      |         +--> ready_to_apply
      |         +--> review_needed
      |         +--> skip
      |         +--> error / unavailable
      |
      +--> Alerter & Mover (15m)
                |
                +--> Slack (copy/open only)
                +--> Applied Jobs
                +--> Archive
```

## Trust boundaries

`Review Queue` is authoritative active state. There is no projection owner and no hidden `Sheet1`. `Applied Jobs` and `Archive` are authoritative terminal stores. `_System` contains only expiring append-winner claims used to arbitrate overlapping discovery, movement, and alert work.

Google Sheet validation improves usability, but workflow-side contract validation is authoritative. Generated fields use warning-only protection; an API or pasted value is still validated again before any status change, alert, or move.

The old workbook is outside the replacement data plane. Its ID must differ from `JOB_PIPELINE_SPREADSHEET_ID`, no rows are imported from it, no generated workflow contains its ID, and cutover rejects active old/new overlap.

No workflow submits a job application. The user reviews, copies, and submits the message manually.

## Scraper

At execution start, Scraper freezes:

```text
window_end   = execution reference instant
window_start = window_end - 24 hours
```

Every keyword, page, retry, parser call, and reconciliation receives those exact values. Timestamps at both boundaries are accepted. Older, future, missing, or unparseable timestamps are excluded with categorized evidence.

Search is intentionally plain keyword matching. Pagination is source-exhaustion aware and capped at three pages per keyword; requests are paced, timed out, and retried within configuration. Login, challenge, maintenance, and structurally unrecognized pages never produce jobs.

Canonical source ID and canonical URL are compared across Review Queue, Applied Jobs, and Archive. Multi-keyword results merge into one record. Rediscovery may update keyword provenance and `last_seen_at`, but it cannot reset status, action, message, retry, alert, or reviewer state.

## Evaluator & Generator

The workflow selects one due row, writes a versioned claim, and rereads current state before committing. A stale token, version, state guard, identity, or user action rejects the commit. It then rereads the saved row and verifies every committed machine field; a missing, ambiguous, partial, or mismatched write fails visibly.

Deterministic evaluation uses the full source description and current candidate/ranking policy:

- a good fit continues through the application-pack and message gates;
- a promising gap, required question, or uncertain instruction becomes `review_needed`;
- a hard disqualifier or low fit becomes `skip`;
- missing source content becomes `unavailable`;
- provider, network, or validation failures become `error`, never `skip`.

`Approve` means “reconsider through normal generation.” The approval timestamp and a bounded snapshot of the reviewer note are retained as untrusted operator context. Approval does not waive proof selection, instruction sanitization, pack validation, or message validation. Prompt-injection requests, private-data requests, unsupported claims, unsupported automatic actions, and unresolved application requirements cannot become ready.

The model path permits one initial request. If deterministic message validation rejects that draft, it permits exactly one delayed repair containing the complete rejected draft and validation errors. The repaired draft must pass the same pack and message gates; there is no third request or automatic HTTP retry.

A failed retry retains an earlier valid message/provenance but the row remains `error`, so it cannot alert or be marked applied until a fresh validated result becomes ready.

## Alerter & Mover

Movement finishes before alert selection rereads `Review Queue`. Each movement and alert first appends a scoped `_System` claim; the earliest unexpired sheet row is the only winner. Individual destination, delete, or Slack failures continue as bounded result items, so one failed branch cannot cancel unrelated work.

Alert eligibility requires a fresh, unacted `ready_to_apply` row with a current ready pack and validated message. The idempotency key includes canonical identity, policy version, generation timestamp, and message digest. A successful key is never replayed. An expired `sending` claim and an ambiguous timeout are terminal because delivery may have occurred; neither is automatically resent.

Slack contains scores, decision reason, gaps, instructions, questions, proofs, warnings, the exact stored message in a code block, and open-only Review Queue/source links. It contains no action webhook.

Moves are:

| Source | Action | Destination | Reason |
| --- | --- | --- | --- |
| `ready_to_apply` | `I Applied` | Applied Jobs | manual application fact |
| `ready_to_apply` | `Skip` | Archive | `user_skip` |
| `review_needed` | `Deny` | Archive | `review_denied` |
| `skip` | blank | Archive | `automatic_skip` |

The destination is upserted by canonical identity first, all non-empty planned fields are confirmed, and only the unchanged source row is then deleted. A partial destination is repaired without overwriting destination-owned notes, outcomes, or the first terminal timestamp. A write failure keeps Review Queue intact. A delete failure is safe to rerun because an existing complete destination becomes confirmation evidence rather than a second append.

## Runtime

All workflows use `Asia/Manila`, remain inactive in source control, retain failed/manual executions, and omit successful production payloads/progress.

| Role | Schedule | Timeout | Claim lease |
| --- | ---: | ---: | ---: |
| Scraper | 240 min, offset 8 | 900 s | 1,200 s |
| Evaluator & Generator | 90 min, offset 2 | 480 s | 600 s |
| Alerter & Mover | 15 min, offset 14 | 120 s | 180 s |

The timeout-weighted demand is 0.2847 execution slots. A one-week phase-aware simulation finds a maximum scheduled overlap of two against an instance concurrency limit of three, leaving one slot of burst headroom.
