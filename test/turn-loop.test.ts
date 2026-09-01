import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventInput, EventRecord, EventsService } from "../plugins/events/contract.js";
import type { PermissionsTrustedService } from "../plugins/permissions/trusted-contract.js";
import type { RoutingDecision, RoutingService } from "../plugins/routing/contract.js";
import type { InboundTurn, TurnExecutor } from "../plugins/turn-loop/contract.js";
import { createTurnRuntime } from "../plugins/turn-loop/turn-loop.js";
import { SqliteTurnReplyOutbox } from "../plugins/turn-loop/reply-outbox.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "friday-turn-loop-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function decision(
  destination: RoutingDecision["destination"] = { kind: "session", id: "session:project" },
  profile: RoutingDecision["execution"]["profile"] = "agent",
): RoutingDecision {
  return Object.freeze({
    messageId: "message",
    destination: Object.freeze(destination),
    execution: Object.freeze({ profile }),
    confidence: 0.9,
  });
}

function eventsHarness() {
  const records = new Map<string, EventRecord>();
  const inputs: EventInput[] = [];
  let sequence = 0;
  const service = {
    publish(input: EventInput): EventRecord {
      inputs.push(structuredClone(input));
      const id = input.id ?? `event-${++sequence}`;
      const existing = records.get(id);
      if (existing) return existing;
      const now = new Date().toISOString();
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
        ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      };
      records.set(id, record);
      return record;
    },
    get(id: string) { return records.get(id); },
  } as EventsService;
  return { service, inputs };
}

function permissionsHarness() {
  const principals: Array<{ channel: string; accountId: string; conversationId?: string; senderId: string; threadId?: string }> = [];
  let localRuns = 0;
  const service = {
    identities: () => [],
    trustChannelIdentity: () => { throw new Error("not used"); },
    revokeChannelIdentity: () => false,
    runAsLocal<T>(operation: () => T): T {
      localRuns += 1;
      return operation();
    },
    runAsSystem: <T>(_service: string, operation: () => T) => operation(),
    runAsChannel<T>(selector: { channel: string; accountId: string; conversationId?: string; senderId: string; threadId?: string }, operation: () => T): T {
      principals.push(selector);
      return operation();
    },
  } satisfies PermissionsTrustedService;
  return { service, principals, localRuns: () => localRuns };
}

