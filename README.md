# Job Pipeline

A guarded autonomous job pipeline for OnlineJobs.ph:

```text
Scraper (n8n) → Browser Executor (scheduled Codex + Chrome) → Alerter & Mover (n8n)
```

The pipeline uses a Main Google workbook for queue records and a separate Configuration workbook for authoritative candidate context. `Scraped Jobs` owns autonomous work through decision, truthful message creation, Chrome fill, durable submit intent, confirmation, or a bounded blocker. `Applied Jobs` and `Archive` are terminal stores. `To Review` and `To Apply` remain compatible with legacy/manual records during guarded migration. The retained old workbook is backup/reference only and is never imported.

## Workflow behavior

1. **Scraper** runs every four hours. At execution start it reads and validates the enabled plain keywords in the visible `Search Keywords` tab, freezes that snapshot with one execution timestamp, and accepts only source postings in the inclusive range `[window_end - 24 hours, window_end]`. It deduplicates against all five business stores, appends new identities to `Scraped Jobs`, and updates discovery-owned fields in the current active owner.
2. **Browser Executor** is a scheduled Codex task every 90 minutes. It explicitly invokes the checked-in `job-autopilot` skill and installed Chrome plugin, claims one due record at a time, reads current authoritative context, decides under trusted policy, writes a truthful message, validates the live form, persists submit intent before clicking, confirms or reconciles the result, and commits only through the versioned executor protocol. Page content is untrusted. Login, CAPTCHA, unexpected agreements/uploads/tests, missing facts, browser failures, and ambiguous post-click states fail visibly and never invent facts or duplicate submissions.
3. **Alerter & Mover** runs every 15 minutes. It is the only role allowed to relocate a business row and always uses guarded copy-confirm-delete. It routes confirmed applications to `Applied Jobs`, automatic skips to `Archive`, preserves blockers for recovery, drains compatible legacy actions, and keeps bounded idempotent alerts/receipts.

Normal eligible applications are designed to submit automatically without routine review or `I Applied`. There is no maximum applications per day. Remaining work continues on later runs only because of technical headroom, durable recovery, Chrome availability, or site state. A confirmed outcome requires an independent signed account-history attestation; unavailable unattended confirmation is a release blocker and is never bypassed.

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
- `Job Preferences`, `Application Settings`, `Required Style`, `Banned Phrases`, and `Prompts`

All five business tabs use the same complete ordered v5 record schema and keep the newest lifecycle event directly below the header. Legacy `Proceed`/`Reject` and `I Applied`/`Skip` values remain readable for migration but do not authorize autonomous submission. The eleven context tabs divide identity, evidence, preferences, and application prompt templates into small editable tables. The browser executor freezes and validates current context before each attempt; Alerter & Mover relies on persisted outcomes and loads Configuration only for bounded notification work. Missing or malformed trusted context fails closed. Setup preserves operator edits and never relocates a business row.

For an existing v4 segmented Main workbook, the same Main setup has one narrow
in-place structural path: all five business tabs must have the exact ordered v4
headers, then the v5 autonomous-browser fields are inserted blank at their named
schema boundaries. It never copies or relocates a business row. Mixed, missing,
partial, reordered, or extended layouts stop before the first write; an
already-v5 workbook is an idempotent no-op apart from normal formatting,
validation, protection, and visibility reconciliation. A v3 workbook must first
use its separately reviewed v3-to-v4 upgrade; the current setup does not claim a
direct v3-to-v5 path.

## Local commands

```bash
npm run build
npm run validate
npm run validate:deployment -- --policy-only
npm run plan:autonomous-browser -- private-fresh-snapshot.json
npm run validate:autonomous-browser-cutover -- sanitized-evidence.json
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
Configuration workbooks, two pinned n8n workflow IDs, and one scheduled-browser
task contract in place. It does not provision a replacement production
workbook or reset existing rows.

The segmented in-place migration has its own offline dry-run command. Its input may contain private job data, so neither snapshots nor generated plans are committed:

```bash
npm run plan:segmented-queues -- workbook-snapshot.json migration-plan.json 2026-07-31T00:00:00.000Z
```

Exactly two n8n workflow exports are checked in under `workflows/` and remain inactive after build. The browser-task source contract is unscheduled. Importing an export does not authorize activation or deployment.

## Configuration

- `config/pipeline-schema.json` — versioned record, status, action, transition, and store contract.
- `config/review-sheet.json` — fresh Sheet ownership, columns, context/keyword bootstrap seeds, validation, protection, and retired tabs.
- `config/search-plan.json` — exact 24-hour window, pagination, pacing, timeout, and retries; it contains no runtime keyword fallback.
- `config/runtime.json` — two n8n schedules plus browser-task schedule, execution budgets, claims, retries, and technical headroom; it has no daily application cap.
- `config/alert-policy.json` — Slack eligibility, idempotency, timeout, and environment bindings.
- `config/alert-receipts.json` — bounded durable delivery-receipt states, Data Table binding, retry cap, and retention requirements.
- `config/browser-executor-task.json` — inactive scheduled-task, skill, Chrome plugin, project, executor protocol, and privacy contract.
- `config/n8n-deployment-policy.json` — exact mixed-role signatures, capacity, retention, monitoring, compatibility, and cutover gates.
- Candidate, ranking, application, and prompt files provide validated bootstrap defaults for a newly provisioned workbook. After the one-time workflow deployment, the corresponding visible context tabs are the runtime source. Pack, provider, runtime, and deterministic safety policies remain repository-controlled.

See `docs/architecture.md`, `docs/data-contract.md`, `docs/sheet-schema.md`,
`docs/operations.md`, and `docs/autonomous-browser-acceptance-matrix.md`.
