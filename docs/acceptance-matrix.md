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
- **I2-AC3 — Bounded adaptive pages:** Artifact: one initial page/query, source-next-page continuation, 3-page/query and 66-request maximum, 7-day lookback, timeout and pacing; automated initial/next/cap request coverage.
- **I2-AC4 — Complete vs capped/partial:** Automated complete, empty, failed, and page-limit partial coverage fixtures.
- **I2-AC5 — Multi-query canonical merge:** Automated two-query/two-page canonical merge and combined provenance test.
- **I2-AC6 — Legacy URL prevents rediscovery:** Automated active and Archive legacy duplicate fixtures.
- **I2-AC7 — Repeated discovery preserves manual state:** Automated reconciliation retains status/message and updates provenance/last-seen.
- **I2-AC8 — Posted date/salary persist:** Automated parser alignment assertions; fields mapped in scraper export.
- **I2-AC9 — Unknown company/salary remain blank:** Parser/config use blank values; no `Not Given` fallback exists.
- **I2-AC10 — One query failure preserves success:** Automated partial-run reconciliation test; adaptive state carries successful earlier pages and export logs per-query coverage.
- **I2-AC11 — Parent-card alignment:** Automated optional badge, neighboring card, malformed card, title/URL/date/salary alignment fixtures.
- **I2-AC12 — Pacing/run limits:** Automated config/export drift checks for first-page-only fan-out, 2-second in-wave and between-wave pacing, 15-second timeout, 3 attempts, source-exhaustion continuation, and page/query bounds.
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
- **I3-AC8 — At-most-once concurrent generation:** Append-only stage claims, earliest-row arbitration, 10-minute lease, state-guard claim update, and durable commit-guard finalization; automated overlapping claim tests.
- **I3-AC9 — Only canonical facts/policy:** Automated prompt contents/obsolete exclusions and approved profile/policy validation.
- **I3-AC10 — Invalid message not ready:** Automated unsupported project/skill/metric/URL and empty/partial-message failure coverage.
- **I3-AC11 — Valid message version/time:** Automated ready transition, profile version, validation status, timestamp, and formatting preservation.
- **I3-AC12 — Legacy ready preservation:** Current-safe legacy records and all
  applied/skipped history are preserved; the eight confirmed unsafe active
  dispatch messages are narrowly quarantined by stable identity/evidence.
- **I3-AC13 — Retryable external failures:** Automated sanitized timeout/rate-limit classification, stage, count, and backoff; export retry settings validated.
- **I3-AC14 — Terminal failures:** Automated exhausted and validation-failure terminal routing.
- **I3-AC15 — Stale lease recovery:** Automated active-claim and append-only claim expiration coverage.
- **I3-AC16 — Stale write cannot overwrite decision:** Generator claim marking matches `state_guard`; final commits match `processing_commit_guard`; reviewer actions clear both processing keys; workflow tests reject canonical-ID claim cleanup.
- **I3-AC17 — One cap value:** `config/runtime.json`, export metadata/code, README/architecture all use 5; automated drift check.
- **I3-AC18 — No auto apply:** Policy requires manual submission; export scan rejects submit/apply endpoints and automated applied/skipped nodes.
- **I3-AC19 — Required generation fixtures:** Automated direct, adjacent, review-required, unsupported skill, seniority, unavailable, missing description, invalid output, rate limit, overlap, stale claim, and legacy ready coverage.
- **I3-AC20 — Eligibility ordering:** Automated generation-stage/score/oldest ordering and cap test; priority ordering is explicitly documented.
- **I28-AC1 — Pack gate:** Workflow-structure and direct pack tests prove only
  `ready` packs reach Groq; non-ready packs persist bounded human-review
  context with zero provider path.
- **I28-AC2 — One bounded repair:** The generated graph has one repair agent
  reachable only after deterministic initial validation failure. Direct and
  lifecycle tests prove the repair prompt contains the rejected draft and all
  errors, reuses the claim, and does not add a pipeline attempt.
- **I28-AC3 — Validation hardening:** Regression tests cover the production
  over-length, Expo, React Native, banned-phrase, and Pacific-time failure;
  transformed/job-sourced numbers, internal labels, and completion claims also
  fail closed.
- **I28-AC4 — Atomic finalization:** Initial or repaired output must pass the
  same pack/message validator and `processing_commit_guard`; failed work starts
  from the pre-generation record so prior valid data and newer manual state
  remain authoritative.

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
- **I6-AC11 — Complete Sheet schema:** `docs/sheet-schema.md` defines all 90 canonical record fields, nine tabs, actions, states, and compatibility.
- **I6-AC12 — Rollout runbook:** `docs/operations.md` includes backup, migration, profile validation, dry run, old-writer shutdown, activation, and checks.
- **I6-AC13 — Rollback preservation:** Runbook keeps canonical identity, active/ready data, decisions/outcomes, and Archive dedup history.
- **I6-AC14 — Production observations:** Runbook defines coverage, dedup, evaluation, generation, retry, stuck-claim, review, and archive counts without success targets.
- **I6-AC15 — Drift failure:** Generated workflow/Sheet `--check` commands plus export/config tests fail `npm run validate` on critical drift.
- **I6-AC16 — No bypass/submission/service:** Export scan, policy, architecture, and runbook retain OnlineJobs.ph read-only/manual submission and add no service.
- **I6-AC17 — Explicit runtime bounds:** Automated policy/runtime validation
  and generated-export tests require all seven workflows to use
  `Asia/Manila`, positive configuration-owned execution timeouts shorter than
  their schedules, and timeout/lease ordering wherever a workflow owns a
  claim. The runbook retains shorter node-level provider/HTTP timeouts and
  verifies idempotent recovery rather than assuming immediate mid-node abort.
