import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { AUTONOMY_CAPABILITY } from "../plugins/autonomy/contract.js";
import { EVALUATION_CAPABILITY } from "../plugins/evaluation/contract.js";
import { EXECUTION_CAPABILITY } from "../plugins/execution/contract.js";
import { GENERATIONS_CAPABILITY } from "../plugins/generations/contract.js";
import { LIFECYCLE_CAPABILITY } from "../plugins/lifecycle/contract.js";
import { MCP_CAPABILITY } from "../plugins/mcp/contract.js";
import { MCP_TRUSTED_CAPABILITY } from "../plugins/mcp/trusted-contract.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";
import selfImprovementPlugin from "../plugins/self-improvement/index.js";
import { SELF_IMPROVEMENT_CAPABILITY } from "../plugins/self-improvement/contract.js";
import { WORKTREES_CAPABILITY } from "../plugins/worktrees/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

afterEach(() => uninstallCapabilityRegistry());

async function assemble(options: { clean: boolean; feasible?: boolean; placement?: "reuse-existing" | "extend-plugin" | "mcp" | "new-plugin" | "host"; mcpMatch?: boolean }) {
  const order: string[] = [];
  const feasibilityMessages: string[] = [];
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-si-autonomy", provides: [AUTONOMY_CAPABILITY] }, (ctx) => ctx.services.provide(AUTONOMY_CAPABILITY, {} as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-evaluation", provides: [EVALUATION_CAPABILITY] }, (ctx) => ctx.services.provide(EVALUATION_CAPABILITY, { runCommandEvaluationSuite: async () => [] } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-execution", provides: [EXECUTION_CAPABILITY] }, (ctx) => ctx.services.provide(EXECUTION_CAPABILITY, {
    async execCommand() { order.push("HOST-EXECUTION"); throw new Error("host execution should not start in this feasibility test"); },
    processes: {},
  } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-generations", provides: [GENERATIONS_CAPABILITY] }, (ctx) => ctx.services.provide(GENERATIONS_CAPABILITY, { createGenerationsManager: () => ({}) } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-lifecycle", provides: [LIFECYCLE_CAPABILITY] }, (ctx) => ctx.services.provide(LIFECYCLE_CAPABILITY, { acknowledgeRestartFromEnvironment: () => undefined } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-model", provides: [MODEL_CAPABILITY] }, (ctx) => ctx.services.provide(MODEL_CAPABILITY, {
      getModel: () => ({ provider: "test", id: "model" }),
      async completeSimple(_model: unknown, request: { readonly systemPrompt?: string; readonly messages?: readonly { readonly content?: unknown }[] }) {
        if (request.systemPrompt?.includes("MCP exact-operation verifier")) {
          order.push("mcp-verifier");
          return { content: [{ type: "text", text: JSON.stringify({ match: options.mcpMatch === true, tool: "computer_use", reason: "live schema reviewed" }) }], stopReason: "stop" };
        }
        order.push("feasibility-model");
        const content = request.messages?.[0]?.content;
        if (typeof content === "string") feasibilityMessages.push(content);
        return { content: [{ type: "text", text: JSON.stringify({
          feasible: options.feasible ?? true,
          reason: "placement reviewed",
          objective: options.placement === "reuse-existing" ? "use installed action demo.read" : "implement the missing feature safely",
          placement: options.placement ?? "extend-plugin",
          target: options.placement === "reuse-existing" ? "demo.read" : "plugins/mcp",
          mcpRelevant: options.placement === "mcp",
          mcpSearchTerms: options.placement === "mcp" ? ["computer control"] : [],
          fallbackPlacement: "extend-plugin",
          fallbackTarget: "plugins/tools",
        }) }], stopReason: "stop" };
      },
      parseJsonWithRepair: (text: string) => JSON.parse(text),
  } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => ctx.services.provide(PERMISSIONS_CAPABILITY, { normalizeMode: () => "ask" } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-sandbox", provides: [SANDBOX_CAPABILITY] }, (ctx) => ctx.services.provide(SANDBOX_CAPABILITY, { assertAvailable: () => { order.push("sandbox-check"); } } as never)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-si-worktrees", provides: [WORKTREES_CAPABILITY] }, (ctx) => ctx.services.provide(WORKTREES_CAPABILITY, {
      async inspectWorktree() { order.push("baseline-check"); return { clean: options.clean }; },
      async createWorktree() { order.push("BUILD-STARTED"); throw new Error("build should not start in this test"); },
      async removeWorktree() { return undefined; },
  } as never)), { defer: true });
  if (options.mcpMatch !== undefined) {
    await friday.activatePlugin(definePlugin({ id: "test-si-mcp", provides: [MCP_CAPABILITY] }, (ctx) => ctx.services.provide(MCP_CAPABILITY, {
      servers: () => [{ id: "computer", label: "Computer MCP", url: "https://example.com/mcp", authKind: "none", builtIn: false, credentialConfigured: true, connected: true }],
      status: () => ({ id: "computer", label: "Computer MCP", url: "https://example.com/mcp", authKind: "none", builtIn: false, credentialConfigured: true, connected: true }),
      async listTools() {
        order.push("mcp-list-tools");
        return [{ server: "computer", name: "computer_use", description: "Control the computer by clicking or typing", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } }];
      },
      async searchRegistry() { order.push("mcp-registry-search"); return []; },
      async callTool() { throw new Error("not used"); },
      async disconnect() { return undefined; },
    } as never)), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-si-mcp-trusted", provides: [MCP_TRUSTED_CAPABILITY] }, (ctx) => ctx.services.provide(MCP_TRUSTED_CAPABILITY, {
      registerServer() { throw new Error("not used"); },
      async removeServer() { return false; },
      async login() { throw new Error("not used"); },
      credentialRef() { return undefined; },
    } as never)), { defer: true });
  }
  await friday.activatePlugin(selfImprovementPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { service: requireCapability(SELF_IMPROVEMENT_CAPABILITY), order, feasibilityMessages };
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


  it("supplies configured public capability contracts to feasibility review before proposing code", async () => {
    const { service, feasibilityMessages } = await assemble({ clean: true, feasible: true });
    await service.assessFeasibility({ ...request, objective: "reuse durable memory search and storage" });
    expect(feasibilityMessages).toHaveLength(1);
    const payload = JSON.parse(feasibilityMessages[0]!) as {
      capabilityContracts?: { source?: string; contracts?: Array<{ plugin?: string; capabilities?: string[]; services?: string[]; publicApi?: string }> };
    };
    expect(payload.capabilityContracts?.source).toBe("configured-plugin-contracts");
    const memory = payload.capabilityContracts?.contracts?.find((entry) => entry.plugin === "memory");
    expect(memory?.capabilities).toContain("memory");
    expect(memory?.services).toContain("MemoryService");
    expect(memory?.publicApi).toContain("openStore");
    expect(memory?.publicApi).toContain("formatRelevant");
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

  it("accepts MCP only after a live exact-tool verification and skips code generation", async () => {
    const { service, order } = await assemble({ clean: false, placement: "mcp", mcpMatch: true });
    let authorized = false;
    const result = await service.ensureCapability({ ...request, objective: "control the user's computer" }, {
      onFeasible(feasibility) {
        expect(feasibility).toMatchObject({ placement: "mcp", target: "computer:computer_use", requiresCode: false });
        order.push("mcp-message");
      },
      authorize() { authorized = true; },
    });
    expect(result.result).toBeUndefined();
    expect(authorized).toBe(false);
    expect(order).toEqual(["feasibility-model", "mcp-list-tools", "mcp-verifier", "mcp-message"]);
    expect(order).not.toContain("BUILD-STARTED");
  });

  it("falls back to code only after live MCP inspection finds no exact operation", async () => {
    const { service, order } = await assemble({ clean: false, placement: "mcp", mcpMatch: false });
    const result = await service.assessFeasibility({ ...request, objective: "control the user's computer" });
    expect(result).toMatchObject({ feasible: false, placement: "extend-plugin", target: "plugins/tools", requiresCode: true });
    expect(result.reason).toMatch(/working tree is not clean/i);
    expect(order.slice(0, 3)).toEqual(["feasibility-model", "mcp-list-tools", "mcp-verifier"]);
    expect(order.filter((entry) => entry === "mcp-registry-search").length).toBeGreaterThanOrEqual(1);
    expect(order.slice(-2)).toEqual(["sandbox-check", "baseline-check"]);
  });
});
