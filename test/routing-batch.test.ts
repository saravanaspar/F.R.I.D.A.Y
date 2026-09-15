import { describe, expect, it, vi } from "vitest";
import { createRoutingService } from "../plugins/routing/router.js";
import type { RoutingMessage } from "../plugins/routing/contract.js";

function message(id: string, text: string, conversationId = "chat-1"): RoutingMessage {
  return Object.freeze({
    id,
    principal: Object.freeze({
      authority: "channel" as const,
      channel: "telegram",
      accountId: "default",
      conversationId,
      senderId: "operator-1",
    }),
    text,
    timestamp: Date.now(),
  });
}

function utilityDecision(messageId: string, capabilityProfile: "none" | "computer" | "general" = "none") {
  return {
    messageId,
    destination: { kind: "transient", id: "transient:utility" },
    execution: { profile: "utility", capabilityProfile },
    confidence: 0.99,
  };
}

describe("routing batch classifier", () => {
  it("routes a one-off Computer request as utility+computer instead of stripping its tools", async () => {
    const classify = vi.fn(async () => utilityDecision("m1", "computer"));
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });

    const decision = await routing.route(message("m1", "open a new screen and open youtube play shakaboom"));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      destination: { kind: "transient", id: "transient:utility" },
      execution: { profile: "utility", capabilityProfile: "computer" },
    });
  });

  it("widens legacy classifier responses without capability metadata to general", async () => {
    const classify = vi.fn(async () => ({
      destination: { kind: "transient", id: "transient:utility" },
      execution: { profile: "utility" },
      confidence: 0.9,
    }));
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });

    const decision = await routing.route(message("legacy", "do a one-off action"));
    expect(decision.execution.capabilityProfile).toBe("general");
  });

  it("classifies an ordered burst with one model request and preserves per-message decisions", async () => {
    const classify = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
      const payload = JSON.parse(userPrompt) as { messages: Array<{ id: string }> };
      return { decisions: payload.messages.map((entry) => utilityDecision(entry.id)) };
    });
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });
    const inputs = [message("m1", "hi"), message("m2", "what can you do?"), message("m3", "summarize this")];
    const decisions = await routing.routeBatch(inputs);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(decisions.map((decision) => decision.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(decisions.every((decision) => decision.destination.id === "transient:utility")).toBe(true);
    expect(routing.recentContext(inputs[0]!.principal).map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps deterministic scheduler items host-owned and excludes them from the classifier batch", async () => {
    const classify = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
      const payload = JSON.parse(userPrompt) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((entry) => entry.id)).toEqual(["m2"]);
      return { decisions: [utilityDecision("m2")] };
    });
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });
    const decisions = await routing.routeBatch([
      message("m1", "remind me in 10 minutes to stretch"),
      message("m2", "hello"),
    ]);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(decisions[0]).toMatchObject({ messageId: "m1", destination: { kind: "scheduler", id: "scheduler" }, execution: { profile: "scheduler" } });
    expect(decisions[1]).toMatchObject({ messageId: "m2", destination: { kind: "transient", id: "transient:utility" } });
  });

  it("preserves the narrow capability profile per utility message in one batch", async () => {
    const classify = vi.fn(async ({ userPrompt }: { userPrompt: string }) => {
      const payload = JSON.parse(userPrompt) as { messages: Array<{ id: string }> };
      expect(payload.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
      return {
        decisions: [
          utilityDecision("m1", "none"),
          utilityDecision("m2", "computer"),
        ],
      };
    });
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });

    const decisions = await routing.routeBatch([
      message("m1", "hi"),
      message("m2", "open a new screen and play Shakaboom on YouTube"),
    ]);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(decisions.map((decision) => decision.execution.capabilityProfile)).toEqual(["none", "computer"]);
  });

  it("fails closed when the classifier assigns a narrow capability to a persistent Agent session", async () => {
    const classify = vi.fn(async () => ({
      decisions: [{
        messageId: "m1",
        destination: { kind: "session", id: "session:new" },
        execution: { profile: "agent", capabilityProfile: "computer" },
        confidence: 0.99,
      }],
    }));
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });

    await expect(routing.routeBatch([message("m1", "start a project")]))
      .rejects.toThrow(/capability profile computer.*execution profile agent/i);
  });

  it("rejects cross-conversation batching before any model request", async () => {
    const classify = vi.fn();
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });
    await expect(routing.routeBatch([
      message("m1", "one", "chat-1"),
      message("m2", "two", "chat-2"),
    ])).rejects.toThrow(/one continuity scope/i);
    expect(classify).not.toHaveBeenCalled();
  });

  it("fails closed when the model duplicates or omits a batch message id", async () => {
    const classify = vi.fn(async () => ({ decisions: [utilityDecision("m1"), utilityDecision("m1")] }));
    const routing = createRoutingService({
      classify,
      sessions: async () => Object.freeze([]),
      memory: async () => Object.freeze([]),
    });
    await expect(routing.routeBatch([message("m1", "one"), message("m2", "two")])).rejects.toThrow(/duplicate batch decision/i);
  });
});
