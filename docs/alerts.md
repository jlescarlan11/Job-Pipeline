# Slack alerts

The Alerter & Mover sends a Slack notification only for a current `ready_to_apply` `To Apply` row with:

- no pending user action;
- `application_pack_status=ready`;
- `message_validation_status=valid`;
- current candidate, application-policy, and pack-policy versions;
- a message that passes deterministic content validation again.

The alert includes job and company context, qualification/opportunity/confidence, the decision reason, gaps, application instructions, questions, proofs, warnings, and the exact stored generated message inside one Slack code block. The live smoke check compares the code-block contents byte-for-byte with the Sheet value.

Both links are non-mutating:

- `Open To Apply` opens the configured HTTPS Google Sheet at the `To Apply` tab.
- `Open OnlineJobs.ph` opens the normalized canonical source URL.

There are no Approve, Deny, Skip, Apply, or state-changing webhook links. The user copies the message, submits manually, and records `I Applied` in `To Apply`.

The Alerter & Mover never submits an application.

Before loading candidate/application context, Alerter & Mover batch-reads all five business stores and performs a persisted-field preselection. With no outcomes, moves, or potential alerts it emits `no_eligible_work` with store/status counts and makes no Configuration or Slack request. Configuration is retrieved through one batch request only for potential alert work. Movement confirmation and latest-first sorting are restricted to stores touched by that execution.

The idempotency key is derived from canonical job identity, alert policy version, generation timestamp, and a message digest. Before the source row enters `sending`, the workflow appends a scoped `_System` claim and only the earliest unexpired row may continue. The winning claim token is also persisted in `To Apply` and must match at render and result commit.

The durable-receipt contract uses that exact idempotency key as the receipt identity in the instance-local `Job Pipeline Alert Receipts` n8n Data Table. Its only persisted fields are bounded identity, status, attempt, provider classification/reference, sanitized error, execution, version, and timestamp metadata. Complete generated messages, job descriptions, profile context, provider responses, webhook URLs, credentials, and authorization values are not receipt fields.

The allowed lifecycle is `pending → sending → delivered → reconciled`. A definite provider rejection becomes a bounded `retryable_rejection` or `terminal_rejection`; an unknown post-send result becomes `terminal_ambiguity` and has no automatic transition back to pending. Transitions compare the receipt version, reread durable state, and fail closed on duplicate identities. A delivered receipt can reconcile the same alert key into its single current owner in `To Apply`, `Applied Jobs`, or `Archive` without producing another provider-send instruction. Legacy records without a receipt remain valid and are not automatically re-alerted.

The Data Table closes the observed Slack-success/Sheet-failure gap, but it cannot make an incoming webhook perfectly exactly-once: a process loss after Slack accepts the request and before the delivered receipt is durably confirmed remains ambiguous and terminal. Receipt-store backup and restore validation are therefore required before activation or recovery.

A recorded success is not replayed. Rate limits and 5xx responses retry within the configured cap. A request timeout is terminal because Slack delivery is ambiguous and an automatic retry could duplicate the notification. A `sending` row whose claim lease expires is also converted to terminal `ambiguous_delivery` state without another provider request.

Alert claims and result commits reread `To Apply` and reject a changed version, state guard, claim token, status, or action. Slack webhook responses are accepted as full text responses so the normal webhook `ok` body does not fail JSON parsing. Diagnostic summaries redact URLs, authorization values, tokens, and control characters.

Movement completes its copy-confirm-delete attempts before the workflow rereads `To Apply` for alert selection. Movement and Slack writes use independent bounded result paths, so one failed move or provider request does not cancel unrelated rows. Rows in `Scraped Jobs` or `To Review` are never alert candidates.

The remaining real-provider copy-fidelity gate is described in `docs/operations.md`. Repository tests prove renderer fidelity with fixtures; they do not claim an authorized Slack workspace accepted a message.
