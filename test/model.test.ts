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
    expect(service.getModels("deepseek").length).toBeGreaterThan(0);
    expect((service as unknown as { registerModel?: unknown }).registerModel).toBeUndefined();

    const registry = requireCapability(MODEL_REGISTRY_CAPABILITY);
    expect(typeof registry.registerModel).toBe("function");
    expect(typeof registry.unregisterModel).toBe("function");

    uninstallCapabilityRegistry();
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
