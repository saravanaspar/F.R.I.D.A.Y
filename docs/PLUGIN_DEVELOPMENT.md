# F.R.I.D.A.Y Plugin Development

F.R.I.D.A.Y is plugin-first. A feature belongs in a plugin when it owns reusable domain behavior, an integration/transport, model-facing tooling, durable state, or an authority boundary. `src/` is reserved for host boot, setup/CLI, and generic composition.

## 1. Start with a contract

A plugin declares what it **requires**, what it can **optionally consume**, what it **provides**, and any typed multi-provider **contributions**. Do not import another plugin's implementation package directly just because it is convenient.

```ts
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface ExampleService {
  status(): Readonly<{ configured: boolean }>;
}

export const EXAMPLE_CAPABILITY: Capability<ExampleService> =
  defineCapability<ExampleService>("example");
```

Then activate it through `definePlugin`:

```ts
const plugin = definePlugin(
  {
    id: "example",
    requires: [PERMISSIONS_CAPABILITY],
    optional: [EVENTS_CAPABILITY],
    provides: [EXAMPLE_CAPABILITY],
  },
  (ctx) => {
    const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
    const events = ctx.services.optional(EVENTS_CAPABILITY);

    const service = Object.freeze({
      status: () => Object.freeze({ configured: false }),
    });

    ctx.services.provide(EXAMPLE_CAPABILITY, service);
  },
);
```

The Plugin Kernel validates the complete graph and activation order. Never rely on the textual order in `friday.config.json` as orchestration.

### Public API rule

`plugins/<owner>/contract.ts` is the source of truth for the owner's ordinary reusable cross-plugin API. A capability service exposes intentional semantic members directly; it must not hand consumers an entire implementation module through a generic `api` bag. Security-sensitive owners may additionally expose deliberately narrow companion authority contracts (for example `trusted-contract.ts`); those are not general reuse surfaces and must not be imported merely to avoid using the ordinary contract.

```ts
const memory = ctx.services.require(MEMORY_CAPABILITY);
const store = memory.openStore({ stateDir, scope: "global" });
const matches = store.search("release decision");
```

Do **not** write `memory.api.MemoryStore`, import `@friday/memory` from another plugin, reach into `plugins/memory/runtime/*`, **or use a relative path to another plugin's implementation file** such as `../memory/store.js`. Cross-plugin imports are limited to the owner's ordinary `contract.ts`, an explicitly authorized narrow `trusted-contract.ts`, and the shared capability protocol. If the required semantic operation already exists in the contract, reuse it. If it does not, first decide whether extending the owning contract is the correct responsibility boundary before creating another implementation.

This rule also applies to self-improvement. Before generating code, the feasibility reviewer receives a bounded catalog derived from **every configured ordinary `contract.ts`** plus the configured plugins' actual `ctx.contribute(...)` registrations. The catalog discovers three different reusable surfaces directly from source: callable capability ids plus their exported `*Service` interfaces, typed multi-provider contribution ids, and hook ids. It also attributes concrete statically named contribution instances (for example `memory-recall` under `agent.tool` or `memory.review` under `system.action`) to the plugin that registers them; factory/runtime-derived registrations are counted explicitly as dynamic instead of silently disappearing. Relevant exported public interfaces/types are included as bounded source detail. Trusted/admin companion contracts are intentionally excluded. If any configured ordinary contract cannot be read or has no discoverable typed surface, reuse discovery is incomplete and self-improvement fails closed before code placement instead of assuming nothing reusable exists.

For a new developer: search `plugins/*/contract.ts`. For a callable service, open the relevant `*Service` interface, add its capability to `requires` or `optional`, then obtain it with `ctx.services.require(...)` or `ctx.services.optional(...)`. For extensibility, reuse the owning `Contribution`/`Hook` type and `ctx.contribute(...)` / `ctx.on(...)` rather than inventing another direct dependency. TypeScript/IDE completion is the authoritative method listing; do not maintain a second manual list of API method names in the plugin manifest. The self-improvement reuse catalog reads these ordinary contracts rather than privilege-escalating through trusted companion APIs.

### Machine-discoverability rule

Every configured domain plugin must have `plugins/<id>/contract.ts` and expose at least one typed `defineCapability(...)`, `defineContribution(...)`, or `defineHook(...)` identifier. **There is no second manual discovery registry to update.** Declare the real public surface once as an exported constant in the ordinary contract (`export const FOO_CAPABILITY = defineCapability<FooService>("foo")`); architecture checks, developer inspection, and self-improvement derive the id/type binding automatically from that declaration. The same rule applies to contributions and hooks.

Each surface definition must bind directly to one exported public type, callable capabilities must bind to an exported semantic `*Service` interface, and the owning plugin must list every ordinary capability it defines in its manifest `provides[]`. A future edit that defines a surface in an implementation file, hides a `define*` value in a non-exported constant, or exports a new semantic `*Service` / `*Contribution` / `*Hook` interface without connecting it to any public surface fails `npm run check:architecture`. This makes "forgot to expose the new API" a CI error instead of a convention reviewers have to remember.

