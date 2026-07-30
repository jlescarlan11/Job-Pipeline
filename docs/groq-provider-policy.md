# Groq provider and model policy

`config/groq-provider-policy.json` is the source of truth for the Generator's
Groq model, lifecycle approval, request bounds, benchmark gate, documented
developer-tier limits, and token pricing. `scripts/build-workflows.mjs` rejects
an unapproved, deprecated, missing, or shutdown-selected model and writes the
resolved model and policy version into the disabled Generator export.

## Current lifecycle decision

Groq announced that `llama-3.3-70b-versatile` will shut down for free and
developer tiers on 2026-08-16. Its official replacements are
`openai/gpt-oss-120b` and `qwen/qwen3.6-27b`.

The repository selects `openai/gpt-oss-120b` for the generated, disabled
artifact because Groq labels it production, while `qwen/qwen3.6-27b` is
preview. Artifact approval alone was not evidence that the production account
permitted the model or that live message quality had passed, so the policy
initially kept `production_activation=benchmark_required`. The first
authorized live run on 2026-07-30 showed that the reasoning-model defaults
consumed the original 384-token cap: every initial and repair response ended at
the cap and all deterministic validations failed. Version `2026-07-30/v4`
therefore raises the output cap to 1,024 tokens and reduces the combined input
bound to 15,000 characters so complete drafts and model reasoning fit without
weakening the conservative daily token ceiling. A second live run passed two
of three GPT-OSS cases but still reached the cap on the failed direct case;
Qwen's default thinking mode reached the cap on every initial and repair
response.
Version `2026-07-30/v5` therefore makes provider behavior explicit:
GPT-OSS uses low reasoning, Qwen uses non-thinking mode, and both return hidden
reasoning. The generated workflow uses a Groq-credential-bound HTTPS request
because the installed n8n Groq Chat Model node does not expose these API
controls.

The repeated v5 comparison failure was not truncation: Qwen's first drafts
echoed employer schedule or availability language, and one of three repairs
retained it. Version `2026-07-30/v6` hardens the shared prompt contract by
requiring a reviewed neutral closing and instructing repairs to delete the
entire sentence containing a schedule, shift, time-zone, start, or join
commitment.

The v6 release benchmark measured all three fixtures on both candidates.
GPT-OSS passed 3/3 with nonzero usage and no output-limit finishes. Qwen was
fully measured but passed only 1/3 after repeating schedule/availability
language and one unsupported project. Version `2026-07-31/v8` marks the
selected, artifact-approved GPT-OSS model ready. Comparison candidates must
still complete every measured case, but an unapproved preview model's quality
does not override the selected production model's activation result.

Official evidence, last verified 2026-07-30:

- [Groq deprecations](https://console.groq.com/docs/deprecations)
- [GPT-OSS 120B model](https://console.groq.com/docs/model/openai/gpt-oss-120b)
- [Qwen 3.6 27B model](https://console.groq.com/docs/model/qwen/qwen3.6-27b)
- [Llama 3.3 70B model](https://console.groq.com/docs/model/llama-3.3-70b-versatile)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq prompt caching](https://console.groq.com/docs/prompt-caching)
- [Groq reasoning controls](https://console.groq.com/docs/reasoning)
- [Groq model permissions](https://console.groq.com/docs/model-permissions)

The checked-in developer limits are a planning baseline, not an account
entitlement. The exact organization/project limits and model permissions in
Groq Console remain authoritative.

## Scheduled rate-capacity bound

Groq applies rate limits at organization level, returns `429` when a limit is
exceeded, and does not guarantee that prompt caching will remove input tokens
from a request. The production calculation therefore assumes no cache hits and
includes the maximum configured output on every request.

For `openai/gpt-oss-120b`, the documented developer-base limits used by the
policy are 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute, and
200,000 tokens/day. With the character-estimate divisor of 3:

- maximum initial request: `ceil((15,000 - 6,000) / 3) + 1,024 = 4,024`;
- offline repair-budget ceiling: `ceil(15,000 / 3) + 1,024 = 6,024`;
- maximum per scheduled selected record: `4,024` character-estimated tokens;
- conservative 30-minute trigger count: `ceil(1,440 / 30) + 1 = 49` per day;
- maximum scheduled use: 49 requests and 197,176 character-estimated tokens
  per day, leaving 2,824 tokens, or 1.4%, below the planning limit.

Both estimates are below 8,000, but the simplified scheduled workflow permits
only the initial request. Invalid output retries in a later scheduled
execution. The Generator cap is 1 and its execution timeout is 480 seconds.
The build fails if policy or runtime edits exceed the selected model's
per-minute, daily, or execution-time envelope.

These values are deliberately labeled character-based estimates. They are not
exact tokenizer counts, do not reserve capacity used by another project in the
same Groq organization, and do not include manual executions or the opt-in
benchmark. Before either of those activities, disable the scheduled Generator,
verify the current account-specific limits in Groq Console, and retain the
required live measurements. Higher verified limits may justify a separately
versioned cadence/cap change; they do not make the checked-in base-limit proof
less conservative.

## Request and prompt bounds

The generated Groq request uses temperature `0.2`, hidden reasoning, the
selected model's reviewed reasoning effort, and a 1,024-token output cap.
The prompt carries only the canonical identity/approved URLs, compact policy
constraints, the two highest-ranked selected profile proofs, non-empty safe
employer context, and a bounded description. The durable pack may retain a
third approved proof for review and validation, but it is not repeated to the
provider. Only each prompt proof's canonical reference and evidence are sent;
the internal relevance score and duplicate display label are omitted. Job URLs
and empty sections are omitted. The checked-in scheduled workflow makes one
model request per selected record; invalid output records a bounded generation
failure for a later claimed retry.

Offline measurements on the three representative ready fixtures:

| Measurement | Before | After |
| --- | ---: | ---: |
| Static system message | 10,262 characters | 3,771 characters |
| Combined direct-job input | 13,559 characters | 6,029 characters |
| Combined adjacent-job input | 13,395 characters | 5,590 characters |
| Combined instruction-job input | 14,148 characters | 6,563 characters |
| Configured worst-case initial input | about 61,088 characters | 9,000 characters |

Relative to the prior compact three-proof packet, the bounded proof payload
removes 790, 1,063, and 881 characters respectively (11.9%, 16.5%, and 12.2%).
A repair reuses the compact initial packet, so it avoids the same repeated
input again.

The policy's displayed token estimate divides characters by three and is only
a conservative character-based estimate. It is not a tokenizer count. Exact
input/output tokens and cache hits are available only from a live Groq response
and are reported by the benchmark harness.

At the published prices, GPT-OSS 120B is cheaper than the retiring Llama model
for both uncached input ($0.15 versus $0.59 per million tokens) and output
($0.60 versus $0.79). Qwen 3.6 27B costs $0.60 input and $3.00 output per
million tokens. Actual spend depends on exact provider usage and cache hits.

## Required live benchmark

Normal build and validation never call Groq. After explicit authorization, run
the benchmark with a non-production credential whose project allows both
candidate models:

```bash
GROQ_API_KEY=... npm run benchmark:groq -- --live
```

The harness runs direct, adjacent, and instruction-bearing fixtures through
both official replacements, uses the same system/user/repair prompt builders
and deterministic message validator as the workflow, applies the same
model-specific reasoning controls, paces calls against the documented
token/request limits, and prints only:

- deterministic validity and whether one repair was needed;
- sanitized failure category and validation-error count;
- provider finish reasons and whether the configured output limit was reached;
- latency;
- exact provider input, cached-input, and output token counts;
- price-derived cost.

It never prints prompts, generated messages, raw provider responses, or the API
key. Every candidate must complete all three cases with non-zero provider token
measurements. The selected model must also achieve a 100% final deterministic
valid rate; comparison-model validity remains visible but does not authorize or
block an artifact-approved selected model. Record the sanitized report, confirm
the production project permits the selected model, and perform the disabled
n8n smoke test before activation. A selected model that remains
`benchmark_required`, forbidden, deprecated, or shutdown blocks activation.
Correctness, latency, exact tokens, and cost should be compared; preview
lifecycle is a reliability disadvantage even if a comparison score is
competitive.

## Rollback

Disable the Generator and wait for active executions to finish. Preserve
retry/error evidence and any prior valid application messages. Revert
`selected_model` only to a currently artifact-approved, non-deprecated model,
regenerate, validate, import the disabled export, rebind the credential, and
repeat the benchmark/smoke gate. Never roll back to
`llama-3.3-70b-versatile` on affected tiers after its shutdown date.
