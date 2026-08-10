# Autonomous browser change-set ledger — 2026-08-10

Comparison base: `08928200fefcdfdf47b5225fb106c97d6fcc8eb0` (`origin/main`).
Prior implementation checkpoint: `6f3c51efd765d931c59a29ee7264b1ed83cd592b`;
the final reviewed consolidation is the draft PR head recorded in Git history.

The consolidated change is **CRITICAL** because it defines unattended external
submission, durable Google Sheets state, signed confirmation evidence,
copy-confirm-delete movement, scheduled work, migration, and production
activation/rollback gates. Source artifacts remain inactive and no deployment,
production-data mutation, application submission, or merge was performed.

## Consolidated accounting

Every base-to-final path is included below. Grouped paths are one coherent
logical change unit; generated artifacts, deletion, fixtures, configuration,
tests, and documentation are explicitly accounted for.

| Change unit and type | Issue provenance | Purpose and inspected direct boundaries | Risk | Disposition |
| --- | --- | --- | --- | --- |
| Added `.agents/skills/job-autopilot/SKILL.md`, `.agents/skills/job-autopilot/agents/openai.yaml`, `.agents/skills/job-autopilot/references/executor-protocol.md`, `.agents/skills/job-autopilot/references/onlinejobs-form-boundary.md` | #85 | Define the explicit Chrome skill, exact named executor operations, allowlisted site/form boundary, ordering, block categories, and privacy contract. Browser task prompt, CLI schemas, fixture protocol, plugin provenance, and skill validator inspected. | Critical browser trust | REVIEWED_AFTER_FIX |
| Modified `config/application-policy.json`, `config/application-pack-policy.json`, `config/pipeline-schema.json`, `config/review-sheet.json` | #82 | Version autonomous policy, decision/lifecycle/submission fields, closed no-daily-cap contract, store/action rules, bounds, transitions, review guidance, and legacy compatibility. Profile/evaluation validators, Sheet compilation, guard construction, movement consumers, and schema tests inspected. | Critical durable contract | REVIEWED_AFTER_FIX |
| Modified `src/contracts.mjs`, `src/profile.mjs`, `src/evaluation.mjs`, `src/sheet-context.mjs`, `src/discovery.mjs` | #82/#83 | Implement exact autonomous validation, stable job/form/submission identities, full configuration binding, closed policy keys, truthful pack/message reuse, Sheet-context validation, and discovery preservation. Direct executor/mover callers, stale/async updates, legacy normalization, and regression tests inspected. | Critical authorization/data | REVIEWED_AFTER_FIX |
| Modified `src/fresh-sheet-setup.mjs`, `scripts/build-sheet-setup.mjs`, `google-apps-script/SheetSetup.gs` | #82 | Add deterministic blank-v5 setup and exact resumable v4→v5 structural insertion without business-row creation or relocation. Header/version/interruption preflight, validation/protection/guidance, idempotent rerun, generator parity, and migration tests inspected. | Critical schema migration | REVIEWED_AFTER_FIX |
| Added `src/browser-executor.mjs`, `src/browser-confirmation-attestation.mjs` | #83/#85 | Implement capability-specific claim/context/decision/fill/submit/result/recovery/reconciliation state machine, effective form/submitter binding, private dual-anchor hash-chain click consumption, stable job/submission suppression, and independent Ed25519 confirmation verification. State guards, counted claim arbitration, exact rereads, current configuration/ownership, pinned retries, restart discovery, form URL/type bounds, replay/rollback/loss/permission drift, bounded diagnostics, context/protocol digests, public-key pinning, Mover reconstruction, and crash boundaries inspected. | Critical submission authority | REVIEWED_AFTER_FIX |
| Added `scripts/browser-executor.mjs` | #83 | Expose strict JSON stdin/stdout operations without a generic writer, provider call, browser implementation, or movement capability. Input key allowlists, one-record selection, output privacy, exit behavior, and CLI tests inspected. | High command boundary | REVIEWED_AFTER_FIX |
| Modified `src/movement.mjs`, `src/alerter-mover.mjs` | #84 | Route exact independently attested confirmations and skips while preserving legacy movement, alert independence, destination recovery, full-record source-copy digests, and copy-confirm-delete. Generated workflow bundle, receipts, concurrent claims, destination ownership, notes/outcomes, deletion rereads, and privacy inspected. | Critical row movement | REVIEWED_AFTER_FIX |
| Added `config/browser-executor-task.json`; modified `config/runtime.json`, `src/runtime.mjs` | #86 | Define one inactive external scheduled browser role alongside two n8n roles, private durable click-receipt storage, technical headroom/retry only, closed runtime/task controls, and no daily limit. Schedule overlap, task provenance, selection continuation, receipt configuration, manifest consumers, and runtime tests inspected. | High scheduled operations | REVIEWED_AFTER_FIX |
| Modified `config/n8n-deployment-policy.json`, `src/n8n-deployment.mjs`, `scripts/validate-n8n-deployment.mjs`, `scripts/build-bound-workflow-rollout.mjs` | #86/#87 | Pin the complete mixed compatibility unit, exact role/artifact/task identities, independent attestation boundary, environment/capacity/rollback rules, closed task shape, and fail-closed evidence requirements. Production validator, rollout builder, cutover consumers, stale digest cases, and deployment tests inspected. | Critical deployment | REVIEWED_AFTER_FIX |
| Modified `scripts/build-workflows.mjs`; modified generated `workflows/scraper.json`, `workflows/alerter-mover.json`; deleted generated `workflows/generator.json` | #84/#86 | Generate exactly two inactive n8n exports, remove active Generator/Groq/message work, bundle current contract/movement code, and retain relocation only in Alerter & Mover. Source/artifact equality, Code-node syntax, graph ownership, environment bindings, inactive flags, and deletion references inspected. | Critical generated runtime | REVIEWED_AFTER_FIX |
| Added `src/autonomous-browser-cutover.mjs`, `scripts/plan-autonomous-browser-migration.mjs`, `scripts/validate-autonomous-browser-cutover.mjs` | #82/#87 | Provide pure no-write legacy classification and exact three-phase cutover validation with strict privacy, provenance, inventory, backup, capability, activation, observation, and rollback gates. CLI argument handling, evidence allowlist, business-store counts, task/workflow identities, exact restore order, backup digest/ID linkage, and tests inspected. | Critical migration/operations | REVIEWED_AFTER_FIX |
| Added `docs/autonomous-browser-cutover.md`, `docs/autonomous-browser-cutover-evidence.example.json` | #87 | Document safe private planning, maintenance prerequisites, exact activation/rollback order, bounded evidence, and explicit production blockers; the example remains deliberately incomplete and cannot prove execution. Validator schema and docs tests inspected. | High operations/privacy | REVIEWED_CLEAN |
| Added `scripts/serve-job-autopilot-fixtures.mjs`; added `tests/fixtures/onlinejobs/already-applied.html`, `tests/fixtures/onlinejobs/ambiguous-navigation.html`, `tests/fixtures/onlinejobs/apply-points.html`, `tests/fixtures/onlinejobs/captcha.html`, `tests/fixtures/onlinejobs/challenge.html`, `tests/fixtures/onlinejobs/changed-form.html`, `tests/fixtures/onlinejobs/login.html`, `tests/fixtures/onlinejobs/required-question.html`, `tests/fixtures/onlinejobs/standard.html`, `tests/fixtures/onlinejobs/success.html`, `tests/fixtures/onlinejobs/unavailable.html`, `tests/fixtures/onlinejobs/upload-test-agreement.html`, and `tests/fixtures/onlinejobs/replay.json` | #85 | Supply sanitized local browser cases and deterministic replay metadata for page/form/outcome boundaries. Host/path routing, absence of secrets/private values, fixture manifest completeness, and skill tests inspected. | Moderate test surface | REVIEWED_CLEAN |
| Added `tests/autonomous-application-pack.test.mjs`, `tests/browser-executor.test.mjs`, `tests/job-autopilot-skill.test.mjs` | #82/#83/#85 | Cover automatic resolution, frozen context, strict command/state ordering, claims, no cap, form identity, submit durability, signed confirmation, ambiguity/restart, privacy, fixture coverage, and skill packaging. Production capability limitations are not represented as fixture success. | High assurance | REVIEWED_AFTER_FIX |
| Added `tests/autonomous-browser-cutover.test.mjs` | #87 | Cover no-write migration and strict pre-cutover/pre-activation/post-activation evidence, privacy, provenance, count reconciliation, activation/rollback ordering, and expected blocker states. No test claims a production cutover occurred. | High assurance | REVIEWED_AFTER_FIX |
| Modified `tests/simplified-contract.test.mjs`, `tests/profile-contracts.test.mjs`, `tests/sheet-context.test.mjs` | #82 | Cover full browser transition matrix, material guards, legacy compatibility, authoritative Sheet context, daily-cap aliases/nested controls, and closed policy shapes. Schema/config producers and consumers inspected. | High contract regression | REVIEWED_AFTER_FIX |
| Modified `tests/simplified-movement.test.mjs`, `tests/simplified-alerter-mover.test.mjs`, `tests/e2e.test.mjs` | #84 | Cover confirmation/skip routes, every retained state, independent receipt verification, complete/partial destination recovery, full-copy delete guard, Slack independence, legacy parity, contention, and end-to-end movement. | High state regression | REVIEWED_AFTER_FIX |
| Modified `tests/runtime.test.mjs`, `tests/n8n-deployment.test.mjs`, `tests/simplified-workflows.test.mjs`, `tests/workflow-cutover.test.mjs`, `tests/workflow-rollout.test.mjs`; added `tests/fixtures/legacy-generator-runtime.json` | #86/#87 | Cover two-n8n-plus-task ownership, inactive artifacts, exact provenance, role residue/duplicates, runtime headroom, closed no-cap controls, generated-code exclusions, rollback history, and isolated legacy compatibility. | High deployment regression | REVIEWED_AFTER_FIX |
| Modified `tests/docs.test.mjs`, `tests/evaluation-generation.test.mjs`, `tests/groq-provider.test.mjs`, `tests/review-preparation-cutover.test.mjs`, `tests/simplified-discovery.test.mjs`, `tests/simplified-generator.test.mjs` | #82-#87 regression | Keep primary documentation, truthful generation, historical provider behavior, prior cutover compatibility, discovery ownership, and retired Generator source helpers aligned without reactivating the old runtime. Direct changed assertions and legacy fixtures inspected. | Moderate regression | REVIEWED_CLEAN |
| Modified `package.json` | #83/#85/#87 | Expose browser executor, fixture server, migration planner, and cutover validator commands; existing build/test/receipt/deployment commands remain authoritative. Call sites and docs inspected; no dependency or lockfile change exists. | Low tooling | REVIEWED_CLEAN |
| Modified `README.md`, `docs/application-pack.md`, `docs/architecture.md`, `docs/data-contract.md`, `docs/ranking.md`, `docs/sheet-schema.md`; added `docs/job-autopilot.md`, `docs/browser-executor-task-prompt.md` | #82-#85 | Document the autonomous product/data/trust model, exact skill invocation, executor boundary, no-review flow, deterministic per-application Apply Points, no daily cap, signed confirmation, legacy compatibility, and browser failure handling. Source contracts and docs tests inspected. | Moderate operator contract | REVIEWED_AFTER_FIX |
| Modified `docs/n8n-deployment.md`, `docs/operations.md` | #86/#87 | Document the inactive mixed role set, environment/provenance/attestation requirements, deployment boundary, maintenance gate, and safe rollback without claiming live execution. Policy/runtime sources and docs tests inspected. | High operations | REVIEWED_AFTER_FIX |
| Added and modified `docs/autonomous-browser-acceptance-matrix.md` | #82-#87 | Map every issue acceptance criterion to direct source/live evidence using only the required status vocabulary; explicitly retain partial/blocked browser and production criteria. Issue bodies, tests, current PR state, and no-deploy boundary inspected. | High audit integrity | REVIEWED_AFTER_FIX |
| Added `docs/autonomous-browser-change-set-ledger-2026-08-10.md` | #82-#87 | Account for every path/logical unit, issue provenance, purpose, direct boundaries, risk, findings, and review disposition. Git name-status, base-to-HEAD diff, generated artifacts, tests, and documentation reconciled. | Low accounting | REVIEWED_CLEAN |

