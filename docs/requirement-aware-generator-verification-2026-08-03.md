# Requirement-aware Generator verification — 2026-08-03

Comparison base: `581d1561e31b433242918d44954a3c7409c35ccf`.
Implementation branch: `codex/requirement-aware-generator`.

This record covers Issues #65–#69. Repository implementation and validation
are complete for #65–#68. Issue #69 remains blocked at its explicitly live
deployment criteria because this run is not authorized to deploy or mutate
production. No n8n workflow was imported or activated, no production workbook
was read or changed, no Slack message was sent, and no application was opened
or submitted.

## Verified root causes and architecture

The old parser flattened structural HTML before extraction, then inferred
instructions from punctuation-delimited text. The resulting pack had no
requirement-level evidence authorization or deterministic message plan, so the
provider could optimize for fluent job-description paraphrase while omitting
the employer's actual application steps. Downstream safety knew pack/message
versions but could not reproduce the requirement-coverage decision.

The rebuilt path preserves semantic source structure, extracts bounded
technology-agnostic requirements, classifies each required answer element
against canonical evidence, and constructs a versioned high-priority message
plan. The same complete deterministic validation gates initial and repair
drafts. Coverage, the one-element plan array, and explicit compatibility
versions are persisted, state-guarded, preserved through lifecycle operations,
and recomputed from the current job description, profile, and policies before
downstream use. Review approval is bound to the exact reviewed strategy by a
digest. Deployment policy now pins the pipeline-contract digest and all
application versions as one Generator/Alerter compatibility unit.

## Issue #65 acceptance-criteria matrix

| ID | Status | Implementation mapping | Direct evidence |
| --- | --- | --- | --- |
| 65-AC-01 | SATISFIED | Structure-aware segments and scoped required list items | `structured application steps preserve hierarchy, constraints, and safe technical context` |
| 65-AC-02 | SATISFIED | Imperative screening intent recognizes Describe/Explain/Tell/Provide/Answer | Structured fixture plus `decorative punctuation and non-question responsibilities...` |
| 65-AC-03 | SATISFIED | Separator/noise rejection and semantic HTML newlines | Structured and decorative-separator tests |
| 65-AC-04 | SATISFIED | Candidate-response intent excludes responsibility blocks | Responsibilities regression assertion |
| 65-AC-05 | SATISFIED | Mandatory introductions scope child list items | Four reported items are independently required in fixture test |
| 65-AC-06 | SATISFIED | Subject extraction preserves quoted values, punctuation, and candidate placeholder | Structured fixture and quoted Node.js subject assertions |
| 65-AC-07 | SATISFIED | Content instructions retain sentence, word, and paragraph constraints | Coverage/plan and boundary-count tests |
| 65-AC-08 | SATISFIED | Alternative group plus manual attachment/test/form/submission types | Coverage manual/alternative/form tests |
| 65-AC-09 | SATISFIED | Unsafe markers no longer reject ordinary system-prompt/API/config terms | Structured fixture safe technical context assertion |
| 65-AC-10 | SATISFIED | Narrow policy-bypass, disclosure, secret, and auto-action categories, including cross-segment matching | Split-injection and private-secret tests |
| 65-AC-11 | SATISFIED | Unavailable/conflict/truncation/overflow gates fail closed without lossy approval | 21-item, oversized-item, no-description, and unavailable tests |
| 65-AC-12 | SATISFIED | Legacy clean/rhetorical/injection/no-instruction behaviors retained | Full evaluation/generation suite |
| 65-AC-13 | SATISFIED | Added real-format HTML fixture and cross-format regressions | `tests/fixtures/job-structured-instructions.html` and evaluation tests |
| 65-AC-14 | SATISFIED | Source and generated artifacts rebuilt together | `npm run build`; final `npm run validate` release gate |

Risk: **HIGH** — untrusted HTML/instruction parsing and prompt-injection trust
boundary. Protected invariants are bounded source input, no unsafe raw warning
persistence, no automatic application action, and fail-closed ambiguity.