- **I6-AC18 — Bounded execution-data writes:** Runtime/config and generated
  workflow tests require all seven exports to retain failures and manual smoke
  runs while skipping successful production payloads and per-node progress.
  The checked-in cadences total 6,322 scheduled runs per week; authoritative
  success remains in Sheets, and the runbook separately gates instance-level
  age/count pruning.
- **I6-AC19 — Ordered learning schedules:** Configuration, policy, generated
  workflow, and documentation tests pin Analytics to 02:00 daily and
  Recommender to 02:45 Monday in `Asia/Manila`. The 45-minute separation
  covers Analytics' 30-minute outer timeout plus a required 15-minute
  completion buffer without relying on activation-relative interval phases.

## Issue #8 — Extended learning contract

- **Ranking/pack/alert fields:** Artifact: the canonical 90-field
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
  processing-guard and archive confirmation tests retain canonical identity,
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
  the 3-minute Slack workflow use environment-bound webhook/review values and
  render all required score, employer/salary/freshness, gap, Apply Points,
  instruction/question/proof/warning, and safe action context with explicit
  unknown labels.
- **No action authority:** Review/skip links open the authorized Sheet for
  confirmation; the canonical source link is open-only. No link applies,
  spends points, or contains a reusable state-changing token.
- **Delivery state/idempotency:** Canonical identity plus alert-policy version
  scopes one initial alert. Confirmed delivery persists channel/version/time
  and bounded provider reference; known transient rejection retries with
  bounded backoff. The 90-second workflow timeout is shorter than the
  2-minute lease, the lease expires before the next 3-minute poll, and retry
  backoff never precedes lease expiry, so polls cannot create a starvation
  chain of losing claims. The cap of 5 matches Generator throughput.
  Configuration/permanent/unavailable paths remain visible.
- **Ambiguous delivery safety:** Records move through `sending`; timeout or a
  lost acknowledgement is terminal/ambiguous and never blindly resent.
  Ready pack and manual state remain intact.
- **Security/regression:** `alerts.test.mjs` covers eligibility boundaries,
  success, duplicate suppression, transient/permanent failure, ambiguity,
  unavailability, missing configuration, tampered links, repeated skip, and
  empty work. Export tests enforce disabled state, secret references,
  sanitization, and absence of application actions.

## Issue #22 — Copyable Slack application messages

- **Complete copy block:** `renderAlert` independently revalidates the persisted
  message and ready pack, encodes only Slack control characters, and places the
  complete application message in one labeled code block. Tests decode the
  rendered block and compare it with multiline source text containing spacing,
  punctuation, Unicode, approved URLs, and Slack metacharacters.
- **Message-first fitting:** The renderer reserves the complete code block and
  Review Queue/source link tail before fitting optional alert context. Boundary
  tests prove an exact-limit message is unchanged, optional context is omitted
  first, and one additional character fails closed rather than truncating.
- **Deterministic preflight:** Embedded code-fence boundaries, unsupported
  invisible controls, and over-limit messages become sanitized non-retryable
  preflight failures before the Slack HTTP node. The guarded commit releases
  the claim, preserves the valid message/pack, and never reports a provider
  timeout or sends a partial message.
- **Compatibility and authority:** Eligibility thresholds, policy-version
  idempotency, provider retry behavior, inactive exports, non-mutating review
  navigation, and manual OnlineJobs.ph submission remain unchanged. A
  renderer-only rollout does not requeue previously confirmed alerts.
- **Operational verification:** The alert runbook requires a disabled
  non-production delivery, plain-text copy comparison, render-failure controls,
  duplicate suppression, and confirmation that no Slack link mutates
  application state.

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
- **Complete-report boundary:** Detail and report IDs are SHA-256
  content-addressed and idempotent. An exact compatible complete result skips
  every analytic write only when it is already latest; older, partial,
  incompatible, malformed, or changed results cannot authorize the skip. Only
  a matching full detail write publishes `status=complete`; partial/orphan rows
  cannot supersede the previous complete report. Empty input is explicitly
  successful.
- **Compatibility/privacy/tests:** Existing Dashboard behavior is unchanged.
  Output is formula-neutral, aggregate-only, and read-only against job state.
  `analytics.test.mjs`, workflow/Sheet/docs tests, and fixed fixtures cover all
  requested totals, bands, attribution, overlap, unknown/zero/invalid/empty,
  progressive outcome, and partial-publication cases.

## Issue #14 — Guarded weekly recommendations

