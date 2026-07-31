# Search Keywords change-set ledger — 2026-07-31

Comparison base: `058c1e40de29086070584ea28eef3b00ec71d7a8`.

Issues #51, #52, and #53 are **HIGH** risk because the change accepts
operator-controlled Unicode input, changes a scheduled production integration,
touches durable Google Sheet state, preserves claims and duplicate suppression,
and requires recoverable in-place deployment.

| Change unit | Issue provenance | Purpose and inspected boundaries | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `config/review-sheet.json`, `config/search-plan.json` | #51/#52 | Move the exact ten seeds into the workbook definition and leave only bounded network/lease policy in the search plan. Setup, runtime validation, generated embedding, schema versions, and direct consumers inspected. | High | REVIEWED_AFTER_FIX |
| `src/fresh-sheet-setup.mjs` | #51 | Validate and plan the five-tab contract, seed only absent configuration, preserve existing rows, and reject conflicts. Existing business rows, empty existing configuration, unexpected tabs, protections, and validation outputs inspected. | High | REVIEWED_CLEAN |
| `scripts/build-sheet-setup.mjs` | #51/#53 | Generate lock-protected, seed-on-create Apps Script with strict checkboxes and header protection. Existing-sheet preflight, write ordering, retries after failure, idempotence, business rows, legacy safety, and production addition inspected. | High | REVIEWED_AFTER_FIX |
| `google-apps-script/SheetSetup.gs` | #51/#53 | Deterministic generated workbook setup artifact. Source/artifact drift, syntax, five-tab structure, seed location, preflight-before-write, protection, validation, and absence of legacy import surfaces inspected. | High | REVIEWED_AFTER_FIX |
| `src/discovery.mjs` | #52 | Normalize, validate, freeze, and deterministically identify sheet keywords while keeping search-plan validation operational only. Unicode/control input, malformed checkbox values, duplicates, zero valid rows, error redaction, request encoding, pagination, coverage, reconciliation, and terminal suppression inspected. | High | REVIEWED_CLEAN |
| `scripts/build-workflows.mjs` | #52/#53 | Add the one-time Sheet read before Capture, consume the frozen snapshot, and retain it for coverage without renumbering existing nodes. Error routing, zero output, graph order, HTTP/write reachability, environment binding, settings, node IDs, and no fallback inspected. | High | REVIEWED_AFTER_FIX |
| `workflows/scraper.json` | #52/#53 | Deterministic generated Scraper with a 26th node and no keyword catalog. Artifact drift, n8n syntax/import, node order, settings, binding, retry behavior, logging, endpoints, claims, and business writes inspected. | High | REVIEWED_CLEAN |
| `outputs/cutover-20260731/build-bound-replacements.mjs` | #53 | Bind an added Google Sheets node from the established workflow-level Sheets credential and reject any unbound Sheet node before import. Existing name-based bindings, credential data boundaries, all three target IDs, inactive output, and restricted temporary files inspected. | High | REVIEWED_AFTER_FIX |
| `config/n8n-deployment-policy.json`, `tests/workflow-cutover.test.mjs` | #52/#53 | Version and require the runtime keyword-read node in the recognized Scraper signature while retaining exactly three roles. Policy-only, cutover fixture, role-count, binding, and retired-marker validation inspected. | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-contract.test.mjs` | #51 | Cover exact five-tab setup, seeds, strict validation, edit/delete/disable/reorder/add persistence, pre-existing empty state, conflicts, and generated preflight ordering. | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-discovery.test.mjs` | #52 | Cover operational-only plan, normalization, freezing, deterministic IDs, every malformed/empty/duplicate state, fixed window, pagination, reconciliation, and bounded diagnostics. | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-workflows.test.mjs` | #52 | Cover generated graph order, zero/error routing properties, absence of every seed value, metadata, preserved discovery writes, and three-store behavior. | Moderate | REVIEWED_CLEAN |
| `tests/e2e.test.mjs` | #52 | Drive an enabled/disabled sheet fixture through snapshot, request, parsing, the full review/application lifecycle, and terminal rediscovery suppression. | Moderate | REVIEWED_CLEAN |
| `README.md`, `docs/architecture.md`, `docs/sheet-schema.md` | #51/#52 | Define operator ownership, trust boundary, tab taxonomy, seed-once behavior, and fail-closed runtime source of truth. | Low | REVIEWED_CLEAN |
| `docs/operations.md`, `docs/n8n-deployment.md` | #51/#52/#53 | Add setup, edit, invalid-state, snapshot, no-fallback, import, smoke, observation, and rollback gates. | Moderate | REVIEWED_CLEAN |
| `outputs/search-keywords-20260731/production-predeployment-baseline.json` | #53 | Preserve sanitized pre-mutation workflow, workbook, seed-source, old-workbook, active-claim, and restricted rollback evidence. Captured counts/IDs/hashes, false content-inclusion flags, rollback sequence, and direct documentation/test consumers inspected. | High | REVIEWED_CLEAN |
| `outputs/search-keywords-20260731/nonproduction-verification.json` | #53 | Preserve disposable setup/rerun, edit-without-rebuild, immutable snapshot, invalid matrix, restoration, and no-submission evidence. Execution categories/counts, bounded digests, absence of private rows, and direct documentation/test consumers inspected. | High | REVIEWED_CLEAN |
| `outputs/search-keywords-20260731/production-deployment-verification.json` | #53 | Preserve sanitized setup, exact-ID deployment, real scheduled Scraper, fixed-window, identity, discovery-claim cleanup, downstream, retained-old-workbook, inventory, rollback, and release-gate evidence. Private-content flags, count/hash/timestamp consistency, execution linkage, and direct test consumers inspected. | High | REVIEWED_CLEAN |
| `docs/search-keywords-verification-2026-07-31.md` | #53 | Record implementation, smoke, setup, deployment, real scheduled observation, downstream compatibility, safety, and rollback outcome. IDs/hashes/counts, private-data exclusions, acceptance linkage, and retention-policy boundaries inspected. | Moderate | REVIEWED_CLEAN |
| `tests/docs.test.mjs` | #53 | Parse and enforce bounded baseline/non-production/final-production evidence and exact acceptance-criterion dispositions without weakening prior production evidence checks. New file loads, field-level assertions, issue-section slicing, and full documentation-suite behavior inspected. | Moderate | REVIEWED_CLEAN |
| `docs/acceptance-matrix.md`, this ledger | #51/#52/#53 | Preserve stable criterion-level evidence and account for every source, test, generated, documentation, and rollout change unit. | Low | REVIEWED_CLEAN |

