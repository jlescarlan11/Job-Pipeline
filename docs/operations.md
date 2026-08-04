# Requirement-aware in-place workflow cutover runbook

This runbook is a gated operator procedure for updating the existing segmented
Main and Configuration workbooks in place. Repository work must not activate
n8n, mutate a production workbook, send a real Slack message, or modify the old
workbook. The exact reviewed commit must first be merged to `main`; an open pull
request is not a deployment commit.

Stop at any failed gate. Never run old and replacement workflows against either workbook at the same time.

Business-row relocation is workflow-owned. Never hard-copy, cut/paste, or
otherwise manually relocate a business row between tabs. Manual execution of
the complete production Alerter & Mover workflow is allowed when deliberately
requested, but it must use the same guarded copy-confirm-delete path as a
scheduled run. Diagnose and repair the source condition and preserve a backup;
then let Alerter & Mover perform and verify relocation. A proven stale duplicate
may be removed during a frozen, backed-up repair window; that exception removes
the invalid copy and does not manually relocate the valid record. Deployment
policy requires the generated workflow to declare copy-confirm-delete-only
business relocation.

Runtime baseline: all three exports use `Asia/Manila`. Scraper runs every 240
minutes with a 900-second timeout; Evaluator & Generator runs every 90 minutes
with a 480-second timeout; Alerter & Mover runs every 15 minutes with a
300-second timeout. Each Generator execution freezes at most five eligible
rows and processes them sequentially without backfill, waiting 20 seconds
after every handled candidate to stay within production Sheet request
capacity.

## 1. Freeze and back up the current compatibility unit

Before creating or activating anything:

1. Record the current Main, Configuration, and retained old workbook IDs and
   prove all three differ.
2. Export the three pinned production workflows and every duplicate/inactive
   pipeline copy. Record each target workflow ID and exact pre-deployment
   version ID.
3. Back up the Main workbook, Configuration workbook, retained old workbook,
   n8n database, alert receipt store, and runtime/launcher configuration in the
   approved encrypted location.
4. Verify every backup is readable and perform the documented isolated restore
   check before any import. Record an opaque reference and SHA-256 digest, not a
   local path containing private account information.
5. Capture the complete instance-wide workflow inventory, not only name search
   results. Confirm exactly the three pinned workflow IDs are active and no
   retired signature is active.
6. Record the old workbook modification timestamp/checksum and confirm it has
   zero active replacement bindings. Do not delete or reorganize it.
7. Build the private unsent `To Apply` snapshot with the current Configuration
   profile/application policy, then generate only the sanitized compatibility
   inventory:

   ```bash
   npm run inventory:unsent -- private-unsent-snapshot.json sanitized-unsent-inventory.json
   ```

8. Populate `docs/cutover-target-map.example.json` outside the repository and
   capture the `pre_deployment` phase. This phase records the currently active
   versions before they are replaced:

   ```bash
   npm run capture:cutover -- pre_deployment target-map.json pre-deployment.json
   npm run validate:cutover -- pre-deployment.json
   ```

Do not put workbook content, generated messages, job descriptions, reviewer
notes, private profile payloads, API keys, authorization headers, credential
identifiers, Slack webhook URLs, or raw provider responses in evidence.

## 2. Provision blank non-production workbooks

Create separate Main and Configuration workbooks whose IDs differ from each other and from the old workbook ID.

