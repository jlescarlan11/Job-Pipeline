# Acceptance evidence matrix

This matrix maps every GitHub acceptance criterion to checked-in evidence. “Automated” runs under `npm run validate`. “Artifact” is deterministic configuration/export inspection. “Release smoke” is a required disabled/non-production or pre-activation check in `docs/operations.md`; no production workflow was activated as part of this change.

## Issue #1 — Versioned profile and data contract

- **I1-AC1 — Current versioned resume:** Artifact: `config/candidate-profile.json`, `docs/candidate-profile.md`; automated: `profile-contracts.test.mjs`.
- **I1-AC2 — Facts separate from writing policy:** Artifact: candidate profile vs `config/application-policy.json`; automated profile/policy validation.
- **I1-AC3 — No obsolete resume facts:** Automated profile and generated-system-message rejection checks in `profile-contracts.test.mjs`, `evaluation-generation.test.mjs`, and `workflows.test.mjs`.
- **I1-AC4 — Complete logical record:** Artifact: all identity, listing, provenance, evaluation, claim/retry, message, decision, outcome, audit, and archive fields in `config/pipeline-schema.json` and `docs/sheet-schema.md`.
- **I1-AC5 — Valid states/transitions:** Artifact: schema transition map; automated allowed/denied transition tests.
- **I1-AC6 — Legacy read/dedup:** Automated legacy normalization and active/archive URL dedup tests.
- **I1-AC7 — `created_at ` compatibility:** Artifact: legacy mapping plus additive Apps Script migration; automated Sheet artifact checks.
- **I1-AC8 — Invalid profile fails closed:** Automated missing field, unsupported URL/obsolete fact, and invalid version tests; workflow build invokes profile validation.
- **I1-AC9 — Required profile fixtures:** Automated valid, missing-field, unsupported-URL, and invalid-version coverage.
- **I1-AC10 — Preserve ready messages/decisions:** Automated legacy normalization, discovery reconciliation, archive, and Sheet migration checks; release smoke compares backup values.

## Issue #2 — Resume-derived discovery and pagination

- **I2-AC1 — Query evidence traceability:** Automated `validateSearchPlan` checks every enabled evidence reference.
- **I2-AC2 — Required role catalog:** Artifact: 22 queries in `config/search-plan.json`; workflow test asserts all 22 are embedded.
- **I2-AC3 — Bounded accessible pages:** Artifact: 3 pages/query, 7-day lookback, 66-request maximum, timeout and pacing; automated request-plan count.
- **I2-AC4 — Complete vs capped/partial:** Automated complete, empty, failed, and page-limit partial coverage fixtures.
- **I2-AC5 — Multi-query canonical merge:** Automated two-query/two-page canonical merge and combined provenance test.
- **I2-AC6 — Legacy URL prevents rediscovery:** Automated active and Archive legacy duplicate fixtures.
- **I2-AC7 — Repeated discovery preserves manual state:** Automated reconciliation retains status/message and updates provenance/last-seen.
- **I2-AC8 — Posted date/salary persist:** Automated parser alignment assertions; fields mapped in scraper export.
- **I2-AC9 — Unknown company/salary remain blank:** Parser/config use blank values; no `Not Given` fallback exists.
- **I2-AC10 — One query failure preserves success:** Automated partial-run reconciliation test; export logs per-query coverage.
- **I2-AC11 — Parent-card alignment:** Automated optional badge, neighboring card, malformed card, title/URL/date/salary alignment fixtures.
- **I2-AC12 — Pacing/run limits:** Automated config/export drift checks for 2-second interval, 15-second timeout, 3 attempts, and page/query bounds.
- **I2-AC13 — Required discovery fixtures:** Automated multi-page, empty, duplicate config/result, active/archive duplicate, malformed/invalid date, seniority, and temporary failure coverage.
- **I2-AC14 — Four-hour schedule:** Automated export/config equality.

Concurrent discovery is additionally protected by append-only `discovery` claims before active insertion.

## Issue #3 — Evaluation and validated generation

