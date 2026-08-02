# n8n deployment policy

`config/n8n-deployment-policy.json` validates a self-hosted regular-mode n8n instance for exactly three workflow roles:

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
- `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` — Configuration workbook containing Search Keywords and the ten context tabs;
- `JOB_PIPELINE_OLD_SPREADSHEET_ID` — retained old workbook; all three workbook IDs must differ;
- `JOB_PIPELINE_REVIEW_URL` — HTTPS deep link to the production `To Apply` tab (the environment-variable name is retained for deployment compatibility);
- `JOB_PIPELINE_GROQ_API_KEY`;
- `JOB_PIPELINE_SLACK_WEBHOOK_URL`.
- `N8N_RUNNERS_AUTH_TOKEN` — shared n8n/runner secret, stored in macOS Keychain by the managed deployment.

Values are checked but never printed or stored in cutover evidence. Workflow exports contain environment-variable expressions and no credential binding.

## Capacity and retention

The final schedules produce 826 executions per week: 42 Scraper, 112 Generator, and 672 Alerter & Mover. Timeout-weighted demand is 0.4847. The maximum scheduled overlap is two against production concurrency 3.

The 336 hours (fourteen days) of all-failure retention is 1,652 executions, below the 10,000-count pruning cap. Failure and manual execution data are retained; successful production payloads and per-node progress are not. Successful scheduled runs are confirmed through the internal workflow-labelled metrics.

Production uses n8n's external JavaScript task-runner mode. The n8n service and runner are separate `launchd` jobs, both configured with `KeepAlive`; the shared authentication token is read from the `io.codex.job-pipeline.runners-auth-token` Keychain service and is never committed. The runner waits for the local task broker at `127.0.0.1:5679`, obtains a short-lived grant, and reconnects automatically after a service restart.
The deployable startup scripts and LaunchAgent definitions are checked in under `outputs/cutover-20260731/`; install the scripts in `~/Library/Application Support/Job-Pipeline/` and the plists in `~/Library/LaunchAgents/` when rebuilding the host.

Metrics must remain internal, include workflow IDs, and be accompanied by saved failures/log ingestion. Required structured events cover discovery, generator result, movement plan/confirmation, alert selection, and alert delivery.

Run the repository-only calculation with:

```bash
npm run validate:deployment -- --policy-only
```

Run without `--policy-only` inside the actual production environment before activation.

Deployment of a rebuilt Generator is permitted only from the exact reviewed
generated commit after it is present on `main`. Before activation, inventory
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

`capture:n8n`-style evidence is intentionally sanitized to workflow ID, name, active flag, node names, and separately supplied workbook binding. Node parameters, credentials, headers, webhook values, and API keys are never captured.

The cutover gate requires a complete instance-wide inventory; a name-filtered
or partially paginated response is invalid.

Pre-activation evidence requires all replacement and retired copies inactive. Post-activation evidence permits exactly one active replacement for each of the three roles and no active retired signature.

For the requirement-aware Generator, do not pass this gate until the unsent
compatibility inventory has zero unhandled records and disposable verification
has covered the reported structured posting, an exact-evidence control, an
unrelated non-Claude control, adjacent/partial/missing/manual coverage, invalid
initial and repair drafts, provider failures, stale commits, and forged
persisted state. Repository tests are prerequisite evidence, not a substitute
for inactive imported-workflow and disposable-workbook evidence.
