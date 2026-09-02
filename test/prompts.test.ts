import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import promptsPlugin from "../plugins/prompts/index.js";
import { PROMPTS_CAPABILITY } from "../plugins/prompts/contract.js";

describe("prompts plugin", () => {
  it("provides pure system-prompt composition through the capability registry", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(promptsPlugin);
      const prompts = requireCapability(PROMPTS_CAPABILITY);
      const prompt = prompts.buildSystemPrompt({
        cwd: "/work",
        messagesPath: "/sessions/one.jsonl",
        selectedTools: ["ipython"],
        allowRecursion: true,
      });
      expect(prompt).toContain("Working directory: /work");
      expect(prompt).toContain("await rlm('sub-task')");
    } finally {
      uninstallCapabilityRegistry();
    }
  });
});
