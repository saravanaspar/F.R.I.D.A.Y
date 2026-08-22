import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventInput, EventRecord, EventsService } from "../plugins/events/contract.js";
import type { PermissionsTrustedService } from "../plugins/permissions/trusted-contract.js";
import type { RoutingService } from "../plugins/routing/contract.js";
import { SessionJobManager } from "../plugins/session-jobs/manager.js";
import type { InboundTurn, TurnExecutor } from "../plugins/turn-loop/contract.js";
import { createTurnRuntime } from "../plugins/turn-loop/turn-loop.js";

function events(): EventsService {
  const records = new Map<string, EventRecord>();
  let sequence = 0;
  return {
    publish(input: EventInput) {
      const now = new Date().toISOString();
      const id = input.id ?? `event-${++sequence}`;
      const existing = records.get(id);
      if (existing) return existing;
      const record: EventRecord = {
        sequence: ++sequence,
        id,
        type: input.type,
        source: input.source,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        occurredAt: input.occurredAt ?? now,
        publishedAt: now,
        data: input.data ?? null,
        metadata: input.metadata ?? {},
      };
      records.set(id, record);
      return record;
    },
    get: (id: string) => records.get(id),
  } as EventsService;
}

function permissions(): PermissionsTrustedService {
  return {
    identities: () => [],
    trustChannelIdentity: () => { throw new Error("unused"); },
    revokeChannelIdentity: () => false,
    runAsLocal: <T>(operation: () => T) => operation(),
    runAsSystem: <T>(_service: string, operation: () => T) => operation(),
    runAsChannel: <T>(_selector: unknown, operation: () => T) => operation(),
  } as PermissionsTrustedService;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Turn Loop detached session jobs", () => {
  it("acknowledges persistent work immediately and reports completion later", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-turn-jobs-"));
    const eventService = events();
    const jobs = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      events: eventService,
      idFactory: () => "job-1234",
      resolveLabel: () => "PSCLS — brain",
      progressNotifyIntervalMs: 0,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const executor: TurnExecutor = {
      id: "agent-session",
      canHandle: () => true,
      async execute(context) {
        executions += 1;
        await context.progress?.({ kind: "tool", message: "Running persistence tests" });
        await gate;
        return { text: "PSCLS report complete", sessionId: "pscls-brain" };
      },
    };
    const routing: RoutingService = {
      async route(message) {
        return {
          messageId: message.id,
          destination: { kind: "session", id: "session:pscls-brain" },
          execution: { profile: "agent" },
          confidence: 1,
        };
      },
      subscribe: () => () => {},
      recentContext: () => [],
    };
    const replies: string[] = [];
    const turn: InboundTurn = {
      id: "m1",
      principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      text: "work on PSCLS brain",
      timestamp: Date.now(),
      reply: async (text) => { replies.push(text); },
    };
    const runtime = createTurnRuntime({
      routing,
      permissions: permissions(),
      events: eventService,
      executors: () => [executor],
      sessionJobs: () => jobs,
    });

    const result = await runtime.submit(turn);
    expect(result.status).toBe("completed");
    expect(replies[0]).toContain("Started background work: PSCLS — brain (job-1234)");
    await waitUntil(() => executions === 1 && jobs.get("job-1234")?.status === "running", "background execution");
    await waitUntil(() => replies.some((text) => text.includes("Running persistence tests")), "progress notification");

    release();
    await waitUntil(() => jobs.get("job-1234")?.status === "completed", "job completion");
    await waitUntil(() => replies.at(-1)?.includes("PSCLS report complete") === true, "completion notification");
    expect(replies.at(-1)).toContain("PSCLS report complete");
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  });
});
