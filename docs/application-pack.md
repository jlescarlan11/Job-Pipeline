# Instruction-aware application packs

`config/application-pack-policy.json` versions deterministic instruction
extraction, proof selection, limits, and unsafe-instruction categories. The
canonical candidate profile and application policy remain the only sources of
candidate facts and writing permissions.

## Pack contents

Each successfully generated pack persists:

- instructions classified as `subject`, `format`, `submission`, `attachment`,
  `test`, or `evidence`;
- screening questions, each marked for manual review;
- at most three relevant `experience:<id>` or `projects:<id>` proof references;
- sanitized unresolved warnings;
- the validated application message;
- pack, profile, application-policy, and pack-policy versions and timestamp.

Instruction and question text is bounded before it reaches a prompt or Sheet
cell. Proof details are resolved from the canonical profile for prompt
generation; only references are persisted with the job.

## Readiness

`ready` means the message passed existing deterministic validation and the pack
has no unresolved extraction warning. `review_required` means the candidate
must interpret an ambiguous instruction, answer a screening question, resolve
conflicting subject requirements, inspect truncated input, or accept a proof
shortfall. `blocked` means a required attachment/test or unsupported evidence
cannot be completed by the pipeline, the posting is unavailable/insufficient,
or an unsafe instruction was rejected.

A generation commit can enter lifecycle `ready` only when the pack status is
also `ready` and the persisted message passes the current shared content and
provenance gate. A `review_required` or `blocked` pack remains non-copyable and
cannot be marked applied or alerted. The candidate remains responsible for
questions, attachments, tests, external navigation, submission, and Apply
Points.

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
