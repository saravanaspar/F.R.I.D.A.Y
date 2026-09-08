import { describe, expect, it, vi } from "vitest";
import type { ManagedProcessOperations, ManagedProcessOwner, ManagedProcessSnapshot } from "../src/execution-access.js";
import { createProcessTool } from "../src/process.js";

function snapshot(owner: ManagedProcessOwner, id = "proc-test"): ManagedProcessSnapshot {
  return {
    id,
    sessionId: owner.sessionId,
    runId: owner.runId,
    command: "npm run dev",
    cwd: process.cwd(),
    state: "running",
    startedAt: new Date(0).toISOString(),
    totalOutputBytes: 0,
    logsTruncated: false,
  };
}

function operations(owner: ManagedProcessOwner | undefined): ManagedProcessOperations & { start: ReturnType<typeof vi.fn> } {
  const records = new Map<string, ManagedProcessSnapshot>();
  const start = vi.fn(async (request: Parameters<ManagedProcessOperations["start"]>[0]) => {
    if (!owner) throw new Error("missing owner");
    const value = { ...snapshot(owner, request.id), command: request.command, cwd: request.cwd };
    records.set(request.id, value);
    return value;
  });
  return {
    currentOwner: () => owner,
    start,
    list: () => [...records.values()],
    get: (id) => records.get(id),
    logs: () => ({ text: "ready\n", truncated: false, totalBytes: 6 }),
    async stop(id) {
      const current = records.get(id);
      if (!current) throw new Error("unknown");
      const stopped = { ...current, state: "stopped" as const };
      records.set(id, stopped);
      return stopped;
    },
  };
}

describe("process tool", () => {
  it("starts a managed background process for the main agent and forwards policy options", async () => {
    const owner: ManagedProcessOwner = { sessionId: "session-1", runId: "run-1", ownerKind: "main-agent" };
    const ops = operations(owner);
    const startHook = vi.fn(async (context) => ({
      ...context,
      cwd: "/sandbox/workspace",
      launch: { command: "sandbox-provider", args: ["run", "sandbox-image"] },
    }));
    const tool = createProcessTool(process.cwd(), { operations: ops, startHook });

    const result = await tool.execute("call-1", { action: "start", command: "npm run dev", network: true, maxLifetimeSeconds: 15 });

    expect(startHook).toHaveBeenCalled();
    expect(ops.start).toHaveBeenCalledWith(expect.objectContaining({
      command: "npm run dev",
      cwd: "/sandbox/workspace",
      launch: { command: "sandbox-provider", args: ["run", "sandbox-image"] },
      maxLifetimeMs: 15_000,
    }));
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("rejects persistent background starts from subagents", async () => {
    const ops = operations({ sessionId: "session-1", runId: "run-child", ownerKind: "subagent" });
    const tool = createProcessTool(process.cwd(), { operations: ops });

    await expect(tool.execute("call-2", { action: "start", command: "npm run dev" })).rejects.toThrow(
      "Subagents cannot start persistent background processes",
    );
    expect(ops.start).not.toHaveBeenCalled();
  });

  it("exposes only processes owned by the active run", async () => {
    const owner: ManagedProcessOwner = { sessionId: "session-1", runId: "run-1", ownerKind: "main-agent" };
    const ops = operations(owner);
    const tool = createProcessTool(process.cwd(), { operations: ops });
    await tool.execute("call-3", { action: "start", command: "npm run dev" });

    const listed = await tool.execute("call-4", { action: "list" });
    expect(listed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("state=running") });
  });
});
