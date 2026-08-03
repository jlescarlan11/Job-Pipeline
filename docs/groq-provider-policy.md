# Groq provider and model policy

`config/groq-provider-policy.json` is the source of truth for the Generator's
Groq models, lifecycle approvals, request bounds, live benchmark gate,
developer-tier limits, and pricing. `scripts/build-workflows.mjs` fails if the
initial or repair model is missing, unapproved, non-production, deprecated,
scheduled for shutdown, or not live-benchmark ready. It writes both resolved
models and the policy version into the disabled Generator export.

## Current model route

The scheduled route is:

| Request | Model | Maximum per job | Purpose |
| --- | --- | ---: | --- |
| Initial | `openai/gpt-oss-120b` | 1 | Generate the first application message. |
| Repair | `openai/gpt-oss-20b` | 1 | Correct a deterministically rejected first draft. |

Both models are Groq production models, artifact-approved, and marked
`production_activation=ready` after live permission and benchmark checks on
2026-07-31. The repair is conditional; a job with a valid initial message makes
no repair request. There is no third request and Groq HTTP requests have no
automatic retry.

The retiring `llama-3.3-70b-versatile` model is forbidden because Groq
announced its 2026-08-16 shutdown on affected tiers. The preview
`qwen/qwen3.6-27b` candidate remains unapproved. Neither is a fallback.

Official evidence, last verified 2026-07-31:

- [GPT-OSS 120B model](https://console.groq.com/docs/model/openai/gpt-oss-120b)
- [GPT-OSS 20B model](https://console.groq.com/docs/model/openai/gpt-oss-20b)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq prompt caching](https://console.groq.com/docs/prompt-caching)
- [Groq reasoning controls](https://console.groq.com/docs/reasoning)
- [Groq deprecations](https://console.groq.com/docs/deprecations)
- [Groq model permissions](https://console.groq.com/docs/model-permissions)

The checked-in developer limits are a planning baseline. The Groq
organization/project console and response headers remain authoritative for
account-specific limits and shared usage.

## Scheduled capacity proof

The production Generator retains its 90-minute schedule and 480-second
timeout, but processes at most five frozen candidates sequentially. The
schedule has 16 nominal runs per 24 hours and 17 conservative trigger
boundaries. This yields:

- nominal jobs per day: `16 × 5 = 80`;
- conservative selected jobs: `17 × 5 = 85`;
- maximum logical requests: `17 × 5 × 2 = 170`.

The policy assumes no prompt-cache credit and includes the configured 480-token
maximum output for every request. With the character estimate divisor of
three:

| Route | Maximum request estimate | Requests/day | Daily estimate | Model limit |
| --- | ---: | ---: | ---: | ---: |
| Initial / GPT-OSS 120B | 2,314 | 85 | 196,690 | 200,000 TPD |
| Repair / GPT-OSS 20B | 2,314 | 85 | 196,690 | 200,000 TPD |

The combined planning estimate is 393,380 tokens, but it is deliberately
validated against two separate model quotas rather than incorrectly summing
them against one quota. Each route stays under 1,000 RPD, 8,000 TPM, and
200,000 TPD. At 21-second request pacing, at most three requests and 6,942
character-estimated tokens enter either rolling minute. The ten-request
all-repair path has 189 seconds of configured pacing, inside the unchanged
480-second execution timeout.

These are conservative character-based estimates, not tokenizer counts. They
do not reserve capacity consumed by another project in the same Groq
organization and do not authorize unscheduled manual or benchmark traffic.
The build reports actionable model-specific failures when runtime, prompt, or
policy edits exceed RPD, RPM, TPD, TPM, or execution-time capacity.

## Request and prompt bounds

Both requests use temperature `0.2`, low reasoning effort, hidden reasoning,
and a 480-token output cap. The initial combined-input ceiling is 6,500
characters with a 1,000-character reserve, so the initial request can use at
most 5,500 combined characters. The independently bounded repair request also
uses a 5,500-character combined-input ceiling.

The initial request contains:

- compact candidate identity and approved URLs;
- bounded job title, company, and stored description;
- non-empty safe employer instructions;
- the two strongest selected, profile-resolved proofs;
- the application and safety constraints needed for a copy-ready message.

The repair is standalone. It contains the complete rejected draft, every
deterministic validation error, compact selected-proof context, and the safe
application instructions needed to correct the message. It does not resend
the full job description.

Only a deterministically ready application pack reaches the initial model.
Every model response remains untrusted until the same deterministic message
validator passes it. Invalid repair output records bounded `error` evidence for
a later claimed retry; rejected text is not persisted and cannot make the row
ready.

## Live verification

Normal build and validation never call Groq. With an explicitly authorized
credential, run:

```bash
GROQ_API_KEY=... npm run benchmark:groq -- --live
```

The harness runs the direct, adjacent, and instruction-bearing fixtures
through both scheduled models. It uses the same system, initial, repair, and
validation code as the workflow. It prints only sanitized validity, error
counts/categories, finish reasons, latency, exact provider token counts, and
price-derived cost; it never prints prompts, messages, raw provider responses,
or credentials.

Activation requires at least three measured cases per scheduled model,
non-zero token measurements, no output-limit finish, and a 100% final
deterministic valid rate. A separate hybrid-route smoke confirms that an
initial 120B rejection can be repaired by 20B through the same deterministic
gate. A permission failure, missing usage measurement, invalid response, or
quota below the checked-in envelope blocks activation with an actionable
model-specific error.

## Rollback

Disable the Generator and wait for active executions to finish. Preserve
retry/error evidence and any earlier valid application messages. Revert only
to artifact-approved, production, non-deprecated models with sufficient
verified capacity; regenerate and validate the exact artifact; import it
inactive; rebind the existing credential; and repeat the permission,
benchmark, and disabled-workflow smoke gates. Never roll back to a model after
its announced shutdown.
