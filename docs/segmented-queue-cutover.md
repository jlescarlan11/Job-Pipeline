# Segmented queue production cutover

This is the operator procedure for issue #58. It is deliberately not a deployment script: repository work cannot provision or mutate a production workbook, pause or activate production n8n workflows, send Slack messages, or fabricate the resulting evidence. The workbook schema and all three workflow definitions are one compatibility unit; stop at any failed gate and restore them together.

Private workbook exports, complete rows, generated messages, credentials, webhook URLs, and full migration plans must remain in an approved encrypted location and must not be committed. Commit only bounded counts, hashes, timestamps, workflow/execution identifiers, pass/fail gates, and rejection categories.

## 1. Pin and validate the release

Record the full reviewed commit for each of #55, #56, and #57 and build from that exact integrated commit:

```bash
npm run build
npm run check:artifacts
npm run validate:policy
npm test
```

Confirm all exports remain inactive and contain storage contract `2026-07-31-segmented-queues-v3`. Confirm there is no OnlineJobs.ph application/submission HTTP path. A later source change invalidates this gate and requires a rebuild and full re-review.

## 2. Capture restorable backups

Before any production mutation:

1. Export the workbook structure and data to a timestamped encrypted backup. Record its external reference, SHA-256, permissions, sheet titles/IDs, headers, visibility, row counts by sheet/status/action, canonical identity count, and live `_System` claim count.
2. Export all three production workflow definitions and capture their IDs, active states, schedules, offsets, timeouts, caps, credential/configuration references, workbook binding, and environment-variable names. Record an encrypted reference and SHA-256.
3. Prove both backup formats can be restored in a disposable environment. Do not count “file exists” as restore verification.
4. Record the pre-cutover `To Apply` deep-link target that will replace the legacy sheet link.

## 3. Prove the migration in disposable systems

On a private snapshot with representative rows for every status/action combination, run the planner twice using the same reference time:

```bash
npm run plan:segmented-queues -- private-snapshot.json private-plan-a.json 2026-07-31T00:00:00.000Z
npm run plan:segmented-queues -- private-snapshot.json private-plan-b.json 2026-07-31T00:00:00.000Z
shasum -a 256 private-plan-a.json private-plan-b.json
```

The private plans must have identical hashes. Store them outside the repository because they contain canonical job identities and state guards. Confirm the planner refuses conflicting headers, unexpected non-empty tabs, duplicate identities, unknown status/action values, unsupported combinations, and coexisting `Review Queue`/`Scraped Jobs` without proposing routes or source deletion.

In a disposable workbook, apply the plan through the authorized Sheets operator path and confirm:

- visible `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, `Archive`, and `Search Keywords`, plus hidden `_System`;
- exact full ordered headers in all five business sheets;
- only `Approve`/`Deny` in `To Review`, only `I Applied`/`Skip` in `To Apply`, blank accepted, and no normal action dropdown in `Scraped Jobs`;
- Search Keywords values and ordering preserved;
- setup and migration reruns are idempotent;
- every pre-migration identity exists exactly once after migration.

Import all three generated workflows inactive and smoke-test new intake, active-owner rediscovery, every generator result, every valid user action, invalid combinations, claim contention/expiry, stale edits, append-success/delete-failure recovery, alert eligibility, alert idempotency, and the `To Apply` deep link. The live-provider acceptance gate is not satisfied by repository tests alone.

## 4. Establish the quiet window

Pause all three production roles as one change. Record UTC and PHT start times, prove no relevant execution is running or waiting, and prove `_System` has no unexpired claim. Do not delete a live claim. Re-read the workbook immediately before planning; any operator edit invalidates an earlier plan.

Run the private planner against this final production snapshot. Resolve a rejection by correcting the source data through an approved, recorded operator decision and then capture a new snapshot. Never coerce an ambiguous row in the migration code.

## 5. Migrate the workbook

Use the accepted #55 plan through the authorized production Sheets path:

1. Rename `Review Queue` to `Scraped Jobs` in place to preserve its sheet ID.
2. Create `To Review` and `To Apply` with authoritative headers, formatting, protections, and dropdowns.
3. Route rows by the fresh planned state/action. Copy and confirm every destination before deleting an unchanged source row; process source deletions in descending row order.
4. Preserve `Applied Jobs`, `Archive`, `Search Keywords`, audit fields, and relevant `_System` evidence.
5. Reconcile total and per-route counts, canonical identities, and state guards. Require pre-cutover count = post-cutover count = unique post-cutover count, with zero unexplained loss or duplicates.
6. Confirm `Review Queue` is absent and the exact visible/hidden sheet contract remains.

Stop before workflow activation if any reconciliation fails. Restore the workbook backup or reconcile the idempotent partial copy under the recorded plan; do not proceed with mixed ownership.

## 6. Update workflows as one release unit

Update the existing Scraper, Evaluator & Generator, and Alerter & Mover IDs in place from the pinned artifacts. Preserve credentials/configuration references, schedule offsets, timeouts, caps, timezone, and intended activation behavior. Bind all three to the migrated workbook and set `JOB_PIPELINE_REVIEW_URL` to the `To Apply` deep link.

With all three still inactive, validate their role signatures, workbook binding, storage contract version, and deep link. Never activate a new-contract workflow against the legacy workbook shape or a legacy workflow against the segmented workbook.

## 7. Activate and observe

Activate exactly one Alerter & Mover, then one Evaluator & Generator, then one Scraper. Consumers start before the producer. Record activation and execution identifiers without payloads.

Observe at least one real schedule boundary for every role and controlled paths that prove:

- Scraper creates one new identity only in `Scraped Jobs` and does not duplicate an existing identity;
- Generator claims only `Scraped Jobs` and commits a result that moves to the correct owner;
- `Approve`/`Deny` work only in `To Review` and `I Applied`/`Skip` work only in `To Apply`;
- invalid combinations leave the source intact;
- one safe ready row produces at most one Slack alert from `To Apply`, and the link opens that tab;
- no workflow submits an application;
- no claim remains past its lease and no unexplained workflow failure remains.

## 8. Rollback as one compatibility unit

Rollback triggers include wrong binding or deep link, mixed contract versions, count/identity mismatch, duplicate ownership or alert, unsafe ready content, a stuck claim, an unexplained failure, or an invalid action that mutates state.

1. Disable all three replacement definitions and wait for executions/claims to finish or expire.
2. Restore the workbook and all three workflow definitions from the verified backups together.
3. Restore original bindings and link configuration, then validate all components while inactive.
4. Activate the mutually compatible prior roles in dependency-safe order.
5. Reconcile workbook hashes/counts and the complete instance-wide workflow inventory.

A rehearsal in a disposable environment must prove this procedure before production. Production rollback is performed only if a trigger occurs; evidence must distinguish rehearsal from an actual rollback.

## 9. Commit sanitized evidence

Create a sanitized JSON record outside `outputs/` first and validate it:

```bash
npm run validate:segmented-cutover -- sanitized-production-evidence.json
```

Only after validation passes may bounded evidence be committed. The validator requires pinned commits, build gates, backup/restore proofs, disposable tests, quiet-window proof, exact sheet ownership, zero-loss identity reconciliation, all three in-place workflow records, every route smoke, three schedule observations, clean claims/failures, and compatible rollback rehearsal.

## Current execution status

As of 2026-07-31, this repository change has not mutated a production workbook, deployed or activated n8n workflows, sent a live Slack message, or performed a production rollback. Those acceptance criteria remain blocked by the explicit no-deploy/no-production-mutation authority boundary until an authorized operator executes this runbook and commits validator-passing sanitized evidence.
