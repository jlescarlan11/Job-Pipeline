# Review approval loop fix — 2026-08-01

## Problem

`Approve` returned a `review_needed` row to generation, but the application-pack
builder recreated the same review warning from the unchanged job description.
The generator cleared the consumed action and the mover returned the row to
`To Review`. Because reviewer notes did not resolve pack warnings, repeated
approval could never advance affected rows.

The question extractor also classified every sentence ending in `?` as a
screening question, including rhetorical section headings such as
`What to expect?`.

## Corrected contract

- Only candidate-directed questions containing `you` or `your` are extracted;
  known rhetorical headings are excluded.
- A persisted `Approve` plus `review_approved_at` acknowledges only warning
  codes explicitly allow-listed in `config/application-pack-policy.json`.
- Acknowledged profile-answerable questions remain in the record with
  `answer_status=answer_in_message` and are included in the next initial and
  repair prompts. Sensitive commitment questions remain
  `manual_submission_required` and appear in Slack/Sheet context.
- Required external actions, unsupported evidence, and rejected unsafe
  instructions may become sanitized manual reminders after approval; unsafe
  source text remains excluded from the provider prompt.
- A ready row carries a visible system-owned `required_input` reminder in `To
  Apply` only for sensitive questions or other manual follow-up. Questions
  assigned to generation are omitted after a successful message. The workflow
  does not overwrite the user-owned `notes` column.
- An unavailable or insufficient description is never acknowledgeable and
  becomes `unavailable` instead of returning to review. Message validation,
  proof provenance, instruction sanitization, and stale-write protection remain
  fail-closed.

## Deployment requirements

1. Build and validate the repository artifacts.
2. Update the existing Evaluator & Generator and Alerter & Mover workflows in
   place; both embed the versioned pack policy, so deploying only one would
   make new ready rows fail the shared alert-safety gate. Do not create a
   duplicate active workflow.
3. Keep both workflows' existing schedules, timezones, timeouts, environment
   bindings, and active states.
4. Install the rebuilt `google-apps-script/SheetSetup.gs` in the Main workbook
   and rerun `setupFreshJobPipeline()` once to reveal the system-owned
   `required_input` column in `To Apply`; setup preserves existing rows and
   user notes.
5. Because the application-pack policy/version changed, drain or regenerate
   any pre-existing unsent `To Apply` rows before activation; old pack versions
   intentionally fail the current message-safety gate.
6. After activation, select `Approve` once for the affected rows. Under the
   configured schedules, movement can take up to 15 minutes, generation up to
   90 minutes, and the final move up to another 15 minutes.
7. Verify the row reaches `To Apply`, retains its screening-question audit
   context, includes the answers in `generated_message`, omits answered
   questions from `required_input`, and receives at most one Slack alert.