function routingHarness(routeDecision: RoutingDecision) {
  const messages: Array<{ id: string; text: string }> = [];
  const service = {
    async route(message: { id: string; text: string }) {
      messages.push({ id: message.id, text: message.text });
      return { ...routeDecision, messageId: message.id };
    },
    subscribe: () => () => {},
    recentContext: () => [],
  } as RoutingService;
  return { service, messages };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function turn(id: string, reply: (text: string) => Promise<void>, conversationId = "chat-1"): InboundTurn {
  return {
    id,
    principal: {
      authority: "channel",
      channel: "telegram",
      accountId: "main",
      conversationId,
      senderId: "alice",
    },
    text: `hello ${id}`,
    timestamp: Date.now(),
    reply,
  };
}

describe("Turn Loop", () => {
  it("runs one normalized turn through trusted identity, routing, an executor, reply, and durable replay state", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const replies: string[] = [];
    const executor: TurnExecutor = {
      id: "agent",
      canHandle: () => true,
      async execute(context) {
        expect(context.turn.text).toBe("hello m1");
        expect(context.decision.destination.id).toBe("session:project");
        return { text: "done", sessionId: "project" };
      },
    };
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [executor],
    });

    const result = await runtime.submit(turn("m1", async (text) => { replies.push(text); }));

    expect(result).toMatchObject({ status: "completed", executorId: "agent", sessionId: "project" });
    expect(permissions.principals).toEqual([{ channel: "telegram", accountId: "main", conversationId: "chat-1", senderId: "alice" }]);
    expect(routing.messages).toEqual([{ id: "m1", text: "hello m1" }]);
    expect(replies).toEqual(["done"]);
    expect(events.inputs.map((event) => event.type)).toEqual(["turn.received", "turn.executed", "turn.delivered", "turn.completed"]);
    expect(JSON.stringify(events.inputs)).not.toContain("hello m1");
    expect(events.inputs.find((event) => event.type === "turn.executed")?.data).toMatchObject({
      replyRef: expect.stringMatching(/^turn-reply:/),
      replySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      requiresFinalization: false,
    });
    expect(JSON.stringify(events.inputs)).not.toContain("done");
  });

  it("preserves validated channel attachments across turn normalization", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    let observed: InboundTurn["attachments"];
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute(context) {
          observed = context.turn.attachments;
          return { text: "installed" };
        },
      }],
    });
    const attachment = {
      kind: "document" as const,
      externalId: "telegram-file-7",
      mimeType: "application/zip",
      fileName: "skill.zip",
      sizeBytes: 123,
      downloadUrl: "https://api.telegram.org/file/7",
      artifactRef: "artifact:11111111-1111-1111-1111-111111111111",
    };

    await runtime.submit({ ...turn("attachment", async () => undefined), attachments: [attachment] });

    expect(observed).toEqual([attachment]);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.[0])).toBe(true);
  });

  it("preserves a host-owned restart destination through normalization and resumes without rerouting", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    let routeCalls = 0;
    const routing = {
      async route() {
        routeCalls += 1;
        throw new Error("restart continuation must not be rerouted");
      },
      subscribe: () => () => {},
      recentContext: () => [],
    } as RoutingService;
    let observedDestination = "";
    let observedResumeJob = "";
    const runtime = createTurnRuntime({
      routing,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute(context) {
          observedDestination = context.decision.destination.id;
          observedResumeJob = context.turn.resumedJobId ?? "";
          return { text: "resumed", sessionId: "resume-session" };
        },
      }],
    });

    const inbound = turn("resume-turn", async () => undefined);
    await expect(runtime.submit({
      ...inbound,
      resumeDestinationId: "session:resume-session",
      resumedJobId: "job-interrupted",
    })).resolves.toMatchObject({ status: "completed", sessionId: "resume-session" });

    expect(routeCalls).toBe(0);
    expect(observedDestination).toBe("session:resume-session");
    expect(observedResumeJob).toBe("job-interrupted");
  });

  it("runs host-local ingress under the local operator context instead of channel identity resolution", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision({ kind: "transient", id: "transient:utility" }, "utility"));
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{ id: "utility", canHandle: () => true, async execute() { return { text: "local-ok" }; } }],
    });
    const replies: string[] = [];
    const inbound = turn("local", async (text) => { replies.push(text); });

    await runtime.submit({ ...inbound, principal: { ...inbound.principal, authority: "local", channel: "local-test" } });

    expect(permissions.localRuns()).toBe(1);
    expect(permissions.principals).toEqual([]);
    expect(replies).toEqual(["local-ok"]);
  });

  it("deduplicates completed external message ids before routing or execution", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    let executions = 0;
    let replies = 0;
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute() { executions += 1; return { text: "ok" }; },
      }],
    });
    const inbound = turn("same", async () => { replies += 1; });

    expect((await runtime.submit(inbound)).status).toBe("completed");
    expect((await runtime.submit(inbound)).status).toBe("duplicate");
    expect(executions).toBe(1);
    expect(replies).toBe(1);
    expect(routing.messages).toHaveLength(1);
  });

  it("replays the private outbox after an ambiguous channel acknowledgement without re-executing side effects", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const attempts: string[] = [];
    let channelAvailable = false;
    let executions = 0;
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute() {
          executions += 1;
          return { text: "side effect already committed" };
        },
      }],
    });
    const inbound = turn("ambiguous-channel-ack", async (text) => {
      attempts.push(text);
      if (!channelAvailable) throw new Error("provider ACK was lost");
    });

    await expect(runtime.submit(inbound)).rejects.toThrow("provider ACK was lost");
    channelAvailable = true;
    await expect(runtime.submit(inbound)).resolves.toMatchObject({ status: "completed", executorId: "agent" });

    expect(executions).toBe(1);
    expect(routing.messages).toHaveLength(1);
    expect(attempts).toEqual([
      "side effect already committed",
      "FRIDAY could not complete this turn.",
      "side effect already committed",
    ]);
  });

  it("replays delivery when the reply succeeded but its durable delivery event did not commit", async () => {
    const events = eventsHarness();
    const originalPublish = events.service.publish.bind(events.service);
    let failDelivery = true;
    (events.service as { publish: EventsService["publish"] }).publish = (input) => {
      if (input.type === "turn.delivered" && failDelivery) {
        failDelivery = false;
        throw new Error("delivery-event-store-unavailable");
      }
      return originalPublish(input);
    };
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const replies: string[] = [];
    let executions = 0;
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute() {
          executions += 1;
          return { text: "durable answer" };
        },
      }],
    });
    const inbound = turn("delivery-commit-failure", async (text) => { replies.push(text); });

    await expect(runtime.submit(inbound)).rejects.toThrow("delivery-event-store-unavailable");
    await expect(runtime.submit(inbound)).resolves.toMatchObject({ status: "completed", executorId: "agent" });

    expect(executions).toBe(1);
    expect(routing.messages).toHaveLength(1);
    expect(replies).toEqual(["durable answer", "durable answer"]);
  });

  it("serializes whole turns per external conversation and per routed persistent session", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const route: RoutingService = {
      async route(message) {
        return decision({ kind: "session", id: message.text.includes("shared") ? "session:shared" : "session:new" });
      },
      subscribe: () => () => {},
      recentContext: () => [],
    };
    let active = 0;
    let maxActive = 0;
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const executor: TurnExecutor = {
      id: "agent",
      canHandle: () => true,
      async execute(context) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(context.turn.id);
        await new Promise<void>((resolve) => { gates.set(context.turn.id, resolve); });
        active -= 1;
        return { text: context.turn.id };
      },
    };
    const runtime = createTurnRuntime({ routing: route, permissions: permissions.service, events: events.service, executors: () => [executor] });

    const first = runtime.submit({ ...turn("a", async () => {}, "one"), text: "shared a" });
    const second = runtime.submit({ ...turn("b", async () => {}, "two"), text: "shared b" });
    await waitUntil(() => started.length === 1 && runtime.status().activeTurns === 2, "shared session contention");
    expect(maxActive).toBe(1);
    expect(runtime.status().lockedSessions).toBe(1);
    const firstStarted = started[0]!;
    gates.get(firstStarted)!();
    await waitUntil(() => started.length === 2, "second shared-session turn");
    const secondStarted = started.find((id) => id !== firstStarted)!;
    gates.get(secondStarted)!();
    await Promise.all([first, second]);

    maxActive = 0;
    started.length = 0;
    const third = runtime.submit(turn("c", async () => {}, "same-chat"));
    const fourth = runtime.submit(turn("d", async () => {}, "same-chat"));
    await waitUntil(() => started.length === 1, "first same-conversation turn");
    expect(maxActive).toBe(1);
    gates.get("c")!();
    await waitUntil(() => started.length === 2, "second same-conversation turn");
    gates.get("d")!();
    await Promise.all([third, fourth]);
  });

  it("dispatches new execution profiles through executor contributions instead of hard-coded branches", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision({ kind: "scheduler", id: "scheduler" }, "scheduler"));
    const used: string[] = [];
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [
        { id: "agent", canHandle: (value) => value.execution.profile === "agent", async execute() { used.push("agent"); return { text: "agent" }; } },
        { id: "scheduler", canHandle: (value) => value.execution.profile === "scheduler", async execute() { used.push("scheduler"); return { text: "scheduled" }; } },
      ],
    });
    const replies: string[] = [];

    const result = await runtime.submit(turn("schedule", async (text) => { replies.push(text); }));
    expect(result.executorId).toBe("scheduler");
    expect(used).toEqual(["scheduler"]);
    expect(replies).toEqual(["scheduled"]);
  });

  it("replays a durable execution after completion recording fails without executing side effects twice", async () => {
    const events = eventsHarness();
    const originalPublish = events.service.publish.bind(events.service);
    let failCompletion = true;
    (events.service as { publish: EventsService["publish"] }).publish = (input) => {
      if (input.type === "turn.completed" && failCompletion) {
        failCompletion = false;
        throw new Error("event-store-unavailable");
      }
      return originalPublish(input);
    };
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const replies: string[] = [];
    const compensated: string[] = [];
    let executions = 0;
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute() {
          executions += 1;
          return { text: "real answer", afterFailure: (error: unknown) => { compensated.push((error as Error).message); } };
        },
      }],
    });

    await expect(runtime.submit(turn("completion-failure", async (text) => { replies.push(text); })))
      .rejects.toThrow("event-store-unavailable");
    expect(replies).toEqual(["real answer"]);
    expect(compensated).toEqual([]);
    expect(events.inputs.some((event) => event.type === "turn.failed")).toBe(true);

    await expect(runtime.submit(turn("completion-failure", async (text) => { replies.push(text); })))
      .resolves.toMatchObject({ status: "completed", executorId: "agent" });
    expect(executions).toBe(1);
    expect(routing.messages).toHaveLength(1);
    expect(replies).toEqual(["real answer"]);
  });

  it("reconstructs a required finalizer after restart and records completion only after it succeeds", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const outboxStateDir = temporaryDirectory();
    const predecessorOutbox = new SqliteTurnReplyOutbox(outboxStateDir);
    const replies: string[] = [];
    let executions = 0;
    let recoveredFinalizers = 0;
    const firstRuntime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      replyOutbox: predecessorOutbox,
      executors: () => [{
        id: "agent",
        canHandle: () => true,
        async execute() {
          executions += 1;
          return {
            text: "private answer",
            afterReply: async () => { throw new Error("predecessor-crashed-before-finalization"); },
            afterReplyFinalizers: [{ type: "test.recover", payload: { operationId: "op-1" } }],
          };
        },
      }],
    });

    await expect(firstRuntime.submit(turn("finalizer-restart", async (text) => { replies.push(text); })))
      .rejects.toThrow("predecessor-crashed-before-finalization");
    expect(events.inputs.some((event) => event.type === "turn.completed")).toBe(false);
    expect(JSON.stringify(events.inputs)).not.toContain("private answer");
    predecessorOutbox.close();

    const successorOutbox = new SqliteTurnReplyOutbox(outboxStateDir);
    const restartedRuntime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      replyOutbox: successorOutbox,
      executors: () => [{ id: "must-not-run", canHandle: () => true, async execute() { throw new Error("duplicate execution"); } }],
      finalizers: () => [{
        type: "test.recover",
        async finalize(payload) {
          expect(payload).toEqual({ operationId: "op-1" });
          recoveredFinalizers += 1;
        },
      }],
    });

    await expect(restartedRuntime.submit(turn("finalizer-restart", async (text) => { replies.push(text); })))
      .resolves.toMatchObject({ status: "completed", executorId: "agent" });
    expect(executions).toBe(1);
    expect(recoveredFinalizers).toBe(1);
    expect(replies).toEqual(["private answer"]);
    const finalizedIndex = events.inputs.findIndex((event) => event.type === "turn.finalized");
    const completedIndex = events.inputs.findIndex((event) => event.type === "turn.completed");
    expect(finalizedIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(finalizedIndex);
    successorOutbox.close();
  });

  it("fails closed on ambiguous executors and returns only a generic failure to the ingress", async () => {
    const events = eventsHarness();
    const permissions = permissionsHarness();
    const routing = routingHarness(decision());
    const replies: string[] = [];
    const runtime = createTurnRuntime({
      routing: routing.service,
      permissions: permissions.service,
      events: events.service,
      executors: () => [
        { id: "one", priority: 10, canHandle: () => true, async execute() { return { text: "one" }; } },
        { id: "two", priority: 10, canHandle: () => true, async execute() { return { text: "two" }; } },
      ],
    });

    await expect(runtime.submit(turn("ambiguous", async (text) => { replies.push(text); }))).rejects.toThrow(/Ambiguous turn executors/);
    expect(replies).toEqual(["FRIDAY could not complete this turn."]);
    const failure = events.inputs.find((event) => event.type === "turn.failed");
    expect(failure?.data).toMatchObject({ phase: "executor-selection", errorType: "Error" });
    expect(JSON.stringify(failure)).not.toContain("Ambiguous turn executors");
  });
});
