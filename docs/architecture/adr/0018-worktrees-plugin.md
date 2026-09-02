# ADR-0018: Worktrees Plugin

## Status

Accepted for implementation.

## Context

Self-development needs an isolated directory where a candidate change can be
made and evaluated without mutating the active FRIDAY checkout. Git worktrees
already provide the required isolation, but worktree creation, reset and
cleanup are infrastructure concerns rather than self-improvement policy.

Putting git worktree commands directly inside `self-improvement` would couple
candidate policy to one source-control implementation and would duplicate
low-level process execution already provided by `execution`.

## Decision

Introduce the `worktrees` plugin as the replaceable owner of git worktree
lifecycle.

The plugin owns:

- repository/root validation
- deterministic parsing of `git worktree list --porcelain`
- unique worktree directory and branch allocation
- branch-backed or detached worktree creation from an exact base commit
- safe worktree listing
- worktree removal and metadata pruning
- optional branch deletion after removal
- destructive reset/clean of a non-primary worktree
- recursive submodule reset/clean during worktree reset
- verification that reset leaves the worktree clean
- validation that linked-worktree `.git`, admin `gitdir`, and `commondir` metadata
  form a trusted bidirectional mapping to the selected candidate
- explicit trusted Git admin/work-tree arguments for candidate inspect/reset/commit
  operations so candidate-controlled `.git` contents cannot redirect host Git
- exposing the already-validated common Git directory to trusted host consumers
  that need a read-only candidate sandbox mount, without duplicating Git trust logic
- refusal to destructively reset or remove the primary checkout

The implementation package receives process execution through an injected
port. It does not import another FRIDAY implementation package.

The plugin does not own:

- deciding what candidate to create
- changing candidate source code
- model or agent orchestration
- evaluation or quality gates
- candidate comparison
- promotion or rejection policy
- commits/checkpoints or generation history
- restart/generation handoff
- sessions, memory, refinement, scheduling, sandboxing or permissions

Those remain separate replaceable concerns. The `self-improvement` plugin
(ADR-0019) consumes `worktrees` together with `evaluation` and other host
capabilities.

## Consequences

Self-improvement can create disposable candidate environments without knowing
git command details. Worktree behavior remains independently testable and
replaceable, while destructive operations have a narrow safety boundary around
the primary checkout.