- **Versioned weekly run:** `config/recommendation-policy.json` defines the
  168-hour schedule with a Monday 02:45 `Asia/Manila` start, after the daily
  02:00 Analytics run's timeout plus 15-minute completion buffer, as well as
  all-time input, required metric/band versions, production sample/coverage
  gates, comparisons, and output schemas. A failed or overrun same-day source
  cannot displace the latest complete report.
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
- **History, idempotency, and failure:** A SHA-256 analysis key gives successful
  overlap and recovery one stable run/detail scope. An exact compatible result
  skips writes only when already latest; returning to older evidence
  republishes it. Failed attempts retain execution-scoped sanitized history and
  never replace the latest complete internal view.
- **No-mutation boundary:** The generated weekly workflow reads
  `Analytics`/`AnalyticsReports` plus its own report history and writes only
  recommendation tabs. It has no notification or job/config mutation path;
  existing 4-hour/22-query and all other schedules/flows remain unchanged.
- **Coverage/operations:** `recommendations.test.mjs` covers strong/weak
  query/role, over/underconfidence, all requested comparisons, missing skill,
  sparse/low/unknown coverage, empty/incompatible/failed input, same/superseding
  attempts, redaction, last-complete selection, and input immutability.
  Workflow/Sheet/docs tests plus `docs/operations.md` cover disabled staged
  rollout, verification, disable-only rollback, and separate approval for any
  future automatic calibration.

## Issue #16 — Plain-text version metadata and coercion repair

- **I16-AC1 — Every declared version field is plain text:** Contract-derived
  headers from the job, analytics, and recommendation policies are formatted
  before migration on every applicable tab; executable generated-script tests
  verify the complete inventory and operation order.
- **I16-AC2 — Genuine dates are untouched:** Only contract-declared version
  headers are selected. A realistic Sheet fixture verifies that a neighboring
  timestamp retains its date value and is never formatted by the migration.
- **I16-AC3 — Five corrupt raw values are repaired:** The migration accepts
  only `profile_version=46231` or its Apps Script `Date` representation when
  the displayed value is `2026-07-28` and stable identity is present, then
  writes the exact string. Raw Google Sheets API verification on the isolated
  workbook copy confirms string values and `TEXT` formatting for rows 14–18.
- **I16-AC4 — Stable identity guards repair:** Physical row number is reported
  for evidence but never authorizes repair; missing identity is an unmapped
  value covered by automated tests.
- **I16-AC5 — Blank values remain blank:** The classifier treats blank values
  as already valid and never supplies a guessed version.
- **I16-AC6 — Unknown numerics fail visibly:** Every other non-string value is
  returned in a bounded sanitized `unmapped` result and stops setup before
  workflow activation.
- **I16-AC7 — Reruns are idempotent:** Executable generated-script tests run the
  migration twice and verify that the second pass performs no repair.
- **I16-AC8 — Existing durable data is preserved:** The isolated copy retains
  source/copy parity for row shape, canonical IDs, URLs, statuses, messages,
  decisions, outcomes, and outcome events; the migration writes only authorized
  version cells and number formats.
- **I16-AC9 — Generated artifact is current:** `npm run validate` runs
  `scripts/build-sheet-setup.mjs --check` against
  `google-apps-script/SheetSetup.gs`.
- **I16-AC10 — Required regression coverage:** `sheet-setup.test.mjs` covers
  generated runtime validity, formatting-before-write, numeric and Date repair,
  valid strings, blanks, unknown values, identity checks, reruns, and timestamp
  isolation.
- **I16-AC11 — Safe validation boundary:** The full validation suite passes and
  workflow artifact tests require every checked-in export to remain inactive.

## Issue #17 — Atomic processing-claim finalization

- **I17-AC1 — Evaluation success clears active claim state:** Evaluation
  commits match `processing_commit_guard` and include blank
  `processing_token`, `processing_stage`, and `processing_started_at` from
  `releaseClaim` in the same Sheets update.
- **I17-AC2 — Every terminal workflow path follows the invariant:** Generated
  evaluation failure, generation success/failure, alert success,
  state-only suppression, configuration failure, retryable failure, and
  terminal failure paths retain the commit guard while never re-injecting the
  active token.
- **I17-AC3 — Stale commits fail closed:** Manual actions clear both processing
  keys; newer claims replace both. Final nodes match only the expected commit
  guard, so an old result updates zero rows after either change.
- **I17-AC4 — No second unguarded cleanup:** Generator and alerter graphs contain
  one guarded terminal commit and no canonical-ID claim-clear node.
- **I17-AC5 — Retry evidence is retained:** Direct evaluation/generation and
  alert tests verify failed stage, attempt counts, retry time, and sanitized
  evidence while `releaseClaim` clears active metadata.
- **I17-AC6 — Five confirmed orphans are narrowly repaired:** Generated Sheet
  migration maps exact stable identity, terminal status, and reported
  evaluation token; it re-reads the row before clearing. Raw API verification
  on the isolated copy confirms all five tokens are blank.
- **I17-AC7 — Live claims are preserved:** The cleanup classifier reports and
  leaves a token with nonblank stage and unexpired start time unchanged.
- **I17-AC8 — Cleanup is idempotent and observable:** Migration output contains
  bounded cleared, preserved-active, skipped, and conflicting counts/records;
  executable tests verify a second pass clears nothing.
