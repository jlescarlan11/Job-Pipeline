# Architecture

## System boundary

Job Pipeline is seven disabled-by-default n8n workflows sharing Google Sheets as durable state. OnlineJobs.ph is read-only. Groq is used only after deterministic evaluation routing. Slack receives concise advisory alerts but cannot mutate application state. The candidate remains the only actor authorized to submit an application or record an application decision.

```text
OnlineJobs.ph search pages
        |
        v
Scraper (4h) -- discovery claims --> ProcessingClaims
        |
        v
Sheet1: discovered jobs
        |
        v
Generator (15m, cap 5) -- evaluation/generation claims --> ProcessingClaims
        |
        v
Sheet1: recommended / review_required / ready / recovery
        |
        +--> Alerter (3m, cap 5) -- alert claims --> ProcessingClaims
        |         |
        |         v
        |      Slack: review / confirm skip in Sheet / open source
        |
        v
Reviewer (5m) <-- explicit manual_action
        |
        +--> Dashboard: current funnel summary
        |
        v
Archiver (45m) -- archive claims --> ProcessingClaims
        |
        v
Archive: terminal history and employer outcomes
        |
        +--> Analytics (24h, read-only source access)
                  |
                  +--> Analytics: versioned detail rows
                  |
                  +--> AnalyticsReports: complete report metadata
                             |
                             v
                  Recommender (168h, read-only source access)
                             |
                             +--> Recommendations: advisory evidence
                             |
                             +--> RecommendationReports: run history
```

Configured schedules are scraper every 4 hours, generator every 15 minutes,
alerter every 3 minutes, reviewer every 5 minutes, archiver every 45 minutes,
analytics every 24 hours, and recommender every 168 hours.

All seven exports run in the explicit `Asia/Manila` workflow timezone. Their
outer execution budgets are Scraper 900-second, Generator 540-second, Alerter
90-second, Reviewer 180-second, Archiver 540-second, Analytics 1800-second,
and Recommender 900-second. Each budget is shorter than its schedule; the
Generator, Reviewer, Alerter, and Archiver budgets are also shorter than the
claims whose ownership they depend on. The n8n workflow timeout is an outer
execution budget, not a promise that every node can be interrupted mid-call:
HTTP/provider nodes retain shorter node-level timeouts, and an
already-running non-abortable node may finish before n8n records the timed-out
execution. Recovery therefore continues to rely on append-only claim expiry,
commit guards, idempotent upserts, and complete-report markers.

## Shared contracts

`config/candidate-profile.json` is the only factual resume source. `config/application-policy.json` is separate so writing preferences cannot become candidate facts. Every evaluation and generated message records the profile version used.

`config/pipeline-schema.json` defines the logical record. `canonical_job_id` is `onlinejobs.ph:<source_job_id>` when OnlineJobs.ph exposes an ID; otherwise it is a deterministic hash of the normalized canonical URL. Mutable Sheet row numbers are transport metadata only.

`state_guard` is a deterministic composite of canonical identity, pipeline status, application decision, and outcome. Generator claim marking matches this guard, so a manual lifecycle update completed before the claim write prevents the stale automation from acquiring the row. Claim marking also writes a hidden `processing_commit_guard` derived from the winning token. Final evaluation, generation, and alert commits match that guard while atomically writing blank `processing_token`, `processing_stage`, and `processing_started_at`. The retained commit guard is not an active claim: a new claim replaces it and a manual lifecycle action clears it, so stale results match zero rows. There is no second canonical-ID cleanup write that could erase a newer claim.

`ProcessingClaims` is append-written. For a canonical job and stage, the
lowest valid Sheet row number wins until its configured lease expires. This
arbitrates concurrent discovery, evaluation, generation, alert, archival, and
Applied Jobs projection executions without treating a mutable active-row
number as identity. The projection winner also performs fail-closed retention:
once 10,000 data rows exist, it can delete at most 1,000 uniquely addressed
claim rows per run only after 30 days beyond expiry. Active/recent, malformed,
unknown-stage, and duplicate-locator rows are preserved. Descending ranges are
sent in one atomic Sheets batch; an uncertain response is not retried against
shifted row numbers.

