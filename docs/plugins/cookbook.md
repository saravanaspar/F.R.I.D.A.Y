# F.R.I.D.A.Y Plugin Cookbook

This cookbook walks through a complete, copyable example of a tiny F.R.I.D.A.Y
plugin. It is the shortest path from zero to a working typed capability plus one
contributed `system.action`.

For the full architecture rules (contracts, authority boundaries, secrets,
lifecycle, persistence, and the review checklist) read
[`../PLUGIN_DEVELOPMENT.md`](../PLUGIN_DEVELOPMENT.md) before writing a
production plugin. This page intentionally lives outside that file: it is a
playground you can copy, not the authoritative spec.

## Before you start

- Node.js `>=22.8.0` (repo pins `22.22.2`; see `.node-version`)
- `npm ci` at the repository root
- The two commands you will run to verify everything:

```bash
npm run inspect:plugins
npm run check:architecture
```

## What we are building

A tiny **`greetings`** plugin that:

1. declares one typed capability (`GreetingsService`) in `contract.ts`;
2. activates that capability through `definePlugin(...)`;
3. contributes one concrete `system.action` (`greetings.list`) that anyone can
   call as a trusted system operation.

```text
plugins/greetings/
  contract.ts   # typed capability + service interface
  index.ts      # definePlugin(...) implementation
```

There is no production value here — that is the point. The shape is what
matters, and every real plugin follows it.

## 1. `contract.ts` — declare the typed capability

```ts
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export interface Greeting {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/** Ordinary reusable cross-plugin API surface. */
export interface GreetingsService {
  /** List all greetings managed by this plugin. */
  list(): readonly Greeting[];
}

export const GREETINGS_CAPABILITY: Capability<GreetingsService> =
  defineCapability<GreetingsService>("greetings");
```

Why it looks like this:

- `defineCapability<GreetingsService>("greetings")` binds the capability id
  `greetings` to the exported `GreetingsService` interface. The name is the
  contract; the exported constant is the only place it lives.
- The machine-discoverability rule in
  [`PLUGIN_DEVELOPMENT.md`](../PLUGIN_DEVELOPMENT.md) says every configured
  plugin must expose at least one typed `defineCapability(...)`,
  `defineContribution(...)`, or `defineHook(...)` in its `contract.ts`. There is
  no second manual registry to update.
- Capability ids are unique per kind across configured ordinary contracts. Do
  not guess a name that another plugin already uses.

## 2. `index.ts` — implement and activate the plugin

```ts
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  GREETINGS_CAPABILITY,
  type Greeting,
  type GreetingsService,
} from "./contract.js";

const greetingsPlugin: FridayPlugin = definePlugin(
  {
    id: "greetings",
    provides: [GREETINGS_CAPABILITY],
  },
  (ctx) => {
    // In-memory-only example state. A production plugin that must survive a
    // restart would persist durably before acknowledging externally (see
    // PLUGIN_DEVELOPMENT.md section 7).
    const greetings: Greeting[] = [];

    const service: GreetingsService = Object.freeze({
      list: () => greetings,
    });

    ctx.services.provide(GREETINGS_CAPABILITY, service);

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "greetings.list",
      label: "List greetings",
      description: "List all greetings managed by the greetings plugin.",
      parameters: Object.freeze({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      permission() {
        return {
          id: "greetings.list",
          effect: "private-read",
          resource: "greetings",
          network: false,
        };
      },
      execute(_input: Readonly<SystemJsonObject>) {
        return Object.freeze({ greetings: service.list() });
      },
    });
  },
);

export default greetingsPlugin;
export * from "./contract.js";
```

Key points:

- `definePlugin({ id, requires?, optional?, provides? }, (ctx) => ...)`: `id`
  must match the configured directory identity (`plugins/greetings/`), and
  every ordinary capability you define must appear in `provides`.
- `ctx.services.provide(GREETINGS_CAPABILITY, service)`: this is how other
  plugins obtain your service — always through the contract, never by importing
  your implementation file.
- `ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {...})`: registers one concrete,
  statically named system action. `inspect:plugins` will discover it
  automatically from this registration call — there is no extra inventory list.