1. Install the generated `google-apps-script/SheetSetup.gs`.
2. Run `setupFreshJobPipeline()` in Main and `setupFreshJobPipelineConfiguration()` in Configuration.
3. Confirm Main has exactly five visible tabs—`Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, and `Archive`—plus hidden `_System`; confirm Configuration has exactly `Search Keywords`, `Candidate`, `Skills`, `Experience`, `Projects`, `Education`, `Awards`, `Job Preferences`, `Application Settings`, `Required Style`, and `Banned Phrases` visible.
4. Confirm the five business tabs have the exact configured headers and zero data rows.
5. Confirm `To Review` offers only `Proceed` and `Reject`, `To Apply` offers only `I Applied` and `Skip`, `prep_status` is visible in To Apply, blank remains valid, and `Scraped Jobs` has no normal action dropdown.
6. Confirm `Search Keywords` has exact `enabled` and `keyword` headers, ten enabled seed rows, checkbox validation, and a warning-protected header.
7. Confirm all ten context tabs have their exact configured headers, bootstrap rows, checkbox validation where applicable, and warning-protected headers.
8. Edit disposable copies of candidate, evidence, job-preference, application-setting, required-style, banned-phrase, and keyword rows, then run setup a second time.
9. Confirm no duplicate tab, header, validation, protection, context row, keyword row, or record was created and every edit was preserved.
10. Confirm no old workbook ID, `IMPORTRANGE`, copied business row, or old data is present in Configuration.

Setup must stop rather than delete a non-empty unexpected sheet or overwrite conflicting headers.

## 2A. Provision and verify a disposable receipt store

The alert receipt store is an n8n Data Table, not a Main-workbook tab. It must never change the business-sheet schema.

1. Validate the repository policy and print the non-mutating provisioning plan:

   ```bash
   npm run validate:receipts
   npm run validate:receipts -- --plan
   ```

2. In the disposable n8n project, create exactly one Data Table named `Job Pipeline Alert Receipts` with the ordered columns and types from the plan. Existing tables are accepted only when their complete user-column schema matches exactly.
3. Bind `JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID` to that Data Table ID. Do not put the ID in a webhook URL, log payload, or committed evidence.
4. Export the table metadata and all rows to a local JSON object with `id`, `name`, `columns`, and `rows`, then validate it without mutation:

   ```bash
   npm run validate:receipts -- --snapshot sanitized-receipt-table.json
   ```

5. Test duplicate receipt identity, stale receipt version, invalid transition, retry cap, restart, and delivered reconciliation. The adapter must fail closed and must never retain a complete message, description, profile, webhook, credential, authorization value, or raw provider response.
6. In an inactive disposable Alerter copy, prove the generated graph imports with every Data Table node on type version 1.1 and every compare-and-swap filter matching both `receipt_id` and `receipt_version`. Confirm Slack has no path that bypasses pending/sending rereads, the fresh `To Apply` guard, or the provider-headroom recheck.
7. Before any cutover, capture both an approved encrypted n8n database backup and a complete receipt-table export. Restore only while the workflow is inactive; validate the restored full snapshot before reactivation. Never prune a delivered receipt before its business record is reconciled.

The repository validator is policy/snapshot-only and never provisions or mutates a production Data Table.

## 3. Import replacements inactive

Run:

```bash
npm run build
npm run validate
npm run validate:deployment -- --policy-only
```

Confirm the deployment policy reports the current application compatibility
unit. The pipeline schema/storage and deterministic contract digest, candidate
profile, application policy, application-pack policy, pack, coverage, and
message-plan versions must match the exact generated commit. A partial match is
a failed gate.

Import only:

- `workflows/scraper.json`
- `workflows/generator.json`
- `workflows/alerter-mover.json`

Keep all three inactive. Bind the same Google Sheets OAuth2 credential to every Google Sheets node and to Alerter & Mover's `Get Main Workbook Layout` and `Sort Business Sheets Latest First` HTTP Request nodes. Bind `JOB_PIPELINE_SPREADSHEET_ID` to the disposable non-production Main workbook, `JOB_PIPELINE_CONFIG_SPREADSHEET_ID` to a separate disposable Configuration workbook, and `JOB_PIPELINE_ALERT_RECEIPT_TABLE_ID` to the validated disposable receipt Data Table. Bind authorized non-production Groq and Slack values, plus `JOB_PIPELINE_REVIEW_URL` as a deep link to the Main workbook's `To Apply` tab. Confirm each export still has `active=false`, `Asia/Manila`, its configured timeout, and no OnlineJobs application/submission endpoint.

## 3A. Build all three production updates in place

For Scraper, Evaluator & Generator, and Alerter & Mover, run
`scripts/build-bound-workflow-rollout.mjs` with the reviewed generated artifact
and its current live export. The builder identifies the role from the policy,
requires the pinned production ID, requires the exact reviewed artifact digest,
copies exactly one unambiguous Google credential reference to every
Google-capable node, assigns a new version, and keeps the result inactive. A
pinned older live graph may have fewer Google nodes than its replacement; all
Google nodes present in that source must still expose the same safe reference.
The expected replacement credential-bound node counts are 13, 20, and 33
respectively.
It rejects any credential field in the repository artifact, any live node
without the common reference, and any credential object containing fields
other than the safe n8n reference `id` and optional `name`; the deployable output
retains only the validated `id`.

```bash
node scripts/build-bound-workflow-rollout.mjs workflows/scraper.json live-scraper.json private-bound-scraper.json
node scripts/build-bound-workflow-rollout.mjs workflows/generator.json live-generator.json private-bound-generator.json
node scripts/build-bound-workflow-rollout.mjs workflows/alerter-mover.json live-alerter.json private-bound-alerter.json
```

Keep bound outputs in a permission-restricted temporary directory. They contain
credential references and must never be committed or copied into cutover
evidence.

Before import, stop n8n and its task runner, confirm no execution is `running`
or `waiting`, and back up the live workflow, Main/Configuration workbooks, n8n
database, launcher/configuration, and receipt table. Import all three bound
workflows under their existing IDs while inactive, restart n8n and the task
runner, then verify health and that all three remain inactive. Capture the
`pre_activation` phase only after each live workflow digest, version, schedule,
timeout, timezone, workbook binding, and hashed Google credential binding
matches policy.

For a bounded observation window only,
`scripts/build-rollout-observation-workflow.mjs` may create a private artifact
with successful execution data and progress retention enabled. After the
scheduled movement, alert, and replay gates pass, import the standard bound
artifact again and verify `saveDataSuccessExecution=none` and
`saveExecutionProgress=false`. Failed executions remain retained according to
normal policy.

The Slack HTTP node must send through n8n's JSON-body field and treat only the
exact plaintext `ok` acknowledgement as accepted/200. Do not use the raw-body
expression: n8n can otherwise serialize a local transport agent after the POST
has already reached Slack, creating an ambiguous-delivery report. Provider
status extraction must include nested `error.status` and `error.statusCode`.

The initial five-store Sheet request has no built-in retry. A 429 alone enters
`Wait for Sheets Quota Window` for 65 seconds, then performs one final request.
All later Sheet reads have no in-execution automatic retry and fail closed for
the next 15-minute recovery run. Never configure a nominal 65-second n8n
`waitBetweenTries`: n8n 2.32.6 caps that runtime wait at five seconds.

Receipt restore is part of workflow rollback, not an optional diagnostic. With
all three pipeline workflows stopped, restore the complete integrity-checked
n8n database or the validated receipt-table export paired with the workflow
backup. Confirm one row per receipt identity and the exact 20-column schema
before reactivation. Do not remove `delivered` evidence until its business row
is `sent` and its receipt is `reconciled`; do not reset a historical terminal
or ambiguous alert to make a canary.

## 4. Non-production smoke matrix

Use synthetic/disposable source fixtures. Record only pass/fail, bounded categories, timestamps, workflow execution IDs, and canonical test IDs.

### Scraper

- Confirm the workflow reads `Search Keywords` before the first source request.
- Add, edit, enable, and disable disposable keywords between runs without
  rebuilding or reimporting the workflow; confirm the next run uses only the
  new enabled snapshot.
- Confirm blank enabled, malformed enabled, duplicate normalized, zero-enabled,
  missing-sheet, and read-failure cases stop before source requests, claims, or
  business-sheet writes.
- Edit the tab after one execution captures its snapshot and confirm only the
  next execution observes the edit.
- Confirm the generated and imported Scraper contains no embedded keyword
  catalog or fallback.
- Freeze one execution clock and prove every keyword/page uses the same `window_start` and `window_end`.
- Accept a source timestamp exactly at `window_start`, inside the interval, and exactly at `window_end`.
- Exclude a timestamp one millisecond older, one millisecond future, missing, and unparseable.
- Confirm multiple keywords/pages create one `Scraped Jobs` identity with merged keywords.
- Put separate identities in `Scraped Jobs`, `To Review`, and `To Apply`; run discovery again and confirm only discovery-owned fields update in the current owner without resetting actions, review context, messages, pack state, alerts, or notes.
- Seed the identity in Applied Jobs, then Archive, and confirm neither is reinserted.
- Seed a duplicate identity within one store and across two stores and confirm the run fails before append/update writes.
- Test a recognized empty result and confirm no placeholder row.
- Test login/challenge/maintenance/unrecognized content and a failed later page. Confirm explicit partial/failure evidence and retention of valid earlier-page rows.

### Evaluator & Generator

- Edit each context tab between executions and confirm the next execution uses
  one new frozen context hash without rebuilding or reimporting a workflow.
- Remove a required Candidate field, create conflicting repeated experience or
  project metadata, use an invalid evidence reference, and corrupt a preference
  value. Confirm every case stops before queue claims, provider calls, or
  business-sheet writes.
- Seed six eligible rows in deterministic queue order. Confirm the first five
  form the fixed batch, the sixth is untouched, and the loop never backfills.
- Repeat with zero, one, two, three, and four eligible rows. Confirm zero is a
  successful no-op and every available row is processed once.
- Confirm each selected `Scraped Jobs` row gets a distinct just-in-time `_System` claim,
  `Scraped Jobs` claim, evaluation, optional generation, guarded commit, and
  exact persistence confirmation before the next row begins.
- Force one selected row to fail at the provider or persistence boundary and
  confirm the other four continue. The failed row must end in bounded `error`
  evidence or fail closed without an unguarded second write.
- Good fit: confirm a ready pack and deterministically validated message produce `ready_to_apply`.
- Promising gap/question: confirm `review_needed`, bounded reason, and required input.
- Hard disqualifier/low fit: confirm `skip`.
- Missing/unavailable source: confirm `unavailable`, not `skip`.
- Provider timeout/rate limit/auth/invalid output: confirm bounded `error` evidence, retries, and no ready status.
- Unsafe instructions/prompt injection/private-data/auto-action/unsupported claims: confirm no provider path or no ready commit.
- Requirement-aware fixture: confirm heading/list structure is preserved, all
  mandatory subject/content/link/manual items are extracted in source order,
  and the responsibilities block does not become a screening question.
- Coverage: confirm exact evidence is preferred, adjacent evidence records its
  material difference and requires review, and partial or missing mandatory
  evidence remains non-ready with actionable `required_input`.
- Prompt and validation: confirm the exact employer subject is the first line,
  all planned answer elements survive prompt compaction and repair, keyword-only
  responses and unsupported frequency/provider claims fail, and required
  summary counts and approved links are enforced.
- Persisted safety: remove or forge coverage, message-plan, canonical proof, or
  version fields on a disposable ready record and confirm Slack eligibility is
  suppressed. Confirm movement and rediscovery preserve the same fields and
  state guard.
- Reported posting: confirm the four scoped application items are extracted,
  Job Pipeline is selected for the AI-workflow request, Groq remains explicit
  as adjacent to Claude, the reported fluent non-answer is rejected, and a
  corrected subject/summary/tools/link message passes both generation and
  persisted safety. Repeat with exact evidence and an unrelated non-Claude job
  to prove the rules are not posting-specific.
- Select `Proceed` for a profile-answerable screening question, confirm Alerter & Mover copies it directly to `To Apply` with `prep_status=pending`, then confirm Generator includes the question in both initial and repair prompts, produces a validated message from approved proofs in place, and sets `prep_status=message_ready` without recreating the review case.
- Repeat with a salary, availability, schedule, time-zone, or start-date question and confirm it remains a manual-submission reminder rather than becoming a generated commitment.
- Select `Proceed` for an unsafe employer instruction or required external action and confirm the unsafe text stays outside the provider prompt while `To Apply` becomes `external_steps` with only its sanitized checklist and no application submission.
- Confirm a missing or unusable description remains `unavailable` and cannot produce an application message.
- Confirm rhetorical headings such as `What to expect?` and `Don't meet every single requirement?` are not extracted as screening questions.
- Change action/version after a claim and confirm the stale commit is rejected.
- Fail a retry after a previously valid message and confirm the old message remains stored but the row is not alert-eligible.
- Exercise one initial rejection and confirm exactly one delayed repair request,
  no third request, no automatic Groq HTTP retry, and at most two provider
  requests for that job.