- **I3-AC1 — Fetch once/persist detail:** Automated stored-detail selection and detail parsing; export branches around stored description and commits enrichment fields.
- **I3-AC2 — Unavailable does not generate:** Automated unavailable evaluation fixture and routing.
- **I3-AC3 — Auditable evaluation fields:** Automated score/tier/decision/evidence/gaps/version/time assertions.
- **I3-AC4 — Full-description evaluation:** Evaluation logic and fixtures include description evidence and requirement gaps, not title-only routing.
- **I3-AC5 — Direct/adjacent recommendation:** Automated direct and evidence-supported adjacent fixtures.
- **I3-AC6 — Uncertain/unscorable avoids Groq:** Automated review-required and unscorable fixtures; selection excludes them unless explicit promotion.
- **I3-AC7 — Not-recommended retained/no quota:** Evaluation/status tests and selection logic; archiver later retains dedup history.
- **I3-AC8 — At-most-once concurrent generation:** Append-only stage claims, earliest-row arbitration, 10-minute lease, state-guard claim update, and processing-token commit; automated overlapping claim tests.
- **I3-AC9 — Only canonical facts/policy:** Automated prompt contents/obsolete exclusions and approved profile/policy validation.
- **I3-AC10 — Invalid message not ready:** Automated unsupported project/skill/metric/URL and empty/partial-message failure coverage.
- **I3-AC11 — Valid message version/time:** Automated ready transition, profile version, validation status, timestamp, and formatting preservation.
- **I3-AC12 — Legacy ready preservation:** Automated selection exclusion and legacy message versioning; migration is additive.
- **I3-AC13 — Retryable external failures:** Automated sanitized timeout/rate-limit classification, stage, count, and backoff; export retry settings validated.
- **I3-AC14 — Terminal failures:** Automated exhausted and validation-failure terminal routing.
- **I3-AC15 — Stale lease recovery:** Automated active-claim and append-only claim expiration coverage.
- **I3-AC16 — Stale write cannot overwrite decision:** Generator claim marking matches `state_guard`; final commits match `processing_token`; reviewer actions clear/replace the token; workflow test rejects canonical-ID claim cleanup.
- **I3-AC17 — One cap value:** `config/runtime.json`, export metadata/code, README/architecture all use 5; automated drift check.
- **I3-AC18 — No auto apply:** Policy requires manual submission; export scan rejects submit/apply endpoints and automated applied/skipped nodes.
- **I3-AC19 — Required generation fixtures:** Automated direct, adjacent, review-required, unsupported skill, seniority, unavailable, missing description, invalid output, rate limit, overlap, stale claim, and legacy ready coverage.
- **I3-AC20 — Eligibility ordering:** Automated generation-stage/score/oldest ordering and cap test; priority ordering is explicitly documented.

## Issue #4 — Idempotent archive

- **I4-AC1 — Retryable excluded:** Automated retention fixture and export/config assertion.
- **I4-AC2 — Eligible terminal states:** Artifact/runtime config and automated applied/skipped/not-recommended/terminal selection.
- **I4-AC3 — Canonical reconciliation:** Archive upsert matches `canonical_job_id`; legacy URL reconciliation is automated.
- **I4-AC4 — Confirm before delete:** Workflow graph and automated missing/incomplete archive-copy rejection.
- **I4-AC5 — Append-success/delete-failure retry:** Automated rerun keeps one archive identity.
- **I4-AC6 — Archive-write failure retains active:** Automated no-copy confirmation rejection.
- **I4-AC7 — Stale row cannot delete another job:** Automated row-identity mismatch rejection.
- **I4-AC8 — Row-shift safety:** Automated multiple-row descending confirmation and export delete mapping.
- **I4-AC9 — Legacy Archive participation:** Automated URL-based legacy archive fixture.
- **I4-AC10 — Full history preserved:** Automated generated message/evaluation/decision/outcome/profile/notes comparison; deletion requires all non-empty planned fields.
- **I4-AC11 — Empty/no eligible safe:** Automated empty input and retryable-only plans return no candidates.
- **I4-AC12 — Operational counts:** Structured `archive_plan`, `archive_claims`, and `archive_confirmation` logs distinguish new, already archived, retained, claim loss, confirmed, and rejection reasons.
- **I4-AC13 — Required archive failures:** Automated normal, empty, pre-append, post-append/delete failure, duplicate retry, row shift, legacy, retryable exclusion, concurrent manual change, and incomplete copy.
- **I4-AC14 — Applied/skipped regression:** Automated eligibility/copy/confirm paths and release smoke.

