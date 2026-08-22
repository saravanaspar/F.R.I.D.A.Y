import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import modelPlugin from "../plugins/model/index.js";
import compactionPlugin from "../plugins/compaction/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import { COMPACTION_CAPABILITY } from "../plugins/compaction/contract.js";

describe("compaction plugin", () => {
  it("summarizes old context through model and persists the result through sessions", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(sessionsPlugin);
      await friday.activatePlugin(modelPlugin);
      await friday.activatePlugin(compactionPlugin);

      const models = requireCapability(MODEL_CAPABILITY);
      const sessions = requireCapability(SESSIONS_CAPABILITY);
      const compaction = requireCapability(COMPACTION_CAPABILITY);
      const faux = models.api.registerFauxProvider();
      try {
        faux.setResponses([models.api.fauxAssistantMessage("## Goal\ncompressed history")]);
        const session = sessions.api.SessionManager.inMemory("/tmp/project");
        session.appendMessage({ role: "user", content: "old1", timestamp: Date.now() });
        session.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "old2" }],
          provider: "faux",
          model: faux.getModel().id,
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });
        session.appendMessage({ role: "user", content: "new1", timestamp: Date.now() });
        session.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "new2" }],
          provider: "faux",
          model: faux.getModel().id,
          usage: { input: 950, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 980, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });

        const result = await compaction.api.compactSession(session, {
          model: faux.getModel(),
          apiKey: "test",
          force: true,
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 2 },
        });

        expect(result?.entryId).toBeTruthy();
        expect(session.getBranch().at(-1)?.type).toBe("compaction");
        expect(session.buildSessionContext().messages[0]).toMatchObject({
          role: "compactionSummary",
          summary: expect.stringContaining("compressed history"),
        });
      } finally {
        faux.unregister();
      }
    } finally {
      uninstallCapabilityRegistry();
    }
  });
});
