import { EventStream } from "../src/event-stream.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/model-types.js";
import { Agent } from "../src/agent.js";
import {
  FRIDAY_MODEL_RETRY_MAX_RETRIES,
  modelRetryDelayMs,
  retryableModelFailure,
} from "../src/retry.js";
import { describe, expect, it } from "vitest";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => event.type === "done" ? event.message : event.type === "error" ? event.error : (() => { throw new Error("unexpected"); })(),
    );
  }
}

function model(): Model<string> {
  return {
    id: "retry-model",
    name: "retry-model",
    api: "test",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

function message(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "retry-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: text } : {}),
    timestamp: Date.now(),
  };
}

describe("model retry policy", () => {
  it("uses the OpenCode-style bounded exponential schedule and FRIDAY's ten-retry ceiling", () => {
    const delays = Array.from({ length: 10 }, (_, index) => modelRetryDelayMs(index + 1, undefined, 0));
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    expect(FRIDAY_MODEL_RETRY_MAX_RETRIES).toBe(10);
  });

  it("honors Retry-After and does not retry context overflow", () => {
    expect(modelRetryDelayMs(4, { message: "rate limited", headers: { "retry-after-ms": "1500" } }, 0)).toBe(1500);
    expect(retryableModelFailure({ message: "maximum context window exceeded", status: 400 })).toBeUndefined();
    expect(retryableModelFailure({ message: "connection reset", status: 500 })).toBeDefined();
    expect(retryableModelFailure({ message: "Too many requests", status: 429 })).toEqual({ message: "Too Many Requests" });
    expect(retryableModelFailure({ message: "max_tokens must be <= 500", status: 400 })).toBeUndefined();
    expect(retryableModelFailure({ message: "authorization failed for account 503", status: 401 })).toBeUndefined();
  });

  it("retries transient model failures without persisting failed assistant attempts", async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; maxRetries: number; delayMs: number }> = [];
    const agent = new Agent({
      initialState: { model: model() },
      streamFn: (selected, _context, options) => {
        calls += 1;
        void options?.onResponse?.({ status: calls < 3 ? 429 : 200, headers: calls < 3 ? { "retry-after-ms": "0" } : {} }, selected);
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          if (calls < 3) {
            const failed = message("Rate limit exceeded", "error");
            stream.push({ type: "error", reason: "error", error: failed });
          } else {
            const done = message("done", "stop");
            stream.push({ type: "done", reason: "stop", message: done });
          }
        });
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "model_retry") retries.push({ attempt: event.attempt, maxRetries: event.maxRetries, delayMs: event.delayMs });
    });

    await agent.prompt("hello");

    expect(calls).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, maxRetries: 10, delayMs: 0 },
      { attempt: 2, maxRetries: 10, delayMs: 0 },
    ]);
    expect(agent.state.messages.filter((entry) => entry.role === "assistant")).toHaveLength(1);
    expect(agent.state.messages.some((entry) => entry.role === "assistant" && (entry as AssistantMessage).errorMessage)).toBe(false);
  });

  it("uses persisted provider failure metadata when an SDK fails before onResponse", async () => {
    let calls = 0;
    const delays: number[] = [];
    const agent = new Agent({
      initialState: { model: model() },
      streamFn: () => {
        calls += 1;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          if (calls === 1) {
            const failed = message("Provider rate limit exceeded", "error");
            failed.diagnostics = [{
              type: "provider_stream_failure",
              timestamp: Date.now(),
              details: { status: 429, retryAfterMs: "0" },
            }];
            stream.push({ type: "error", reason: "error", error: failed });
          } else {
            const done = message("done", "stop");
            stream.push({ type: "done", reason: "stop", message: done });
          }
        });
        return stream;
      },
    });
    agent.subscribe((event) => { if (event.type === "model_retry") delays.push(event.delayMs); });

    await agent.prompt("hello");

    expect(calls).toBe(2);
    expect(delays).toEqual([0]);
  });

  it("never retries local transforms, response hooks, or event listeners", async () => {
    let transformCalls = 0;
    let providerCalls = 0;
    const transformAgent = new Agent({
      initialState: { model: model() },
      transformContext: async () => {
        transformCalls += 1;
        throw new Error("local timeout 500");
      },
      streamFn: () => {
        providerCalls += 1;
        return new MockAssistantStream();
      },
    });
    await transformAgent.prompt("hello");
    expect(transformCalls).toBe(1);
    expect(providerCalls).toBe(0);

    let responseCalls = 0;
    const responseAgent = new Agent({
      initialState: { model: model() },
      onResponse: async () => { throw new Error("response hook timeout 500"); },
      streamFn: async (selected, _context, options) => {
        responseCalls += 1;
        await options?.onResponse?.({ status: 200, headers: {} }, selected);
        return new MockAssistantStream();
      },
    });
    await responseAgent.prompt("hello");
    expect(responseCalls).toBe(1);

    let caughtResponseCalls = 0;
    const caughtResponseAgent = new Agent({
      initialState: { model: model() },
      onResponse: async () => { throw new Error("caught response hook timeout 500"); },
      streamFn: (selected, _context, options) => {
        caughtResponseCalls += 1;
        const stream = new MockAssistantStream();
        void Promise.resolve(options?.onResponse?.({ status: 200, headers: {} }, selected)).then(
          () => { throw new Error("response hook unexpectedly succeeded"); },
          () => {
            const failed = message("caught response hook timeout 500", "error");
            stream.push({ type: "error", reason: "error", error: failed });
          },
        );
        return stream;
      },
    });
    await caughtResponseAgent.prompt("hello");
    expect(caughtResponseCalls).toBe(1);

    let payloadCalls = 0;
    const payloadAgent = new Agent({
      initialState: { model: model() },
      onPayload: async () => { throw new Error("payload hook timeout 500"); },
      streamFn: (_selected, _context, options) => {
        payloadCalls += 1;
        const stream = new MockAssistantStream();
        void Promise.resolve(options?.onPayload?.({}, model())).then(
          () => { throw new Error("payload hook unexpectedly succeeded"); },
          () => {
            const failed = message("payload hook timeout 500", "error");
            stream.push({ type: "error", reason: "error", error: failed });
          },
        );
        return stream;
      },
    });
    await payloadAgent.prompt("hello");
    expect(payloadCalls).toBe(1);

    let listenerCalls = 0;
    const listenerAgent = new Agent({
      initialState: { model: model() },
      streamFn: () => {
        listenerCalls += 1;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const done = message("done", "stop");
          stream.push({ type: "done", reason: "stop", message: done });
        });
        return stream;
      },
    });
    listenerAgent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") throw new Error("listener timeout 500");
    });
    await listenerAgent.prompt("hello");
    expect(listenerCalls).toBe(1);
  });
});
