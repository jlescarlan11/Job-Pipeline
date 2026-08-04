# Instruction-aware application packs

`config/application-pack-policy.json` versions deterministic instruction
extraction, proof selection, limits, and unsafe-instruction categories. The
frozen six-tab candidate context plus `Application Settings`, `Required Style`,
and `Banned Phrases` remain the only runtime sources of candidate facts and
editable writing permissions. Repository
policies retain non-editable extraction and safety bounds.

## Pack contents

Each successfully generated pack persists:

- source-ordered instructions classified as `subject`, `format`, `content`,
  `submission`, `attachment`, `test`, or `evidence`, including inherited
  required scope, alternatives, and count constraints;
- screening questions marked for review, for an approved answer in the next
  generated message, or for manual completion when they request sensitive
  commitments such as salary, availability, schedules, or start dates;
- one coverage entry per mandatory requirement, classified as `exact`,
  `adjacent`, `partial`, `missing`, or `manual_action`, with bounded answer
  elements, canonical evidence references, and any material difference;
- one versioned message plan containing the exact resolved subject, required
  answer elements, proof references, transparent adjacent framing, approved
  URLs, formats, and manual actions;
- at most three relevant `experience:<id>` or `projects:<id>` proof references;
- sanitized warnings with explicit unresolved or acknowledged state;
- the validated application message;
- pack, coverage, message-plan, profile, application-policy, and pack-policy
  versions and timestamp.

Instruction and question text is bounded before it reaches a prompt or Sheet
cell. Proof details are resolved from the canonical profile for prompt
generation; only references are persisted with the job.

Extraction preserves semantic headings, list items, and line breaks from the
source HTML while collapsing decorative separators and source-formatting
noise. A required heading such as `Follow these steps exactly` scopes its
child items. Imperative prompts such as `Describe...`, `Provide...`, or
`Answer...` are
treated as candidate-directed questions, while responsibility statements and
rhetorical headings are not.

Coverage is deterministic and technology-agnostic. `exact` means the active
profile directly supports the requested fact. `adjacent` means approved
evidence is relevant but has a material difference that must be stated, such
as a Groq-based agentic workflow answering a Claude-workflow request.
`partial` and `missing` cannot become ready. `manual_action` records a required
external step or an allowed alternative such as supplying an approved project
URL. Exact evidence outranks adjacent evidence, and every reference resolves
back to the active canonical profile rather than duplicating candidate facts
inside the row.

## Readiness

The pack statuses are internal safety results. `ready` means the message passed
deterministic validation and the pack has no unresolved extraction warning.
It may retain review warnings and screening questions only when each carries a
persisted `Proceed` resolution tied to `review_case_id`, `review_decided_at`,
and the exact `review_approval_guard` digest of the requirements, coverage, plan, warnings,
proof references, and active versions reviewed. Profile-answerable
questions become `answer_in_message` and are supplied to both the initial and
repair prompts. Sensitive commitment questions remain
`manual_submission_required` and are shown in the application context.
Message validation requires every `answer_in_message` item to be woven into
natural first-person prose and rejects Markdown or `Question:`/`Answer:` labels,
so an otherwise valid draft cannot silently skip a required answer.
`review_required` means the candidate must interpret an ambiguous instruction,
answer a screening question, resolve conflicting subject requirements, approve
a transparent adjacent strategy, or accept a proof
shortfall. Partial or missing mandatory coverage is not acknowledgeable.
`blocked` marks extraction truncation or overflow, a durable JSON-budget
overflow, a required attachment/test/external form, unsupported evidence,
rejected unsafe instruction, no relevant approved candidate proof, or an
unavailable/insufficient description.
When detailed extracted state cannot fit the Sheet contract, the pipeline
persists a minimal `application_state_exceeds_persistence_limit` blocked pack
instead of attempting an oversized or silently incomplete write. Extraction
loss is never acknowledgeable.

Every material clause in a generated message must resolve to one fact unit in
one selected canonical proof. Separate clauses may cite separate proofs, but
tokens and metrics from multiple proofs or unrelated facts within one proof
cannot be recombined into a new accomplishment. Generic overlap cannot carry
an unsupported technology, domain, accomplishment, credential, or award.
Requested adjacent terms are permitted only in the same sentence as an
explicit difference qualifier. At least one substantive first-person ownership
statement is required; repeated project/tool fragments are not an answer.

A record enters To Apply immediately after a final `Proceed` decision, with
`ready_to_apply` ownership and `prep_status=pending`. Copy readiness is separate:
only a commit with a `ready` pack and a message that passes the shared content
and provenance gate may set `prep_status=message_ready`. Internal
`review_required` maps to `review_needed` only before final review. After
`Proceed`, answerable questions are prepared in place; sensitive candidate
choices become `needs_input`, and attachments, tests, or employer tasks become
`external_steps`. A proceeded record never returns to review solely because
preparation is incomplete. Unsafe instructions remain excluded from prompts.
An unavailable/insufficient description is not acknowledgeable and cannot
generate a message. The candidate remains responsible for every acknowledged
question, external action, and submission.

A `ready` pack must contain current coverage and message-plan versions, one
consistent plan entry per mandatory requirement, all required canonical proof
references, and no unresolved partial or missing mandatory coverage. Review
resolution may authorize only the recorded transparent adjacent strategy; it
cannot remove the material difference or authorize an unsupported claim.

Question extraction requires candidate-directed language such as `you` or
`your` and excludes known rhetorical section headings. This prevents headings
such as `What to expect?` from creating a review loop while retaining real
questions such as `What hourly rate are you seeking?`.

## Trust boundary

Job descriptions are untrusted. Instructions attempting policy bypass, hidden
configuration disclosure, private-data access, or automatic submission/point
spending are excluded from instructions and prompts, including markers split
across HTML/list/line boundaries. Invalid numeric HTML entities are replaced
without aborting the remaining job. Durable warnings store
only a category and sanitized summary, never the malicious instruction text.

The durable `requirement_coverage` and one-element
`application_message_plan` JSON arrays are system-owned and bounded by the
pipeline schema. Their versions and serialized values are part of the state
guard. A downstream consumer reconstructs the complete pack from the current
job description, profile, and policies, compares every persisted authorization
field with that canonical result, reconstructs proof text only from current
canonical references, and re-runs the message validator.
Absent, malformed, stale, unresolved, or forged state therefore suppresses an
unsent ready message before Slack or manual-application safety authorization.

Normal regeneration is copy-on-success while the old message and contract
remain one coherent unit: provider, validation, or commit failure preserves
that prior validated unit for retry. If new extraction determines that the
current contract is non-ready, the row persists the new review contract and
clears the now-incompatible message and message provenance. The one-time
confirmed unsafe legacy-message migration is different: it removes
dispatchable text before regeneration, stores sanitized quarantine evidence,
and fails closed until a current replacement commits.
