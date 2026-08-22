import { describe, expect, it } from "vitest";
import { createPluginBootstrapSession } from "../src/bootstrap.js";
import {
  PLUGIN_BOOTSTRAP_DEFERRED,
  PLUGIN_BOOTSTRAP_DISPOSER,
  PLUGIN_BOOTSTRAP_FINALIZER,
  type FridayPlugin,
} from "../src/plugin.js";

describe("FRIDAY plugin bootstrap protocol", () => {
  it("exposes no string-keyed application or command API", async () => {
    const bootstrap = createPluginBootstrapSession();
    let exposed: PropertyKey[] = [];

    const plugin: FridayPlugin = (api) => {
      exposed = Reflect.ownKeys(api);
    };

    await bootstrap.activatePlugin(plugin);
    expect(exposed.filter((key) => typeof key === "string")).toEqual([]);
    expect(new Set(exposed)).toEqual(new Set([
      PLUGIN_BOOTSTRAP_FINALIZER,
      PLUGIN_BOOTSTRAP_DISPOSER,
      PLUGIN_BOOTSTRAP_DEFERRED,
    ]));
    await bootstrap.dispose();
  });

  it("supports asynchronous plugin entrypoints and generic finalization", async () => {
    const bootstrap = createPluginBootstrapSession();
    const order: string[] = [];

    const plugin: FridayPlugin = async (api) => {
      await Promise.resolve();
      order.push("discovered");
      api[PLUGIN_BOOTSTRAP_FINALIZER](() => { order.push("finalized"); });
      api[PLUGIN_BOOTSTRAP_DISPOSER](() => { order.push("disposed"); });
    };

    await bootstrap.activatePlugin(plugin);
    expect(order).toEqual(["discovered"]);
    await bootstrap.complete();
    expect(order).toEqual(["discovered", "finalized"]);
    await bootstrap.dispose();
    expect(order).toEqual(["discovered", "finalized", "disposed"]);
  });

  it("does not hide plugin or finalizer failures", async () => {
    const activation = createPluginBootstrapSession();
    await expect(activation.activatePlugin(() => { throw new Error("plugin-boom"); }))
      .rejects.toThrow("plugin-boom");
    await activation.dispose();

    const finalization = createPluginBootstrapSession();
    await finalization.activatePlugin((api) => {
      api[PLUGIN_BOOTSTRAP_FINALIZER](() => { throw new Error("finalize-boom"); });
    });
    await expect(finalization.complete()).rejects.toThrow("finalize-boom");
  });
});
