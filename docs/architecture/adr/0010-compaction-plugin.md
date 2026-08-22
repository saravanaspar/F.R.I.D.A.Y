# ADR 0010: Compaction is a plugin

## Status

Accepted.

## Decision

Context compaction and abandoned-branch summarization live in the `compaction` plugin.

The implementation owns:

- context-token estimation and automatic trigger thresholds,
- recent-context cut-point selection,
- split-turn handling,
- iterative summaries that incorporate a previous compaction,
- structured continuation-summary prompts,
- branch-summary collection and generation,
- cumulative file-operation metadata in summaries, and
- persistence coordination through the sessions capability.

The implementation package does not import sibling FRIDAY packages. Model completion and
session opening are injected when the plugin is activated. Existing session objects are
consumed through a narrow structural port, and resulting summaries are persisted using the
session's append operations.

## Boundaries

`compaction` does not own durable session storage, model/provider transport, the agent loop,
tools, skills, RLM/subagents, scheduling, sandboxing, permissions, or autonomous continuation.

`sessions` remains responsible for storing and projecting compaction and branch-summary
entries. `model` remains responsible for the actual completion request. Higher-level
orchestration decides when to invoke manual compaction or branch navigation.
