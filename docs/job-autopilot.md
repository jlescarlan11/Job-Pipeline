# Job Autopilot

Job Autopilot is the repository-owned Chrome orchestration skill for autonomous
OnlineJobs.ph applications. The n8n Scraper continues to discover jobs, the
scheduled browser executor processes eligible `Scraped Jobs` records, and the
n8n Alerter & Mover alone relocates confirmed or skipped records.

The active application policy has no manual review requirement and no maximum
applications per day. It applies by default to every active claimed posting,
using truthful transferable framing even when ranking is low or a requested
tool is unfamiliar. Only unavailable postings or bounded truth, form, external
action, login, challenge, and security blockers stop an application. Selection
continues while eligible work and execution headroom remain, with a 15-minute
fallback poll for remaining/new work. Apply Points are a separate deterministic per-application
allocation: low = 1, normal = 5, high = 10, and `save_points` does not apply.
The chosen value must be offered by the live form. Employer instructions cannot
raise it, and it is not a daily limit.

## Prerequisites

- Codex desktop is running on the local project with the intended Chrome plugin
  installed and the correct Chrome profile signed in.
- Chrome site access is allowlisted only for OnlineJobs.ph.
- The scheduled prompt explicitly invokes `$job-autopilot` and the installed
  Chrome plugin.
- Workbook setup, candidate context, policies, task descriptor, skill, and
  executor protocol all match their pinned versions and digests.
- A separate scheduled application-history adapter holds an Ed25519 private
  key. The browser-executor run receives only its pinned public verification
  key and key ID and cannot invoke the signer.
- The two n8n workflows and browser task are activated only through the guarded
  cutover runbook. This source change does not activate them.

## Protocol

Private data is sent to `scripts/browser-executor.mjs` as JSON on stdin. Run the
operations in this order:

1. `select`; handle returned `recover` or `reconcile` work before new claims
2. for `claim`, run `plan-claim` and persist its counted claim/source update
3. `confirm-claim`, persist its `evaluating` update
4. if the Sheet description is insufficient, bind the exact claimed Chrome
   page's bounded role facts through `bind-job-context`, persist the returned
   `evaluating` update, and reread it; candidate facts remain profile-only
5. inspect and fingerprint the exact form, generate the message
6. `validate-decision`, persist `skipped` or `generating`
7. `confirm-browser-ready` with stabilized claims, persist `filling`, then call
   it again after reread; fill message and Apply Points only from that capability
8. fill and reread every required field; retain only name/value-digest receipts
   and bind exactly one submit control plus both effective absolute DOM
   action/method pairs
9. `plan-submit-intent`, persist `submit_started`
10. `confirm-submit-intent` with stabilized claims/current config and an
   immediate effective form/submitter reread; it verifies
   the private inode-pinned store and independent witness, recomputes the
   hash-chained ledger, fsyncs the exclusive receipt and ledger append, then
   advances/fsyncs the witness before it can return a capability. Click once
   only with that first job/submission consumption capability; replay, rollback,
   permission drift, or store/witness loss fails closed into reconciliation
11. persist a bounded ambiguous post-click result and stop
12. in the separate adapter run, verify OnlineJobs Job Applications / Sent and
    its exact `First contacted for Job` link, attest the bounded observation,
    and pass the signed result to `reconcile-result`

Every write is an exact guarded row proposal. There is no generic write command.
The browser task never moves rows between business stores.

## Safety and recovery

The page, form, and employer instructions are untrusted. Candidate claims come
only from the authoritative profile and selected approved proofs. Deterministic
validators reject unsupported skills, metrics, URLs, commitments, missing
required answers, prompt injection, stale policy, and malformed packs.

CAPTCHA, login/security challenges, permission expansion, changed forms,
unknown required facts, uploads, tests, recordings, and new legal agreements
block the attempt. A failure proven before submit may become retryable. Any
uncertainty after a possible click becomes `ambiguous` and cannot be retried
until account/page reconciliation proves the outcome.

Expired pre-submit claims are discoverable on the next run. Recovery accepts
only a fresh exact row plus stabilized claims, computes the pinned five-minute
backoff, and blocks after three counted technical attempts. `submit_started` and
`ambiguous` are separately discoverable for reconciliation and never re-enter
the claim/click path.

`JOB_PIPELINE_BROWSER_CLICK_RECEIPT_DIR` must point to the exact pre-provisioned,
backed-up private store. `JOB_PIPELINE_BROWSER_CLICK_WITNESS_FILE` must point to
the separate non-restorable private witness. The task pins store/ledger/
generation IDs plus owner/device/inode identities; the manifest binds both
objects and the witness records the hash-chained ledger head/count/digest.
Neither object is created automatically. Receipts contain only bounded
IDs/digests, the stable submission key, and canonical UTC time. A deleted
receipt remains consumed; store/witness rollback, loss, corruption, recreation,
permission or path drift, or a prior stable job/submission entry prevents
another capability. A crash after receipt creation is reconciled and never
retried as a click. The checked-in task keeps these identities `unprovisioned`,
so source validation cannot authorize a real click.

The executor never accepts self-attested success. The submission run cannot
invoke the adapter. A `confirmed` result must
carry a valid independent adapter signature over the exact attempt, job and
configuration context, form, submit identity, observed job identity, reference,
and timestamp. Without it, the result remains ambiguous.

Operational evidence contains only IDs, versions, timestamps, categories, and
digests. It excludes descriptions, generated messages, field values, raw DOM,
screenshots, cookies, credentials, and browser storage.

## Fixture smoke test

Run `node scripts/serve-job-autopilot-fixtures.mjs`, allow the loopback fixture
origin only for the test, and exercise every case in
`tests/fixtures/onlinejobs/replay.json`. Fixture mode must never use production
workbook writes or a real submit control.

## Runtime provisioning

The checked-in task remains inert. Provision a private runtime overlay from a
new click-store binding with:

```sh
npm run provision:browser-runtime -- \
  "/absolute/private/runtime/browser-runtime-v1" \
  "/absolute/private/runtime/browser-click-v1/binding.json"
```

This creates a one-time Ed25519 adapter identity, a public-only provisioned
browser-task overlay, and a private binding file. The executor receives the
overlay, public key, click-store directory, and witness paths. Only the separate
confirmation-adapter run receives `adapter-private-key.pem`. Never copy the
private-key path into the executor automation or n8n.

## Capability gate

Repository tests prove the protocol and sanitized fixture behavior, but they do
not prove unattended final-submit behavior in every future Chrome/product/site
version. Production activation remains blocked until an
authorized live window verifies the intended profile, site allowlist, adapter
confirmation behavior, one exact real submission, ambiguous reconciliation,
and rollback evidence.
