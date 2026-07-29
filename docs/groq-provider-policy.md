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
preview. This is not evidence that the production account permits the model or
that live message quality has passed. The policy therefore keeps
`production_activation=benchmark_required`, and operations must not activate
the Generator until the live gate below passes.

Official evidence, last verified 2026-07-30:

- [Groq deprecations](https://console.groq.com/docs/deprecations)
- [GPT-OSS 120B model](https://console.groq.com/docs/model/openai/gpt-oss-120b)
- [Qwen 3.6 27B model](https://console.groq.com/docs/model/qwen/qwen3.6-27b)
- [Llama 3.3 70B model](https://console.groq.com/docs/model/llama-3.3-70b-versatile)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq model permissions](https://console.groq.com/docs/model-permissions)

The checked-in developer limits are a planning baseline, not an account
entitlement. The exact organization/project limits and model permissions in
Groq Console remain authoritative.

## Request and prompt bounds

The generated Groq node uses temperature `0.2` and a 384-token output cap.
The prompt carries only the canonical identity/approved URLs, compact policy
constraints, selected profile proofs, non-empty safe employer context, and a
bounded description. Job URLs and empty sections are omitted. A repair reuses
the exact initial evidence packet and adds the complete rejected draft plus
deterministic errors; if that combined input exceeds the provider budget, the
workflow records a bounded generation failure instead of making an oversized
repair call.

Offline measurements on the three representative ready fixtures:

| Measurement | Before | After |
| --- | ---: | ---: |
| Static system message | 10,262 characters | 3,572 characters |
| Combined direct-job input | 13,559 characters | 6,620 characters |
| Combined adjacent-job input | 13,395 characters | 6,454 characters |
| Combined instruction-job input | 14,148 characters | 7,245 characters |
| Configured worst-case initial input | about 61,088 characters | 12,000 characters |

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
and deterministic message validator as the workflow, paces calls against the
documented token/request limits, and prints only:

- deterministic validity and whether one repair was needed;
- sanitized failure category and validation-error count;
- latency;
- exact provider input, cached-input, and output token counts;
- price-derived cost.

It never prints prompts, generated messages, raw provider responses, or the API
key. Both models must complete all three cases with a 100% final deterministic
valid rate and non-zero provider token measurements. Record the sanitized
report, confirm the production project permits the selected model, and perform
the disabled n8n smoke test before activation. If the selected model passes,
change its `production_activation` to `ready`, bump the provider policy
version, regenerate, and validate; the checked-in `benchmark_required` state
intentionally blocks activation. Correctness, latency, exact tokens, and cost
should be compared; preview lifecycle is a reliability disadvantage even if
Qwen's fixture score is competitive.

## Rollback

Disable the Generator and wait for active executions to finish. Preserve
retry/error evidence and any prior valid application messages. Revert
`selected_model` only to a currently artifact-approved, non-deprecated model,
regenerate, validate, import the disabled export, rebind the credential, and
repeat the benchmark/smoke gate. Never roll back to
`llama-3.3-70b-versatile` on affected tiers after its shutdown date.
