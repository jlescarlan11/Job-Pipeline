# Architecture

## System boundary

Job Pipeline is four disabled-by-default n8n workflows sharing Google Sheets as durable state. OnlineJobs.ph is read-only. Groq is used only after deterministic evaluation routing. The candidate remains the only actor authorized to submit an application or record an application decision.

```text
OnlineJobs.ph search pages
        |
        v
Scraper (4h) -- discovery claims --> ProcessingClaims
        |
        v
Sheet1: discovered jobs
        |
        v
Generator (15m, cap 5) -- evaluation/generation claims --> ProcessingClaims
        |
        v
Sheet1: recommended / review_required / ready / recovery
        |
        v
Reviewer (5m) <-- explicit manual_action
        |
        +--> Dashboard: current funnel summary
        |
        v
Archiver (45m) -- archive claims --> ProcessingClaims
        |
        v
Archive: terminal history and employer outcomes
```

Configured schedules are scraper every 4 hours, generator every 15 minutes, reviewer every 5 minutes, and archiver every 45 minutes.

## Shared contracts

`config/candidate-profile.json` is the only factual resume source. `config/application-policy.json` is separate so writing preferences cannot become candidate facts. Every evaluation and generated message records the profile version used.

`config/pipeline-schema.json` defines the logical record. `canonical_job_id` is `onlinejobs.ph:<source_job_id>` when OnlineJobs.ph exposes an ID; otherwise it is a deterministic hash of the normalized canonical URL. Mutable Sheet row numbers are transport metadata only.

`state_guard` is a deterministic composite of canonical identity, pipeline status, application decision, and outcome. Generator claim marking matches this guard, so a manual lifecycle update completed before the claim write prevents the stale automation from acquiring the row. Final evaluation/generation commits match the unique `processing_token`, so a manual action that clears or replaces the token prevents a stale result from overwriting the decision. Completed commits leave the last token as an optimistic-concurrency sentinel while clearing the processing stage/start time; the next legitimate claim overwrites it. There is no canonical-ID cleanup write that could erase a newer claim.

`ProcessingClaims` is append-only. For a canonical job and stage, the lowest valid Sheet row number wins until its 10-minute lease expires. This arbitrates concurrent discovery, evaluation, generation, and archival executions without treating a mutable active-row number as identity.

## Discovery workflow

`config/search-plan.json` defines 22 enabled, evidence-linked queries across full-stack, frontend, backend/API, React/Next.js/TypeScript/Node.js, database, Flutter/mobile, ASP.NET Core/C#, automation/AI integration, production support, and payment integration. Validation rejects duplicate queries and evidence references absent from the profile.

Each scheduled run emits at most 66 page requests: 22 queries multiplied by 3 pages. Requests are paced one every 2 seconds, time out after 15 seconds, and retry up to 3 times with 5-second waits. Saved search pages are parsed as parent cards to keep title, URL, date, description, badge, and salary aligned. A seven-day cutoff and seniority exclusion remain configured.

Successful pages are retained when another page/query fails. Coverage records `complete`, `empty`, `partial`, or `failed` per query; reaching the configured page cap while a next page exists is `partial`, never `complete`.

Discovery reconciliation combines query and role-family provenance, updates `last_seen_at`, and preserves existing evaluation, message, manual decision, and outcome fields. Active and Archive legacy URLs participate in deduplication. Concurrent new rows pass through append-only discovery claims before insertion.

## Evaluation and generation workflow

Eligible records are ordered by generation stage, match score, then oldest posted/created time, and capped at 5 per execution. Existing application decisions and historical ready messages are not selected.

Evaluation work uses a stored description when available; otherwise it fetches the detail page once and persists parsed metadata for reuse. Deleted/unavailable pages route to `unavailable`; insufficient content routes to `unscorable`. Deterministic evaluation uses full description evidence, known skills, role family, unsupported requirements, and seniority. It stores score, tier, decision, reasons, gaps, profile version, and timestamp.

Only `recommended` records or explicit supported promotions reach Groq. The generated system message is built from the canonical profile plus application policy. Post-generation validation rejects empty output, excess length, unapproved URLs, obsolete projects, unsupported technologies, unsupported numeric claims, phone numbers, and banned phrases. A validated message preserves line breaks and becomes `ready`; no node submits it.

The workflow runs every 15 minutes. It makes at most 5 generation selections per run. Detail HTTP calls time out after 15 seconds and retry up to 3 times with 5-second in-node waits, which stay below the 10-minute claim lease. Retryable stage failures record stage, category, sanitized summary, attempt count, and exponential next-retry time starting at 5 minutes. The third failed attempt, validation failure, or non-retryable request becomes `terminal_error`.

## Review workflow

The Sheet is the human interface. Only `manual_action` and `notes` are intended for direct editing. Supported actions are:

- `promote`, `regenerate`, `retry`
- `mark_applied`, `mark_skipped`
- `outcome_no_response`, `outcome_replied`, `outcome_interview`, `outcome_offer`, `outcome_rejected`, `clear_outcome`

No action means no lifecycle change. Unsupported actions or invalid transitions are logged and leave the previous record intact. Application decision and employer outcome are separate from processing/error state. Outcomes can be updated on archived applied records without replacing the message, profile version, evaluation, or application decision.

The Dashboard upserts one deduplicated current summary and never infers a reply, interview, offer, or rejection from `applied`.

## Archive workflow

Archival is eligible only for configured `applied`, `skipped`, `not_recommended`, and `terminal_error` records. `retryable_error` remains active.

For each winning archive claim:

1. Merge with any existing archive history by canonical identity/legacy URL.
2. Upsert the complete record into Archive by `canonical_job_id`.
3. Reread Archive and Sheet1.
4. Reject deletion if the active row identity changed, any supported source field changed after planning, or the archive copy is missing/stale.
5. Delete confirmed Sheet1 rows in descending row order.

An interrupted run may temporarily leave one copy in both tabs; retry reconciliation treats that as recoverable. It cannot authorize deletion merely because a minimal archive row exists.

## Physical storage and compatibility

Arrays such as query provenance, role families, reasons, and gaps are serialized as JSON strings in Sheets and normalized on read. Blank company, salary, outcome, or profile metadata means unknown, not “Not Given.”

`google-apps-script/SheetSetup.gs` is additive: it creates missing tabs/headers, copies legacy `created_at ` values into `created_at`, populates canonical identity/state guards and legacy versions, orders human review columns, applies manual-action validation, and uses warning-only protection for generated fields. Existing legacy headers remain for rollback compatibility.

## Operational visibility

Workflow execution logs emit structured summaries for discovery coverage, claim winners/losses, archive planning/reconciliation, and invalid review actions. Durable recovery data lives in `pipeline_status`, `processing_stage`, `attempt_count`, `failed_stage`, `next_retry_at`, `error_category`, and `error_summary`. Logs must remain sanitized: no API keys, authorization headers, raw provider responses, or full resume/job-description payloads.

Workflow JSON contains credential and Sheet references inherited from the existing exports but no secret material. Operators must rebind those references to the intended environment after import.