- **I17-AC9 — Contract and workflow agree:** Direct terminal-state tests assert
  blank active claim fields and retained non-active commit guard; workflow tests
  inspect the corresponding match key and persisted field mappings.
- **I17-AC10 — Claim and alert regressions remain covered:** Existing and
  extended tests cover acquisition, append-only deterministic arbitration,
  stale recovery, manual invalidation, alert retries, ambiguity, and duplicate
  suppression.
- **I17-AC11 — Documentation reflects terminal state:** Architecture,
  data-contract, Sheet schema, review report, and operations guidance describe
  the commit guard and blank terminal active-claim fields.
- **I17-AC12 — Generated/disabled validation boundary:** `npm run validate`
  checks current workflow and Apps Script artifacts and requires every export
  to remain inactive.

## Issue #18 — Unsafe legacy-message quarantine and regeneration

- **I18-AC1 — Legacy/mismatched profile is rejected:** The shared
  `evaluatePersistedMessageSafety` predicate emits distinct stable reasons for
  legacy, missing, and mismatched message profile versions.
- **I18-AC2 — Every current safety dimension is enforced:** The predicate
  checks message policy/version/validation state, deterministic content,
  current ready pack status and versions, pack structure/timestamp, approved
  URLs, and banned phrases. Unit tests cover each reason and combined evidence.
- **I18-AC3 — Current-safe control remains eligible:** A current validated
  message with a structurally valid current pack passes the predicate and
  existing apply/alert paths.
- **I18-AC4 — Manual apply fails without mutation:** `mark_applied` invokes the
  shared gate before input/snapshot writes; a quarantine test verifies the
  decision, timestamp, snapshot, and complete record remain unchanged.
- **I18-AC5 — Slack fails closed:** Eligibility includes the stable
  `message_quarantined` reason. Pending/sending/retryable unsafe records take a
  state-only path, and direct rendering throws before provider work.
- **I18-AC6 — Eight records are identified before generation:** Sheet migration
  requires all eight exact canonical IDs plus ready/undecided/legacy provenance
  and the confirmed obsolete resume URL, rechecks each row, and fails setup if
  the target cohort is incomplete or conflicting.
- **I18-AC7 — Alert state cannot survive quarantine:** Migration writes
  `not_eligible`, clears delivery/idempotency/retry evidence, and stores only
  the stable sanitized suppression reason.
- **I18-AC8 — Existing evaluation rules remain authoritative:** Migration
  preserves ranking values and routes quarantined rows to recommended.
  Missing-description quarantines select evaluation first; only a subsequent
  recommendation enters generation.
- **I18-AC9 — Success requires an atomic current replacement:** Generation can
  commit lifecycle `ready` only for `application_pack_status=ready`; the
  established message/pack validators write current profile/policy/pack
  provenance and approved content together.
- **I18-AC10 — Failure stays quarantined:** Fetch/model/pack/content failures
  retain a blank active message, non-current provenance, retry evidence, and a
  failing shared safety decision.
- **I18-AC11 — Reruns avoid duplicate work/alerts:** Sheet migration recognizes
  already-quarantined and current-safe targets. A current-safe ready record is
  not selected for generation, and alert idempotency remains policy-scoped.
- **I18-AC12 — Unrelated durable history is preserved:** The isolated-copy
  migration retains target identity, URL, title, ranking, application decision,
  and outcome fields; non-target and applied/skipped behavior has regression
  coverage.
- **I18-AC13 — Full regression matrix exists:** `message-safety.test.mjs`,
  evaluation/generation, reviewer, alert, workflow, Sheet migration, and E2E
  suites cover individual/combined reasons, denials, success, partial failure,
  idempotency, and current-safe controls.
- **I18-AC14 — Generated/disabled validation boundary:** `npm run validate`
  checks current generated artifacts and requires all workflow exports to
  remain inactive.

## Issue #19 — Context-aware PHP and alternative requirements

- **I19-AC1 — PHP amounts are currency:** Qualification fixtures cover PHP
  amounts/ranges and the peso symbol without emitting a PHP programming gap.
- **I19-AC2 — Compensation wording is currency:** Salary, wage, compensation,
  monthly-pay, explicit Philippine-peso, and in-PHP contexts are classified
  before severity.
- **I19-AC3 — Salary ranking remains independent:** The classifier does not
  rewrite `salary_text`; PHP 75,000/month remains an observed opportunity
  salary input.
- **I19-AC4 — Required PHP stays hard:** A separate unambiguous PHP programming
  requirement still routes to `not_recommended` and `save_points`, including
  when the same posting also contains PHP compensation.
- **I19-AC5 — Preference semantics remain:** “PHP would be useful” produces a
  preference gap and does not become a hard requirement.
- **I19-AC6 — Supported alternatives satisfy once:** `choose any`, `one of`,
  `either`, and `at least one of` fixtures with comma, slash, and `or`
  separators emit no unchosen-option gaps when one canonical skill matches.
- **I19-AC7 — Unsupported alternatives produce one gap:** An unsatisfied group
  persists one alphabetized `One of: ...` gap with its clause severity and
  bounded evidence.
