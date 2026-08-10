# OnlineJobs.ph form boundary

Normal execution is restricted to `https://onlinejobs.ph` or
`https://www.onlinejobs.ph` and same-origin POST forms. The observed page URL,
source job ID, and `/jobseekers/job/<claimed-id>/apply` action must match the
frozen executor record before fill or submit.

## Bounded field inventory

Capture only these structural properties for each field:

- stable name;
- type: hidden, text, textarea, select, radio, checkbox, or submit;
- required boolean;
- maximum length when supplied;
- digest of available options when relevant.

Never persist raw DOM, page HTML, screenshot data, hidden values, field values,
session identifiers, CSRF values, cookies, or browser storage. Form fingerprint
input contains origin, normalized canonical page URL, observed source job ID,
same-origin job-specific action path, POST method, structural fields, and the
required live per-application Apply Points value plus its bounded numeric option
list. The selected value must be one of those options and the options digest
must match. Apply Points are not a daily application cap. The supported initial
form has exactly the required message and Apply Points controls; any additional
required answer is blocked until a separately validated answer contract exists.

## Supported behavior

Fill only fields represented by the validated application pack and fill
capability. Reread every required field after filling and send only name/value
digests to `plan-submit-intent`. A value digest is lowercase SHA-256 over the
UTF-8 JSON string encoding of the exact reread string. The message and Apply
Points digests must match the authorized values. The final submit control must
belong to the fingerprinted same-origin claimed-job form.

Block on:

- cross-origin or changed forms;
- unknown required fields or candidate facts;
- file uploads, tests, media recordings, or new legal agreements;
- CAPTCHA, bot/security challenges, login/account changes, or new permissions;
- unexpected site or product confirmations;
- an idempotency key or persisted submit intent mismatch.

After the possible click, accept confirmation only when the independent
application-history adapter verifies the signed-in account record and signs the
exact source job ID, canonical job URL, reference digest, time, configuration
context, and immutable submit authorization. The browser task holds only the
verification key. Navigation, page text, or an unsigned model-authored result
is ambiguous.

If an unexpected product confirmation appears before any possible submit click,
do not interact with it and record `blocked` / `unsupported_external_step`. If
the submit click may already have occurred, do not click either confirm or
cancel; reconcile from a separate trusted page/account view and record
`ambiguous` / `submission_uncertain` when the outcome remains unproven.
