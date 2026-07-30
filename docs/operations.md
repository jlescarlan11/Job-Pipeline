# Fresh three-workflow cutover runbook

This runbook is a gated operator procedure. Repository work must not activate n8n, provision a production workbook, send a real Slack message, or modify the old workbook.

Stop at any failed gate. Never run old and replacement workflows against either workbook at the same time.

Runtime baseline: all three exports use `Asia/Manila`. Scraper runs every 240
minutes with a 900-second timeout; Evaluator & Generator runs every 90 minutes
with a 480-second timeout; Alerter & Mover runs every 15 minutes with a
120-second timeout.

## 1. Freeze and back up the old system

Before creating or activating anything:

1. Record the old production workbook ID and a timestamped recoverable backup/reference ID.
2. Export every currently imported n8n pipeline workflow, including duplicate and inactive copies. Store the export bundle in the approved encrypted backup location and record its reference.
3. Capture the instance-wide workflow inventory, not only name search results.
4. Record every prior workflow ID needed for rollback.
5. Record the old workbook modification timestamp/checksum and its current active binding count.
6. Do not delete or reorganize the old workbook. It remains rollback/reference state.

Do not put workbook content, generated messages, private profile payloads, API keys, authorization headers, or Slack webhook URLs in evidence.

## 2. Provision a blank non-production workbook

Create a separate workbook whose ID is not the old workbook ID.

1. Install the generated `google-apps-script/SheetSetup.gs`.
2. Run `setupFreshJobPipeline()`.
3. Confirm exactly `Review Queue`, `Applied Jobs`, and `Archive` are visible and `_System` is hidden.
4. Confirm the three business tabs have the exact configured headers and zero data rows.
5. Run setup a second time.
6. Confirm no duplicate tab, header, validation, protection, or record was created.
7. Confirm no old workbook ID, import formula, copied row, or old data is present.

Setup must stop rather than delete a non-empty unexpected sheet or overwrite conflicting headers.

## 3. Import replacements inactive

Run:

```bash
npm run build
npm run validate
npm run validate:deployment -- --policy-only
```

Import only:

- `workflows/scraper.json`
- `workflows/generator.json`
- `workflows/alerter-mover.json`

Keep all three inactive. Bind Google Sheets credentials and `JOB_PIPELINE_SPREADSHEET_ID` only to the disposable non-production workbook. Bind authorized non-production Groq and Slack values, plus `JOB_PIPELINE_REVIEW_URL` for that workbook. Confirm each export still has `active=false`, `Asia/Manila`, its configured timeout, and no OnlineJobs application/submission endpoint.

## 4. Non-production smoke matrix

Use synthetic/disposable source fixtures. Record only pass/fail, bounded categories, timestamps, workflow execution IDs, and canonical test IDs.

### Scraper

- Freeze one execution clock and prove every keyword/page uses the same `window_start` and `window_end`.
- Accept a source timestamp exactly at `window_start`, inside the interval, and exactly at `window_end`.
- Exclude a timestamp one millisecond older, one millisecond future, missing, and unparseable.
- Confirm multiple keywords/pages create one Review Queue identity with merged keywords.
- Run again and confirm allowed discovery fields update without resetting downstream state.
- Seed the identity in Applied Jobs, then Archive, and confirm neither is reinserted.
- Test a recognized empty result and confirm no placeholder row.
- Test login/challenge/maintenance/unrecognized content and a failed later page. Confirm explicit partial/failure evidence and retention of valid earlier-page rows.

### Evaluator & Generator

- Good fit: confirm a ready pack and deterministically validated message produce `ready_to_apply`.
- Promising gap/question: confirm `review_needed`, bounded reason, and required input.
- Hard disqualifier/low fit: confirm `skip`.
- Missing/unavailable source: confirm `unavailable`, not `skip`.
- Provider timeout/rate limit/auth/invalid output: confirm bounded `error` evidence, retries, and no ready status.
- Unsafe instructions/prompt injection/private-data/auto-action/unsupported claims: confirm no provider path or no ready commit.
- Select `Approve` and confirm it returns through the same pack/message gates.
- Change action/version after a claim and confirm the stale commit is rejected.
- Fail a retry after a previously valid message and confirm the old message remains stored but the row is not alert-eligible.

### Actions and moves

- `ready_to_apply`: test only `I Applied` and `Skip`.
- `review_needed`: test only `Approve` and `Deny`.
- Paste forged/unsupported values and confirm no mutation.
- Confirm `I Applied` fails without current pack/message provenance.
- Confirm automatic `skip`, user `Skip`, and `Deny` use their exact archive reasons.
- Fail destination write and confirm Review Queue remains.
- Succeed destination write, fail source delete, rerun, and confirm one destination row followed by safe deletion.
- Change source state after planning and confirm deletion is rejected.
- Seed duplicate/ambiguous identities and confirm the run stops.
- Repeat after successful deletion and confirm no-op.

