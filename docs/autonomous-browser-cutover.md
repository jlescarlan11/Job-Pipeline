# Autonomous browser cutover

This repository contains the source contract and readiness validators for the
mixed Job Pipeline runtime. It does **not** activate production: the two n8n
exports are inactive, and `config/browser-executor-task.json` is explicitly
`inactive_unscheduled`.

The target role set is exactly:

- n8n Scraper: discovery and five-store deduplication.
- scheduled Codex browser executor: decision, truthful ChatGPT-written message,
  Chrome fill, submit intent, submission, confirmation, and reconciliation.
- n8n Alerter & Mover: the only business-row relocation owner.

The retired n8n Evaluator & Generator must not be active with the browser
executor. There is no application-per-day cap, daily counter, or date bucket.
Unfinished eligible work continues on a later schedule only because of runtime
headroom, a durable claim/recovery state, Chrome availability, or site state.

## Source gate

Before requesting a maintenance window, run:

```sh
npm run build
npm run check:artifacts
npm run validate:policy
npm run validate
```

The active workflow directory must then contain only `scraper.json` and
`alerter-mover.json`. The build must not register a task, activate a workflow,
open Chrome, or mutate either workbook.

The deployment policy pins the exact two workflow artifacts, browser-task
contract and prompt, executor protocol, skill version, Chrome plugin URI,
schema, application policy, candidate profile, runtime, workbook bindings, and
retired Generator identity. Any mismatch fails the source gate.

## Private migration plan

During an authorized frozen and backed-up maintenance window, capture an exact
private reread with `contract_version`, `captured_at`, `active_claims`, and
exactly the five business stores. Keep the snapshot outside source control and
run:

```sh
npm run plan:autonomous-browser -- /private/path/fresh-snapshot.json \
  > /private/path/migration-plan.json
```

The planner is pure and always reports `writes_allowed: false`. It assigns one
owner and one disposition per supported row, rejects duplicate owners, active
claims, stale state guards, and incompatible records, and never authorizes a
direct move. Every actual business transition must run through Alerter &
Mover's guarded copy-confirm-delete path. A deliberate manual workflow run is
permitted only when the operator asks for it and uses that same guarded path.

## Readiness phases

Sanitized evidence contains only bounded identifiers, timestamps, digests,
counts, state categories, and pass/fail results. Never include messages, job
descriptions, URLs, DOM, screenshots, cookies, credentials, browser history, or
raw provider responses.

Every workflow/task observation includes its exact version and a sanitized
binding digest. Instance inventory must prove zero duplicate roles/tasks and no
active verification copy. The preflight freezes five-store row counts, every
browser-state count, every receipt-state count, ownership/snapshot digests, and
the exact schema/profile/application/pack/skill/protocol compatibility unit.
Migration evidence includes the exact no-write plan
digest and complete classified/route/reject/preservation accounting. Each
controlled case has its own bounded evidence reference, result digest, and
timestamp; booleans alone are not proof. Rollback lists exact compatible prior
asset versions and restore IDs. Post-activation scheduled run IDs must be
nonempty and unique and are accompanied by bounded outcome, confirmation,
duplicate-suppression, claim-recovery, and movement-recovery counts.
The evidence schema is an exact recursive allowlist: unknown debug/private
fields and path- or URL-shaped backup references are rejected.

`pre_activation` is the release gate. It requires:

- readable, restore-identified backups for every policy-listed asset;
- a fresh frozen preflight with zero duplicate owners, active claims, unknown
  partial moves, malformed receipts, unsupported actions, contract drift, or
  wrong bindings;
- exactly two inactive replacement n8n workflows, the retired Generator
  inactive, and exactly one paused browser task;
- the installed Chrome plugin, correct signed-in profile, OnlineJobs.ph
  allowlist, selected local project, explicit `$job-autopilot` invocation, and
  sanitized mock sequence all verified;
- the normal final submission path and independent account-history attestation
  adapter proven unattended, with the adapter private key unavailable to the
  browser task. Missing attestation or a required human confirmation is a
  release blocker and must not be bypassed;
- every required controlled case passed, including durable submit intent,
  ambiguous reconciliation, duplicate suppression, partial-move recovery, and
  legacy disposition;
- exact activation and rollback ordering.

Validate a sanitized evidence document only from the exact clean reviewed
`main` commit:

```sh
npm run validate:autonomous-browser-cutover -- /private/path/pre-activation.json
```

The included `autonomous-browser-cutover-evidence.example.json` is deliberately
an incomplete, non-production shape reference. It is not proof and must not be
edited to pretend that external checks ran.

## Activation order

Only an explicitly authorized operator may perform the live cutover. Resolve
targets by exact IDs and use the policy order:

1. Freeze writers and capture backups.
2. Upgrade workbook structure without moving business rows.
3. Import both n8n roles inactive.
4. Register the browser task paused.
5. Disable the retired Generator and drain claims.
6. Enable Alerter & Mover.
7. Enable Scraper.
8. Enable the browser executor last.

Never permit a Generator/browser mixed-writer window. After activation there
must be exactly one Scraper, one scheduled browser executor, and one Alerter &
Mover. Verification copies remain inactive.

## Observation and rollback

Post-activation evidence requires at least 90 minutes and one normal scheduled
run ID for every active role, zero retired Generator runs, every controlled case
passing, and bounded outcome/recovery counts. Validate it with the same command.

If a rollback trigger occurs, disable in this exact order:

1. Browser executor.
2. Alerter & Mover.
3. Scraper.

Then restore only the recorded compatible prior workflow, policy, schema, task,
workbook, and receipt set. Autonomous states already written under the new
contract may not be understood by the former manual contract, so the
compatibility limits must be reviewed before any restore. Rollback never
authorizes manual row relocation.

## Current release status

Source implementation and validation can be completed without external
mutation. Production acceptance remains blocked until an authorized maintenance
window supplies exact clean-main provenance, private fresh rereads, backups,
Chrome/profile/session/allowlist checks, a provisioned independent attestation
adapter/public key, a real unattended-submit capability proof, registration of
one paused task, guarded legacy draining, ordered
activation, and the full scheduled observation. If final submission requires a
human confirmation, zero-touch production activation remains blocked.
