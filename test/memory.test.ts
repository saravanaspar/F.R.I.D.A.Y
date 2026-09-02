import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import memoryPlugin from "../plugins/memory/index.js";
import { MEMORY_CAPABILITY } from "../plugins/memory/contract.js";

describe("memory plugin", () => {
  it("provides persistent continual state through the capability registry", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    const dir = mkdtempSync(join(tmpdir(), "friday-memory-root-test-"));
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(memoryPlugin);
      const memory = requireCapability(MEMORY_CAPABILITY);
      const store = memory.openStore({ stateDir: dir, scope: "global" });
      store.create("memory", { id: "decision", title: "Decision", content: "Keep it small." });
      const reopened = memory.openStore({ stateDir: dir, scope: "global" });
      expect(reopened.get("memory", "decision")?.content).toBe("Keep it small.");
      expect(reopened.search("small decision")[0]?.entry.id).toBe("decision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      uninstallCapabilityRegistry();
    }
  });
});
