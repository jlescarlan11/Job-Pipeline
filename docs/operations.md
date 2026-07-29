# Migration, rollout, and operations runbook

This runbook deliberately separates repository validation from production activation. The checked-in workflows are inactive and this change does not deploy them.

## 1. Preconditions

- Node.js 20 or newer.
- Access to the intended n8n environment, Google Sheet, Google Sheets OAuth credential, Groq credential, and a test/production Slack incoming webhook as appropriate.
- Authority to disable the existing three writers and make a Sheet backup.
- A non-production Sheet copy. If no staging n8n exists, import the workflows disabled and use manual executions against the copy only.

Record the current time, operator, current n8n workflow IDs/versions, Sheet ID, active row count, Archive row count, and current status counts.

## 2. Repository preflight

From a clean checkout:

```bash
npm run build
npm run validate
git diff --check
```

Expected: generated artifacts are unchanged after build and every deterministic test passes. No command calls OnlineJobs.ph, Google Sheets, Groq, or n8n.

Inspect profile/policy changes before continuing:

```bash
git diff -- config/candidate-profile.json config/application-policy.json
```

Confirm the version is current, only approved public contact links are present, and no unsupported skill/project/metric/availability claim was added.

## 3. Backup

Before schema or workflow changes:

1. In Google Sheets, create a timestamped full workbook copy and export an `.xlsx` backup.
2. Export the currently active scraper, generator, and archiver from n8n.
3. Preserve current n8n credential bindings separately; never put secret values in the repository.
4. Record counts for Sheet1, Archive, ProcessingClaims, status,
   applied/skipped decisions, non-empty generated messages, and outcomes.
5. Spot-check at least one legacy pending, ready, applied, skipped, error, and archived row when those categories exist.

Do not continue if either the Sheet or workflow export backup cannot be opened.

## 4. Schema migration on a copy

1. Open the non-production workbook copy.
2. In Extensions → Apps Script, replace the project code with `google-apps-script/SheetSetup.gs`.
3. Run `setupJobPipelineSheets` and approve only the workbook-scoped authorization required by the script.
4. Reopen the Sheet to load the **Job Pipeline** menu.
5. Verify `Sheet1`, `Review Queue`, `Applied Jobs`, `Archive`, `ProcessingClaims`, `Dashboard`,
   `Analytics`, `AnalyticsReports`, `Recommendations`, and
   `RecommendationReports` exist.
6. Verify legacy columns and rows still exist.
7. Compare pre/post counts and representative messages/decisions.

The script must:

- add missing headers without deleting legacy ones;
- format every contract-declared version column as plain text before migration
  writes, repair the confirmed `profile_version` serial `46231` only when the
  row has stable identity and displays `2026-07-28`, and stop for manual review
  on any other non-text version value;
- add the hidden `processing_commit_guard` compare key and clear only the five
  identity/status/token-matched orphaned evaluation claims whose stage and
  start time are blank; preserve unexpired active claims and stop when a
  confirmed target has conflicting state;
- quarantine only the eight stable-identity active ready records that still
  carry `legacy/unknown` provenance and the confirmed obsolete Netlify resume
  URL; remove the active dispatch text, clear pending/sending alert state, keep
  scores/decisions/outcomes unchanged, and route missing-description rows
  through current evaluation before regeneration;
- copy `created_at ` into blank `created_at`;
- populate normalized identity, canonical state, legacy versions, and state guards;
- classify legacy Archive rows as archived while preserving their previous status;
- create or reconcile the exact versioned `Review Queue` headers without
  changing `Sheet1`/`Archive` rows, and stop if the existing queue contains
  unsupported or duplicate headers;
- create or reconcile the exact versioned `Applied Jobs` headers without
  changing existing rows or pending Actions, and stop before rewriting if the
  existing sheet contains unsupported or duplicate headers;
- put review columns first and retain generated fields after them;
- install a strict `manual_action` list and warning-only protection elsewhere;
- expose only the eight friendly queue columns, hide `canonical_job_id` and
  `source_state_guard`, validate the three friendly Action values, and protect
  every derived queue column;
- expose only the eight friendly Applied Jobs columns, hide
  `canonical_job_id` and `source_state_guard`, validate the six friendly
  outcome labels, wrap generated messages, and protect every column except
  Action;
- preserve unrelated conditional-formatting rules.