## Discovery workflow

`config/search-plan.json` defines 22 enabled, evidence-linked queries across full-stack, frontend, backend/API, React/Next.js/TypeScript/Node.js, database, Flutter/mobile, ASP.NET Core/C#, automation/AI integration, production support, and payment integration. Validation rejects duplicate queries and evidence references absent from the profile.

Each scheduled run starts one page for each of 22 queries and follows the
source's next-page signal adaptively, up to 3 pages and 66 requests. Requests
remain globally wave-paced by at least 2 seconds, time out after 15 seconds,
and retry up to 3 times with 5-second waits. A successful earlier page remains
in the query's accumulated state if a later page exhausts its retries. Saved
search pages are parsed as parent cards to keep title, URL, date, description,
badge, and salary aligned. A seven-day cutoff and seniority exclusion remain
configured.

Pagination stops only when the source no longer advertises a next page or the
configured cap is reached. It does not stop merely because every parsed card
was old, excluded, or malformed. Successful pages are retained when another
page/query fails. Coverage records `complete`, `empty`, `partial`, or `failed`
per query, plus actual and maximum page-request counts; reaching the configured
page cap while a next page exists is `partial`, never `complete`.

Discovery reconciliation combines query and role-family provenance, updates `last_seen_at`, and preserves existing evaluation, message, manual decision, and outcome fields. Active and Archive legacy URLs participate in deduplication. Concurrent new rows pass through append-only discovery claims before insertion.

## Evaluation and generation workflow

Eligible records are ordered by generation stage, opportunity score, ranking
confidence, posting time, creation time, and canonical identity, then capped at
5 per execution. A legacy record without an opportunity score falls back to its
unchanged `match_score`; the fallback is a queue value only and does not populate
either new score. Existing application decisions and historical ready messages
are not selected.

Evaluation work uses a stored description when available; otherwise it fetches the detail page once and persists parsed metadata for reuse. Deleted/unavailable pages route to `unavailable`; insufficient content routes to `unscorable`. Deterministic evaluation uses full description evidence, known skills, role family, unsupported requirements, and seniority. It stores score, tier, decision, reasons, gaps, profile version, and timestamp.

`config/ranking-policy.json` versions the dual-score rules. Qualification uses
only canonical-profile skills and configured role-family evidence. Opportunity
combines qualification, posting freshness, reliably parsed PHP-monthly salary,
listing completeness, allowlisted source employer signals, observable
application effort, and sufficiently large historical cohorts. Unknown factors
receive the configured neutral contribution and remain listed as missing; they
are never fabricated. Hard requirements unsupported by profile evidence route
to `not_recommended` and `save_points`; ambiguous requirements route to manual
review when the remaining qualification evidence meets the review threshold.
Requirement classification distinguishes occurrence-local PHP currency
evidence from PHP programming requirements. Explicit any-one-of capability
lists are evaluated once against canonical approved skills; a supported option
satisfies the group, while an unsatisfied group becomes one deterministic gap.
Unmarked lists and unclear wording retain the independent/fail-closed behavior.
Apply Points values are advisory categories only.

Only `recommended` records or explicit supported promotions enter the
generation branch. Before any provider call, the workflow deterministically
builds an instruction-aware pack
using `config/application-pack-policy.json`: safe structured instructions,
screening questions, up to three canonical proof references, and sanitized
warnings. Unsafe prompt-bypass/private-data/automatic-action text is excluded
from both the structured pack and model prompt. Only a `ready` pack reaches
Groq. A `review_required` or `blocked` pack releases the claim, persists its
bounded warnings, and returns to `review_required` without a provider call.

