# ADR-0043: Donor-Grounded Prompt Caching and Model Telemetry

## Status

Accepted.

## Context

FRIDAY already had a mature multi-provider transport, stable session IDs, cache
retention settings, provider-native cache usage accounting and an injectable
Model log sink. The remaining model-runtime requirement was not to replace that
stack, but to compare it against the relevant upstream open-source donor sources and
reuse proven implementation details where they improve correctness or cost.

The donor audit reviewed the following upstream source paths. FRIDAY does not
vendor or retain complete donor repository snapshots: the useful implementation
details were copied or adapted into FRIDAY's own architecture and tests.

- OpenCode: `packages/llm/src/cache-policy.ts` and
  `packages/llm/src/protocols/utils/cache.ts` (MIT).
- Hermes Agent: `agent/prompt_caching.py` (MIT).
- Goose: `crates/goose-provider-types/src/cache_semantics.rs` (Apache-2.0).
- Codex: `codex-rs/core/tests/suite/prompt_caching.rs`,
  `codex-rs/core/tests/suite/prompt_cache_key.rs`, and
  `codex-rs/otel/src/events/session_telemetry.rs` (Apache-2.0).
- Prime Agent: `packages/ai` (MIT), which remains the strongest direct lineage
  for FRIDAY's existing low-level provider transport; that adapted FRIDAY code
  is retained rather than overwritten.

## Decision

### Keep FRIDAY's provider stack

Do not transplant another project's complete LLM abstraction. FRIDAY already
has provider coverage, reasoning/tool-call handling, retries, cache retention,
session-affinity keys, normalized cache read/write accounting and security
integration that fit the Plugin Kernel. Replacing it would discard validated
behavior for little benefit.

### Adapt stable-prefix caching from Hermes and OpenCode

Prompts now produces a `SystemPromptPlan` containing the complete canonical
prompt plus a stable leading prefix. Session-specific conversation-log paths,
recursive depth and parent-agent identity are moved to the suffix. Memory stays
in the latest user turn as ephemeral runtime context.

The canonical Agent/session state still stores one prompt string. The prefix is
request metadata only. Explicit-cache provider adapters may split the outgoing
system prompt into stable/volatile blocks after verifying byte-prefix identity.

Anthropic and Anthropic-compatible Chat routes spend at most four breakpoints:

1. stable system prefix,
2. volatile system suffix,
3. last tool definition,
4. latest conversation boundary.

Bedrock uses the same stable/volatile split plus its latest-user cache point.
Implicit-prefix providers such as OpenAI need no marker injection; they benefit
from the stable bytes appearing before per-session metadata.

This follows the donor principle of request-local decoration: persisted prompt
state is never rewritten into provider-specific cache block shapes.

### Adapt cache-semantics classification from Goose

Model exposes provider/model cache semantics as one of:

- `explicit-breakpoints`,
- `implicit-tolerant`,
- `implicit-strict`,
- `uncached`.

Unknown/custom routes conservatively default to strict prefix behavior. This is
metadata for planning/telemetry, not a response cache and not a claim that a
provider will always produce a hit.

### Adapt model request telemetry from Codex

Every Model stream records a content-free terminal event containing provider,
model/API, status, duration, time-to-first-output, normalized input/output/cache
read/cache write token counts, total cost, cache-read ratio, cache semantics and
whether a session cache key was supplied.

Prompt text, model output text, tool arguments, secrets and the actual session
identifier are deliberately excluded. The existing Model log sink sends these
records to Observability. The composition plugin also derives bounded metrics
for request count, duration, TTFT and cache-read ratio.

### Preserve cache-key stability

The existing stable FRIDAY session ID remains the provider prompt-cache key
where the provider supports one. Request/thread IDs may vary independently.
This matches the behavior explicitly tested in the Codex donor and avoids
coupling cache identity to individual HTTP requests.

## Consequences