Stop and restore the workbook copy if row counts change, a ready message/decision disappears, or canonical IDs collide.
Also inspect version cells through a raw-value API or n8n read: displayed date
text alone does not prove that the stored value is a string. Run setup twice
and confirm the second `versionMigration` summary reports no repairs.
Inspect the `processingClaimMigration` result for cleared, preserved-active,
skipped, and conflicting counts. On the copied workbook, verify the five
confirmed terminal records have blank token/stage/start values and that a
second setup run reports zero cleared claims. The setup script must not delete
`ProcessingClaims` history; bounded runtime retention is tested separately
against the workbook copy.
Inspect `legacyMessageMigration` and `archivedLegacyMessageMigration` for
eight unique target identities accounted for as quarantined,
already-quarantined, current-safe, or archived, with no missing identities,
active/archive overlap, duplicates, or conflicts.
Confirm quarantined rows have no active message,
`message_validation_status=quarantined`, `alert_status=not_eligible`, the
stable suppression reason, and no application decision change. A second setup
run must quarantine zero additional rows.
Inspect `applicationInputMigration` and confirm exact legacy zero sentinels in
`apply_points_input` are cleared to blank, valid values remain unchanged, and
no unsupported or concurrently changed value is overwritten. A second setup
run must clear zero additional inputs.

## 5. Disabled import and rebinding

1. Import all seven exports. Confirm each imports inactive:
   - `workflows/scraper.json`
   - `workflows/generator.json`
   - `workflows/alerter.json`
   - `workflows/analytics.json`
   - `workflows/recommender.json`
   - `workflows/reviewer.json`
   - `workflows/archiver.json`
   Confirm both the stored `active=false` value and the running n8n instance's
   active registrations. A CLI import can update the database without
   deregistering schedules already cached by a long-running n8n process. If the
   workflow existed in that process, deactivate it through the supported
   runtime surface or restart n8n, then inspect execution history through at
   least the 15-minute alert cadence before treating it as inactive.
2. Rebind every Google Sheets node to the non-production workbook and test OAuth credential.
3. Rebind the Groq model node to a test credential. Confirm the project permits
   `config/groq-provider-policy.json`'s selected model; a credential alone does
   not prove model permission.
4. Set `JOB_PIPELINE_SLACK_WEBHOOK_URL` to a test Slack incoming webhook and
   `JOB_PIPELINE_REVIEW_URL` to the authorized non-production Sheet's full
   `Review Queue` tab deep link in the n8n runtime. Never paste either value
   into workflow JSON, the Sheet, logs, or test evidence.
5. Confirm no HTTP node targets an application-submit URL.
6. Confirm the configured schedules are 4 hours, 90 minutes, 15 minutes,
   10 minutes, 45 minutes, 24 hours, and 168 hours; generator cap is 1. Confirm
   Analytics is fixed at 02:00 daily and Recommender at 02:45 Mondays in
   `Asia/Manila`, leaving the configured 30-minute timeout plus 15-minute
   completion buffer. Confirm the five interval exports use custom cron rules:
   Scraper 01:08 then every four hours; Generator 00:01 then every 90 minutes;
   Alerter :02/:17/:32/:47; Reviewer :04/:14/:24/:34/:44/:54; and Archiver
   00:19 then every 45 minutes. Inspect at least three next-fire timestamps for
   Generator and Archiver across an hour boundary; do not replace them with a
   `minutesInterval` value.
7. Confirm every export uses `Asia/Manila` and the checked-in workflow timeout:
   Scraper 900-second, Generator 540-second, Alerter 90-second, Reviewer
   180-second, Archiver 540-second, Analytics 1800-second, and Recommender
   900-second. Treat these as outer budgets: preserve the shorter HTTP/provider
   node-level timeout values, and verify timeout recovery from claims, guarded
   commits, idempotent writes, or incomplete report metadata rather than
   assuming an in-flight node is interrupted immediately.
8. Confirm every export saves failed production executions and manual
   executions. Confirm it does not save successful production executions or
   per-node execution progress. Manual smoke executions therefore retain IDs and data;
   scheduled success must be verified from sanitized runtime logs and
   authoritative Sheet state.
9. For self-hosted regular mode, apply
   `config/n8n-deployment-policy.json`, restart n8n, and run
   `npm run validate:deployment` inside that configured runtime. Confirm
   production concurrency is 3; pruning is 336 hours/10,000 executions with a
   1-hour hard-delete buffer; readiness and metrics are internally reachable;
   workflow ID labels are present; and the validator reports a maximum
   scheduled burst of 2 with one slot of headroom. The exports do not activate
   instance-level pruning or concurrency controls. For Cloud or queue mode,
   record the plan/worker controls and create a separately reviewed profile
   rather than claiming this one.
