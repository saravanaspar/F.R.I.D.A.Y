import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { AUTONOMY_CAPABILITY } from "../plugins/autonomy/contract.js";
import { EVALUATION_CAPABILITY } from "../plugins/evaluation/contract.js";
import { EXECUTION_CAPABILITY } from "../plugins/execution/contract.js";
import { GENERATIONS_CAPABILITY } from "../plugins/generations/contract.js";
import { LIFECYCLE_CAPABILITY } from "../plugins/lifecycle/contract.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";
import selfImprovementPlugin from "../plugins/self-improvement/index.js";
import { SELF_IMPROVEMENT_CAPABILITY } from "../plugins/self-improvement/contract.js";
import { WORKTREES_CAPABILITY } from "../plugins/worktrees/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

afterEach(() => uninstallCapabilityRegistry());

async function assemble(options: { clean: boolean; feasible?: boolean; placement?: "reuse-existing" | "extend-plugin" | "mcp" | "new-plugin" | "host" }) {
  const order: string[] = [];
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-si-autonomy", provides: [AUTONOMY_CAPABILITY] }, (ctx) => ctx.services.provide(AUTONOMY_CAPABILITY, { api: {} } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-evaluation", provides: [EVALUATION_CAPABILITY] }, (ctx) => ctx.services.provide(EVALUATION_CAPABILITY, { api: { runCommandEvaluationSuite: async () => [] } } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-execution", provides: [EXECUTION_CAPABILITY] }, (ctx) => ctx.services.provide(EXECUTION_CAPABILITY, {
    api: { async execCommand() { order.push("HOST-EXECUTION"); throw new Error("host execution should not start in this feasibility test"); } },
    processes: {},
  } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-generations", provides: [GENERATIONS_CAPABILITY] }, (ctx) => ctx.services.provide(GENERATIONS_CAPABILITY, { api: { createGenerationsManager: () => ({}) } } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-lifecycle", provides: [LIFECYCLE_CAPABILITY] }, (ctx) => ctx.services.provide(LIFECYCLE_CAPABILITY, { api: { acknowledgeRestartFromEnvironment: () => undefined } } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-model", provides: [MODEL_CAPABILITY] }, (ctx) => ctx.services.provide(MODEL_CAPABILITY, {
    api: {
      getModel: () => ({ provider: "test", id: "model" }),
      async completeSimple() {
        order.push("feasibility-model");
        return { content: [{ type: "text", text: JSON.stringify({
          feasible: options.feasible ?? true,
          reason: "placement reviewed",
          objective: options.placement === "reuse-existing" ? "use installed action demo.read" : "implement the missing feature safely",
          placement: options.placement ?? "extend-plugin",
          target: options.placement === "reuse-existing" ? "demo.read" : "plugins/mcp",
          requiresCode: options.placement !== "reuse-existing",
        }) }], stopReason: "stop" };
      },
      parseJsonWithRepair: (text: string) => JSON.parse(text),
    },
  } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => ctx.services.provide(PERMISSIONS_CAPABILITY, { normalizeMode: () => "ask" } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-sandbox", provides: [SANDBOX_CAPABILITY] }, (ctx) => ctx.services.provide(SANDBOX_CAPABILITY, { assertAvailable: () => { order.push("sandbox-check"); } } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-worktrees", provides: [WORKTREES_CAPABILITY] }, (ctx) => ctx.services.provide(WORKTREES_CAPABILITY, {
    api: {
      async inspectWorktree() { order.push("baseline-check"); return { clean: options.clean }; },
      async createWorktree() { order.push("BUILD-STARTED"); throw new Error("build should not start in this test"); },
      async removeWorktree() { return undefined; },
    },
  } as never)), { defer: true });
  await friday.activatePlugin(selfImprovementPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { service: requireCapability(SELF_IMPROVEMENT_CAPABILITY), order };
}

const request = Object.freeze({ objective: "add stdio MCP support", cwd: process.cwd(), provider: "test", model: "model", permissionMode: "ask" as const });

describe("self-improvement feasibility gate", () => {
  it("exposes missing-capability orchestration to the ordinary agent without routing the user to a system command", async () => {
    await assemble({ clean: true, feasible: true });
    const tool = collectContributions(AGENT_TOOL_CONTRIBUTION).find((entry) => entry.name === "capability_ensure");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("original channel request");
    expect(tool!.description).toContain("strict deterministic gates");
    await expect(tool!.execute({ feature: "example", implementationObjective: "Build example support." }))
      .rejects.toThrow(/originating user turn/);
  });

  it("stops before user messaging, authorization, or build when a code placement has a dirty baseline", async () => {
    const { service, order } = await assemble({ clean: false });
    let messaged = false;
    let authorized = false;
    const result = await service.ensureCapability(request, {
      onFeasible: () => { messaged = true; },
      authorize: () => { authorized = true; },
    });
    expect(result.feasibility.feasible).toBe(false);
    expect(messaged).toBe(false);
    expect(authorized).toBe(false);
    expect(order).toEqual(["feasibility-model", "sandbox-check", "baseline-check"]);
    expect(order).not.toContain("BUILD-STARTED");
  });

  it("analyzes feasibility first, tells the user it can build, then asks authorization before any build starts", async () => {
    const { service, order } = await assemble({ clean: true, feasible: true });
    await expect(service.ensureCapability(request, {
      onFeasible(feasibility) { expect(feasibility.feasible).toBe(true); order.push("user-message"); },
      authorize() { order.push("authorization"); throw new Error("operator denied"); },
    })).rejects.toThrow("operator denied");
    expect(order).toEqual(["feasibility-model", "sandbox-check", "baseline-check", "user-message", "authorization"]);
    expect(order).not.toContain("BUILD-STARTED");
  });

  it("chooses reuse before code generation and skips authorization/build for an installed capability", async () => {
    const { service, order } = await assemble({ clean: false, placement: "reuse-existing" });
    let authorized = false;
    const result = await service.ensureCapability(request, {
      onFeasible(feasibility) {
        expect(feasibility).toMatchObject({ placement: "reuse-existing", target: "demo.read", requiresCode: false });
        order.push("reuse-message");
      },
      authorize() { authorized = true; },
    });
    expect(result.result).toBeUndefined();
    expect(result.feasibility.objective).toBe("use installed action demo.read");
    expect(authorized).toBe(false);
    expect(order).toEqual(["feasibility-model", "reuse-message"]);
    expect(order).not.toContain("BUILD-STARTED");
  });
});