## Issue #5 — Prioritized review and outcomes

- **I5-AC1 — Required review context:** Artifact: `config/review-sheet.json`/`docs/sheet-schema.md`; automated required-column check.
- **I5-AC2 — Recommended priority/recency:** Automated review-queue ordering and Apps Script priority sort.
- **I5-AC3 — One explicit promotion:** Automated transition plus generator claim arbitration.
- **I5-AC4 — Ready applied/skipped:** Automated explicit action tests and documented transition table.
- **I5-AC5 — Automation never decides:** Automated no-action test, export scan, and manual policy.
- **I5-AC6 — Separate decision/outcome:** Schema and automated timestamp/state assertions.
- **I5-AC7 — Outcome preserves history:** Automated archived outcome test retains decision, message, and version/evaluation fields.
- **I5-AC8 — Archived follow-up:** Reviewer export reads/updates Archive; outcome-follow-up view is documented.
- **I5-AC9 — Retryable/terminal/skip distinction:** Separate statuses, conditional colors, recovery view, and automated transition coverage.
- **I5-AC10 — Unavailable not promoted:** Manual transition validation rejects normal promotion; retry is explicit.
- **I5-AC11 — Legacy blanks:** Normalization defaults unknown/blank; automated legacy/empty tests.
- **I5-AC12 — Invalid values preserve record:** Strict Sheet dropdown plus automated unsupported/invalid action tests.
- **I5-AC13 — Funnel uses persisted outcomes:** Automated known-count fixture and no-inference assertions.
- **I5-AC14 — Empty first use:** Apps Script creates headers/tabs/controls; automated empty queue/dashboard and additive setup checks.
- **I5-AC15 — Desktop Sheet usability:** Generated setup orders review columns, freezes identity columns, sizes/wraps content, validates actions, and preserves formatting; `docs/operations.md` requires desktop smoke on the workbook copy before activation.
- **I5-AC16 — Copy/review message:** Generated message preserves line breaks; Sheet setup wraps/widens the message column; automated lifecycle preservation.

## Issue #6 — Regression coverage and rollout

- **I6-AC1 — Offline workflow validation:** `npm run validate` checks all seven exports without credentials.
- **I6-AC2 — Discovery regression set:** `discovery.test.mjs`, fixtures, and workflow drift tests cover direct/adjacent catalog, duplicates, empty/partial/capped behavior.
- **I6-AC3 — Evaluation regression set:** `evaluation-generation.test.mjs` and contract tests cover direct, adjacent/review, unscorable, unavailable, validation, retries/terminal, stale/overlap, and legacy ready.
- **I6-AC4 — Review regression set:** `review.test.mjs` covers promotion, applied, skipped, outcomes, invalid transition, and empty data.
- **I6-AC5 — Archive regression set:** `archive.test.mjs` covers success, append/delete failures, retry, row shift, legacy, and retryable retention.
- **I6-AC6 — Full synthetic lifecycle:** `e2e.test.mjs` traverses discovery → evaluation → generation → manual applied → archive → offer → rediscovery with one identity.
- **I6-AC7 — Partial is not complete/ready:** E2E failure test asserts partial coverage and terminal invalid output with no generated message.
- **I6-AC8 — No live default calls:** Tests use local JSON/HTML and pure functions; no network client is imported.
- **I6-AC9 — Docs match exports:** README/architecture plus automated schedule/cap/retry/version drift checks.
- **I6-AC10 — Profile/policy docs:** `docs/candidate-profile.md` and `docs/master-prompt.md` identify canonical sources/version behavior.
- **I6-AC11 — Complete Sheet schema:** `docs/sheet-schema.md` defines all 89 canonical record fields, eight tabs, actions, states, and compatibility.
- **I6-AC12 — Rollout runbook:** `docs/operations.md` includes backup, migration, profile validation, dry run, old-writer shutdown, activation, and checks.
- **I6-AC13 — Rollback preservation:** Runbook keeps canonical identity, active/ready data, decisions/outcomes, and Archive dedup history.
- **I6-AC14 — Production observations:** Runbook defines coverage, dedup, evaluation, generation, retry, stuck-claim, review, and archive counts without success targets.
- **I6-AC15 — Drift failure:** Generated workflow/Sheet `--check` commands plus export/config tests fail `npm run validate` on critical drift.
- **I6-AC16 — No bypass/submission/service:** Export scan, policy, architecture, and runbook retain OnlineJobs.ph read-only/manual submission and add no service.

