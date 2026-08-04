# Review/preparation lifecycle cutover

This runbook upgrades the review/preparation lifecycle introduced by issues
#75, #76, and #77. It extends the controlled deployment procedure in
`docs/n8n-deployment.md`; it does not create a second deployment architecture.

No production cutover is represented by this repository change. Production
data mutation, deployment, activation, and live workflow execution require a
separately authorized maintenance window. Committed examples are intentionally
non-passing until sanitized live evidence exists.

## Non-negotiable movement boundary

- Never copy, cut, paste, or directly relocate a valid business row among
  `Scraped Jobs`, `To Review`, `To Apply`, `Applied Jobs`, and `Archive`.
- Never edit status, action, review, or preparation cells to force a route.
- A deliberate manual Alerter & Mover run is allowed only through the same
  complete generated workflow used by schedules.
- Every business move is append/upsert destination, exact reread/confirmation,
  then unchanged-source deletion. A surviving destination after delete failure
  is recovered by that same path.
- A proven stale duplicate may be deleted only after a fresh backup and exact
  reread identify the invalid copy. That deletion does not authorize moving the
  surviving row; its normal guarded workflow owns the next transition.

## 1. Pin and validate the compatibility unit

Pin one full commit containing #75–#77 and record that same SHA for each issue.

```bash
npm ci
npm run build
npm run validate
git diff --exit-code -- workflows google-apps-script/SheetSetup.gs
```

The pinned deployment policy must name exactly one Scraper, one Evaluator &
Generator, and one Alerter & Mover target, with the exact artifact digests,
schedules, timeouts, workbook bindings, receipt schema, and storage contract.
Do not continue with mixed versions.

## 2. Freeze and capture pre-cutover evidence

Stop all affected scheduled writers and wait for running/waiting executions and
unexpired `_System`/business claims to reach zero. Capture sanitized IDs,
versions, artifact digests, active state, schedules, timeouts, environment
binding names, schema/receipt versions, and per-store row counts. Do not capture
credential values, generated messages, full job descriptions, complete rows,
or full URLs.

Create readable, hashed, restore-identified backups for every kind required by
`config/n8n-deployment-policy.json`, including all three workflows, Main and
Configuration workbooks, n8n state, alert receipts, and runtime configuration.

Validate a completed sanitized pre-cutover evidence file:

```bash
npm run validate:review-preparation-cutover -- private-sanitized-pre.json
```

The pre-cutover validator requires all three workflow records to be inactive.

## 3. Prove setup and failure controls in disposable copies

Run the generated setup against a copied workbook twice. Both runs must preserve
every business row and operator-owned value, create no seed/placeholder business
record, and converge to the exact v4 headers/validations.

In inactive disposable workflow copies, exercise:

- legacy blank, `Approve`, `Deny`, and preparation-less rows;
- ambiguous duplicates and unrelated third-store ownership;
- append-confirm-delete success followed by source-delete failure and recovery;
- stale actions, stale v3/v4 guards, and operator edits during a claim;
- current and incompatible active claims/workflow versions;
- `pending`, `message_ready`, `needs_input`, `external_steps`, repair, and error;
- unchanged paused rows across multiple scheduled-equivalent cycles;
- a guarded relevant-input/version advance that resumes exactly once;
- copy-ready and reminder receipt-category transitions;
- existing rediscovery, direct-ready, applied, skip, reject, Archive, receipt,
  and no-auto-application controls.

No disposable control may open/submit an application, perform an employer test,
attach a file, or spend Apply Points.

## 4. Apply structural setup, then fresh-preflight again

With writers still frozen and backups verified, apply only the idempotent Sheet
structure/setup upgrade. Do not seed or relocate business data. Take another
fresh exact reread of all five business stores and claims before planning.

The private snapshot contract is:

- `captured_at` and exact `contract_version`;
- exactly five arrays under `stores`;
- an `active_claims` array;
- optional sanitized `message_authorizations` produced by the current persisted
  message-safety gate.

Generate a deterministic private plan to stdout:

