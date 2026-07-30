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

This single-host launchd profile explicitly configures n8n's task runner in
internal mode. It caps runner concurrency at the same 3-slot production limit,
sets a 300-second Code-task timeout, a 20-second task-offer timeout, and a
15-second heartbeat. The official external task-runner launcher is Linux-only,
so it is not used on this macOS host. After every n8n upgrade, keep schedules
inactive until one disposable scheduled Code workflow completes successfully
four consecutive times, then delete that workflow before activation.

The same policy defines stable structural signatures for all seven pipeline
roles. They are used by the separate, evidence-driven cutover commands:

```bash
npm run capture:cutover -- pre_activation /secure/target-map.json /secure/pre.json
npm run validate:cutover -- /secure/pre.json
npm run capture:cutover -- post_activation /secure/target-map.json /secure/post.json
npm run validate:cutover -- /secure/post.json
```

`capture:cutover` is the only repository validation command in this section
that calls n8n. It performs paginated, read-only Public API GETs when an
operator explicitly supplies `N8N_PUBLIC_API_URL` and `N8N_API_KEY`.
The API identity must have instance-wide workflow-list and execution-list
visibility; project-limited results cannot prove the absence of an older copy.
`validate:cutover`, `validate:deployment`, and default `npm run validate`
remain offline.

## Capacity and overlap

n8n regular mode has no production concurrency limit by default. The template
sets `N8N_CONCURRENCY_PRODUCTION_LIMIT=3`. Summing each workflow's outer
timeout divided by its trigger interval gives a conservative
timeout-weighted average demand of 0.685 execution slots. Average demand does
not prove burst safety, so the validator also expands every fixed local phase
and maximum timeout across a complete week. The checked-in phases peak at two
simultaneous scheduled executions, and the policy requires at least one slot
of scheduled-burst headroom under the limit of 3. Moving every interval phase
to zero would produce five simultaneous starts and is rejected. Excess trigger
executions queue in FIFO order; a five-minute queue wait remains an alert
condition and consumes one-third of the Alerter recovery interval.

Scraper starts at 01:08, Generator at 00:01, Alerter at minute 02 of its
15-minute cycle, Reviewer at minute 13 of its 15-minute cycle, and Archiver at
00:19, all in `Asia/Manila`. Their generated six-field cron rules preserve the
declared 240-, 90-, 15-, 15-, and 45-minute gaps across hour and midnight
boundaries. This avoids interpreting an elapsed interval as a cron step inside
the minute field.

The limit applies to production trigger executions, not manual, sub-workflow,
CLI, or error executions. Do not treat it as provider request concurrency:
nodes within one workflow can still issue several requests. Existing workflow
caps, pacing, provider timeouts, append-only claims, and commit guards remain
the provider and record-safety boundaries.

The task-runner cap is intentionally equal to the production concurrency
limit. The deployment validator rejects a mode change, missing timeouts, a
heartbeat that cannot arrive within the task-offer window, or concurrency
drift between the two controls.

The instance also sets `N8N_HTTP_RESPONSE_BODY_READ_TIMEOUT=20000`. The Google
Sheets transport otherwise inherits n8n's 300-second response-body read
timeout, which can outlive the 90-second Alerter budget before a retry begins.
At 20 seconds per attempt, the checked-in three-attempt/two-backoff policy has
a 70-second maximum read-retry window. The validator rejects any timeout or
retry change whose computed window reaches the shortest workflow timeout.

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

At 1,730 scheduled executions per week, an extreme case where every scheduled
run fails and is retained creates 3,460 records in 14 days. The 10,000-record
cap therefore preserves the complete age window plus 6,540 manual, retry, or
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
sanitized workflow logs and durable Sheet state. Ingest the structured
`operational_backlog`, `generator_result`, and `alert_delivery` events into
the external monitor; successful execution data is intentionally not retained
by n8n. Alert if no `operational_backlog` event arrives for 20 minutes. The
checked-in thresholds also flag:

- a due generation record older than 120 minutes;
- a due deterministic evaluation record older than 120 minutes;
- a pending alert older than 45 minutes;
- a manual action older than 30 minutes;
- any active processing marker beyond its stage lease; or
- three provider rate-limit events within 15 minutes.

