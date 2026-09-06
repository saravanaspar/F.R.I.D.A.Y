import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { OBSERVABILITY_CAPABILITY, type ModelUsageSummary, type ObservabilityService } from "../plugins/observability/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionRequest, type PermissionsService } from "../plugins/permissions/contract.js";
import spendingPlugin from "../plugins/spending/index.js";
import { SPENDING_POLICY_CAPABILITY } from "../plugins/spending/contract.js";
import { AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION, type AgentModelRequestContext } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME; else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function summary(cost: number): ModelUsageSummary {
  const totals = { requests: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, cacheHitRate: 0, actualCost: cost, actualCostRecords: 1, estimatedCost: 0, estimatedCostRecords: 0, billableCost: cost, billableCostRecords: 1, currency: "USD" };
  return { totals, byAgent: [], byModel: [], byJob: [], note: "test" };
}

describe("persistent spending policy", () => {
  it("enforces shared daily/project limits before a job model request and records explicit approval", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-spending-")); roots.push(home); await chmod(home, 0o700); process.env.FRIDAY_HOME = home;
    const approvals: PermissionRequest[] = [];
    const observability = { usageSummary: (query: { rootSessionId?: string }) => summary(query.rootSessionId ? 0.6 : 1.2) } as unknown as ObservabilityService;
    const permissions = {
      normalizeMode: () => "ask",
      assertWorkspacePath: (_workspace: string, path: string) => path,
      async authorize(request: PermissionRequest) { approvals.push(request); return { allowed: true as const, approvedBy: "user" as const }; },
    } satisfies PermissionsService;
    const host = new PluginTestHost();
    await host.activatePlugin(capabilitiesPlugin);
    await host.activatePlugin(definePlugin({ id: "test-observability", provides: [OBSERVABILITY_CAPABILITY] }, (ctx) => ctx.services.provide(OBSERVABILITY_CAPABILITY, observability)), { defer: true });
    await host.activatePlugin(definePlugin({ id: "test-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => ctx.services.provide(PERMISSIONS_CAPABILITY, permissions)), { defer: true });
    await host.activatePlugin(spendingPlugin, { defer: true });
    await host.completePluginBootstrap();

    const service = requireCapability(SPENDING_POLICY_CAPABILITY);
    service.setLimit("daily", 1);
    const cwd = process.cwd();
    const projectKey = `friday-${createHash("sha256").update(cwd).digest("hex").slice(0, 10)}`;
    service.setLimit("project", 0.5, projectKey);
    const policy = collectContributions(AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION)[0]!;
    const replies: string[] = [];
    const context = {
      cwd, sessionId: "session-1", rootSessionId: "root-1", agentId: "agent-1", agentName: "worker",
      provider: "test", model: "model", jobId: "job-123",
      turn: { id: "turn-1", principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "user" }, text: "work", timestamp: Date.now(), reply: async (text: string) => { replies.push(text); } },
      deferAfterReply() {}, deferOnFailure() {},
    } as AgentModelRequestContext;
    await policy.beforeRequest(context);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ jobId: "job-123", action: { id: "spending.continue" } });
    expect(service.approvals()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: "job-123", scope: "daily" })]));
    expect(service.approvals()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: "job-123", scope: "project" })]));
  });
});
