# Quota-safe Alerter & Mover rollout evidence — 2026-08-02

This record is the sanitized production evidence for issues #60–#63. It
contains bounded identifiers, counts, hashes, statuses, and timestamps only.
Private Google Drive IDs, workbook IDs, credential IDs, webhook values,
messages, descriptions, provider bodies, and authorization values are omitted.

## Release identity and gates

- Baseline: `5476c437ad62cf0a676bd8d284fed3e53d945924`.
- Issue commits: `3954a59` (#60), `de04bf6` (#61), and `6507a1c` (#62).
- Target workflow: `QO6OLK3pHetgGIGq`, updated in place.
- Generated Alerter artifact: 179 nodes, inactive in the repository, 300-second
  timeout, `Asia/Manila`, schedule minutes 10/25/40/55, and no OnlineJobs
  application endpoint.
- Final artifact SHA-256: `f7a756f59b483988dedd28ccb9d9127cdf87377a0de44c0b19185542e0e0e33b`.
- Private credential-bound deployable SHA-256:
  `84e6b5fa3579b89d08e7187ddb0395088235481bc5043182a30e2322f10e2515`.
- `npm run validate`: 247 tests, 235 passed, 12 intentional legacy skips,
  zero failures. Artifact drift, deployment policy, receipt policy, generated
  Code syntax, and no-auto-apply gates passed.

## Recoverable backup and rollback boundary

The private local backup directory is permission-restricted. The production
workflow backup has SHA-256
`4c9589371d8a73474e8f65aed9e1ef0cec9728ffb96356eec32b2a06a18689d6`;
the pre-cutover n8n database has SHA-256
`dca838d8709fc6a5718de061bcc61215a79f03cf729f92d50c292f642301fc73`
and passed SQLite integrity; the empty receipt-store backup has SHA-256
`4a8bbc04783656bfcd5229ec085ab0065bfc0399537ac4a0c80ab49e6e24f94e`,
passed integrity, and contained zero receipt rows. Configuration, launcher, and
launch-agent backups have hashes `c4e9a0fd…`, `69134d1d…`, and `e9a39ccb…`
respectively and were captured before mutation.

Two private Drive copies preserve the Main and Configuration workbooks. They
were reread and matched their expected names and sizes. Committed evidence
refers to them only as `private://main-workbook-backup` and
`private://configuration-workbook-backup`.

Rollback was rehearsed in the disposable instance: the 120-node pre-cutover
workflow imported and published under the same workflow ID with its original
120-second timeout; the empty receipt-store database restored with integrity;
the rebuilt inactive workflow then reimported under that same ID. Production
rollback requires stopping the three pipeline services, confirming no running
or waiting execution, restoring the workflow/database or private workbook
copy as appropriate, and rechecking the exactly-three-active inventory before
reactivation.

## Disposable verification

All provider and Sheet failure injection ran only against an inactive,
webhook-triggered disposable copy, loopback mocks, a disposable workbook, and
a disposable receipt table.

| Execution | Scenario | Result |
| --- | --- | --- |
| `6953` | Empty/no-op | `no_eligible_work`; one logical Sheet read; no mutation or provider call |
| `6954` | Movement | One `Scraped Jobs` automatic skip completed copy-confirm-delete into Archive; four reads |
| `6960` | Slack accepted | One provider request; durable `delivered` then `reconciled`; six reads |
| `6961` | Exact replay | No eligible work and no second provider request |
| `6963` | Slack HTTP 503 | Durable `retryable_rejection`; movement remained independent |
| `6964` | Restart after 503 | Receipt remained retryable and no duplicate provider request occurred |
| `6965` | Slack HTTP 200, Sheet result write failed | Receipt stayed durable `delivered`; business row stayed `sending`; one provider request |
| `6966` | Restart/reconciliation | Business row reconciled without a second provider request |
| `6971` | Google Sheets HTTP 429 | 429 then 200 after 65.9 seconds; original trigger timestamp preserved; one quota retry; clean `no_eligible_work` summary |

The route matrix and repository tests additionally cover every existing
Scraped/Review/Apply/Applied/Archive route, stale source, destination repair,
descending deletion, claims, cap enforcement, and manual submission boundary.
Mock Slack retained only timestamp, response mode, body length, and payload
hash; it never retained the body. The receipt schema has exactly 20 allowlisted
columns and excludes complete messages, descriptions, profile context,
webhook/credential/authorization values, and raw responses.

Disposable verification found and fixed three rollout defects before the
final release: raw JSON request serialization could report a local circular
object error after Slack had accepted the POST; nested HTTP status values were
not classified; and n8n capped the configured retry interval at five seconds.
Slack now uses the node's JSON-body field and accepts only the exact plaintext
`ok` acknowledgement, provider classification reads nested status, the first
business snapshot uses an explicit 65-second Wait, and later Sheet reads have
no automatic in-execution retry.

## Production cutover and scheduled evidence

Before cutover there were no active movement/alert claims, the receipt table
had the exact 20-column schema and zero rows, and no execution was running or
waiting. Credential references were bound to all 33 Google-capable nodes. The
launcher injects the receipt-table binding from the private credential store.
After update-in-place and activation, n8n 2.32.6 was healthy and exactly the
Scraper, Evaluator & Generator, and Alerter & Mover were active.

Scheduled execution `6949` started at `2026-08-02T09:10:00.387Z` and completed
successfully. It performed three copy-confirm-delete moves (two To Review →
Scraped Jobs and one To Review → Archive), touched only those three stores,
used four logical Sheet reads, emitted `completed_with_work`, and reported no
alert or error category. This was a schedule-triggered state-changing run, not
a manual execution.

Scheduled execution `6950` started at `2026-08-02T09:25:00.380Z` and completed
successfully at `2026-08-02T09:25:57.223Z`. One clearly labelled authorized
canary progressed through durable `pending → sending → delivered → reconciled`.
Slack returned accepted/200, the provider node ran exactly once, receipt
attempt/version ended at 1/4, and the matching To Apply row ended `sent` with
the same accepted provider classification. Its final summary reported one
selected, one delivered, one reconciled, zero retryable/terminal, six logical
Sheet reads, zero quota retries, and no error category. The explicit quota Wait
did not run. This was a schedule-triggered provider run, not a manual execution.

Scheduled execution `6951` started at `2026-08-02T09:40:00.416Z` and completed
successfully at `2026-08-02T09:41:11.110Z`. The previously reconciled receipt
remained at attempt 1/version 4 and the Slack provider node ran zero times. A
concurrent terminal canary action produced one copy-confirm-delete move from To
Apply to Archive; the final summary reported one move, zero selected/delivered/
reconciled/retryable/terminal alert outcomes, five logical Sheet reads, zero
quota retries, and no error category. This proves movement remained independent
and the delivered alert was not replayed.

Scheduled execution `6952` started at `2026-08-02T09:55:00.384Z` and completed
successfully at `2026-08-02T09:55:15.523Z`. It emitted
`no_eligible_work`, made zero mutations and zero provider calls, used one
logical Sheet read, performed zero quota retries, and reported no error
category. The archived canary and reconciled receipt were unchanged, proving
the same terminal source state produced neither a duplicate move nor a
duplicate Slack message.

## Privacy and cleanup

Only a clearly labelled, authorized production canary is used for live Slack
proof. Historical `terminal_failure` rows are never reset or replayed. The
canary does not submit an application or spend Apply Points. After execution
`6952`, exact canonical-ID searches found and cleared the one synthetic Archive
row and its one expired movement claim. Rereads found the canonical ID in none
of the five business stores or `_System`, and `_System` contained only its
header. The reconciled durable receipt remains as bounded no-replay evidence.

Temporary successful-execution retention is enabled only during the bounded
observation window. The final deployment restores
`saveDataSuccessExecution=none` and `saveExecutionProgress=false` while
retaining failures, so complete successful execution payloads do not remain a
long-term production data store.

## Final production state

The standard 179-node bound artifact is restored after observation at active
workflow version `644b9d1a-5671-4b1f-aa76-38a1eec95579`. Successful execution
retention and progress saving are disabled. After their sanitized summaries
were committed to this record, only the raw execution-data blobs for successful
observation executions `6949`–`6952` were removed; their bounded status/trigger/
timestamp metadata remains. n8n health is 200, exactly three workflow roles are
active, no execution is running or waiting, the receipt table still has one
reconciled attempt-1/version-4 canary receipt, and there are no operational
claims.
