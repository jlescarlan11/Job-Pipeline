# Job Pipeline

A small, manual-application job pipeline for OnlineJobs.ph:

```text
Scraper → Evaluator & Generator → Alerter & Mover
```

The replacement uses a Main Google workbook for queue records and a separate Configuration workbook for operator-managed context. `Scraped Jobs` owns intake and automated processing, `To Review` owns decisions that need `Approve` or `Deny`, and `To Apply` owns safe messages awaiting `I Applied` or `Skip`. `Applied Jobs` and `Archive` are terminal stores. The retained old workbook is a backup/reference and is never imported.

## Workflow behavior

1. **Scraper** runs every four hours. At execution start it reads and validates the enabled plain keywords in the visible `Search Keywords` tab, freezes that snapshot with one execution timestamp, and accepts only source postings in the inclusive range `[window_end - 24 hours, window_end]`. It deduplicates against all five business stores, appends new identities to `Scraped Jobs`, and updates discovery-owned fields in the current active owner.
2. **Evaluator & Generator** runs every 90 minutes and freezes at most the first five eligible `Scraped Jobs` rows per execution. It processes that fixed batch sequentially, with an independent append-winner claim, evaluation, generation, guarded commit, and persistence confirmation for each row, followed by a 20-second production Sheet pacing interval. It commits `ready_to_apply`, `review_needed`, or `skip` back to `Scraped Jobs`; permanent source HTTP 404/410 responses become `unavailable` and route to Archive, while temporary provider and source failures remain observable retryable `error` conditions without stopping later rows. A ready row requires a current, validated application pack and message. `Approve` acknowledges explicitly allow-listed warnings, strips unsafe employer content from generation, and sends profile-answerable screening questions into the next message prompt. Sensitive commitment questions and external actions remain manual-submission reminders. A missing or unusable description still cannot generate a message. Each row allows one initial model request and, only after deterministic rejection, one bounded repair request.
3. **Alerter & Mover** runs every 15 minutes. It reads the five business stores in one batch, exits immediately when there is no eligible work, routes results and user decisions between focused stores with copy-confirm-delete, restores latest-first ordering only for stores touched by the selected moves, then lazily loads Configuration and sends an idempotent Slack copy only for fresh ready rows in `To Apply`.

Applications are never submitted automatically. Slack and Sheet links only open `To Apply` or the source page. An approved row with manual follow-up shows that reminder in the visible, system-owned `required_input` column without changing the user's `notes`. The user applies manually and then selects `I Applied` in `To Apply`.

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

All five business tabs use the same complete ordered record schema and keep the newest lifecycle event directly below the header. `To Review` exposes only `Approve`/`Deny`; `To Apply` exposes only `I Applied`/`Skip`; blank remains valid and workflow-side validation is authoritative. The ten context tabs divide identity, evidence, and preferences into small editable tables. Generator reads and freezes them directly from Configuration at execution start. Alerter & Mover first plans from persisted business fields and reads all ten tabs in one request only when a potential alert exists; movement and outcome work therefore do not depend on Configuration availability. Both derive context hashes automatically, and alert delivery fails closed when context is missing or malformed. An empty default tab is removed. A non-empty unexpected tab or conflicting header stops setup. On first creation, the configuration tabs are seeded from the current approved profile and policies. Rerunning either role-specific setup preserves operator edits without recreating deleted rows or re-enabling disabled rows.

## Local commands

```bash
npm run build
npm run validate
npm run validate:deployment -- --policy-only
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