The Reviewer emits `operational_backlog` from the Sheet snapshots it already
reads. It reports eligible generation and evaluation counts with their oldest
durable due times, pending-alert count and age, canonical active markers past
their stage-specific lease, and up to 100 deterministic manual-action
fingerprints.
It does not count expired append-only `ProcessingClaims` rows as stuck active
claims. Manual Action cells have no edit timestamp, so the external monitor
must record when each fingerprint is first observed, remove it when absent,
and alert at 30 minutes. A nonzero fingerprint truncation count is immediately
actionable. This avoids logging canonical IDs, action text, job evidence, or
generated messages.

Count `category=rate_limit` only in `generator_result` and `alert_delivery`
events, using their structured `timestamp`, for the 15-minute provider
threshold. Generator events cover final
evaluation/generation results, including failed source-detail and Groq calls;
alert events cover confirmed Slack responses. Both events explicitly carry
`state_commit_pending=true`: they prove the provider attempt/result, not the
later guarded Sheet commit. Reconcile durable status from the next backlog
snapshot or Sheet state. Do not infer event counts from the current Sheet
error category because repeated attempts overwrite that state.

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
The cutover collector follows the official Public API
[workflow inventory](https://docs.n8n.io/api/api-reference/) and
[cursor pagination](https://docs.n8n.io/api/pagination/) contract: workflow
responses expose active state and trigger count, and collection responses must
be followed until `nextCursor` is empty.

## Seven-role workflow cutover

Importing a workflow whose top-level ID is absent creates another n8n workflow
record. Four portable exports have no instance ID, so merely deactivating the
three original Scraper, Generator, and Archiver records cannot exclude an
older active Alerter, Reviewer, Analytics, or Recommender. Claims reduce some
duplicate durable writes, but they do not eliminate duplicate Slack delivery
risk, recurring reads, report attempts, or scheduled-capacity consumption.

The cutover gate treats every workflow whose name contains
`Job Application Pipeline`, or whose nodes match a role signature, as a
pipeline candidate. An unrecognized or multiply matching candidate blocks the
cutover instead of being ignored. Target IDs are instance-specific and live
only in the operator's temporary target map. The validator also requires the
operator to confirm that the API identity can list workflows and executions
instance-wide; cursor completion inside a restricted project is insufficient.

Before activation:

1. Import and rebind the seven target workflows while inactive.
2. Unpublish or deactivate every existing copy of all seven roles.
3. Restart the regular-mode n8n runtime. This is mandatory even if stored
   `active=false` values look correct, because a prior CLI import may not have
   removed schedules cached by the old process.
4. Wait for readiness to recover and record the restart/readiness timestamps.
5. Capture the complete workflow inventory plus complete `new`, `running`, and
   `waiting` execution inventories.
6. Require the pre-activation validator to report that all target and
   non-target pipeline copies are inactive and no pipeline execution remains
   in flight.

After ordered activation, capture the complete workflow inventory again. The
post-activation validator requires exactly one active workflow for each role,
requires it to be the recorded target ID with at least one registered trigger,
and rejects every active non-target copy.

The capture output contains only workflow ID, name, active/archive state,
trigger count, node name/type pairs, and minimal in-flight execution metadata.
It excludes pinned data, node parameters, credential references, execution
payloads, and the API key. Write the target map and evidence outside the
repository with owner-only permissions, do not attach them to tickets, and
delete them under the release-evidence retention policy after recording the
pass result. The collector refuses to overwrite an existing evidence file and
requires HTTPS except for a loopback n8n endpoint.

## Rollout and rollback

Apply the template first in non-production, restart n8n, run the deployment
validator inside the same runtime, and verify readiness plus internally
scraped metrics. Run the four-cycle disposable scheduled Code-node smoke gate.
Create a controlled collision of disabled-copy executions and
confirm FIFO release without a five-minute queue wait. Seed only synthetic
failed executions and verify age/count pruning after the hard-delete buffer.
Before activating the production exports, inspect each generated custom cron
rule in n8n and compare its next three local fire times with the runbook. Then
complete the seven-role pre-activation evidence gate. Repeat the inventory
capture immediately after ordered activation and require the post-activation
gate to pass before ending the maintenance window.

For rollback, preserve the previous environment configuration, stop new
activations, wait for running and queued executions, restore the prior values,
and restart n8n. Never disable pruning or set the count to zero as an emergency
rollback. If the concurrency limit caused queueing, raise it temporarily only
after recording active/waiting counts and confirming database, memory, Google
Sheets, Groq, and Slack capacity.
