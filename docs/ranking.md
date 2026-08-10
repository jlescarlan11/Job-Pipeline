# Opportunity ranking

`config/ranking-policy.json` retains the repository-controlled scoring weights,
thresholds, confidence rules, and Apply Points logic. At runtime, candidate
facts come from the six candidate context tabs. `Job Preferences` supplies the
editable role-family evidence mapping, unsupported-technology catalog, and PHP
monthly salary bands. The workflow derives a ranking context hash from the
enabled preference rows.

## Qualification

Qualification is a 0–100 evidence score. Contributions come from approved
profile skills, configured role-family evidence references, and an explicit
early-career signal in the posting. Unsupported technologies are classified
from the surrounding requirement language:

- `hard`: must, required, minimum, mandatory, proficiency, or an explicit years
  requirement;
- `preference`: preferred, nice-to-have, bonus, plus, optional, or
  “would be useful” language;
- `ambiguous`: a mentioned unsupported technology without either marker.

Recognized qualification headings provide section context to their child
lines. `Requirements`, `Required Qualifications`, and equivalent headings make
otherwise unmarked child capabilities hard requirements. `Preferred Skills`,
`Nice to Have`, and equivalent headings make them preferences. A local marker
overrides the inherited context; conflicting local-hard language inside a
preferred section is review-oriented (`ambiguous`) instead of silently becoming
a terminal hard gap. Responsibility, overview, benefits, and application
headings reset qualification context.

Capability matching uses canonical names from the approved candidate profile
even when a skill has no curated alias, plus bounded family aliases for common
forms such as REST/RESTful APIs, CI/CD, and ASP.NET/.NET. Extraction accepts
explicit requirement grammar but does not turn headings, generic prose, or
container nouns such as `backend`, `databases`, or `DevOps tools` into
standalone gaps. Explicit lower-case technologies in requirement clauses still
produce gaps when they are not supported by the profile.

A `PHP` occurrence is classified before severity is assigned. An adjacent
amount, explicit Philippine-peso wording, or an unambiguous
salary/wage/compensation/pay/rate context is currency evidence and does not
become a programming gap. The exclusion is occurrence-local: a separate
`PHP programming experience is required` clause in the same posting remains a
hard gap. Qualification parsing does not remove or rewrite `salary_text`, so
the opportunity salary factor continues to parse reliable PHP-per-month
amounts independently.

Disjunctive and illustrative lists—such as `one of`, `either`, `choose any`,
`at least one of`, `such as`, `including`, `e.g.`, or an ordinary `or` list—are
evaluated as one alternative group when at least two bounded capabilities can
be identified. One canonical approved profile skill satisfies the group and
suppresses gaps for unchosen alternatives. If no listed option is supported,
one deterministic gap named
`One of: <alphabetized options>` is persisted with the original bounded
evidence and the clause severity. A slash or comma list without an explicit
alternative marker remains a set of independent requirements. Unrecognized or
unclear wording remains ambiguous rather than being discarded.

A hard gap, including a seniority mismatch, produces the internal
`not_recommended` decision and maps to visible pipeline result `skip`. Without
a hard gap or truncated description, a posting whose pre-penalty qualification
meets the review threshold cannot be lowered to `not_recommended` solely by
ambiguous or preferred gaps; it remains at least `review_required` and maps to
visible `review_needed`. Preference gaps reduce the score but do not
independently block a recommendation. These internal decision labels are
implementation details; operators act only on the simplified visible statuses.

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

Within lifecycle priority, the single Evaluator & Generator queue sorts by:

1. `opportunity_score` descending;
2. `ranking_confidence` (`high`, `medium`, `low`, blank);
3. posting time descending;
4. creation time descending;
5. `canonical_job_id` ascending.

Apply Points recommendations are `save_points`, `low_allocation`,
`normal_allocation`, or `high_allocation`. They never represent qualification,
read or alter a live points balance, submit an application, or spend points.
For autonomous submission, trusted application policy maps low to 1 point,
normal to 5, and high to 10; `save_points` does not apply. The value must also
exist in the live form's offered options. This is a per-application allocation,
not a daily quota.
