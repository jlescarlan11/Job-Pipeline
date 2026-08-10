# Autonomous browser acceptance matrix

Status labels:

- **SATISFIED** — implemented and covered by repository validation.
- **SOURCE READY** — the guarded source/tooling exists; external execution evidence is still required.
- **BLOCKED (live)** — requires an authorized maintenance window, real account/browser/task checks, or production observation. This change deliberately does not deploy, schedule, or merge anything.

The release command for source evidence is `npm run build && npm run check:artifacts && npm run validate:policy && npm run validate`. It currently passes with 377 tests: 365 passed, 12 intentional skips, and zero failures.

## Issue #82 — autonomous application and submission contract

1. **82-AC-01 — SATISFIED:** `profile-contracts.test.mjs` accepts explicit `autonomous_chrome` with `manual_submission_required=false`.
2. **82-AC-02 — SATISFIED:** recursive policy validation rejects daily maximum, budget, counter, and date-bucket fields; selection has no daily throttle.
3. **82-AC-03 — SATISFIED:** `simplified-contract.test.mjs` covers the complete guarded browser transition matrix and material state-guard changes.
4. **82-AC-04 — SATISFIED:** submission identity tests prove stability across attempt IDs and binding to job/form/profile/policy inputs.
5. **82-AC-05 — SATISFIED:** `submit_started` has no transition back to fill/retry; executor recovery rejects it.
6. **82-AC-06 — SATISFIED:** deterministic low-fit/hard-gap evaluation becomes `skipped` without an action.
7. **82-AC-07 — SATISFIED:** autonomous pack tests prove unknown commitments and unsafe steps become bounded blockers, never invented facts or review cases.
8. **82-AC-08 — SATISFIED:** autonomous store/action validation requires no `Proceed`, `Reject`, `I Applied`, or `Skip`.
9. **82-AC-09 — SATISFIED:** exact legacy normalization/movement tests retain the guarded manual routes without creating browser authority.
10. **82-AC-10 — SATISFIED:** contract, executor, movement, and migration fixtures reject stale guards, duplicate ownership, destination conflicts, invalid states, and malformed evidence before writes.
11. **82-AC-11 — SATISFIED:** fresh setup and generated Apps Script tests prove deterministic headers, validation, protection, guidance, and zero row creation/movement.
12. **82-AC-12 — SATISFIED:** v4→v5 migration tests classify supported, legacy, blocked, and rejected rows without writes.
13. **82-AC-13 — SATISFIED:** bounded evidence uses fixed category summaries and hashed references; tests exclude messages, descriptions, DOM, screenshots, cookies, credentials, and URLs.
14. **82-AC-14 — SATISFIED:** direct tests cover happy path, no cap, unknown facts, legacy records, duplicates, stale/concurrent guards, ambiguity, evidence, setup, and migration.
15. **82-AC-15 — SATISFIED:** the full suite retains identity, message safety, history, discovery, and copy-confirm-delete regressions.
16. **82-AC-16 — SATISFIED:** build and validation pass with no artifact drift.

## Issue #83 — deterministic browser-executor core

