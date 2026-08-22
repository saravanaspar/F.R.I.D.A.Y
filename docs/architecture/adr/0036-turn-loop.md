# ADR-0036: Replaceable conversational Turn Loop

## Status

Accepted. References to Command Handler are historical; ADR-0038 removes it.

## Context

Plugin Kernel v2 makes FRIDAY's subsystem graph declarative, but a dependency
graph alone does not define what happens when a human message arrives. Channels,
Routing, Sessions, Agent, Tools, Memory, Permissions, Events, and Observability
were independently usable, yet no ordinary plugin owned the end-to-end human
turn lifecycle.

Putting that workflow in Command Handler would violate the fundamental rule.
Making Channels call Routing/Agent directly would turn transport ingress into an
application coordinator. Making Routing subscribe to Channels also conflates
WHERE/HOW classification with execution and causes new ingress types such as
Voice to require routing/orchestration edits.

## Decision

Add an ordinary declarative `turn-loop` plugin. It is replaceable behavioral
composition, not kernel infrastructure.

The stable ingress contract is the typed `turn.ingress` hook. Channels emits one
normalized `InboundTurn` for ordinary sanitized messages and supplies a
host-owned reply closure. Credential capture remains inside Channels and never
reaches this hook. Explicit host/test local injection through the CLI adapter is
marked `local`; the normal `friday` runtime does not read stdin as conversational
ingress. Authenticated remote transports are marked `channel`. Turn Loop maps
those host-owned authority classifications
to `permissions.trusted.runAsLocal()` or exact `runAsChannel()` context before
Routing or execution occurs.

Routing becomes a pure service with no Channels or Observability dependency. It
owns WHERE/HOW classification and its own bounded routing decision/failure Event
publication. Turn Loop invokes Routing and owns the outer processing span.

Execution is not hard-coded by destination branches. Turn Loop selects from the
typed multi-provider `turn.executor` contribution registry. A matching executor
with the highest priority wins; equal highest-priority matches fail closed. The
built-in `agent-session` executor handles persistent `session/agent` and
transient `utility/transient` decisions. Scheduler/System behavior is not part
of Turn Loop and can be added later as independent executor contributions.

The built-in Agent executor reuses the existing subsystem contracts rather than
reimplementing them. It composes Sessions, Model, Agent, Prompts, Tools and
Session Resources. Optional Memory, Skills, RLM/Subagents and Sandbox are
resolved lazily by the Agent executor, while Turn Loop resolves optional
Observability lazily. Config order therefore remains non-semantic. Skills remain
owned by Skills; Memory remains owned by Memory; RLM/Subagents remain
independently replaceable. Session-scoped IPython receives the existing host
handlers/environment through Tools rather than bypassing the security adapter.

Agent-facing capability plugins extend the running Agent through the generic
`agent.tool` contribution registry. Turn Loop collects those contributions
dynamically for every turn and adapts their JSON Schema/result contract to the
Agent tool interface. MCP contributes only server discovery/list/call tools;
Integrations contributes only connection listing/action invocation. Their own
services continue to enforce Permissions, Vault and network policy. They import
only Turn Loop's generic contribution contract; neither depends on Turn Loop's
runtime capability/implementation or on Agent. Credential-management operations
remain host/trusted APIs rather than model-facing tools.

Persistent routed sessions live in the same mission state root used by Routing
(`FRIDAY_STATE_DIR`, then `FRIDAY_HOME`, then `~/.friday`) and are cached with a
bounded idle eviction policy. Existing routed session ids are validated and
opened only from that sessions directory. Transient utility turns use in-memory
sessions. The Agent's inner model/tool loop remains owned by Agent; Turn Loop
owns only the outer human-turn lifecycle.

Turn Loop serializes the entire lifecycle per external conversation. Different
external conversations may proceed concurrently, but execution against the same
existing persistent FRIDAY session is additionally serialized. This preserves
the rule that one external chat is not one FRIDAY session while preventing two
external chats from racing the same Agent session state.

Received/completed/failed Turn Events contain host-owned identity/routing/executor
metadata only; conversation and response text are not stored there. A
deterministic completed Event plus a bounded in-process cache suppresses
redelivery after known completion. This is an at-least-once boundary around
external effects: a process crash after execution/reply but before durable
completion publication can cause a transport redelivery to execute again. The
system does not claim impossible exactly-once semantics across arbitrary remote
side effects and message transports.

## Consequences

Adding Voice or another conversational ingress requires emitting the existing
`turn.ingress` contract; Turn Loop does not change. Adding a new execution
profile implementation requires contributing `turn.executor`; Turn Loop does
not change. Adding a model-facing capability tool requires contributing
`agent.tool`; Turn Loop does not change. Replacing the complete turn lifecycle is
possible by replacing the plugin that provides `turn-runtime` and consumes the
ingress hook.

Channels no longer depends on Routing, Sessions, Agent, or the Turn Loop service.
Routing no longer subscribes to Channels. This removes the previous hidden
message-classification side effect and prevents double routing.

Turn Loop is intentionally a trusted composition boundary because it establishes
Permissions identity context and chooses host-registered executors. Model output
can select only the host-validated Routing destination/profile; it cannot invent
an executor or trusted principal.

## Alternatives rejected

### Put the conversation workflow in Command Handler

Rejected because Command Handler must remain ignorant of conversational
semantics and behavioral subsystems.

### Make Channels call Routing and Agent directly

Rejected because every new transport would duplicate orchestration and Channels
would own behavior unrelated to transport security/admission.

### Make Routing subscribe to Channels and execute the result

Rejected because Routing must remain a stateless WHERE/HOW classifier rather
than an executor, and it would make non-Channel ingress awkward.

### Hard-code scheduler/system branches in Turn Loop

Rejected because those are independently replaceable execution behaviors.
`turn.executor` contributions preserve plug-and-play extension without reopening
the outer lifecycle.
