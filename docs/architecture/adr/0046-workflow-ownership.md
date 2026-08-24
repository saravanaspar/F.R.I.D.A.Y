# ADR-0046: Autonomous Workflow Ownership Stays Local

## Status

Accepted. Runtime-control wording amended by ADR-0038.

## Context

FRIDAY needs user-facing autonomous execution and self-development without
turning either the non-plugin runtime host or a new central composition plugin
into a god object.

A proposed `application` plugin only coordinated capabilities already owned by
`autonomy` and `self-improvement`. It had no independent mechanism, safety
boundary or meaningful reuse case. Under FRIDAY's plugin-boundary test, that
coordination does not earn a top-level plugin.

## Decision

There is no central `application` plugin.

- `autonomy` contributes `autonomy.run` through `system.action` and owns ordinary autonomous-objective composition:
  Agent, model, sessions, prompts, tools and deterministic completion gates.
- `self-improvement` contributes `self-improvement.run` through `system.action` and owns the self-development
  transaction: candidate creation, invoking autonomy inside the candidate,
  host-side commit finalization, sealed evaluation, promotion, durable mission
  state, restart/takeover, handoff completion and rollback/recovery policy.
- Mechanisms that already earn independent boundaries remain separate:
  `worktrees`, `evaluation`, `generations` and `lifecycle`.
- The non-plugin host has no workflow dispatch or dynamic command registry; plugin discovery/finalization is ephemeral (ADR-0038).

A future plugin is not added merely because a new workflow needs composition.
The workflow belongs to the plugin that owns the policy unless the proposed
boundary independently passes FRIDAY's four-question test.

## Consequences

Adding an unrelated plugin does not require modifying the non-plugin host or a
central application registry. Existing workflow plugins change only when they
intentionally consume a new capability. Self-development remains replaceable
without centralizing the Git, evaluation or process mechanisms it coordinates.
