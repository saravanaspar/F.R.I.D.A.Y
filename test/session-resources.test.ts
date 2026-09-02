import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { requireCapability } from "../plugins/capabilities/protocol.js";
import { SESSION_RESOURCES_CAPABILITY } from "../plugins/session-resources/contract.js";

describe("session resources plugin", () => {
  it("owns session-scoped cleanup outside the model plugin", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    const service = requireCapability(SESSION_RESOURCES_CAPABILITY);
    const seen: Array<string | undefined> = [];
    const unregister = service.registerSessionResourceCleanup((sessionId) => seen.push(sessionId));
    service.cleanupSessionResources("s-1");
    unregister();
    expect(seen).toEqual(["s-1"]);
  });
});