## Issue #8 — Extended learning contract

- **Ranking/pack/alert fields:** Artifact: the canonical 89-field
  `config/pipeline-schema.json` contract, enum/field rules, generated mappings,
  and `docs/sheet-schema.md`; automated valid/invalid contract coverage in
  `profile-contracts.test.mjs`.
- **Review/application/outcome telemetry:** Artifact: first-review, controlled
  Apply Points/strategy input, immutable application snapshot, and serialized
  cumulative outcomes; automated normalization/state-guard coverage in
  `profile-contracts.test.mjs` and `review.test.mjs`.
- **Invalid values preserve state:** Contract validation rejects out-of-range
  scores/points, invalid enums/timestamps/arrays; reviewer tests assert
  validation returns no update.
- **Legacy compatibility:** Legacy `match_score` and current outcome remain
  readable without becoming new scores/events; covered by contract, review,
  archive, and analytics fixtures.
- **Unknown-field preservation and archive completeness:** Discovery merges
  preserve owner-external fields; archive union/comparison uses the complete
  canonical schema; covered by `discovery.test.mjs` and `archive.test.mjs`.
- **Additive reproducible migration:** Generated Sheet setup appends missing
  headers, preserves reviewer content, and stops on identity collisions;
  `sheet-setup.test.mjs` plus generated-artifact checks cover repeatability.
- **Concurrency/regression:** State guards include the newly manual telemetry;
  processing-token and archive confirmation tests retain canonical identity,
  actions, retries, valid messages, and archive safety.

## Issue #9 — Opportunity ranking and Apply Points advice

- **Dual deterministic ranking:** `config/ranking-policy.json` and
  `src/evaluation.mjs` produce distinct bounded qualification/opportunity
  scores, confidence, advisory allocation, versioned factors/missing signals,
  profile version, and evaluation time; exact repeatability is tested.
- **Evidence and gaps:** Qualification references canonical profile evidence;
  structured hard/preference/uncertain gaps drive documented recommendation or
  review behavior without fabricated skills, tenure, metrics, or claims.
- **Opportunity factors:** Qualification, freshness, reliably parsed
  PHP-monthly salary, completeness, allowlisted employer signals, observable
  effort, and sufficient historical cohorts are explicit contribution,
  neutral, or missing factors. Missing data reduces confidence according to
  policy.
- **Priority and compatibility:** New queues use opportunity score, confidence,
  posting/creation times, and identity as deterministic tie-breakers. Legacy
  rows retain `match_score` only as a queue fallback; unavailable/unscorable
  records cannot become high-confidence recommendations.
- **Manual boundary/regression:** Every allocation is a category, never a
  points spend or application. Evaluation, queue, workflow, review, archive,
  and lifecycle tests cover all requested direct/adjacent/gap/seniority/missing
  input/staleness/boundary/legacy cases and existing manual flows.

## Issue #10 — Instruction-aware application packs