1. **83-AC-01 — SATISFIED:** claim tests require append-winner persistence and an exact reread before returning bounded context.
2. **83-AC-02 — SATISFIED:** system-claim arbitration permits at most one winning attempt.
3. **83-AC-03 — SATISFIED:** global five-store identity validation runs before selection or claim output.
4. **83-AC-04 — SATISFIED:** a persisted context digest binds the bounded job plus exact profile/ranking/application/pack policies and remains mandatory through fill/click/result; no credential field is exposed.
5. **83-AC-05 — SATISFIED:** a validated apply result persists the current pack, message provenance, form fingerprint, and stable submission identity before fill eligibility.
6. **83-AC-06 — SATISFIED:** evaluation/message/pack tests reject unsupported facts, numbers, URLs, commitments, missing answers, injection, stale policy, and invalid state before fill/click capabilities.
7. **83-AC-07 — SATISFIED:** deterministic non-recommendation can skip with a trusted bounded reason and no review.
8. **83-AC-08 — SATISFIED:** ambiguous/noisy evaluation cannot be model-skipped or applied.
9. **83-AC-09 — SATISFIED:** submit planning returns only an exact `submit_started` proposal; the one-click capability is returned only after persistence and reread.
10. **83-AC-10 — SATISFIED:** a crash in `submit_started` cannot re-enter selection, fill, ordinary recovery, or a second submit.
11. **83-AC-11 — SATISFIED:** result commit binds attempt, job/context/form digests, idempotency key, authorization digest, exact profile/ranking/application/pack provenance, processing ownership, and state guard.
12. **83-AC-12 — SATISFIED:** exact-reread tests reject stale rows, edits, lost claims, and mismatched job/form/submission digests.
13. **83-AC-13 — SATISFIED:** empty selection succeeds with `candidate=null`, `due_count=0`, and no write/browser capability.
14. **83-AC-14 — SATISFIED:** selector returns all due work; CLI takes one at a time and technical headroom leaves the remainder due without a quota/date counter.
15. **83-AC-15 — SATISFIED:** retryable pre-submit failures require future backoff and fixed-category evidence; unavailable, blocked, and ambiguous remain distinct.
16. **83-AC-16 — SATISFIED:** `browser-executor.test.mjs` covers the strict command schemas and lifecycle boundaries.
17. **83-AC-17 — SATISFIED:** all legacy evaluation, generation, safety, discovery, contract, and movement regressions pass.
18. **83-AC-18 — SATISFIED:** build and validation pass with no artifact drift.

## Issue #84 — autonomous Alerter & Mover routes

1. **84-AC-01 — SATISFIED:** exact current confirmation with blank action routes from `Scraped Jobs` to `Applied Jobs`.
2. **84-AC-02 — SATISFIED:** destination `applied_at` equals confirmation time and preserves browser/message/profile/policy provenance.
3. **84-AC-03 — SATISFIED:** exact autonomous `skipped` routes to `Archive` with `autonomous_skip` and no operator action.
4. **84-AC-04 — SATISFIED:** every nonterminal, blocked, retryable, and ambiguous browser state remains unmoved.
5. **84-AC-05 — SATISFIED:** malformed attempts, identities, provenance, timestamps, references, digests, and guards reject movement.
6. **84-AC-06 — SATISFIED:** complete destination/delete-failure reruns confirm the existing copy and retry only unchanged-source deletion.
7. **84-AC-07 — SATISFIED:** partial destination repair preserves destination-owned notes, outcomes, alert state, and stronger confirmation.
8. **84-AC-08 — SATISFIED:** movement append-winner contention authorizes one copy-confirm-delete path.
9. **84-AC-09 — SATISFIED:** confirmed movement is independent of Slack receipt/delivery state and independently re-verifies the persisted signed receipt against the pinned trust root.
10. **84-AC-10 — SATISFIED:** autonomous rows never emit copy-ready or `I Applied` reminders.
11. **84-AC-11 — SATISFIED:** optional operational alerts contain only a bounded category and safe open-only link.
12. **84-AC-12 — SATISFIED:** legacy `To Review` and `To Apply` action routes retain their existing guarded behavior.
13. **84-AC-13 — SATISFIED:** forged legacy actions on autonomous rows are rejected.
14. **84-AC-14 — SATISFIED:** direct mover/alerter tests cover routing, failures, contention, Slack independence, compatibility, and privacy.
15. **84-AC-15 — SATISFIED:** generated workflow tests require destination upsert, exact confirmation, and unchanged-source deletion for every move.
16. **84-AC-16 — SATISFIED:** build and validation pass with no artifact drift.

## Issue #85 — Chrome job-autopilot skill

