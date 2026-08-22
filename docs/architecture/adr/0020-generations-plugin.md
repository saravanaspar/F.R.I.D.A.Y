# ADR-0020: Generation History and Activation Mechanics Belong to Generations

## Status

Accepted

## Context

FRIDAY needs a durable history of runnable accepted generations that is separate
from temporary self-improvement candidates. Candidates may fail or be
abandoned; generations are accepted code checkpoints that must remain
addressable across process restarts and safe activation failures.

Putting generation history in `self-improvement` would mix candidate policy
with low-level version activation and rollback mechanics. Putting it in
`worktrees` would broaden that plugin beyond isolated checkout lifecycle.

The mechanism therefore remains independently replaceable and exposes a narrow
capability consumed by self-improvement policy.

## Decision

`generations` owns durable FRIDAY generation history and guarded activation of a
verified descendant generation.

It owns:

- one restart-safe generation registry and active-generation pointer;
- clean-repository checkpoint admission;
- immutable sequential generation ids;
- pinned git refs under `refs/friday/generations/` so recorded commits remain
  reachable independently of branch movement;
- parent lineage between successive accepted generations;
- idempotent checkpointing when HEAD already equals the active generation;
- rejection of duplicate or divergent generation history;
- generation-pin verification;
- guarded activation of a target commit that is a descendant of the active
  generation and whose expected base exactly matches the active commit;
- fast-forward-only activation of the primary checkout;
- recovery of the primary checkout and unpublished generation pin if activation
  fails before generation state is published;
- idempotent activation recovery when the target is already the active child of
  the expected base;
- rollback-target discovery along the active lineage; and
- non-mutating rollback-plan creation and stale-plan validation.

It does not own:

- candidate creation, evaluation, or promotion policy;
- source editing or agent/model orchestration;
- isolated candidate worktree lifecycle;
- rollback activation policy;
- process restart, executable replacement, or generation handoff; or
- scheduling, sessions, prompts, memory, sandboxing, or permissions.

The runtime consumes only a narrow injected process port. The FRIDAY adapter
resolves `execution` at activation time, so the implementation package has no
sibling `@friday/*` dependency.

## Safety Invariants

A checkpoint or activation is admitted only when the configured path is the git
worktree root and the primary checkout is clean, including untracked files.
The active generation's pinned ref must still resolve to its recorded commit,
and primary HEAD must exactly equal that active commit before activation.

A target must resolve to a commit, must not already belong to another recorded
generation, and must be a descendant of the active commit. The expected base
supplied by the caller must equal the active commit. These checks prevent a
stale candidate from silently replacing newer accepted work.

Before moving HEAD, the target is pinned under the reserved generation ref
namespace. Activation uses `git merge --ff-only` by exact target commit, with git
hooks disabled for that internal transition so arbitrary host hooks cannot run
inside the promotion transaction. After the move, generations verifies both a
clean checkout and the exact expected target HEAD before publishing the new
active-generation state.

If an error or cancellation occurs after HEAD moved but before state
publication, recovery does not reuse the caller's abort signal. It verifies the
current HEAD, performs a guarded `git reset --hard` only when HEAD is exactly the
unpublished target, restores the previous active commit, and removes the
unpublished pin. An unexpected HEAD is never reset. Incomplete recovery is
reported as an `AggregateError` rather than hidden.

The target pin is created before HEAD moves, which also provides a restart
recovery marker. If the process stops after pin creation but before publication,
a retry for the same target reuses the exact next reserved generation pin. It
either completes the fast-forward when HEAD is still at the base or publishes
the generation when HEAD already reached the pinned target. This closes the
normal crash windows around activation without treating unrelated refs as an
accepted generation.

`git reset --hard` is therefore a transaction-recovery primitive here, not a
user-facing rollback implementation. Rollback planning remains non-mutating.

Generation state snapshots finalize file permissions before the atomic rename,
so publication is the final filesystem mutation of the state write.

## Consequences

Self-improvement can promote a passed, commit-sealed candidate without
implementing raw git mutation. The primary checkout and generation registry move
as one guarded transaction with explicit recovery behavior. Actual rollback
activation and restart/handoff remain later work and require their own green
checkpoint before use.
