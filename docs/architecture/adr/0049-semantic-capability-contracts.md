# ADR 0049: Semantic capability contracts are the cross-plugin API

## Status

Accepted.

## Context

FRIDAY's Plugin Kernel already declares `requires`, `optional`, and `provides` as typed capabilities. Several older service contracts nevertheless exposed an entire implementation package through `service.api`. That made the dependency graph visible while leaving the callable boundary too broad: consumers could depend on concrete stores, module helpers, or test-oriented exports. It also made implementation replacement harder and gave self-improvement a weak signal for deciding whether existing behavior could be reused.

## Decision

1. `plugins/<owner>/contract.ts` is the ordinary reusable cross-plugin API for that owner. Narrow companion contracts such as `trusted-contract.ts` may exist for explicitly privileged host authority; they are not general reuse surfaces.
2. Capability services expose intentional members directly. A generic module-sized `api` property is forbidden.
3. Consumers declare the capability in `requires`/`optional` and obtain it through `ctx.services.require`/`optional`.
4. Non-runtime plugin code may import its own implementation package and the dependency-free operational-error utility, but may not import a sibling plugin implementation package. Ordinary sibling interaction goes through the sibling's semantic contract; privileged interaction uses a narrow authority contract only when the architecture explicitly grants it.
5. Implementation-specific types may be referenced by an owning contract when they are part of the stable public data shape, but concrete storage/transport/runtime ownership stays private.
6. Memory uses a structural `MemoryStoreService` plus `MemoryService.openStore` instead of exposing the concrete `MemoryStore` class, allowing a future backend such as MemPalace to implement the same semantic boundary.
7. Self-improvement feasibility receives a bounded source-derived catalog of every configured ordinary `contract.ts`. The catalog discovers callable capabilities/`*Service` APIs as well as typed contribution and hook extension points, while trusted/admin companion contracts remain intentionally excluded. Discovery is fail-closed: an unreadable/malformed configured ordinary contract blocks code placement rather than being treated as evidence that no reusable surface exists. Autonomous self-improvement candidates must search `plugins/*/contract.ts` before editing.
8. Privilege-specific operations should use a separate capability instead of broadening a common service. `model.registry`, for example, owns custom-model registration/removal while ordinary `model` remains the inference/read surface.
9. Architecture tests enforce these rules.

## Consequences

- New contributors can discover ordinary reusable APIs from one predictable file and get normal TypeScript completion; trusted/admin authority stays visibly separate.
- Plugin manifests remain concise; method names are not duplicated in `requires`/`provides` metadata.
- Consumers are insulated from implementation refactors and alternate providers become practical where the semantic contract is implementation-neutral.
- Self-improvement has a concrete API inventory for reuse-first placement decisions.
- Contract changes become deliberate public API changes and require compatible consumer/test updates.