1. **85-AC-01 — SATISFIED (fixtures):** the skill requires the exact canonical OnlineJobs page/source identity before form work.
2. **85-AC-02 — SATISFIED (fixtures):** changed, deleted, redirected, login, challenge, and unknown pages produce bounded no-fill results.
3. **85-AC-03 — SATISFIED:** the skill obtains ChatGPT context/draft authorization through #83 and never requires an n8n/Groq draft.
4. **85-AC-04 — SATISFIED:** rejection by #83 produces no fill or submit capability.
5. **85-AC-05 — SATISFIED (fixtures):** required authorized fields must be reread before submit intent.
6. **85-AC-06 — SATISFIED (fixtures):** Apply Points follow the current deterministic recommendation/resource field, never a daily budget.
7. **85-AC-07 — SATISFIED (fixtures):** missing facts, attachments, external work, CAPTCHA, agreements, credentials, and permission expansion stop with exact bounded categories.
8. **85-AC-08 — SATISFIED:** executor ordering makes persisted `submit_started` a prerequisite for the one-click capability.
9. **85-AC-09 — SATISFIED (fixtures):** definitive confirmation binds exact attempt/submission/configuration identity, time, reference hash, and an independently verified Ed25519 adapter attestation; unsigned or wrong-key results fail closed.
10. **85-AC-10 — SATISFIED (fixtures):** post-click uncertainty becomes `ambiguous` and cannot click again after restart.
11. **85-AC-11 — SATISFIED (fixtures):** prior ambiguity requires account/page reconciliation before any proven result.
12. **85-AC-12 — SATISFIED (contract):** the normal sequence contains no review, copy/edit, user click, or `I Applied` step.
13. **85-AC-13 — BLOCKED (live):** no real final-submit capability test or independent attestation adapter/key provisioning was authorized. The task contract and cutover validator forbid self-attested success, bypass, or zero-touch claims.
14. **85-AC-14 — SATISFIED:** fixtures cover standard/changed forms, required question, Apply Points, unavailable, login, challenge, CAPTCHA, upload/test/agreement, success, already applied, and ambiguous navigation.
15. **85-AC-15 — SATISFIED:** skill/protocol tests enforce verify → validate → fill/reread → persist intent → click → reconcile.
16. **85-AC-16 — SATISFIED:** skill, executor, fixture, and cutover privacy contracts exclude raw private browser/job/application content.
17. **85-AC-17 — SOURCE READY:** the explicit `job-autopilot-v1` skill and local fixture server are manually testable; normal-profile execution remains part of the live gate.
18. **85-AC-18 — SATISFIED:** skill validation and fixture tests are included in `npm run validate`; all regressions pass.

## Issue #86 — mixed runtime and Generator retirement

1. **86-AC-01 — SATISFIED:** artifact manifest requires exactly inactive `scraper.json` and `alerter-mover.json`; `generator.json` is deleted and unexpected exports fail.
2. **86-AC-02 — SATISFIED:** generated-Code scans reject Generator evaluation, Groq requests, application prompt/message generation, Chrome control, and submit paths.
3. **86-AC-03 — SATISFIED:** runtime validation requires one Scraper, one external browser executor, and one Alerter & Mover with exact ownership.
4. **86-AC-04 — SATISFIED:** browser-task configuration pins protocol, skill, full profile/ranking/application/pack configuration, policy/schema, Chrome URI/hosts, independent-attestation boundary, project mode, Manila schedule, timeout, claim, retry/headroom, and provenance digests.
5. **86-AC-05 — SATISFIED:** deployment compatibility hashes reject schema/profile/ranking/application/pack/executor/skill/mover/runtime drift; the executor bundle includes all transitive local code plus `AGENTS.md`.
6. **86-AC-06 — SATISFIED:** recursive runtime/policy tests reject application daily limits, counters, budgets, and date buckets.
7. **86-AC-07 — SATISFIED:** continuation is defined only by technical headroom, claims, recovery, and the next scheduled run.
8. **86-AC-08 — SATISFIED:** relocation-marker scans permit copy-confirm-delete only in Alerter & Mover.
9. **86-AC-09 — SATISFIED:** both n8n artifacts have `active=false`; task source has `inactive_unscheduled`; build performs no registration/activation.
10. **86-AC-10 — SATISFIED (validator):** production-evidence validation requires exactly one mixed-role set and rejects an active Generator or duplicate task.
11. **86-AC-11 — SATISFIED (validator):** rollback evidence pins prior workflows/Generator/task/compatibility assets and exact disable/restore order.
12. **86-AC-12 — SATISFIED:** deployment/runtime tests cover missing/extra roles, stale hashes, active residue, duplicates, bindings/timezone, headroom, forbidden code, and movement ownership.
13. **86-AC-13 — SATISFIED:** historical evidence remains unchanged and sanitized; legacy runtime fixtures are isolated.
14. **86-AC-14 — SATISFIED:** build, artifact check, policy validation, and full validation pass.