- Repeat or overlap the execution and confirm no duplicate claims, result
  commits, application messages, ready states, or downstream Slack alerts.
- Seed `pending`, `preparing`, `message_ready`, `needs_input`, `external_steps`,
  `repair_pending`, and `preparation_error` controls in a disposable copy.
  Confirm only pending/repair/error are eligible for preparation, unchanged
  paused rows are not selected, and a guarded relevant-input/version advance
  resumes exactly one preparation.
- Confirm only `message_ready` produces the full copy-ready alert. Confirm
  `needs_input` and `external_steps` produce at most their distinct bounded
  reminder, while other preparation states produce no notification. Advance a
  reminder control to a new message-ready preparation version and confirm one
  new category-specific receipt rather than a replay.

### Actions and moves

- From `Scraped Jobs`, confirm blank `review_needed` moves to `To Review`, blank `ready_to_apply` moves to `To Apply`, and blank `skip` moves to Archive.
- In `To Review`, test only `Proceed` and `Reject`; confirm Proceed goes directly to To Apply pending and Reject goes to Archive.
- In `To Apply`, test only `I Applied` and `Skip`; confirm a proceeded review
  row shows its system reminder in visible `required_input` while preserving
  any user-owned `notes`.
- Paste forged/unsupported values and confirm no mutation.
- Confirm `I Applied` records the manual application fact even when the current
  message-safety check suppresses Slack or the alert is already terminal; the
  To Apply store/status/action contract and copy-confirm-delete guards still
  apply.
