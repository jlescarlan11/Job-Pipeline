# Final engineering review

Review date: 2026-07-28

Scope: the extended pipeline contract, dual opportunity ranking,
instruction-aware application packs, high-match alerts, manual learning
telemetry, conversion analytics, weekly recommendations, seven generated n8n
exports, eight-tab Google Sheets setup, deterministic tests, and
migration/operations documentation for GitHub issues #8–#14. Regression review
also includes the closed #1–#6 behavior on which these changes depend.

## Result

The repository implementation is ready for disabled import and non-production smoke testing. All checked-in workflows remain inactive, default validation is offline, and application submission remains a manual candidate action. Production activation is intentionally gated by the backup, migration, rebinding, smoke, and seven-role old-version shutdown procedure in `docs/operations.md`.

## Security and privacy

- The repository-wide secret scan found no API keys, bearer tokens, or private keys. Workflow exports retain n8n credential and Sheet references only; operators must rebind them to the target environment.
- Discovery URL normalization accepts only HTTPS OnlineJobs.ph job-detail URLs, rejects credentials and alternate ports, and removes queries/fragments before any fetch.
- Job titles, descriptions, employer instructions, and formatting are treated
  as untrusted prompt data. Policy-bypass, private-data, unsupported-claim, and
  automatic-action instructions are removed before prompt assembly and surfaced
  only as sanitized warnings. They cannot override the candidate profile,
  application/pack policy, URL/project allowlists, validation, or
  manual-submission boundary.
- Generated-message validation rejects unsupported projects, technologies, numbers, URLs, phone numbers, banned phrases, empty output, and output above the configured word limit.
- Logged external errors are length-limited and redact URLs, tokens,
  authorization values, and API-key-like assignments. Unsupported reviewer
  input is logged generically instead of echoing its value. Analytics and
  recommendation text is formula-neutralized and excludes job identifiers,
  descriptions, generated messages, contact details, credentials, and raw
  provider payloads.
- Slack credentials and authorized review URLs are environment-bound rather
  than embedded. Alert links are open-only/confirmation links and carry no
  reusable state-changing authorization.
- Only approved public candidate links are present in the profile. Credentials, raw provider responses, complete job descriptions, and full profile contents are excluded from the operations evidence log.
- No workflow contains an application-submit endpoint, changes an OnlineJobs.ph
  balance, or automatically sets an applied/skipped decision. Weekly
  recommendations cannot edit search, ranking, profile, strategy, application,
  outcome, or Apply Points state.

## Data integrity and concurrency

- One normalized OnlineJobs.ph identity is used for active rows, Archive, discovery deduplication, evaluation/generation claims, review actions, and rediscovery prevention.
- Append-only `ProcessingClaims` records arbitrate overlapping discovery, evaluation, generation, and archive executions. The earliest non-expired Sheet row wins each identity/stage lease.
- Generator claim acquisition matches a `state_guard` derived from identity, pipeline state, application decision, and outcome. Final evaluation/generation commits match the winning `processing_commit_guard` and clear the active processing fields atomically.
- Reviewer actions replace the guard/token ownership boundary, so stale automation cannot overwrite a manual decision.
- Application-time score, confidence, recommendation, pack, strategy, and
  posting-age context is frozen on the first valid application decision.
  Cumulative stable-ID outcome events preserve progressive milestones and
  corrections across active/archive overlap.
- Archive planning captures the complete supported source snapshot. Source deletion requires a current identity/state match, a complete Archive copy, and bottom-up row deletion.
- Retryable failures remain active. Archive upsert and delete failures are idempotently recoverable without losing the active record or creating a second canonical history row.
- Legacy rows are normalized by canonical URL, preserve existing messages/decisions/outcomes, and receive explicit legacy profile versions. The additive Sheet migration stops on duplicate canonical identities instead of choosing a destructive winner.
- Analytics chooses the earliest immutable application snapshot when
  recoverable overlap conflicts, unions cumulative outcome/provenance evidence,
  and exposes the conflict. It never feeds current mutable rank values back
  into historical application cohorts.
- Analytics and recommendation detail is written before complete metadata.
  Expected row counts and version/window checks prevent partial refreshes from
  replacing the latest identifiable complete report. Recommendation attempts
  are versioned while repeats within one execution remain idempotent.
- Google Sheets compare keys (`state_guard` and `processing_commit_guard`) are placed in the first 26 physical record columns, matching the configured A:Z update range. The current n8n Sheets schema check requires configured fields to exist but does not require saved schema order to equal physical header order.