## Issue #66 acceptance-criteria matrix

| ID | Status | Implementation mapping | Direct evidence |
| --- | --- | --- | --- |
| 66-AC-01 | SATISFIED | One validated coverage record per mandatory answer element | Coverage classification and pack-validation tests |
| 66-AC-02 | SATISFIED | Exact classification and proof priority outrank adjacent/partial | `exact requirement evidence outranks adjacent evidence deterministically` |
| 66-AC-03 | SATISFIED | Provider/tool/domain/production differences are material | Table-driven coverage cases |
| 66-AC-04 | SATISFIED | AI-workflow intent boosts Job Pipeline relevance | Structured fixture proof-order assertion |
| 66-AC-05 | SATISFIED | Groq→Claude is adjacent with persisted requested/actual difference | Structured coverage and corrected-message tests |
| 66-AC-06 | SATISFIED | Every reference resolves through the active profile | Pack validation and forged-reference safety tests |
| 66-AC-07 | SATISFIED | Missing coverage produces bounded candidate input | Missing/partial Generator routing tests |
| 66-AC-08 | SATISFIED | Attachments/tests/forms/submission classify as manual actions | Manual coverage tests |
| 66-AC-09 | SATISFIED | CV-or-approved-link remains one satisfiable alternative | Structured fixture link coverage assertion |
| 66-AC-10 | SATISFIED | Mandatory coverage evidence is selected before generic overlap | Job Pipeline proof priority and compaction tests |
| 66-AC-11 | SATISFIED | Proof-count limits throw if mandatory evidence would be removed | `mandatory coverage proofs survive compaction or fail closed` |
| 66-AC-12 | SATISFIED | General inferred capabilities surface without a posting-specific list or capitalization dependency | Upper/lowercase Terraform/Claude Code/LangChain/RAG regressions |
| 66-AC-13 | SATISFIED | Existing severity, alternatives, PHP, and seniority semantics retained | Full evaluation requirement-gap suite |
| 66-AC-14 | SATISFIED | Same inputs/versions yield stable coverage and proof order | Determinism assertions in exact/adjacent tests |
| 66-AC-15 | SATISFIED | Added exact/adjacent/partial/missing/manual/ranking regressions | Evaluation and Generator suites |
| 66-AC-16 | SATISFIED | Integrated repository gate | Final `npm run validate` release gate |

Risk: **HIGH** — evidence authorization controls candidate factual claims.
Canonical profile references are the only authority; material differences
cannot be silently upgraded or removed.

## Issue #67 acceptance-criteria matrix