- **Complete structured pack:** `config/application-pack-policy.json` and
  `src/evaluation.mjs` persist distinct instructions, subject/format
  requirements, questions, proof references, warnings, message, status, and
  profile/policy/version timestamps.
- **Supported proof only:** Deterministic proof selection returns at most three
  strongest job-relevant canonical references, reports a shortfall, and cannot
  invent skills, projects, metrics, URLs, availability, salary, or contact
  facts.
- **Safe readiness:** Unsupported mandatory answers/evidence/attachments/tests
  block readiness; ambiguous/conflicting content requires review; missing or
  unavailable source content remains unscorable/unavailable.
- **Untrusted instruction handling:** Prompt-bypass, private-data,
  unsupported-claim, and automatic-action requests are excluded and reduced to
  sanitized warnings before Groq receives the pack prompt.
- **Atomic generation and review:** Only a deterministically validated message
  can be ready. Pack/message commit together under the winning processing
  token; failed regeneration preserves the previous valid pair. Sheet setup
  displays the pack while protecting generated fields.
- **Coverage/regression:** `evaluation-generation.test.mjs`, malicious and
  instruction fixtures, workflow tests, and lifecycle tests cover the requested
  instructions/questions/subject/proof/unsupported/prompt-injection/empty/
  conflict/failure/regeneration cases and retain copy/review/manual submission.

## Issue #11 — Idempotent high-match alerts

- **Immediate guarded queue:** The generator evaluates versioned
  score/confidence/freshness/gap/pack eligibility only after atomic pack commit
  and stores `pending` immediately, independent of the reviewer cadence.
- **Configured provider and complete payload:** `config/alert-policy.json` and
  the one-minute Slack workflow use environment-bound webhook/review values and
  render all required score, employer/salary/freshness, gap, Apply Points,
  instruction/question/proof/warning, and safe action context with explicit
  unknown labels.
- **No action authority:** Review/skip links open the authorized Sheet for
  confirmation; the canonical source link is open-only. No link applies,
  spends points, or contains a reusable state-changing token.
- **Delivery state/idempotency:** Canonical identity plus alert-policy version
  scopes one initial alert. Confirmed delivery persists channel/version/time
  and bounded provider reference; known transient rejection retries with
  bounded backoff; configuration/permanent/unavailable paths remain visible.
- **Ambiguous delivery safety:** Records move through `sending`; timeout or a
  lost acknowledgement is terminal/ambiguous and never blindly resent.
  Ready pack and manual state remain intact.
- **Security/regression:** `alerts.test.mjs` covers eligibility boundaries,
  success, duplicate suppression, transient/permanent failure, ambiguity,
  unavailability, missing configuration, tampered links, repeated skip, and
  empty work. Export tests enforce disabled state, secret references,
  sanitization, and absence of application actions.

## Issue #12 — Manual learning telemetry

- **Review and application capture:** Explicit `mark_reviewed` stamps
  `first_reviewed_at` once. Only authorized review/application actions can do
  so; discovery/ranking/generation/alerts/source opens cannot.
- **Validated points and strategy:** Sheet controls and reviewer logic accept
  blank or an integer 1–60 plus a bounded versioned strategy identifier.
  Invalid input returns no update; blank remains unknown, not zero.
- **Immutable decision snapshot:** First successful `mark_applied` freezes
  qualification/opportunity/confidence/policy/recommendation/pack/strategy/
  posting-age context and decision time. Duplicate apply/skip and later
  permitted changes preserve the original snapshot/timestamp.
- **Cumulative outcomes:** Stable-ID events retain reply → interview → offer or
  rejection history; explicit no-response remains manual; corrections update
  the compatibility view without deleting history.
- **Active/archive safety:** Reviewer routing and archive union preserve
  messages, versions, ranking/pack/alert data, notes, identity, and decisions
  while allowing explicit archived outcomes. Unsupported/conflicting actions
  are sanitized no-ops.
