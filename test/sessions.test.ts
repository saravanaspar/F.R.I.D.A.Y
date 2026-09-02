import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";

describe("sessions plugin", () => {
  it("exposes durable session history and branching through a capability", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionsPlugin);

    const service = requireCapability(SESSIONS_CAPABILITY);
    const session = service.SessionManager.inMemory("/tmp/project");
    const first = session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    });
    session.branch(first);
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "branch" }],
      timestamp: Date.now(),
    });

    expect(session.buildSessionContext().messages).toMatchObject([
      { role: "user", content: [{ text: "first" }] },
      { role: "user", content: [{ text: "branch" }] },
    ]);

    uninstallCapabilityRegistry();
  });
});
