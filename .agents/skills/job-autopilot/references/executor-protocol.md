# Browser executor protocol

Authoritative protocol: `2026-08-10/v1` from `src/browser-executor.mjs`.

Pass private payloads to `scripts/browser-executor.mjs` as one JSON object on
stdin. The operation name is the only command-line argument. Never place a job
description, candidate context, generated message, field value, cookie, or
credential in arguments, logs, or telemetry.

## Required order

1. `select`: validate all five stores, global identity ownership, and stabilized
   claims. It returns one operation: `claim` for due work, `recover` for an
   expired pre-submit claim, or `reconcile` for `submit_started`/`ambiguous`.
   Selection has no item/day/date cap and stops only for execution headroom.
2. `plan-claim`: return an append-winner `_System` claim and exact proposed
   source update. This does not expose browser or ChatGPT context.
3. Persist the `_System` claim and proposed source update through the scheduled
   task's guarded Sheet adapter.
4. `confirm-claim`: provide stabilized `_System` rows and a fresh source reread.
   Only the winning exact claim returns the bounded private context. Persist and
   reread its exact `evaluating` source proposal, including the full
   `browser_context_digest`, before decision validation.
5. Generate a strict decision envelope with `protocol_version`, `attempt_id`,
   `context_digest`, `decision`, `reason_code`, and `message` for apply only.
6. `validate-decision`: include the bounded verified form inventory; recompute
   ranking, application pack, proofs, form fingerprint, submission identity,
   and message validation. Persist its exact proposed row.
7. `confirm-browser-ready`: supply the proposed `generating` row plus a fresh
   exact source reread and the stabilized current `_System` claims. Persist the
   returned `filling` proposal, then call the operation again after that exact
   reread. The winning claim and current configuration must still match. Use
   only its fill capability.
8. `plan-submit-intent`: supply bounded form inventory and reread-completed field
   receipts. Each receipt contains only a field name and the lowercase SHA-256
   of the UTF-8 JSON string encoding of its exact string value; it must match
   the authorized message or repository-owned deterministic per-application
   Apply Points value (low 1, normal 5, high 10; never `save_points`). Persist
   the exact `submit_started` row; it returns no click capability.
9. `confirm-submit-intent`: supply that plan, a fresh exact source reread, and
   an immediate second reread of the authorized field values plus the form and
   chosen submitter effective DOM action/method. Supply the stabilized `_System`
   claims and current timestamp. Only a
   still-winning claim under exact current profile/policies can consume the
   authorization. Before returning the one-click capability, the executor
   verifies the private pinned store and independent witness identities,
   manifest, and hash chain, then atomically creates/verifies/fsyncs the
   canonical-job-keyed receipt and directory before the ledger append, witness
   advance, and final directory sync named by
   `JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR`. An existing receipt/ledger entry or
   missing, recreated, moved, unprovisioned, malformed, busy, or changed store
   fails closed and routes to reconciliation without another click.
10. `commit-result`: for a pre-submit result, supply a fresh exact source reread
    and stabilized claims. It requires the current winning claim and current
    configuration, computes the pinned retry delay, and enforces the technical
    retry maximum.
11. `reconcile-result`: only for `submit_started` or `ambiguous`; supply a fresh
    exact source reread and current configuration. It cannot return a click or
    retry capability. A `confirmed` result additionally requires the independent
    adapter's Ed25519 attestation.
12. `recover`: only for an executor-selected expired/lost pre-submit claim.
    Supply the fresh exact source row and stabilized claims. The executor
    computes the retry time or blocks an exhausted attempt; caller-supplied
    retry times are rejected.

All write-producing operations return an exact `proposed_record`; none accepts
arbitrary field updates. Persist and reread before using the next capability.

## State meaning

- `queued`, `claimed`, `evaluating`, `generating`, `filling`: no submit occurred.
- `submit_started`: click may occur or may already have occurred; do not reset.
- `confirmed`: exact bounded browser/account confirmation was accepted.
- `retryable`: failure is proven pre-submit.
- `ambiguous`: submission may have occurred; reconcile, never retry blindly.
- `blocked`: a safety, fact, form, security, or capability boundary stopped work.
- `unavailable`: the posting is unavailable.
- `skipped`: policy deterministically chose not to apply.

`browser_attempt_id` is unique per winning claim. The submission idempotency key
is stable for the same canonical job/input/form/profile/policy contract and does
not contain the attempt ID. `browser_context_digest` binds the exact candidate
profile plus ranking, application, and pack policies and must remain unchanged
through fill, click authorization, and result commit.

