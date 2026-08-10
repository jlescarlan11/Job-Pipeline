# n8n deployment policy

`config/n8n-deployment-policy.json` policy `2026-08-10/v2` validates a
self-hosted regular-mode n8n instance for exactly three workflow roles:

- Scraper (`scraper`)
- Evaluator & Generator (`evaluator_generator`)
- Alerter & Mover (`alerter_mover`)

The validator rejects missing or duplicate signatures, any active retired workflow, a mixed old/new inventory, wrong workbook binding, insufficient capacity, stale execution counts, disabled pruning, or execution-data settings that retain successful production payloads.

It also pins one application compatibility unit: pipeline/storage schema,
the deterministic pipeline contract digest, candidate profile, application
policy, application-pack policy, pack,
requirement-coverage, and message-plan versions. Policy-only validation fails if
any one of those values drifts. Generator and Alerter & Mover must therefore be
built, reviewed, imported inactive, and rolled back together; activating a new
Generator against an old message-safety consumer is forbidden.

The exports run in `Asia/Manila`: Scraper every 240 minutes with a 900-second timeout, Evaluator & Generator every 90 minutes with a 480-second timeout, and Alerter & Mover every 15 minutes with a 300-second timeout. This deployment policy does not authorize or automate application submission.

Production Alerter & Mover may be started manually when deliberately requested,
but manual and scheduled runs use the same guarded workflow. Business rows must
never be hard-copied, cut/pasted, or otherwise manually relocated between tabs;
all relocation remains copy-confirm-delete-only and is pinned by deployment
policy.

The Generator freezes at most five eligible `Scraped Jobs` rows and processes
them sequentially, with a 20-second post-candidate interval for production
Sheet request capacity. Its conservative 17 daily trigger boundaries yield 80
nominal jobs per day and at most 170 logical Groq requests per day. The initial
and repair requests use separate production models and are validated against
each model's documented and live-observed quota; the five-job all-repair pacing
path remains inside the 480-second timeout.

The Scraper must contain `Get Search Keywords` before `Capture Fixed Window and
Keywords`. It reads the visible `Search Keywords` tab from the Configuration workbook once per execution and
contains no embedded runtime keyword catalog. Missing or invalid configuration
must stop before OnlineJobs.ph requests and workbook writes.

All three exports share the segmented storage contract: Scraper and Generator use `Scraped Jobs`, Alerter & Mover routes review decisions through `To Review`, and ready alerts/actions originate only from `To Apply`. `Applied Jobs` and `Archive` remain terminal stores.

## Required bindings

Instance/runtime values must match the policy exactly. The production-context validator also requires:

- `JOB_PIPELINE_SPREADSHEET_ID` — Main queue workbook containing the five business tabs and hidden `_System`;
- `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` — Configuration workbook containing Search Keywords and the eleven context tabs, including `Prompts`;
- `JOB_PIPELINE_OLD_SPREADSHEET_ID` — retained old workbook; all three workbook IDs must differ;
- `JOB_PIPELINE_REVIEW_URL` — HTTPS deep link to the production `To Apply` tab (the environment-variable name is retained for deployment compatibility);
- `JOB_PIPELINE_GROQ_API_KEY`;
- `JOB_PIPELINE_SLACK_WEBHOOK_URL`.
- `JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID` — durable n8n Data Table for bounded
  Slack delivery receipts;
- `N8N_RUNNERS_AUTH_TOKEN` — shared n8n/runner secret, stored in macOS Keychain by the managed deployment.

Values are checked but never printed or stored in cutover evidence. Workflow exports contain environment-variable expressions and no credential binding.

## Capacity and retention

The final schedules produce 826 executions per week: 42 Scraper, 112 Generator, and 672 Alerter & Mover. Timeout-weighted demand is 0.4847. Production concurrency 2 admits the maximum normal scheduled overlap without queueing. Same-role overlap from sleep/wake catch-up is serialized by append-winner claims followed by a bounded contention wait and stabilized claim reread before any business write.

The 336 hours (fourteen days) of all-failure retention is 1,652 executions, below the 10,000-count pruning cap. Failure and manual execution data are retained; successful production payloads and per-node progress are not. Successful scheduled runs are confirmed through the internal workflow-labelled metrics.

Production uses n8n's external JavaScript task-runner mode. The n8n service and runner are separate `launchd` jobs, both configured with `KeepAlive`; the shared authentication token is read from the `io.codex.job-pipeline.runners-auth-token` Keychain service and is never committed. The runner waits for the local task broker at `127.0.0.1:5679`, obtains a short-lived grant, and reconnects automatically after a service restart.
The deployable startup scripts and LaunchAgent definitions are checked in under `outputs/cutover-20260731/`; install the scripts in `~/Library/Application Support/Job-Pipeline/` and the plists in `~/Library/LaunchAgents/` when rebuilding the host.

