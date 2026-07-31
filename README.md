# Job Pipeline

A small, manual-application job pipeline for OnlineJobs.ph:

```text
Scraper → Evaluator & Generator → Alerter & Mover
```

The replacement starts with a new Google workbook. `Review Queue` is the active source of truth, `Applied Jobs` owns applications the user says they submitted, and `Archive` owns automatic skips, user skips, and review denials. The retained old workbook is a backup/reference and is never imported.

## Workflow behavior

1. **Scraper** runs every four hours. It searches the enabled plain keywords in `config/search-plan.json`, captures one fixed execution timestamp, and accepts only source postings in the inclusive range `[window_end - 24 hours, window_end]`. It deduplicates against all three stores.
2. **Evaluator & Generator** runs every 90 minutes and freezes at most the first five eligible rows per execution. It processes that fixed batch sequentially, with an independent append-winner claim, evaluation, generation, guarded commit, and persistence confirmation for each row, followed by a 20-second production Sheet pacing interval. It routes to `ready_to_apply`, `review_needed`, or `skip`; provider and source failures become observable `error`/`unavailable` conditions and do not stop later rows. A ready row requires a current, validated application pack and message. Each row allows one initial model request and, only after deterministic rejection, one bounded repair request.
3. **Alerter & Mover** runs every 15 minutes. It sends an idempotent Slack copy for fresh ready rows and independently processes terminal moves with copy-confirm-delete.

Applications are never submitted automatically. Slack and Sheet links only open review/source pages. The user applies manually and then selects `I Applied`.

## Fresh workbook

Run the generated `setupFreshJobPipeline()` Apps Script in a blank workbook. It creates:

- `Review Queue`
- `Applied Jobs`
- `Archive`
- `_System` (hidden, short-lived claims only)

An empty default tab is removed. A non-empty unexpected tab or conflicting header stops setup. Rerunning setup preserves valid operator data and does not create rows.

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

All three workflow exports are checked in under `workflows/` and remain inactive after build. Importing an export does not authorize activation or deployment.

## Configuration

- `config/pipeline-schema.json` — versioned record, status, action, transition, and store contract.
- `config/review-sheet.json` — fresh Sheet ownership, columns, validation, protection, and retired tabs.
- `config/search-plan.json` — enabled keywords, exact 24-hour window, pagination, pacing, timeout, and retries.
- `config/runtime.json` — the three schedules, execution budgets, claims, retry bounds, and Generator batch cap.
- `config/alert-policy.json` — Slack eligibility, idempotency, timeout, and environment bindings.
- `config/n8n-deployment-policy.json` — exact three-role signatures, capacity, retention, monitoring, and cutover gates.
- Candidate, ranking, application, pack, and Groq policies remain versioned because truthful generation and provenance are safety requirements, not extra workflows.

See `docs/architecture.md`, `docs/data-contract.md`, `docs/sheet-schema.md`, and `docs/operations.md`.