## Operational readiness

- `npm run build` deterministically regenerates all seven workflow exports and
  the Apps Script artifact.
- `npm run validate` fails on generated-artifact drift and exercises the
  profile/schema contract, discovery, dual ranking, instruction extraction and
  proof selection, message validation, claims, alerts, review telemetry,
  cumulative outcomes, analytics, recommendations, archive confirmation, Sheet
  migration, workflow structure, documentation, and a full synthetic lifecycle.
- Every workflow export is disabled. Repository validation performs no OnlineJobs.ph, Google Sheets, Groq, n8n, deployment, or application-submission call.
- The runbook requires a timestamped Sheet/workflow backup, migration on a
  workbook copy, credential rebinding, disabled smoke executions, hand-checked
  analytics/recommendations, count reconciliation, old-writer shutdown, ordered
  activation, production observation, recommender-only disablement, and
  preservation-first rollback. The version cutover inventories all seven roles
  before and after activation, restarts n8n to clear cached registrations, and
  rejects any older active copy. Future automatic calibration is an explicit
  separate approval gate.

## Findings resolved during review

| Finding | Resolution |
| --- | --- |
| Clearing a claim by canonical ID could erase a newer execution's claim. | Removed the separate canonical-ID claim-clear writes; winning-token commits own release. |
| A generated numeric claim could be accepted merely because it appeared in the job description. | Numeric evidence now comes only from the canonical candidate profile. |
| An arbitrary URL could reach detail enrichment. | Canonical URL validation now restricts host, path, protocol, port, and credentials. |
| An active row changed after archive planning could still be deleted. | Archive deletion now compares current source state with the planned source snapshot. |
| Concurrent discovery runs could append the same job. | Discovery now uses the shared append-only claim arbitration before insert. |
| Retry timing could overlap an active lease. | External-request retry bounds and state retry backoff are explicit and remain inside the configured lease ownership model. |
| Unsupported manual actions could expose their raw content in logs. | Review failure logging now records a generic unsupported-action marker. |
| Google Sheets match keys outside A:Z would make configured updates unreliable. | Physical review ordering places both compare-and-set keys within A:Z and hides them from normal review. |
| Apply Points recommendations could be mistaken for qualification or authority to spend. | They are bounded advisory categories only; actual points require controlled manual input and no workflow can submit or spend. |
| An instruction-aware prompt could obey employer prompt injection or invent unsupported evidence. | Deterministic extraction removes unsafe instructions, proof references resolve to approved profile evidence, and the message still passes existing factual validation. |
| A provider timeout or success followed by a failed Sheet acknowledgement could duplicate an alert. | Delivery enters `sending`; ambiguous/stale delivery becomes terminal without blind resend, while confirmed success is deduplicated by canonical identity and policy version. |
| Copying the Slack webhook URL into an n8n item could expose a credential in execution data. | The HTTP node references the environment variable directly; item data and logs never contain the webhook URL. |
| Worst-case alert content could truncate one or more required action links. | Action URLs are bounded, invalid source URLs are ineligible, and the renderer trims context while preserving the complete three-link tail. |
| Mutable scores or latest-only outcomes could contaminate conversion history. | First application freezes context and append-safe events preserve milestones; analytics consumes the immutable snapshot and explicit event union. |
| Contract-invalid application snapshots or malformed legacy arrays could bias conversion, point-efficiency, or blocker metrics. | Invalid values stay unknown, malformed arrays reduce disclosed coverage, and data-quality rows identify excluded evidence. |
| Discovery volume or sparse observational cohorts could drive self-reinforcing policy edits. | Volume is separate from conversion, sample/coverage gates force abstention, caveats remain stored, and the recommender has no configuration write path. |
| Partial or tampered analytic/recommendation detail could appear current. | Analytics publication confirms exact physical detail; the weekly consumer independently requires unambiguous metadata, exact sequential identities and row metadata, and a matching SHA-256 content identity. Non-empty sources without a valid complete report fail, and failed/partial attempts retain the prior complete report. |

## Residual release gates

No live n8n, Google Sheets, Groq, Slack, OnlineJobs.ph, or production smoke
execution was performed as part of the repository change. Those steps require
target-environment credentials and/or mutate external data, so they remain
explicit pre-activation gates in `docs/operations.md`. A failed gate must leave
the new workflows inactive and trigger the documented preservation-first
rollback. Repository evidence supports disabled import and non-production
verification; it does not claim production conversion improvement.
