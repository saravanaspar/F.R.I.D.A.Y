import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import rlmPlugin from "../plugins/rlm/index.js";
import { RLM_CAPABILITY } from "../plugins/rlm/contract.js";
import subagentsPlugin from "../plugins/subagents/index.js";
import { SUBAGENTS_CAPABILITY } from "../plugins/subagents/contract.js";

function hostRequestContext(signal = new AbortController().signal) {
  return {
    requestId: "root-rlm-test",
    generation: 1,
    signal,
    isCurrent: () => !signal.aborted,
  };
}

describe("rlm plugin", () => {
  it("adapts model-facing host requests to the subagents capability", async () => {
    uninstallCapabilityRegistry();
    const friday = new PluginTestHost();
    const artifactDir = mkdtempSync(join(tmpdir(), "friday-rlm-integration-"));
    try {
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(subagentsPlugin);
      await friday.activatePlugin(rlmPlugin);

      const subagents = requireCapability(SUBAGENTS_CAPABILITY);
      const rlm = requireCapability(RLM_CAPABILITY);
      const models = [
        { provider: "test", id: "parent", name: "Parent" },
        { provider: "test", id: "child", name: "Child" },
      ];
      const manager = await subagents.api.SubagentManager.create({
        parentArtifactDir: artifactDir,
        parentModel: models[0]!,
        models,
        runtimeHost: {
          async create(options) {
            return {
              sessionId: `session-${options.id}`,
              sessionName: options.name,
              async run() {},
            };
          },
          async delete() {},
        },
      });

      const handlers = rlm.api.createRlmHostHandlers({ subagents: manager, models });
      const context = hostRequestContext();
      const admitted = await handlers["rlm.run"]!({
        type: "rlm.run",
        prompt: "review API",
        kwargs: { name: "api-reviewer", model: "test/child" },
        cellSourceCode: "await rlm('review API')",
      }, context);
      expect(admitted).toMatchObject({
        name: "api-reviewer",
        model: "test/child",
      });

      const found = await handlers["rlm.find_models"]!({
        type: "rlm.find_models",
        query: "child",
        limit: 8,
      }, context);
      expect(found).toEqual({
        models: [{ provider: "test", id: "child", name: "Child", selector: "test/child" }],
      });

      const listed = await handlers["rlm.list_subagents"]!({ type: "rlm.list_subagents" }, context);
      expect(listed.subagents).toEqual(
        expect.arrayContaining([expect.objectContaining({ rlm_child_id: admitted.rlm_child_id, session_name: "api-reviewer" })]),
      );

      const deleted = await handlers["rlm.delete_subagent"]!({
        type: "rlm.delete_subagent",
        target: admitted.rlm_child_id,
      }, context);
      expect(deleted).toMatchObject({ subagent: { rlm_child_id: admitted.rlm_child_id } });
      await manager.dispose();
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      uninstallCapabilityRegistry();
    }
  });
});
