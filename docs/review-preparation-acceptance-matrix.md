# Review/preparation acceptance matrix

Evidence baseline: `npm run validate` completed on 2026-08-04 with 314 tests,
302 passed, 12 intentionally skipped, zero failed; workflow and Sheet artifacts
had no drift. Production deployment, live data mutation, workflow activation,
and live observation were not authorized in this change set. Issue #78 criteria
that require those actions remain `BLOCKED` or `PARTIAL`; repository proof is
not presented as live proof.

## Issue #75 — monotonic review/preparation contract

| ID | Required observable behavior | Implementation and direct evidence | Status |
| --- | --- | --- | --- |
| 75-01 | Exact Proceed/Reject and I Applied/Skip Sheet controls | `pipeline-schema.json`, `review-sheet.json`, generated setup; setup/contract tests | SATISFIED |
| 75-02 | Stable review case and immutable resolution audit | `reviewCaseId`, review version/decision/decided fields; contract and movement tests | SATISFIED |
| 75-03 | Seven independent preparation states | Versioned schema and transition matrix; exhaustive lifecycle tests | SATISFIED |
| 75-04 | To Apply ownership remains ready_to_apply while non-ready | Store contract and message-safety gates; contract tests | SATISFIED |
| 75-05 | message_ready requires current pack/message provenance | Contract validation plus persisted message safety; message-safety tests | SATISFIED |
| 75-06 | needs_input/external_steps require safe bounded checklist | Field bound, unsafe-control rejection, state requirements; invalid-input tests | SATISFIED |
| 75-07 | Missing legacy preparation defaults fail safe | `normalizeLegacyRecord` maps ready legacy rows to preparation_error/v0; migration tests | SATISFIED |
| 75-08 | Legacy Approve/Deny classify but are never emitted | Pure mapping to Proceed/Reject; UI/config exact-value tests | SATISFIED |
| 75-09 | Invalid store/status/action/preparation rejected pre-write | Store contract validation at claims/commits/moves; negative matrix tests | SATISFIED |
| 75-10 | Setup rerun idempotent and preserves rows/operator values | Fresh setup reconciliation; populated/empty rerun tests | SATISFIED |
| 75-11 | Existing identity/version/guard/movement/history/manual boundary preserved | Integrated contract, movement, terminal, and no-submission suites | SATISFIED |
| 75-12 | Direct contract/setup/legacy/transition/empty tests | `simplified-contract`, setup, migration, and end-to-end suites | SATISFIED |
| 75-13 | Generated setup rebuilt; build/validate clean | `npm run check:artifacts` and `npm run validate` | SATISFIED |

## Issue #76 — prepare proceeded jobs in To Apply

| ID | Required observable behavior | Implementation and direct evidence | Status |
| --- | --- | --- | --- |
| 76-01 | Select pending/repair/retry To Apply in place | `stageForCandidate`/`selectGeneratorCandidate`; lifecycle tests | SATISFIED |
| 76-02 | One deterministic global five-item batch, sequential, no backfill | Combined-store sort/cap and generated loop; batch/workflow tests | SATISFIED |
| 76-03 | Source/store/identity/review/prep/version/guard claim protection | Source-qualified claims and persisted exact reread; stale-field tests | SATISFIED |
| 76-04 | Valid result becomes message_ready while ready_to_apply | `applyValidatedGeneration` and commit contract; generation/e2e tests | SATISFIED |
| 76-05 | Missing candidate input becomes bounded needs_input in To Apply | Preparation classifier; missing/partial coverage tests | SATISFIED |
| 76-06 | Human employer work becomes external_steps without completion claim | External action classifier/render boundary; external-step tests | SATISFIED |
| 76-07 | Repair and operational errors remain distinct/bounded | repair_pending/preparation_error mapping and retry metadata tests | SATISFIED |
| 76-08 | Same review/input cannot recreate review_needed | Proceeded branches always remain To Apply; no-loop tests | SATISFIED |
| 76-09 | New review requires material fingerprint/reason/audit | Stable case digest excludes volatile data; new-case tests | SATISFIED |
| 76-10 | Paused rows do not hot-loop; guarded input change resumes | selection guard/version gate; unchanged/changed rerun tests | SATISFIED |
| 76-11 | Every stale ownership/identity/review/prep/record/token fact rejects affected commit | `commitGeneratorResult` exact comparisons; stale concurrency tests | SATISFIED |
| 76-12 | Commit-confirm/expired-claim failure recovers without stranding or losing prior safe output | persisted completion is not reselected; expired `preparing` lease and prior-safe-message tests | SATISFIED |
| 76-13 | Existing direct/skip/unavailable/error/malicious/repair/isolation behavior | Generator/evaluation/e2e regression suite | SATISFIED |
| 76-14 | Generated workflow binds both sources, inactive, safe | dynamic source-store Sheet nodes, environment bindings, graph safety tests | SATISFIED |
| 76-15 | Lifecycle/concurrency/failure/shape/e2e tests updated | Generator, workflow, claim, evaluation, and e2e suites | SATISFIED |
| 76-16 | Build/validate and artifact drift clean | `npm run validate` | SATISFIED |

