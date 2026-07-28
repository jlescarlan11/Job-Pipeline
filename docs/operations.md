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
4. Record counts for Sheet1, Archive, status, applied/skipped decisions, non-empty generated messages, and outcomes.
5. Spot-check at least one legacy pending, ready, applied, skipped, error, and archived row when those categories exist.

Do not continue if either the Sheet or workflow export backup cannot be opened.

## 4. Schema migration on a copy

1. Open the non-production workbook copy.
2. In Extensions → Apps Script, replace the project code with `google-apps-script/SheetSetup.gs`.
3. Run `setupJobPipelineSheets` and approve only the workbook-scoped authorization required by the script.
4. Reopen the Sheet to load the **Job Pipeline** menu.
5. Verify `Sheet1`, `Archive`, `ProcessingClaims`, `Dashboard`, `Analytics`,
   `AnalyticsReports`, `Recommendations`, and `RecommendationReports` exist.
6. Verify legacy columns and rows still exist.
7. Compare pre/post counts and representative messages/decisions.

The script must:

- add missing headers without deleting legacy ones;
- copy `created_at ` into blank `created_at`;
- populate normalized identity, canonical state, legacy versions, and state guards;
- classify legacy Archive rows as archived while preserving their previous status;
- put review columns first and retain generated fields after them;
- install a strict `manual_action` list and warning-only protection elsewhere;
- preserve unrelated conditional-formatting rules.

Stop and restore the workbook copy if row counts change, a ready message/decision disappears, or canonical IDs collide.

## 5. Disabled import and rebinding

1. Import all seven exports. Confirm each imports inactive:
   - `workflows/scraper.json`
   - `workflows/generator.json`
   - `workflows/alerter.json`
   - `workflows/analytics.json`
   - `workflows/recommender.json`
   - `workflows/reviewer.json`
   - `workflows/archiver.json`
2. Rebind every Google Sheets node to the non-production workbook and test OAuth credential.
3. Rebind the Groq model node to a test credential.
4. Set `JOB_PIPELINE_SLACK_WEBHOOK_URL` to a test Slack incoming webhook and
   `JOB_PIPELINE_REVIEW_URL` to the authorized non-production Sheet URL in the
   n8n runtime. Never paste either value into workflow JSON, the Sheet, logs, or
   test evidence.
5. Confirm no HTTP node targets an application-submit URL.
6. Confirm the configured schedules are 4 hours, 15 minutes, 1 minute,
   5 minutes, 45 minutes, 24 hours, and 168 hours; generator cap is 5.
7. Keep the old workflows enabled only in production. They must not write to the non-production copy.

Credential IDs and cached Sheet references in the exports are environment hints inherited from the existing workflows, not portable authorization.

## 6. Dry run and smoke checks

Keep schedules disabled. Manually execute one workflow at a time against the workbook copy.

### Sheet/reviewer

- Confirm header/control behavior on desktop Google Sheets.
- Verify title, company, URL, date, salary, tier, evidence, gaps, status, message, and action are readable in the ordered review region.
- Use **Job Pipeline → Sort priority queue** and confirm ready/recommended rows order by score, then posting date.
- Enter an unsupported action, a fractional/out-of-range Apply Points value, and
  a malformed strategy identifier; confirm Sheet validation or reviewer
  validation blocks each without changing durable telemetry.
- On disposable rows, verify first/repeated review, promotion,
  ready-to-applied with valid and blank optional inputs, duplicate apply/skip,
  ready-to-skipped, progressive reply/interview/rejection, outcome correction,
  an archived applied outcome, and empty first-use tabs.
- Confirm the application snapshot remains unchanged after a permitted
  regeneration/correction path, and that a legacy applied row with blank
  points remains valid.

### Discovery

- Run one manual discovery execution or temporarily reduce the copy’s query catalog in an uncommitted local export.
- Confirm requests are paced and bounded.
- Record per-query complete/empty/partial/failed counts, unique jobs, active/archive duplicates, malformed cards, seniority exclusions, and discovery-claim losses.
- Run the same fixture/input again and confirm canonical identity prevents a second row.

### Evaluation/generation

- Exercise one direct, adjacent, unscorable, unavailable, and unsupported job.
- Confirm only recommended or explicitly promoted rows call Groq.
- Confirm the description persists after the first fetch.
- Confirm a valid message preserves formatting and records profile version.
- Force one temporary failure and verify `retryable_error`, stage, count, category, sanitized summary, and `next_retry_at`.
- Force exhaustion/validation failure and verify `terminal_error`.
- Confirm no row becomes applied/skipped without an explicit manual action.

### Alert

- Use a disposable, fresh, high-confidence record at each configured score
  boundary and confirm the committed ready pack immediately becomes `pending`.
- Confirm one Slack alert includes the configured concise summary, uses
  `Unknown`/`None detected` labels for absent optional data, and exposes only
  review-Sheet, skip-confirmation, and open-source links.
- Re-run the alerter and confirm the same canonical job/policy version does not
  receive a second initial alert.
- Force a rate limit or provider `5xx` response and verify bounded backoff,
  sanitized error evidence, and preservation of the application pack.
- Test an invalid/missing webhook, an unavailable source, and a stale `sending`
  row. Confirm no provider request for the first two suppression/configuration
  paths and no blind resend for the ambiguous stale delivery.
- Confirm forwarded/tampered review URLs cannot directly mutate a decision and
  repeated skip still requires a valid, explicit reviewer action.

### Analytics

