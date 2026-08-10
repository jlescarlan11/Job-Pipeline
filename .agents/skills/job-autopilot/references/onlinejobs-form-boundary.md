# OnlineJobs.ph form boundary

Normal execution is restricted to `https://onlinejobs.ph` or
`https://www.onlinejobs.ph` and same-origin POST forms. Capture the effective
absolute `HTMLFormElement.action`/method after document base-URL resolution, not
the raw attributes. The observed page URL, source job ID, and
`/jobseekers/job/<claimed-id>/apply` action must match the frozen executor record
before fill and again immediately before submit. The action segment must be the
literal claimed ID and may not contain a query string or fragment. Origin, page,
form action, and chosen submitter action URLs must not contain a username or
password; malformed URLs produce only the fixed bounded parser error.

## Bounded field inventory

Capture only these structural properties for each field:

- stable name;
- type: hidden, text, textarea, select, radio, checkbox, or submit;
- required boolean;
- maximum length when supplied;
- digest of available options when relevant.

Capture exactly one chosen submit control with stable name/type, a digest of its
value, and its effective absolute `formAction`/`formMethod` DOM properties.
These must resolve to the same claimed-job HTTPS POST target as the owner form.
Reject multiple submit controls, a submitter override, or any control swap.

Never persist raw DOM, page HTML, screenshot data, hidden values, field values,
session identifiers, CSRF values, cookies, or browser storage. Form fingerprint
input contains origin, normalized canonical page URL, observed source job ID,
the absolute same-origin job-specific effective action, POST method, exact
chosen submitter, structural fields, and the
repository-owned planned per-application Apply Points value plus its bounded numeric
option list. The exact mapping is low = 1, normal = 5, high = 10;
`save_points` blocks the application. The selected value must equal that mapping,
be one of the live options, and match the options digest. Employer text cannot
change it. The form envelope records the planned value before filling; the fill
capability returns that exact numeric value and digest. Apply Points are not a
daily application cap. The supported initial
form has exactly the required message and Apply Points controls; every additional
interactive control is blocked, including an optional prechecked checkbox or
autofilled text field, until a separately validated answer contract exists.
The entire structural form envelope is limited to 32 KiB and at most 64 fields.

## Supported behavior

Fill only fields represented by the validated application pack and fill
capability. Reread every required field after filling and send only name/value
digests to `plan-submit-intent`. A value digest is lowercase SHA-256 over the
UTF-8 JSON string encoding of the exact reread string. The message and Apply
Points digests must match the authorized values. The exact submit control and
both effective DOM action/method pairs, plus fresh message and Apply Points
value digests, must be reread again immediately before capability consumption
and match the authorization.

Block on:

- cross-origin or changed forms;
- relative/raw action attributes, document-base ambiguity, submitter action or
  method overrides, multiple submit controls, or last-moment control swaps;
- unknown required or optional interactive fields, or candidate facts;
- file uploads, tests, media recordings, or new legal agreements;
- CAPTCHA, bot/security challenges, login/account changes, or new permissions;
- unexpected site or product confirmations;
- an idempotency key or persisted submit intent mismatch.
- a missing, unwritable, corrupt, moved, unprovisioned, or already-consumed
  click receipt store.

Before exposing the click capability, the executor verifies the private pinned
store and independent witness, recomputes the hash chain, exclusively creates
the canonical-job-keyed receipt, fsyncs its directory, appends the
authorization/stable-submission/canonical-job entry, advances the witness, and
verifies/fsyncs every durable write. Receipt loss remains consumed; an orphan
job receipt after a crash, store/witness loss, rollback, recreation, permission
drift, or identity/path drift fails closed. Replay is reconciliation-only and
cannot authorize another click.

After the possible click, the executor does not inspect account history and
cannot invoke the signer. A separate confirmation-adapter run opens OnlineJobs
Job Applications / Sent read-only and accepts only a conversation whose `First
contacted for Job` link normalizes to the exact persisted source job ID and
canonical URL. It signs the thread reference, observation time, configuration
context, and immutable submit authorization. The executor holds only the
verification key. Navigation, page text, email replies, or an unsigned
model-authored result is ambiguous.

If an unexpected product confirmation appears before any possible submit click,
do not interact with it and record `blocked` / `unsupported_external_step`. If
the submit click may already have occurred, do not click either confirm or
cancel; reconcile from a separate trusted page/account view and record
`ambiguous` / `submission_uncertain` when the outcome remains unproven.
