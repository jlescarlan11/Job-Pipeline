# Job Pipeline

A small, manual-application job pipeline for OnlineJobs.ph:

```text
Scraper → Evaluator & Generator → Alerter & Mover
```

The replacement starts with a new Google workbook. `Scraped Jobs` owns intake and automated processing, `To Review` owns decisions that need `Approve` or `Deny`, and `To Apply` owns safe messages awaiting `I Applied` or `Skip`. `Applied Jobs` and `Archive` are terminal stores. The retained old workbook is a backup/reference and is never imported.

## Workflow behavior

1. **Scraper** runs every four hours. At execution start it reads and validates the enabled plain keywords in the visible `Search Keywords` tab, freezes that snapshot with one execution timestamp, and accepts only source postings in the inclusive range `[window_end - 24 hours, window_end]`. It deduplicates against all five business stores, appends new identities to `Scraped Jobs`, and updates discovery-owned fields in the current active owner.
2. **Evaluator & Generator** runs every 90 minutes and freezes at most the first five eligible `Scraped Jobs` rows per execution. It processes that fixed batch sequentially, with an independent append-winner claim, evaluation, generation, guarded commit, and persistence confirmation for each row, followed by a 20-second production Sheet pacing interval. It commits `ready_to_apply`, `review_needed`, or `skip` back to `Scraped Jobs`; provider and source failures become observable `error`/`unavailable` conditions and do not stop later rows. A ready row requires a current, validated application pack and message. Each row allows one initial model request and, only after deterministic rejection, one bounded repair request.
3. **Alerter & Mover** runs every 15 minutes. It routes results and user decisions between focused stores with copy-confirm-delete, then sends an idempotent Slack copy only for fresh ready rows in `To Apply`.

Applications are never submitted automatically. Slack and Sheet links only open `To Apply` or the source page. The user applies manually and then selects `I Applied` in `To Apply`.

## Fresh workbook

Run the generated `setupFreshJobPipeline()` Apps Script in a blank workbook. It creates:

- `Scraped Jobs`
- `To Review`
- `To Apply`
- `Applied Jobs`
- `Archive`
- `Search Keywords` (visible operator configuration)
- `_System` (hidden, short-lived claims only)

All five business tabs use the same complete ordered record schema. `To Review` exposes only `Approve`/`Deny`; `To Apply` exposes only `I Applied`/`Skip`; blank remains valid and workflow-side validation is authoritative. An empty default tab is removed. A non-empty unexpected tab or conflicting header stops setup. On first creation, `Search Keywords` is seeded with the ten current enabled keywords. Rerunning setup preserves keyword edits and valid operator data without recreating deleted rows or re-enabling disabled rows.

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
npm run capture:cutover -- pre_activation target-map.json evidence.json
npm run validate:cutover -- evidence.json
```

The segmented in-place migration has its own offline dry-run command. Its input may contain private job data, so neither snapshots nor generated plans are committed:

```bash
npm run plan:segmented-queues -- workbook-snapshot.json migration-plan.json 2026-07-31T00:00:00.000Z
```

All three workflow exports are checked in under `workflows/` and remain inactive after build. Importing an export does not authorize activation or deployment.

## Configuration

- `config/pipeline-schema.json` — versioned record, status, action, transition, and store contract.
- `config/review-sheet.json` — fresh Sheet ownership, columns, keyword seeds, validation, protection, and retired tabs.
- `config/search-plan.json` — exact 24-hour window, pagination, pacing, timeout, and retries; it contains no runtime keyword fallback.
- `config/runtime.json` — the three schedules, execution budgets, claims, retry bounds, and Generator batch cap.
- `config/alert-policy.json` — Slack eligibility, idempotency, timeout, and environment bindings.
- `config/n8n-deployment-policy.json` — exact three-role signatures, capacity, retention, monitoring, and cutover gates.
- Candidate, ranking, application, pack, and Groq policies remain versioned because truthful generation and provenance are safety requirements, not extra workflows.

See `docs/architecture.md`, `docs/data-contract.md`, `docs/sheet-schema.md`, and `docs/operations.md`.