- **I19-AC8 — Independent lists remain independent:** `PHP and Laravel` and
  slash-only requirements without an alternative marker retain separate gaps.
- **I19-AC9 — Ambiguity remains fail-closed:** Unmarked PHP/Laravel wording
  remains ambiguous and review-oriented rather than being ignored.
- **I19-AC10 — Bounded deterministic output:** Classification reads at most the
  established ranking-text bound, stores at most 160 evidence characters, and
  sorts requirement labels deterministically.
- **I19-AC11 — Evaluation fields agree:** Qualification score, decision,
  reasons/factors, `requirement_gaps`, and `requirement_gap_details` derive
  from the corrected pre-scoring classification.
- **I19-AC12 — Lifecycle regression:** The synthetic discovery-to-archive E2E
  includes a satisfied TypeScript/PHP/Ruby alternative without blocking
  generation.
- **I19-AC13 — Ranking semantics are versioned:** New evaluations persist
  ranking policy `2026-07-28/v2`; weights, thresholds, confidence, salary
  scoring, and Apply Points rules are unchanged.
- **I19-AC14 — Generated/disabled boundary:** `npm run validate` verifies the
  current bundled generator classifier and every workflow export remains
  inactive.

## Issue #20 — Disabled Groq-to-Slack smoke test

Sanitized runtime evidence, workbook links, counts, execution IDs, partial
failures, fixes, and reconciliation are recorded in
`docs/smoke-test-2026-07-28.md`.

- **I20-AC1 — Issue #16 preflight:** Raw reads on the migrated copy return all
  five repaired `profile_version` values as `2026-07-28` strings and the
  applicable version cells use `TEXT`/`@` formatting.
- **I20-AC2 — Issue #17 preflight:** The five confirmed migrated terminal rows
  and every completed disposable evaluation/generation/alert row have blank
  `processing_token`, `processing_stage`, and `processing_started_at`.
- **I20-AC3 — Issue #18 preflight:** All eight confirmed unsafe active messages
  were quarantined on the remediation copy before external integration; the
  alert control remained quarantined and produced zero provider calls.
- **I20-AC4 — Issue #19 preflight:** The final positive fixture's explicit
  TypeScript/PHP/Ruby alternative produced no gap, while the mandatory-PHP
  control became `not_recommended` and made no Groq call.
- **I20-AC5 — Repository validation:** `npm run validate` checks the current
  generated artifacts and inactive exports. Final command evidence is recorded
  with the delivery change set.
- **I20-AC6 — Readable timestamped copy and counts:** The named remediation and
  dedicated smoke workbooks were readable before execution; their private Drive
  IDs are excluded from this public repository. Pre-run active, status,
  message, identity, Archive, decision, and outcome counts are recorded.
- **I20-AC7 — Inactive imports:** The disposable generator and alerter stored
  `active=0`, used Manual Triggers, and were rebound only to the dedicated
  workbook. Runtime registrations were stopped before integration.
- **I20-AC8 — Valid unique fixture:** `onlinejobs.ph:990005` used a unique
  identity, valid OnlineJobs.ph source URL, recent `posted_at`, complete
  ranking inputs, and an evidence-supported description.
- **I20-AC9 — Policies unchanged for the test:** Ranking/alert thresholds,
  profile facts, and policy versions were not lowered or edited to force the
  smoke result.
- **I20-AC10 — Legitimate generator path:** Execution `3790` evaluated the
  final record at 80 qualification, 80 opportunity, medium confidence, and no
  gaps; execution `3791` reached application-pack generation without manual
  score, confidence, gap, pack, or freshness overrides.
- **I20-AC11 — Groq and deterministic validation:** Execution `3791` invoked
  Groq once, returned a non-empty result, and passed
  `validateGeneratedMessage` and `validateApplicationPack`.
- **I20-AC12 — Safe current commit:** Raw cells contain current scoring,
  profile, message-policy, and pack provenance as plain-text strings. The
  shared persisted-message check returned safe with no obsolete Netlify URL or
  configured banned phrase.
- **I20-AC13 — Generator claim cleanup:** The `3791` ready commit and all final
  disposable rows have blank active processing token/stage/start fields.
- **I20-AC14 — Natural alert eligibility:** The committed record entered
  `alert_status=pending` from the generator's existing eligibility function at
  unchanged thresholds and without an operator state override.
- **I20-AC15 — One confirmed Slack delivery:** Execution `3793` made exactly
  one POST to the approved test webhook and received HTTP 200. The
  acknowledgement was reconciled to persisted `sent` evidence without a
  resend after the run exposed n8n raw-response serialization. Local-only
  execution `3795` verified the final JSON-body POST and bounded `200/ok`
  response shape without another external notification.
- **I20-AC16 — Duplicate suppression:** Execution `3794` selected zero
  candidates and executed the Slack node zero times for the same canonical
  identity and alert-policy version.
- **I20-AC17 — Unsafe alert control:** Execution `3786` committed
  `not_eligible` with `pack_not_ready,message_quarantined` and zero Slack
  executions.
- **I20-AC18 — Generator negative control:** Execution `3780` committed the
  mandatory-PHP record `not_recommended` with zero Groq executions.
