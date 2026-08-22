import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import { EXECUTION_CAPABILITY } from "../plugins/execution/contract.js";

afterEach(() => uninstallCapabilityRegistry());

describe("execution plugin", () => {
  it("exposes the persistent kernel and process execution API through a capability", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);

    const service = requireCapability(EXECUTION_CAPABILITY);
    expect(typeof service.api.KernelManager).toBe("function");
    expect(typeof service.api.execCommand).toBe("function");
    expect(typeof service.api.defaultKernelPythonPath).toBe("function");
  });
});