There are no dependency or lockfile changes, binaries, renames, database
migrations, production evidence outputs, screenshots, or private snapshots in
the change set.

## Per-issue accounting

| Issue | Verified requirement/root cause | Principal change units | Final issue status |
| --- | --- | --- | --- |
| #82 | The v4 manual-only contract could not represent guarded autonomous decisions, submit durability, confirmation, or no-cap policy. | Policy/schema/review config; contract/profile/evaluation/Sheet setup; migration planner; direct contract tests and docs. | COMPLETE |
| #83 | No deterministic capability-specific boundary existed between a ChatGPT/Chrome task and durable queue state. | Browser executor/CLI, context and identity digests, strict claims/rereads, submit/result protocol, tests. | COMPLETE |
| #84 | Alerter & Mover required manual `I Applied` and could not independently validate autonomous terminal evidence. | Signed receipt verifier, autonomous movement/alerts, full-copy deletion guard, generated Mover, recovery/privacy tests. | COMPLETE |
| #85 | No reusable Chrome skill/fixture protocol existed; source behavior is implemented, but the real signed-in unattended submit and independent account-history adapter are not provisioned or proven. | Skill package, task prompt, fixtures/server, strict executor handoffs, documentation/tests. | BLOCKED |
| #86 | The active build/deployment contract still modeled n8n Generator/Groq as the decision/message role. | Mixed runtime/task/deployment contracts, two-workflow generator, generated artifact deletion/regeneration, validation/tests/docs. | COMPLETE |
| #87 | Production migration/activation requires private inventory, backups, real Chrome/account proof, task/workflow mutation, controlled submissions, and observation, while this run explicitly forbids deployment and production-data mutation. | Pure planner, strict cutover validator, incomplete example, runbook, source tests only. | BLOCKED |

