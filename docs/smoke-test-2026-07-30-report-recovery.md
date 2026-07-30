# Analytics and Recommender recovery evidence — 2026-07-30

This record covers the report-persistence correction and recovery procedure in
issues #33 and #34. It intentionally omits credentials, workbook URLs, private
workbook identifiers, and application-row payloads.

## Safeguards

- Both corrected workflows were imported inactive with Manual Triggers on
  private workbook copies before any production workflow change.
- Private timestamped production-workbook copies were created at 19:40 PHT
  and immediately before cutover at 20:35 PHT.
- The published pre-cutover Analytics and Recommender workflows were exported.
  The final pre-cutover export SHA-256 hashes are
  `a0c886fdcf0ebed2d2ffefd416cc2494b12977ca7fea4edfa903661ac9b7aa14`
  and
  `623c759b80f9880b3e0004d1ca567bde95c9ebf3d20d0a66807ddbc2301faaef`.
- Production report identities were audited before cutover. No duplicate,
  case-variant, formula, or conflicting identities were found. One
  execution-scoped failed Recommender detail group from execution 6456 had no
  metadata and remained non-authoritative history.
- No rerun began before its report-store claim lease expired.

## Repository validation

- `npm run build`: passed.
- `npm run validate`: passed, 300 tests.
- `git diff --check`: passed.
- `node --check` across `scripts`, `src`, and `tests`: passed.
- Generated-artifact checks confirmed the repository exports were reproducible.

## Copied-workbook integration evidence

| Gate | Execution | Authoritative result |
| --- | ---: | --- |
| Non-empty Analytics | 6469 | 134 exact detail rows and one `status=complete` report; 933 records, 189 applications |
| Non-empty Recommender | 6470 | One exact detail row and one matching `status=complete`, `result=abstained` report consuming the Analytics report from execution 6469 |
| Analytics mismatch | 6474 | Stopped at `Prepare Analytics Completion`; no metadata was published; the error was the intended content mismatch, not `ReferenceError` |
| Recommender mismatch | 6472 | Published `status=failed`, `result=failed`, `error_category=detail_write_failure`; no `ReferenceError` |
| Empty Analytics recovery | 6476 | Reused the existing report identity, reconciled 50 unambiguous orphan detail rows without duplicates, and published one `status=complete` report with zero applications |
| Empty Recommender | 6478 | Published one exact detail row and matching `status=complete`, `result=empty` metadata consuming the recovered empty Analytics report |
| Unchanged Analytics reuse | 6480 | `publish_required=false`; neither the detail writer nor metadata writer executed |
| Unchanged Recommender reuse | 6481 | `publish_required=false`; neither the detail writer nor metadata writer executed |

The first copied-workbook Analytics attempt, execution 6466, exposed an
additional n8n resource-mapper behavior: optional numeric values declared as
number schema fields were converted from blank to zero before the Sheets
write. Completion correctly failed closed and published no metadata. The
writer schema now preserves optional blank numeric cells while
`USER_ENTERED` lets Sheets parse non-empty numeric strings. The strict
confirmation comparison was not weakened; blank-to-zero remains a mismatch.

The successful non-empty and empty paths preserved blank optional numeric
cells, contained no duplicate or case-variant identities, and did not mutate
the copied `Sheet1` or `Archive` source data.

## Unchanged-input reuse verification

Executions 6480 and 6481 ran only through their reuse and retention branches.
The four report-tab row counts and normalized snapshot hashes were identical
before and after both executions. The copied `Sheet1` and `Archive` source
snapshot was also identical.

## Production cutover

- Both corrected workflow versions were imported inactive. A runtime restart
  cleared cached registrations before either schedule was enabled.
- Analytics `r0FvLfoQKSPalo8u` was activated and restarted first. Recommender
  `K5XQEntq6bfpjcqU` was activated and restarted second.
- The obsolete Analytics copy `QyB5teEiv7ebrN8K` and obsolete Recommender copy
  `rMkW7qCsJ5WjPaPn` remained inactive.
- Post-activation exports confirmed the corrected writer and confirmation
  nodes match the repository artifacts. Every other node, connection,
  credential reference, workbook binding, and live workflow setting remained
  unchanged.
- Exactly one Analytics workflow is active at 02:00 daily and exactly one
  Recommender workflow is active at 02:45 Monday, both in `Asia/Manila`.
- Because n8n CLI execution does not start Schedule Trigger nodes, inactive
  verification copies `issue34ProdAnalyticsVerify0730` and
  `issue34ProdRecommenderVerify0730` replaced only the trigger with Manual
  Trigger. Their other 31 nodes and production bindings matched the active
  targets.
- Analytics verification execution 6484 changed the production report state
  from 676 to 1,022 detail rows and from three to four metadata rows. Its new
  complete report
  `analytics-2026-07-28-v1-7e8d7c6b11c97af94d0fe6c2230d1c282104cf11af00f442b284c745b113433e`
  had 346 exact detail rows, 981 records, and 192 applications.
- Recommender verification execution 6485 changed the production report state
  from six to seven detail rows and from five to six metadata rows. Its new
  complete, abstained report
  `recommendation-98a0bd4de606028ace12804e916dd0d345722ea210c6632c0fbcd2ea33651467`
  consumed the Analytics report from execution 6484 and had one exact detail
  row.
- The normalized production `Sheet1` plus `Archive` source snapshot hash
  remained `a01b0dd3` before and after both report executions.
- Both verification copies remained inactive, health and readiness returned
  HTTP 200, no execution remained in flight, and failed execution 6456
  remained visible after cutover.
