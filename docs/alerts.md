# High-match alerts

## Scope and safety boundary

`config/alert-policy.json` is the versioned source of truth for Slack alert
eligibility, cadence, caps, execution timeout, leases, retry limits, content
limits, and environment-variable names. The repository stores no webhook
credential. Alert actions never apply to a job or mutate a decision: one `Open
Review Queue` link opens the authorized simplified Google Sheet tab, while the
OnlineJobs.ph link is open-only. An eligible alert includes the complete
current validated application message in a copyable Slack code block; it does
not add clipboard authority or change the candidate's responsibility to review
and submit manually.

## Eligibility and queueing

The generator queues an alert only after committing a record whose lifecycle,
instruction-aware application pack, message content, and provenance are all
current and ready. The shared safety gate revalidates profile/policy/pack
versions, validation state, approved URLs, banned phrases, and pack structure.
The record must also meet every configured qualification, opportunity,
confidence, freshness, and major-gap rule, remain active, and have no
application decision. The current minimum qualification score is 70 and the
current minimum opportunity score is 50. Queuing is part of the same successful
record commit and stores:

- `alert_status=pending`
- the configured channel and policy version
- `alert_idempotency_key=<canonical_job_id>|<alert_policy_version>`
- zero attempts and an immediately due `alert_next_retry_at`

Ineligible records are explicit `not_eligible` records. An unsafe queued or
sending record is terminalized through a state-only alert claim with the stable
`message_quarantined` reason and no provider request. A queued job that becomes
unavailable is changed to `suppressed` under an alert claim and is not sent.
Changing the versioned policy creates a new idempotency scope; it is therefore
an operator-visible product change, not an invisible configuration edit.
Policy changes apply to newly committed packs and unsent pending or retryable
alerts. Records already marked `sent` are not replayed automatically.

## Provider configuration

Set these variables in the n8n runtime, not in workflow JSON or the Sheet:

- `JOB_PIPELINE_SLACK_WEBHOOK_URL`: an HTTPS incoming webhook on
  `hooks.slack.com` or `hooks.slack-gov.com`
- `JOB_PIPELINE_REVIEW_URL`: the credential-free HTTPS Google Sheets deep link
  for the authorized `Review Queue` tab, including its sheet identifier (for
  example, `https://docs.google.com/spreadsheets/d/.../edit#gid=...`)

The provider configuration is validated before each send. Missing or invalid
configuration produces a terminal, sanitized `configuration_error` and no HTTP
request. Set and smoke-test distinct non-production and production values
without recording their private workbook IDs. Each value must open with
`Review Queue` selected rather than defaulting to `Sheet1`. The review URL does
not grant authorization or contain a job ID, command, credential, action token,
or other mutation capability.

The Slack HTTP node references the webhook environment variable directly. The
credential is never copied into an n8n item, alert payload, Sheet field, or
execution log. Both the review and OnlineJobs.ph URLs are bounded by policy and
must be credential-free HTTPS URLs.

## Delivery and failure semantics

The 3-minute schedule selects only due `pending` or `retryable_failure`
records, orders them by opportunity, freshness, and canonical identity, and
applies a cap of 5. That matches the Generator’s maximum new ready records per
15-minute run while reducing idle Sheet reads from 1,440 to 480 per day. A
winning claim is persisted as `sending` before the Slack request. Confirmed
`2xx`/`ok` delivery becomes `sent` with a timestamp, attempt count, and optional
non-sensitive provider reference.

Known transient failures such as rate limiting or provider `5xx` responses use
bounded exponential backoff. The workflow has a 90-second execution timeout,
the claim lease is 2 minutes, and the first retry waits at least those 2
minutes. This ordering is a correctness requirement: a completed claim row
remains eligible for arbitration until expiry. Retrying or polling sooner would
append losing claims; those newer rows could continuously become the next
winner and starve the actual current retry. Policy validation therefore
requires the workflow timeout to be shorter than the lease, the lease to
expire before the next scheduled poll, the capped serial provider-timeout
budget to fit within the workflow timeout, and the base backoff to be no
shorter than the lease. Permanent rejection, exhausted attempts, missing
configuration, and ambiguous timeout become
`terminal_failure`. If the request may have succeeded but its final Sheet
acknowledgement was not persisted, the stale `sending` state becomes terminal
`ambiguous_delivery`; the workflow does not resend automatically. An operator
may inspect Slack and the Sheet before choosing a future policy-version change
or manual recovery.

Alert errors and execution summaries exclude credentials, raw provider
responses, full descriptions, resumes, and generated application messages. A
delivery failure never clears or rewrites the valid application pack.
Message fitting reserves the complete encoded application message and the
single Review Queue and source link tail before fitting optional context.
The application message uses only Slack-required literal escaping for `&`,
`<`, and `>` so its paragraphs and spacing remain intact when copied. Bounded
context fields are trimmed and then omitted from lowest priority when needed.
The application message and required links are never truncated.

A message containing a code-fence boundary, unsupported invisible control
characters, or content that cannot fit completely is a deterministic
non-retryable preflight failure. The workflow does not call Slack, does not
persist the complete message in its error evidence, atomically releases the
alert claim, and preserves the ready application pack. This path is distinct
from a provider timeout because delivery never began. A job with an invalid or
over-limit source URL remains ineligible rather than producing a partial action
set.

## Disabled import and rollback

Checked-in `workflows/alerter.json` is inactive. Import and rebind it against a
non-production Sheet first, supply test environment variables, and exercise
success, known transient rejection, invalid configuration, source suppression,
deterministic render failure, and a stale `sending` row. For the success case,
copy the Slack code-block content into a plain-text comparison surface and
verify it matches the stored message. In Slack desktop or web, click `Open
Review Queue`, confirm the intended tab is selected, and verify that merely
opening, forwarding, or reopening the link changes no job state. Activate the
alerter only after the generator and reviewer are verified.

To roll back, disable the alerter first and wait for running executions. Preserve
all alert fields and inspect any `sending` row as potentially delivered. Never
reset it to `pending` or delete delivery evidence merely to make it retry.
