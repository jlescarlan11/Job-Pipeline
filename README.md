# Job Pipeline

A resume-driven OnlineJobs.ph discovery and application-review pipeline built with n8n, Google Sheets, and Groq. It discovers direct and credible adjacent roles, evaluates each listing against one versioned candidate profile, generates only evidence-supported application messages, and keeps application submission manual.

All checked-in n8n exports have `active: false`. Importing this repository does not scrape, write to Sheets, call Groq, archive data, or submit an application until an operator explicitly configures and activates the workflows.

## Workflows

| Export | Schedule | Responsibility |
| --- | --- | --- |
| `workflows/scraper.json` | Every 4 hours | Start 22 evidence-linked queries, follow source pagination only while a next page exists up to the 3-page cap, preserve result-card alignment, reconcile active/archive history, and append only the winning discovery claim. |
| `workflows/generator.json` | Every 90 minutes | Select at most 1 eligible job, gate Groq on a ready application pack, validate the first draft, make at most one validation-aware repair call after a 65-second wait, and persist ready, review, retry, or terminal state. |
| `workflows/alerter.json` | Every 15 minutes | Claim newly ready high-opportunity jobs, send one Slack alert with the complete copy-ready message and safe links through an environment-bound webhook, and persist delivery or bounded failure evidence. |
| `workflows/reviewer.json` | Every 10 minutes | Exit after six reads when the complete review snapshot is unchanged, otherwise reconcile Review Queue and Applied Jobs, safely commit guarded decisions/outcomes, and publish a post-action funnel summary only when its metrics change. |
| `workflows/analytics.json` | Every 24 hours | Read deduplicated active/archive state, skip a content-identical complete result, otherwise publish versioned conversion/calibration detail and mark it complete only after all detail rows persist. |
| `workflows/recommender.json` | Every 168 hours | Read the latest complete analytics report, skip an already-current equivalent successful result, otherwise publish guarded evidence-backed recommendations or explicit abstentions, and leave all source behavior unchanged. |
| `workflows/archiver.json` | Every 45 minutes | Upsert eligible terminal records into Archive, reread both tabs, verify the source snapshot and archive copy, then delete confirmed rows from bottom to top. |

The daily Analytics run has a fixed 02:00 start in `Asia/Manila`. The weekly
Recommender starts Mondays at 02:45, after Analytics' 30-minute outer timeout
and a required 15-minute completion buffer. If the daily refresh fails or
overruns, the Recommender remains safe by selecting the latest complete
analytics report rather than partial output.

Every export uses the `Asia/Manila` workflow timezone and an explicit outer
execution budget: Scraper 900-second, Generator 540-second, Alerter 90-second,
Reviewer 180-second, Archiver 540-second, Analytics 1800-second, and
Recommender 900-second. These workflow budgets complement the shorter
provider and HTTP node timeouts; they do not authorize automatic application
submission or unsafe retry.

The same generated settings retain failed production executions and manual
smoke tests, but do not retain successful production executions or per-node
progress snapshots. At the configured cadences this avoids saving payloads for
2,066 normally successful scheduled executions per week; the authoritative
success state remains in Google Sheets.

The Generator's 90-minute cadence and cap of 1 are the checked-in conservative
baseline for the selected model's documented 200,000-token developer-base
daily allowance. Its character-based planning ceiling is 183,056 tokens and
34 requests per day, including one repair for every selected record. The
initial and repair calls are separated by 65 seconds. Exact account limits and
provider token measurements must still pass the live activation gate.

The Alerter's 15-minute recovery sweep runs 96 times per day instead of the
original 480, avoiding 140,160 scheduled executions and idle `Sheet1` reads per
year. This cadence alone saves 70,080 per year relative to the prior
five-minute baseline. Its cap of 5 provides capacity for 30 alerts during each
90-minute Generator interval, versus at most one new Generator output. A new
ready alert, due retry, or stale ambiguous delivery is observed within 15
minutes without binding successful generation to Slack availability.

An exact idle Reviewer snapshot performs six Sheet reads and no writes. Before
the snapshot gate, that same path made at least 14 Sheet/Sheets API requests,
appended one projection claim, and rewrote Dashboard. Each stable run now
avoids at least eight requests, one claim row, and one Dashboard mutation;
actual recurring savings scale with the observed number of stable polls.
Running that fail-closed snapshot every ten rather than five minutes avoids
52,560 executions and 315,360 mandatory Sheet reads per year. Manual actions,
projection changes, and concurrent edits remain durable until the next sweep,
with worst-case observation latency increasing from under five to under ten
minutes.

Learning-report writers are serialized by timeout-covering store claims.
Analytics keeps 90 days of normal history, starts cleanup at 120 report rows,
preserves the newest 30 complete reports, and deletes at most 30 expired
reports per batch. Recommendations keeps 365 days, starts at 80 report rows,
preserves the newest 12 complete reports, and deletes at most 12 expired runs.
Every cleanup fails closed on ambiguous identity, count, or row evidence.

For self-hosted regular-mode n8n, the checked-in deployment template caps
production concurrency at 3, retains a full 14-day all-scheduled-failure
window (336 hours) within 10,000 execution rows, enables internal
health/metrics, and pins
the same execution-data defaults used by every workflow. Run
`npm run validate:deployment` inside the configured runtime before activation;
repository JSON does not claim those instance-level controls are already live.

The workflows share ten Google Sheet tabs:

- `Sheet1`: active discovery, evaluation, generation, and review records.
- `Review Queue`: simplified derived review surface; `Sheet1` remains authoritative.
- `Applied Jobs`: derived outcome-follow-up surface across active and archived applications.
- `Archive`: idempotent terminal history and post-application outcomes.
- `ProcessingClaims`: append-written coordination leases with bounded,
  fail-closed retention of expired history.
- `Dashboard`: one `metric_key=current` funnel row.
- `Analytics`: versioned conversion, efficiency, coverage, and calibration detail rows with bounded historical retention.
- `AnalyticsReports`: complete analytic report identifiers with a guarded rolling history.
- `Recommendations`: versioned advisory evidence, proposed operator actions, and abstentions.
- `RecommendationReports`: bounded complete, empty, abstained, and failed weekly run history.

## Source of truth

- `config/candidate-profile.json`: versioned candidate facts and approved public links.
- `config/application-policy.json`: message style, approved projects/URLs, validation limits, and the manual-submission boundary.
- `config/ranking-policy.json`: versioned dual-score factors, confidence rules, and advisory Apply Points thresholds.
- `config/application-pack-policy.json`: instruction extraction, proof selection, limits, and pack readiness rules.
- `config/alert-policy.json`: versioned Slack eligibility, recovery cadence, retry, message-size, and environment-reference rules.
- `config/groq-provider-policy.json`: approved Groq model lifecycle, request bounds, pricing evidence, and live benchmark gate.
- `config/analytics-policy.json`: versioned cohorts, bands, attribution, timezone, cadence, and report fields.
- `config/recommendation-policy.json`: weekly eligibility, comparison, coverage, version, and output rules.
- `config/report-retention.json`: guarded Analytics and Recommender history bounds, cleanup batches, and store leases.
- `config/n8n-deployment-policy.json`: validated self-hosted regular-mode concurrency, pruning, monitoring, and failure-detection template.
- `config/pipeline-schema.json`: logical fields, states, transitions, and legacy mappings.
- `config/search-plan.json`: evidence-linked query catalog, pagination, pacing, and discovery lease.
- `config/runtime.json`: workflow timezone and execution-data policy plus generator and archiver schedules, timeouts, caps, leases, and retries.
- `config/review-sheet.json`: source review controls, Review Queue and Applied Jobs contracts, actions, views, and dashboard fields.

Do not edit embedded workflow Code or the AI Agent system message directly. Change the relevant source/configuration and regenerate the exports.

## Local validation

Prerequisite: Node.js 20 or newer. The repository has no third-party runtime dependencies.

```bash
npm run build
npm run validate
```

`npm run build` regenerates all workflow JSON and `google-apps-script/SheetSetup.gs`. `npm run validate` fails on generated-artifact drift and runs deterministic profile, schema, discovery, evaluation, message, review, archive, Sheet setup, workflow-structure, and synthetic lifecycle tests. Default validation makes no live OnlineJobs.ph, Google Sheets, Groq, or n8n calls.

## Safe setup

1. Follow `docs/operations.md`; back up the current Sheet and n8n workflows first.
2. On a non-production Sheet copy, attach and run `google-apps-script/SheetSetup.gs`. It adds required tabs/headers including `Review Queue` and `Applied Jobs`, migrates legacy identity and state, retains old columns, orders review fields, and installs controlled actions.
3. Import all seven workflow JSON files into a non-production or disabled n8n context.
4. Replace the exported environment-specific Sheet and credential references with test resources.
5. Run the documented dry-run and smoke checks while every workflow remains disabled.
6. Activate production workflows only in the documented order after the old writers are disabled and verification evidence is recorded.

No workflow applies to jobs. A candidate must copy/review the validated message,
submit it on OnlineJobs.ph, and explicitly choose `I Applied` or `Skip` in
`Review Queue` (or the corresponding legacy action in `Sheet1`). Optional
actual Apply Points and a versioned message-strategy identifier remain
available and validated through the detailed `Sheet1` path; blank values
remain unknown.

## Documentation

- `docs/architecture.md`: data flow, ownership, concurrency, retries, and state model.
- `docs/candidate-profile.md`: profile and application-policy versioning.
- `docs/data-contract.md`: identity, compatibility, migration, and state semantics.
- `docs/ranking.md`: qualification, opportunity, missing-signal, queue, and Apply Points rules.
- `docs/application-pack.md`: structured instructions, approved proofs, warnings, readiness, and retry safety.
- `docs/alerts.md`: eligibility, provider setup, idempotency, safe actions, failure handling, and rollback.
- `docs/analytics.md`: cohort definitions, dimensions, attribution, metrics, coverage, and complete-report publishing.
- `docs/recommendations.md`: weekly eligibility, evidence, abstention, versioning, failure, and no-mutation rules.
- `docs/n8n-deployment.md`: instance-level concurrency, pruning, metrics, alert thresholds, rollout, and rollback.
- `docs/sheet-schema.md`: complete tab, field, action, and view reference.
- `docs/master-prompt.md`: how the generated Groq prompt is assembled and validated.
- `docs/groq-provider-policy.md`: model lifecycle, prompt/request bounds, live benchmark, cost evidence, and rollback.
- `docs/operations.md`: backup, migration, dry run, activation, production checks, and rollback.
- `docs/acceptance-matrix.md`: issue-by-issue acceptance evidence.
- `docs/review-report.md`: final security, data-integrity, and operational-readiness review.
