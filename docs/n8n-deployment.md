# Mixed runtime deployment policy

`config/n8n-deployment-policy.json` policy `2026-08-10/v5` defines one
compatibility unit across two execution surfaces:

- n8n Scraper (`scraper`);
- a scheduled Codex browser executor (`browser_executor`); and
- n8n Alerter & Mover (`alerter_mover`).

The active n8n build contains exactly the Scraper and Alerter & Mover exports.
The former n8n Evaluator & Generator is retained only as a rollback identity
and must be inactive before the browser executor is activated. The historical
three-workflow `workflow_cutover` policy remains `legacy_only`; it is not the
active release contract.

Source control is inert. Both n8n exports have `active=false`, and the browser
task contract has `source_control_state=inactive_unscheduled`. Building and
validating do not import a workflow, register a scheduled task, open Chrome,
or write to a workbook.

## Compatibility unit

The application compatibility unit is pinned by policy-only validation across
the exact pipeline/storage schema and digest,
candidate profile, ranking, application and application-pack policies, pack, coverage,
message plan, autonomous execution mode, automation contract, executor
protocol, browser skill, task contract, prompt, runtime, and workflow digests.
A partial update fails closed.

The browser protocol bundle covers the CLI plus the complete transitive local
execution graph (`browser-executor`, confirmation verification, contracts,
evaluation, profile, claim arbitration) and the applicable root `AGENTS.md`.
Changing any of those sources invalidates scheduled-task provenance.

The scheduled-task contract additionally requires:

- explicit `job-autopilot` skill invocation;
- the installed Chrome plugin URI `plugin://chrome@openai-bundled`;
- a signed-in Chrome profile and an independent account-history attestation
  adapter whose private key is unavailable to the task;
- an OnlineJobs.ph host allowlist;
- the selected local project root;
- the authoritative Main and Configuration workbook bindings; and
- no generic Sheet writer or business-row relocation operation.

Only Alerter & Mover may relocate a business row, and it does so with guarded
copy-confirm-delete. A deliberate manual workflow execution is allowed only
when the operator requests it and it runs that same guarded path.

## Runtime and capacity

All roles use `Asia/Manila` and staggered schedules:

- Scraper: every 240 minutes, offset 8, timeout 900 seconds;
- browser executor: every 90 minutes, offset 2, timeout 480 seconds; and
- Alerter & Mover: every 15 minutes, offset 10, timeout 300 seconds.

The browser attempt requires 120 seconds of technical headroom. Remaining due
jobs stay eligible for a later scheduled run; the runtime has no application
per-day cap, daily counter, quota date bucket, or daily rejection path. There is
no daily application cap.

n8n itself produces 714 scheduled executions per week: 42 Scraper and 672
Alerter & Mover. Its timeout-weighted demand is 0.3958, and concurrency 2
admits the maximum scheduled n8n overlap. The external browser task produces
112 scheduled opportunities per week and is counted separately. Fourteen days
(336 hours)
of all-failure n8n retention is 1,428 executions, below the 10,000 pruning cap.

Failed and manual n8n executions are retained. Successful production payloads
and per-node progress are not. Internal workflow-labelled metrics and logs must
cover discovery, movement, confirmation, alert selection/delivery, and the
browser task's bounded run/result categories without private content.

## Required environment bindings

The production-context validator requires:

- `JOB_PIPELINE_SPREADSHEET_ID` — Main queue workbook;
- `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` — Configuration workbook;
- `JOB_PIPELINE_OLD_SPREADSHEET_ID` — retained prior workbook;
- `JOB_PIPELINE_REVIEW_URL` — HTTPS deep link to the current Main workbook;
- `JOB_PIPELINE_SLACK_WEBHOOK_URL`;
- `JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID`; and
- `N8N_RUNNERS_AUTH_TOKEN`.

Set `NODE_FUNCTION_ALLOW_BUILTIN=crypto` exactly. The generated Alerter & Mover
uses that single built-in to verify the persisted Ed25519 confirmation receipt
again before copy-confirm-delete; no other external or built-in module is
allowlisted for Code nodes.

The three workbook IDs must differ. Groq is not part of the active deployment,
so `JOB_PIPELINE_GROQ_API_KEY` is neither required nor validated. Values are
checked but never printed or stored in cutover evidence.

Run the repository-only gate with:

```sh
npm run validate:deployment -- --policy-only
```

Run without `--policy-only` only in the deliberately authorized production
environment before activation.

## Build and inactive import

Build and inspect only:

```sh
npm run build
npm run check:artifacts
npm run validate:policy
```

The workflow directory must contain exactly:

- `workflows/scraper.json`
- `workflows/alerter-mover.json`

Import or update both under the exact pinned production IDs while inactive.
Bind the reviewed Google credential reference and environment-backed workbook
expressions; never put workbook IDs or credentials into repository artifacts.
Register exactly one scheduled browser task in a paused state from the pinned
task prompt, skill, protocol, project, and runtime contract. Provision private
durable storage through `JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR`; the executor
must pin the exact store/ledger/generation IDs plus private owner/device/inode
identities for the store and independent witness, prove manifest binding,
hash-chain/count/head recomputation, exact receipt/ledger/witness fsync writes,
and replay/rollback/loss/recreation/permission-drift rejection,
and include the store in backup/restore evidence before activation. Do not
activate anything from the source-build step.

Create a new private click-receipt generation only during the authorized,
frozen maintenance window:

```sh
npm run provision:browser-click-store -- \
  "/absolute/private/runtime/browser-click-v1"
```

The target must not already exist. The command creates a private store,
independent witness, durable manifest/ledger, and a private `binding.json` with
the exact production pins. It never edits the inert checked-in task contract,
never overwrites a generation, and does not activate the scheduled task. Back
up the new generation before activation; never restore or rebind its witness
after loss.

## Live cutover boundary

The production migration is a separate authorized maintenance operation. It
requires clean reviewed `main` provenance, exact private rereads, readable
backups, zero unsafe preflight counts, a deterministic legacy migration plan,
Chrome/profile/session/allowlist checks, provisioned attestation verification
keys, and proof that final submission plus independent confirmation can run
without a human confirmation. If that proof is blocked, zero-touch activation
is blocked; safeguards must not be bypassed.

The Generator is disabled before the browser executor can claim a production
job. Enable Alerter & Mover, then Scraper, then the browser executor. Afterward,
observe at least one normal scheduled cycle for every active role and zero
Generator runs. Rollback disables browser executor, Alerter & Mover, then
Scraper and restores only a recorded compatible unit. It never authorizes
manual row relocation.

See `docs/autonomous-browser-cutover.md` for the evidence schema, capability
gate, activation sequence, observation, privacy boundary, and rollback rules.