Metrics must remain internal, include workflow IDs, and be accompanied by saved failures/log ingestion. Required structured events cover discovery, generator result, movement plan/confirmation, alert selection, and alert delivery.

Run the repository-only calculation with:

```bash
npm run validate:deployment -- --policy-only
```

Run without `--policy-only` inside the actual production environment before activation.

Deployment of the rebuilt compatibility unit is permitted only from the exact
reviewed generated commit after it is present on `main`. Before activation, inventory
every unsent `To Apply` record with the current shared message-safety gate.
Records with missing, malformed, stale, unresolved, or forged coverage/plan
state must be regenerated through guarded lifecycle transitions, returned to
review, or quarantined; direct message or contract edits are forbidden. Update
workflow `TRUqD9atneyDyMNx` in place while it is inactive; preserve its
identity, schedule, timezone, timeout, and workbook binding, and keep it
inactive until the controlled activation gate. Reject any operation that would create a
fourth active pipeline workflow or a duplicate Generator.

The sanitized compatibility inventory may retain canonical identity, record
version, state guard/digest, version values, and bounded reason codes. It must
not retain job descriptions, generated messages, candidate-profile content,
provider responses, credentials, or reviewer notes.

## Cutover inventory

Cutover evidence schema v3 has three phases: `pre_deployment` records the
currently active versions and readable rollback assets; `pre_activation`
records the exact reviewed versions after in-place inactive import and all
disposable gates; `post_activation` records the final 240-minute observation.

Capture stores target workflow ID/name/state and node names, while unrelated
workflow names and node names are replaced by bounded pipeline classifications
and a SHA-256 surface digest. It also stores version/timestamp, schedule,
timeout, timezone, exact credential-free artifact digest, actual per-workflow
environment-binding modes, workbook IDs, and a SHA-256 digest of the common
Google credential reference. Node
parameters, credential IDs/names, headers, webhooks, API keys, job descriptions,
messages, reviewer notes, profile payloads, and provider responses are never
captured. The same Google credential must cover 13 Scraper, 19 Generator, and
35 Alerter Google-capable nodes.

The capture client sends its API key only to the policy-approved loopback n8n
origins and rejects redirects and URL userinfo/query/fragment values. Before
any API read, repository provenance must be clean and `HEAD` must equal both
local `main` and `origin/main`; the target-map commit must equal that exact
commit. Production environment validation also requires the Slack value to use
the official webhook host/path and the review URL to deep-link to the current
Main workbook.

The cutover gate requires a complete instance-wide inventory; a name-filtered
or partially paginated response is invalid.

The policy pins the existing production IDs and credential-free digests for all
three reviewed artifacts. Use `scripts/build-bound-workflow-rollout.mjs` to
build permission-restricted inactive imports under those IDs. Pre-activation
evidence requires all three targets and every detected pipeline-bound or
retired copy inactive. A write-capable Google node with a dynamic unresolved
destination is pipeline-ambiguous unless its unrelated workflow ID is explicitly
approved in policy. The builder rejects credential-bearing repository artifacts,
requires every live Google-capable node to expose the same reference, and copies
only the validated credential `id`, never its display name or other fields.
The pinned live target may be an older compatible graph and is therefore not
required to already contain the replacement's new node names; the builder
still requires its exact production ID and role name, validates every Google
node that actually exists in that live export, and binds only the reviewed
replacement node set.
Post-activation evidence permits exactly one active target for each role and no
active renamed, pipeline-bound, duplicate, or retired signature. Active version
IDs must match the imported reviewed versions, while pre-deployment rollback
versions must match the versions actually active at capture time.

For the requirement-aware Generator, do not pass this gate until the unsent
compatibility inventory has zero unhandled records and disposable verification
has covered the reported structured posting, an exact-evidence control, an
unrelated non-Claude control, adjacent/partial/missing/manual coverage, invalid
initial and repair drafts, provider failures, stale commits, and forged
persisted state. Repository tests are prerequisite evidence, not a substitute
for inactive imported-workflow and disposable-workbook evidence.

Generate the compatibility inventory from a private current `To Apply`
snapshot with `npm run inventory:unsent`; only digests, versions, bounded reason
codes, and guarded dispositions may enter the target map. Schema-v3 validation
also requires exact current Main/Configuration workbook contracts, nine
readable restore-verified backup kinds, sanitized execution IDs for every
required disposable case, one scheduled boundary per role, bounded production
record provenance, and one non-replayed Slack canary whose payload digest equals
the stored-message digest.