| ID | Status | Implementation mapping | Direct evidence |
| --- | --- | --- | --- |
| 67-AC-01 | SATISFIED | Exact reported draft is a failing regression | Separate subject/link/project/frequency/provider/domain error assertions |
| 67-AC-02 | SATISFIED | Ready validation requires a complete disposition for every mandatory item | Pack and message-plan validation tests |
| 67-AC-03 | SATISFIED | Employer subject wins when override policy permits | Structured fixture subject plan |
| 67-AC-04 | SATISFIED | Complete first-line subject resolves candidate placeholder | Corrected adjacent message and subject failure tests |
| 67-AC-05 | SATISFIED | Project-summary sentence/word/paragraph counters enforce exact or inclusive bounds | Below/above and exact-count regressions |
| 67-AC-06 | SATISFIED | One grounded project narrative can cover overlapping requests | Corrected message passes without Q/A blocks |
| 67-AC-07 | SATISFIED | Workflow plan requires project plus supported tools/integrations | Keyword-only draft fails; corrected Job Pipeline draft passes |
| 67-AC-08 | SATISFIED | Adjacent claims require actual/requested distinction and qualifier in the same sentence | Provider and agentic-difference validation tests |
| 67-AC-09 | SATISFIED | Groq→Claude transfer is allowed only with explicit distinction | Corrected adjacent fixture passes; omission fails |
| 67-AC-10 | SATISFIED | Every material clause resolves to one canonical proof fact; employer duties and keyword overlap are not candidate evidence | Cross-proof/within-proof stitching plus forged evaluation/guardrail/HIPAA claim tests |
| 67-AC-11 | SATISFIED | Unsupported routine/always/every claims fail | Reported draft frequency assertions |
| 67-AC-12 | SATISFIED | Approved link satisfies the alternative; otherwise manual remains | Link requirement validation |
| 67-AC-13 | SATISFIED | Keyword echoes do not satisfy answer elements | `keywordOnly` regression |
| 67-AC-14 | SATISFIED | Plan and mandatory evidence precede/truncate description context | Prompt-budget and lifecycle evidence-content tests |
| 67-AC-15 | SATISFIED | Initial and repair use the same validator | Generator repair tests |
| 67-AC-16 | SATISFIED | Repair receives immutable plan/coverage/evidence and cannot erase differences | Repair-context and invalid-repair tests |
| 67-AC-17 | SATISFIED | Existing deterministic safety gates retained | URL/tech/number/schedule/salary/phone/banned/Markdown/passive-manual suites |
| 67-AC-18 | SATISFIED | Missing evidence routes review, not invented prose/provider failure | Missing/partial routing tests |
| 67-AC-19 | SATISFIED | Added AI, full-stack, generic capability, and malicious cases | Evaluation, Generator, Groq, and E2E suites |
| 67-AC-20 | SATISFIED | Integrated repository gate | Final `npm run validate` release gate |

Risk: **HIGH** — generated external copy and untrusted model output. The
provider never authorizes readiness; deterministic subject, plan, grounding,
claim, URL, and manual-action checks do.

## Issue #68 acceptance-criteria matrix

| ID | Status | Implementation mapping | Direct evidence |
| --- | --- | --- | --- |
| 68-AC-01 | SATISFIED | Bounded coverage and one-element plan JSON fields | Schema/contract tests |
| 68-AC-02 | SATISFIED | Persisted requirements/coverage are canonically recomputed, not trusted | Forged required/exact/reference safety tests |
| 68-AC-03 | SATISFIED | Adjacent differences persist in coverage and plan | Erased-difference safety regression |
| 68-AC-04 | SATISFIED | Missing coverage yields actionable review input, not provider error | Generator missing/partial routing test |
| 68-AC-05 | SATISFIED | Adjacent warning requires an acknowledgment bound to the reviewed strategy digest | Approval-rebinding regression |
| 68-AC-06 | SATISFIED | Approval allowlist excludes partial/missing and never waives validators | Policy plus approval regressions |
| 68-AC-07 | SATISFIED | Ready requires current pack/profile/application/message/coverage/plan versions | Pack and persisted-safety tests |
| 68-AC-08 | SATISFIED | Persisted safety recomputes and rejects absent/malformed/stale/mismatched/forged state | Message-safety matrix and Terraform forgery regression |
| 68-AC-09 | SATISFIED | Unsafe/incompatible To Apply rows are not Slack candidates | Alerter and message-safety tests |
| 68-AC-10 | SATISFIED | Provider failure preserves a coherent prior unit; a new non-ready contract clears an incompatible old message | Generator coherence regressions |
| 68-AC-11 | SATISFIED | Complete fields survive copy-confirm-delete across queues | Movement and E2E tests |
| 68-AC-12 | SATISFIED | Rediscovery preserves coverage/plan/versions | Discovery regression |
| 68-AC-13 | SATISFIED | Guard covers every synchronous system-owned outbound/safety field and review digest; operator/discovery-owned edits use explicit boundary checks | Guard allowlist, Sheet-round-trip, direct-action, rediscovery, and Slack-race tests |
| 68-AC-14 | SATISFIED | Provider/validation/missing/unavailable/skip/manual outcomes stay distinct | Generator lifecycle suite |
| 68-AC-15 | SATISFIED | Setup remains idempotent with complete ordered schema | Sheet setup/contract tests |
| 68-AC-16 | SATISFIED | Legacy unsent ready rows fail closed with reason codes | Persisted message-safety legacy test |
| 68-AC-17 | SATISFIED | Generator, Alerter, and Sheet artifacts rebuilt inactive and drift-free | Build/artifact/workflow tests |
| 68-AC-18 | SATISFIED | Schedules/caps/models/retries/routes/receipts/manual boundary unchanged | Runtime, deployment, workflow, receipt tests |
| 68-AC-19 | SATISFIED | Contract, safety, movement, discovery, workflow, and E2E regressions added | Full suite manifest |
| 68-AC-20 | SATISFIED | Build and integrated validation gates | Final `npm run build` and `npm run validate` |