## Issue #77 — guarded Proceed movement and preparation-aware alerts

| ID | Required observable behavior | Implementation and direct evidence | Status |
| --- | --- | --- | --- |
| 77-01 | Proceed copies to To Apply pending with audit/action clearing | Movement destination builder; Proceed route test | SATISFIED |
| 77-02 | Delete only after exact destination confirmation | `validExistingDestination`/`confirmMoveDeletions`; confirmation tests | SATISFIED |
| 77-03 | Stale terminal/review actions preserve newer source | explicit fresh action/version/guard checks; stale tests | SATISFIED |
| 77-04 | Concurrent/repeated Proceed yields one owner | identity upsert and append-winner claim; concurrency tests | SATISFIED |
| 77-05 | Append success/delete failure recovers without another append | exact destination recognized as recovery; phase/movement tests | SATISFIED |
| 77-06 | Resolved same fingerprint cannot return to review | `resolved_review_case_repeated` suppression; regression test | SATISFIED |
| 77-07 | Materially new fingerprint may enter review with reason | review-case derivation and explicit reason checks; new-case test | SATISFIED |
| 77-08 | Reject/Skip/I Applied remain idempotent human terminal moves | route table and terminal audit preservation tests | SATISFIED |
| 77-09 | I Applied preserves truthful observed preparation path | destination record preserves preparation/audit context; applied tests | SATISFIED |
| 77-10 | Copy-ready requires To Apply/message_ready/current safety/blank action | alert category + shared message safety; eligibility tests | SATISFIED |
| 77-11 | Every non-message-ready state excluded from copy-ready | full preparation-state matrix tests | SATISFIED |
| 77-12 | Reminders are distinct, bounded, safe, non-submission | reminder renderer/category/checklist policy; render tests | SATISFIED |
| 77-13 | Receipt key includes category/prep version/input identity | alert idempotency key; reminder→message-ready receipt test | SATISFIED |
| 77-14 | Safety rejection makes no request; provider ambiguity remains bounded | selection before provider and receipt outcome model; failure tests | SATISFIED |
| 77-15 | Global move cap, per-sheet delete order, failure isolation | movement planner/deletion ordering/result-item tests | SATISFIED |
| 77-16 | Manual and scheduled execution use identical guarded graph | manual-trigger block removed; single generated route path and graph tests | SATISFIED |
| 77-17 | Summary exposes required bounded counts without content | `summarizeAlerterMoverRun`; summary/privacy tests | SATISFIED |
| 77-18 | Terminal dedup/receipt recovery/claim recovery/no-auto-application preserved | receipt, claims, movement, graph safety suites | SATISFIED |
| 77-19 | Direct movement/alerts/safety/receipt/concurrency/e2e tests | named suites in validation baseline | SATISFIED |
| 77-20 | Build/validate and artifact drift clean | `npm run validate` | SATISFIED |

## Issue #78 — production migration and lifecycle cutover

Blocker for every live criterion: the governing authority explicitly prohibits
deployment and production data mutation in this run. The repository now makes
the later maintenance window deterministic and fail-closed, but no live result
is inferred from unit tests.