## Verified findings fixed

1. Form-action source identity originally allowed an unrelated numeric suffix
   and query-bearing action; the executor now requires the literal claimed ID,
   no query/fragment, at most 64 fields, and at most 32 KiB of structural input.
2. Submission authorization originally did not bind the full frozen
   profile/ranking/application/pack context; the persisted context digest is
   now mandatory through decision, fill, click, and result commit.
3. Confirmation originally permitted an environment-selected trust root and
   was not independently verified by Mover. It now pins key ID plus SPKI
   fingerprint, rejects private-key PEM, persists bounded receipt fields, and
   verifies the exact Ed25519 witness before planning and deletion.
4. The signed protocol version originally could not be reconstructed from the
   persisted row. It is now single-sourced as an immutable protocol constant,
   with an executor→Mover→destination→deletion integration regression.
5. Source deletion originally omitted discovery-owned fields from its
   comparison. A full schema-record copy digest now rejects concurrent
   rediscovery or any other source mutation before deletion.
6. Daily-cap validation originally depended on a short alias vocabulary and
   individual keys. Closed runtime, application-policy, pack-policy, and task
   shapes plus path/value scanning now reject flat, synonym, 24-hour, and
   split-key quota controls.
7. Scheduled-task provenance originally omitted transitive executor sources.
   It now binds `AGENTS.md`, the complete executor/attestation/contract/
   evaluation/profile/claim graph, CLI, skill bundle, prompt, and configuration.
