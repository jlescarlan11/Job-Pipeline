# Fresh workbook schema

Run the generated `setupFreshJobPipeline()` function from `google-apps-script/SheetSetup.gs` in a new workbook. It creates exactly three visible business tabs and one hidden operational tab:

- `Review Queue`
- `Applied Jobs`
- `Archive`
- `_System` (hidden, short-lived claims only)

An empty default `Sheet1` or another empty unexpected tab is removed. Setup refuses to delete a non-empty unexpected tab or replace conflicting headers. This makes the fresh-start instruction explicit without silently destroying existing data.

## Review Queue

`Review Queue` is the authoritative active record, not a projection. Its visible columns are:

`pipeline_status`, `user_action`, `job_title`, `company`, `opportunity_score`, `decision_reason`, `required_input`, `generated_message`, `canonical_url`, `posted_at`, `matched_keywords`, `error_summary`, and `notes`.

Only `user_action` and `notes` are editable. The action cell rejects a value that is not allowed for the row’s current status.

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

All three business sheets share the exact ordered fields in `config/pipeline-schema.json`. Columns not listed above remain hidden so a terminal record can preserve its full safe provenance without a second projection model. Generated and identity fields use warning-only protections; workflow validation remains the security boundary.

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
