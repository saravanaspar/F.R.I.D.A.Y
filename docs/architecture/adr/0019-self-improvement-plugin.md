# ADR-0019: Self-Development Policy and Workflow Belong to Self-Improvement

## Status

Accepted. Runtime-control wording amended by ADR-0038 and extended through restart-safe autonomous self-development.

## Context

FRIDAY has independently replaceable worktree, evaluation, generation,
autonomy and lifecycle subsystems. Self-development needs policy that creates
isolated candidates, asks an autonomous agent to modify them, evaluates the
exact committed candidate, decides whether to promote it, survives process
replacement and restores a known-good generation when startup cannot complete.

That policy must not move into the non-plugin runtime host. A separate `application`
plugin would only re-coordinate the same self-improvement policy and therefore
fails FRIDAY's plugin-boundary test. The workflow belongs to the plugin that
owns candidate/promotion policy while dangerous mechanisms stay behind their
own capability boundaries.

## Decision

`self-improvement` owns candidate lifecycle, promotion policy, durable
self-development missions and the end-to-end self-development transaction.

It owns:

- creation of branch-backed isolated candidates through `worktrees`;
- stable candidate ids and restart-safe candidate records;
- deterministic candidate evaluation sealed to the exact clean candidate
  commit;
- promotion admission and handoff publication through injected generation
  mechanisms;
- invoking the generic `autonomy` capability inside the candidate worktree so
  the Agent can edit/fix the candidate until gates pass;
- asking `worktrees` to host-finalize the candidate commit with hooks/signing
  disabled rather than trusting model-generated Git commit behavior;
- durable self-improvement mission records for the promoted target generation;
- launch of a replacement generation through `lifecycle`;
- authenticated preflight before successor readiness: active generation,
  mission target and pending generation handoff must agree;
- post-restart deterministic verification before final takeover;
- claim/complete/recovery semantics for the generation handoff;
- known-good rollback policy when promotion publication, replacement startup,
  post-start verification or takeover fails; and
- cleanup/final terminal candidate, handoff and mission state.

It does not implement:

- raw Git worktree creation/removal/finalization (`worktrees`);
- evaluation command execution/classification (`evaluation`);
- generation refs, activation or transactional rollback mechanics
  (`generations`);
- process spawning, liveness, authenticated readiness or takeover transport
  (`lifecycle`);
- the Agent loop or generic autonomous continuation mechanics
  (`agent` / `autonomy`);
- model/provider transport, sessions, prompts or tool schemas.

The implementation runtime remains free of sibling `@friday/*` imports. The
FRIDAY-facing adapter/runner resolves capability contracts and composes the
transaction.

## Promotion and recovery safety

Evaluation is commit-sealed. Promotion only accepts an unchanged clean
candidate whose HEAD equals the evaluated commit. Generation mutation is
performed by `generations`, never by self-improvement directly.

If generation activation succeeds but promoted candidate/handoff state cannot
be persisted, self-improvement requests authoritative transactional rollback
before returning failure. If durable mission publication fails after promotion,
the same rule applies.

Lifecycle replacement is two-phase. The predecessor remains alive after the
successor reports full-graph readiness. The successor runs post-restart gates,
completes the durable handoff, then acknowledges takeover. If readiness or
takeover fails, the predecessor rolls back to the known-good generation. If the
predecessor has already disappeared, the successor can launch the recovered
generation after rollback.

Mission and candidate snapshots use atomic replacement so recovery never treats
partially written JSON as accepted state. Corrupt or incomplete durable mission
records fail closed.

## Consequences

Self-improvement is policy/orchestration, not a duplicate Git, evaluation,
Agent or process implementation. `worktrees`, `evaluation`, `generations` and
`lifecycle` remain independently testable/replaceable boundaries. Execution
isolation and authorization are supplied by the independent Sandbox and
Permissions capabilities rather than being reimplemented here. There is no
central application plugin to edit when an unrelated FRIDAY capability is added.
