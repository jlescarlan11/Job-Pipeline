# Disabled Groq-to-Slack smoke evidence — 2026-07-28

This is the sanitized release evidence for issue #20. The test used only
inactive disposable workflow imports, a copied workbook, the configured Groq
test credential, and the approved Slack test incoming webhook. It did not
publish a workflow, enable a schedule, submit an application, or write a
credential, webhook, full job description, generated application message, or
raw provider response into this repository.

## Preflight and isolation

- Source workbook: the operator-supplied `Job Applications Pipeline`.
- Post-migration backup/copy:
  `Job Applications Pipeline — remediation smoke copy 2026-07-28`.
- Dedicated smoke workbook:
  `Job Applications Pipeline — issue20 Groq Slack smoke 2026-07-28`.
- Full Drive IDs are retained in the private operator context and deliberately
  omitted from this public repository.
- The backup/copy retained 17 active identities and an Archive last-row count
  of 920. All 17 active identities and 916 nonblank Archive identities were
  unique, with no active/Archive overlap.
- Raw Google Sheets cell reads on the migrated copy returned
  `profile_version=2026-07-28` as strings for the five affected records.
  Applicable version columns had `TEXT`/`@` formatting.
- The five confirmed terminal orphan claims had blank
  `processing_token`, `processing_stage`, and `processing_started_at`.
- All eight confirmed unsafe active messages were quarantined before the
  integration run: dispatch text was blank, validation was `quarantined`,
  alert state was `not_eligible`, and application decisions/outcomes were
  unchanged.
- The PHP currency, mandatory-PHP, supported-alternative, unsatisfied-group,
  and independent-list regression fixtures passed before live integration.
- Existing ranking and alert thresholds, candidate facts, and application,
  pack, message, and alert policy versions were not changed for the smoke.
- The dedicated workbook was cleared only on `Sheet1` and
  `ProcessingClaims`, then seeded with two evaluation controls and one
  quarantined alert control. Its pre-run state was 3 active/3 unique
  identities, 2 `discovered`, 1 `ready`, 1 non-empty disposable control
  message, 0 application decisions, 0 outcomes, the unchanged Archive cohort,
  and no active/Archive overlap.
- Disposable generator `NJA9WO_rDNbogzne` and alerter
  `J9GwORbDXOPcmpiL` were rebound only to the dedicated workbook. Their
  Schedule Trigger nodes were replaced in the disposable imports by Manual
  Trigger nodes. Stored `active=0` and workbook bindings were rechecked before
  execution; checked-in exports retained their real schedules and
  `active=false`.

## Sanitized execution evidence

| Execution | Workflow | Observable result |
| --- | --- | --- |
| `3780` | Generator | Read the disposable controls; the positive record evaluated `recommended` at 80/80 and the mandatory-PHP control became `not_recommended`. Groq runs: 0. Both terminal evaluation rows cleared active claim fields. |
| `3783` | Generator | Groq ran once. The deterministic validator rejected the response for an unsupported numeric claim and a banned phrase; the row became a sanitized retryable generation error with cleared active claim fields. |
| `3784` | Generator | A repeated generation claim lost to the prior unexpired append-only lease. Groq runs: 0. |
| `3785` | Alerter | Pre-provider runtime failure exposed a missing persisted-message-safety bundle in the generated Code node. Slack runs: 0. |
| `3786` | Alerter | After the bundle fix, the quarantined control committed `not_eligible` with `pack_not_ready,message_quarantined`. Slack runs/deliveries: 0; active claim fields were blank. |
| `3787` | Generator | Natural retry after lease expiry invoked Groq once, passed `validateGeneratedMessage` and `validateApplicationPack`, and committed a current `ready` message/pack with `alert_status=pending` and blank active claim fields. |
| `3788` | Alerter | CLI environment access was denied before the provider node. Slack runs/deliveries: 0. The stale `sending` state was retained for the normal no-blind-resend recovery path. |
| `3789` | Generator | A first replacement fixture evaluated below the alert qualification boundary (69/74); Groq runs: 0. The fixture was not promoted and no score was manually overridden. |
| `3790` | Generator | The final positive fixture naturally evaluated `recommended` at 80/80, medium confidence, with no requirement gaps; Groq runs: 0. |
| `3791` | Generator | Groq ran once and returned a non-empty result. Both deterministic validators passed. The row committed `ready`/`valid`/pack `ready`, current provenance, `alert_status=pending`, and blank active claim fields. |
| `3792` | Alerter | Slack rejected the request with sanitized `400 invalid_payload`; delivery was not counted as success. Runtime inspection found the generated HTTP node had inherited the default GET method. The builder was fixed to require POST, and regression coverage now asserts it. |
| `3793` | Alerter | The corrected POST reached the approved Slack test webhook once and received HTTP 200. n8n raw-body response mode serialized its response stream, so the finalizer initially misclassified the acknowledgement. No resend was attempted; the unambiguous 200 acknowledgement was reconciled to `sent`, and the export was switched to JSON-body mode. |
| `3794` | Alerter | Immediate repeat selected zero candidates and did not execute the Slack node. The sent row and its policy-scoped idempotency key were unchanged. |
| `3795` | Local transport probe | The final JSON-body HTTP configuration sent one local POST with `application/json` and exactly one `text` field. n8n returned bounded `statusCode=200` and `data=ok`; no external provider was called. |