## Issue #87 — production migration and activation

1. **87-AC-01 — SOURCE READY:** #82-#86 source gates pass, but the reviewed commit is not merged to clean remote `main` and therefore is not a deployment commit.
2. **87-AC-02 — BLOCKED (live):** no authorized pre-cutover workflow/task/workbook inventory was captured.
3. **87-AC-03 — BLOCKED (live):** no authorized production backups or restore identifiers were created.
4. **87-AC-04 — SOURCE READY:** the fail-closed global preflight validator exists and is tested; no fresh private production reread was authorized.
5. **87-AC-05 — SOURCE READY:** the structural v4→v5 upgrade is idempotent and row-preserving in tests; it was not run on production.
6. **87-AC-06 — SOURCE READY:** the pure no-write migration planner classifies every supported row; no private production snapshot was supplied.
7. **87-AC-07 — BLOCKED (live):** no business transition was executed. The runbook preserves the mandatory #84 copy-confirm-delete-only rule.
8. **87-AC-08 — BLOCKED (live):** installed-profile, extension, OnlineJobs allowlist, session, and scheduled local-project invocation require direct external verification.
9. **87-AC-09 — BLOCKED (live):** unattended final submission and independently attested account-history confirmation have not been proven or provisioned; activation must not proceed without them.
10. **87-AC-10 — BLOCKED (live):** no Generator/task activation change was authorized.
11. **87-AC-11 — BLOCKED (live):** the one-active-instance mixed role set is enforced by the validator but has not been activated.
12. **87-AC-12 — BLOCKED (live):** no real eligible control application was submitted or moved.
13. **87-AC-13 — BLOCKED (live):** fixture behavior passes; no production skip/noisy controls were executed.
14. **87-AC-14 — BLOCKED (live):** fixture behavior passes; no production blocker/network control matrix was executed.
15. **87-AC-15 — BLOCKED (live):** ambiguous reconciliation is covered by fixtures/executor tests, not a controlled production click.
16. **87-AC-16 — BLOCKED (live):** mover delete-failure recovery passes tests but was not induced in production.
17. **87-AC-17 — BLOCKED (live):** migration classification is implemented; no legacy production row was drained or retained.
18. **87-AC-18 — SOURCE READY:** checked-in configuration/prompt/policy/telemetry have no daily maximum/counter/date bucket; production state still requires evidence.
19. **87-AC-19 — SOURCE READY:** technical headroom leaves due jobs eligible in tests and runtime validation; live task evidence is pending.
20. **87-AC-20 — BLOCKED (live):** no post-cutover evidence exists because no cutover ran.
21. **87-AC-21 — BLOCKED (live):** no active-role scheduled observation was authorized.
22. **87-AC-22 — SOURCE READY:** rollback order and compatibility validation are implemented and tested; no live rollback evidence was captured or executed.
23. **87-AC-23 — SATISFIED (repository):** discovery, deduplication, rediscovery, legacy automatic skip, outcomes, archive history, receipts, and guarded manual mover parity pass the full regression suite.

## Release conclusion

Issues #82-#84 and #86 are source-complete. Issue #85 is source-complete except for the real unattended final-submit capability proof. Issue #87 remains a deliberately blocked production rollout. The repository is ready for independent review and a PR, not for activation.