The generated system message is built from a compact canonical identity and
approved-URL block plus application policy. Per-job prompts provide only
selected canonical proofs and non-empty bounded role context; they omit the job
URL. `config/groq-provider-policy.json` selects an artifact-approved,
non-expired model and bounds temperature, output, initial input, and repair
reserve. The message targets at most 260 words below the configured 300-word
hard limit. Post-generation validation rejects empty output, excess length,
unapproved URLs, obsolete projects, unsupported technologies, transformed or
unsupported numeric claims, unapproved schedule/availability/salary/start-date
commitments, phone numbers, completion/submission claims, internal evaluation
labels, banned phrases, and a missing required subject value. An invalid first
draft receives one repair call containing the complete rejected draft and all
deterministic errors. The repair is revalidated under the same profile, policy,
pack, processing claim, and commit guard; it is not a separate pipeline
attempt. The repair reuses the exact original evidence packet and is skipped
with bounded failure evidence when the complete input would exceed the provider
budget. A successful finalization matches the durable
`processing_commit_guard` written at claim acquisition and writes the message,
complete pack, and cleared active-claim fields together. Provider or validation
failure starts from the pre-generation record, preserving the previous valid
pack and message. A validated message preserves line breaks and becomes
`ready` only when its pack is also `ready`; no node submits it.

Persisted dispatchability is independently revalidated against the current
candidate profile, application policy, pack policy, provenance fields, pack
structure, approved URLs, and banned phrases. The same fail-closed decision
guards `mark_applied`, Slack eligibility, and alert rendering. The eight
confirmed unsafe legacy active messages are cleared by stable identity and
evidence, marked `quarantined`, made alert-ineligible, and routed through
evaluation first when their stored description is missing. Failed or partial
replacement work remains non-dispatchable.

The workflow runs every 15 minutes. It makes at most 5 generation selections per run. Detail HTTP calls time out after 15 seconds and retry up to 3 times with 5-second in-node waits, which stay below the 10-minute claim lease. Retryable stage failures record stage, category, sanitized summary, attempt count, and exponential next-retry time starting at 5 minutes. An initial provider failure, an invalid repaired draft, or a repair provider failure increments the execution's attempt once; the third failed attempt or a non-retryable request becomes `terminal_error`.

## Alert workflow

The generator evaluates alert eligibility only after the instruction-aware pack
and message have passed their atomic commit boundary. A ready record meeting
the current persisted-message gate plus the versioned qualification,
opportunity, confidence, freshness, and major-gap thresholds is persisted as
`pending` in the same commit; no reviewer poll is required to enter the
delivery queue.

The alerter claims at most the configured per-run cap through
`ProcessingClaims`, marks a deliverable record `sending`, validates the
environment-bound Slack webhook and authorized HTTPS review URL, and sends a
length-bounded alert. The alert places the complete validated application
message in one copyable Slack code block and keeps one required `Open Review
Queue` link plus the source link outside that block. Optional context uses explicit
`Unknown`/`None detected` labels and includes scores, confidence, employer,
salary, freshness, advisory Apply Points, major gaps, instructions, screening
questions, selected proofs, and warnings when it fits. Context is trimmed or
omitted before the application message or required links. The environment-bound
review URL is the full credential-free Google Sheets deep link for `Review
Queue`; it carries no job identifier, command, or state-changing token. The
source link is open-only. Only the Reviewer can persist promotion, skip, or
application decisions after an explicit in-sheet action.

`canonical_job_id + alert_policy_version` is the idempotency scope. Confirmed
success stores `sent`, timestamp, attempt count, and any non-sensitive provider
reference. The workflow is capped at 90 seconds, below its 2-minute claim
lease. A known transient rejection uses bounded exponential retry beginning at
2 minutes, never before the prior append-only claim expires. The next 3-minute
poll is also after expiry. This prevents polls from appending a rolling chain
of losing claims that can starve the due retry. The cap of 5 matches the
Generator’s maximum output per run and keeps the capped serial
provider-timeout budget inside the workflow timeout. Provider timeouts are
terminal because Slack cannot reconcile an ambiguous delivery. If a `sending`
record outlives its claim lease—covering
delivery followed by a failed acknowledgement commit—it is terminalized as
`ambiguous_delivery` without automatic resend. Missing configuration, invalid
URLs, permanent provider rejection, and source unavailability fail or suppress
visibly without discarding the ready application pack. A message that would
break the Slack code-block boundary, contains unsupported invisible controls,
or cannot fit completely with the required links is terminalized before any
provider request. That deterministic preflight path releases the claim, records
only a sanitized category and summary, and is never treated as ambiguous
delivery.

