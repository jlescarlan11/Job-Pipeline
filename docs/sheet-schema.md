# Fresh workbook schema

Run the generated `setupFreshJobPipeline()` function from `google-apps-script/SheetSetup.gs` in a new workbook. It creates five visible business tabs, eleven visible configuration/context tabs, and one hidden operational tab:

- `Scraped Jobs`
- `To Review`
- `To Apply`
- `Applied Jobs`
- `Archive`
- `Search Keywords` (visible configuration)
- `Candidate`
- `Skills`
- `Experience`
- `Projects`
- `Education`
- `Awards`
- `Job Preferences`
- `Application Settings`
- `Required Style`
- `Banned Phrases`
- `_System` (hidden, short-lived claims only)

An empty default `Sheet1` or another empty unexpected tab is removed. Setup refuses to delete a non-empty unexpected tab or replace conflicting headers. This makes the fresh-start instruction explicit without silently destroying existing data.

## Scraped Jobs

`Scraped Jobs` owns new, processing, error, and unavailable intake records. It also briefly owns Generator results until Alerter & Mover routes them. Its visible columns are:

`pipeline_status`, `job_title`, `company`, `opportunity_score`, `decision_reason`, `required_input`, `generated_message`, `canonical_url`, `posted_at`, `matched_keywords`, `error_summary`, and `notes`.

Only `notes` is editable. There is no normal user-action dropdown on this sheet.

## To Review

`To Review` owns `review_needed` records. Its native action dropdown offers exactly `Approve` and `Deny`, and a blank cell remains valid. Visible columns are `user_action`, `job_title`, `company`, `opportunity_score`, `decision_reason`, `required_input`, `canonical_url`, `posted_at`, `matched_keywords`, and `notes`. Only `user_action` and `notes` are editable.

## To Apply

`To Apply` owns safely generated `ready_to_apply` records. Its native action dropdown offers exactly `I Applied` and `Skip`, and a blank cell remains valid. Visible columns are `user_action`, `job_title`, `company`, `opportunity_score`, `decision_reason`, `generated_message`, `canonical_url`, `posted_at`, `matched_keywords`, and `notes`. Only `user_action` and `notes` are editable.

Sheet validation is a usability control. The versioned store/status/action matrix in `config/pipeline-schema.json` remains authoritative when values are pasted or written through the API.

## Applied Jobs

`Applied Jobs` is written only after `I Applied` is accepted against a fresh `ready_to_apply` row and the destination copy is confirmed. Visible columns are:

`applied_at`, `job_title`, `company`, `generated_message`, `canonical_url`, `outcome`, `outcome_at`, and `notes`.

Only `outcome` and `notes` are editable. Outcomes are blank, `no_response`, `replied`, `interview`, `offer`, or `rejected`.

## Archive

`Archive` receives only:

- a system-owned `skip` as `automatic_skip`;
- `Skip` from a `ready_to_apply` row as `user_skip`; or
- `Deny` from a `review_needed` row as `review_denied`.

Visible columns are `archived_at`, `archive_reason`, `job_title`, `company`, `decision_reason`, `canonical_url`, and `notes`. Only `notes` is editable.

## Hidden record fields

All five business sheets share the exact ordered fields in `config/pipeline-schema.json`. Columns not listed above remain hidden so movement can preserve full safe provenance without a projection transform. Generated and identity fields use warning-only protections; workflow validation remains the security boundary.

The exact record columns are:

`source`, `source_job_id`, `canonical_job_id`, `record_version`,
`state_guard`, `canonical_url`, `job_title`, `company`, `job_description`,
`salary_text`, `posted_at`, `discovered_at`, `last_seen_at`,
`matched_keywords`, `source_availability`, `pipeline_status`, `user_action`,
`decision_reason`, `required_input`, `review_approved_at`,
`review_approval_note`, `qualification_score`,
`opportunity_score`, `ranking_confidence`, `match_reasons`,
`requirement_gaps`, `profile_version`, `policy_version`, `evaluated_at`,
`processing_stage`, `processing_token`, `processing_started_at`,
`attempt_count`, `next_retry_at`, `error_category`, `error_summary`,
`generated_message`, `message_validation_status`, `message_profile_version`,
`message_policy_version`, `generated_at`, `application_instructions`,
`screening_questions`, `selected_proof_refs`, `application_warnings`,
`application_pack_status`, `application_pack_version`,
`application_pack_profile_version`, `application_pack_policy_version`,
`application_pack_generated_at`, `alert_status`, `alert_idempotency_key`,
`alert_claim_token`,
`alert_attempt_count`, `alert_last_attempt_at`, `alert_next_retry_at`,
`alert_sent_at`, `alert_provider_reference`, `alert_error_category`,
`alert_error_summary`, `applied_at`, `archived_at`, `archive_reason`,
`outcome`, `outcome_recorded_value`, `outcome_at`, `notes`, `created_at`, and
`updated_at`.

