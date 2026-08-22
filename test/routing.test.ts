import { describe, expect, it } from "vitest";
import type { RoutingMessage } from "../plugins/routing/contract.js";
import {
  createRoutingService,
  type RoutingClassifierRequest,
  type RoutingMemoryHint,
  type RoutingSessionCandidate,
} from "../plugins/routing/router.js";

function message(id: string, text: string, conversationId = "chat-1", senderId = "user-1"): RoutingMessage {
  return {
    id,
    text,
    timestamp: 1_776_000_000_000 + Number(id.replace(/\D/g, "") || 0),
    principal: {
      channel: "telegram",
      accountId: "default",
      conversationId,
      senderId,
    },
  };
}

const projectSession: RoutingSessionCandidate = {
  id: "session:pscls",
  label: "PSCLS",
  summary: "Persistent project session for PSCLS architecture and implementation.",
  modifiedAt: "2026-08-19T07:00:00.000Z",
};

const memoryHint: RoutingMemoryHint = {
  id: "pscls-text",
  kind: "memory",
  title: "PSCLS text representation",
  content: "PSCLS uses UTF-8 bytes as primitive text representation.",
};

function validSessionDecision() {
  return {
    destination: { kind: "session", id: "session:pscls" },
    execution: { profile: "agent" },
    confidence: 0.97,
  };
}

function validTransientDecision() {
  return {
    destination: { kind: "transient", id: "transient:utility" },
    execution: { profile: "utility" },
    confidence: 0.88,
  };
}