### Slack (issue #22 evidence gate)

In an authorized non-production channel:

1. Trigger one current safe ready row.
2. Copy the code-block contents from Slack and compare byte-for-byte with the Sheet’s stored `generated_message`.
3. Confirm title/company/scores/reason/gaps/instructions/questions/proofs/warnings are present and bounded.
4. Open Review Queue and source links; confirm they only navigate and do not change state.
5. Test rejection/rate limit and confirm movement still completes.
6. Test timeout and confirm terminal ambiguous delivery prevents automatic duplicate send.
7. Repeat the scheduler and confirm the successful idempotency key is not replayed.

This live provider acceptance is not satisfied by unit tests alone.

### Failure and recovery

Explicitly cover source-page failure, Groq/provider failure, stale/concurrent action, destination-write failure, source-delete failure, Slack rejection, Slack timeout, repeated schedules, empty queues, and recovery. Inspect saved failed executions and sanitized logs for secrets/private payloads.

## 5. Provision the blank production workbook

Only after non-production passes:

1. Create another new workbook, distinct from old and non-production IDs.
2. Run setup twice and repeat the exact structure/idempotency/zero-row checks.
3. Record `verified_empty_before_activation=true`, `setup_runs>=2`, initial row counts of zero, and `old_rows_imported=false`.
4. Set production `JOB_PIPELINE_SPREADSHEET_ID` and `JOB_PIPELINE_REVIEW_URL`.
5. Set `JOB_PIPELINE_OLD_SPREADSHEET_ID` only for validation/rollback comparison; replacement workflows never read it.
6. Run `npm run validate:deployment` inside the actual production environment.

## 6. Pre-activation inventory gate

Create the target map using `docs/cutover-target-map.example.json`. Capture and validate:

```bash
npm run capture:cutover -- pre_activation target-map.json pre-activation.json
npm run validate:cutover -- pre-activation.json
```

The gate requires:

- exact IDs for the three replacement targets;
- complete instance-wide pagination;
- all replacement targets inactive;
- every superseded/duplicate Scraper, Generator, Alerter, Reviewer, Archiver, Analytics, and Recommender inactive;
- all three targets bound to the fresh production workbook;
- fresh/old IDs distinct;
- workbook and workflow backups recorded;
- every smoke boolean true;
- rollback documented and verified.

## 7. Activation

Within one controlled window:

1. Reconfirm every superseded workflow inactive.
2. Activate exactly one Alerter & Mover, then one Evaluator & Generator, then one Scraper. This order starts consumers before the producer.
3. Do not activate a second copy to “test” failover.
4. Capture post-activation inventory immediately.
5. Validate post-activation evidence. Exactly three recognized pipeline workflows must be active.

No step authorizes application submission or deletion of the old workbook.

## 8. Initial scheduled observation

Observe at least one real schedule boundary for every role. Confirm:

- no out-of-window or duplicate Review Queue jobs;
- no duplicate alerts, applied rows, or archive rows;
- no stuck processing/alert/discovery claim past lease;
- no unexpected old-workbook modification;
- exactly one active role signature each;
- successful Sheet state even though successful n8n execution payloads are not retained;
- saved failures/log events contain sanitized categories only.

Record the old workbook checksum/modification time again and prove it is unchanged and has zero active replacement bindings.

## 9. Rollback

Rollback triggers include wrong workbook binding, unexpected old-workbook write, duplicate role/row/alert, unsafe ready message, repeated stale claims, destination/source inconsistency, or deployment validation failure.

1. Disable all three replacement workflows.
2. Wait for their maximum claim leases to expire and verify no execution remains running/waiting.
3. Preserve the fresh workbook for diagnosis; do not merge its rows into the old workbook.
4. Restore the recorded prior workflow exports/IDs and old workbook binding only through the approved rollback change.
5. Activate old roles only after every replacement is inactive.
6. Recheck the complete instance-wide inventory and old workbook integrity.

Because the new pipeline intentionally starts fresh, rollback does not merge new jobs or reconstruct retired analytics/recommendation state. Any manually submitted application during the observation window must be reconciled by a human before returning to the old workflow.

## Evidence status

Repository validation proves deterministic fixtures, generated artifacts, policy consistency, and rejection behavior. Actual workbook backups/provisioning, n8n imports/bindings/activation, a real scheduled boundary, and authorized Slack delivery require external credentials and operator authority. Leave their checkboxes open until captured evidence passes `validate:cutover`.
