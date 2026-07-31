# Five-job Generator change-set ledger — 2026-07-31

Comparison base: `ae827d1648fb985ebb5f5a84c0bcf47f658afc8e`.

Risk classification is **HIGH** because the change affects a scheduled
production integration, durable Google Sheet state, external model calls,
claims, retries, idempotency, generated artifacts, and deployment recovery.

| Change unit | Issue provenance | Purpose and inspected boundaries | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `config/runtime.json`, `src/runtime.mjs` | #47 | Set cap five; validate integer range 1–5 while preserving schedule, timeout, lease, and retries. Runtime callers, schedules, deployment calculations, and boundary tests inspected. | High | REVIEWED_AFTER_FIX |
| `config/groq-provider-policy.json`, `src/groq-provider.mjs` | #47 | Split initial/repair models; bound prompts, per-model quotas, shared-model quotas, per-minute pacing, daily use, and timeout. Build, benchmark, pricing, lifecycle, and failure boundaries inspected. | High | REVIEWED_AFTER_FIX |
| `src/evaluation.mjs`, `src/generator.mjs` | #47/#48 | Compact the initial packet; create standalone repair; add exact claim persistence confirmation. Candidate/profile trust boundary, pack/message validators, failure redaction, previous-message retention, and commit guards inspected. | High | REVIEWED_AFTER_FIX |
| `scripts/build-workflows.mjs` | #48 | Generate fixed five selection, batch-one loop, append-winner and fresh-row claim gates, item-local provider/commit paths, failure continuation, pacing, and one sanitized event per attempt. Sheet reads/writes, provider calls, loop outputs, stale-state guards, and no-retry behavior inspected. | High | REVIEWED_AFTER_FIX |
| `scripts/benchmark-groq-models.mjs` | #47 | Exercise the actual 120B initial/20B repair route and calculate each call with its model price without exposing content. Live response parsing, measurement gate, pacing, and sanitization inspected. | High | REVIEWED_CLEAN |
| `workflows/generator.json` | #48 | Deterministic generated 46-node artifact for the sequential lifecycle. Source/artifact drift, n8n 2.32.6 import/export, graph topology, settings, env bindings, retry flags, and endpoint surface inspected. | High | REVIEWED_AFTER_FIX |
| `workflows/alerter-mover.json` | #48 regression | Deterministic regeneration carries the shared compact evaluation/message helpers; movement and alert topology is otherwise unchanged. Artifact drift, message safety, alert idempotency, writes, and endpoints inspected. | High | REVIEWED_CLEAN |
| `tests/runtime.test.mjs`, `tests/groq-provider.test.mjs` | #47 | Cover cap boundaries; exact 17/80/170 capacity; per-model RPM/TPM/RPD/TPD; shared quota; timeout; prompt budget; and activation assessment. | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-generator.test.mjs`, `tests/system-claims.test.mjs` | #48 | Cover zero through six selection, mixed results, failure isolation, distinct claims, exact claim reread, ambiguity, stale state, and overlap winner. | Moderate | REVIEWED_AFTER_FIX |
| `tests/simplified-workflows.test.mjs` | #48 | Cover loop graph, just-in-time claim reread, item linkage, failure continuation, one event, model route, no Groq/write retry, and no auto-submit. | Moderate | REVIEWED_AFTER_FIX |
| `tests/e2e.test.mjs` | #48 | Cover a fixed five of six batch, one failed job plus four ready jobs, and repeated downstream Alerter no-replay. | Moderate | REVIEWED_CLEAN |
| `tests/evaluation-generation.test.mjs` | #47 regression | Keep prompt authority and safety assertions aligned with compact wording without weakening the deterministic gates. | Moderate | REVIEWED_CLEAN |
| `tests/docs.test.mjs` | #47/#48/#49 | Require five-job, sequential, capacity, evidence, and `main` deployment-gate documentation. | Low | REVIEWED_CLEAN |
| `README.md`, `docs/architecture.md`, `docs/master-prompt.md` | #47/#48 | Replace one-row/single-model descriptions with fixed-batch, sequential, split-model, and failure-isolation contracts. | Low | REVIEWED_CLEAN |
| `docs/groq-provider-policy.md`, `docs/n8n-deployment.md`, `docs/operations.md` | #47/#48/#49 | Document verified quotas, pacing, smoke matrix, in-place deployment identity, rollback, and exact-commit gate. | Low | REVIEWED_CLEAN |
| `docs/acceptance-matrix.md`, `docs/generator-batch-verification-2026-07-31.md` | #47/#48/#49 | Record stable criterion IDs/statuses, direct evidence, and the explicit production blocker without rewriting historical cutover evidence. | Low | REVIEWED_CLEAN |
| `outputs/generator-batch-20260731/*.json` | #47/#48/#49 | Retain only sanitized permission, benchmark, isolated n8n import, and read-only production pre-deployment evidence. Secret-shaped value scan, JSON parse, measurement fields, bounded identities/state, rollback reference, and production-mutation flags inspected. | Moderate | REVIEWED_CLEAN |
| This ledger | #47/#48/#49 | Account for every source, configuration, test, artifact, documentation, and evidence change unit. | Low | REVIEWED_CLEAN |

## Findings fixed before final review

1. Claim confirmation originally accepted the first matching identity. It now
   rejects missing or duplicate Review Queue identities, with regression
   coverage.
2. The frozen candidate snapshot originally reached the Review Queue claim
   write without a just-in-time current-row read. The generated graph now
   rereads and revalidates exact identity, eligibility, and stage before
   constructing the claim, preventing an operator change from being
   overwritten by stale selection state.
3. Early handled failures did not all emit the required `generator_result`
   event. Logging now occurs once at the common per-candidate finalization
   boundary and contains only identity, bounded status/outcome, request count,
   and confirmation boolean.
4. Capacity regression coverage did not independently force all four provider
   limit failures or a shared initial/repair quota. Explicit RPM, TPM, RPD,
   TPD, and shared-model failure fixtures now fail closed.

## High-assurance review result

**Lane A — Security, Privacy, and Trust: PASS.** Provider credentials remain
environment-only; repository evidence contains no prompt, message, raw
response, authorization header, webhook, or credential. Error paths use
bounded/redacted categories, Generator events contain no application content,
job/operator content remains untrusted, deterministic pack/message safety is
authoritative, URLs and endpoints remain open/read-only, and automatic
application submission remains absent.

**Lane B — Data, State, Failure, and Operations: PASS.** The first five
identities are fixed with no backfill; claims are append-winner and
just-in-time; current state is reread before claim and commit; successful
writes are exactly confirmed; uncertain writes are not blindly retried;
handled failures return to the batch-one loop; model calls are bounded and
paced; alerts remain idempotent; n8n import/export succeeds; and rollback/main
deployment gates remain explicit.

Issue #49 is not complete. Production deployment is explicitly forbidden by
the delivery instruction, and its authoritative acceptance criteria also
require the exact generated commit on `main` before mutation. No production
workflow, Sheet row, claim, or Slack delivery was changed during this run.