## Findings fixed before publication

1. Runtime keyword rows initially had no bounded Unicode/control-character
   policy. NFKC/trim normalization, a 200-character maximum, and Cc/Cf
   rejection now prevent invisible or oversized request/provenance values.
2. A generated setup run could write headers before rejecting a sheet that had
   data below a blank first row. Every existing expected and unexpected tab is
   now preflighted before the first structural or cell write.
3. A failure elsewhere after creating but before seeding `Search Keywords`
   could strand an empty tab that later runs correctly refused to repopulate.
   The same preflight prevents known content/header failures before creation.
4. Adding one sequentially generated node renumbered every later node,
   including unrelated Generator and Alerter artifacts. The new node has an
   explicit stable ID, leaving every pre-existing node and unrelated workflow
   byte-equivalent.
5. The changed Scraper recognition signature initially retained deployment
   policy version v1. The policy is now v2 so evidence cannot silently validate
   against the old signature.
6. The deployment binder originally copied credentials by node name only, so
   the new `Get Search Keywords` node would import unbound. Newly added Google
   Sheets nodes now inherit the existing workflow-level Sheets binding, and
   the binder refuses any remaining unbound Sheet node before import.

## High-assurance review result for issues #51 and #52

**Lane A — Security, Privacy, and Trust: PASS.** Sheet values are untrusted;
only strict checkbox states and bounded NFKC-normalized strings are accepted.
Invisible controls, duplicates, missing values, unexpected columns, and zero
enabled rows fail closed. URLs encode values, diagnostic errors contain only
fixed categories, success logs contain counts/statuses rather than the sheet,
credentials remain in n8n bindings/environment, and no application endpoint or
automatic submission was added.

**Lane B — Data, State, Failure, and Operations: PASS.** Seeds are written only
on first creation; existing edits and every business row are preserved;
conflicts preflight before writes; one Sheet read creates one immutable
execution snapshot and fixed window; every invalid/read failure precedes HTTP,
claims, and writes; existing pagination, deduplication, rediscovery, terminal
suppression, append-winner claims, and lease cleanup remain unchanged; generated
artifacts are deterministic; and rollback remains an in-place Scraper restore
without removing the configuration sheet.

## Issue #53 rollout evidence review

**Lane A — Security, Privacy, and Trust: PASS.** The baseline, non-production
record, final production record, and report store only bounded counts, IDs,
hashes, timestamps, statuses, and fixed error categories. Explicit false
inclusion flags and focused scans confirm that credentials, authorization
material, complete sheet rows, job descriptions, prompts, model responses, and
application messages are absent. No submission or Apply Points spend occurred.

**Lane B — Data, State, Failure, and Operations: PASS.** Direct records cover
the original workbook and claim counts, first-creation production setup,
value-preserving rerun, edit-without-rebuild smoke, five invalid
configurations, exact-ID deployment, credential binding, normalized artifact
equality, live environment validation, real scheduled snapshot and fixed
window, 69/69 identity uniqueness, first-boundary discovery-lease cleanup,
Generator and Alerter compatibility, unchanged retained-old-workbook timestamp,
exact three-role inventory, and the restricted rollback export. No completed
gate failed, so rollback was not required.