```bash
npm run plan:review-preparation -- private-fresh-snapshot.json \
  > private-review-preparation-plan.json
```

Snapshots and plans contain canonical identities and must not be committed. The
planner performs no writes and always reports `writes_allowed=false`. It stops
the window on contract mismatch, unsupported store/status/action combinations,
stale guards, unexpired claims, or duplicate owners. It reports each row's
source, identity, normalized decision, target store/lifecycle, guarded workflow
path, source guard/version, and bounded reason.

Expected legacy classifications are:

| Legacy state | Planned result | Execution path |
| --- | --- | --- |
| blank To Review | unresolved review case | no move until operator decides |
| `Approve` / `Proceed` in To Review | To Apply, proceed, `pending` | Alerter & Mover copy-confirm-delete, then Generator in place |
| `Deny` / `Reject` in To Review | Archive / `review_denied` | Alerter & Mover copy-confirm-delete |
| v3 looped `Approve` in Scraped Jobs | To Apply, proceed, `pending` | one guarded Alerter & Mover copy-confirm-delete exit, then Generator in place |
| v3 looped `Deny` in Scraped Jobs | Archive / `review_denied` | one guarded Alerter & Mover copy-confirm-delete exit |
| preparation-less To Apply | fail-safe preparation; `message_ready` only with exact current authorization | one guarded Generator legacy claim |

A v3 state guard is compatible for exactly one guarded claim only when no v4
review/preparation state is already present. The claim immediately writes a v4
guard. The Scraped Jobs exception additionally requires the raw legacy spelling
`Approve` or `Deny`; a new `Proceed`/`Reject` value cannot use it. Any v3 guard
combined with v4 lifecycle fields is stale and stops.

## 5. Execute only guarded workflows

Update the three pinned workflow IDs as one inactive compatibility unit and
rerun deployment validation. Execute eligible transitions only through the
generated Alerter & Mover and Generator. Manual Alerter & Mover execution, when
deliberately authorized, must use the identical route table, claims, guards,
caps, receipts, and audit summary as the schedule path.

After each bounded cycle, freshly reread all five stores and reconcile source
and destination guards before the next cycle. Do not resume schedules while a
partial move or duplicate owner remains unresolved.

## 6. Named records and observations

Record sanitized evidence for OnlineJobs.ph source IDs `1699999`, `1589947`,
`1701320`, `1701315`, and `1701179`, plus unrelated controls. Each must have one
authoritative owner and a documented preparation/terminal category. For every
proceeded named record, the resolved `review_case_id` must not reappear as an
undecided To Review case.

After activation, observe at least the policy minimum of 240 minutes and at
least one scheduled boundary for each of the three roles. Evidence must include
bounded counts for preparation states, repeated-case suppressions, partial
recoveries, provider failures, reminders, copy-ready alerts, and unresolved
migration rejects. It must prove:

- no unchanged paused record was repeatedly prepared or reminded;
- one controlled relevant-input/version change resumed exactly once;
- one message-ready control received at most one copy-ready alert;
- reminder categories matched policy and did not contain a message/description;
- exactly one active workflow exists for each role; verification copies remain
  inactive;
- all existing lifecycle and no-auto-application controls still pass.

Validate the completed post-cutover evidence with the same validator. Post
evidence requires each target workflow active, exactly one owner for each named
record, at least three role boundaries total, the minimum observation duration,
and zero unresolved migration rejects.

## 7. Rollback

Rollback triggers include identity ambiguity, unresolved partial movement,
mixed workflow/contract versions, stale incompatible claims, repeated resolved
review cases, duplicate or unsafe notifications, or any automatic-application
path. Freeze writers first. Restore runtime/configuration, receipt store,
workbooks, and all three workflow definitions as the documented mutually
compatible unit; validate while inactive before any reactivation.

Rollback never manually relocates business rows. Older workflows cannot safely
interpret v4 preparation state, so a partial workflow-only rollback is
forbidden. If Sheet state advanced after the backup, preserve it frozen and
escalate for a new guarded migration plan rather than forcing rows into an old
shape.
