# n8n production deployment policy

`config/n8n-deployment-policy.json` is a checked-in, credential-free template
for a self-hosted n8n instance in regular execution mode. Workflow exports
cannot activate instance-level concurrency, pruning, health, or metrics, so
the template must be applied to the runtime environment and verified with:

```bash
npm run validate:deployment
```

The command compares every required variable without printing its runtime
value. It does not mutate n8n, import workflows, or call any external service.
Cloud and queue-mode deployments must not claim compliance with this profile:
record the Cloud plan limit or create a separately reviewed queue-mode profile.
n8n recommends worker concurrency of at least 5 in queue mode, while the
regular-mode policy here sets the production concurrency limit to 3.

## Capacity and overlap

n8n regular mode has no production concurrency limit by default. The template
sets `N8N_CONCURRENCY_PRODUCTION_LIMIT=3`. Summing each workflow's outer
timeout divided by its trigger interval gives a conservative
timeout-weighted average demand of 0.785 execution slots. Average demand does
not prove burst safety, so the validator also expands every fixed local phase
and maximum timeout across a complete week. The checked-in phases peak at two
simultaneous scheduled executions, and the policy requires at least one slot
of scheduled-burst headroom under the limit of 3. Moving every interval phase
to zero would produce five simultaneous starts and is rejected. Excess trigger
executions queue in FIFO order; a five-minute queue wait remains an alert
condition and consumes one-third of the Alerter recovery interval.

Scraper starts at 01:08, Generator at 00:01, Alerter at minute 02 of its
15-minute cycle, Reviewer at minute 04 of its 10-minute cycle, and Archiver at
00:19, all in `Asia/Manila`. Their generated six-field cron rules preserve the
declared 240-, 90-, 15-, 10-, and 45-minute gaps across hour and midnight
boundaries. This avoids interpreting an elapsed interval as a cron step inside
the minute field.

The limit applies to production trigger executions, not manual, sub-workflow,
CLI, or error executions. Do not treat it as provider request concurrency:
nodes within one workflow can still issue several requests. Existing workflow
caps, pacing, provider timeouts, append-only claims, and commit guards remain
the provider and record-safety boundaries.

## Execution data and pruning

Instance defaults match every export: retain errors and manual smoke runs,
discard successful production payloads, and do not persist per-node progress.
The longest workflow timeout is 1,800 seconds, so both instance timeout bounds
are pinned to 1,800 seconds.

Pruning is explicit rather than inherited from an n8n default:

- `EXECUTIONS_DATA_PRUNE=true`
- `EXECUTIONS_DATA_MAX_AGE=336` (336 hours)
- `EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000`
- `EXECUTIONS_DATA_HARD_DELETE_BUFFER=1` hour

At 2,066 scheduled executions per week, an extreme case where every scheduled
run fails and is retained creates 4,132 records in 14 days. The 10,000-record
cap therefore preserves the complete age window plus 5,868 manual, retry, or
error executions while still bounding database growth. Running or waiting
executions and annotated evidence are subject to n8n's documented pruning
semantics and must be inspected separately.

## Health, metrics, and backlog alerts

The runtime exposes `/healthz/readiness` and enables `/metrics` with workflow
ID labels. The metrics endpoint must be reachable only by the internal
monitoring system; it can disclose operational data. Poll readiness every
minute and alert after two consecutive failures.

Alert on the first unexpected failed execution in 15 minutes or a production
queue wait of five minutes. Reconcile n8n metrics and saved failures with
sanitized workflow logs and durable Sheet state. The checked-in thresholds
also flag:

- a due generation record older than 120 minutes;
- a pending alert older than 45 minutes;
- a manual action older than 30 minutes;
- any active processing marker beyond its stage lease; or
- three provider rate-limit events within 15 minutes.

These alerts observe existing state; they do not retry an ambiguous Slack
delivery, clear a claim, rewrite a row, or authorize an application.

## Central error-workflow decision

The portable exports deliberately do not embed `settings.errorWorkflow`.
n8n's workflow setting selects an instance-assigned workflow, while four of
the seven portable exports have no top-level instance ID. Error executions
also bypass the production concurrency limit, so a failure storm could amplify
an error workflow and its provider side effects.

Failed executions are instead retained and externally alerted through internal
metrics. If an operator later adds a central error workflow, import it first,
select its instance-specific ID in all seven workflow settings, sanitize the
Error Trigger payload, avoid automatic retry of notification side effects,
and smoke-test one failure per workflow. That is a production binding and must
not be claimed from repository JSON alone.

Current behavior and variable names were verified on 2026-07-30 against n8n's
official documentation for [execution variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/executions),
[concurrency](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/control-concurrency),
[execution-data pruning](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data),
[monitoring](https://docs.n8n.io/deploy/host-n8n/keep-n8n-running/monitor-n8n),
[Prometheus metrics](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/enable-prometheus-metrics),
and [error workflows](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully).
Schedule behavior is also checked against the official
[Schedule Trigger documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/).

## Rollout and rollback

Apply the template first in non-production, restart n8n, run the deployment
validator inside the same runtime, and verify readiness plus internally
scraped metrics. Create a controlled collision of disabled-copy executions and
confirm FIFO release without a five-minute queue wait. Seed only synthetic
failed executions and verify age/count pruning after the hard-delete buffer.
Before activating the production exports, inspect each generated custom cron
rule in n8n and compare its next three local fire times with the runbook.

For rollback, preserve the previous environment configuration, stop new
activations, wait for running and queued executions, restore the prior values,
and restart n8n. Never disable pruning or set the count to zero as an emergency
rollback. If the concurrency limit caused queueing, raise it temporarily only
after recording active/waiting counts and confirming database, memory, Google
Sheets, Groq, and Slack capacity.