| ID | Required observable behavior | Repository evidence / remaining live evidence | Status |
| --- | --- | --- | --- |
| 78-01 | Exact deployed commit contains #75–#77; build/validate clean | Source unit is integrated and validates; no deployment commit was activated | PARTIAL |
| 78-02 | Sanitized pre-cutover workflow/binding/schema/claim/receipt/count inventory | Strict evidence validator requires it; no live capture authorized | BLOCKED |
| 78-03 | Readable rollback assets for every changed workflow/config/Sheet state | Required kinds and hashes validated; no live backups authorized | BLOCKED |
| 78-04 | Fresh global preflight stops duplicates/states/guards/claims/contracts | Pure planner and negative tests satisfy repository behavior; live reread absent | PARTIAL |
| 78-05 | Idempotent live setup preserves rows/operator values and seeds none | Setup behavior directly tested; live workbook upgrade absent | PARTIAL |
| 78-06 | Deterministic per-row migration plan with required fields/path/reason | `planReviewPreparationMigration`, CLI, repeat-equality tests | SATISFIED |
| 78-07 | All live relocation evidenced as Alerter copy-confirm-delete | Code and runbook prohibit direct moves; live movement evidence absent | PARTIAL |
| 78-08 | Proven stale duplicate rule and normal surviving path | Planner/runbook require backup+reread; no live duplicate action authorized | PARTIAL |
| 78-09 | Live blank/Deny/Approve outcomes follow new paths | Planner and integrated fixtures include the retired Scraped Jobs approval loop's one guarded v3 exit; live rows not migrated | PARTIAL |
| 78-10 | Legacy To Apply gets fail-safe prep; only current authorization message_ready | Planner authorization digest + guarded v3 claim tests; live rows absent | PARTIAL |
| 78-11 | Five named IDs each have one live owner and outcome | Validator requires exact IDs; no live inventory authorized | BLOCKED |
| 78-12 | Proceeded named cases do not reopen during observation | Validator requires zero repeated cases; no live observation authorized | BLOCKED |
| 78-13 | Live copy-ready/reminder controls have correct at-most-once delivery | Unit/receipt matrix passes; no live Slack/provider evidence | BLOCKED |
| 78-14 | Unchanged paused live rows are not re-prepared/reminded | Selection/receipt tests pass; no scheduled observation | BLOCKED |
| 78-15 | Controlled live input/version change resumes once then alerts once | Unit lifecycle test passes; no controlled live mutation authorized | BLOCKED |
| 78-16 | Deliberate manual and scheduled live runs have identical semantics | One generated path exists; comparative live executions absent | BLOCKED |
| 78-17 | Disposable-copy partial failure and stale-action controls | Deterministic repository simulations pass; required copied-workbook run absent | BLOCKED |
| 78-18 | Exactly one active production role each | Policy pins IDs and validator enforces uniqueness; activation prohibited | BLOCKED |
| 78-19 | Bounded live post-cutover counts/evidence | Validator enforces counts/privacy/duration; observation absent | BLOCKED |
| 78-20 | Existing lifecycle and no-auto-application behavior remains functional | Full integrated repository regression suite passes | SATISFIED |
| 78-21 | Rollback triggers/order/limits/duration documented; no manual moves | `review-preparation-cutover.md` and validator | SATISFIED |
| 78-22 | No workflow applies, tests, attaches, or spends points | Generated graph scan and no-auto-application tests | SATISFIED |

## Change-set accounting ledger

| Change unit | Provenance | Contract/consumer review | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `config/pipeline-schema.json`, `config/review-sheet.json` | #75 | Contracts, setup, all business stores, workflow mappings, docs/tests inspected | High/data contract | REVIEWED_AFTER_FIX |
| `src/contracts.mjs` | #75/#78 | State guard, legacy one-claim bridge, review/prep validation and direct callers inspected | High/concurrency | REVIEWED_AFTER_FIX |
| `src/fresh-sheet-setup.mjs`, `scripts/build-sheet-setup.mjs`, generated `SheetSetup.gs` | #75 | Idempotency, preservation, validation/dropdowns, artifact source checked | High/data preservation | REVIEWED_CLEAN |
| `src/generator.mjs` | #76/#78 | Selection, claim, provider boundary, commit confirmation, legacy claim inspected | High/provider/concurrency | REVIEWED_AFTER_FIX |
| Generator builder and generated workflow | #76 | Both source sheets, dynamic store writes, batch/cap, inactive/no-submit graph inspected | High/workflow | REVIEWED_AFTER_FIX |
| `src/movement.mjs` | #77 | Route classification, exact destination, partial recovery, deletion guards inspected | High/data movement | REVIEWED_AFTER_FIX |
| `src/alerter-mover.mjs`, `src/message-safety.mjs`, `config/alert-policy.json` | #77 | Eligibility, reminder safety, receipt identity, stale result, summary inspected | High/notification | REVIEWED_AFTER_FIX |
| Alerter builder and generated workflow | #77 | Single manual/scheduled route, copy-confirm-delete, receipt/provider isolation inspected | High/workflow | REVIEWED_CLEAN |
| `config/n8n-deployment-policy.json`, `src/n8n-deployment.mjs` | #75–#78 | Exact artifact digests, compatibility unit, one-claim v3 rule inspected | High/deployment | REVIEWED_AFTER_FIX |
| `src/review-preparation-cutover.mjs` and two CLI scripts | #78 | Read-only plan, global preflight, evidence privacy, no-write boundary inspected | High/migration | REVIEWED_AFTER_FIX |
| Review/preparation documentation and evidence scaffold | #75–#78 | Current routes/states/actions, maintenance/rollback authority, no false live claim inspected | Medium/operations | REVIEWED_AFTER_FIX |
| Direct and integrated test changes | #75–#78 | Positive, negative, stale, concurrent, partial, privacy, workflow-shape paths inspected | Medium/verification | REVIEWED_CLEAN |
| Rebuilt Scraper artifact | compatibility unit | Source unchanged; digest changed because embedded shared contract changed; policy pinned | High/generated | REVIEWED_CLEAN |

Consolidated review lanes completed against the final source state: data
integrity/copy-confirm-delete, stale/concurrent claims, provider and message
safety, migration fail-closed behavior, evidence privacy/secret leakage,
generated-workflow shape, deployment compatibility, rollback/manual boundary,
and cross-issue end-to-end regression. No verified repository finding remains
open. Live #78 evidence remains blocked rather than waived.
