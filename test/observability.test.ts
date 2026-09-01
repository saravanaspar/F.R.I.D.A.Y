import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilityCompositionPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import eventsPlugin from "../plugins/events/index.js";
import { EVENTS_CAPABILITY } from "../plugins/events/contract.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import observabilityPlugin, {
  OBSERVABILITY_CAPABILITY,
  createObservabilityService,
  getObservabilityDatabasePath,
  getObservabilityStateDir,
} from "../plugins/observability/index.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";

const directories: string[] = [];
const originalStateDir = process.env.FRIDAY_STATE_DIR;

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-observability-"));
  directories.push(directory);
  return directory;
}

function handler(): PluginTestHost {
  return new PluginTestHost();
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalStateDir;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Observability", () => {
  it("persists bounded redacted logs with private permissions", async () => {
    const stateDir = await temp();
    const observability = createObservabilityService({ stateDir, maxLogRows: 2 });

    observability.log({ level: "info", component: "test", message: "first" });
    observability.log({
      level: "warn",
      component: "auth",
      message: "request Authorization: Bearer abcdefghijklmnop",
      fields: {
        token: "super-secret-token",
        nested: { password: "hunter2", requestId: "req-1" },
      },
    });
    observability.log({ level: "error", component: "test", message: "third" });

    const logs = observability.logs({ limit: 10 });
    expect(logs).toHaveLength(2);
    expect(logs.map((entry) => entry.message)).toEqual([
      "third",
      "request Authorization: Bearer [REDACTED]",
    ]);
    expect(logs[1]?.fields).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", requestId: "req-1" },
    });
    expect(await mode(stateDir)).toBe(0o700);
    expect(await mode(getObservabilityDatabasePath(stateDir))).toBe(0o600);

    observability.close();
  });

  it("persists bounded counter, gauge, and distribution series", async () => {
    const stateDir = await temp();
    let observability = createObservabilityService({ stateDir, maxMetricSeries: 3 });

    observability.increment("requests.total", 2, { route: "mcp", status: "ok" });
    observability.increment("requests.total", 3, { status: "ok", route: "mcp" });
    observability.gauge("workers.active", 4, { token: "do-not-store" });
    observability.observe("request.duration_ms", 20, { route: "mcp" });
    observability.observe("request.duration_ms", 40, { route: "mcp" });
    observability.increment("overflow.total", 1);

    expect(observability.metrics("requests.total")).toEqual([
      expect.objectContaining({ kind: "counter", value: 5, labels: { route: "mcp", status: "ok" } }),
    ]);
    expect(observability.metrics("workers.active")).toEqual([
      expect.objectContaining({ kind: "gauge", value: 4, labels: { token: "[REDACTED]" } }),
    ]);
    expect(observability.metrics("request.duration_ms")).toEqual([
      expect.objectContaining({ kind: "distribution", count: 2, sum: 60, min: 20, max: 40, average: 30 }),
    ]);
    expect(observability.status()).toMatchObject({
      health: "degraded",
      metricSeriesCount: 3,
      maxMetricSeries: 3,
      droppedMetrics: 1,
      droppedMetricsByReason: { "series-limit": 1 },
      metricSeriesUtilization: 1,
      metricSeriesNearCapacity: true,
      lastMetricDropReason: "series-limit",
    });

    observability.close();
    observability = createObservabilityService({ stateDir, maxMetricSeries: 3 });
    expect(observability.metrics("requests.total")[0]).toMatchObject({ value: 5 });
    observability.close();
  });

  it("persists bounded provider usage and keeps actual cost separate from estimates", async () => {
    const stateDir = await temp();
    let observability = createObservabilityService({ stateDir, maxUsageRows: 2 });
    observability.recordUsage({
      at: "2026-08-20T10:00:00.000Z",
      provider: "provider-a",
      model: "model-1",
      api: "responses",
      status: "ok",
      sessionId: "session-1",
      agentId: "agent-root",
      agentName: "root",
      jobId: "job-1",
      inputTokens: 60,
      outputTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      totalTokens: 110,
      tokenSource: "provider-reported",
      actualCost: 0.004,
      currency: "USD",
      costSource: "provider-reported",
    });
    observability.recordUsage({
      at: "2026-08-20T10:01:00.000Z",
      provider: "provider-a",
      model: "model-1",
      api: "responses",
      status: "ok",
      sessionId: "session-1",
      agentId: "agent-child",
      agentName: "researcher",
      parentAgentId: "agent-root",
      jobId: "job-1",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 25,
      tokenSource: "provider-reported",
      estimatedCost: 0.002,
      currency: "USD",
      costSource: "catalog-estimate",
    });
    observability.recordUsage({
      at: "2026-08-20T10:02:00.000Z",
      provider: "provider-b",
      model: "model-2",
      api: "messages",
      status: "ok",
      sessionId: "session-2",
      agentId: "agent-other",
      agentName: "other",
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 10,
      tokenSource: "provider-reported",
      costSource: "unavailable",
    });

    expect(observability.status()).toMatchObject({ usageCount: 2, maxUsageRows: 2, droppedUsage: 0 });
    expect(observability.usage({ provider: "provider-a" })).toHaveLength(1);
    const summary = observability.usageSummary();
    expect(summary.totals).toMatchObject({
      requests: 2,
      inputTokens: 28,
      outputTokens: 7,
      totalTokens: 35,
      actualCost: 0,
      actualCostRecords: 0,
      estimatedCost: 0.002,
      estimatedCostRecords: 1,
    });
    expect(summary.byAgent.map((entry) => [entry.key, entry.totalTokens])).toEqual([
      ["researcher", 25],
      ["other", 10],
    ]);
    expect(summary.note).toContain("never presented as billed cost");

    observability.close();
    observability = createObservabilityService({ stateDir, maxUsageRows: 2 });
    expect(observability.usage()).toHaveLength(2);
    observability.close();
  });

  it("propagates nested trace context and records failures without secret text", async () => {
    const observability = createObservabilityService({ stateDir: await temp() });
    let outerTraceId = "";
    let outerSpanId = "";

    await observability.withSpan({ name: "outer", component: "test", attributes: { token: "hide-me" } }, async () => {
      const outer = observability.currentTrace();
      expect(outer).toBeDefined();
      outerTraceId = outer!.traceId;
      outerSpanId = outer!.spanId;

      await expect(observability.withSpan({ name: "inner", component: "test" }, async () => {
        const inner = observability.currentTrace();
        expect(inner?.traceId).toBe(outerTraceId);
        expect(inner?.spanId).not.toBe(outerSpanId);
        throw new Error("password=hunter2");
      })).rejects.toThrow("password=hunter2");
    });

    const spans = observability.spans({ traceId: outerTraceId, limit: 10 });
    const outer = spans.find((span) => span.name === "outer");
    const inner = spans.find((span) => span.name === "inner");
    expect(outer).toMatchObject({ status: "ok", attributes: { token: "[REDACTED]" } });
    expect(inner).toMatchObject({ status: "error", parentSpanId: outerSpanId, error: "password=[REDACTED]" });

    observability.close();
  });

  it("reuses Events metadata and the existing Model log sink without storing event payloads", async () => {
    const stateDir = await temp();
    process.env.FRIDAY_STATE_DIR = stateDir;
    const friday = handler();
    await friday.activatePlugin(capabilityCompositionPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(eventsPlugin);
    await friday.activatePlugin(observabilityPlugin);
    await friday.activatePlugin(modelPlugin);

    const events = requireCapability(EVENTS_CAPABILITY);
    const observability = requireCapability(OBSERVABILITY_CAPABILITY);
    const models = requireCapability(MODEL_CAPABILITY);

    let traceId = "";
    await observability.withSpan({ name: "integration", component: "test" }, async () => {
      traceId = observability.currentTrace()!.traceId;
      events.publish({
        type: "routing.message.routed",
        source: "routing",
        subject: "message:1",
        data: { rawText: "do-not-copy-event-payload" },
      });
      models.api.getLogger("model-test").info("provider ready", { apiKey: "do-not-store", requestId: "req-1" });
    });

    const eventLog = observability.logs({ component: "events", limit: 10 })[0];
    expect(eventLog).toMatchObject({ message: "routing.message.routed", traceId });
    expect(JSON.stringify(eventLog)).not.toContain("do-not-copy-event-payload");
    expect(observability.metrics("friday.events.total")[0]).toMatchObject({
      value: 1,
      labels: { source: "routing", type: "routing.message.routed" },
    });

    const modelLog = observability.logs({ component: "model-test", limit: 10 })[0];
    expect(modelLog).toMatchObject({ traceId });
    expect(modelLog?.fields).toMatchObject({ apiKey: "[REDACTED]", requestId: "req-1" });

    models.api.setLogSink(undefined);
    observability.close();
    await events.close();
  });

  it("fails closed when the telemetry database is corrupt", async () => {
    const stateDir = await temp();
    await mkdir(stateDir, { recursive: true });
    await writeFile(getObservabilityDatabasePath(stateDir), "not-a-sqlite-database", { mode: 0o600 });

    expect(() => createObservabilityService({ stateDir })).toThrow();
  });

  it("uses mission-scoped FRIDAY state when configured", () => {
    expect(getObservabilityStateDir({ FRIDAY_STATE_DIR: "/tmp/friday-state", FRIDAY_HOME: "/tmp/friday-home" }))
      .toBe("/tmp/friday-state/observability");
  });
});
