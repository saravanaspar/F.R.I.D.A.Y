import { afterEach, describe, expect, it } from "vitest";
import {
  attachModelStreamTelemetry,
  createAssistantMessageEventStream,
  effectiveCacheSemantics,
  getCacheSemantics,
  setLogSink,
  splitStableSystemPrompt,
  type AssistantMessage,
  type LogEntry,
  type Model,
} from "@friday/model";

const openAIResponsesModel = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} satisfies Model<"openai-responses">;

afterEach(() => setLogSink(undefined));

describe("model cache semantics", () => {
  it("classifies explicit, strict, tolerant, and disabled cache behavior", () => {
    const anthropic = {
      ...openAIResponsesModel,
      api: "anthropic-messages" as const,
      provider: "anthropic",
    } satisfies Model<"anthropic-messages">;
    const deepseek = {
      ...openAIResponsesModel,
      api: "openai-completions" as const,
      provider: "deepseek",
    } satisfies Model<"openai-completions">;

    expect(getCacheSemantics(anthropic)).toEqual({ kind: "explicit-breakpoints", maxBreakpoints: 4 });
    expect(getCacheSemantics(openAIResponsesModel)).toEqual({ kind: "implicit-strict" });
    expect(getCacheSemantics(deepseek)).toEqual({ kind: "implicit-tolerant" });
    expect(effectiveCacheSemantics(openAIResponsesModel, "none")).toEqual({ kind: "uncached" });
  });

  it("splits only a genuine stable byte prefix", () => {
    expect(splitStableSystemPrompt("stable\nvolatile", "stable")).toEqual(["stable", "\nvolatile"]);
    expect(splitStableSystemPrompt("stable", "stable")).toBeUndefined();
    expect(splitStableSystemPrompt("stable\nvolatile", "other")).toBeUndefined();
  });
});

describe("model stream telemetry", () => {
  it("records TTFT, cache usage, and duration without logging content", () => {
    const entries: LogEntry[] = [];
    setLogSink((entry) => entries.push(entry));

    let clock = 100;
    const stream = createAssistantMessageEventStream();
    attachModelStreamTelemetry(stream, openAIResponsesModel, { sessionId: "session-secret-id" }, () => clock);

    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };

    clock = 120;
    stream.push({ type: "start", partial });
    clock = 180;
    stream.push({ type: "text_delta", contentIndex: 0, delta: "secret model output", partial });
    clock = 300;
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        ...partial,
        content: [{ type: "text", text: "secret model output" }],
        responseId: "resp-1",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 10,
          totalTokens: 180,
          cost: { input: 0.1, output: 0.04, cacheRead: 0.005, cacheWrite: 0.01, total: 0.155 },
        },
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      component: "ai.model",
      msg: "model request completed",
      provider: "openai",
      model: "gpt-test",
      api: "openai-responses",
      status: "ok",
      durationMs: 200,
      ttftMs: 80,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      totalTokens: 180,
      cacheRetention: "short",
      cacheSemantics: "implicit-strict",
      sessionCacheKey: true,
    });
    expect(JSON.stringify(entries[0])).not.toContain("secret model output");
    expect(JSON.stringify(entries[0])).not.toContain("session-secret-id");
  });

  it("records a stream that terminated before telemetry could subscribe", async () => {
    const entries: LogEntry[] = [];
    setLogSink((entry) => entries.push(entry));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "request construction failed",
      timestamp: 1,
    };
    stream.push({ type: "error", reason: "error", error: message });

    attachModelStreamTelemetry(stream, openAIResponsesModel);
    await Promise.resolve();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      component: "ai.model",
      msg: "model request terminated",
      status: "error",
    });
    expect(JSON.stringify(entries[0])).not.toContain("request construction failed");
  });
});
