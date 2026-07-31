# Segmented queue change-set accounting ledger

Comparison base: `dbe085969861c8a9b09388d041da25bbb8267caf` (`origin/main` at run initialization). Implementation branch: `codex/segmented-job-queues`.

Disposition vocabulary follows the autonomous issue loop. Generated artifacts are reviewed through their source builder plus direct structural, syntax, binding, endpoint, and drift validation; this is not a substitute for source inspection.

| Change unit | Issue | Purpose and inspected boundaries | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `config/pipeline-schema.json` | #55 | Version five-store ownership and exact store/status/action matrix; inspected contracts, movement terminal clearing, migration, tests | High state | REVIEWED_AFTER_FIX |
| `config/review-sheet.json` | #55 | Define seven tabs, visibility, columns, edits, validations, seeds; inspected setup generator and docs | High state | REVIEWED_CLEAN |
| `src/contracts.mjs` | #55 | Validate schema/store ownership while retaining identity, guard, message, and terminal contracts | High state/security | REVIEWED_CLEAN |
| `src/fresh-sheet-setup.mjs` | #55 | Plan idempotent setup and pure fail-closed legacy migration; inspected all preflight/reject/route boundaries | High migration | REVIEWED_CLEAN |
| `scripts/build-sheet-setup.mjs` | #55 | Generate native tab, formatting, protection, and dropdown setup | Medium generated | REVIEWED_CLEAN |
| `google-apps-script/SheetSetup.gs` | #55 | Generated setup artifact; source, exact tabs, write surfaces, and drift inspected | High operational | REVIEWED_CLEAN |
| `tests/simplified-contract.test.mjs` | #55 | Fresh/rerun/empty/conflict/action/migration regression matrix | Medium | REVIEWED_CLEAN |
| `docs/sheet-schema.md` | #55 | Document authoritative tabs, edits, dropdowns, and migration planner | Low | REVIEWED_CLEAN |
| `src/discovery.mjs` | #56 | Require five-store reconciliation, active-owner updates, terminal suppression, and canonical alias rejection | High state/network | REVIEWED_AFTER_FIX |
| `src/generator.mjs` | #56 | Restrict select/claim/commit/confirm to Scraped Jobs and retain approval gates | High state/provider | REVIEWED_CLEAN |
| `tests/simplified-discovery.test.mjs` | #56 | Cover each active owner, both terminals, duplicate IDs, URL aliases, window/keyword invariants | Medium | REVIEWED_AFTER_FIX |
| `tests/simplified-generator.test.mjs` | #56 | Update source-store diagnostics without weakening lifecycle gates | Low | REVIEWED_CLEAN |
| `src/movement.mjs` | #57 | Implement seven explicit routes, global cap, route claims, repair, copy-confirm-delete, alias rejection | High state/concurrency | REVIEWED_AFTER_FIX |
| `src/alerter-mover.mjs` | #57 | Select/commit alerts only in To Apply after five-store movement | High state/external send | REVIEWED_CLEAN |
| `tests/simplified-movement.test.mjs` | #57 | Cover all routes, invalid actions, message gate, partial repair, live alert state, caps, stale state, aliases | High regression | REVIEWED_AFTER_FIX |
| `tests/simplified-alerter-mover.test.mjs` | #57 | Cover To Apply eligibility, copy fidelity, claims, retries, timeouts, and independence | High external send | REVIEWED_CLEAN |
| `scripts/build-workflows.mjs` | #56/#57 | Generate five-store reads/writes, Scraped processing, per-sheet movement/delete paths, and To Apply alerts | High generated/state | REVIEWED_AFTER_FIX |
| `workflows/scraper.json` | #56 | Generated 34-node five-store Scraper; unique IDs/names, connections, bindings, syntax, no retired binding checked | High operational | REVIEWED_AFTER_FIX |
| `workflows/generator.json` | #56 | Generated 47-node Scraped-only Generator; sequence, claims, gates, bindings, syntax checked | High provider/state | REVIEWED_AFTER_FIX |
| `workflows/alerter-mover.json` | #57 | Generated 96-node route/alert graph; all destination and deletion branches, bindings, syntax, ordering checked | High state/external send | REVIEWED_AFTER_FIX |
| `tests/simplified-workflows.test.mjs` | #56/#57 | Assert graph shape, bindings, metadata, syntax, safety endpoints, route and alert ordering | High regression | REVIEWED_AFTER_FIX |
| `tests/e2e.test.mjs` | #56/#57 | Prove intake→generation→focused route→alert→manual applied and review approval/denial lifecycle | High regression | REVIEWED_CLEAN |
| `config/n8n-deployment-policy.json` | #58 | Version current role signatures to v3 and retain capacity/retention/manual boundaries | High deployment | REVIEWED_AFTER_FIX |
| `src/segmented-queue-cutover.mjs` | #58 | Validate sanitized backups, release pins, exact stores, zero-loss counts, workflow compatibility, observations, rollback | High security/deployment | REVIEWED_AFTER_FIX |
| `scripts/plan-segmented-queue-migration.mjs` | #58 | Write a private, exclusive-create, mode-0600 deterministic plan and fail closed on rejects | High privacy/migration | REVIEWED_CLEAN |
| `scripts/validate-segmented-queue-cutover.mjs` | #58 | Fail closed unless sanitized production evidence satisfies the cutover contract | High deployment | REVIEWED_CLEAN |
| `package.json` | #58 | Expose explicit offline planning and evidence-validation commands; no dependencies added | Low | REVIEWED_CLEAN |
| `tests/segmented-queue-cutover.test.mjs` | #58 | Accept complete phase-correct evidence; reject loss, secrets, live work, stale contract, mixed activation, rollback gaps | High regression | REVIEWED_AFTER_FIX |
| `tests/workflow-cutover.test.mjs` | #58 | Align role fixtures and prove current policy signatures match generated artifacts | High deployment regression | REVIEWED_AFTER_FIX |
| `docs/segmented-queue-cutover.md` | #58 | Define private dry-run, backup, quiet window, atomic migration/deployment, observation, rollback, evidence gates | High operations | REVIEWED_CLEAN |
| `docs/segmented-queue-cutover-evidence.example.json` | #58 | Provide a complete sanitized evidence shape that deliberately fails until direct production proof replaces every placeholder | High evidence/privacy | REVIEWED_AFTER_FIX |
| `README.md` | #55–#58 | Describe focused ownership, manual boundary, setup, runtime, and offline migration command | Low | REVIEWED_CLEAN |
| `docs/architecture.md` | #56/#57 | Document five-store trust/data flow, Generator source, routes, claims, and repairs | Medium | REVIEWED_CLEAN |
| `docs/data-contract.md` | #55/#57 | Document versioned store/status/action and move contracts | Medium | REVIEWED_CLEAN |
| `docs/alerts.md` | #57 | Document To Apply-only eligibility, links, claims, and idempotency | Medium security | REVIEWED_CLEAN |
| `docs/n8n-deployment.md` | #56–#58 | Document segmented roles, compatibility binding, and To Apply deep link | Medium deployment | REVIEWED_CLEAN |
| `docs/operations.md` | #55–#58 | Update setup/smoke/action/observation instructions and route to the in-place runbook | High operations | REVIEWED_CLEAN |
| `docs/acceptance-matrix.md` | #55–#58 | Record every authoritative criterion and honest #58 limitations | Medium evidence | REVIEWED_CLEAN |
| `tests/docs.test.mjs` | #55–#58 | Assert current stores/runbook while bounding historical evidence sections | Low | REVIEWED_AFTER_FIX |
| `docs/segmented-queue-change-ledger-2026-07-31.md` | #55–#58 | Permanent criterion/change-set/high-assurance accounting | Low | REVIEWED_CLEAN |

