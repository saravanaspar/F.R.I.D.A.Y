# ADR-0022: Transactional Executable Generation Rollback

## Status
Accepted

## Decision
`generations` owns rollback execution, not only rollback planning. A rollback is
published as a durable transaction before repository HEAD moves. Recovery may
observe either the old or target HEAD and completes the same transaction without
silently choosing a third state.

Rollback requires a clean primary checkout, exact active/target pinned refs,
active-lineage membership, an exact expected HEAD, and stale-plan validation.
After the journal exists, cancellation cannot leave HEAD and the durable active
generation pointer split.

## Rationale
Self-improvement cannot safely promote code unless failed startup can restore a
known-good generation after process crashes at any rollback publication window.
Raw reset/checkout policy does not belong in self-improvement.

## Consequences
- `self-improvement` or another generations consumer may request rollback through the capability.
- `generations` remains the only layer that performs the guarded primary-checkout transition.
- interrupted rollback is recovered before a new promotion/resume decision.
