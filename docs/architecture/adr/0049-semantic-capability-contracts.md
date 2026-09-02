# ADR 0049: Semantic capability contracts are the cross-plugin API

## Status

Accepted.

## Context

FRIDAY's Plugin Kernel already declares `requires`, `optional`, and `provides` as typed capabilities. Several older service contracts nevertheless exposed an entire implementation package through `service.api`. That made the dependency graph visible while leaving the callable boundary too broad: consumers could depend on concrete stores, module helpers, or test-oriented exports. It also made implementation replacement harder and gave self-improvement a weak signal for deciding whether existing behavior could be reused.

## Decision

1. `plugins/<owner>/contract.ts` is the only public cross-plugin API for that owner.
2. Capability services expose intentional members directly. A generic module-sized `api` property is forbidden.
3. Consumers declare the capability in `requires`/`optional` and obtain it through `ctx.services.require`/`optional`.
4. Non-runtime plugin code may import its own implementation package and the dependency-free operational-error utility, but may not import a sibling plugin implementation package. Sibling interaction goes through the sibling contract.
5. Implementation-specific types may be referenced by an owning contract when they are part of the stable public data shape, but concrete storage/transport/runtime ownership stays private.
6. Memory uses a structural `MemoryStoreService` plus `MemoryService.openStore` instead of exposing the concrete `MemoryStore` class, allowing a future backend such as MemPalace to implement the same semantic boundary.
7. Self-improvement feasibility receives a bounded source-derived catalog of configured capability contracts and must consider reuse before code generation. Autonomous self-improvement candidates must search `plugins/*/contract.ts` before editing.
8. Architecture tests enforce these rules.

## Consequences

- New contributors can discover reusable APIs from one predictable file and get normal TypeScript completion.
- Plugin manifests remain concise; method names are not duplicated in `requires`/`provides` metadata.
- Consumers are insulated from implementation refactors and alternate providers become practical where the semantic contract is implementation-neutral.
- Self-improvement has a concrete API inventory for reuse-first placement decisions.
- Contract changes become deliberate public API changes and require compatible consumer/test updates.