## Review workflow

`Sheet1` remains the active source of truth. `Review Queue` is a derived,
automatically reconciled review surface containing only Status, Job title,
Company, Score, Reason for review, Generated message, Job link, and Action.
Hidden `canonical_job_id` and `source_state_guard` cells bind each displayed
row to an authoritative source state; row position, title, and visible link
text are never used as update identity. Only Action is intended for editing in
this simplified surface.

The queue contains the configured `ready`, `recommended`, and
`review_required` states plus only retryable or terminal failures from the
generation stage. Current
`opportunity_score` is displayed as Score, with the existing `match_score`
fallback for legacy records. Review reasons are bounded and derived from
persisted warnings, requirement gaps, match evidence, or safe recovery
context. A `review_required` row with no evidence explicitly says that no
reason was recorded. Generation recovery reasons distinguish pending/due
automatic retries from exhausted attempts and sanitize credentials, URLs,
provider details, and formula-like text. Recovery projections never display a
rejected draft.

Friendly queue actions map `Generate Application` to `promote` for normal
review states and to the existing `retry` transition for generation failures.
`Skip` records an explicit decision from either boundary. `I Applied` is
removed from recovery-row dropdowns and remains authoritatively rejected until
a current validated message is `ready`. The Reviewer rereads `Sheet1`,
rejects missing, duplicate, stale, unsupported, or conflicting inputs, and
reuses the same `applyManualAction` transition and message-safety boundary as
the detailed review path. A compare-and-commit sequence first matches
`state_guard`, writes an execution-unique `processing_commit_guard`, and then
commits only the row that still owns that guard. Direct `Sheet1` input wins if
it conflicts with a queue input.

After the source commit, the Reviewer rereads both source and queue. Applied
and skipped rows disappear; a promoted record returns as a fresh recommended
projection while still eligible. If source commit fails, its pending queue
input remains available for retry. If cleanup fails after a source commit,
the next run treats the stale action safely and rebuilds the projection.
Concurrent Action edits made after the initial read are protected from that
run's rebuild. Duplicate delivery cannot create another application snapshot
or decision timestamp.

When every configured Review Queue cell and row order already matches the
canonical projection, reconciliation performs no deletes or appends. Both
queue reads request formula rendering from Google Sheets, so a formula in any
owned cell is compared as formula text rather than as its displayed result and
therefore forces the normal cleanup/rebuild path.

`Applied Jobs` is a second derived operator surface, not a new source of truth.
It projects every authoritative `application_decision=applied` record from
`Sheet1` and `Archive`, preferring the active record during recoverable
active/archive overlap. Its eight visible columns are Applied at, Job title,
Company, Generated message, Job link, Current outcome, Outcome updated at, and
Action. Hidden canonical identity and source-state guards bind the projection
to the source. Missing or duplicate identity fails closed and is logged instead
of showing an ambiguous row.

Friendly follow-up actions map to the existing explicit outcome transitions.
The Reviewer rereads both sources, gives direct `Sheet1`/`Archive`
`manual_action` input precedence, claims the authoritative row by
`state_guard`, and commits by an execution-specific
identity-embedded `processing_commit_guard`. It rereads the claimed source,
requires that guard to occur globally exactly once on the expected identity
with no direct action, and commits by the guard rather than by row position.
It writes only processing/outcome fields for Applied Jobs actions, so blank
optional application fields and immutable decision/snapshot data are not
round-tripped through Google Sheets. Persisted source guards are recomputed;
stale guard data taints the whole identity instead of allowing Archive
fallback. Archive actions use the same
compare-and-commit sequence as active actions. The Reviewer then rereads both
sources and both operator surfaces before reconciling them. Applied Jobs
maintenance never deletes or updates by `row_number`: desired records are
upserted by `canonical_job_id`, and every cell update omits `Action`, so a user
selection made during any workflow step cannot be erased. An append-written
`applied_jobs_projection` claim in `ProcessingClaims` selects one maintenance
winner; the workflow's three-minute timeout is shorter than the four-minute
lease. The winner clears stale generated cells and guards, rereads the sheet,
then submits one Google Sheets `batchUpdate`. For each uniquely identified
blank stale row, the batch inserts an identity-matched blank template,
server-side duplicate removal compares every current cell, and only an
unchanged stale row matches its template. An Action entered after the reread
therefore makes the row non-duplicate and prevents retirement. The templates
remain the first rows in the atomic request, are removed by their known inserted
range, and the survivors are sorted by valid Applied at plus canonical
identity. Case-folded identity uniqueness prevents Sheets' case-insensitive
duplicate comparison from collapsing two templates. This avoids an unguarded
positional delete, keeps late actions visible, and restores a genuinely
header-only empty state. Invalid application
timestamps display blank so the physical Sheets sort matches the deterministic
projection order. Confirmed selections may remain visible and are
idempotent; the user can select a later outcome or blank the cell. A late
changed Action is rebased onto the fresh source guard, while an unchanged stale
Action is never rebased across a direct source update. Missing or duplicate
projection identity fails closed before action processing. The Archiver's own
fresh-snapshot comparison prevents an outcome written during an
active-to-Archive race from being overwritten or deleted.