- Confirm automatic `skip`, user `Skip`, and `Reject` use their exact archive reasons.
- Fail each active and terminal destination write and confirm its source row remains.
- Succeed destination write, fail source delete, rerun, and confirm one destination row followed by safe deletion.
- Combine routes from multiple source sheets and confirm the one global cap and per-sheet descending deletion order.
- Change source state after planning and confirm deletion is rejected.
- Seed duplicate/ambiguous identities and confirm the run stops.
- Repeat after successful deletion and confirm no-op.

### Slack (issue #22 evidence gate)

In an authorized non-production channel:

1. Trigger one current safe ready row.
2. Copy the code-block contents from Slack and compare byte-for-byte with the Sheet’s stored `generated_message`.
3. Confirm title/company/scores/reason/gaps/instructions/questions/proofs/warnings are present and bounded.
4. Open `To Apply` and source links; confirm they only navigate and do not change state.
5. Test rejection/rate limit and confirm movement still completes.
6. Test timeout and confirm terminal ambiguous delivery prevents automatic duplicate send.
7. Repeat the scheduler and confirm the successful idempotency key is not replayed.

This live provider acceptance is not satisfied by unit tests alone.

### Failure and recovery

Explicitly cover source-page failure, Groq/provider failure, stale/concurrent action, destination-write failure, source-delete failure, Slack rejection, Slack timeout, repeated schedules, empty queues, and recovery. Inspect saved failed executions and sanitized logs for secrets/private payloads.