Risk: **HIGH** — durable shared-row schema, stale-state authorization, queue
movement, and Slack safety. Segmented ownership/storage versions remain
unchanged, while a deterministic pipeline-contract digest prevents an older
same-version header/schema shape from passing compatibility checks.

## Issue #69 acceptance-criteria matrix

| ID | Status | Repository mapping/evidence | Live limitation |
| --- | --- | --- | --- |
| 69-AC-01 | PARTIAL | Candidate branch artifacts rebuild and full validation pass | No exact deployment commit exists yet; the gate must be rerun on that eventual commit |
| 69-AC-02 | BLOCKED | Runbook defines sanitized workflow/policy/schema/unsent inventory | Requires authorized production reads/backups |
| 69-AC-03 | BLOCKED | Existing cutover rollback contract plus compatibility rollback order | Requires readable live exports/identifiers |
| 69-AC-04 | BLOCKED | Inactive artifacts retain schedules/timeouts/caps/pacing/timezone | Requires authorized n8n import/binding |
| 69-AC-05 | PARTIAL | Structured fixture proves extraction and responsibility exclusion | Disposable imported n8n/workbook execution unavailable |
| 69-AC-06 | PARTIAL | Job Pipeline adjacent coverage and Groq/Claude difference are deterministic | Disposable imported workflow evidence unavailable |
| 69-AC-07 | SATISFIED | Exact reported non-answer fails complete validation | No live provider required for deterministic rejection |
| 69-AC-08 | PARTIAL | Corrected adjacent draft passes generation validation | Disposable persisted-workflow safety execution unavailable |
| 69-AC-09 | SATISFIED | Exact-evidence and unrelated capability fixtures prove generality | Repository evidence is deterministic |
| 69-AC-10 | SATISFIED | Exact/adjacent/partial/missing/manual/ambiguous/unavailable/malicious routes tested | Repository evidence is deterministic |
| 69-AC-11 | SATISFIED | One bounded repair; invalid repair cannot become ready | Generator/Groq tests |
| 69-AC-12 | SATISFIED | Provider, Sheet, stale-guard, malformed-response failures remain visible/fail closed | Generator/workflow/E2E tests |
| 69-AC-13 | BLOCKED | Guard-safe inventory/disposition procedure documented | Requires current production `To Apply` snapshot and authority |
| 69-AC-14 | SATISFIED | Persisted safety rejects legacy/stale/missing/unsupported/forged records | Message-safety and Alerter tests |
| 69-AC-15 | BLOCKED | Cutover validator requires exactly one active role each | Requires production activation/inventory |
| 69-AC-16 | BLOCKED | Complete persisted record contract is repository-tested | Requires bounded production record |
| 69-AC-17 | BLOCKED | Slack fidelity/idempotency/safety are repository-tested | Requires authorized real Slack canary |
| 69-AC-18 | SATISFIED | Endpoint/workflow tests prove no application submission/spend path | Repository and generated graph scans |
| 69-AC-19 | SATISFIED | Applied/archive/deny/skip/unavailable/rediscovery/receipt regressions pass | Repository evidence is deterministic |
| 69-AC-20 | BLOCKED | Evidence sanitation/rollback rules and validators exist | Requires actual post-deployment evidence |
| 69-AC-21 | SATISFIED | Operations/deployment docs define 240-minute observation, triggers/order/risks | Documentation tests and review |