The detailed `Sheet1` and `Archive` interfaces remain available. Only the
temporary Apply Points/strategy inputs, `manual_action`, and `notes` are
intended for direct editing there. Supported internal actions are:

- `mark_reviewed`
- `promote`, `regenerate`, `retry`
- `mark_applied`, `mark_skipped`
- `outcome_no_response`, `outcome_replied`, `outcome_interview`, `outcome_offer`, `outcome_rejected`, `clear_outcome`

No action means no lifecycle change. `mark_reviewed` and the qualifying manual
review/application actions set the first observable review time once; automated
work and source-link opens do not. `mark_applied` validates optional Apply
Points and a bounded versioned strategy identifier, then freezes the ranking,
recommendation, pack, strategy, and posting-age context. Missing points remain
unknown. Duplicate apply/skip commands preserve the first decision timestamp
and application snapshot.

Unsupported actions, invalid inputs, stale queue rows, or conflicting
transitions are logged in sanitized form and leave the previous durable record
intact. Application
decision and employer outcome are separate from processing/error state.
Distinct outcome milestones and corrections append to `outcome_events`, while
the latest `outcome` remains for backward compatibility. Duplicate current
outcomes are consumed without another event. Outcomes can be updated on
archived applied records without replacing the message, profile/policy
versions, ranking/application snapshot, pack/alert data, notes, identity, or
decision.

The Dashboard upserts one deduplicated current summary and never infers a reply, interview, offer, or rejection from `applied`.

## Analytics workflow

The analytics workflow reads both active and archived records and never mutates
either source. It deduplicates recoverable overlap by canonical identity, uses
the earliest immutable application snapshot when overlap conflicts, unions
cumulative outcome events and multi-touch provenance, and discloses conflicts
as data-quality metrics. Existing Dashboard funnel behavior remains owned by
the reviewer.

`config/analytics-policy.json` versions an all-time cohort, `Asia/Manila` day
boundary, score/salary/posting-age bands, top-ranked threshold, and
multi-touch full-credit attribution. Output includes explicit
numerator/denominator/sample/window rows for overall and dimensional
conversion, per-ten outcomes, time to action, Apply Point efficiency,
instruction/top-rank comparisons, hard-gap non-applications, pack blockers,
coverage, and ordered score calibration. Unknown or malformed values stay in
unknown buckets.

Each distinct aggregate result receives a SHA-256 content-addressed report ID
and deterministic detail IDs. The daily workflow first verifies
`AnalyticsReports`; an exact compatible complete result is logged as unchanged
and performs no analytic writes only when it is already the latest complete
report. Missing, older, partial, incompatible, or malformed metadata cannot
authorize that skip; returning to an older result republishes it as current.
Concurrent or recovered executions with the same result converge on the same
IDs. Only after every expected detail write is observed does the workflow
publish `status=complete` metadata, so a partial refresh cannot replace the
last identifiable complete report. Analytic text is formula-neutralized and
excludes descriptions, messages, credentials, provider payloads, contact
details, and job identifiers.

