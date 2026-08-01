# Instruction-aware application packs

`config/application-pack-policy.json` versions deterministic instruction
extraction, proof selection, limits, and unsafe-instruction categories. The
frozen six-tab candidate context plus `Application Settings`, `Required Style`,
and `Banned Phrases` remain the only runtime sources of candidate facts and
editable writing permissions. Repository
policies retain non-editable extraction and safety bounds.

## Pack contents

Each successfully generated pack persists:

- instructions classified as `subject`, `format`, `submission`, `attachment`,
  `test`, or `evidence`;
- screening questions marked for review, for an approved answer in the next
  generated message, or for manual completion when they request sensitive
  commitments such as salary, availability, schedules, or start dates;
- at most three relevant `experience:<id>` or `projects:<id>` proof references;
- sanitized warnings with explicit unresolved or acknowledged state;
- the validated application message;
- pack, profile, application-policy, and pack-policy versions and timestamp.

Instruction and question text is bounded before it reaches a prompt or Sheet
cell. Proof details are resolved from the canonical profile for prompt
generation; only references are persisted with the job.

## Readiness

The pack statuses are internal safety results. `ready` means the message passed
deterministic validation and the pack has no unresolved extraction warning.
It may retain review warnings and screening questions only when each carries a
persisted review acknowledgment tied to `review_approved_at`. Profile-answerable
questions become `answer_in_message` and are supplied to both the initial and
repair prompts. Sensitive commitment questions remain
`manual_submission_required` and are shown in the application context.
Message validation requires every `answer_in_message` item to be woven into
natural first-person prose and rejects Markdown or `Question:`/`Answer:` labels,
so an otherwise valid draft cannot silently skip a required answer.
`review_required` means the candidate must interpret an ambiguous instruction,
answer a screening question, resolve conflicting subject requirements, inspect
truncated input, or accept a proof shortfall. Before approval, `blocked` marks a
required attachment/test, unsupported evidence, rejected unsafe instruction,
or unavailable/insufficient description.

A generation commit can enter visible lifecycle `ready_to_apply` only when the
pack status is `ready` and the persisted message passes the current shared
content and provenance gate. Internal `review_required` maps to
`review_needed`. `Approve` may acknowledge only warning codes explicitly listed
by `review_approval.acknowledgeable_warning_codes`. Acknowledged unsafe
instructions remain excluded from the provider prompt. Answerable questions
must be addressed from selected approved proofs; sensitive questions,
attachments, tests, and unsupported evidence become visible manual reminders.
An unavailable/insufficient description is not acknowledgeable and cannot
generate a message. The candidate remains responsible for every acknowledged
question, external action, and submission.

Question extraction requires candidate-directed language such as `you` or
`your` and excludes known rhetorical section headings. This prevents headings
such as `What to expect?` from creating an approval loop while retaining real
questions such as `What hourly rate are you seeking?`.

## Trust boundary

Job descriptions are untrusted. Instructions attempting policy bypass, hidden
configuration disclosure, private-data access, or automatic submission/point
spending are excluded from instructions and prompts. Durable warnings store
only a category and sanitized summary, never the malicious instruction text.

Normal regeneration is copy-on-success: extraction and the model response
remain transient until the guarded commit. Provider, validation, or commit
failure preserves the prior validated message and pack for retry. The one-time
confirmed unsafe legacy-message migration is different: it removes
dispatchable text before regeneration, stores sanitized quarantine evidence,
and fails closed until a current replacement commits.
