# Applied Jobs non-production smoke evidence — 2026-07-29

This is the sanitized release evidence for issue #31. The test used an
isolated copy of the job-pipeline workbook and inactive disposable Reviewer
imports. It did not modify the production workbook, activate a workflow,
submit an application, change an application decision, or expose credentials
or full generated messages in this repository.

## Isolation and setup

- Workbook:
  `Job Applications Pipeline — issue31 Applied Jobs smoke 2026-07-29`.
  Its private Drive ID is retained in the operator context and deliberately
  omitted from this public repository.
- Disposable Reviewer:
  `issue31AppliedJobsSmoke20260729`.
- Disposable concurrent-edit Reviewer:
  `issue31AppliedConcurrentSmoke20260729`.
- Final lease/order/retirement Reviewers:
  `issue31AppliedSortOld2`, `issue31AppliedSortNew`, and
  `issue31AppliedFinalConditional2`.
- Conditional-retirement race Reviewer:
  `issue31AppliedConditionalConcurrent5`, with a smoke-only lease identity and
  a 45-second pause immediately before the unchanged generated cleanup code.
- Both workflow imports used Manual Trigger nodes, were rebound only to the
  isolated workbook, and remained stored as inactive.
- `setupJobPipelineSheets` completed against the copy, then completed a second
  time without changing the compatible Applied Jobs contract or losing
  controls. The resulting tab had one frozen header row, two frozen identity
  columns, exactly the configured eight visible fields, hidden
  `canonical_job_id` and `source_state_guard` helpers, wrapped generated
  messages, protected derived columns, and the exact blank/No Response/
  Replied/Interview/Offer/Rejected/Clear Outcome Action validation.

The setup and workflow artifacts used for the final runs were generated from
the checked-in builders. Production Sheet and workflow resources were not
used.

## Projection and compatibility

The isolated sources included unique active and archived applied records, one
intentional active/Archive overlap, an archived applied legacy record with
blank optional application/message fields, a skipped archive record, and a
ready active record.

Execution `5262` produced these observable results:

- Applied Jobs contained the active overlap record once, the unique archived
  applied record once, and the legacy applied record once.
- The active copy won the overlap; the stale archived copy did not create a
  duplicate.
- Skipped and ready records did not enter Applied Jobs.
- Legacy optional cells remained blank rather than receiving placeholder or
  inferred values.
- Rows were newest-application-first.
- The ready record remained present in Review Queue.

After all applied source records and projection data were cleared, execution
`5314` rebuilt Applied Jobs as headers only. The Action validation, formatting,
protections, and hidden helpers remained, no placeholder row was added, and
the ready Review Queue record remained present.

## Outcome actions and durable state

The archived applied record was exercised through No Response, Replied,
Interview, Offer, Rejected, and Clear Outcome. The final durable event
sequence was:

`no_response`, `replied`, `interview`, `offer`, `rejected`, `correction`.

After Clear Outcome, the compatibility outcome fields were blank and the six
audit events remained. Application decision/time, application snapshot,
generated message, notes, archive timestamp, and version metadata were
unchanged. Blank legacy Apply Points inputs also remained blank.

An active applied record successfully committed Offer through Applied Jobs.
The intentionally overlapping Archive copy remained unchanged, demonstrating
that the active source was authoritative. A later direct Sheet1 Rejected
action conflicted with a pending Applied Jobs Interview action during
execution `5311`; the direct action won, the authoritative source became
Rejected, and the conflicting Applied Jobs action remained visible with a
sanitized diagnostic.

The live sequence exposed one integration defect before the final successful
runs: a generic Google Sheets row update coerced blank optional numeric fields
to zero. Applied Jobs outcome commits were narrowed to the mutable processing
and outcome fields, followed by authoritative rereads. The affected
disposable cells were restored to blank and every action was rerun
through the repaired path as needed; the final durable sequence and preserved
blank fields were then verified. Regression tests now assert the narrow write
contract and preservation of optional and immutable fields.

## Failure, replay, and concurrency

| Execution | Observable result |
| --- | --- |
| `5293` | The Rejected source commit succeeded, then a later Google Sheets read hit a quota error before cleanup. The Action remained available for reconciliation. |
| `5296` | The source remained Rejected, no duplicate rejected event was appended, and the projection reconciled from authoritative state. |
| `5305` | A stale Applied Jobs guard was rejected with a sanitized diagnostic. The source was unchanged and the pending Action remained. |
| `5308` | A 12-second pause separated the initial projection read from later source/surface rereads. An Interview action entered during the pause was absent from the initial read, preserved by final cleanup, and did not mutate the current Offer source. |
| `5311` | A direct Sheet1 action and a conflicting projected action were both present. The direct action committed; the projection action was retained and reported as a conflict. |
| `5414` | The final 86-node Reviewer projected one older archived application into an empty Applied Jobs tab under a winning append-only projection claim. |
| `5417` | A newer archived application was added after the older row. Canonical upsert encountered the existing row, and the final Sheets batch physically sorted the newer application above the older one. |
| `5421` | The exact final disposable Reviewer export ran successfully while inactive after source cleanup, preserving the ready Review Queue record and header-only Applied Jobs state. |
| `5489` / `5491` | A Reviewer using the exact final generated cleanup code captured a blank stale row and paused immediately before cleanup. During the pause, a separate authenticated Sheets write put `Offer` in `Applied Jobs!H2`. The atomic template/deduplication batch completed successfully and retained `Offer` in H2 because the live row no longer matched its blank template. |
| `5494` | After the disposable Action was cleared, the final generated cleanup code inserted its identity-matched blank template, compared all ten cells server-side, retired the unchanged duplicate, removed only its own inserted template row, and returned the tab to headers only. |

The repository's archive-concurrency regression additionally verifies that an
outcome update invalidates a stale Archiver plan, preventing deletion from an
outdated Archive copy and preserving the updated outcome for retry.
Deterministic reconciliation and workflow-structure regressions verify the
final maintenance redesign: row movement and source-guard-only changes cannot
rebase an unchanged action; duplicate projection identity is rejected before
action processing; refresh, rebase, clear, and upsert mutations match canonical
identity and omit Action; one append-only lease winner maintains the
projection; and the final atomic batch protects Action-bearing rows while
retiring only identity-matched rows whose complete live state is still blank,
removes only its own inserted templates, and restores deterministic
application-date/canonical-identity order.

## Final state

- The isolated Applied Jobs tab ended empty with its complete controls intact.
- The isolated ready Review Queue record remained present.
- Disposable smoke workflows remained inactive.
- No production workbook row, production workflow, application decision, or
  external application was changed.
- Full deterministic and generated-artifact validation is recorded with the
  delivery change set.