describe("routing plugin", () => {
  it("uses one disposable classifier call with bounded read-only context and host destinations", async () => {
    const requests: RoutingClassifierRequest[] = [];
    const published: unknown[] = [];
    const observed: unknown[] = [];
    const routing = createRoutingService({
      classify: async (request) => {
        requests.push(request);
        return validSessionDecision();
      },
      sessions: async () => [projectSession],
      memory: async () => [memoryHint],
      publishDecision: (input, decision) => published.push({ input, decision }),
    });
    routing.subscribe((routed) => { observed.push(routed); });

    await expect(routing.route(message("m1", "Continue the PSCLS byte-text design."))).resolves.toEqual({
      messageId: "m1",
      ...validSessionDecision(),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.systemPrompt).toContain("Your only job is to choose WHERE");
    expect(requests[0]?.systemPrompt).toContain("Never invent a destination id");
    const payload = JSON.parse(requests[0]!.userPrompt) as Record<string, any>;
    expect(payload.message.text).toBe("Continue the PSCLS byte-text design.");
    expect(payload.memoryHints).toEqual([expect.objectContaining({ id: "pscls-text", title: "PSCLS text representation" })]);
    expect(payload.destinations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", id: "session:pscls", requiredExecutionProfile: "agent" }),
      expect.objectContaining({ kind: "session", id: "session:new", requiredExecutionProfile: "agent" }),
      expect.objectContaining({ kind: "transient", id: "transient:utility", requiredExecutionProfile: "utility" }),
      expect.objectContaining({ kind: "scheduler", id: "scheduler", requiredExecutionProfile: "scheduler" }),
      expect.objectContaining({ kind: "system", id: "system", requiredExecutionProfile: "system" }),
    ]));
    expect(published).toHaveLength(1);
    expect(observed).toHaveLength(1);
  });

  it("does not pin an external conversation to one FRIDAY session", async () => {
    const prompts: Record<string, any>[] = [];
    let call = 0;
    const routing = createRoutingService({
      classify: async (request) => {
        prompts.push(JSON.parse(request.userPrompt));
        call += 1;
        return call === 1
          ? validSessionDecision()
          : { destination: { kind: "scheduler", id: "scheduler" }, execution: { profile: "scheduler" }, confidence: 0.94 };
      },
      sessions: async () => [projectSession],
      memory: async () => [],
    });

    await routing.route(message("m1", "Continue PSCLS."));
    await expect(routing.route(message("m2", "Remind me tomorrow to review the report."))).resolves.toMatchObject({
      destination: { kind: "scheduler", id: "scheduler" },
    });

    expect(prompts[1]?.recentContext).toEqual([
      expect.objectContaining({ id: "m1", text: "Continue PSCLS." }),
    ]);
  });

  it("keeps recent channel context isolated by external conversation", async () => {
    const prompts: Record<string, any>[] = [];
    const routing = createRoutingService({
      classify: async (request) => {
        prompts.push(JSON.parse(request.userPrompt));
        return validTransientDecision();
      },
      sessions: async () => [],
      memory: async () => [],
    });

    await routing.route(message("m1", "first chat message", "chat-a"));
    await routing.route(message("m2", "other chat message", "chat-b"));
    await routing.route(message("m3", "back to first chat", "chat-a"));

    expect(prompts[1]?.recentContext).toEqual([]);
    expect(prompts[2]?.recentContext).toEqual([
      expect.objectContaining({ id: "m1", text: "first chat message" }),
    ]);
  });

  it("rejects hallucinated destinations and publishes only host-owned failure context", async () => {
    const failures: Array<{ id: string; error: unknown }> = [];
    const routing = createRoutingService({
      classify: async () => ({
        destination: { kind: "session", id: "session:not-real" },
        execution: { profile: "agent" },
        confidence: 0.99,
      }),
      sessions: async () => [projectSession],
      memory: async () => [],
      publishFailure: (input, error) => failures.push({ id: input.id, error }),
    });

    await expect(routing.route(message("m1", "put this in some session"))).rejects.toThrow(
      "unknown destination",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.id).toBe("m1");
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });

  it("rejects destination/execution mismatches and invalid confidence", async () => {
    let call = 0;
    const routing = createRoutingService({
      classify: async () => {
        call += 1;
        return call === 1
          ? { destination: { kind: "scheduler", id: "scheduler" }, execution: { profile: "agent" }, confidence: 0.8 }
          : { destination: { kind: "transient", id: "transient:utility" }, execution: { profile: "utility" }, confidence: 2 };
      },
      sessions: async () => [],
      memory: async () => [],
    });

    await expect(routing.route(message("m1", "route this somewhere"))).rejects.toThrow("expected scheduler");
    await expect(routing.route(message("m2", "quick question"))).rejects.toThrow("invalid confidence");
  });

  it("serializes concurrent messages from one conversation so context cannot race", async () => {
    const prompts: Record<string, any>[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const routing = createRoutingService({
      classify: async (request) => {
        calls += 1;
        prompts.push(JSON.parse(request.userPrompt));
        if (calls === 1) await firstGate;
        return validTransientDecision();
      },
      sessions: async () => [],
      memory: async () => [],
    });

    const first = routing.route(message("m1", "first"));
    const second = routing.route(message("m2", "second"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(prompts[1]?.recentContext).toEqual([expect.objectContaining({ id: "m1", text: "first" })]);
  });

  it("bounds ephemeral conversation context and honors an already-aborted route", async () => {
    let classifierCalls = 0;
    const routing = createRoutingService({
      classify: async () => {
        classifierCalls += 1;
        return validTransientDecision();
      },
      sessions: async () => [],
      memory: async () => [],
      maxContextMessages: 2,
    });

    await routing.route(message("m1", "one"));
    await routing.route(message("m2", "two"));
    await routing.route(message("m3", "three"));
    expect(routing.recentContext(message("x", "", "chat-1").principal).map((entry) => entry.id)).toEqual(["m2", "m3"]);

    const controller = new AbortController();
    controller.abort();
    await expect(routing.route(message("m4", "four"), { signal: controller.signal })).rejects.toThrow("Routing aborted");
    expect(classifierCalls).toBe(3);
  });
  it("routes concrete commitments and explicit reminders to scheduler without spending a classifier call", async () => {
    let classifierCalls = 0;
    let sessionSearches = 0;
    const routing = createRoutingService({
      classify: async () => { classifierCalls += 1; return validTransientDecision(); },
      sessions: async () => { sessionSearches += 1; return []; },
      memory: async () => [],
    });

    await expect(routing.route(message("m40", "We have a meeting at 5:30 today with KKK client."))).resolves.toMatchObject({
      destination: { kind: "scheduler", id: "scheduler" },
      execution: { profile: "scheduler" },
      confidence: 1,
    });
    await expect(routing.route(message("m41", "Remind me tomorrow at 9am to send the contract."))).resolves.toMatchObject({
      destination: { kind: "scheduler", id: "scheduler" },
    });
    expect(classifierCalls).toBe(0);
    expect(sessionSearches).toBe(0);
  });

  it("leaves reminder requests with incomplete timing to the semantic router for clarification", async () => {
    let classifierCalls = 0;
    const routing = createRoutingService({
      classify: async () => { classifierCalls += 1; return validTransientDecision(); },
      sessions: async () => [],
      memory: async () => [],
    });
    await expect(routing.route(message("m41a", "Remind me tomorrow to send the contract."))).resolves.toMatchObject({
      destination: { kind: "transient", id: "transient:utility" },
    });
    expect(classifierCalls).toBe(1);
  });

  it("leaves broad future-action statements to the semantic router instead of auto-scheduling them", async () => {
    let classifierCalls = 0;
    const routing = createRoutingService({
      classify: async () => { classifierCalls += 1; return validTransientDecision(); },
      sessions: async () => [],
      memory: async () => [],
    });
    await expect(routing.route(message("m41b", "I will debug the parser today at 5:30."))).resolves.toMatchObject({
      destination: { kind: "transient", id: "transient:utility" },
    });
    expect(classifierCalls).toBe(1);
  });

  it("does not misroute informational time questions through the deterministic reminder fast path", async () => {
    let classifierCalls = 0;
    const routing = createRoutingService({
      classify: async () => { classifierCalls += 1; return validTransientDecision(); },
      sessions: async () => [],
      memory: async () => [],
    });
    await expect(routing.route(message("m42", "What time is the client meeting at 5:30 today?"))).resolves.toMatchObject({
      destination: { kind: "transient", id: "transient:utility" },
    });
    expect(classifierCalls).toBe(1);
  });

  it("gives the router bounded attachment descriptors rather than attachment bytes or URLs", async () => {
    const payloads: Record<string, any>[] = [];
    const routing = createRoutingService({
      classify: async (request) => { payloads.push(JSON.parse(request.userPrompt)); return validTransientDecision(); },
      sessions: async () => [],
      memory: async () => [],
    });
    const inbound: RoutingMessage = {
      ...message("m43", "Review the attached data."),
      attachments: [{ kind: "document", mimeType: "application/json", fileName: "huge.json", sizeBytes: 50_000_000 }],
    };
    await routing.route(inbound);
    expect(payloads[0]?.attachments).toEqual([{
      kind: "document", mimeType: "application/json", fileName: "huge.json", sizeBytes: 50_000_000,
    }]);
    expect(JSON.stringify(payloads[0])).not.toContain("downloadUrl");
    expect(JSON.stringify(payloads[0])).not.toContain("artifactRef");
  });

});