- **I20-AC19 — Manual submission boundary:** Final decision/outcome cells were
  blank for every disposable row; no row became applied/skipped and no
  application-submit endpoint exists in or was called by the workflows.
- **I20-AC20 — Count and identity reconciliation:** The dedicated workbook
  ended with 5 unique disposable identities and no Archive overlap; Archive
  remained unchanged. The source workbook retained its original 17 identities,
  statuses, messages, claims, decisions, and outcomes and contained no
  disposable identity.
- **I20-AC21 — Final inactive state:** Checked-in and disposable workflow
  records remained `active=false`; a fresh n8n process was started from zero
  active database records and observed for cached-schedule regression.
- **I20-AC22 — Sanitized evidence:** The smoke evidence records execution IDs,
  before/after states, Groq and Slack results, negative controls, duplicate
  suppression, claim cleanup, runtime findings, and final inactive state
  without credentials, webhook values, full messages/descriptions, or raw
  provider responses.

## Issue #24 — Canonical-ID-synchronized Review Queue

- **I24-AC1 — Additive setup:** Generated Apps Script creates `Review Queue`
  without deleting or rewriting `Sheet1`/`Archive`; static and isolated setup
  tests reject destructive operations.
- **I24-AC2 — Idempotent setup:** `sheet-setup.test.mjs` runs queue creation
  twice and verifies stable ordered headers with no second-pass column moves.
- **I24-AC3 — Exact visible contract:** Versioned configuration and artifact
  tests require the eight visible fields in the ticket's exact order.
- **I24-AC4 — Hidden technical helpers:** Only hidden `canonical_job_id` and
  `source_state_guard` follow the visible fields; row numbers, commands, and
  processing fields are not queue columns.
- **I24-AC5 — Action-only editing:** Generated layout tests require friendly
  Action validation and warning-only protection on every other queue field.
- **I24-AC6 — Eligible unique projection:** `review.test.mjs` verifies one
  ordered row per unique eligible canonical identity.
- **I24-AC7 — Initial statuses:** Configuration and projection tests restrict
  the queue to `ready`, `recommended`, and `review_required`.
- **I24-AC8 — Derived display state:** Projection tests source status, title,
  company, message, URL, score, and hidden guard from normalized `Sheet1`
  records.
- **I24-AC9 — Legacy score:** Projection tests prefer `opportunity_score` and
  fall back to `match_score` only when the former is missing.
- **I24-AC10 — Review reason:** Bounded formula-neutralized warning, gap,
  evidence, and safe-error rendering has direct tests; missing
  `review_required` evidence renders explicit text.
- **I24-AC11 — Friendly-only validation:** Configuration and generated setup
  expose exactly `Generate Application`, `I Applied`, and `Skip`.
- **I24-AC12 — Existing transition reuse:** Mapping tests prove those labels
  call `promote`, `mark_applied`, and `mark_skipped` through
  `applyManualAction`.
- **I24-AC13 — Identity-safe movement:** Workflow tests require hidden
  canonical identity plus state-guard claim and commit-guard finalization;
  source and queue row numbers are presentation metadata.
- **I24-AC14 — Invalid identity/state:** Direct tests reject stale guards,
  missing identities/sources, and duplicate source identities with sanitized
  diagnostics and no update.
- **I24-AC15 — Replay safety:** Identical queue deliveries coalesce; existing
  duplicate-decision and archive tests preserve the original snapshot,
  timestamp, and one canonical archive record.
- **I24-AC16 — Conflict safety:** Conflicting queue inputs fail closed and a
  direct `Sheet1` action wins without a second transition.
- **I24-AC17 — Source-write failure:** Reconciliation tests retain the pending
  Action when the fresh source guard proves no transition committed.
- **I24-AC18 — Cleanup failure:** Reconciliation is retry-safe after a source
  state change and removes the stale row on the next successful cleanup.
- **I24-AC19 — Completed removal:** Direct and E2E tests remove applied and
  skipped source states from the projection.
- **I24-AC20 — Promotion refresh:** Reconciliation tests clear the consumed
  input and return a still-eligible promoted record as `recommended`.
- **I24-AC21 — Archive continuity:** The E2E lifecycle now traverses
  Review Queue → guarded `Sheet1` applied state → confirmed Archive while
  preserving identity, message, decision, and application snapshot.
- **I24-AC22 — Empty state:** Projection and setup tests retain headers and
  controls with zero placeholder records.
- **I24-AC23 — Legacy Reviewer paths:** Workflow and review tests retain direct
  active actions plus archived outcome updates.
- **I24-AC24 — Adjacent compatibility:** Schedule/config tests plus Dashboard,
  message-safety, Archive, and no-auto-apply regression suites remain
  authoritative.
- **I24-AC24a — Post-commit Dashboard:** The generated Reviewer launches its
  funnel summary only from the post-action active/archive reread. Workflow
  structure tests reject the former initial-snapshot branch, and the runbook
  verifies a committed decision or outcome appears in the same execution's
  summary.
- **I24-AC24b — Exact idle snapshot:** A pure fail-closed comparator plus
  generated-workflow structure tests require exact Review Queue, Applied Jobs,
  and Dashboard content; no action, ambiguity, invalid projection, or eligible
  claim cleanup; and formula-visible reads before the Reviewer may exit. The
  stable path uses six reads and no writes instead of at least 14
  Sheet/Sheets API requests, one projection claim, and one Dashboard mutation.
  Retention work still enters the existing projection-lease arbitration path.
