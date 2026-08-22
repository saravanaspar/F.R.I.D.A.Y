# ADR-002: Plugin Boundaries Follow Replaceable Subsystems

## Status

Accepted. Host-boundary wording amended by ADR-0038.

## Context

FRIDAY's invariant says every functional subsystem outside the tiny non-plugin host is a plugin. Interpreting that as "every helper/function is a plugin" would create excessive coupling and operational complexity.

Large implementations often combine multiple responsibilities; FRIDAY splits behavior at replaceable subsystem boundaries.

## Decision

FRIDAY plugins are split by independently replaceable subsystem, not by individual function.

For the current implementation:
- model/provider transport is one initial model plugin, including streaming and tool-call protocol handling
- generic agent loop is its own plugin
- execution kernel is its own plugin
- tool registry/definitions are their own plugin
- skills are their own plugin
- sessions are their own plugin
- context compaction is its own plugin
- autonomous continuation policy is its own plugin
- subagent/RLM orchestration is its own plugin
- self-improvement/refinement is its own plugin

No monolithic coding-agent package is treated as one FRIDAY plugin.

## Consequences

Positive:
- existing behavior can be preserved without preserving unrelated coupling
- subsystems can evolve/restart/replace independently
- sessions remain usable without subagents
- agent loop remains usable without a particular CLI/UI/session stack
- permissions and sandboxing wrap execution without becoming part of the execution runtime

Negative:
- extraction requires explicit adapter interfaces
- existing components that cross these boundaries must be decomposed carefully
- early GEN-0 wiring takes more work than importing `pi-coding-agent` wholesale

## Guardrail

Do not introduce a new plugin solely because a module contains multiple exported functions. Create a plugin when the responsibility is independently replaceable or has a meaningful state, lifecycle, security or version boundary.
