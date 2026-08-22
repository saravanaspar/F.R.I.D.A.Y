import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import {
  PLUGIN_KERNEL_CAPABILITY,
  activeCapabilityRegistry,
  collectContributions,
  defineCapability,
  defineContribution,
  defineHook,
  definePlugin,
  emitHook,
  getPluginManifest,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";

function handler() {
  return new PluginTestHost();
}

afterEach(() => uninstallCapabilityRegistry());

describe("Plugin Kernel v2", () => {
  it("resolves declarative dependencies independent of config discovery order", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const source = defineCapability<number>("test.source");
    const derived = defineCapability<number>("test.derived");
    const activationOrder: string[] = [];

    const consumer = definePlugin(
      { id: "consumer", requires: [source], provides: [derived] },
      (ctx) => {
        activationOrder.push("consumer");
        ctx.services.provide(derived, ctx.services.require(source) + 1);
      },
    );
    const provider = definePlugin(
      { id: "provider", provides: [source] },
      (ctx) => {
        activationOrder.push("provider");
        ctx.services.provide(source, 41);
      },
    );

    await friday.activatePlugin(consumer, { defer: true });
    await friday.activatePlugin(provider, { defer: true });
    await friday.completePluginBootstrap();

    expect(activationOrder).toEqual(["provider", "consumer"]);
    expect(requireCapability(derived)).toBe(42);
  });

  it("prefers available optional providers and always activates last-stage plugins last", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const optionalService = defineCapability<string>("test.optional");
    const order: string[] = [];

    const last = definePlugin({ id: "last", activation: "last" }, () => { order.push("last"); });
    const consumer = definePlugin(
      { id: "optional-consumer", optional: [optionalService] },
      (ctx) => { order.push(ctx.services.has(optionalService) ? "consumer-with-optional" : "consumer-without-optional"); },
    );
    const provider = definePlugin(
      { id: "optional-provider", provides: [optionalService] },
      (ctx) => {
        order.push("optional-provider");
        ctx.services.provide(optionalService, "ready");
      },
    );

    await friday.activatePlugin(last, { defer: true });
    await friday.activatePlugin(consumer, { defer: true });
    await friday.activatePlugin(provider, { defer: true });
    await friday.completePluginBootstrap();

    expect(order).toEqual(["optional-provider", "consumer-with-optional", "last"]);
  });

  it("runs graph-ready callbacks only after the complete graph activates", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const order: string[] = [];

    await friday.activatePlugin(definePlugin({ id: "ready-first" }, (ctx) => {
      order.push("activate-first");
      ctx.afterReady(() => { order.push("ready-first"); });
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "ready-second" }, (ctx) => {
      order.push("activate-second");
      ctx.afterReady(() => { order.push("ready-second"); });
    }), { defer: true });

    expect(order).toEqual([]);
    await friday.completePluginBootstrap();
    expect(order).toEqual(["activate-first", "activate-second", "ready-first", "ready-second"]);
  });

  it("rolls back the whole graph when graph-ready work fails", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const disposed: string[] = [];

    await friday.activatePlugin(definePlugin({ id: "ready-cleanup-first" }, (ctx) => {
      ctx.effect(() => { disposed.push("first"); });
      ctx.afterReady(() => { throw new Error("ready-boom"); });
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "ready-cleanup-second" }, (ctx) => {
      ctx.effect(() => { disposed.push("second"); });
    }), { defer: true });

    await expect(friday.completePluginBootstrap()).rejects.toThrow(
      "Plugin ready-cleanup-first graph-ready failed: ready-boom",
    );
    expect(disposed).toEqual(["second", "first"]);
  });

  it("fails closed on missing providers, cycles, duplicate providers, and undeclared services", async () => {
    {
      const friday = handler();
      await friday.activatePlugin(capabilitiesPlugin);
      const missing = defineCapability<string>("test.missing");
      await friday.activatePlugin(definePlugin({ id: "needs-missing", requires: [missing] }, () => {}), { defer: true });
      await expect(friday.completePluginBootstrap()).rejects.toThrow("Missing plugin capability providers");
      uninstallCapabilityRegistry();
    }

    {
      const friday = handler();
      await friday.activatePlugin(capabilitiesPlugin);
      const a = defineCapability<string>("test.cycle-a");
      const b = defineCapability<string>("test.cycle-b");
      await friday.activatePlugin(definePlugin({ id: "cycle-a", requires: [b], provides: [a] }, (ctx) => ctx.services.provide(a, "a")), { defer: true });
      await friday.activatePlugin(definePlugin({ id: "cycle-b", requires: [a], provides: [b] }, (ctx) => ctx.services.provide(b, "b")), { defer: true });
      await expect(friday.completePluginBootstrap()).rejects.toThrow("Plugin dependency cycle");
      uninstallCapabilityRegistry();
    }

    {
      const friday = handler();
      await friday.activatePlugin(capabilitiesPlugin);
      const shared = defineCapability<string>("test.shared");
      await friday.activatePlugin(definePlugin({ id: "provider-a", provides: [shared] }, (ctx) => ctx.services.provide(shared, "a")), { defer: true });
      await friday.activatePlugin(definePlugin({ id: "provider-b", provides: [shared] }, (ctx) => ctx.services.provide(shared, "b")), { defer: true });
      await expect(friday.completePluginBootstrap()).rejects.toThrow("declared by multiple plugins");
      uninstallCapabilityRegistry();
    }

    {
      const friday = handler();
      await friday.activatePlugin(capabilitiesPlugin);
      const undeclared = defineCapability<string>("test.undeclared");
      const plugin = definePlugin({ id: "undeclared-provider" }, (ctx) => ctx.services.provide(undeclared, "nope"));
      await expect(friday.activatePlugin(plugin)).rejects.toThrow("provided undeclared capability");
      uninstallCapabilityRegistry();
    }

    {
      const friday = handler();
      await friday.activatePlugin(capabilitiesPlugin);
      const hidden = defineCapability<string>("test.hidden-consumer");
      const provider = definePlugin({ id: "hidden-provider", provides: [hidden] }, (ctx) => ctx.services.provide(hidden, "ready"));
      const consumer = definePlugin({ id: "hidden-consumer" }, (ctx) => {
        ctx.services.require(hidden);
      });
      await friday.activatePlugin(provider);
      await expect(friday.activatePlugin(consumer)).rejects.toThrow("accessed undeclared capability");
    }
  });

  it("owns capabilities, contributions, hooks, and custom effects for reversible disposal", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const service = defineCapability<string>("test.reversible-service");
    const tools = defineContribution<string>("test.tools");
    const lifecycle = defineHook<string>("test.lifecycle");
    const seen: string[] = [];
    const disposed: string[] = [];

    const plugin = definePlugin({ id: "reversible", provides: [service] }, (ctx) => {
      ctx.services.provide(service, "active");
      ctx.contribute(tools, "browser");
      ctx.on(lifecycle, (event) => { seen.push(event); });
      ctx.effect(() => { disposed.push("custom"); });
    });

    await friday.activatePlugin(plugin);
    expect(requireCapability(service)).toBe("active");
    expect(collectContributions(tools)).toEqual(["browser"]);
    await emitHook(lifecycle, "before-dispose");
    expect(seen).toEqual(["before-dispose"]);

    await requireCapability(PLUGIN_KERNEL_CAPABILITY).dispose("reversible");
    expect(collectContributions(tools)).toEqual([]);
    expect(disposed).toEqual(["custom"]);
    expect(() => requireCapability(service)).toThrow("Capability not available");
    await emitHook(lifecycle, "after-dispose");
    expect(seen).toEqual(["before-dispose"]);
  });

  it("protects required providers from disposal unless dependent plugins are cascaded", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const base = defineCapability<string>("test.base");
    const dependent = defineCapability<string>("test.dependent");

    const provider = definePlugin({ id: "base-provider", provides: [base] }, (ctx) => ctx.services.provide(base, "base"));
    const consumer = definePlugin(
      { id: "base-consumer", requires: [base], provides: [dependent] },
      (ctx) => ctx.services.provide(dependent, ctx.services.require(base) + ":dependent"),
    );

    await friday.activatePlugin(provider);
    await friday.activatePlugin(consumer);
    const kernel = requireCapability(PLUGIN_KERNEL_CAPABILITY);
    await expect(kernel.dispose("base-provider")).rejects.toThrow("required by: base-consumer");
    await kernel.dispose("base-provider", { cascade: true });
    expect(() => requireCapability(base)).toThrow("Capability not available");
    expect(() => requireCapability(dependent)).toThrow("Capability not available");
  });

  it("attempts every plugin shutdown even when one disposer fails", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const disposed: string[] = [];
    await friday.activatePlugin(definePlugin({ id: "shutdown-first" }, (ctx) => {
      ctx.effect(() => { disposed.push("first"); });
    }));
    await friday.activatePlugin(definePlugin({ id: "shutdown-failing" }, (ctx) => {
      ctx.effect(() => { disposed.push("failing"); throw new Error("shutdown-boom"); });
    }));
    await friday.activatePlugin(definePlugin({ id: "shutdown-last" }, (ctx) => {
      ctx.effect(() => { disposed.push("last"); });
    }));

    const kernel = requireCapability(PLUGIN_KERNEL_CAPABILITY);
    await expect(kernel.disposeAll()).rejects.toThrow("Plugin shutdown failed");
    expect(disposed).toEqual(["last", "failing", "first"]);
  });

  it("makes explicit effect unregister await and surface asynchronous disposer failures", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    let unregister: (() => Promise<void>) | undefined;
    await friday.activatePlugin(definePlugin({ id: "manual-async-cleanup" }, (ctx) => {
      unregister = ctx.effect(async () => {
        await Promise.resolve();
        throw new Error("async-cleanup-boom");
      });
    }));

    expect(unregister).toBeDefined();
    await expect(unregister!()).rejects.toThrow("async-cleanup-boom");
  });

  it("rolls back activated plugins when graph activation fails and keeps bootstrap failure sticky", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const base = defineCapability<string>("test.rollback-base");
    const disposed: string[] = [];
    const rollbackContributions = defineContribution<string>("test.rollback-contributions");

    const provider = definePlugin({ id: "rollback-provider", provides: [base] }, (ctx) => {
      ctx.services.provide(base, "ready");
      ctx.contribute(rollbackContributions, "provider");
      ctx.effect(() => { disposed.push("provider"); });
    });
    const failing = definePlugin({ id: "rollback-failing", requires: [base] }, (ctx) => {
      ctx.contribute(rollbackContributions, "failing");
      ctx.effect(() => { disposed.push("failing"); });
      throw new Error("activation-boom");
    });

    await friday.activatePlugin(failing, { defer: true });
    await friday.activatePlugin(provider, { defer: true });
    const kernel = requireCapability(PLUGIN_KERNEL_CAPABILITY);
    const registry = activeCapabilityRegistry();

    await expect(friday.completePluginBootstrap()).rejects.toThrow("activation-boom");

    expect(disposed).toEqual(["failing", "provider"]);
    expect(kernel.collect(rollbackContributions)).toEqual([]);
    expect(registry.has(base)).toBe(false);
    expect(() => requireCapability(base)).toThrow("Capability composition plugin is not active");

    await expect(kernel.finalize()).rejects.toThrow("Plugin bootstrap previously failed: Plugin rollback-failing activation failed: activation-boom");
    await expect(kernel.register({ id: "late-plugin" }, () => {}, { deferred: true }))
      .rejects.toThrow("Plugin discovery is already finalized");
  });

  it("preserves activation and cleanup failures together", async () => {
    const friday = handler();
    await friday.activatePlugin(capabilitiesPlugin);
    const plugin = definePlugin({ id: "cleanup-failure" }, (ctx) => {
      ctx.effect(() => { throw new Error("cleanup-boom"); });
      throw new Error("activation-boom");
    });

    await expect(friday.activatePlugin(plugin)).rejects.toThrow(
      "activation-boom; activation cleanup also failed: cleanup-boom",
    );
  });

  it("exposes immutable manifests before functional activation", () => {
    const capability = defineCapability<string>("test.manifest");
    const plugin = definePlugin({ id: "manifested", provides: [capability] }, () => {});
    const manifest = getPluginManifest(plugin);
    expect(manifest).toMatchObject({ id: "manifested", activation: "normal" });
    expect(manifest?.provides.map((entry) => entry.id)).toEqual(["test.manifest"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(() => definePlugin({ id: "bad-activation", activation: "sometimes" as never }, () => {}))
      .toThrow("Invalid plugin activation class");
  });
});
