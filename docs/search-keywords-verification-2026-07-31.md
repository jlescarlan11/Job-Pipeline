# Search Keywords rollout verification — 2026-07-31

This record covers repository, disposable-workbook, deployment, and production
verification for Issues #51, #52, and #53.

## Repository implementation and release gate

The implementation source is branch `codex/search-keywords-sheet`, pull request
#54. Commit `56243802aaed8fb01a0e3bf83f773f1a881572a9` was pushed before the
production mutation. The generated Scraper contains 26 nodes and no embedded
runtime keyword catalog. Its one `Get Search Keywords` read precedes the
immutable Capture node and every OnlineJobs.ph request.

Before deployment:

- `npm run build` completed and generated no repository drift;
- `npm run validate` passed 188 tests: 176 passed, 12 intentional skips, and
  zero failures;
- deployment policy `2026-07-31/v2` and the live n8n environment passed;
- the generated 26-node Scraper imported and re-exported under isolated n8n
  2.32.6; and
- JavaScript, generated Apps Script, secret, endpoint, and exact-role scans
  passed.

## Disposable workbook and inactive smoke

The native Google Sheet used for the controlled smoke is recorded in
`outputs/search-keywords-20260731/nonproduction-verification.json`. Setup
created exactly four visible tabs—`Review Queue`, `Applied Jobs`, `Archive`,
and `Search Keywords`—plus hidden `_System`. All three business tabs remained
empty. The Search Keywords tab had exact `enabled` and `keyword` headers, ten
first-creation seeds, strict checkboxes, a frozen/filterable header, and one
warning-only generated header protection.

After an operator-style edit, disable, reorder, and addition, a setup-equivalent
second run made no value writes and preserved every keyword value. The inactive
26-node smoke workflow was not rebuilt or reimported between configuration
changes:

1. the first valid execution captured two enabled disposable keywords, one
   fixed window, and excluded nine disabled rows;
2. the sheet was edited and one keyword disabled; and
3. the next execution captured only the edited enabled value and did not
   retain the previous or newly disabled value.

The OnlineJobs.ph source returned bounded partial coverage in this disposable
environment. Neither valid smoke made a claim or business-sheet write.

Duplicate-normalized, enabled-blank, malformed-enabled, no-enabled, and
missing-sheet/read-failure executions all failed at or before Capture. Each
case recorded zero source-request outputs, zero claims, and zero business-sheet
writes. The sheet name and strict checkbox validation were restored, and the
non-production workflow remains inactive.

## Production setup and deployment

The read-only pre-deployment record is
`outputs/search-keywords-20260731/production-predeployment-baseline.json`.
It records:

- exactly the three active production roles;
- the original 25-node Scraper version
  `49ab515e-7585-48b1-8cea-3338b8cf441c`;
- the original four-tab workbook, 69-field business contract, row/identity
  counts, and three normal Generator leases;
- the retained old workbook timestamp and zero active replacement bindings;
  and
- a permission-restricted 25-node rollback export with SHA-256
  `81523a35a8b76169c20264ae3dd294f90b248031f37225c04f0203e7d30dd768`.

Production setup added visible `Search Keywords` as sheet ID `34991351` with
the exact ten enabled seeds. A direct reread confirmed strict checkbox
validation, the header format, a frozen row, filter, and header protection.
Business identity counts remained unchanged by setup. A second setup-equivalent
run deleted and recreated only the generated header protection, reapplied
formatting and validation, made no value writes, and preserved all ten seed
rows exactly.

The rebuilt Scraper was imported only after a normal in-flight Alerter
execution finished. It retained workflow ID `qxPbOzNs5StaPY8B`, Google Sheets
credential binding, production workbook environment binding, role, Manila
timezone, 900-second timeout, and cron
`0 8 0,4,8,12,16,20 * * *`. Published version
`7ac5ea80-4d2c-437e-a7b8-b3e73e12acbb` is active. All nine Google Sheets
nodes are bound. Normalized deployed and repository artifacts share SHA-256
`cb4aca7affe0c0d1bb8d641386bd342f365bd1728a28258a2926ccaa759baafa`.
Post-deployment inventory contains exactly one active Scraper, one active
Evaluator & Generator, and one active Alerter & Mover.

## Production scheduled observation

The real 2026-07-31 16:08 PHT scheduled Scraper execution was observed as
trigger execution `6673` against the active 26-node version. It entered
`running` at the expected boundary. The configured success-retention policy
then pruned the execution row; the Scraper trigger-success metric increased by
one while the trigger-error metric remained unchanged.

The execution read the operator-managed configuration and used one fixed
24-hour window from `2026-07-30T08:08:01.865Z` through
`2026-07-31T08:08:01.865Z`. Four values added by an operator after the initial
setup were present in saved match provenance, proving that the scheduled run
used the Sheet rather than the former catalog. The reconciliation/coverage
path completed; its bounded coverage field was computed but not retained after
the successful execution was pruned.

The Scraper created 54 Review Queue rows and rediscovered one existing row.
All 54 new `posted_at` timestamps fell inside the fixed window. The immediate
post-Scraper state contained 55 Review Queue rows, zero Applied Jobs rows, 14
Archive rows, and 69 unique canonical identities across all three business
stores. There were zero cross-store duplicates, 13 multi-keyword Review Queue
rows, and zero automatic submissions.

All 54 discovery claims had distinct claim keys, identities, and tokens tied
to execution `6673`. They expired at 16:28:01 PHT. The first cleanup boundary
after expiry, execution `6675` at 16:29 PHT, removed them; a direct reread at
16:29:46 PHT found zero discovery claims.

The downstream contracts also remained compatible:

- Generator execution `6676` selected and completed five rows, producing four
  `skip` decisions and one new `review_needed` decision. It left no processing
  stage, token, or retry ownership in Review Queue.
- Alerter execution `6677` moved the four `skip` rows to Archive. The durable
  state then contained 51 Review Queue rows—49 `new` and two
  `review_needed`—zero Applied Jobs rows, and 18 Archive rows, all `skip`.
- The five short-lived Generator/movement leases were removed by the next
  Alerter cleanup execution, `6678`; a direct `_System` reread at 16:59:51 PHT
  found zero claims.
- Across the final 69 business rows there were still 69 unique canonical
  identities and no cross-store duplicate.

The retained old workbook modified time remained exactly
`2026-07-31T00:39:57.233Z`, and all active Google Sheets nodes use the
production environment binding with zero old-workbook literal hits. Final
inventory still contains exactly the three expected active roles; after cleanup
retention completed, the listener was healthy with zero running/waiting
pipeline executions. The sanitized permanent record is
`outputs/search-keywords-20260731/production-deployment-verification.json`.
After adding the permanent evidence and its field-level assertions, the final
`npm run build` and `npm run validate` gate passed 190 tests: 178 passed, 12
intentional skips, and zero failed. Artifact drift, deployment policy, live
environment, syntax, secret, and application-endpoint checks also passed.

## Safety and rollback

No workflow in this rollout submits an application or spends Apply Points.
Evidence contains bounded counts, hashes, IDs, timestamps, statuses, and error
categories; it excludes credentials, authorization data, job descriptions,
complete sheet rows, prompts, model responses, and application messages.

If a future production gate fails, the prior restricted Scraper export can be
restored under the same workflow ID, published, and revalidated before its
schedule resumes. The Search Keywords tab and all business data would be
preserved for diagnosis. Every rollout gate passed, so no rollback was
required or performed.