- **I24-AC25 — Failure/concurrency matrix:** Review, workflow, setup, Archive,
  and E2E suites cover ordering, empty data, duplicates, stale/conflicting
  state, unconfirmed commit, cleanup retry, concurrent Action preservation,
  completed removal, promotion refresh, and archival.
- **I24-AC26 — Generated artifacts:** `npm run build` owns
  `google-apps-script/SheetSetup.gs` and `workflows/reviewer.json`;
  `npm run validate` enforces drift checks and inactive exports.
- **I24-AC27 — Activation gate:** `docs/operations.md` requires the complete
  non-production desktop Sheet and disabled Reviewer failure/retry smoke matrix
  before any production activation.

## Issue #29 — Generation-failure Review Queue recovery

- **I29-AC1 — Generation-only recovery membership:** Configuration and
  projection tests include retryable/terminal generation failures once while
  keeping unrelated terminal failures, completed decisions, and archived rows
  out of the simplified queue.
- **I29-AC2 — Friendly bounded reasons:** Direct tests distinguish pending/due
  automatic retry from exhausted attempts and preserve recognizable
  validation/provider causes after URL, credential, control-character, and
  formula sanitization.
- **I29-AC3 — Hidden recovery state:** The exact eight visible and two hidden
  helper columns remain unchanged. Recovery rows project a blank generated
  message and no technical attempts, timestamps, stage, token, or command
  column.
- **I29-AC4 — Contextual generation action:** Guarded queue tests prove
  `Generate Application` remains `promote` for review states and becomes the
  existing `retry` action only for generation failures, resetting attempts and
  scheduling the same failed stage.
- **I29-AC5 — Safe decisions:** Direct and queue tests allow idempotent Skip
  from generation failures while both UI validation and authoritative
  processing reject I Applied until a current validated message is ready.
- **I29-AC6 — Retry reconciliation:** Direct lifecycle tests preserve canonical
  identity, return successful work as `ready` with its validated message, and
  retain failed work with an updated recovery reason.
- **I29-AC7 — Commit/replay safety:** Existing guarded source-write,
  cleanup-failure, duplicate, stale, missing, conflicting, and concurrent-edit
  tests apply unchanged to recovery actions.
- **I29-AC8 — Archive boundary:** Archive tests retain retryable and undecided
  terminal generation failures, continue archiving unrelated terminal states,
  and archive an explicit skipped decision through the established
  confirmation/idempotency path.
- **I29-AC9 — Generated surfaces:** Sheet setup refreshes recovery-row dropdowns
  to only Generate Application/Skip on open or Action selection; Reviewer and
  Archiver exports embed the versioned configuration and remain inactive.

## Issue #31 — Guarded Applied Jobs outcome follow-up

- **I31-AC1–3 — Additive, idempotent, fail-closed setup:** Generated setup and
  VM tests create the tab, preserve pending Action data on rerun, and reject
  unsupported or duplicate headers before mutation.
- **I31-AC4–6 — Exact operator contract:** Versioned config and setup tests
  require the exact eight visible columns, only two hidden identity/state
  helpers, a wrapped generated message, six controlled labels, and protection
  of every field except Action.
- **I31-AC7–9 — Complete deduplicated membership:** Projection tests cover
  active and archived applications, explicit offer/rejected outcomes,
  non-applied exclusions, and active-source precedence during recoverable
  overlap.
- **I31-AC10 — Legacy blanks:** Projection fixtures prove missing optional
  application, message, company, URL, and outcome values remain blank.
- **I31-AC11 — Identity ambiguity:** Missing or duplicate eligible identities
  are omitted and returned as sanitized invalid-record diagnostics.
- **I31-AC12 — Deterministic order:** Tests require descending application time
  with canonical identity fallback for invalid or tied timestamps.
- **I31-AC13 — Empty state:** Projection and setup artifacts retain headers,
  validation, formatting, and protections with no placeholder records.
- **I31-AC14–15 — Friendly existing actions:** Config validation requires No
  Response, Replied, Interview, Offer, Rejected, and Clear Outcome to map
  exactly to established manual outcome commands.
- **I31-AC16 — Guarded authoritative routing:** Reviewer tests reread and route
  each action to one unique active or archived source using canonical identity
  plus source guard.
- **I31-AC17 — Durable history preservation:** Action tests assert updated
  outcome/timestamp/events/updated state and guard while retaining decision,
  generated message, application snapshot, notes, and version metadata.
- **I31-AC18–20 — Explicit idempotent semantics:** Tests cover repeated current
  outcomes without duplicate events, nonblank/blank Clear Outcome behavior,
  and no-response only through explicit Action.
- **I31-AC21 — Fail-closed inputs:** Stale, missing, non-applied, forged,
  malformed-history, and duplicate source/action cases produce sanitized
  diagnostics and no source update.
- **I31-AC22 — Direct-source precedence:** Active and Archive direct
  `manual_action` values win conflicting projection inputs.
