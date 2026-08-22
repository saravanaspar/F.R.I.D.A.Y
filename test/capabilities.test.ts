import { afterEach, describe, expect, it } from "vitest";
import capabilityCompositionPlugin, { MapCapabilityRegistry } from "../plugins/capabilities/index.js";
import {
  activeCapabilityRegistry,
  defineCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

afterEach(() => {
  uninstallCapabilityRegistry();
});

describe("capability composition plugin", () => {
  it("installs the registry through an ordinary FRIDAY plugin", async () => {
    const friday = new PluginTestHost();

    await friday.activatePlugin(capabilityCompositionPlugin);

    expect(activeCapabilityRegistry()).toBeInstanceOf(MapCapabilityRegistry);
  });

  it("provides and resolves typed opaque capabilities", () => {
    const registry = new MapCapabilityRegistry();
    const answer = defineCapability<number>("example.answer");

    registry.provide(answer, 42);

    expect(registry.has(answer)).toBe(true);
    expect(registry.require(answer)).toBe(42);
    expect(registry.ids()).toEqual(["example.answer"]);
  });

  it("rejects duplicate providers", () => {
    const registry = new MapCapabilityRegistry();
    const answer = defineCapability<number>("example.answer");

    registry.provide(answer, 42);

    expect(() => registry.provide(answer, 43)).toThrow("Capability already provided: example.answer");
  });

  it("reports missing capabilities", () => {
    const registry = new MapCapabilityRegistry();
    const missing = defineCapability<string>("example.missing");

    expect(() => registry.require(missing)).toThrow("Capability not available: example.missing");
  });
});
