import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import diagnosticsPlugin from "../plugins/diagnostics/index.js";
import { collectDoctorChecks } from "../plugins/host-doctor/collector.js";
import hostDoctorPlugin from "../plugins/host-doctor/index.js";
import { DIAGNOSTICS_CAPABILITY } from "../plugins/diagnostics/contract.js";
import { OBSERVABILITY_CAPABILITY, type ObservabilityService } from "../plugins/observability/contract.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../plugins/runtime-settings/contract.js";
import { saveRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { SYSTEM_STATUS_CONTRIBUTION } from "../plugins/system/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const previousHome = process.env.FRIDAY_HOME;

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "friday-diagnostics-"));
  roots.push(home);
  return home;
}

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (previousHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostics", () => {
  it("keeps router-only Doctor healthy enough to operate and redacts bounded plugin status evidence", async () => {
    const home = await tempHome();
    process.env.FRIDAY_HOME = home;
    const workspace = join(home, "..", `${basename(home)}-workspace`);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await saveRuntimeSettings({
      routingProvider: "test-router",
      routingModelId: "router-1",
      permissionMode: "ask",
      hostPrivilegeMode: "none",
      timezone: "UTC",
      workspaceRoot: workspace,
    }, home);
    const secret = "DIAGNOSTIC_SECRET_SENTINEL";
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(definePlugin({ id: "test-diagnostics-observability", provides: [OBSERVABILITY_CAPABILITY] }, (ctx) => {
      const observability = {
        log() {}, increment() {}, gauge() {}, observe() {}, currentTrace: () => undefined,
        startSpan: () => ({ context: { traceId: "trace", spanId: "span" }, end() {} }),
        withSpan: (_input: unknown, operation: () => unknown) => operation(),
        logs: () => [{
          sequence: 1,
          at: "2026-09-08T00:00:00.000Z",
          level: "error",
          component: "voice",
          message: `provider failed Authorization: Bearer ${secret}`,
          fields: { apiKey: secret, detail: `token=${secret}` },
        }],
        spans: () => [{
          sequence: 1,
          traceId: "trace",
          spanId: "span",
          name: "voice setup",
          component: "voice",
          startedAt: "2026-09-08T00:00:00.000Z",
          endedAt: "2026-09-08T00:00:01.000Z",
          durationMs: 1000,
          status: "error",
          attributes: { password: secret, detail: `Authorization: Bearer ${secret}` },
          error: `voice setup failed token=${secret}`,
        }],
        metrics: () => [],
        status: () => ({
          health: "healthy",
          logCount: 1,
          spanCount: 1,
          metricSeriesCount: 0,
          maxLogRows: 100,
          maxSpanRows: 100,
          maxMetricSeries: 100,
          droppedLogs: 0,
          droppedSpans: 0,
          droppedMetrics: 0,
          droppedMetricsByReason: {},
          metricSeriesUtilization: 0,
          metricSeriesNearCapacity: false,
        }),
        close() {},
      } as unknown as ObservabilityService;
      ctx.services.provide(OBSERVABILITY_CAPABILITY, observability);
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-diagnostics-runtime", provides: [RUNTIME_SETTINGS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(RUNTIME_SETTINGS_CAPABILITY, {
        async read() {
          return {
            routingProvider: "test-router",
            routingModelId: "router-1",
            permissionMode: "ask",
            hostPrivilegeMode: "none",
            timezone: "UTC",
            workspaceRoot: workspace,
          };
        },
        async update() { throw new Error("not used"); },
        async onboarding() { return undefined; },
        async markOnboardingStep() { throw new Error("not used"); },
      });
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-diagnostics-status" }, (ctx) => {
      ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
        id: "unsafe-status",
        label: "Unsafe status",
        snapshot: () => ({
          ready: false,
          apiKey: secret,
          nested: { password: secret },
          detail: `request Authorization: Bearer ${secret}`,
          oversized: "x".repeat(10_000),
        }),
      });
    }), { defer: true });
    await friday.activatePlugin(hostDoctorPlugin, { defer: true });
    await friday.activatePlugin(diagnosticsPlugin, { defer: true });
    await friday.completePluginBootstrap();

    const diagnostics = requireCapability(DIAGNOSTICS_CAPABILITY);
    const doctor = await diagnostics.doctor();
    expect(doctor).toEqual(await collectDoctorChecks(process.env));
    expect(doctor.find((check) => check.id === "runtime-settings")).toMatchObject({ level: "ok", message: "router-only" });
    expect(doctor.find((check) => check.id === "model-credential")?.message).not.toBe("main model is required");

    const review = await diagnostics.review({ component: "voice", limit: 20 });
    expect(review.runtime).toMatchObject({ routerOnly: true, mainModelConfigured: false, hostPrivilegeMode: "none" });
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain(secret);
    expect(review.statuses["unsafe-status"]).toContain("[REDACTED]");
    expect(review.statuses["unsafe-status"]!.length).toBeLessThanOrEqual(2_000);
    expect(review.logs).toHaveLength(1);
    expect(review.spans).toHaveLength(1);
    expect(JSON.stringify(review.logs)).not.toContain(secret);
    expect(JSON.stringify(review.spans)).not.toContain(secret);
  });
});
