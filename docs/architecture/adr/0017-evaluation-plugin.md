# ADR 0017: Evaluation plugin

## Status

Accepted.

## Decision

FRIDAY has a replaceable `evaluation` plugin for deterministic evaluation and result classification.

The plugin owns:

- running host-supplied deterministic command checks through an injected process port,
- bounded stdout/stderr evidence capture,
- pass, partial, fail, timeout, error and no-score classification,
- per-check duration and exit evidence,
- sequential evaluation suites,
- aggregate counts and score summaries.

A positive score remains positive evidence even when teardown later records an error or timeout. This prevents post-result harness failures from silently erasing a successful evaluation result.

The plugin does not own:

- low-level process or shell implementation,
- autonomous continuation or retry policy,
- git/worktree change detection,
- source candidate creation,
- promotion or rollback policy,
- sessions, memory, refinement, prompt composition, model transport, tools, sandboxing, permissions or scheduling.

`autonomy` consumes the evaluation capability for deterministic quality-gate execution while retaining its own continuation budgets, retry state and worktree-change suppression. This removes command-evaluation behavior from autonomy without moving autonomy policy into evaluation.

Future self-improvement code may consume the same evaluation capability for candidate validation rather than creating a second test runner.