- Every System action must declare `permission()` metadata. Use the narrowest
  `effect`, `resource`, and `network` authority appropriate for the action.
  Model prose never grants authority.
- The contribution id (`greetings.list`) must be unique on its surface —
  duplicate static ids on the same contribution kind fail `check:architecture`.

## 3. The smallest useful test

Put a focused test next to the other plugin tests, for example
`test/greetings.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import {
  collectContributions,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import { GREETINGS_CAPABILITY } from "../plugins/greetings/contract.js";
import greetingsPlugin from "../plugins/greetings/index.js";

afterEach(() => uninstallCapabilityRegistry());

describe("greetings plugin", () => {
  it("activates cleanly and contributes a greetings.list system action", async () => {
    const host = new PluginTestHost();
    // The capabilities plugin implements the plugin protocol itself and is a
    // deliberate exception to the "no sibling implementation imports" rule.
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(greetingsPlugin);
    await host.completePluginBootstrap();

    const service = requireCapability(GREETINGS_CAPABILITY);
    expect(service.list()).toEqual([]);

    // The contributed System action must be reachable on the real
    // contribution registry, keyed by its id on the system.action surface.
    const listAction = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find(
      (action) => action.id === "greetings.list",
    );
    expect(listAction).toBeDefined();
    expect(listAction!.permission({})).toMatchObject({
      id: "greetings.list",
      effect: "private-read",
      network: false,
    });

    await host.dispose();
  });
});
```

Zoom out: the entire goal of this test is to prove the plugin activates while
unconfigured (no secrets, no external assumptions), exposes its capability, and
contributes the expected System action with its permission metadata.
Production plugins also test the configured happy path, permission/effect
metadata, malformed persisted state, lifecycle cleanup, and
retry/restart/idempotency — see the test expectations in
[`PLUGIN_DEVELOPMENT.md`](../PLUGIN_DEVELOPMENT.md) section 9.

## 4. Registering the plugin

A folder under `plugins/` is **not** discovered automatically. The installed
built-in plugin list lives in `friday.config.json`. To add `greetings` as a
built-in plugin you would:

1. add `./plugins/greetings/index.ts` to `friday.config.json`;
2. run `npm run generate:builtin-plugins`;
3. re-run `npm run check:architecture`.

Then you can read the plugin's capabilities from the output of:

```bash
npm --silent run inspect:plugins:json
```

This step matters for what `inspect:plugins` reports below: the focused test
from section 3 runs before registration, but `inspect:plugins` and the
configured plugin inventory only include `greetings` **after** it has been
registered in `friday.config.json` and the builtin list has been regenerated.

## 5. Verify

Run the focused test first; it proves the plugin activates cleanly even before
registration:

```bash
npx vitest run test/greetings.test.ts
```

Then, from the repository root, run the configured inventory checks (after the
registration step from section 4):

```bash
npm run inspect:plugins
npm run check:architecture
```

`inspect:plugins` prints the generated capability/contribution/hook inventory
derived from the real `contract.ts` declarations and actual `.contribute(...)`
registrations. Once the plugin is registered, its rows appear automatically:

- a `greetings` capability row bound to `GreetingsService`, and
- a `greetings.list` `system.action` row attributed to
  `plugins/greetings/index.ts`.

`check:architecture` runs the plugin boundary check plus the builtin-plugin
registry check. If you forget to expose the capability or register a duplicate
contribution id, this fails with a precise message.

For a plugin with its own runtime workspace, tests live under
`plugins/<id>/runtime/test/` and run through the workspace runner
(`npm run test:workspaces`).

## Next steps

- [`docs/plugins/README.md`](./README.md) — the contributor entry point
- [`docs/PLUGIN_DEVELOPMENT.md`](../PLUGIN_DEVELOPMENT.md) — the authoritative
  architecture and review rules
- [`plugins/conditional-hooks/`](../../plugins/conditional-hooks/) — a small
  plugin with typed `system.action` and `agent.tool` contributions
- [`plugins/host-privileges/`](../../plugins/host-privileges/) — a tiny
  capability-plus-action plugin