8. Cutover evidence originally accepted normalized identifier prefixes and did
   not reconcile business-store counts with browser-state counts. Exact bounded
   identifiers, matching count totals, attestation trust identity, and
   provisioned-adapter evidence are now mandatory.
9. Pre-submit result commit originally accepted only a caller-supplied guarded
   row. It now requires a fresh exact source reread, the live winning claim, and
   current frozen configuration; post-submit outcomes use a separate no-click
   reconciliation operation.
10. Scheduled selection originally exposed only queued/retryable rows. It now
    discovers expired pre-submit claims and `submit_started`/`ambiguous` rows as
    explicit recovery/reconciliation work without re-entering submission.
11. Browser retry settings originally were pinned but unenforced. Persisting a
    claim now increments `attempt_count`; retry time is executor-computed from
    the five-minute policy and the third failed attempt becomes blocked.
12. Rollback prior assets originally were a smaller unordered set unrelated to
    backup evidence. They now cover all 12 required backup kinds, including the
    browser click-receipt store, in exact policy restore order, with restore IDs
    and SHA-256 digests linked one-for-one.
13. The v4→v5 header upgrade originally rejected an exact interruption after a
    subset of sheets or after column insertion but before header fill. It now
    resumes exact legacy/current/blank-new-header states without double insert.
