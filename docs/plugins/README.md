# Contributing F.R.I.D.A.Y Plugins

Plugins are the preferred extension boundary for F.R.I.D.A.Y. You do not need to understand the entire runtime to add useful behavior; start with the domain that owns the capability and let the architecture checks enforce the boundaries around it.

This page is the contributor entry point. If you want a small copy-and-paste walkthrough of a first plugin, start with the [`plugin cookbook`](./cookbook.md). The authoritative rules live in [`../PLUGIN_DEVELOPMENT.md`](../PLUGIN_DEVELOPMENT.md).

## Before writing code

Run:

```bash
npm run inspect:plugins
```

The catalog is derived from the real `contract.ts` declarations and concrete contribution registrations. It shows existing capability, contribution, and hook surfaces plus statically discoverable contributed instances.

Before creating something new, check whether an existing plugin already owns the behavior. Reusing an existing typed capability or contribution is preferred to creating another owner for the same domain.

## The normal plugin path

1. **Choose the owner.** Put behavior in the plugin that owns the domain, not the plugin that happens to call it.
2. **Declare the public surface once.** Use a typed `defineCapability<T>`, `defineContribution<T>`, or `defineHook<T>` in the owner's `contract.ts`.
3. **Implement behind that contract.** Other plugins may consume the public contract; they must not import sibling implementation files directly.
4. **Register concrete contributions normally.** Agent tools, System actions/status, prompt sections, lifecycle participants, and similar instances are discovered from the real `.contribute(...)` registrations. Do not create a separate discovery manifest.
5. **Add focused tests.** Cover behavior and the important failure boundary for the capability.
6. **Run the gates.** At minimum:

```bash
npm run inspect:plugins
npm run check:architecture
npx tsc --noEmit
```

Run the relevant focused tests while iterating, then `npm run verify` before opening a PR.

## Good implementations to study

Choose the smallest example that resembles your change rather than copying a large orchestration plugin.

- [`plugins/alerts/`](../../plugins/alerts/) — capability plus small System status/action contributions.
- [`plugins/conditional-hooks/`](../../plugins/conditional-hooks/) — capability plus Agent prompt/tool and System contributions.
- [`plugins/sandbox/`](../../plugins/sandbox/) — typed provider/health boundaries and setup/status behavior.
- [`plugins/voice/`](../../plugins/voice/) — artifact enrichment plus user-facing setup/status behavior.
- [`plugins/memory/`](../../plugins/memory/) — a larger example with Agent tools and System actions; useful after you understand the smaller plugins.

## Discoverability is automatic

A contributor should never need to update a second plugin feature catalog.

The repository derives and verifies:

- configured ordinary plugin identity;
- typed capability/contribution/hook surface IDs and their public types;
- exported ordinary public contract types;
- surface-reachable public types;
- statically named concrete contribution instances and their owning plugin;
- dynamic/factory contribution registrations that cannot be assigned a static instance ID at source-analysis time.

Architecture checks fail when a public semantic service/contribution/hook type is orphaned, a declared surface is hidden/unexported, a static contribution ID conflicts on the same surface, or a plugin bypasses a sibling implementation boundary.

## Proposing a new plugin

Use the **Plugin proposal** issue form when there is no obvious existing owner. A good proposal answers:

- What user problem requires the capability?
- Why can an existing plugin/capability/MCP integration not solve it?
- Which trust boundary does it need?
- Does it persist state, access credentials, perform external writes, or require lifecycle authority?
- Which public capability/contribution/hook surface should other plugins consume?

For simple improvements to an existing plugin, open a normal feature issue instead.

## Contributor-friendly work

Look for:

- [`good first issue`](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
- [`help wanted`](https://github.com/saravanaspar/F.R.I.D.A.Y/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22)
- the public [`ROADMAP`](../ROADMAP.md)

Questions about architecture are welcome in GitHub Discussions once enabled; security vulnerabilities must follow [`../../SECURITY.md`](../../SECURITY.md) instead of a public issue or discussion.
