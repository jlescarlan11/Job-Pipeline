# Conversion and calibration analytics

## Source of truth and refresh boundary

`config/analytics-policy.json` versions the metric definitions, bands,
attribution rule, all-time window, `Asia/Manila` day boundary, daily cadence,
fixed 02:00 start, and Sheet output contracts. `src/analytics.mjs` is a pure
deterministic aggregator. `workflows/analytics.json` reads `Sheet1` and
`Archive`; it never updates a job, ranking policy, search plan, application
pack, or outcome. The fixed time provides the weekly consumer with a
configuration-validated completion window; workflow activation time does not
define this phase.
`config/report-retention.json` separately versions the store lease and
historical retention boundary.

Every distinct aggregate result has a SHA-256 content-addressed `report_id`.
The identity includes the complete ordered metric result, versions, cohort
counts, window start, timezone, attribution, and warnings, but excludes the run
ID, generation time, and moving all-time window end. Before publishing, the
workflow reads `AnalyticsReports`; an exact compatible complete result ends as
a successful unchanged refresh with no detail or completion writes only when
that result is already the latest complete report and every expected stored
semantic detail row is uniquely present and field-matching. A missing, older,
partial, incompatible, or malformed prior row never authorizes the skip;
neither does missing, duplicated, case-variant, or mismatched detail. If either
history read is unavailable, the workflow logs that condition and safely
disables only the optimization: content-addressed detail and completion upserts
proceed normally.

Detail rows are idempotently upserted to `Analytics` by `analytics_row_id`.
Only after the workflow observes every expected detail write does it upsert
`status=complete` to `AnalyticsReports`. Concurrent or recovered executions
with the same result converge on the same IDs. Consumers select the newest
unambiguous complete metadata row, require its exact sequential detail IDs and
matching row metadata, and recompute its SHA-256 content identity before using
the rows. Folded metadata/detail duplicates, substitutions, formulas, and
content tampering therefore fail closed even when the physical row count is
unchanged. Detail rows without complete metadata are from a failed/partial
refresh and must not replace the previous complete report.

## Store serialization and retention

Every execution first appends an `analytics_report_store` claim and only the
lowest unexpired claim proceeds. Its 35-minute lease exceeds the 30-minute
workflow timeout, so scheduled/manual overlap cannot concurrently publish or
retire rows; a crash is recoverable after lease expiry.

Normal report history is retained for 90 days. Cleanup is dormant below 120
metadata rows, preserves at least the newest 30 complete reports, and removes
at most 30 expired reports at a time. Before deletion the workflow rereads both
tabs with formulas visible and requires a unique canonical report row, a
unique row address, exact `detail_row_count`, and unique matching
`analytics_row_id` values. It sends all descending detail and metadata ranges
in one atomic Sheets `batchUpdate` with automatic retry disabled. Any
malformed, duplicate, incomplete, recent, or current group remains untouched.
An ambiguous response is reconciled from a fresh snapshot on a later run.

## Cohort and outcome definitions

Overall totals deduplicate `Sheet1`/`Archive` overlap by `canonical_job_id`.
Search-query, role-family, matched-skill, requirement-gap, and outcome-event
arrays are unioned. When overlapping immutable application snapshots conflict,
the earliest valid snapshot is retained and a data-quality conflict is emitted.
The latest valid `outcome_at` supplies the compatibility view.

The application cohort contains explicit `application_decision=applied`
records, including compatible archived applied records. The configured window
is `all_time`: records with missing application timestamps remain in
application/outcome denominators, while timestamp-dependent metrics disclose
their lower coverage. `window_start_at` is the earliest valid application time;
`window_end_at` is report generation time.

An outcome numerator requires either a cumulative event of that exact type or
the explicit current legacy outcome. An interview or offer does not fabricate
a reply event. Consequently:

- `reply_rate = applications with explicit replied evidence / applications`
- `interview_rate = applications with explicit interview evidence / applications`
- `offer_rate = applications with explicit offer evidence / applications`
- `rejection_rate = applications with explicit rejected evidence / applications`
- `no_response_rate = applications with explicit no_response evidence / applications`

Per-ten metrics multiply the corresponding explicit numerator/application
denominator ratio by ten. A zero denominator produces a blank value, never
`NaN`, infinity, or a placeholder record. Every metric row carries its
numerator, denominator, sample size, report window, and definition versions.