## Weekly recommendation workflow

The recommender reads only `AnalyticsReports` and `Analytics`. It chooses the
newest valid complete analytics report, verifies the required all-time window
and metric/band versions, and rejects missing or mismatched detail. The source
analytics and every operational tab remain read-only.

`config/recommendation-policy.json` versions the 168-hour schedule, overall and
segment sample minimums, explicit-outcome and per-dimension coverage gates,
comparison delta, ordered score/confidence bands, and output contracts.
Eligible query and role cohorts are assessed on reply/interview/offer
conversion rather than discovery volume alone. Ordered qualification,
opportunity, and confidence cohorts expose possible overconfidence,
underconfidence, or non-monotonicity. Eligible skill, salary, posting-age,
actual/recommended Apply Points, instruction, and message-strategy cohorts
remain observational comparisons. Promising-job missing requirements are
checked against approved profile skills before an investigate-only suggestion
is produced.

The workflow writes evidence rows to `Recommendations` and publishes a
`RecommendationReports` row only after observing every expected detail write.
A successful analysis has a SHA-256 identity derived from its analytics report,
recommendation policy, and profile version; successful overlap converges on
that stable run/detail scope. If an exact compatible result is already the
latest complete report, the weekly execution logs it as unchanged and performs
no recommendation writes. A history-read failure disables only the skip.
Returning to older evidence republishes it as current.

The report keeps numerator, denominator, sample, comparison, window, coverage,
versions, and caveat. Sparse overall input yields a single explicit abstention;
low dimension coverage yields only an abstention for that dimension; zero
applications yields a successful empty report. Source, analysis, or detail
write failures remain attempt-scoped, sanitized, and non-authoritative, so the
latest identifiable complete report remains available.

No branch changes search configuration, ranking rules, profile facts,
strategies, applications, outcomes, or Apply Points. The internal Sheet tabs
are the delivery surface in this version; notification delivery is not an
authoritative dependency.

## Archive workflow

Archival is eligible only for configured `applied`, `skipped`,
`not_recommended`, and `terminal_error` records. `retryable_error` remains
active. An undecided terminal generation failure also remains active for
Review Queue retry or skip; terminal failures from other stages retain normal
archival behavior.

For each winning archive claim:

1. Merge with any existing archive history by canonical identity/legacy URL.
2. Upsert the complete record into Archive by `canonical_job_id`.
3. Reread Archive and Sheet1.
4. Reject deletion if the active row identity changed, any supported source field changed after planning, or the archive copy is missing/stale.
5. Delete confirmed Sheet1 rows in descending row order.

An interrupted run may temporarily leave one copy in both tabs; retry reconciliation treats that as recoverable. It cannot authorize deletion merely because a minimal archive row exists.

## Physical storage and compatibility

Arrays such as query provenance, role families, reasons, and gaps are serialized as JSON strings in Sheets and normalized on read. Blank company, salary, outcome, or profile metadata means unknown, not “Not Given.”

`google-apps-script/SheetSetup.gs` is additive: it creates missing tabs/headers,
including the exact versioned `Review Queue` and `Applied Jobs` contracts, copies legacy
`created_at ` values into `created_at`, populates canonical
identity/state guards and legacy versions, orders human review columns,
applies action validation, and uses warning-only protection for generated
fields. Each derived surface hides its two helper fields, exposes exactly eight
operator fields, and leaves Action as the only unprotected input. Existing
legacy headers remain for rollback compatibility. An existing Review Queue or
Applied Jobs sheet with unsupported or duplicate headers fails setup before it
is rewritten and requires manual reconciliation.

## Operational visibility

Workflow execution logs emit structured summaries for discovery coverage, claim winners/losses, archive planning/reconciliation, and invalid review actions. Durable recovery data lives in `pipeline_status`, `processing_stage`, `attempt_count`, `failed_stage`, `next_retry_at`, `error_category`, and `error_summary`. Logs must remain sanitized: no API keys, authorization headers, raw provider responses, or full resume/job-description payloads.

Workflow JSON contains credential and Sheet references inherited from the existing exports but no secret material. Operators must rebind those references to the intended environment after import.
