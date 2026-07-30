# Generator commit recovery evidence — 2026-07-30

This record covers GitHub issues #36 and #37. Evidence is intentionally
sanitized: it contains counts, stages, and outcomes, but no workbook URL,
provider payload, generated message, credential, or processing token.

## Safety boundary and backups

- The production Generator and all schedules were unpublished before the
  recovery write.
- A readable active-Generator export, seven role exports, a SQLite backup, a
  full workbook copy, and a separate verification workbook were created before
  cutover.
- The database backup opened successfully and the workbook export retained all
  ten tabs.
- Temporary success-data capture was enabled only on the isolated Generator
  copy. Three exact diagnostic execution payloads were deleted after shape
  inspection; the pre-recovery database backup remains the recovery source.

## Copied-workbook results

| Case | Result |
| --- | --- |
| Evaluation completion | One claimed record committed its new evaluation state, cleared all active ownership fields, and passed the post-write exact-field verifier. |
| Valid generation | The provider returned one initial and one repaired draft. Deterministic validation accepted the repair; one `ready` result with current provenance committed and passed the post-write verifier. |
| Screening question | One record became `review_required` with a persisted question and warning. Neither provider node ran; ownership cleared and the post-write verifier passed. |
| Already current | The rerun stopped after candidate selection. It created no claim and reached no provider or Sheet write node. |
| Zero commit-guard match | The exact generated authorization code failed visibly at the authorization node. |
| Duplicate commit-guard match | The exact generated authorization code failed visibly because the guard was not unique. |
| Stale state guard | The exact generated authorization code rejected the changed snapshot. |
| Changed manual action | The exact generated authorization code rejected the changed snapshot. |
| Changed alert state | The exact generated authorization code rejected the changed snapshot. |

The live copy exposed two additional integration defects that repository-only
tests could not reveal:

1. Embedding a system prompt containing `{{job_title}}` inside an n8n
   expression produced `invalid syntax`. The system prompt is now staged as an
   ephemeral field and referenced by the request.
2. HTTP raw-body mode returned a response stream object instead of parsed
   provider JSON. Both provider nodes now use native JSON-body mode, and the
   copied run observed a one-choice JSON response for each provider call.

## Post-implementation HIGH-risk review

**Lane A — Security and privacy.** Review found that embedding the system
prompt directly inside the n8n expression could expose private job context in
syntax failures, and raw response mode could bypass the expected parsed-JSON
validation boundary. The fix stages the system prompt only in execution memory,
uses native JSON mode, retains credential references without credential values,
and keeps job descriptions, screening questions, generated messages, workbook
references, and provider payloads out of repository evidence. The repository
secret-pattern scan, generated-export secret test, and sanitized-evidence URL
and sensitive-value scan passed after the fix.

**Lane B — Data, state, and operations.** Review found two Sheet round-trip
risks: numeric source identifiers must compare safely with their staged string
form, and a post-write check keyed only by commit guard could miss a duplicate
canonical identity carrying a different guard. The fix normalizes unruled
scalar fields to strings and independently requires one canonical identity and
one commit guard referring to the same row. Regression tests cover both
conditions, strict pre-commit conflicts, exact post-write fields, and cleared
ownership. The copied-workbook, bounded production recovery, Reviewer
projection, final topology, and rollback checks passed after the fixes.

## Production recovery and cutover

| Check | Outcome |
| --- | --- |
| Target revalidation | Exactly one stuck record retained the expected identity, original guard, token, generation stage, blank manual action, and blank alert state; its lease was stale. |
| Bounded Generator recovery | One identity-filtered execution reclaimed the record, routed the screening case without a provider call, committed `review_required`, cleared token/stage/start time, and passed both commit verifiers. |
| Reviewer stale action | A queue Action tied to the old source guard was not applied. After exact revalidation it was cleared as stale. |
| Reviewer convergence | One winning pass retired the stale projection and one fresh winning pass appended exactly one `review_required` row with the new source guard and blank Action. |
| Final topology | Seven production roles are active. Exactly one Generator and one Reviewer are active; old, verification, conflict-harness, and recovery workflows are inactive. |
| Runtime policy | The active Generator has a 90-minute schedule, 540-second timeout, `Asia/Manila` timezone, evaluation/generation caps of one, a 600,000-millisecond claim lease, native JSON provider requests, and both post-write verifiers. |
| Final release parity | The final inactive artifact was imported into the production Generator and published after both review lanes. Active nodes and connections matched the rebuilt artifact, and the published verifier included independent canonical-identity and commit-guard uniqueness checks. |
| Natural Reviewer cycle | Reviewer fired at its configured Manila phase and self-cleaned with no live execution. A later current-guard `I Applied` action was correctly left pending because the source was `review_required`, not `ready`; the source stayed unchanged and exactly one queue row retained the action for correction. |
| Execution state | No non-deleted execution is new, queued, running, or waiting. Historical execution 6494 remains queryable as a successful historical execution. |

Rollback was verified from readable before/after workflow exports and the
disable-first procedure in `docs/operations.md`. The preferred rollback keeps
additive Sheet columns and historical executions, disables the corrected
Generator, republishes the pre-cutover export, and uses the workbook backup
only after an exact range diff.
