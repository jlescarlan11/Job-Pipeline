# High-match alerts

## Scope and safety boundary

`config/alert-policy.json` is the versioned source of truth for Slack alert
eligibility, cadence, caps, leases, retry limits, content limits, and
environment-variable names. The repository stores no webhook credential. Alert
actions never apply to a job or mutate a decision: review and skip both open the
authorized Google Sheet review surface, while the OnlineJobs.ph link is
open-only.

## Eligibility and queueing

The generator queues an alert only after committing a record whose lifecycle
and instruction-aware application pack are ready. The record must meet every
configured qualification, opportunity, confidence, freshness, and major-gap
rule, remain active, and have no application decision. Queuing is part of the
same successful record commit and stores:

- `alert_status=pending`
- the configured channel and policy version
- `alert_idempotency_key=<canonical_job_id>|<alert_policy_version>`
- zero attempts and an immediately due `alert_next_retry_at`

Ineligible records are explicit `not_eligible` records. A queued job that becomes
unavailable is changed to `suppressed` under an alert claim and is not sent.
Changing the versioned policy creates a new idempotency scope; it is therefore
an operator-visible product change, not an invisible configuration edit.

## Provider configuration

Set these variables in the n8n runtime, not in workflow JSON or the Sheet:

- `JOB_PIPELINE_SLACK_WEBHOOK_URL`: an HTTPS incoming webhook on
  `hooks.slack.com` or `hooks.slack-gov.com`
- `JOB_PIPELINE_REVIEW_URL`: the HTTPS URL of the authorized review Sheet

The provider configuration is validated before each send. Missing or invalid
configuration produces a terminal, sanitized `configuration_error` and no HTTP
request. Rebind and smoke-test the Google Sheet and credentials independently;
the review URL does not grant authorization by itself.

The Slack HTTP node references the webhook environment variable directly. The
credential is never copied into an n8n item, alert payload, Sheet field, or
execution log. Both the review and OnlineJobs.ph URLs are bounded by policy and
must be credential-free HTTPS URLs.

## Delivery and failure semantics

The minute schedule selects only due `pending` or `retryable_failure` records,
orders them by opportunity, freshness, and canonical identity, and applies the
configured per-run cap. A winning claim is persisted as `sending` before the
Slack request. Confirmed `2xx`/`ok` delivery becomes `sent` with a timestamp,
attempt count, and optional non-sensitive provider reference.

Known transient failures such as rate limiting or provider `5xx` responses use
bounded exponential backoff. Permanent rejection, exhausted attempts, missing
configuration, and ambiguous timeout become `terminal_failure`. If the request
may have succeeded but its final Sheet acknowledgement was not persisted, the
stale `sending` state becomes terminal `ambiguous_delivery`; the workflow does
not resend automatically. An operator may inspect Slack and the Sheet before
choosing a future policy-version change or manual recovery.

Alert errors and execution summaries exclude credentials, raw provider
responses, full descriptions, resumes, and generated application messages. A
delivery failure never clears or rewrites the valid application pack.
Message fitting trims bounded context fields first and preserves the complete
review, skip-confirmation, and source link tail. A job with an invalid or
over-limit source URL is ineligible rather than producing a partial action set.

## Disabled import and rollback

Checked-in `workflows/alerter.json` is inactive. Import and rebind it against a
non-production Sheet first, supply test environment variables, and exercise
success, known transient rejection, invalid configuration, source suppression,
and a stale `sending` row. Activate it only after the generator and reviewer are
verified.

To roll back, disable the alerter first and wait for running executions. Preserve
all alert fields and inspect any `sending` row as potentially delivered. Never
reset it to `pending` or delete delivery evidence merely to make it retry.