Risk: **HIGH** — deployment, rollback, external services, durable live state,
and disclosure. Repository-safe work is complete. The exact blocker is absent
authorization/credentials for production inventory, backups, inactive import,
workbook/Groq/Slack verification, activation, observation, and rollback-ready
evidence; deployment is also explicitly prohibited by this run.

## Validation evidence

- Focused extraction, coverage, generation, persistence, movement, alert, Groq,
  deployment, and E2E tests pass after the latest fixes.
- The final integrated suite contains 274 tests: 262 pass and 12 explicitly
  retired legacy paths are skipped; there are zero failures.
- `npm run build` rebuilds all three inactive workflows and Sheet setup.
- `npm run validate:deployment -- --policy-only` accepts deployment policy
  `2026-08-03/v1` and its pinned application compatibility unit.
- The final full `npm run validate` result is the release evidence for the
  integrated branch; production-only checks remain deliberately unclaimed.

## Change-set accounting

| Change unit | Issue provenance | Contract/boundaries inspected | Risk | Disposition |
| --- | --- | --- | --- | --- |
| `src/evaluation.mjs`, application-pack policy | #65–#67 | HTML/input normalization, extraction, coverage, proof ranking, plan, prompt/repair, validation | High | REVIEWED_AFTER_FIX |
| `src/generator.mjs` | #67–#68 | Non-ready routing, provider boundary, ready commit, prior-safe-message retention | High | REVIEWED_AFTER_FIX |
| `src/discovery.mjs`, `src/movement.mjs` | #65, #68 | Numeric-entity input safety, operator action ownership, approval repair, copy-confirm-delete, rediscovery preservation | High | REVIEWED_AFTER_FIX |
| `src/alerter-mover.mjs`, `src/alert-receipts.mjs` | #68 | Recomputed protected-state guard, explicit action race check, Slack selection/result, and receipt reconciliation | High | REVIEWED_AFTER_FIX |
| pipeline/review schema, contracts, setup artifact | #68 | JSON bounds, complete row order, guards, idempotent setup, compatibility | High | REVIEWED_AFTER_FIX |
| `src/message-safety.mjs`, Alerter artifact | #68 | Canonical rehydration, persisted authorization, Slack eligibility | High | REVIEWED_AFTER_FIX |
| deployment policy/validator/script | #69 | Exact compatibility unit, schedules, bindings, inactive cutover boundary | High | REVIEWED_AFTER_FIX |
| evaluation/Generator/Groq/safety/contract/movement/discovery/alert/E2E tests and fixture | #65–#69 | Positive, negative, malformed, stale, compaction, lifecycle, regression behavior | Moderate | REVIEWED_AFTER_FIX |
| generated workflows and Sheet setup | #68–#69 | Source parity, inactive state, syntax, topology, environment bindings, no auto-submit | High | REVIEWED_AFTER_FIX |
| application-pack/prompt/data/sheet/architecture/alerts/operations/deployment docs | #65–#69 | Product contract, trust boundary, operator gates, rollback, live limitations | Moderate | REVIEWED_AFTER_FIX |
| This verification record | #65–#69 | Criterion-level evidence and honest blocked live gates | Low | REVIEWED_CLEAN |

No dependency, lockfile, migration, binary, rename, or deletion is part of the
change set.

## Findings fixed before final review

1. The first requirement parser lost list hierarchy and imperative requests;
   semantic HTML normalization and scoped structure fixed the root cause.
2. Broad unsafe keywords treated legitimate AI-system terminology as prompt
   injection; unsafe categories now require actual bypass/disclosure/secret or
   automatic-action intent.
3. Generic lexical proof scoring hid Job Pipeline; answer-element coverage and
   exact-over-adjacent priority now select request-relevant canonical evidence.