14. Retry eligibility originally preferred a non-schema alias and direct claim
    planning did not independently enforce the future `next_retry_at`. The
    selector now rejects the alias, and both selection and claim planning
    enforce the executor-owned retry timestamp before issuing authority.
15. Claim confirmation originally matched only the planned token/key during
    arbitration, while later capabilities did not reconstruct the exact scope
    and lease. Confirmation and every pre-submit capability now require one
    exact persisted claim with the expected key, canonical job, stage, token,
    creation time, and runtime-derived expiry; altered metadata is rejected.
16. Click authorization originally remained replayable while the persisted row
    stayed `submit_started`. The executor now pins a private store and separate
    witness by lossless owner/device/inode identity and generation, binds both in
    the manifest, recomputes the ledger chain/count/head, and performs exact,
    verified fsync writes for the canonical-job-keyed receipt and directory,
    append, witness, and final directory state before
    returning capability. It rejects prior authorization, stable-submission, or
    canonical-job identity. Receipt deletion, ledger/witness rollback,
    same-path recreation, permission/path drift, whole-store loss, and
    interrupted consumption fail closed. Witness loss requires browser
    disablement, independent reconciliation, and generation/task-pin rotation;
    it is never restored or rebound. The checked-in CLI remains unprovisioned.
17. Form URL checks originally allowed credential-bearing authorities to
    normalize to the trusted host/origin. Origin, page, and action parsing now
    reject any username or password before fingerprint construction.
18. Native invalid-URL exceptions originally retained hostile raw input in the
    error object and CLI stack. Form parsing now converts every parse failure to
    a fixed bounded error, with a regression proving the secret is absent.
19. Form field `required` values originally normalized non-boolean input to
    false. Exact structural validation now requires a boolean before required
    field and reread authorization are computed.
20. The first receipt fix treated each caller-selected directory as a separate
    namespace and recreated a lost directory. Exact filesystem identity and the
    independent live witness now detect missing/moved/recreated/stale stores;
    an individual receipt may disappear without erasing consumption. Cutover
    backup evidence includes the store, but rollback never restores the witness
    and cannot reactivate the browser without reconciliation and rotation.
21. Browser timestamps originally accepted some `Date.parse` inputs and could
    persist the original unbounded string, including RFC comments. Every
    selection, claim, decision, fill, submit, result, recovery, receipt, ledger,
    and witness boundary now requires the exact 24-character canonical UTC ISO
    representation before comparison or persistence.
