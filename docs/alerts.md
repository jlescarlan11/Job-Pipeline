# Slack alerts

The Alerter & Mover sends a Slack notification only for a current `ready_to_apply` Review Queue row with:

- no pending user action;
- `application_pack_status=ready`;
- `message_validation_status=valid`;
- current candidate, application-policy, and pack-policy versions;
- a message that passes deterministic content validation again.

The alert includes job and company context, qualification/opportunity/confidence, the decision reason, gaps, application instructions, questions, proofs, warnings, and the exact stored generated message inside one Slack code block. The live smoke check compares the code-block contents byte-for-byte with the Sheet value.

Both links are non-mutating:

- `Open Review Queue` opens the configured HTTPS Google Sheet.
- `Open OnlineJobs.ph` opens the normalized canonical source URL.

There are no Approve, Deny, Skip, Apply, or state-changing webhook links. The user copies the message, submits manually, and records `I Applied` in Review Queue.

The Alerter & Mover never submits an application.

The idempotency key is derived from canonical job identity, alert policy version, generation timestamp, and a message digest. A recorded success is not replayed. Rate limits and 5xx responses retry within the configured cap. A request timeout is terminal because Slack delivery is ambiguous and an automatic retry could duplicate the notification.

Alert claims and result commits reread Review Queue and reject a changed version, state guard, status, or action. Diagnostic summaries redact URLs, authorization values, tokens, and control characters.

Movement is planned on an independent workflow branch before Slack delivery, so Slack rejection or timeout cannot cancel an otherwise valid terminal move.

The remaining real-provider copy-fidelity gate is described in `docs/operations.md`. Repository tests prove renderer fidelity with fixtures; they do not claim an authorized Slack workspace accepted a message.
