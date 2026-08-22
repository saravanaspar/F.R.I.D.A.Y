import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import agentPlugin from "../plugins/agent/index.js";
import { AGENT_CAPABILITY } from "../plugins/agent/contract.js";

function assistantText(messages: readonly unknown[]): string | undefined {
  const message = [...messages].reverse().find(
    (candidate): candidate is { role: "assistant"; content: Array<{ type: string; text?: string }> } =>
      typeof candidate === "object" && candidate !== null && (candidate as { role?: unknown }).role === "assistant",
  );
  return message?.content.find((block) => block.type === "text")?.text;
}

describe("agent plugin", () => {
  it("runs the agent loop through the model capability", async () => {
    const friday = new PluginTestHost();
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(modelPlugin);
      await friday.activatePlugin(agentPlugin);

      const models = requireCapability(MODEL_CAPABILITY);
      const agents = requireCapability(AGENT_CAPABILITY);
      const faux = models.api.registerFauxProvider();

      try {
        faux.setResponses([models.api.fauxAssistantMessage("hello from agent")]);
        const agent = new agents.api.Agent({ initialState: { model: faux.getModel() } });
        await agent.prompt("hello");

        expect(assistantText(agent.state.messages)).toBe("hello from agent");
        expect(faux.state.callCount).toBe(1);
      } finally {
        faux.unregister();
      }
    } finally {
      uninstallCapabilityRegistry();
    }
  });
});
