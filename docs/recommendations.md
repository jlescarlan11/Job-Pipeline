# Weekly recommendations

## Boundary and source

The disabled-by-default `workflows/recommender.json` runs every 168 hours,
starting Mondays at 02:45 in `Asia/Manila`. The daily Analytics workflow starts
at 02:00, so the weekly consumer begins after Analytics' 30-minute outer
timeout and a required 15-minute completion buffer. It reads only
`AnalyticsReports` and `Analytics` as evidence, selects the newest valid
`status=complete` analytics report, and filters detail to that report ID.
`config/recommendation-policy.json` pins the required all-time window, metric
definition, band definition, thresholds, output contracts, and policy version.
An incomplete, incompatible, or orphaned analytics refresh is never eligible.
If the same-day Analytics refresh fails or overruns, the latest complete
earlier report remains eligible; partial same-day detail cannot replace it.
If the source contains analytics metadata but no valid complete report, the
weekly run is recorded as failed rather than as a successful abstention or
empty result. A genuinely empty source produces a complete `empty` report.

Each execution first appends a `recommendation_report_store` claim. Only the
lowest unexpired claim enters the report path; its 20-minute lease exceeds the
15-minute workflow timeout, so scheduled/manual overlap cannot interleave
detail publication or cleanup.

The process is deterministic and advisory. Apart from its coordination lease,
it does not write `Sheet1`, `Archive`, `Dashboard`, any repository configuration,
ranking weights, candidate facts, application decisions, outcomes, or Apply
Points. Search/ranking/profile changes require a separate operator decision and
repository change. Future automatic calibration requires a separately approved
ticket and rollout.

## Eligibility

The production policy requires:

- at least 20 applied records in the complete analytics cohort;
- at least 60% explicit outcome coverage for any directional analysis;
- at least 5 applications in a compared segment;
- at least 70% known application-time coverage for the relevant dimension;
- at least 5 observed discovery records before volume can support a weak-query
  warning; and
- at least 5 promising-job requests and 70% promising-job gap coverage for a
  missing-skill recommendation.

The minimum response-conversion difference is 0.10. Response conversion is the
equal-weight mean of reply, interview, and offer rates, with its summed
numerator and three-times-application denominator persisted for audit. These
rules are eligibility gates, not claims of statistical significance.

If the overall application or explicit-outcome threshold is not met, the run
stores one explicit abstention and no directional recommendation. A dimension
with low coverage stores a dimension-specific abstention; eligible dimensions
may still be analyzed. Unknown values remain represented by analytics coverage
and never become an assumed value.

## Recommendation categories

### Search attention

Search-query and role-family cohorts are compared with the overall applied
cohort. An eligible cohort materially above baseline may receive
`increase_attention`; one materially below baseline may receive
`reduce_attention`. A segment with enough discovery volume and zero response
evidence can be flagged as weak, but discovery volume alone can never justify
increased attention.

Query and role-family attribution remains multi-touch full-credit. Totals are
non-additive, and every recommendation carries that caveat.

### Score and confidence calibration

Qualification and opportunity cohorts use the ordered `00_24`, `25_44`,
`45_64`, `65_79`, and `80_100` application-time bands. Confidence uses
`low`, `medium`, and `high`. A higher adjacent cohort that materially
underperforms is labeled `review_overconfidence`; a lower cohort materially
above the overall baseline is labeled `review_underconfidence`. The proposed
action is to inspect explainable rules, never to edit weights automatically.

### Application cohort comparisons

Eligible matched-skill, PHP-monthly salary, posting-age, actual Apply Points,
Apply Points recommendation, message-strategy, and instruction-completeness
segments are compared with the overall cohort. At least two eligible segments
must exist. The strongest and weakest materially different segments may receive
`favor_for_manual_test` or `review_or_deprioritize`. These are observational
associations; selection effects and missing outcomes remain explicit caveats.

### Missing skills

The analytics source counts requirements attached to jobs meeting the
configured promising-job opportunity threshold. A missing-skill recommendation
requires sufficient promising-job gap coverage and frequency, excludes
non-skill requirements configured by policy, and checks the current approved
profile skill set case-insensitively. It states that the skill is absent from
approved evidence and proposes investigation only. It never adds a claim to
`config/candidate-profile.json`.

## Evidence and internal visibility

`Recommendations` is the internal evidence view. Every row includes:

- recommendation/policy/analytics versions and the all-time window;
- status, category, affected dimension and segment, and advisory direction;
- evidence metric, numerator, denominator, and sample size;
- comparison value, overall or adjacent baseline, and difference where
  applicable;
- coverage numerator, denominator, and rate;
- a bounded proposed operator action and caveat.

`RecommendationReports` is the run-history view. Operators determine the
current report by choosing the newest `status=complete` row by `generated_at`
and `run_id`, then filtering `Recommendations` by that `run_id`. Complete
reports have `result=recommendations`, `abstained`, or `empty`. Failed reports
remain visible but never supersede the last complete report.

No optional Slack summary is included in this version. This keeps the stored
Sheet report authoritative and avoids coupling valid analysis to notification
delivery. A later notification may link to the stored evidence, but delivery
failure must not change report status.

## Idempotency, failure, and privacy

`analysis_key` is a SHA-256 identity for the analytics report, recommendation
policy, and candidate-profile version. A successful report uses that key as its
stable `run_id`, so concurrent or recovered executions converge on the same
recommendation IDs. Before writing, the workflow reads
`RecommendationReports`; an exact compatible result performs no detail or
report writes only when it is already the latest complete report. Returning to
an older analysis republishes it so it becomes current again.

Failed attempts retain an execution-scoped `run_id` and sanitized evidence.
An unavailable recommendation-history read disables the optimization and
publishes through the normal completion gate rather than suppressing work.

Recommendation detail is upserted before report publication. A source-read or
analysis failure creates a sanitized failed run. If any expected detail write
fails or the observed write count differs, the report is published as failed
when the report store remains available. Partial detail is non-authoritative.
The final report write does not continue on error: an unavailable report store
leaves the n8n execution failed and the previous complete row intact.

Normal recommendation history is retained for 365 days. Cleanup is dormant
below 80 report rows, preserves at least the newest 12 complete reports, and
removes at most 12 expired complete/failed runs per batch. A fresh
formula-visible reread must prove unique run/detail identities, row addresses,
and the exact stored detail count before one atomic, non-retried Sheets batch
deletes detail and metadata. Any ambiguity fails closed; the latest complete
report remains outside the eligible set.

Output text is length-bounded, control-character stripped, formula-neutralized,
and credential-like values are redacted. Reports contain aggregated segments,
not descriptions, messages, provider payloads, contact details, or canonical
job identifiers.
