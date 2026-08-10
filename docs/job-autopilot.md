# Job Autopilot

Job Autopilot is the repository-owned Chrome orchestration skill for autonomous
OnlineJobs.ph applications. The n8n Scraper continues to discover jobs, the
scheduled browser executor processes eligible `Scraped Jobs` records, and the
n8n Alerter & Mover alone relocates confirmed or skipped records.

The active application policy has no manual review requirement and no maximum
applications per day. Selection continues while eligible work and execution
headroom remain. Apply Points use the required current value exposed by each
live job form; they are not a daily limit.

## Prerequisites

- Codex desktop is running on the local project with the intended Chrome plugin
  installed and the correct Chrome profile signed in.
- Chrome site access is allowlisted only for OnlineJobs.ph.
- The scheduled prompt explicitly invokes `$job-autopilot` and the installed
  Chrome plugin.
- Workbook setup, candidate context, policies, task descriptor, skill, and
  executor protocol all match their pinned versions and digests.
- An independent application-history adapter holds an Ed25519 private key and
  the task receives only its pinned public verification key and key ID.
- The two n8n workflows and browser task are activated only through the guarded
  cutover runbook. This source change does not activate them.

## Protocol

Private data is sent to `scripts/browser-executor.mjs` as JSON on stdin. Run the
operations in this order:

1. `select`
2. `plan-claim`, persist claim/source update
3. `confirm-claim`, persist its `evaluating` update
4. inspect and fingerprint the exact form, generate the message
5. `validate-decision`, persist `skipped` or `generating`
6. `confirm-browser-ready` with stabilized claims, persist `filling`, then call
   it again after reread
7. fill and reread every required field; retain only name/value-digest receipts
8. `plan-submit-intent`, persist `submit_started`
9. `confirm-submit-intent` with stabilized claims/current config, click once
   only with its capability
10. obtain the independent account-history attestation and `commit-result`

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

The executor never accepts self-attested success. A `confirmed` result must
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

## Capability gate

Repository tests prove the protocol and sanitized fixture behavior, but they do
not prove unattended final-submit behavior in the installed Chrome/product/site
combination, and no trusted attestation adapter/public key has been provisioned
by this source-only change. Production activation remains blocked until an
authorized live window verifies the intended profile, site allowlist, adapter
confirmation behavior, one exact real submission, ambiguous reconciliation,
and rollback evidence.
