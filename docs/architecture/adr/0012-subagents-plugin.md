# ADR 0012: Subagents plugin

## Status

Accepted.

## Decision

FRIDAY keeps recursive child-agent orchestration in the `subagents` plugin.

The plugin owns direct-child admission, recursion depth checks, readable child
names, exact child-model selection helpers, detached child lifecycle tracking,
parent-scoped registry state, cancellation, deletion, and retention hooks.

Child runtime construction is supplied through a narrow runtime-host port. This
lets a higher-level session composition create children with the same agent,
tools, skills, model, persistence, and policy stack as their parent without
moving those responsibilities into `subagents`.

The parent registry can be persisted through generic session custom entries.
`sessions` remains unaware of subagent semantics.

## Boundary

`subagents` does not own:

- Python/IPython host-request transport or the model-facing recursive API;
- provider/model transport;
- session storage implementation;
- agent loop implementation;
- tools, skills, compaction, or autonomous continuation policy;
- agent-to-agent messaging;
- scheduling, refinement, sandboxing, or permissions.

The model-facing recursive API is the separate `rlm` plugin (ADR-0013). It
translates its protocol into the generic `subagents` capability rather than
reimplementing child lifecycle behavior.
