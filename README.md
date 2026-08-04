# Job Pipeline

A small, manual-application job pipeline for OnlineJobs.ph:

```text
Scraper → Evaluator & Generator → Alerter & Mover
```

The replacement uses a Main Google workbook for queue records and a separate Configuration workbook for operator-managed context. `Scraped Jobs` owns intake and automated evaluation, `To Review` owns final `Proceed` or `Reject` decisions, and `To Apply` owns every proceeded record throughout preparation and the later manual `I Applied` or `Skip` decision. `Applied Jobs` and `Archive` are terminal stores. The retained old workbook is a backup/reference and is never imported.

## Workflow behavior

1. **Scraper** runs every four hours. At execution start it reads and validates the enabled plain keywords in the visible `Search Keywords` tab, freezes that snapshot with one execution timestamp, and accepts only source postings in the inclusive range `[window_end - 24 hours, window_end]`. It deduplicates against all five business stores, appends new identities to `Scraped Jobs`, and updates discovery-owned fields in the current active owner.
2. **Evaluator & Generator** runs every 90 minutes and freezes one global batch of at most five eligible rows across `Scraped Jobs` evaluation work and `To Apply` preparation work. It processes the batch sequentially with source-qualified claims and commits. A `Proceed` decision is never reevaluated: preparation remains in `To Apply` and advances through `pending`, `preparing`, `message_ready`, `needs_input`, `external_steps`, `repair_pending`, or `preparation_error`. Unchanged paused rows do not hot-loop. Only `message_ready` has a current validated application pack and generated message; employer tasks, attachments, tests, and sensitive candidate choices remain explicit operator work. Each eligible generation allows one initial model request and at most one bounded repair.
3. **Alerter & Mover** runs every 15 minutes. It reads the five business stores in one batch, exits immediately when there is no eligible work, routes results and decisions with guarded copy-confirm-delete, recovers a persisted destination copy before retrying source deletion, then lazily loads Configuration. It sends one idempotent copy-ready Slack alert only for `message_ready`; `needs_input` and `external_steps` may receive a separate bounded action reminder under policy.

Applications are never submitted automatically. Slack and Sheet links only open `To Apply` or the source page. A proceeded row with manual follow-up shows a bounded checklist in the visible, system-owned `required_input` column without changing the user's `notes`. The user completes any employer steps, applies manually, and then selects `I Applied` in `To Apply`.

## Fresh workbooks

Install the generated Apps Script in two blank workbooks. Run `setupFreshJobPipeline()` in Main; it creates:

- `Scraped Jobs`
- `To Review`
- `To Apply`
- `Applied Jobs`
- `Archive`
- `_System` (hidden, short-lived claims only)

Run `setupFreshJobPipelineConfiguration()` in Configuration; it creates:

- `Search Keywords`
- `Candidate`, `Skills`, `Experience`, `Projects`, `Education`, and `Awards`
- `Job Preferences`, `Application Settings`, `Required Style`, and `Banned Phrases`

All five business tabs use the same complete ordered record schema and keep the newest lifecycle event directly below the header. `To Review` exposes only `Proceed`/`Reject`; `To Apply` exposes only `I Applied`/`Skip` and shows `prep_status`; blank remains valid and workflow-side validation is authoritative. The ten context tabs divide identity, evidence, and preferences into small editable tables. Generator reads and freezes them directly from Configuration at execution start. Alerter & Mover first plans from persisted business fields and reads all ten tabs in one request only when potential alert/reminder work exists; movement and outcome work therefore do not depend on Configuration availability. Both derive context hashes automatically, and delivery fails closed when context is missing or malformed. An empty default tab is removed. A non-empty unexpected tab or conflicting header stops setup. On first creation, the configuration tabs are seeded from the current approved profile and policies. Rerunning either role-specific setup preserves operator edits without recreating deleted rows or re-enabling disabled rows.

For the existing segmented production Main workbook, the same Main setup has
one deliberately narrow in-place compatibility path. It accepts only when all
five business tabs have the exact ordered 74-column v3 header contract, then
inserts the eight v4 review/preparation columns blank at their named schema
boundaries. It never copies or relocates a business row. Mixed, missing,
partial, reordered, or extended record layouts stop before the first write;
an already-v4 workbook is an idempotent no-op apart from normal formatting,
validation, protection, and visibility reconciliation.

## Local commands

```bash
npm run build
npm run validate
npm run validate:deployment -- --policy-only
npm run plan:review-preparation -- private-fresh-snapshot.json
npm run validate:review-preparation-cutover -- sanitized-evidence.json
```

Production-context deployment validation intentionally requires the real n8n settings and fresh/old workbook bindings:

```bash
npm run validate:deployment
```

Cutover evidence is captured and validated separately:

```bash
npm run inventory:unsent -- private-unsent-snapshot.json sanitized-unsent-inventory.json
npm run capture:cutover -- pre_deployment target-map.json pre-deployment.json
npm run capture:cutover -- pre_activation target-map.json pre-activation.json
npm run capture:cutover -- post_activation target-map.json post-activation.json
npm run validate:cutover -- evidence.json
```

Capture accepts only the loopback n8n API origins approved by deployment
policy, requires a clean `HEAD` equal to both local and remote `main`, and never
retains raw names or node names for unrelated workflows.

The current deployment path updates the existing segmented Main and
Configuration workbooks and three pinned workflow IDs in place. It does not
provision a replacement production workbook or reset existing rows.

The segmented in-place migration has its own offline dry-run command. Its input may contain private job data, so neither snapshots nor generated plans are committed:

```bash
npm run plan:segmented-queues -- workbook-snapshot.json migration-plan.json 2026-07-31T00:00:00.000Z
```

All three workflow exports are checked in under `workflows/` and remain inactive after build. Importing an export does not authorize activation or deployment.

## Configuration

- `config/pipeline-schema.json` — versioned record, status, action, transition, and store contract.
- `config/review-sheet.json` — fresh Sheet ownership, columns, context/keyword bootstrap seeds, validation, protection, and retired tabs.
- `config/search-plan.json` — exact 24-hour window, pagination, pacing, timeout, and retries; it contains no runtime keyword fallback.
- `config/runtime.json` — the three schedules, execution budgets, claims, retry bounds, and Generator batch cap.
- `config/alert-policy.json` — Slack eligibility, idempotency, timeout, and environment bindings.
- `config/alert-receipts.json` — bounded durable delivery-receipt states, Data Table binding, retry cap, and retention requirements.
- `config/n8n-deployment-policy.json` — exact three-role signatures, capacity, retention, monitoring, and cutover gates.
- Candidate, ranking, and application files provide validated bootstrap defaults for a newly provisioned workbook. After the one-time workflow deployment, the corresponding visible context tabs are the runtime source. Pack, provider, runtime, and safety policies remain repository-controlled.

See `docs/architecture.md`, `docs/data-contract.md`, `docs/sheet-schema.md`, and `docs/operations.md`.
