# Segmented queue production cutover — 2026-07-31

## Outcome

The production Job Pipeline now uses the segmented storage contract
`2026-07-31-segmented-queues-v3`. The workbook, all three in-place n8n
workflows, the persistent launcher environment, and the `To Apply` review link
were released as one compatibility unit. No workflow submits an application.

The validator-passing bounded record is
`docs/segmented-queue-cutover-evidence-2026-07-31.json`. Private rows, complete
migration plans, credentials, generated messages, webhook values, and signed
backup locations are excluded.

## Release and recovery gates

- `main` was pinned at `8a7e37406089aff59214c80db1f35afa842ea20c`.
- The build, generated-artifact drift, deployment policy, and 201-test release
  gate passed with 189 passes, 12 intentional skips, and zero failures.
- The restricted workbook archive hash is
  `93bedeaffd76004576e0d28d19e52409a5d8fd837dee9de9e8dccd1dc49add50`.
- The restricted workflow archive hash is
  `252f39f92c1147e5582ffcfc8e95aac285150f2dce9ff955f2eb96a23e64a53e`.
- Both encrypted archives were decrypted and parsed successfully. A private
  Drive copy restored the legacy workbook exactly, and an isolated n8n user
  folder imported the three prior workflow IDs successfully.
- A second owner-only workbook copy plus the isolated workflow restore proved
  that the legacy workbook and workflow definitions can be restored together.

## Disposable rehearsal

The native Sheets rehearsal migrated 79 identities with no loss or duplicate:

- `Scraped Jobs`: 44
- `To Review`: 2
- `To Apply`: 2
- `Applied Jobs`: 0
- `Archive`: 31

Headers, visibility, dropdowns, Search Keywords, protections, and the hidden
`_System` sheet were re-read after mutation. A second planner run proposed no
action, and a deliberately unsafe snapshot was refused.

Inactive n8n smoke copies proved new intake, immediate rediscovery without a
duplicate, fixed-five Generator isolation, every valid user action, forged
invalid-action rejection, a live Slack delivery, immediate alert no-replay,
and zero-loss movement. The first Alerter rehearsal timed out after establishing
a sending claim; the expired claim was terminalized without replay, and the
bounded retry completed successfully with a smoke-only timeout allowance.

## Production migration

The quiet window began with all three roles inactive, zero running or waiting
executions, and zero live `_System` claims. The final snapshot produced two
identical migration plan hashes.

`Review Queue` was renamed in place to preserve sheet ID `1540022097`.
`To Review` was created as sheet ID `2099002001`, and `To Apply` was created as
sheet ID `2099002002`. Four moved rows were copied and confirmed before source
deletion. Immediate reconciliation was 79 total and 79 unique identities, with
the same 44/2/2/0/31 destination counts as rehearsal. Applied Jobs, Archive,
Search Keywords, audit fields, and `_System` evidence were preserved exactly.

The final visible sheets are `Scraped Jobs`, `To Review`, `To Apply`,
`Applied Jobs`, `Archive`, and `Search Keywords`; `_System` remains hidden.
`Scraped Jobs` has no action dropdown, `To Review` permits only `Approve` and
`Deny`, and `To Apply` permits only `I Applied` and `Skip`.

## Workflow deployment and observation

The existing workflow IDs were updated in place and remain the only active
workflows:

- Scraper `qxPbOzNs5StaPY8B`, version
  `2edabeb3-8295-4ba6-90bd-f13475fb2a7f`
- Evaluator & Generator `TRUqD9atneyDyMNx`, version
  `9e975a9d-233c-4c9f-a17a-8a540be00067`
- Alerter & Mover `QO6OLK3pHetgGIGq`, version
  `31302b6a-3d9f-4b1d-b954-7650842faf65`

The persistent launch-agent Keychain binding was updated to the exact
`To Apply` deep link before activation. An attempted activation detected the
old launcher value and failed its environment gate; all roles were immediately
unpublished with zero live executions, the persistent value was corrected,
and activation was retried consumer-first.

Scheduled production observations were:

- Alerter execution `6714`: one success in 19.35 seconds.
- Generator execution `6715`: one success in 193.38 seconds.
- Alerter execution `6716`: one success in 32.90 seconds.
- Alerter execution `6723`: one success in 23.53 seconds.

Successful payload retention is disabled, so completed trigger executions are
soft-deleted while aggregate insights retain the success count and duration.

Controlled production paths added five new identities once, replayed the same
window without a duplicate, isolated Generator outcomes, moved review and
ready results to their focused queues, archived skips, delivered one new Slack
alert from `To Apply`, and left all ready rows unchanged on immediate replay.
The final observed business count was 84 total and 84 unique:

- `Scraped Jobs`: 40
- `To Review`: 4
- `To Apply`: 3
- `Applied Jobs`: 0
- `Archive`: 37

The first post-observation snapshot contained only valid, unexpired discovery
and Generator leases. After their bounded leases expired, the rehearsed
Alerter cleanup removed all ten rows; a direct `_System` reread at
`2026-07-31T15:12:33Z` returned only the header, proving zero residual,
expired, or malformed claims. The three `To Apply` records remained `sent`
with no alert claim and no retry state. The retained old workbook modification
time remained `2026-07-31T00:39:57.233Z`, confirming no old-workbook write.

## Rollback disposition

No production rollback trigger remained after reconciliation. The disposable
compatibility-unit restore passed, while the encrypted pre-cutover workbook
and workflow archives remain available if a later rollback is required.