## 5. Validate the existing production workbooks

Only after non-production passes:

1. Do not provision a new blank workbook or reset existing rows. Confirm the
   current Main workbook still has the exact five business sheets and hidden
   `_System`, with all 74 ordered record fields.
2. Confirm the separate Configuration workbook still has `Search Keywords` and
   all ten context tabs with exact headers, and reconstructs a valid current
   profile/application context without exposing it in evidence.
3. Confirm Main, Configuration, and retained old workbook IDs are distinct and
   the old workbook has zero active replacement bindings.
4. Confirm `JOB_PIPELINE_REVIEW_URL` still targets the current Main workbook's
   `To Apply` tab. Do not change any workbook or URL merely to satisfy evidence.
5. Run `npm run validate:deployment` inside the exact production environment.
   It must match deployment policy `2026-08-04/v1` without printing values.

## 6. Pre-activation inventory gate

Freeze profile/configuration edits and regenerate the sanitized unsent
compatibility inventory from a fresh private snapshot. The inventory tool uses
the same persisted-message safety gate as Slack and emits only identity/guard
digests, record and compatibility versions, bounded reason codes, and guarded
dispositions. For each incompatible row, use normal regeneration, return to
review, or quarantine. Re-read immediately before any disposition and never
overwrite a newer action, version, guard, or profile snapshot. The unhandled
incompatible count must be zero before activation.

Create the target map using `docs/cutover-target-map.example.json`. Capture and validate:

```bash
npm run capture:cutover -- pre_activation target-map.json pre-activation.json
npm run validate:cutover -- pre-activation.json
```

The schema-v3 gate requires:

- the exact 40-character reviewed deployment commit and application
  compatibility unit;
- exact pinned IDs, imported artifact digests, version IDs, schedules,
  timeouts, timezone, and hashed common Google credential binding for all three
  targets;
- complete instance-wide pagination;
- all replacement targets inactive;
- every renamed or pipeline-bound copy and every superseded/duplicate Scraper,
  Generator, Alerter, Reviewer, Archiver, Analytics, and Recommender inactive;
- every unresolved dynamic Google Sheets writer classified as pipeline-ambiguous
  and inactive unless its unrelated workflow ID is explicitly approved in the
  reviewed deployment policy;