All ordinary exported contract types are also inventoried automatically, including named `export type { ... }` re-exports used for public DTOs/domain types. Auxiliary public data types do not need their own capability id; they remain discoverable as public types and should be reachable from the semantic service/contribution/hook that uses them when they represent part of that API. Concrete contribution ownership is derived from the registration call itself, so adding a new literal `ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, { id: "example.action", ... })` automatically updates the developer/self-improvement inventory; there is no extra registration list to maintain. Duplicate static ids on the same contribution surface fail architecture validation. Trusted/admin companion contracts remain intentionally outside model/self-improvement reuse discovery; they are authority boundaries, not ordinary reusable APIs.

A plugin's manifest id must match its configured directory identity, and surface ids are unique per kind across configured ordinary contracts. The `capabilities` composition microkernel is the deliberate exception because it implements the plugin protocol itself rather than a reusable domain contract. `npm run check:architecture` enforces these rules for the entire configured plugin list **and rejects direct relative imports into sibling plugin implementation files**, so the contract cannot be bypassed accidentally.

Use:

```bash
npm run inspect:plugins
npm --silent run inspect:plugins:json
```

The first command prints the generated capability/contribution/hook inventory, then a contributor table showing each statically discoverable registered instance with its owning plugin/source location and any explicitly dynamic registrations, plus public-type counts. The JSON form contains every configured ordinary plugin, every surface id/type binding, every exported ordinary public type, the set reachable from semantic surfaces, and grouped contribution-instance ownership, so humans, CI, or another AI can audit discoverability without maintaining a hand-written list.

## 2. Boot safely while unconfigured

An integration must be able to activate without credentials or pairing state. Report an explicit `unconfigured` / `auth-required` status and wait for a trusted setup action. Do not make plugin activation depend on a secret already existing.

This matters for self-improvement: a newly built capability must survive the successor's full plugin-graph boot **before** credentials are requested.

## 3. Secrets belong in Vault

Never put API keys, OAuth refresh tokens, passwords, cookies, or private keys in model-visible tool arguments, plugin metadata, logs, or `runtime.env`.

Use trusted credential/Vault capabilities and opaque secret references. Consume plaintext only inside the smallest trusted callback that actually performs the authenticated operation. Reuse the shared operational-error redactor for diagnostics rather than inventing a weaker local scrubber.

## 4. Declare authority through Permissions

Every externally meaningful read/write, credential mutation, system mutation, or network-bearing action must describe its effect accurately. Model prose does not grant authority.

For model-facing commands that need internet access, expose an explicit `network: true` request. Sandbox egress is off by default; Permissions routes a network-bearing action through the normal approval path and exact originating trusted-channel principal **even in `full` mode**. A host may deliberately override the sandbox to unrestricted networking, but Doctor warns because `requested` is the secure default.

Do not hide network access inside an action whose permission metadata claims it is offline.

## 5. Use contributions for extensibility

Common contribution surfaces include:

- `agent.tool` for model-facing tools;
- `system.action` / `system.status` for trusted bounded system operations;
- scheduler actions for future work;
- lifecycle/active-work contributions for restart coordination.

The owning plugin contributes the behavior. Central executors should discover contributions generically rather than grow feature-specific imports or switch statements.

## 6. Own lifecycle cleanup

If activation opens sockets, starts workers, registers callbacks, mounts sandbox paths, or spawns managed processes, register reversible cleanup through the plugin activation context. A failed activation or shutdown must not leak resources into the next runtime.

Long-running/durable work must define its crash/restart behavior explicitly rather than relying on in-memory promises.

## 7. Durable state is persistence-first

For behavior that can cause an external side effect or be replayed after restart:

1. durably admit/record the operation;
2. perform the side effect;
3. durably record the result/idempotency data;
4. only then acknowledge externally where possible.

Corrupt security-sensitive state should fail closed or be quarantined; do not silently reset it to empty state.

## 8. Events are occurrences, not authority

Use Events for durable occurrences and consumer delivery. Do not treat an Event payload as trusted authorization. Trusted identity comes from the host/channel principal and Permissions boundary.

## 9. Tests expected for a plugin

At minimum, add tests for:

- clean activation while unconfigured;
- configured happy path;
- permission/effect metadata for mutations and network;
- malformed/corrupt persisted state;
- secret non-disclosure/redaction where applicable;
- lifecycle cleanup;
- retry/restart/idempotency for durable or externally effectful behavior;
- architecture-boundary compliance.

Run:

```bash
npm run check:architecture
npm run check:packaging
npm run typecheck
npm test
npm run test:workspaces
```

Before merging to `main`, the full gate is:

```bash
npm run setup:execution-python
npm run verify
```

## 10. Adding a built-in plugin

Follow the existing plugin directory shape and manifest/package conventions. A folder under `plugins/` is **not** discovered automatically: `friday.config.json` is the installed built-in plugin list. Add the new `./plugins/<name>/index.ts` entry there, then run `npm run generate:builtin-plugins`. The generated `src/builtin-plugins.ts` is used by the single-executable distribution and must never be hand-edited. Source mode dynamically imports the same configured entrypoints; the SEA runtime resolves those logical entries from the generated bundled registry.

Run `npm run check:architecture` after every dependency-edge change. Direct sibling runtime imports, undeclared capabilities, or hidden host-domain logic are architecture regressions even if unit tests happen to pass.

## Review checklist

A plugin is ready when its ownership is clear, dependencies are declared, unconfigured boot is safe, secrets remain host-owned, effects/network are permissioned accurately, resources clean up, durable work recovers deterministically, and tests prove the failure paths—not only the happy path.
