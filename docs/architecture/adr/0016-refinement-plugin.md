# ADR 0016: Refinement Plugin

## Status

Accepted for the GEN-0 subsystem build sequence.

## Decision

`refinement` owns model-driven continual-state improvement while `memory` remains the durable state store.

The plugin owns:

- JSON proposal parsing and validation;
- create/update/delete refinement planning;
- rollback proposal generation;
- stale-plan conflict detection;
- model-backed manual refinement planning;
- model-backed automatic-refinement review decisions;
- application of accepted edits through an injected memory port;
- passive refinement result/history serialization helpers.

The implementation package receives model completion and memory-store access through narrow injected ports. It must not import sibling FRIDAY implementation packages.

## Boundaries

`refinement` does not own:

- memory file persistence or memory CRUD internals;
- session storage or branch history;
- scheduling, cooldown timers, or turn counters for automatic refinement;
- agent orchestration or conversation serialization;
- prompt-system composition;
- tools, skills, subagent execution, RLM transport, sandboxing, or permissions;
- candidate source-code mutation, evaluation, checkpoint promotion, or generation handoff.

The host supplies a serialized trajectory and any persisted detailed refinement history. A later orchestration/self-improvement layer may trigger refinement and persist detailed results through session/custom-entry facilities.