4. The original fluent draft passed while omitting the subject, project, tools,
   and link and inventing frequency/domain/provider history; the message plan
   and grounding validators now reject each failure independently.
5. Prompt compaction could retain requirement references while dropping or
   prefix-truncating the concrete proof. Mandatory proof sections now survive
   or fail closed, and prompt evidence puts the approved accomplishment before
   secondary metadata.
6. Persisted ready rows could not reproduce requirement authorization;
   coverage/plan/version fields now move with the row, participate in the
   guard, and are revalidated before Slack.
7. Deployment policy previously allowed same-version schema-shape and
   Generator/Alerter application drift; it now pins the pipeline-contract
   digest and rejects a partial compatibility unit.
8. Persisted JSON could forge required flags or exact evidence; downstream
   safety now rebuilds the contract from authoritative job/profile/policy input.
9. Approval timestamps could rebind to a changed strategy; approvals now carry
   an exact review digest and changed strategies return to review.
10. Keyword-overlap grounding admitted invented evaluations, guardrails, and
    regulated-domain claims; stricter grounding and material-claim checks now
    reject those adversarial drafts.
11. Aggregate lexical overlap still allowed arbitrary technologies,
    cross-proof metrics, and within-proof fact fragments to form new
    accomplishments; clause-to-fact grounding and a substantive first-person
    ownership gate now fail closed.
12. Stored state guards were trusted without recomputation and omitted
    Slack-rendered fields. SHA-256 guards now bind every synchronous
    system-owned safety/outbound field and are recomputed at Generator,
    movement, Slack, and receipt commit boundaries. Operator-owned actions,
    outcomes, and notes plus asynchronous seen metadata are explicitly
    validated/compared outside the digest so legitimate Sheet edits and
    rediscovery remain operable.
13. Partial approval destinations could lose their timestamp/digest during
    copy-confirm-delete; incomplete approval rows are now repaired before the
    review source can be deleted.
14. Valid extraction maxima could exceed Sheet JSON limits or provider proof
    capacity; compatible policy limits and minimal durable blocked packs now
    preserve an actionable fail-closed outcome.
15. Within-proof relation permutations and swapped quantity relationships could
    recombine true fragments into false accomplishments; fact-unit grounding
    now preserves subject, relation, object, and numeric association together.
16. Additional credential wording such as bearer tokens, recovery phrases,
    authentication cookies, connection strings, and cloud access-key IDs could
    evade narrow secret labels; category-level secret detection now blocks and
    sanitizes those variants before prompting or persistence.

## High-assurance review status

- **PASS — Lane A (Security, Privacy, and Trust):** independent adversarial
  review confirmed secret/instruction sanitization, zero-proof and contact-line
  fail-closed behavior, relation/quantity preservation, downstream persisted
  authorization, truthful adjacent evidence, inactive workflows, and absence
  of application-submission or embedded-secret paths. Its focused run contained
  115 tests: 108 pass, seven intentional skips, and zero failures.
- **PASS — Lane B (Data, State, Failure, and Operations):** independent review
  accounted for all 74 schema fields across 67 guarded fields and seven explicit
  operator/async exclusions, then confirmed operator actions, rediscovery,
  concurrency checks, partial-repair/copy-confirm-delete behavior, bounded JSON,
  receipts, failure recovery, and generated-artifact parity in a focused
  100-test lifecycle run.
- **PASS — criterion and change-set accounting:** independent review confirmed
  every #65–#69 criterion, all source/artifact/doc changes, adversarial relation
  and quantity tests, zero-proof behavior, and the integrated result of 274
  tests: 262 pass, 12 intentional skips, and zero failures.

These PASS verdicts cover the repository implementation and reproducible local
evidence for Issues #65–#69. They do not convert production-only Issue #69 gates
to PASS: deployment inventory, backup, inactive import, live workbook/Groq/Slack
verification, activation, observation, and rollback-ready evidence remain
explicitly PARTIAL or BLOCKED pending separate authorization and credentials.