FRIDAY gains useful cross-session prompt-prefix reuse without creating a custom
response cache or duplicating provider transports. Cache effectiveness becomes
measurable through Observability rather than inferred from configuration.
Provider-specific decoration remains localized to Model, while Prompts and Agent
stay provider-neutral.

The implementation is an adaptation of the donor strategies above, integrated
with FRIDAY's existing provider/runtime contracts; it is not a wholesale fork of
OpenCode, Hermes, Goose, Codex or Prime Agent.

The upstream paths in this ADR are audit citations, not a requirement to carry
source snapshots in this repository. Reproducibility here means the resulting
FRIDAY behavior is covered by its own implementation and tests.

## Audit Matrix

| Area | Donor evidence reviewed | Decision for FRIDAY |
| --- | --- | --- |
| Prompt construction | Hermes keeps volatile memory/context out of the system prompt; OpenCode decorates cache boundaries at request time | **Adapt.** Publish a stable-prefix plan from Prompts and keep session-specific metadata at the tail. |
| Provider abstraction | Prime `packages/ai`, OpenCode `packages/llm/src/provider.ts`, Goose provider registry/inventory | **Keep.** FRIDAY's current model runtime already preserves the Prime-derived provider breadth while exposing Plugin Kernel capabilities and FRIDAY-specific compatibility flags. |
| Prompt caching | OpenCode cache policy + four-breakpoint helpers; Hermes stable-system-prefix splitting; Goose cache semantics; Codex stable prompt-cache-key tests | **Adapt.** Add stable-prefix metadata, provider/model cache semantics, explicit request-local breakpoints and preserve FRIDAY session cache keys. |
| Tool schemas | OpenCode protocol-specific tool-schema conversion; Prime provider converters | **Keep.** FRIDAY already normalizes TypeBox tools and performs provider-specific conversion/strict-mode compatibility. Changing schema ownership would duplicate working code. |
| Context management | Hermes user-message context injection; FRIDAY Memory/Turn Loop runtime context; Goose context-management boundary | **Keep + align.** Volatile Memory remains user-turn runtime context; only durable/configuration material belongs in the stable system prefix. |
| Compaction | Donor agents compact historical context independently of provider transport | **Keep.** FRIDAY's Compaction plugin remains separate from Model and Prompts so cache policy cannot silently mutate session history. |
| Retry behavior | OpenCode session retry policy; Codex client retry module; provider SDK retry behavior in Prime/OpenCode | **Superseded by ADR-0044.** FRIDAY now adapts OpenCode-style retry classification/`Retry-After`/jitter at the Agent model-request boundary with a ten-retry ceiling, without replaying completed tool side effects. |
| Streaming | Prime event stream/provider streams; OpenCode protocol stream helpers; Codex SSE/client streaming | **Keep + extend.** Preserve FRIDAY's terminal-event stream contract and add a non-consuming observer solely for telemetry. |
| Usage accounting | Prime normalized usage fields; OpenCode shared token arithmetic; Codex session telemetry | **Keep + extend.** Preserve non-overlapping input/cache-read/cache-write accounting and add request duration, TTFT and cache-read ratio metrics. |
| Session persistence | Codex cache-key tests; Prime session-aware transport; FRIDAY Sessions/Turn Loop | **Keep.** Persistent FRIDAY session IDs remain transport cache-affinity keys; per-request IDs never replace them. |
| Model selection | OpenCode/Goose provider registries; FRIDAY model catalog + Routing/main-model split | **Keep.** Selection remains host-owned and provider-neutral; no donor registry is transplanted wholesale. |
| Provider quirks | Goose cache-semantics classification; OpenCode/Hermes cache protocol guards; FRIDAY compatibility maps | **Adapt selectively.** Cache semantics becomes explicit metadata while existing FRIDAY compatibility flags continue to own concrete wire quirks. |

This matrix closes the comparison requirement without rewarding code volume for
its own sake: donor code is reused or adapted where it adds a proven behavior,
and existing FRIDAY code is retained where transplanting another abstraction
would merely duplicate already-tested functionality.
