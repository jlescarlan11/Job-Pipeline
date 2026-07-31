# n8n deployment policy

`config/n8n-deployment-policy.json` validates a self-hosted regular-mode n8n instance for exactly three workflow roles:

- Scraper (`scraper`)
- Evaluator & Generator (`evaluator_generator`)
- Alerter & Mover (`alerter_mover`)

The validator rejects missing or duplicate signatures, any active retired workflow, a mixed old/new inventory, wrong workbook binding, insufficient capacity, stale execution counts, disabled pruning, or execution-data settings that retain successful production payloads.

The exports run in `Asia/Manila`: Scraper every 240 minutes with a 900-second timeout, Evaluator & Generator every 90 minutes with a 480-second timeout, and Alerter & Mover every 15 minutes with a 120-second timeout. This deployment policy does not authorize or automate application submission.

The Generator freezes at most five eligible Review Queue rows and processes
them sequentially, with a 20-second post-candidate interval for production
Sheet request capacity. Its conservative 17 daily trigger boundaries yield 80
nominal jobs per day and at most 170 logical Groq requests per day. The initial
and repair requests use separate production models and are validated against
each model's documented and live-observed quota; the five-job all-repair pacing
path remains inside the 480-second timeout.

## Required bindings

Instance/runtime values must match the policy exactly. The production-context validator also requires:

- `JOB_PIPELINE_SPREADSHEET_ID` — fresh workbook;
- `JOB_PIPELINE_OLD_SPREADSHEET_ID` — retained old workbook, and it must differ;
- `JOB_PIPELINE_REVIEW_URL` — HTTPS link to the fresh Review Queue;
- `JOB_PIPELINE_GROQ_API_KEY`;
- `JOB_PIPELINE_SLACK_WEBHOOK_URL`.

Values are checked but never printed or stored in cutover evidence. Workflow exports contain environment-variable expressions and no credential binding.

## Capacity and retention

The final schedules produce 826 executions per week: 42 Scraper, 112 Generator, and 672 Alerter & Mover. Timeout-weighted demand is 0.2847. The maximum scheduled overlap is two against production concurrency 3.

The 336 hours (fourteen days) of all-failure retention is 1,652 executions, below the 10,000-count pruning cap. Failure and manual execution data are retained; successful production payloads and per-node progress are not.

Metrics must remain internal, include workflow IDs, and be accompanied by saved failures/log ingestion. Required structured events cover discovery, generator result, movement plan/confirmation, alert selection, and alert delivery.

Run the repository-only calculation with:

```bash
npm run validate:deployment -- --policy-only
```

Run without `--policy-only` inside the actual production environment before activation.

Deployment of a rebuilt Generator is permitted only from the exact generated
commit already present on `main`. Update workflow
`TRUqD9atneyDyMNx` in place, retain its active state, schedule, timezone,
timeout, and workbook binding, and reject any operation that would create a
fourth active pipeline workflow or a duplicate Generator.

## Cutover inventory

`capture:n8n`-style evidence is intentionally sanitized to workflow ID, name, active flag, node names, and separately supplied workbook binding. Node parameters, credentials, headers, webhook values, and API keys are never captured.

The cutover gate requires a complete instance-wide inventory; a name-filtered
or partially paginated response is invalid.

Pre-activation evidence requires all replacement and retired copies inactive. Post-activation evidence permits exactly one active replacement for each of the three roles and no active retired signature.