## Dimensions, bands, and attribution

Conversion rows are emitted for:

- search query and role family;
- application-time qualification/opportunity score band and confidence;
- matched skill and requirement gap;
- reliably parsed PHP-monthly salary band;
- application-time posting-age band;
- actual Apply Points and application-time recommendation;
- message strategy;
- instruction completeness;
- top-ranked versus lower-ranked cohort.

Scores, confidence, Apply Points recommendation, pack status, strategy, and
posting age use the immutable application snapshot. Search/role provenance,
matched skills, requirement gaps, and salary use preserved record evidence;
normal automation does not re-evaluate an applied/archived record. A blank or
contract-invalid value is `Unknown`, not an invented band. This includes
out-of-range scores, unsupported confidence/recommendation/status/strategy
values, and invalid Apply Point counts.
`application_pack_status_at_apply=ready` is instruction-complete;
`review_required` or `blocked` is incomplete; blank is unknown. The top-ranked
cohort is an application-time opportunity score at or above the configured
threshold; other known scores are lower-ranked.

Search query, role family, matched skill, and requirement gap use
`multi_touch_full_credit`: one application belongs to every observed segment.
Those segment totals are explicitly marked non-additive. All other dimensions
are exclusive. Overall totals always count each canonical application once.

Band maximums are inclusive and evaluated in configured order. Salary parsing
accepts only explicit PHP monthly text and uses a range midpoint. Other
currencies, periods, malformed values, and unsupported magnitudes are unknown.
Score-band rows are ordered and include sample size/outcome rates so
non-monotonic calibration is visible without claiming significance.

## Time, Apply Points, blockers, and coverage

Discovery-to-review and discovery-to-application durations require valid
timestamps in chronological order. Mean and median hours include only valid
pairs. Same-day review uses the calendar date in `Asia/Manila`; unobservable or
invalid pairs are excluded from that rate and reported through coverage/data
quality.

Apply Point efficiency includes only applications with known positive integer
points:

- replies/interviews per Apply Point divide explicit outcomes among
  known-point applications by their total points;
- points/application coverage divides known-point applications by all
  applications;
- high-confidence points share divides points attached to an application-time
  high-confidence snapshot by total known points.

`hard_gap_non_application_count` is the count of evaluated jobs with a
structured hard gap and no applied decision. It is an observable proxy and
does not claim the gap caused avoidance. Pack blocker counts independently use
the deterministic warning codes for unavailable instructions and unsupported
required evidence.

Each exclusive dimension emits an unknown segment and known-application
coverage. Multi-touch dimensions emit unknown only when no attributable value
is observable. Data-quality rows expose input rows, deduplicated records,
active/archive overlap, invalid identities/timestamps, and conflicting
application snapshots or decisions.

Malformed legacy `requirement_gap_details` or `application_warnings` values do
not fail a refresh or create blockers. They are excluded from those
calculations, reduce the relevant coverage, and produce explicit data-quality
counts and report warnings.

## Recommendation-supporting observations

Search-query and role-family segments also expose
`discovered_job_count`. This is deduplicated discovery volume, uses
multi-touch full-credit attribution, and is explicitly non-additive. It stays
separate from application conversion so the weekly recommender can identify
volume with weak response evidence without treating volume as success.

Records whose current `opportunity_score` meets the configured top-ranked
threshold form the promising-job observation cohort. Structured gaps from
those jobs emit `promising_job_request_count` by missing requirement plus
`promising_job_gap_coverage`. This cohort is not an application conversion
cohort and does not claim that a frequent requirement is a useful candidate
skill. The weekly recommender applies its own sample, coverage, exclusion, and
approved-profile checks before proposing investigation.

## Operational verification

On a non-production workbook, hand-calculate a small applied cohort and compare
the exact overall numerators/denominators, multi-touch segment memberships,
unknown counts, point totals, and score-band boundaries. Interrupt a refresh
after some detail writes and verify no new complete metadata appears. Rerun and
confirm stable row IDs prevent duplicates within the same execution.

Analytics output contains only aggregate/segment data. Spreadsheet-formula
prefixes in segment text are neutralized. It excludes job descriptions,
generated messages, credentials, provider responses, contact details, and
canonical job IDs.
