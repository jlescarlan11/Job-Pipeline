# Slack alerts

The Alerter & Mover sends the full copy-ready Slack notification only for a current `ready_to_apply` `To Apply` row with:

- no pending user action;
- `prep_status=message_ready` with a positive `preparation_version` and current `preparation_input_guard`;
- `application_pack_status=ready`;
- `message_validation_status=valid`;
- current candidate, application-policy, pack-policy, coverage-contract, and
  message-plan versions;
- bounded coverage and exactly one persisted message plan whose canonical
  proof references resolve against the current profile;
- a pack with no unresolved or forged mandatory coverage and a message that
  passes the same deterministic plan, grounding, and content validation again.

Legacy, missing, malformed, stale, unsupported, or forged coverage/plan state
is not copy-ready. It remains identifiable for guarded preparation in To Apply
and is never returned to review merely because the message is incomplete.

`needs_input` and `external_steps` can emit only a bounded action reminder. The reminder contains the job title, sanitized `required_input` checklist, and open-only links; it never includes the stored message or full job description and says explicitly that no application was submitted. `pending`, `preparing`, `repair_pending`, and `preparation_error` do not alert. An unchanged paused row is not repeatedly reminded on every schedule.

The alert includes job and company context, qualification/opportunity/confidence, the decision reason, gaps, application instructions, questions, proofs, warnings, and the exact stored generated message inside one Slack code block. The live smoke check compares the code-block contents byte-for-byte with the Sheet value.

Both links are non-mutating:

- `Open To Apply` opens the configured HTTPS Google Sheet at the `To Apply` tab.
- `Open OnlineJobs.ph` opens the normalized canonical source URL.

There are no Proceed, Reject, Skip, Apply, or state-changing webhook links. The user copies the message, submits manually, and records `I Applied` in `To Apply`.

The Alerter & Mover never submits an application.

Before loading candidate/application context, Alerter & Mover batch-reads all five business stores and performs a persisted-field preselection. With no outcomes, moves, or potential alerts it emits `no_eligible_work` with store/status counts and makes no Configuration or Slack request. Configuration is retrieved through one batch request only for potential alert work. Movement confirmation and latest-first sorting are restricted to stores touched by that execution.

The idempotency key is derived from canonical identity, notification category, alert policy, preparation version/input guard, and a message or checklist digest. A transition from a reminder to a later copy-ready state therefore receives a different receipt key, while an unchanged state cannot replay. Before the source row enters `sending`, the workflow appends a scoped `_System` claim and only the earliest unexpired row may continue. The winning claim token is also persisted in `To Apply` and must match at render and result commit.

The durable-receipt contract uses that exact idempotency key as the receipt identity in the instance-local `Job Pipeline Alert Receipts` n8n Data Table. Its only persisted fields are bounded identity, status, attempt, provider classification/reference, sanitized error, execution, version, and timestamp metadata. Complete generated messages, job descriptions, profile context, provider responses, webhook URLs, credentials, and authorization values are not receipt fields.

The allowed lifecycle is `pending → sending → delivered → reconciled`. A definite provider rejection becomes a bounded `retryable_rejection` or `terminal_rejection`; an unknown post-send result becomes `terminal_ambiguity` and has no automatic transition back to pending. Transitions compare the receipt version, reread durable state, and fail closed on duplicate identities. On every run, receipt recovery happens before movement or new-alert selection. It first terminalizes an expired durable `sending` receipt, then reconciles provider outcomes into the alert key's single current owner in `To Apply`, `Applied Jobs`, or `Archive` without producing another provider-send instruction. Any recovery work, active send, duplicate, invalid row, or unavailable receipt store blocks new Slack work for that execution but does not block outcomes or movement. Legacy records without a receipt remain valid and are not automatically re-alerted.

For a new attempt, the workflow persists and rereads `pending`, compare-and-swaps and rereads `sending`, persists the matching Sheet claim, rereads `To Apply`, and rechecks execution headroom before Slack. If the pre-provider guard or headroom recheck fails, the unattempted receipt becomes bounded retryable/terminal state and is reconciled without Slack. A Slack response is classified and compare-and-swapped into the receipt before any final business-sheet update. If that post-send receipt write cannot be proven, the workflow attempts a terminal-ambiguity compare-and-swap and writes terminal business state even when receipt durability remains uncertain. This deliberately prefers a missed alert over a duplicate.

The Data Table closes the observed Slack-success/Sheet-failure gap, but it cannot make an incoming webhook perfectly exactly-once: a process loss after Slack accepts the request and before the delivered receipt is durably confirmed remains ambiguous and terminal. Receipt-store backup and restore validation are therefore required before activation or recovery.

A recorded success is not replayed. Definite Slack rate limits and 5xx responses become a bounded retryable receipt; Slack itself is not automatically replayed inside the same execution. A request timeout is terminal because Slack delivery is ambiguous and an automatic retry could duplicate the notification. A `sending` row whose claim lease expires is also converted to terminal `ambiguous_delivery` state without another provider request.

Alert claims and result commits reread `To Apply` and reject a changed version, state guard, claim token, status, or action. Slack webhook responses are accepted as full text responses so the normal webhook `ok` body does not fail JSON parsing. Diagnostic summaries redact URLs, authorization values, tokens, and control characters.

Movement completes its copy-confirm-delete attempts before the workflow rereads `To Apply` for alert selection. Movement and Slack writes use independent bounded result paths, so one failed move or provider request does not cancel unrelated rows. Rows in `Scraped Jobs` or `To Review` are never alert candidates.

The initial Alerter & Mover five-store snapshot may retry once through an explicit 65-second Wait node. Later Google Sheets reads have no in-execution automatic retry: if they fail, the current phase fails closed and the next 15-minute run performs recovery. This avoids n8n's runtime cap silently turning a configured 65-second retry into five-second quota pressure. The 300-second execution reserves at least 150 seconds before receipt/provider commit work. A full movement-plus-alert path uses at most ten Google Sheets read requests; a movement-plus-recovery path uses at most six. The final sanitized summary reports store/status and preparation-state counts, proceeded/rejected/applied/skipped moves, repeated-case suppressions, partial recoveries, copy-ready/reminder categories, delivery/reconciliation classes, Sheet reads, quota retries, provider failures, and bounded errors.

The remaining real-provider copy-fidelity gate is described in `docs/operations.md`. Repository tests prove renderer fidelity with fixtures; they do not claim an authorized Slack workspace accepted a message.