`_System` contains only `claim_key`, `canonical_job_id`, `stage`, `token`, `created_at`, and `expires_at`. It is not a business-data store.

Setup is idempotent: rerunning it reconciles formatting, validation, protection, and visibility while preserving valid headers and operator data. It does not insert placeholders, call `openById`, use `IMPORTRANGE`, or copy a row from any old workbook.

## Existing-workbook migration planning

`planSegmentedQueueMigration()` in `src/fresh-sheet-setup.mjs` is a pure planner. It reads a supplied workbook snapshot but performs no Sheet mutation and never plans source deletion. For a valid legacy snapshot it proposes an in-place `Review Queue` → `Scraped Jobs` rename, creates missing steady-state tabs, and classifies rows as follows:

- operational rows remain in `Scraped Jobs`;
- `review_needed` rows, including pending `Approve` or `Deny`, route to `To Review`;
- `ready_to_apply` rows, including pending `I Applied` or `Skip`, route to `To Apply`;
- blank-action `skip` rows route to `Archive` as `automatic_skip`.

The same snapshot and reference time produce the same plan. Unknown status/action values, unsupported combinations, duplicate canonical identities, conflicting headers, coexisting `Review Queue`/`Scraped Jobs`, and unexpected non-empty tabs return bounded rejection categories with no routes or planned deletion. Production execution and rollback remain separate operator-controlled rollout steps.

## Search Keywords

`Search Keywords` is the runtime source of truth for Scraper keyword selection.
Its exact columns are `enabled` and `keyword`. `enabled` uses checkbox
validation, the header is warning-protected, and data rows remain editable
under the workbook's normal Google Sheets permissions.

When setup creates the tab for the first time, it seeds the ten current
keywords as enabled. Setup never seeds an already existing tab, including a
valid empty tab, so rerunning setup preserves additions, edits, row order,
disabled values, and deletions.

The Scraper reads this tab once before any OnlineJobs.ph request. It ignores
blank and disabled rows, normalizes enabled keyword text with NFKC and trimming,
and rejects malformed, missing, duplicate, or empty enabled configuration
before any source request or pipeline write. Internal keyword IDs are derived
by the workflow and are not operator-managed.

## Candidate context tabs

These tabs live in the separate Configuration workbook. The Generator and Alerter & Mover read all ten context tabs at the start of
every execution and freeze one validated snapshot. The workflow automatically
derives profile, ranking, and application context hashes, so operators do not
edit version identifiers.

- `Candidate` uses `field` and `value` for name, location, email, summary, and
  approved LinkedIn, GitHub, and portfolio URLs.
- `Skills` uses `enabled`, `category`, and `skill`.
- `Experience` uses `enabled`, `experience_id`, `title`, `organization`,
  `location`, `start`, `end`, and one `highlight` per row. Repeated rows with
  the same ID add highlights and must keep the other fields identical.
- `Projects` uses `enabled`, `project_id`, `name`, `description`, `url`,
  comma-separated `technologies`, and one `highlight` per row.
- `Education` uses `enabled`, `program`, `institution`, `start`, `end`, and
  `honor`.
- `Awards` uses `enabled` and `award`.
- `Job Preferences` uses `enabled`, `type`, `group`, `value`, and `score` for
  role-family evidence, unsupported technologies, and PHP monthly salary bands.
- `Application Settings` uses `key` and `value` for the word limit, subject
  template, greeting, and employer-format override.
- `Required Style` uses `enabled` and `style`; add one writing instruction per
  row.
- `Banned Phrases` uses `enabled` and `phrase`; add one disallowed phrase per
  row.

Enabled columns use checkboxes and every header is warning-protected. Data rows
remain editable. Missing required fields, conflicting repeated entities,
invalid URLs, duplicate skills, invalid evidence references, or malformed
preferences stop the execution before job claims, moves, alerts, or provider
requests. A context edit captured after an execution begins applies to the next
execution. Existing generated messages retain their historical hashes and are
not alert-eligible after the active context changes.
