# Opportunity ranking

`config/ranking-policy.json` is the sole versioned policy for deterministic
qualification, opportunity, confidence, and Apply Points recommendations.
`config/candidate-profile.json` remains the only source of candidate facts.

## Qualification

Qualification is a 0–100 evidence score. Contributions come from approved
profile skills, configured role-family evidence references, and an explicit
early-career signal in the posting. Unsupported technologies are classified
from the surrounding requirement language:

- `hard`: must, required, minimum, mandatory, proficiency, or an explicit years
  requirement;
- `preference`: preferred, nice-to-have, bonus, plus, or optional language;
- `ambiguous`: a mentioned unsupported technology without either marker.

A hard gap, including a seniority mismatch, routes the job to
`not_recommended` and forces `save_points`. An ambiguous gap routes to
`review_required` when the remaining qualification score reaches the configured
review threshold. Preference gaps reduce the score but do not independently
block a recommendation.

Every profile-derived explanation contains a canonical evidence reference.
Free-form job text may describe the requirement but cannot create candidate
skills, projects, tenure, metrics, or availability.

## Opportunity

Opportunity is a separately rounded 0–100 weighted score:

| Factor | Weight | Observed behavior |
| --- | ---: | --- |
| Qualification | 50 | Carries the qualification score. |
| Freshness | 15 | Uses posting age from a valid non-future timestamp. |
| Salary | 10 | Parses only unambiguous PHP-per-month amounts or ranges; no currency conversion occurs. |
| Listing completeness | 10 | Measures presence of the configured listing fields. |
| Employer signal | 5 | Uses only allowlisted boolean source fields. |
| Application effort | 5 | Classifies observable tests, recordings, portfolios, questions, or formatting requests. |
| Historical results | 5 | Remains neutral until at least 20 comparable applications exist. |

Missing or unreliable optional input receives the configured neutral score and
is also written to `ranking_missing_signals`. A neutral contribution is not an
assertion that the missing value is average. Confidence is calculated
separately from observed signals, so missing salary, employer identity,
timestamp, employer signal, or sufficient history cannot silently produce high
confidence.

## Priority and compatibility

Within lifecycle priority, both generator and review queues sort by:

1. `opportunity_score` descending;
2. `ranking_confidence` (`high`, `medium`, `low`, blank);
3. posting time descending;
4. creation time descending;
5. `canonical_job_id` ascending.

Legacy records with no `opportunity_score` use their unchanged `match_score` as
a queue fallback until explicit re-evaluation. The fallback does not populate
either new score.

Apply Points recommendations are `save_points`, `low_allocation`,
`normal_allocation`, or `high_allocation`. They never represent qualification,
read or alter a live points balance, submit an application, or spend points.
