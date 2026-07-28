# Final engineering review

Review date: 2026-07-28

Scope: the versioned profile and policy, pipeline contracts, four generated n8n exports, Google Sheets setup artifact, deterministic tests, and migration/operations documentation introduced for GitHub issues #1–#6.

## Result

The repository implementation is ready for disabled import and non-production smoke testing. All checked-in workflows remain inactive, default validation is offline, and application submission remains a manual candidate action. Production activation is intentionally gated by the backup, migration, rebinding, smoke, and old-writer shutdown procedure in `docs/operations.md`.

## Security and privacy

- The repository-wide secret scan found no API keys, bearer tokens, or private keys. Workflow exports retain n8n credential and Sheet references only; operators must rebind them to the target environment.
- Discovery URL normalization accepts only HTTPS OnlineJobs.ph job-detail URLs, rejects credentials and alternate ports, and removes queries/fragments before any fetch.
- Job titles, descriptions, and employer formatting are treated as untrusted prompt data. They cannot override the candidate profile, application policy, URL/project allowlists, validation, or manual-submission boundary.
- Generated-message validation rejects unsupported projects, technologies, numbers, URLs, phone numbers, banned phrases, empty output, and output above the configured word limit.
- Logged external errors are length-limited and redact URLs, tokens, authorization values, and API-key-like assignments. Unsupported reviewer input is logged generically instead of echoing its value.
- Only approved public candidate links are present in the profile. Credentials, raw provider responses, complete job descriptions, and full profile contents are excluded from the operations evidence log.
- No workflow contains an application-submit endpoint or automatically sets an applied/skipped decision.

## Data integrity and concurrency

- One normalized OnlineJobs.ph identity is used for active rows, Archive, discovery deduplication, evaluation/generation claims, review actions, and rediscovery prevention.
- Append-only `ProcessingClaims` records arbitrate overlapping discovery, evaluation, generation, and archive executions. The earliest non-expired Sheet row wins each identity/stage lease.
- Generator claim acquisition matches a `state_guard` derived from identity, pipeline state, application decision, and outcome. Final evaluation/generation commits match the winning `processing_token`.
- Reviewer actions replace the guard/token ownership boundary, so stale automation cannot overwrite a manual decision.
- Archive planning captures the complete supported source snapshot. Source deletion requires a current identity/state match, a complete Archive copy, and bottom-up row deletion.
- Retryable failures remain active. Archive upsert and delete failures are idempotently recoverable without losing the active record or creating a second canonical history row.
- Legacy rows are normalized by canonical URL, preserve existing messages/decisions/outcomes, and receive explicit legacy profile versions. The additive Sheet migration stops on duplicate canonical identities instead of choosing a destructive winner.
- Google Sheets compare keys (`state_guard` and `processing_token`) are placed in the first 26 physical record columns, matching the configured A:Z update range. The current n8n Sheets schema check requires configured fields to exist but does not require saved schema order to equal physical header order.

## Operational readiness

- `npm run build` deterministically regenerates all four workflow exports and the Apps Script artifact.
- `npm run validate` fails on generated-artifact drift and exercises the profile/schema contract, discovery, evaluation, message validation, claims, review actions, archive confirmation, Sheet migration, workflow structure, documentation, and a full synthetic lifecycle.
- Every workflow export is disabled. Repository validation performs no OnlineJobs.ph, Google Sheets, Groq, n8n, deployment, or application-submission call.
- The runbook requires a timestamped Sheet/workflow backup, migration on a workbook copy, credential rebinding, disabled smoke executions, count reconciliation, old-writer shutdown, ordered activation, production observation, and preservation-first rollback.

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

## Residual release gates

No live n8n/Google Sheets/Groq smoke execution or production activation was performed as part of the repository change. Those steps require target-environment credentials and mutate external data, so they remain explicit pre-activation gates in `docs/operations.md`. A failed gate must leave the new workflows inactive and trigger the documented preservation-first rollback.
