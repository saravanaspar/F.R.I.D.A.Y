import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilityCompositionPlugin from "../plugins/capabilities/index.js";
import {
  definePlugin,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
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

    expect(typeof service.api.stream).toBe("function");
    expect(typeof service.api.complete).toBe("function");
    expect(typeof service.api.getModel).toBe("function");
    expect(typeof service.api.getProviders).toBe("function");
    expect(service.api.getProviders()).toContain("deepseek");
    expect(service.api.getModels("deepseek").length).toBeGreaterThan(0);

    uninstallCapabilityRegistry();
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
    const stream = service.api.createAssistantMessageEventStream();
    service.api.attachModelStreamTelemetry(stream, {
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
