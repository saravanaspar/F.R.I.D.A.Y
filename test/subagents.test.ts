import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import subagentsPlugin from "../plugins/subagents/index.js";
import { SUBAGENTS_CAPABILITY } from "../plugins/subagents/contract.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for subagent state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("subagents plugin", () => {
  it("keeps a parent-scoped child registry in generic session custom entries", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    const artifactDir = mkdtempSync(join(tmpdir(), "friday-subagents-integration-"));
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionsPlugin);
      await friday.activatePlugin(subagentsPlugin);

      const sessions = requireCapability(SESSIONS_CAPABILITY);
      const subagents = requireCapability(SUBAGENTS_CAPABILITY);
      const session = sessions.SessionManager.inMemory("/tmp/project");
      const store = subagents.createSessionSubagentRegistryStore(session);
      const runtimeHost: Parameters<typeof subagents.SubagentManager.create>[0]["runtimeHost"] = {
        async create(options) {
          return {
            sessionId: `session-${options.id}`,
            sessionName: options.name,
            async run() {},
          };
        },
        async delete() {},
      };

      const first = await subagents.SubagentManager.create({
        parentId: session.getSessionId(),
        parentArtifactDir: artifactDir,
        parentModel: { provider: "test", id: "parent" },
        runtimeHost,
        registryStore: store,
      });
      const handle = await first.spawn("inspect the API", { name: "api-reviewer" });
      await waitFor(() => first.get(handle.childId)?.status === "completed");

      const reopened = await subagents.SubagentManager.create({
        parentId: session.getSessionId(),
        parentArtifactDir: artifactDir,
        parentModel: { provider: "test", id: "parent" },
        runtimeHost,
        registryStore: store,
      });
      expect(reopened.get(handle.childId)).toMatchObject({
        name: "api-reviewer",
        status: "completed",
        sessionId: `session-${handle.childId}`,
      });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      uninstallCapabilityRegistry();
    }
  });
});