- **Coverage/regression:** `review.test.mjs`, `archive.test.mjs`,
  `sheet-setup.test.mjs`, and `e2e.test.mjs` cover first/repeated review,
  points boundaries/unknown, duplicate/stale decisions, progressive/rejected/
  corrected outcomes, archived/legacy/empty input, and all existing actions.

## Issue #13 — Conversion and calibration analytics

- **Deduplicated cohort and outcomes:** `src/analytics.mjs` reconciles
  active/Archive overlap, retains earliest immutable application context, and
  unions explicit cumulative outcomes/provenance. Overall and per-ten
  reply/interview/offer/rejection/no-response rows expose numerator,
  denominator, sample, and all-time window.
- **All requested dimensions:** Versioned rows cover query, role, both score
  bands, confidence, matched skill, gaps, PHP salary, posting age, actual and
  recommended points, strategy, instruction completeness, and top/lower rank.
  Multi-touch values are full-credit/non-additive; malformed/blank values are
  unknown with coverage.
- **Efficiency, action time, and blockers:** Analytics includes valid-timestamp
  review/application duration, Manila same-day review, known-positive-point
  efficiency and high-confidence share, hard-gap non-application, and
  independent pack blockers.
- **Calibration and supporting observations:** Ordered score cohorts expose
  outcome rates/sample sizes. Separate discovery volume and promising-job gap
  frequency/coverage support guarded weekly recommendations without becoming
  conversion evidence.
- **Complete-report boundary:** Daily detail IDs are execution-scoped and
  idempotent. Only a matching full detail write publishes `status=complete`;
  partial/orphan rows cannot supersede the previous complete report. Empty
  input is explicitly successful.
- **Compatibility/privacy/tests:** Existing Dashboard behavior is unchanged.
  Output is formula-neutral, aggregate-only, and read-only against job state.
  `analytics.test.mjs`, workflow/Sheet/docs tests, and fixed fixtures cover all
  requested totals, bands, attribution, overlap, unknown/zero/invalid/empty,
  progressive outcome, and partial-publication cases.

## Issue #14 — Guarded weekly recommendations

- **Versioned weekly run:** `config/recommendation-policy.json` defines the
  168-hour schedule, all-time input, required metric/band versions, production
  sample/coverage gates, comparisons, and output schemas.
- **Complete eligible evidence only:** `src/recommendations.mjs` selects the
  newest complete compatible analytics report and verifies its exact detail
  cohort. Sparse overall data emits one abstention; low coverage emits only a
  dimension abstention; empty input emits a successful empty report.
- **Explainable directions:** Query/role recommendations separate discovery
  volume from reply/interview/offer conversion. Ordered qualification,
  opportunity, and confidence bands expose over/underconfidence. Eligible
  skill, salary, age, points/recommendation, strategy, and instruction cohorts
  retain numerator, denominator, sample, comparison, window, coverage, and
  caveat.
- **Profile-safe missing skills:** Frequent structured requirements from
  promising jobs pass gap coverage/frequency/non-skill exclusion rules and are
  checked against approved profile evidence. The action is investigate-only
  and never mutates profile facts.
- **History, idempotency, and failure:** One analysis key groups compatible
  superseding attempts; execution-versioned run/detail IDs upsert safely.
  `Recommendations` and `RecommendationReports` persist recommendation,
  abstained, empty, complete, and sanitized failed history. Failed/partial
  attempts never replace the latest complete internal view.
- **No-mutation boundary:** The generated weekly workflow reads only
  `Analytics`/`AnalyticsReports` and writes only recommendation tabs. It has no
  notification or job/config mutation path; existing 4-hour/22-query and all
  other schedules/flows remain unchanged.
- **Coverage/operations:** `recommendations.test.mjs` covers strong/weak
  query/role, over/underconfidence, all requested comparisons, missing skill,
  sparse/low/unknown coverage, empty/incompatible/failed input, same/superseding
  attempts, redaction, last-complete selection, and input immutability.
  Workflow/Sheet/docs tests plus `docs/operations.md` cover disabled staged
  rollout, verification, disable-only rollback, and separate approval for any
  future automatic calibration.
