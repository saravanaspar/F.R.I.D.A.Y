import { createServer } from "node:http";
import * as modelRuntime from "@friday/model";
import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilityCompositionPlugin from "../plugins/capabilities/index.js";
import {
  definePlugin,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY, MODEL_REGISTRY_CAPABILITY } from "../plugins/model/contract.js";
import {
  OBSERVABILITY_CAPABILITY,
  type ObservabilityService,
} from "../plugins/observability/contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";

function handler(): PluginTestHost {
  return new PluginTestHost();
}

describe("model plugin", () => {
  it("exposes the model API through a FRIDAY capability", async () => {
    uninstallCapabilityRegistry();
    const friday = handler();
    await friday.activatePlugin(capabilityCompositionPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(modelPlugin);

    const service = requireCapability(MODEL_CAPABILITY);

    expect(typeof service.stream).toBe("function");
    expect(typeof service.complete).toBe("function");
    expect(typeof service.getModel).toBe("function");
    expect(typeof service.getProviders).toBe("function");
    expect(typeof service.supportsLiveModelDiscovery).toBe("function");
    expect(typeof service.discoverAvailableModelIds).toBe("function");
    expect(service.getProviders()).toContain("deepseek");
    expect(service.getModels("deepseek" as never)).toEqual([]);
    const liveOnly = service.getModel("deepseek" as never, "provider-returned-test-model" as never);
    expect(liveOnly).toMatchObject({
      provider: "deepseek",
      id: "provider-returned-test-model",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect((service as unknown as { registerModel?: unknown }).registerModel).toBeUndefined();

    const registry = requireCapability(MODEL_REGISTRY_CAPABILITY);
    expect(typeof registry.registerModel).toBe("function");
    expect(typeof registry.unregisterModel).toBe("function");

    uninstallCapabilityRegistry();
  });


  it("materializes arbitrary NVIDIA model ids from the provider transport profile instead of a bundled catalog", async () => {
    expect(modelRuntime.getProviders()).toContain("nvidia");

    const model = modelRuntime.getModel("nvidia", "live-model-returned-by-provider");
    expect(model).toMatchObject({
      id: "live-model-returned-by-provider",
      name: "live-model-returned-by-provider",
      provider: "nvidia",
      api: "openai-completions",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      reasoning: false,
      input: ["text"],
    });

    const previous = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-test-key";
    try {
      expect(modelRuntime.getEnvApiKey("nvidia")).toBe("nvapi-test-key");
    } finally {
      if (previous === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = previous;
    }
  });

  it("discovers NVIDIA API Catalog models visible to the supplied credential", async () => {
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("https://integrate.api.nvidia.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer nvidia-test-key");
      return new Response(JSON.stringify({
        data: [
          { id: "meta/llama-3.2-11b-vision-instruct" },
          { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
          { id: "nvidia/nemotron-3-super-120b-a12b" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(modelRuntime.discoverAvailableModelIds("nvidia", "nvidia-test-key", { fetchImpl }))
      .resolves.toEqual([
        "meta/llama-3.2-11b-vision-instruct",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        "nvidia/nemotron-3-super-120b-a12b",
      ]);
  });

  it("discovers OpenRouter models with the provider API key", async () => {
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openrouter-test-key");
      return new Response(JSON.stringify({
        data: [
          { id: "openai/gpt-5.6-sol", pricing: { prompt: "0.00001", completion: "0.00002" } },
          { id: "stealth/union-alpha", pricing: { prompt: "0", completion: "0", request: "0" } },
          { id: "anthropic/claude-sonnet-5" },
          { id: "meta/free-variant:free" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    expect(modelRuntime.supportsLiveModelDiscovery("openrouter")).toBe(true);
    await expect(modelRuntime.discoverAvailableModelIds("openrouter", "openrouter-test-key", { fetchImpl }))
      .resolves.toEqual([
        "meta/free-variant:free",
        "stealth/union-alpha",
        "openai/gpt-5.6-sol",
        "anthropic/claude-sonnet-5",
      ]);
    expect(modelRuntime.getDiscoveredModelPricingTier("openrouter", "stealth/union-alpha")).toBe("free");
    expect(modelRuntime.getDiscoveredModelPricingTier("openrouter", "openai/gpt-5.6-sol")).toBe("paid");
    expect(modelRuntime.getDiscoveredModelPricingTier("openrouter", "anthropic/claude-sonnet-5")).toBe("unknown");
    expect(modelRuntime.compareDiscoveredModelIds("openrouter", "stealth/union-alpha", "openai/gpt-5.6-sol")).toBeLessThan(0);
  });

  it("uses bearer OAuth headers when discovering Anthropic models with a Claude OAuth token", async () => {
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toContain("https://api.anthropic.com/v1/models");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test-token");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
      return new Response(JSON.stringify({
        data: [{ id: "claude-sonnet-5" }],
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(modelRuntime.discoverAvailableModelIds("anthropic", "sk-ant-oat-test-token", { fetchImpl }))
      .resolves.toEqual(["claude-sonnet-5"]);
  });

  it("maps NVIDIA NIM reasoning and token options onto its OpenAI-compatible request", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.end([
          'data: {"id":"chatcmpl-nvidia","object":"chat.completion.chunk","created":1,"model":"test-nvidia","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl-nvidia","object":"chat.completion.chunk","created":1,"model":"test-nvidia","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join("\n"));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    try {
      const descriptor: modelRuntime.Model<"openai-completions"> = {
        id: "test-nvidia",
        name: "Test NVIDIA",
        api: "openai-completions",
        provider: "nvidia",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      };
      const thinkingResponse = await modelRuntime.completeSimple(
        descriptor,
        {
          systemPrompt: "Return concise output.",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        { apiKey: "nvidia-test-key", maxTokens: 128, temperature: 0, reasoning: "high" },
      );
      const instructResponse = await modelRuntime.completeSimple(
        descriptor,
        {
          systemPrompt: "Return concise output.",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        { apiKey: "nvidia-test-key", maxTokens: 64, temperature: 0, reasoning: "off" },
      );
      const providerDefaultResponse = await modelRuntime.completeSimple(
        descriptor,
        {
          systemPrompt: "Return concise output.",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        { apiKey: "nvidia-test-key", maxTokens: 32, temperature: 0 },
      );

      expect(thinkingResponse.stopReason).toBe("stop");
      expect(instructResponse.stopReason).toBe("stop");
      expect(providerDefaultResponse.stopReason).toBe("stop");
      expect(requestBodies).toHaveLength(3);
      expect(requestBodies[0]).toMatchObject({
        model: "test-nvidia",
        max_tokens: 128,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(requestBodies[0]).not.toHaveProperty("max_completion_tokens");
      expect(requestBodies[0]).not.toHaveProperty("store");
      expect(requestBodies[0]).not.toHaveProperty("stream_options");
      expect(requestBodies[1]).toMatchObject({
        model: "test-nvidia",
        max_tokens: 64,
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(requestBodies[2]).toMatchObject({
        model: "test-nvidia",
        max_tokens: 32,
      });
      expect(requestBodies[2]).not.toHaveProperty("chat_template_kwargs");
      const messages = requestBodies[0]?.messages as Array<{ role?: string }> | undefined;
      expect(messages?.[0]?.role).toBe("system");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("discovers only Google generateContent models visible to the supplied credential across pages", async () => {
    const requests: Array<{ url: string; key: string | null }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url: url.toString(), key: new Headers(init?.headers).get("x-goog-api-key") });
      if (!url.searchParams.has("pageToken")) {
        return new Response(JSON.stringify({
          models: [
            { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent", "countTokens"] },
            { name: "models/text-embedding-999", supportedGenerationMethods: ["embedContent"] },
          ],
          nextPageToken: "next-page",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        models: [
          { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent"] },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const ids = await modelRuntime.discoverAvailableModelIds("google", "secret-test-key", { fetchImpl });

    expect(ids).toEqual(["gemini-3.5-flash-lite", "gemma-4-31b-it"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.key === "secret-test-key")).toBe(true);
    expect(requests[1]!.url).toContain("pageToken=next-page");
  });

  it("does not leak provider credentials in model-discovery failures", async () => {
    const secret = "do-not-log-this-key";
    const fetchImpl: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: `API key ${secret} is invalid` },
    }), { status: 400, headers: { "content-type": "application/json" } });

    let message = "";
    try {
      await modelRuntime.discoverAvailableModelIds("google", secret, { fetchImpl });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("HTTP 400");
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("is invalid");
    expect(message).not.toContain(secret);
  });

  it("uses credential-scoped language-model discovery for xAI and keeps aliases selectable", async () => {
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/language-models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-test-key");
      return new Response(JSON.stringify({
        models: [
          { id: "grok-4.6", aliases: ["grok-4.6-latest"] },
          { id: "grok-code-fast-1", aliases: [] },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(modelRuntime.discoverAvailableModelIds("xai", "xai-test-key", { fetchImpl }))
      .resolves.toEqual(["grok-4.6", "grok-4.6-latest", "grok-code-fast-1"]);
  });

  it("derives bounded TTFT and cache metrics from content-free model telemetry", async () => {
    uninstallCapabilityRegistry();
    const friday = handler();
    const counters: Array<{ name: string; value: number }> = [];
    const distributions: Array<{ name: string; value: number }> = [];
    const logs: Array<{ component: string; message: string; fields?: Record<string, unknown> | undefined }> = [];
    const observability: ObservabilityService = {
      log(input) {
        logs.push({ component: input.component, message: input.message, fields: input.fields });
      },
      increment(name, value = 1) {
        counters.push({ name, value });
      },
      gauge() {},
      observe(name, value) {
        distributions.push({ name, value });
      },
      currentTrace: () => undefined,
      startSpan() {
        return { context: { traceId: "trace", spanId: "span" }, end() {} };
      },
      withSpan(_input, operation) {
        return operation();
      },
      logs: () => [],
      spans: () => [],
      metrics: () => [],
      status: () => ({
        health: "healthy",
        logCount: 0,
        spanCount: 0,
        metricSeriesCount: 0,
        maxLogRows: 0,
        maxSpanRows: 0,
        maxMetricSeries: 0,
        droppedLogs: 0,
        droppedSpans: 0,
        droppedMetrics: 0,
        droppedMetricsByReason: {},
        metricSeriesUtilization: 0,
        metricSeriesNearCapacity: false,
      }),
      close() {},
    };
    const observabilityStub = definePlugin({
      id: "model-observability-stub",
      provides: [OBSERVABILITY_CAPABILITY],
    }, (ctx) => {
      ctx.services.provide(OBSERVABILITY_CAPABILITY, observability);
    });

    await friday.activatePlugin(capabilityCompositionPlugin);
    await friday.activatePlugin(observabilityStub);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(modelPlugin);

    const service = requireCapability(MODEL_CAPABILITY);
    const stream = modelRuntime.createAssistantMessageEventStream();
    modelRuntime.attachModelStreamTelemetry(stream, {
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
    });
    const message = {
      role: "assistant" as const,
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 50,
        cacheWrite: 0,
        totalTokens: 170,
        cost: { input: 0.1, output: 0.04, cacheRead: 0.005, cacheWrite: 0, total: 0.145 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    stream.push({ type: "done", reason: "stop", message });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ component: "ai.model", message: "model request completed" });
    expect(counters).toContainEqual({ name: "model.requests", value: 1 });
    expect(distributions.some((metric) => metric.name === "model.request.duration_ms")).toBe(true);
    expect(distributions.some((metric) => metric.name === "model.cache.read_ratio")).toBe(true);
  });
});