- **I31-AC23–24 — Confirmed cleanup:** Reconciliation retains Action through
  unconfirmed writes and cleanup retries. Canonical-key updates omit Action;
  one append-only lease winner retires a blank stale row only when a
  server-atomic, identity-matched template comparison confirms every current
  cell is still blank. A late Action makes the row non-duplicate, so confirmed
  refreshes are idempotent without concurrent-input loss.
- **I31-AC25 — Concurrent sheet edits:** Reconciliation snapshot tests preserve
  an Action entered or changed after the Reviewer initial read, and
  row-movement/guard-only changes cannot authorize stale-action rebasing.
- **I31-AC26 — Archiver race safety:** Guarded archive commits and the existing
  fresh-snapshot/full-copy Archiver confirmation prevent outcome loss during
  active-to-Archive movement.
- **I31-AC27 — Adjacent workflow compatibility:** Review Queue, Dashboard,
  analytics, direct review actions, and Archiver regression tests continue to
  exercise their established contracts.
- **I31-AC28 — Automated matrix:** Review, setup, workflow-structure, Archive,
  and E2E suites cover projection, controls, routing, outcome semantics,
  failures, concurrency, cleanup, and full archived follow-up.
- **I31-AC29 — Generated artifacts:** `npm run build` owns
  `google-apps-script/SheetSetup.gs` and `workflows/reviewer.json`; `npm run
  validate` enforces artifact drift, syntax, inactive exports, and the complete
  automated suite.
- **I31-AC30 — Non-production smoke gate:** The copied-workbook, inactive
  Reviewer evidence in `docs/smoke-test-2026-07-29-applied-jobs.md` verifies
  setup and idempotency, exact controls, membership and overlap, all six
  actions, preserved state, partial-failure replay, stale/direct conflicts,
  concurrent input, empty state, and preserved Review Queue behavior. Archive
  race safety is covered by the deterministic archive-concurrency regression.

## Issue #25 — Slack Review Queue navigation

- **I25-AC1 — One review link:** `alerts.test.mjs` requires one configured
  review URL occurrence labeled `Open Review Queue`.
- **I25-AC2 — Legacy labels removed:** Direct, bounded, and generated-workflow
  tests reject `Review in Sheet`, `Review in authorized Sheet`, and
  `Confirm skip in Sheet`.
- **I25-AC3 — Exact environment URL:** Rendering returns the validated
  configured URL unchanged and appends no job ID, command, credential, or
  reusable action token.
- **I25-AC4 — Deep-link rollout:** `docs/alerts.md` and
  `docs/operations.md` require distinct environment values containing the
  `Review Queue` sheet identifier and a desktop/web click test before
  activation.
- **I25-AC5 — Source action retained:** Alert tests require one canonical
  OnlineJobs.ph action with `open_only` mode.
- **I25-AC6 — Navigation cannot mutate:** Returned actions contain no token or
  record payload; tampered/forwarded-link tests and the explicit Reviewer
  boundary prove Slack cannot change lifecycle, decision, or outcome state.
- **I25-AC7 — One metadata action:** Rendering returns only
  `review_action` and `source_action`; obsolete `skip_action` metadata is
  absent.
- **I25-AC8 — Complete message retained:** Existing multiline copy-block tests
  compare decoded paragraphs, punctuation, Unicode, spaces, Slack literals,
  and approved URLs with the stored message.
- **I25-AC9 — Recalculated payload boundary:** Exact-limit and one-character
  overflow tests reserve only the Review Queue/source tail; optional context
  still drops first.
- **I25-AC10 — Configuration fails closed:** Existing policy/provider tests
  cover missing, invalid, overlong, credential-bearing, and non-HTTPS values;
  workflow preflight prevents a Slack request and stores sanitized evidence.
- **I25-AC11 — Sent records remain sent:** Alert idempotency stays scoped to
  canonical identity plus the unchanged alert policy version; confirmed-sent
  regression tests do not requeue the record.
- **I25-AC12 — Delivery compatibility:** Pending/retryable selection,
  ambiguous timeout, suppression, transient backoff, terminal preflight, and
  application-pack preservation tests remain unchanged.
- **I25-AC13 — Direct alert coverage:** `alerts.test.mjs` verifies exact label,
  count, target, legacy-label absence, size bounds, message fidelity,
  configuration denial, and non-mutating metadata.
- **I25-AC14 — Generated workflow coverage:** `workflows.test.mjs` verifies the
  new label, rejects obsolete labels/modes and state-changing paths, requires
  environment references, and keeps the export inactive.
- **I25-AC15 — Generated artifact ownership:** `npm run build` regenerates
  `workflows/alerter.json`; artifact checks reject direct-export drift.
- **I25-AC16 — Documentation:** Alert, architecture, operations, and acceptance
  documents describe one Review Queue link and the explicit in-sheet action
  boundary.
- **I25-AC17 — Release validation:** `npm run build` and `npm run validate` are
  automated gates; the runbook additionally requires a non-production Slack
  desktop/web deep-link smoke before activation.
- **I25-AC18 — Adjacent regression:** Full alert, review, generation, Archive,
  workflow, and E2E suites retain eligibility, manual submission, and durable
  state behavior.