22. Strict-key diagnostics originally interpolated attacker-controlled object
    key names. Library and CLI errors now report fixed missing/unsupported
    counts only, with hostile-key regressions proving secrets stay out of stderr.
23. Contract and message validators originally forwarded detailed error arrays
    that could contain hostile enum values, URLs, query strings, or generated
    prose. The browser boundary now exposes only a fixed category and bounded
    failure count; regressions prove secrets never reach library stacks or CLI
    stderr.
24. A static path-bound click ledger could be rolled back at the same path, and
    attempt-derived authorization digests did not suppress a restored workbook
    with a new attempt. The dual-anchor generation and hash chain detect stale
    storage, while privacy-safe stable-submission and canonical-job digests make
    one application per posting the durable invariant.
25. Form fingerprinting originally trusted a raw/relative form action and did
    not bind the chosen submitter's effective overrides. The contract now
    requires absolute effective DOM form/submitter actions, POST for both,
    exactly one submit control, and an immediate pre-click reread; cross-origin
    `formaction`, GET `formmethod`, document-base ambiguity, multiple controls,
    and control swaps are rejected.
26. Apply Points originally accepted any browser-selected offered value up to
    100, allowing untrusted employer text or a mistaken agent to expand spend.
    Trusted policy now maps low/normal/high to 1/5/10 per application,
    `save_points` does not apply, and the exact mapped value must be present in
    the live option list. The fill capability returns that numeric value and its
    digest, and submit planning rejects a reread of another offered option. This
    is deliberately independent of any daily quota.
27. Submit planning originally validated field receipts only before the
    `submit_started` persistence boundary. Confirmation now requires a fresh
    second message/Apply Points digest reread immediately before click-store
    consumption; changed values fail before any receipt, ledger, or witness
    mutation.
28. The form contract originally rejected only unknown required interactive
    controls, allowing optional prechecked or autofilled values to ride along.
    Every additional interactive control is now rejected regardless of its
    `required` flag, with optional checkbox and text regressions.
29. The first exclusive receipt filename was authorization-derived. A crash
    after receipt fsync but before ledger/witness advancement could therefore
    allow a new attempt for the same job to use a different filename. The first
    exclusive receipt is now keyed by the privacy-safe canonical-job digest and
    its directory entry is fsynced before ledger append; an orphan receipt
    blocks every later authorization for that job.

No verified pre-existing validation failure remains. The final source suite is
recorded in the acceptance matrix and PR validation evidence.

## High-assurance review

- **Lane A — Security, Privacy, and Trust: PASS.** The independent frozen-tree
  adversarial review found no unresolved high-confidence defect; build,
  artifacts, policy, 382-test release (370 pass, 12 intentional skips), skill,
  diff, and exact protocol/skill/task provenance checks passed.
- **Lane B — Data, State, Failure, and Operations: PASS.** The independent
  frozen-tree review passed 67/67 focused checks plus the same 382-test release,
  and verified CLI reachability, rereads, replay/crash ordering, recovery,
  movement, migration, rollback, and exact provenance.

Both required reruns passed on the frozen source with no unresolved finding.

## Remaining blockers and limitations

- #85 cannot prove the required real signed-in Chrome/plugin behavior,
  unattended final click, pinned private click store/witness generation, or
  independent account-history confirmation without a controlled external
  capability test and provisioned store/witness/adapter/key.
- #87 cannot satisfy its production criteria without an authorized frozen,
  backed-up maintenance window, private fresh rereads, production workflow/task
  mutations, guarded control cases, and scheduled observation. Deployment and
  production-data mutation are explicitly prohibited in this run.
- If the product or site requires human confirmation, zero-touch activation
  remains blocked and that safeguard must not be bypassed.

These are true acceptance blockers, not source test failures. No source-ready
or fixture-only result is represented as live success.