The click-consumption receipt and ledger contain only schema/store/ledger/
generation identities, authorization/receipt digests, the stable submission
key, a digest of canonical job identity, hash-chain metadata, and canonical UTC
timestamps. The task pins lossless owner/device/inode identities for the private
store and a separate private witness. The manifest binds both; the witness pins
the full ledger count, hash-chain head, and file digest. It is advanced and
fsynced after the ledger and before capability release. A deleted receipt,
truncated or restored ledger, witness rollback, same-path recreation, permission
drift, an orphan canonical-job receipt, or duplicate job/submission identity
fails closed. The witness is never
restored or rebound. Loss requires task disablement, independent reconciliation,
and a new generation with new pins. A crash after durability but before the
click deliberately prefers a missed application over a duplicate.

## Bounded result envelopes

Use only these category codes: `missing_candidate_fact`, `login_required`,
`challenge`, `captcha`, `unexpected_agreement`, `unsafe_upload`,
`unsupported_external_step`, `invalid_form`, `policy_mismatch`,
`unsafe_page_content`, `posting_unavailable`, `navigation_failed`,
`transient_browser_failure`, `submission_uncertain`, `submission_rejected`, or
`confirmation_mismatch`. Definitive confirmation uses
`submission_confirmed` only inside the bounded evidence object.

Every `commit-result` or `reconcile-result` envelope contains `protocol_version`, `attempt_id`,
`job_digest`, `result`, and `evidence`. A post-submit result also contains the
exact `form_fingerprint`, `submission_idempotency_key`, and
`authorization_digest` returned by `confirm-submit-intent`. `ambiguous` uses
evidence category `submission_uncertain`. `confirmed` additionally contains
`confirmation_kind` (`confirmation_page` or `application_history`) and a
bounded opaque `confirmation_reference`, the exact observed source job ID, and
the normalized claimed canonical job URL. Evidence supplies `observed_at` and
the lowercase SHA-256 of the UTF-8 JSON string encoding of the exact reference.
The envelope also contains `confirmation_attestation` with exact keys
`algorithm`, `key_id`, `witness_digest`, and `signature`. The executor verifies
that signature with its separately configured public key; the private key is
held only by the independent application-history adapter. The executor requires
all of them to bind to the persisted submit intent. Do not put page text,
unrelated URLs, messages, DOM, or field values in evidence.

Pre-submit unexpected confirmation example:

```json
{
  "protocol_version": "2026-08-10/v1",
  "attempt_id": "attempt-v1:<64-lowercase-hex>",
  "job_digest": "job-v1:<64-lowercase-hex>",
  "result": "blocked",
  "evidence": {
    "category": "unsupported_external_step",
    "summary": "Unexpected product confirmation requires interaction.",
    "observed_at": "<ISO-8601 timestamp>"
  }
}
```

Unproven post-submit example:

```json
{
  "protocol_version": "2026-08-10/v1",
  "attempt_id": "attempt-v1:<64-lowercase-hex>",
  "job_digest": "job-v1:<64-lowercase-hex>",
  "result": "ambiguous",
  "evidence": {
    "category": "submission_uncertain",
    "summary": "No definitive confirmation was observable.",
    "observed_at": "<ISO-8601 timestamp>"
  },
  "form_fingerprint": "form-v1:<64-lowercase-hex>",
  "submission_idempotency_key": "submission-v1:<64-lowercase-hex>",
  "authorization_digest": "<64-lowercase-hex>"
}
```

Definitive claimed-job confirmation example:

```json
{
  "protocol_version": "2026-08-10/v1",
  "attempt_id": "attempt-v1:<64-lowercase-hex>",
  "job_digest": "job-v1:<64-lowercase-hex>",
  "result": "confirmed",
  "evidence": {
    "category": "submission_confirmed",
    "observed_at": "<ISO-8601 timestamp>",
    "reference_digest": "<64-lowercase-hex>"
  },
  "form_fingerprint": "form-v1:<64-lowercase-hex>",
  "submission_idempotency_key": "submission-v1:<64-lowercase-hex>",
  "authorization_digest": "<64-lowercase-hex>",
  "confirmation_kind": "confirmation_page",
  "confirmation_reference": "application/receipt-example",
  "observed_source_job_id": "example-source-id",
  "observed_canonical_url": "https://onlinejobs.ph/jobseekers/job/example-source-id",
  "confirmation_attestation": {
    "algorithm": "ed25519",
    "key_id": "configured-history-adapter-key",
    "witness_digest": "witness-v1:<64-lowercase-hex>",
    "signature": "<base64url-ed25519-signature>"
  }
}
```