The final positive record used unique identity `onlinejobs.ph:990005`, an
approved OnlineJobs.ph source URL, a recent `posted_at`, complete ranking
inputs, and an evidence-supported description. It reached 80 qualification,
80 opportunity, medium confidence, no requirement gaps, and a ready pack
without editing scores, confidence, gaps, pack status, or freshness.

The generated result contained 216 words and three approved public candidate
URLs. The shared persisted-message gate returned `safe=true`; the result had
no obsolete Netlify URL and no configured banned phrase. Raw cell inspection
confirmed current profile, scoring, message-policy, and pack provenance were
stored as strings in plain-text version columns.

## Runtime findings and recovery

The smoke found and fixed two export defects that deterministic tests alone had
not exposed:

1. The generator, reviewer, and alerter Code-node bundles did not all include
   the shared persisted-message-safety implementation. The builder now embeds
   the implementation and its deterministic validators in every direct
   consumer; export tests assert the definitions are present.
2. The Slack HTTP node did not specify `method=POST`, so n8n used its default
   method and Slack returned `invalid_payload`. After POST was added, n8n's raw
   request-body mode serialized the text response stream instead of returning
   a bounded acknowledgement string. The builder now emits POST with n8n's
   JSON-body mode, reads nested error status codes, and the workflow export
   test asserts the transport contract. Local execution `3795` exercised that
   final n8n transport shape without creating another Slack notification.

The first CLI alert attempt also showed that n8n blocks `$env` access in nodes
unless the runner explicitly permits it. The approved webhook/review
configuration was exposed only to the isolated CLI process with
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`; values were never printed or persisted in
workflow JSON.

A separate operational check found that importing `active=false` through the
n8n CLI does not necessarily deregister schedules cached by an already-running
n8n process. The process was stopped before live integration, database state
was confirmed to contain zero active workflows, and the runbook now requires
both stored-state and runtime-registration checks.

## Final reconciliation

The dedicated workbook ended with 5 active/5 unique disposable identities:
3 `ready`, 1 `not_recommended`, and 1 `discovered`. It contained 3 non-empty
disposable messages, 0 application decisions, and 0 outcomes. All five durable
rows had blank active processing token/stage/start fields. The Archive cohort
retained a last-row count of 920 and 916 nonblank unique identities;
none of the five disposable identities appeared in Archive.

The source workbook still had its original 17 unique active identities and
the original status distribution: 8 `ready`, 4 `discovered`,
3 `not_recommended`, and 2 `review_required`. It retained the original 8
legacy messages and 5 reported orphan tokens, contained no disposable
`onlinejobs.ph:99000*` identity, and had no application decision or outcome.
The smoke therefore introduced no source-workbook change.

Expired `ProcessingClaims` rows remain append-only audit history. Completed job
rows must have blank `processing_token`, `processing_stage`, and
`processing_started_at`; the non-active `processing_commit_guard` may remain
as the guarded commit sentinel. No row became `applied` or `skipped`, no
application decision/outcome was created, and no application-submit endpoint
was called.

All stored checked-in and disposable workflows remained `active=false`
throughout the run. A long-running n8n process initially retained pre-existing
cached schedule registrations despite that database state; it was stopped
before live integration. The service was restarted only after its database
contained zero active workflows, and a post-restart execution-history
observation across 71 seconds confirmed that no cached one-minute schedule
resumed (`MAX(execution_id)` remained `3794` during the observation). The
subsequent `3795` execution was the explicitly manual local-only transport
probe. The original non-smoke review configuration and webhook environment
were restored without printing either value.