- all three targets bound to the current Main and Configuration workbooks;
- exact segmented Main and Configuration contracts, with all workbook IDs
  distinct;
- readable, restore-verified workflow/workbook/database/receipt/runtime backups;
- zero unhandled incompatible unsent records;
- every required disposable case tied to a sanitized n8n execution ID;
- all deployment checks true;
- rollback documented and verified.

## 7. Activation

Within one controlled window:

1. Reconfirm every superseded workflow inactive.
2. Activate exactly one Alerter & Mover, then one Evaluator & Generator, then one Scraper. This order starts consumers before the producer.
3. Do not activate a second copy to “test” failover.
4. Capture a read-only immediate inventory and confirm exactly three recognized
   pipeline workflows are active. This is an activation check, not final
   `post_activation` evidence.
5. Begin the required observation window; do not mark the deployment complete
   from the immediate inventory.

No step authorizes application submission or deletion of the old workbook.

## 8. Initial scheduled observation

Observe one complete maximum schedule interval (240 minutes) and at least one
real boundary for each role. Extend observation while any retry, receipt
reconciliation, incompatible unsent record, or unresolved failure remains.

Observe at least one real schedule boundary for every role. Confirm:

- no out-of-window or duplicate jobs across `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, and `Archive`;
- no duplicate alerts, applied rows, or archive rows;
- no stuck processing/alert/discovery claim past lease;
- no unexpected old-workbook modification;
- exactly one active role signature each;
- successful Sheet state even though successful n8n execution payloads are not retained;
- saved failures/log events contain sanitized categories only.

Record the old workbook checksum/modification time again and prove it is unchanged and has zero active replacement bindings.

Record one scheduled execution ID for every role, one bounded production record
digest, and the authorized Slack canary's matching stored/payload digests and
receipt digest. Then capture and validate the final phase:

```bash
npm run capture:cutover -- post_activation target-map.json post-activation.json
npm run validate:cutover -- post-activation.json
```

The validator rejects an observation shorter than 240 minutes or completed
after capture, a missing role boundary, a production/Slack execution unrelated
to its recorded scheduled role execution, mismatched production/Slack identity,
an unsafe or replayed Slack canary, incomplete record provenance, stale active
or artifact versions, an active renamed/pipeline-bound duplicate, or any
unhandled incompatible unsent record.

## 9. Rollback

Rollback triggers include wrong workbook binding, unexpected old-workbook write, duplicate role/row/alert, unsafe ready message, repeated stale claims, destination/source inconsistency, or deployment validation failure.

For an application-compatibility rollback, disable Alerter & Mover first to
stop new message disclosure, then disable Evaluator & Generator and Scraper.
Do not reactivate an older consumer while records written under the new pack,
coverage, or message-plan versions remain unsent. Quarantine or reconcile those
records under the captured guard-safe inventory before restoring the previous
compatible workflow/policy set.

1. Disable all three replacement workflows.
2. Wait for their maximum claim leases to expire and verify no execution remains running/waiting.
3. Preserve the current Main and Configuration workbooks for diagnosis; do not
   merge their rows into the retained old workbook.
4. Restore the three recorded prior versions under the same pinned workflow IDs
   together with the matching runtime, database, and receipt-store assets.
5. Reactivate prior versions only after every replacement version is inactive
   and all new-compatibility unsent records are reconciled or quarantined.
6. Recheck the complete instance-wide inventory and old workbook integrity.

This update preserves the existing segmented workbooks in place. Rollback does
not erase or rewrite rows created under the new application compatibility unit;
those rows must first be reconciled or quarantined. Any manually submitted
application during the observation window must be reconciled by a human before
restoring prior workflow versions.

## Evidence status

Repository validation proves deterministic fixtures, exact generated-artifact
digests, policy consistency, sanitizer behavior, and rejection paths. A valid
`pre_deployment` record additionally requires readable current backups and a
fresh sanitized unsent inventory. Inactive imports, disposable execution IDs,
guarded dispositions, activation, the 240-minute observation, a bounded
production record, and authorized Slack delivery remain external gates. Leave
them open until all three evidence phases pass `validate:cutover` against the
exact commit on `main`.

The in-place migration from the legacy single active queue to the segmented contract is a separate compatibility-unit procedure. Follow `docs/segmented-queue-cutover.md`; do not reuse the historical fresh-workbook evidence as proof of that migration.
