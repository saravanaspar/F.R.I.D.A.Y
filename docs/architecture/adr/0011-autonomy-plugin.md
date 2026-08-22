# ADR 0011: Autonomy plugin

## Status

Accepted and extended with production objective orchestration. Operational invocation amended by ADR-0038.

## Decision

Autonomous continuation policy and the ordinary autonomous-objective workflow
are provided by the plain `autonomy` plugin.

The runtime package owns reusable continuation mechanics: turn/token/time
budgets, usage accounting, quality-gate decisions, failed-gate retry state,
workspace-change detection, continuation message construction, and the rule
that assistant prose alone is not terminal evidence.

Workspace-change detection treats the selected checkout as model-controlled
input. Its Git inspection processes are composed through the independent
`sandbox` capability with read-only, network-off workspace access rather than
running Git directly on the host. Untracked-path hashing also rejects paths
whose resolved parent escapes the selected workspace before opening them on
the host.

The FRIDAY-facing plugin adapter owns the composition required to make that
policy a usable autonomous run. It contributes the bounded `autonomy.run`
System action, resolves the independent Agent/model/session/prompt/tool
capabilities, creates one durable
session, installs the runtime continuation hook on the Agent, and
keeps working until deterministic gates pass or a configured budget/abort
condition ends the run.

Autonomous shell and edit tools are deliberately sequential. IPython is not
exposed by this workflow. Isolation and authorization are supplied by the
independent sandbox and permissions plugins rather than embedded inside autonomy.

Low-level command execution and process-tree termination remain owned by
`execution`. Deterministic command classification remains owned by `evaluation`.
Model/provider transport, session persistence, prompt construction and the
Agent loop remain independent capabilities.

`autonomy` does **not** own candidate creation, promotion, accepted-generation
mutation, rollback policy, or process replacement. `self-improvement` consumes
the autonomy capability when a self-development candidate needs an agent to
modify it.

## Boundary rationale

Autonomy passes FRIDAY's independent-plugin test because the continuation/run
contract is reusable for ordinary tasks as well as self-development, can be
replaced independently of the Agent loop, enforces bounded autonomous-work
safety policy, and has substantial independent state-machine behavior/tests.

A separate central application/orchestration plugin is not needed. Ordinary
autonomous workflow composition belongs here because autonomy owns the policy
being executed.

## Consequences

- `autonomy.run` is contributed by `autonomy`; there is no host command registry (ADR-0038).
- Self-improvement reuses exactly the same autonomous objective capability
  rather than implementing a second agent loop.
- Adding an unrelated plugin does not require changing autonomy. Autonomy only
  changes when its workflow intentionally consumes the new capability.