10. Keep the old workflows enabled only in production. They must not write to the non-production copy.

Credential IDs and cached Sheet references in the exports are environment hints inherited from the existing workflows, not portable authorization.

## 6. Dry run and smoke checks

Keep schedules disabled. Manually execute one workflow at a time against the workbook copy.

For CLI-only validation, import a disposable inactive copy whose Schedule
Trigger is replaced by a Manual Trigger; do not edit the checked-in export.
When another n8n process owns the default task-broker port, either stop that
process after preserving its environment or use a separate
`N8N_RUNNERS_BROKER_PORT`. Reconfirm the disposable workflow ID, workbook
binding, credential references, trigger type, and inactive state before every
manual execution.
If the CLI runner blocks `$env` access, scope
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` to that one isolated manual process only;
do not weaken a shared host or print the webhook/review values. The checked-in
Slack HTTP node must remain an explicit JSON `POST`.

### Sheet/reviewer

- Confirm header/control behavior on desktop Google Sheets.
- Verify `Review Queue` visibly contains exactly Status, Job title, Company,
  Score, Reason for review, Generated message, Job link, and Action in that
  order. Confirm its two helper columns are hidden, only Action is intended for
  editing, long reasons/messages wrap, and an empty eligible source retains
  headers and controls without a placeholder row.
- Verify `Applied Jobs` visibly contains exactly Applied at, Job title,
  Company, Generated message, Job link, Current outcome, Outcome updated at,
  and Action in that order. Confirm its two helper columns are hidden, only
  Action is intended for editing, generated messages wrap, and an empty
  applied cohort retains controls without placeholder rows.
- With disposable active and archived applied records, confirm each canonical
  job appears once, active wins during overlap, non-applied records stay out,
  missing optional legacy values remain blank, and ordering is newest
  application first with deterministic identity fallback.
- Exercise No Response, Replied, Interview, Offer, Rejected, and Clear Outcome
  from Applied Jobs. Confirm the matching authoritative source changes, the
  application decision/message/snapshot/notes/version metadata remain intact,
  duplicate current outcomes add no event, blank Clear Outcome adds no event,
  and no-response is recorded only when explicitly chosen.
- Verify queue membership contains `ready`, `recommended`, and
  `review_required`, plus only retryable/terminal records with
  `failed_stage=generation`. Confirm terminal failures from evaluation and
  other stages stay out of the simplified queue, current rows use
  `opportunity_score`, legacy rows fall back to `match_score`, and every
  `review_required` row has a bounded explanation.
- Create one retryable and one terminal generation failure. Confirm the reason
  distinguishes pending/due automatic retry from exhausted attempts, preserves
  a sanitized validation/provider category, displays no rejected message,
  credential, raw URL, stack trace, or provider payload, and stays within the
  configured bound.
- Verify title, company, URL, date, salary, tier, evidence, gaps, status,
  message, and action remain readable in the detailed `Sheet1` review region.
- Use **Job Pipeline → Sort priority queue** and confirm ready/recommended rows order by score, then posting date.
- Enter an unsupported action, a fractional/out-of-range Apply Points value, and
  a malformed strategy identifier; confirm Sheet validation or reviewer
  validation blocks each without changing durable telemetry.
- On disposable rows, verify first/repeated review, promotion,
  ready-to-applied with valid and blank optional inputs, duplicate apply/skip,
  ready-to-skipped, progressive reply/interview/rejection, outcome correction,
  an archived applied outcome, and empty first-use tabs.
- In the same execution that commits a disposable application decision or
  outcome, confirm the Dashboard summary reflects the post-action
  active/archive reread; it must not publish the initial pre-commit counts.
- On disposable queue rows, exercise `Generate Application`, `I Applied`, and
  `Skip`; verify each maps to the expected current `Sheet1` record after source
  row insertion/sorting, consumes the action only after a successful source
  commit, removes applied/skipped rows, and refreshes a promoted row as
  recommended. Confirm the applied row later reaches `Archive` with identity,
  message, decision, timestamps, and application snapshot intact.
- On both generation-failure states, confirm the Action dropdown offers only
  `Generate Application` and `Skip`. Confirm Generate Application resets the
  attempt count and schedules the persisted generation stage, Skip records one
  idempotent decision and removes the row after reconciliation, and a forged
  `I Applied` value produces no source mutation.
- Simulate a stale guard, missing identity, duplicate source identity,
  conflicting duplicate queue actions, and a conflict with a direct `Sheet1`
  action. Confirm no ambiguous source update occurs and the execution log
  contains only sanitized diagnostics.
- Interrupt once before the guarded source commit and once after source commit
  but before queue cleanup. Confirm the first case preserves the pending input,
  the second leaves authoritative `Sheet1` state intact, and the next Reviewer
  run safely reconciles both. Edit a second Action after the Reviewer initial
  queue read and confirm that concurrent input survives the current rebuild.
- Run the Reviewer twice with an unchanged, correctly ordered Review Queue and
  no pending Action. Also ensure Applied Jobs and Dashboard exactly match the
  current sources and ProcessingClaims has no eligible retention batch.
  Confirm the second run reports `review_snapshot_unchanged`, performs exactly
  six Sheet reads, performs no write, appends no projection claim, and does not
  enter the post-review reread or maintenance nodes. In the workbook copy,
  replace one owned queue cell with an equivalent-display formula and confirm
  the next run detects the formula text and rebuilds the projection.
- Separately change only one Dashboard count, add a duplicate current Dashboard
  row, and replace a Dashboard count with a formula. Confirm each case fails
  the idle gate closed. Restore one valid current row, run without metric
  changes, and confirm no Dashboard upsert occurs; `generated_at` is the last
  material summary publication, not a ten-minute health signal.
- Enter one valid action immediately after a completed Reviewer run. Confirm it
  remains intact until the next sweep, is observed within ten minutes, and is
  committed exactly once. Confirm a second concurrent edit still survives the
  compare-and-commit path. The three-minute timeout and four-minute projection
  lease must both end before the next scheduled Reviewer run.
- Repeat those interruption and concurrent-edit checks for Applied Jobs,
  including an archived source commit and an active-to-Archive race. Confirm an
  unconfirmed write retains Action, a confirmed write survives cleanup retry,
  direct Sheet1/Archive input wins conflicts, and Archiver never loses the
  outcome. Confirm Applied Jobs maintenance uses canonical-identity upserts and
  an append-only projection lease, never maps `Action` in a generated cell
  update, and retires a blank stale row only when it still matches its
  identity-specific blank template inside the final atomic batch. Enter an
  Action after the final reread but before that batch and verify the row remains
  visible and is not retired. Sort or move a row during reconciliation and
  verify the selected Action remains attached to its canonical identity. Run two
  overlapping Reviewer copies and verify only the earliest unexpired
  `applied_jobs_projection` claim reaches maintenance.
- For claim-retention smoke testing, use only the backed-up workbook copy.
  First set the copy below the configured 10,000-row threshold and confirm the
  plan logs a no-op with no metadata or batch-update request. Then seed uniquely
  addressed claims on both sides of the 30-day expiry cutoff plus an active
  claim, malformed timestamp, unknown stage, and duplicate `row_number`
  locator. Confirm only old valid rows are selected, no more than 1,000 rows
  are removed, descending ranges target the expected rows, and the committed
  log reconciles the selected count. Interrupt the batch request once; do not
  retry that execution. Rerun from a fresh Sheet read and confirm arbitration
  still selects the same active winner. Confirm eligible cleanup work fails the
  idle gate closed and still runs only after the Reviewer wins the existing
  `applied_jobs_projection` lease.
- Confirm the application snapshot remains unchanged after a permitted
  regeneration/correction path, and that a legacy applied row with blank
  points remains valid.

To roll back only the Reviewer cadence, disable the imported workflow and wait
for running executions, restore `schedule_minutes=5` in
`config/review-sheet.json`, regenerate, import inactive, and repeat the
concurrent-action smoke case. Do not clear `Action`, source guards, claims, or
derived rows: existing and legacy inputs remain compatible and reconcile on
the next run.

### Discovery

- Run one manual discovery execution or temporarily reduce the copy’s query catalog in an uncommitted local export.
- Confirm requests are paced and bounded.
- Record per-query complete/empty/partial/failed counts, unique jobs, active/archive duplicates, malformed cards, seniority exclusions, and discovery-claim losses.
- Run the same fixture/input again and confirm canonical identity prevents a second row.

### Evaluation/generation

- Do not activate the Generator until the opt-in live benchmark in
  `docs/groq-provider-policy.md` passes both official replacement candidates
  and the selected model also passes this disabled n8n smoke. Repository
  validation is offline and is not a substitute for that gate.
- Exercise one direct, adjacent, unscorable, unavailable, and unsupported job.
- Confirm a ready pack makes one initial Groq call and a valid draft becomes
  `ready`.
- With the scheduled Generator disabled, confirm the production project shows
  current limits at least as large as the checked-in 8,000 TPM, 200,000 TPD,
  30 RPM, and 1,000 RPD baseline. In the explicitly authorized smoke, force
  one repair and verify its request starts at least 65 seconds after the
  initial request completes. Reconcile exact provider token measurements
  against the character-estimated planning envelope; do not activate on an
  account with lower limits.
- Confirm `review_required` and `blocked` packs make zero Groq calls, return to
  human review, and retain bounded pack warnings.
- Force one first draft containing Expo, React Native, a banned phrase, more
  than 300 words, and `8:00–11:00 a.m. Pacific Time`. Confirm exactly one repair
  call receives the complete rejected draft plus every validation error, the
  schedule error is human-readable, and the time fragments are not the primary
  numeric errors.
- Confirm a valid repair is committed once under the original processing claim.
  Confirm an invalid or failed repair increments `attempt_count` once, never
  stores the rejected draft, and cannot overwrite a newer manual decision.
- Confirm the description persists after the first fetch.
- Confirm a valid message preserves formatting and records profile version.
- Confirm every quarantined legacy row is evaluated first when its stored
  description is missing, remains ineligible after a fetch/model/validation
  failure, and becomes ready only after current message and pack provenance
  pass the shared gate.
- Force one temporary failure and verify `retryable_error`, stage, count, category, sanitized summary, and `next_retry_at`.
- Force exhaustion/validation failure and verify `terminal_error`.
- Confirm no row becomes applied/skipped without an explicit manual action.

### Alert

- Use a disposable, fresh, high-confidence record at each configured score
  boundary and confirm the committed ready pack immediately becomes `pending`.
- Confirm one Slack alert includes the complete validated application message
  in a dedicated code block, uses `Unknown`/`None detected` labels for absent
  optional data, and exposes only one `Open Review Queue` link plus the
  open-source link outside the code block. Assert the legacy review and
  skip-confirmation labels are absent. Copy the code-block content into a
  plain-text comparison surface and verify the paragraphs, spacing,
  punctuation, Unicode characters, and approved URLs match the stored message.
- In Slack desktop or web, click `Open Review Queue` and confirm the configured
  non-production `JOB_PIPELINE_REVIEW_URL` opens the copied workbook with
  `Review Queue` selected. Forward and reopen the link, then verify
  `pipeline_status`, `manual_action`, `application_decision`, and outcome state
  are unchanged.
- Exercise a near-limit message and confirm optional context is reduced before
  the message or required links. Exercise an over-limit message, an embedded
  code fence, and an unsupported invisible control; confirm each terminalizes
  with sanitized preflight evidence, releases the claim, preserves the ready
  pack, and makes no Slack request.
- Re-run the alerter and confirm the same canonical job/policy version does not
  receive a second initial alert.
- On the copied workbook, retain one prior-policy sent row and one
  prior-policy retryable row at attempt 2 with a future due time. Confirm the
  current Generator/Alerter do not requeue the sent row or move the retry
  earlier, and that the retry terminalizes at attempt 3 if its due provider
  call fails again.
- Force a rate limit or provider `5xx` response and verify bounded backoff,
  sanitized error evidence, and preservation of the application pack. Confirm
  a check at one minute is not yet due and appends no retry claim, the scheduled
  15-minute poll occurs after the 2-minute lease expires, the due retry wins, and
  no rolling chain of losing alert claims remains. Confirm the 90-second
  workflow timeout is shorter than the lease and the cap remains 5.
- Queue 5 new ready alerts immediately after an Alerter run. Confirm the next
  sweep processes all 5 within 15 minutes. Over one 90-minute Generator
  interval, confirm the six Alerter sweeps expose capacity for 30 alerts
  without making generation wait for Slack.
- Test an invalid/missing webhook, an unavailable source, and a stale `sending`
  row. Confirm no provider request for the first two suppression/configuration
  paths and no blind resend for the ambiguous stale delivery.
- Confirm forwarded/tampered review URLs cannot directly mutate a decision and
  repeated skip still requires a valid, explicit reviewer action.

To roll back only the cadence, disable the imported Alerter and wait for
running executions, restore `schedule_minutes=5` in
`config/alert-policy.json`, regenerate, import inactive, and rerun the retry
claim-expiry smoke case. Do not clear pending/retryable timestamps or reset a
`sending` row: existing rows remain compatible, and `sending` is potentially
delivered.

### Analytics

- Hand-calculate a small applied cohort with active/archive overlap,
  multi-query provenance, progressive outcomes, known/unknown Apply Points,
  complete/incomplete packs, and score-band boundary values.
- Confirm the Schedule Trigger is a daily 02:00 `Asia/Manila` rule rather than
  an activation-relative hourly interval.
- Run analytics and compare every overall numerator/denominator, per-ten value,
  point total, time coverage, unknown bucket, non-additive attribution flag,
  and calibration sample size.
- Confirm `Analytics` excludes canonical job IDs, descriptions, generated
  messages, credentials, provider responses, and contact details; test a
  formula-prefixed segment and confirm it is neutralized.
- Interrupt after a subset of detail writes. Confirm the incomplete report has
  no `status=complete` metadata and the previous complete report remains the
  newest authoritative result. Rerun and verify deterministic row upserts.
- Rerun an unchanged copied source at a later time. Confirm the same
  content-addressed report ID is selected, the execution logs
  `action=unchanged`, and neither `Analytics` nor `AnalyticsReports` receives a
  write. Change one outcome and confirm a new result publishes normally.
- Start overlapping manual Analytics runs. Confirm both append
  `analytics_report_store` claims, only the lowest unexpired claim enters the
  report path, and a retry after the 35-minute lease can recover a crashed
  owner.
- In the workbook copy, seed at least 120 valid metadata rows and their exact
  detail groups across the 90-day cutoff. Confirm one cleanup preserves the
  newest 30 complete reports, selects at most 30 expired reports, rereads
  formulas, and removes detail plus metadata in one batch. Repeat with a
  duplicate ID, formula ID, duplicate row address, missing detail row, and
  current report; each ambiguous group must remain. Do not retry a response-
  ambiguous batch; rerun later from fresh rows and reconcile the counts.
- Confirm the workflow performs read-only operations against `Sheet1` and
  `Archive` and does not alter Dashboard, ranking, search, or application data.

### Weekly recommendations

- Seed or reuse a complete copied analytics report whose strong/weak query,
  role, ordered score/confidence, matched-skill, requested-gap, Apply Points,
  instruction, posting-age, salary, and strategy cohorts can be
  hand-calculated.
- Temporarily use a non-production policy copy only if the production minimum
  of 20 applications prevents fixture verification; do not commit or deploy
  lowered thresholds.
- Confirm the Schedule Trigger is Mondays at 02:45 `Asia/Manila`, 15 minutes
  after the daily Analytics timeout deadline. Simulate a failed or overrun
  same-day refresh and confirm the Recommender uses the latest complete report
  and ignores partial detail.
- Run the recommender and verify its 168-hour policy version, required analytics
  versions, all-time window, numerator, denominator, sample, comparison,
  coverage, caveat, and proposed operator action.
- Confirm query/role direction follows reply/interview/offer conversion, not
  discovery volume alone, and non-additive multi-touch caveats are visible.
- Test fewer than 20 applications, a segment below 5 applications, low
  explicit-outcome coverage, low dimension coverage, no applications, an
  incomplete analytics report, and a source/read or detail-write failure.
  Verify explicit abstained, empty, or failed history and no unsupported
  directional result.
- Rerun the same complete fixture at a later time and confirm the SHA-256
  `analysis_key`/successful `run_id` are stable, the execution logs
  `action=unchanged`, and neither recommendation tab receives a write. Change
  the source analytics report and confirm a new successful run publishes.
- Simulate a failed attempt and confirm its execution-scoped run remains
  non-authoritative. Simulate an unavailable RecommendationReports history read
  and confirm the workflow publishes normally instead of suppressing work.
- In `RecommendationReports`, select the newest `status=complete` row, filter
  `Recommendations` to its `run_id`, and confirm a failed/partial later run
  cannot become the current internal report.
- Start overlapping manual Recommender runs and confirm only the lowest
  unexpired `recommendation_report_store` claim enters analysis. In the
  workbook copy, seed at least 80 valid report rows across the 365-day cutoff;
  confirm cleanup keeps the newest 12 complete reports and removes at most 12
  expired exact complete/failed run groups. Every malformed, incomplete,
  recent, or current group must remain.
- Diff or checksum `Sheet1`, `Archive`, `Dashboard`,
  search/ranking/profile/application policies, application decisions, outcomes,
  strategies, and Apply Points before and after. No value may change. One
  append-only coordination claim is expected; it must contain no job,
  application, or recommendation evidence.
- Confirm no weekly notification is expected in this version. Stored report
  validity is independent of alert delivery.

### Archive

- Use disposable applied, skipped, terminal-error, and retryable-error rows.
- Confirm retryable errors and undecided terminal generation failures remain
  active. Confirm a terminal evaluation failure retains normal archival
  behavior, and a skipped generation failure archives once through the
  existing idempotent path.
- Interrupt after Archive upsert or simulate source-delete failure; rerun and confirm one archive identity.
- Change a source row after the plan and confirm deletion is rejected.
- Confirm final deletions are bottom-up and all supported history exists in Archive.

Record workflow execution IDs and before/after Sheet counts. Raw provider responses, full descriptions, resume content, and credentials must not be copied into the evidence log.

## 7. Production activation

Only after dry-run evidence passes:

Before activation, poll `/healthz/readiness` and internally scrape `/metrics`.
Alert after two missed one-minute readiness checks, any unexpected failed
execution in 15 minutes, or a production execution waiting five minutes.
Ingest the structured `operational_backlog`, `generator_result`, and
`alert_delivery` log events and alert if the backlog event is absent for 20
minutes. Reconcile those signals with Sheet state. Alert when the oldest due generation exceeds 120 minutes, a pending alert exceeds 45 minutes, or a
manual action exceeds 30 minutes based on its continuously present
fingerprint. Also alert when any canonical active processing marker exceeds
its stage lease, or three provider events have
`category=rate_limit` within 15 minutes of their structured timestamps. Reset
a manual fingerprint's
first-seen clock only after it disappears; alert immediately if the
fingerprint list reports truncation. Do not treat normal expired
`ProcessingClaims` history as an active marker. These checks are
observational and must not clear state or retry ambiguous delivery.
Provider-result events have `state_commit_pending=true`; use them to count
attempts, never as proof that the following guarded Sheet update committed.

Do not add an instance-specific error-workflow ID to portable exports. If a
central Error Trigger workflow is introduced later, import it first, select it
in all seven workflow settings, sanitize its payload, and smoke-test one
failure per source workflow without provider retries. Saved failed executions
and internal metrics remain authoritative if that notification path also
fails.

1. Schedule a low-activity window.
2. Disable every old scraper/generator/archiver writer and verify no execution remains running.
3. Back up production again.
4. Run the Sheet migration and repeat the count/message/decision checks.
5. Import/rebind the seven new workflows while inactive.
6. Manually execute and verify the reviewer on production data without setting
   actions. Confirm the new queue projection and source/archive/dashboard
   counts before enabling schedules.
7. Verify the sanitized Groq benchmark evidence, current model permission,
   selected model ID, and account-specific rate limits still meet
   `config/groq-provider-policy.json`. A
   `benchmark_required`, forbidden, deprecated, or shutdown selection blocks
   Generator activation.
8. Verify the production Slack/review environment variables without recording
   their values, including that `JOB_PIPELINE_REVIEW_URL` is the full
   `Review Queue` tab deep link, then activate in this order: reviewer, generator, alerter,
   scraper, archiver, analytics, recommender. After activation, re-open both
   learning workflow triggers and verify Analytics remains daily at 02:00 and
   Recommender remains Monday at 02:45 in `Asia/Manila`; activation time must
   not define their relative phase.
9. Wait for and verify one cycle at each cadence from sanitized runtime logs
   and the authoritative Sheet/report state before ending the window.

Never run old and new writers against the same workbook.

## 8. Production verification

Do not invent hiring or conversion targets. Record observed counts and reconcile invariants:

- Discovery: enabled queries, complete/empty/partial/failed/capped queries, pages, unique new jobs, active duplicates, archive duplicates, malformed cards, exclusions, claim winners/losses.
- Discovery pagination: compare `pages_requested` with
  `maximum_page_requests`; confirm exhausted queries do not request later
  pages, capped queries remain partial, and a later-page failure retains the
  earlier successful page counts and jobs.
- Evaluation: selected, enriched from source, reused stored detail, recommended, review-required, not-recommended, unscorable, unavailable.
- Generation: attempted, validated ready, retryable, terminal, claim losers, per-run maximum.
- Alert: queued, eligible, sent, suppressed, retryable, terminal, stale
  `sending`, attempts, provider categories, and time from ready commit to
  confirmed delivery.
- Recovery: failures by stage/category, next retries, attempts at cap, expired claims, non-empty processing stages older than the lease.
- Operational backlog: event freshness, due-generation/pending-alert counts
  and oldest ages, manual-action fingerprint first-seen age and truncation,
  canonical active markers past their stage lease, and rate-limit events from
  Generator/Alerter result logs.
- Claim retention: policy version, rows seen, threshold state, eligible,
  selected, deferred, preserved-by-reason counts, delete ranges, committed
  deletions, and any failed or response-ambiguous batch.
- Review: projected queue rows, protected concurrent actions, queue actions
  applied, invalid/stale/conflicting actions, applied/skipped decisions,
  explicit outcomes, and queue cleanup/appends.
- Archive: new upserts, already archived/reconciled, retained-for-retry, confirmation rejections by reason, confirmed deletes.
- Analytics: latest complete report ID, detail count match, deduplicated
  applications, overlap/conflict counts, unknown/coverage rates, partial
  orphan rows, and refresh duration.
- Recommendations: latest complete run/analysis keys, source analytics report
  and policy versions, result, detail count match, recommendation/abstention
  counts, minimum and observed samples, dimension coverage, partial/failed
  later runs, and refresh duration.
- Report retention: policy/store, claim winners/losses, threshold state,
  cutoff, reports seen/eligible/selected/deferred, preserved-by-reason counts,
  detail/report delete ranges, committed row counts, and any failed or
  response-ambiguous atomic batch.
- Data invariants: one canonical identity across active/archive, no missing historical ready messages/decisions/outcomes, and no automatic applied/skipped transition.

Investigate when a summary is missing, the operational backlog event is more
than 20 minutes old, query coverage unexpectedly drops, a canonical claim
marker remains active beyond its lease, a retryable row archives,
active/archive both contain the same identity beyond one recovery cycle, or
counts cannot be reconciled.

## 9. Rollback

If verification fails:

1. Disable the seven new workflows immediately, beginning with the alerter,
   recommender, and analytics, and wait for running executions to stop. Treat every remaining
   `sending` alert as potentially delivered; do not reset it to `pending`.
2. Export the current migrated Sheet before changing anything; it contains new identities and any decisions/outcomes created after activation.
   If claim cleanup contributed to the failure, disabling the Reviewer stops
   future cleanup. To keep other Reviewer behavior running while retention is
   investigated, set `enabled=false` in `config/claim-retention.json`, rebuild,
   validate, and import the replacement inactive before activation.
   If report cleanup contributed, disable Analytics and Recommender or set
   `enabled=false` in `config/report-retention.json`, rebuild, validate, and
   import both replacements inactive. Store claims still serialize publication;
   no later report cleanup should be attempted until the copied workbook
   reconciles detail and metadata counts.
3. Do not delete new columns, `Review Queue`, or Archive rows. The queue is
   derived and may be left stale while the Reviewer is disabled; never copy it
   back over `Sheet1`.
4. Restore the timestamped workbook copy only if no post-activation records exist. Otherwise reconcile new/changed records by canonical identity into the backup before restoration.
5. Restore the previous n8n exports inactive first.
6. Do not reactivate old writers against the migrated workbook until you verify their legacy `status`/URL mappings cannot overwrite canonical state or reintroduce duplicates/obsolete prompt facts.
7. If old writers must be reactivated, use the reconciled pre-migration workbook and preserve a read-only copy of the migrated workbook.
8. Recheck active/archive counts, ready messages, application decisions, outcomes, and URL deduplication.

The migration is additive, so leaving new columns in place is the preferred rollback. Never roll back by deleting canonical identity, messages, application decisions, outcomes, or Archive history.
Expired claim rows already removed by retention are recoverable only from the
timestamped workbook backup. Do not replace a live workbook merely to restore
those audit rows; preserve the backup as evidence or reconcile with workflows
disabled and verify that every restored claim is expired before any writer is
reactivated.

Expired Analytics or Recommendation report groups already removed by retention
are likewise recoverable only from the timestamped workbook backup. Restoring
them is not required for the current complete view. If audit history must be
restored, keep all learning workflows disabled, restore both metadata and every
matching detail row together, and rerun the exact-count checks before
activation.

Disabling only the recommender stops future weekly reports and leaves
discovery, ranking, application packs, alerts, review, analytics, and archival
operational. Retain `Recommendations` and `RecommendationReports` as
non-authoritative history. Do not implement or activate future automatic
calibration without a separately reviewed approval, migration, rollback plan,
and acceptance criteria.