- Hand-calculate a small applied cohort with active/archive overlap,
  multi-query provenance, progressive outcomes, known/unknown Apply Points,
  complete/incomplete packs, and score-band boundary values.
- Run analytics and compare every overall numerator/denominator, per-ten value,
  point total, time coverage, unknown bucket, non-additive attribution flag,
  and calibration sample size.
- Confirm `Analytics` excludes canonical job IDs, descriptions, generated
  messages, credentials, provider responses, and contact details; test a
  formula-prefixed segment and confirm it is neutralized.
- Interrupt after a subset of detail writes. Confirm the incomplete report has
  no `status=complete` metadata and the previous complete report remains the
  newest authoritative result. Rerun and verify deterministic row upserts.
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
- Rerun the same execution fixture and confirm recommendation IDs upsert.
  Execute a new attempt and confirm a superseding `run_id` shares the
  `analysis_key` without replacing history.
- In `RecommendationReports`, select the newest `status=complete` row, filter
  `Recommendations` to its `run_id`, and confirm a failed/partial later run
  cannot become the current internal report.
- Diff or checksum `Sheet1`, `Archive`, `Dashboard`, `ProcessingClaims`,
  search/ranking/profile/application policies, application decisions, outcomes,
  strategies, and Apply Points before and after. No value may change.
- Confirm no weekly notification is expected in this version. Stored report
  validity is independent of alert delivery.

### Archive

- Use disposable applied, skipped, terminal-error, and retryable-error rows.
- Confirm retryable error remains active.
- Interrupt after Archive upsert or simulate source-delete failure; rerun and confirm one archive identity.
- Change a source row after the plan and confirm deletion is rejected.
- Confirm final deletions are bottom-up and all supported history exists in Archive.

Record workflow execution IDs and before/after Sheet counts. Raw provider responses, full descriptions, resume content, and credentials must not be copied into the evidence log.

## 7. Production activation

Only after dry-run evidence passes:

1. Schedule a low-activity window.
2. Disable every old scraper/generator/archiver writer and verify no execution remains running.
3. Back up production again.
4. Run the Sheet migration and repeat the count/message/decision checks.
5. Import/rebind the seven new workflows while inactive.
6. Manually execute and verify the reviewer on production data without setting actions.
7. Verify the production Slack/review environment variables without recording
   their values, then activate in this order: reviewer, generator, alerter,
   scraper, archiver, analytics, recommender.
8. Wait for and verify one cycle at each cadence before ending the window.

Never run old and new writers against the same workbook.

## 8. Production verification

Do not invent hiring or conversion targets. Record observed counts and reconcile invariants:

- Discovery: enabled queries, complete/empty/partial/failed/capped queries, pages, unique new jobs, active duplicates, archive duplicates, malformed cards, exclusions, claim winners/losses.
- Evaluation: selected, enriched from source, reused stored detail, recommended, review-required, not-recommended, unscorable, unavailable.
- Generation: attempted, validated ready, retryable, terminal, claim losers, per-run maximum.
- Alert: queued, eligible, sent, suppressed, retryable, terminal, stale
  `sending`, attempts, provider categories, and time from ready commit to
  confirmed delivery.
- Recovery: failures by stage/category, next retries, attempts at cap, expired claims, non-empty processing stages older than the lease.
- Review: actions applied, invalid actions, applied/skipped decisions, explicit outcomes.
- Archive: new upserts, already archived/reconciled, retained-for-retry, confirmation rejections by reason, confirmed deletes.
- Analytics: latest complete report ID, detail count match, deduplicated
  applications, overlap/conflict counts, unknown/coverage rates, partial
  orphan rows, and refresh duration.
- Recommendations: latest complete run/analysis keys, source analytics report
  and policy versions, result, detail count match, recommendation/abstention
  counts, minimum and observed samples, dimension coverage, partial/failed
  later runs, and refresh duration.
- Data invariants: one canonical identity across active/archive, no missing historical ready messages/decisions/outcomes, and no automatic applied/skipped transition.

Investigate when a summary is missing, query coverage unexpectedly drops, a claim remains active beyond its lease, a retryable row archives, active/archive both contain the same identity beyond one recovery cycle, or counts cannot be reconciled.

## 9. Rollback

If verification fails:

1. Disable the seven new workflows immediately, beginning with the alerter,
   recommender, and analytics, and wait for running executions to stop. Treat every remaining
   `sending` alert as potentially delivered; do not reset it to `pending`.
2. Export the current migrated Sheet before changing anything; it contains new identities and any decisions/outcomes created after activation.
3. Do not delete new columns or Archive rows.
4. Restore the timestamped workbook copy only if no post-activation records exist. Otherwise reconcile new/changed records by canonical identity into the backup before restoration.
5. Restore the previous n8n exports inactive first.
6. Do not reactivate old writers against the migrated workbook until you verify their legacy `status`/URL mappings cannot overwrite canonical state or reintroduce duplicates/obsolete prompt facts.
7. If old writers must be reactivated, use the reconciled pre-migration workbook and preserve a read-only copy of the migrated workbook.
8. Recheck active/archive counts, ready messages, application decisions, outcomes, and URL deduplication.

The migration is additive, so leaving new columns in place is the preferred rollback. Never roll back by deleting canonical identity, messages, application decisions, outcomes, or Archive history.

Disabling only the recommender stops future weekly reports and leaves
discovery, ranking, application packs, alerts, review, analytics, and archival
operational. Retain `Recommendations` and `RecommendationReports` as
non-authoritative history. Do not implement or activate future automatic
calibration without a separately reviewed approval, migration, rollback plan,
and acceptance criteria.