## High-assurance lane A — security and privacy

**PASS on the latest change set.** Inspected the manual-application boundary, every changed HTTP/provider surface, URL parsing and link rendering, environment-only secret bindings, log/error sanitization, private migration-plan handling, evidence secret/private-row rejection, and generated workflow endpoint scans. No credential was added. The planner uses exclusive creation with mode `0600` and the runbook forbids committing its private input/output. `npm audit --omit=dev` is not applicable because the repository has no lockfile or dependency graph; no dependency was added.

## High-assurance lane B — data, state, and operations

**PASS after fixes and rereview.** Inspected all source/destination ownership, canonical ID/URL aliasing, action validation, guard/version/token persistence, active and terminal partial repair, global caps, route-scoped claims, per-sheet descending deletion, destination confirmation, repeated execution, alert ordering, generated graph connections, migration preflight, evidence phases, deployment signatures, and rollback compatibility.

Verified findings fixed during review:

1. Terminal store action rules initially contradicted movement's intentional action clearing; terminal stores now accept only blank actions.
2. Active-destination repair could clear an in-flight `alert_claim_token`; destination-owned alert claims are now preserved and directly tested.
3. Distinct discovered identities could alias one canonical URL; discovery now rejects the run before writes.
4. Movement indexed only canonical IDs; it now rejects cross-store canonical-URL aliases before planning.
5. Deployment role signatures still named retired queue nodes; policy v3 now matches and is tested against generated workflows.
6. Pre-activation cutover evidence could claim post-activation schedule observations; phase-specific validation now forbids that state.
7. The strict evidence validator had no operator-consumable document shape; a secret-free, deliberately non-passing template now covers every required field and is regression-tested.

## Validation evidence

- Generated graph integrity: Scraper 34 nodes, Generator 47 nodes, Alerter & Mover 96 nodes; unique IDs/names and no dangling connections.
- Focused domain, workflow, documentation, cutover, policy, and E2E suites pass after each applicable fix.
- Integrated release command: `npm run validate` passed 201 tests (189 passed, 12 intentional legacy skips, 0 failed).
- Diff hygiene: `git diff --check` passes.
- Production mutation/deployment/live-provider evidence: not executed and not claimed; see issue #58 matrix and runbook.
