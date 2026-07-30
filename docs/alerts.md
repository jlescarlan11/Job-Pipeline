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

The idempotency key is derived from canonical job identity, alert policy version, generation timestamp, and a message digest. Before the source row enters `sending`, the workflow appends a scoped `_System` claim and only the earliest unexpired row may continue. The winning claim token is also persisted in Review Queue and must match at render and result commit.

A recorded success is not replayed. Rate limits and 5xx responses retry within the configured cap. A request timeout is terminal because Slack delivery is ambiguous and an automatic retry could duplicate the notification. A `sending` row whose claim lease expires is also converted to terminal `ambiguous_delivery` state without another provider request.

Alert claims and result commits reread Review Queue and reject a changed version, state guard, claim token, status, or action. Slack webhook responses are accepted as full text responses so the normal webhook `ok` body does not fail JSON parsing. Diagnostic summaries redact URLs, authorization values, tokens, and control characters.

Movement completes its copy-confirm-delete attempts before the workflow rereads Review Queue for alert selection. Movement and Slack writes use independent bounded result paths, so one failed move or provider request does not cancel unrelated rows.

The remaining real-provider copy-fidelity gate is described in `docs/operations.md`. Repository tests prove renderer fidelity with fixtures; they do not claim an authorized Slack workspace accepted a message.
