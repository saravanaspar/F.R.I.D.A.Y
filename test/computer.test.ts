import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { createComputerPlugin, createComputerService } from "../plugins/computer/index.js";
import {
  COMPUTER_CAPABILITY,
  type ComputerBrowserActionRequest,
  type ComputerNodeAdapter,
  type ComputerNodeRuntimeSnapshot,
  type ComputerNodeToolExecutionRequest,
  type ComputerRunProcessCleanupRequest,
  type ComputerObservation,
} from "../plugins/computer/contract.js";
import { createEventsPlugin } from "../plugins/events/index.js";
import { PERMISSIONS_CAPABILITY, type PermissionRequest, type PermissionsService } from "../plugins/permissions/contract.js";
import { AGENT_TOOL_CONTRIBUTION, type AgentToolExecutionContext, type TurnProgressUpdate } from "../plugins/turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../plugins/system/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

function observation(screenId = "agent-1"): ComputerObservation {
  return Object.freeze({
    observedAt: new Date().toISOString(),
    screenId,
    observationId: "obs-1",
    safety: { protectedInputOmitted: true as const, keystrokesOmitted: true as const, captchaOmitted: true as const, sensitiveScreenshotOmitted: true as const },
    url: "https://example.com/after-takeover",
    domSummary: "signed-in page; secret fields omitted",
    accessibilitySummary: "main document",
    tabs: Object.freeze([{ id: "tab-1", title: "Example", url: "https://example.com/after-takeover", active: true }]),
    screenshotArtifactRef: "artifact:screen-safe",
    elements: Object.freeze([{
      id: "e1", ref: "obs-1:e1", role: "button", name: "Continue",
      bbox: { left: 10, top: 10, right: 50, bottom: 50 },
      visible: true, enabled: true, focused: false, interactive: true, clickable: true, editable: false,
      selectable: false, scrollable: false, draggable: false, actions: Object.freeze(["click" as const]),
      source: "dom" as const, confidence: 0.95,
    }]),
    processes: Object.freeze([{ pid: 123, name: "chromium" }]),
  });
}

function healthySnapshot(): ComputerNodeRuntimeSnapshot {
  return Object.freeze({
    availability: "online",
    resources: Object.freeze({
      totalMemoryMb: 8_192,
      availableMemoryMb: 6_144,
      cpuPercent: 20,
      browserRendererCount: 3,
      gpuPercent: 15,
      screenWorkloadPercent: 25,
    }),
    screens: Object.freeze([
      { id: "human-1", label: "Human", kind: "human" as const, width: 1_920, height: 1_080 },
      { id: "agent-1", label: "Agent 1", kind: "agent" as const, width: 1_920, height: 1_080 },
    ]),
    browser: Object.freeze({
      running: true,
      profileId: "shared-profile",
      contextId: "shared-context",
      persistentProfile: true,
      windows: Object.freeze([{ id: "window-1", owner: "friday" as const, screenId: "agent-1", tabIds: Object.freeze(["tab-1"]) }]),
      tabs: Object.freeze([{ id: "tab-1", title: "Example", url: "https://example.com/", active: true }]),
    }),
  });
}

function fakeAdapter(overrides: Partial<ComputerNodeAdapter> = {}): ComputerNodeAdapter & {
  setSnapshot(value: ComputerNodeRuntimeSnapshot): void;
  browserRequests: ComputerBrowserActionRequest[];
  toolRequests: ComputerNodeToolExecutionRequest[];
  cleanupRequests: ComputerRunProcessCleanupRequest[];
  observations: number;
  armHighImpactBrowserGate(): void;
  lifecycle: { restarts: number; updates: number; resets: number };
} {
  let snapshotValue = healthySnapshot();
  const browserRequests: ComputerBrowserActionRequest[] = [];
  const toolRequests: ComputerNodeToolExecutionRequest[] = [];
  const cleanupRequests: ComputerRunProcessCleanupRequest[] = [];
  let observations = 0;
  let highImpactBrowserGate = false;
  const lifecycle = { restarts: 0, updates: 0, resets: 0 };
  const adapter: ComputerNodeAdapter & {
    setSnapshot(value: ComputerNodeRuntimeSnapshot): void;
    browserRequests: ComputerBrowserActionRequest[];
    toolRequests: ComputerNodeToolExecutionRequest[];
    cleanupRequests: ComputerRunProcessCleanupRequest[];
    observations: number;
    armHighImpactBrowserGate(): void;
    lifecycle: { restarts: number; updates: number; resets: number };
  } = {
    descriptor: Object.freeze({
      id: "node-1",
      label: "Test Computer",
      platform: "test",
      capabilities: Object.freeze({
        executionOperations: Object.freeze(["shell", "edit", "process", "git"] as const),
        browser: true,
        playwright: true,
        accessibility: true,
        cdp: true,
        visualControl: true,
        screenCapture: true,
        rawInput: true,
        virtualDisplays: true,
        managedLifecycle: true,
      }),
      admission: Object.freeze({
        minAvailableMemoryMb: 1_024,
        maxCpuPercent: 85,
        maxBrowserRenderers: 12,
        maxGpuPercent: 90,
        maxScreenWorkloadPercent: 90,
      }),
    }),
    async snapshot() { return snapshotValue; },
    async observeScreen(screenId) { observations += 1; return observation(screenId); },
    async runTool(request) {
      toolRequests.push(request);
      return { content: [{ type: "text", text: `remote:${request.tool}` }], details: { operation: request.operation } };
    },
    async cleanupRunProcesses(request) { cleanupRequests.push(request); },
    async runBrowserAction(request) {
      browserRequests.push(request);
      if (highImpactBrowserGate && request.action.kind === "click" && !request.action.visualProbeToken) {
        return {
          mode: "cdp" as const,
          performed: false,
          confidence: 0.95,
          visualProbeRequired: { ref: request.action.target, reason: "high-impact-action" as const, recommendedSize: "small" as const },
          observation: observation(request.screenId),
        };
      }
      if (highImpactBrowserGate && request.action.kind === "click" && request.action.visualProbeToken) highImpactBrowserGate = false;
      return { mode: request.automationOrder[0]!, observation: observation(request.screenId) };
    },
    async visualProbe(request) {
      return {
        observationId: "obs-1",
        safety: { protectedRegionOmitted: true as const, challengeRegionOmitted: true as const },
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        bbox: request.bbox ?? { left: 10, top: 10, right: 50, bottom: 50 },
        width: 40,
        height: 40,
        targetMatch: true,
        confidence: 0.95,
        visibleText: ["Continue"],
        ...(request.ref === undefined ? {} : { probeToken: "probe-test" }),
        ...(request.return === "image" ? { image: { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" as const } } : {}),
      };
    },
    async restart() { lifecycle.restarts += 1; },
    async update() { lifecycle.updates += 1; },
    async resetManagedState() { lifecycle.resets += 1; },
    setSnapshot(value) { snapshotValue = value; },
    browserRequests,
    toolRequests,
    cleanupRequests,
    get observations() { return observations; },
    armHighImpactBrowserGate() { highImpactBrowserGate = true; },
    lifecycle,
    ...overrides,
  };
  return adapter;
}

function sequentialIds(): () => string {
  let value = 0;
  return () => `computer-test-${++value}`;
}

afterEach(() => {
  uninstallCapabilityRegistry();
});

describe("Phase 4 Shared Agent Computer", () => {
  it("registers a provider-neutral node, leases an Agent screen, and runs browser automation in the required fallback order", async () => {
    const adapter = fakeAdapter();
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);

    const requested = await service.requestScreen({ ownerId: "job-1", requireBrowser: true });
    expect(requested.state).toBe("acquired");
    if (requested.state !== "acquired") throw new Error("expected Computer screen grant");
    expect(requested.screenLease).toMatchObject({ nodeId: "node-1", screenId: "agent-1", ownerId: "job-1" });
    expect(requested.controlLease).toMatchObject({ holder: "agent", generation: 1 });

    const result = await service.runBrowserAction(
      requested.screenLease.id,
      "job-1",
      requested.controlLease.generation,
      { kind: "navigate", url: "https://example.com/work" },
    );
    expect(result.mode).toBe("playwright-dom");
    expect(adapter.browserRequests).toHaveLength(1);
    expect(adapter.browserRequests[0]?.automationOrder).toEqual(["playwright-dom", "accessibility", "cdp", "visual"]);
    await expect(service.runBrowserAction(
      requested.screenLease.id,
      "job-1",
      requested.controlLease.generation,
      { kind: "type", target: "password", text: "never-log-this", sensitive: true },
    )).rejects.toThrow(/human takeover|protected-credential/);

    await service.close();
  });

  it("presents a shared Agent screen only for the active bound lease and closes only provider-owned views", async () => {
    let opened = 0;
    let closed = 0;
    const adapter = fakeAdapter({
      async sharedScreenSupport() {
        return Object.freeze({
          level: "full" as const,
          backend: "x11-ewmh" as const,
          desktopEnvironment: "KDE",
          sessionType: "x11" as const,
          canCreateWorkspace: true,
          canPlaceViewer: true,
          canSwitchWorkspace: true,
          viewOnly: false as const,
          missing: Object.freeze([]),
          reason: "test native desktop backend",
        });
      },
      async openSharedScreen(request) {
        opened += 1;
        return Object.freeze({
          nodeId: "node-1",
          screenId: request.screenId,
          workspaceName: request.name ?? `FRIDAY ${request.screenId}`,
          backend: "x11-ewmh" as const,
          viewOnly: false as const,
          viewerId: "friday-computer-share-test",
        });
      },
      async closeSharedScreens() { closed += 1; return 1; },
    });
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "shared-owner" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const binding = Object.freeze({
      nodeId: grant.screenLease.nodeId,
      screenId: grant.screenLease.screenId,
      screenLeaseId: grant.screenLease.id,
      ownerId: grant.screenLease.ownerId,
      ownerKind: "main-agent" as const,
      runId: "shared-run",
      generation: grant.controlLease.generation,
    });

    await expect(service.openSharedScreen(binding, { name: "FRIDAY Agent 1" })).resolves.toEqual(expect.objectContaining({
      nodeId: "node-1",
      screenId: "agent-1",
      workspaceName: "FRIDAY Agent 1",
      viewOnly: false,
    }));
    expect(opened).toBe(1);
    await expect(service.closeSharedScreens("node-1")).resolves.toBe(1);
    expect(closed).toBe(1);

    await service.releaseScreen(grant.screenLease.id, grant.screenLease.ownerId);
    await expect(service.openSharedScreen(binding)).rejects.toThrow(/screen lease|active/i);
    expect(opened).toBe(1);
    await service.close();
  });

  it("treats a soft preferred screen as a preference so concurrent Agents receive different free screens", async () => {
    const adapter = fakeAdapter();
    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      screens: Object.freeze([
        ...healthySnapshot().screens,
        { id: "agent-2", label: "Agent 2", kind: "agent" as const, width: 1_920, height: 1_080 },
      ]),
    }));
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);

    const first = await service.requestScreen({ ownerId: "agent-a", preferredScreenId: "agent-1", preferredScreenMode: "soft" });
    const second = await service.requestScreen({ ownerId: "agent-b", preferredScreenId: "agent-1", preferredScreenMode: "soft" });
    expect(first).toMatchObject({ state: "acquired", screenLease: { screenId: "agent-1", ownerId: "agent-a" } });
    expect(second).toMatchObject({ state: "acquired", screenLease: { screenId: "agent-2", ownerId: "agent-b" } });

    await service.close();
  });

  it("rejects unknown preferred screen modes instead of silently hard-pinning them", async () => {
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(fakeAdapter());

    await expect(service.requestScreen({
      ownerId: "agent-invalid-mode",
      preferredScreenId: "agent-1",
      preferredScreenMode: "anything" as never,
    })).rejects.toThrow(/preferredScreenMode must be required or soft/);

    await service.close();
  });

  it("enforces Browser Supervisor persistence, ownership, and profile continuity before browser admission", async () => {
    const wrongOwner = fakeAdapter();
    wrongOwner.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      browser: Object.freeze({
        ...healthySnapshot().browser!,
        windows: Object.freeze([{ id: "window-human", owner: "human" as const, screenId: "agent-1", tabIds: Object.freeze(["tab-1"]) }]),
      }),
    }));
    const invalidService = createComputerService({ idFactory: sequentialIds() });
    await expect(invalidService.registerNode(wrongOwner)).rejects.toThrow(/human browser windows.*human screen/);
    await invalidService.close();

    const adapter = fakeAdapter();
    const service = createComputerService({ idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    expect(service.status().nodeStatus[0]?.browser).toMatchObject({ available: true, ready: true, running: true, persistentProfile: true });

    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      browser: Object.freeze({
        running: false,
        profileId: "shared-profile",
        persistentProfile: true,
        windows: Object.freeze([]),
        tabs: Object.freeze([]),
      }),
    }));
    await service.refreshNode("node-1");
    const waiting = await service.requestScreen({ ownerId: "job-browser", requireBrowser: true });
    expect(waiting).toMatchObject({ state: "waiting", reasons: expect.arrayContaining(["browser-unavailable"]) });

    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      browser: Object.freeze({ ...healthySnapshot().browser!, profileId: "replacement-profile", contextId: "replacement-context" }),
    }));
    const degraded = await service.refreshNode("node-1");
    expect(degraded.availability).toBe("degraded");
    expect(degraded.browser?.profileId).toBe("shared-profile");

    await service.close();
  });

  it("routes existing FRIDAY tool execution through the leased node and rejects stale Computer control", async () => {
    const adapter = fakeAdapter();
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-tools", preferredNodeId: "node-1" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const binding = {
      nodeId: grant.screenLease.nodeId,
      screenId: grant.screenLease.screenId,
      screenLeaseId: grant.screenLease.id,
      ownerId: "job-tools",
      ownerKind: "main-agent" as const,
      runId: "run-tools",
      generation: grant.controlLease.generation,
    };

    const result = await service.runTool(binding, {
      workspace: "/workspace/project",
      tool: "bash",
      input: { command: "pwd" },
    });
    expect(result).toMatchObject({ content: [{ type: "text", text: "remote:bash" }], details: { operation: "shell" } });
    expect(adapter.toolRequests[0]).toMatchObject({
      workspace: "/workspace/project",
      tool: "bash",
      operation: "shell",
      screenId: grant.screenLease.screenId,
      screenLeaseId: grant.screenLease.id,
      ownerId: "job-tools",
      ownerKind: "main-agent",
      runId: "run-tools",
      controlGeneration: grant.controlLease.generation,
    });

    await service.takeOver(grant.screenLease.id, "human:operator", null);
    await expect(service.runTool(binding, { workspace: "/workspace/project", tool: "edit", input: { path: "a.ts", edits: [] } }))
      .rejects.toThrow(/human control|stale/);
    await service.close();
  });

  it("requires run-scoped cleanup support before starting a Computer background process and exposes idempotent cleanup", async () => {
    const withCleanup = fakeAdapter();
    const { cleanupRunProcesses: _cleanupRunProcesses, ...noCleanup } = withCleanup;
    const blocked = createComputerService({ idFactory: sequentialIds() });
    await blocked.registerNode(noCleanup);
    const blockedGrant = await blocked.requestScreen({ ownerId: "job-process-blocked" });
    if (blockedGrant.state !== "acquired") throw new Error("expected Computer screen grant");
    const blockedBinding = {
      nodeId: blockedGrant.screenLease.nodeId, screenId: blockedGrant.screenLease.screenId, screenLeaseId: blockedGrant.screenLease.id,
      ownerId: blockedGrant.screenLease.ownerId, ownerKind: "main-agent" as const, runId: "run-process-blocked", generation: blockedGrant.controlLease.generation,
    };
    await expect(blocked.runTool(blockedBinding, { workspace: "/workspace", tool: "process", input: { action: "start", command: "npm run dev" } }))
      .rejects.toThrow(/run-scoped cleanup support/);
    await blocked.close();

    const adapter = fakeAdapter();
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-process-cleanup" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const binding = {
      nodeId: grant.screenLease.nodeId, screenId: grant.screenLease.screenId, screenLeaseId: grant.screenLease.id,
      ownerId: grant.screenLease.ownerId, ownerKind: "main-agent" as const, runId: "run-process-cleanup", generation: grant.controlLease.generation,
    };
    await service.runTool(binding, { workspace: "/workspace", tool: "process", input: { action: "start", command: "npm run dev" } });
    expect(adapter.toolRequests.at(-1)?.input).toMatchObject({ action: "start", command: "npm run dev", maxLifetimeSeconds: 3_600 });
    expect(adapter.toolRequests.at(-1)?.runId).toBe("run-process-cleanup");
    await expect(service.runTool(binding, { workspace: "/workspace", tool: "process", input: { action: "start", command: "npm run dev", maxLifetimeSeconds: 3_601 } }))
      .rejects.toThrow(/between 1 and 3600/);
    await expect(service.releaseScreen(grant.screenLease.id, grant.screenLease.ownerId)).resolves.toBe(true);
    await expect(service.cleanupRunProcesses(binding)).resolves.toBe(true);
    await expect(service.cleanupRunProcesses(binding)).resolves.toBe(true);
    expect(adapter.cleanupRequests).toHaveLength(2);
    expect(adapter.cleanupRequests[0]).toMatchObject({
      screenId: grant.screenLease.screenId,
      screenLeaseId: grant.screenLease.id,
      ownerId: "job-process-cleanup",
      ownerKind: "main-agent",
      runId: "run-process-cleanup",
    });
    await service.close();
  });

  it("fails closed on missing observation safety attestation and defensively redacts credential-shaped observation text", async () => {
    const unsafe = fakeAdapter({
      async observeScreen(screenId) {
        return { ...observation(screenId), safety: undefined } as unknown as ComputerObservation;
      },
    });
    const unsafeService = createComputerService({ idFactory: sequentialIds() });
    await unsafeService.registerNode(unsafe);
    const unsafeGrant = await unsafeService.requestScreen({ ownerId: "job-unsafe-observation" });
    if (unsafeGrant.state !== "acquired") throw new Error("expected Computer screen grant");
    await expect(unsafeService.observeScreen(unsafeGrant.screenLease.id, unsafeGrant.screenLease.ownerId, unsafeGrant.controlLease.generation))
      .rejects.toThrow(/safety attestation/);
    await unsafeService.close();

    const keystrokeUnsafe = fakeAdapter({
      async observeScreen(screenId) {
        return {
          ...observation(screenId),
          safety: { ...observation(screenId).safety, keystrokesOmitted: false },
        } as unknown as ComputerObservation;
      },
    });
    const keystrokeUnsafeService = createComputerService({ idFactory: sequentialIds() });
    await keystrokeUnsafeService.registerNode(keystrokeUnsafe);
    const keystrokeUnsafeGrant = await keystrokeUnsafeService.requestScreen({ ownerId: "job-unsafe-keystrokes" });
    if (keystrokeUnsafeGrant.state !== "acquired") throw new Error("expected Computer screen grant");
    await expect(keystrokeUnsafeService.observeScreen(
      keystrokeUnsafeGrant.screenLease.id,
      keystrokeUnsafeGrant.screenLease.ownerId,
      keystrokeUnsafeGrant.controlLease.generation,
    )).rejects.toThrow(/keystroke/);
    await keystrokeUnsafeService.close();

    const adapter = fakeAdapter({
      async observeScreen(screenId) {
        return {
          ...observation(screenId),
          url: "https://example.com/account?token=super-secret-token",
          domSummary: 'password value="super-secret-password" otp=123456 captcha=ABCD1234',
          accessibilitySummary: "authorization: Bearer super-secret-bearer; verification code=654321",
          tabs: [{ id: "tab-secret", title: "credential=super-secret-title PIN=9876", url: "https://example.com/?api_key=super-secret-key", active: true }],
        };
      },
    });
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-redacted-observation" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const safe = await service.observeScreen(grant.screenLease.id, grant.screenLease.ownerId, grant.controlLease.generation);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("654321");
    expect(serialized).not.toContain("ABCD1234");
    expect(serialized).not.toContain("9876");
    expect(serialized).toContain("[REDACTED]");
    expect(safe.safety).toEqual({ protectedInputOmitted: true, keystrokesOmitted: true, captchaOmitted: true, sensitiveScreenshotOmitted: true });
    await service.close();
  });

  it("fails closed when a visual probe omits its protected-region safety attestation", async () => {
    const adapter = fakeAdapter({
      async visualProbe(request) {
        return {
          observationId: "obs-1",
          safety: undefined,
          ...(request.ref === undefined ? {} : { ref: request.ref }),
          bbox: request.bbox ?? { left: 10, top: 10, right: 50, bottom: 50 },
          width: 40,
          height: 40,
          targetMatch: true,
          confidence: 0.95,
          visibleText: ["Continue"],
        } as never;
      },
    });
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-unsafe-visual", requireBrowser: true });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    await expect(service.visualProbe(
      grant.screenLease.id,
      grant.screenLease.ownerId,
      grant.controlLease.generation,
      { ref: "obs-1:e1", return: "text" },
    )).rejects.toThrow(/visual probe.*safety attestation/i);
    await service.close();
  });

  it("returns WAITING_FOR_COMPUTER under resource pressure and resumes a waiter when telemetry becomes admissible", async () => {
    const adapter = fakeAdapter();
    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      resources: Object.freeze({ ...healthySnapshot().resources, cpuPercent: 96 }),
    }));
    const service = createComputerService({ idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(adapter);

    const immediate = await service.requestScreen({ ownerId: "job-wait" });
    expect(immediate).toMatchObject({ state: "waiting", code: "WAITING_FOR_COMPUTER" });
    if (immediate.state !== "waiting") throw new Error("expected Computer wait state");
    expect(immediate.reasons).toContain("cpu-pressure");

    let observedWait: { readonly code: "WAITING_FOR_COMPUTER"; readonly reasons: readonly string[] } | undefined;
    let waitingReported!: () => void;
    const reported = new Promise<void>((resolve) => { waitingReported = resolve; });
    const waiting = service.waitForScreen({ ownerId: "job-wait" }, undefined, (state) => {
      observedWait = state;
      waitingReported();
    });
    await reported;
    expect(observedWait).toMatchObject({ code: "WAITING_FOR_COMPUTER", reasons: expect.arrayContaining(["cpu-pressure"]) });
    adapter.setSnapshot(healthySnapshot());
    await service.refreshNode("node-1");
    const grant = await waiting;
    expect(grant.screenLease).toMatchObject({ ownerId: "job-wait", screenId: "agent-1" });

    await service.close();
  });

  it("fails closed when GPU-required admission has no GPU telemetry", async () => {
    const adapter = fakeAdapter();
    const snapshot = healthySnapshot();
    const { gpuPercent: _gpuPercent, ...resourcesWithoutGpu } = snapshot.resources;
    adapter.setSnapshot(Object.freeze({
      ...snapshot,
      resources: Object.freeze(resourcesWithoutGpu),
    }));
    const service = createComputerService({ idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(adapter);

    const result = await service.requestScreen({ ownerId: "job-gpu-required", demand: { gpu: true } });
    expect(result).toMatchObject({
      state: "waiting",
      code: "WAITING_FOR_COMPUTER",
      reasons: expect.arrayContaining(["gpu-pressure"]),
    });

    await service.close();
  });

  it("expires exclusive screen leases and makes the screen available to queued work", async () => {
    let clock = Date.parse("2026-09-11T08:00:00.000Z");
    const adapter = fakeAdapter();
    const service = createComputerService({ now: () => clock, idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const first = await service.requestScreen({ ownerId: "job-first", leaseTtlMs: 5_000 });
    expect(first.state).toBe("acquired");

    const second = service.waitForScreen({ ownerId: "job-second", leaseTtlMs: 5_000 });
    clock += 5_001;
    await expect(service.expireLeases(clock)).resolves.toBe(1);
    const resumed = await second;
    expect(resumed.screenLease.ownerId).toBe("job-second");
    expect(service.screenLeases()).toHaveLength(1);

    await service.close();
  });

  it("renews a screen lease while a manual-only human takeover is active", async () => {
    let clock = Date.parse("2026-09-11T08:00:00.000Z");
    const service = createComputerService({ now: () => clock, idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(fakeAdapter());
    const grant = await service.requestScreen({ ownerId: "job-long-takeover", leaseTtlMs: 5_000 });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    await service.takeOver(grant.screenLease.id, "human:operator", null);
    const originalExpiry = Date.parse(grant.screenLease.expiresAt);
    clock += 4_000;
    const renewed = await service.renewScreenLease(grant.screenLease.id, "job-long-takeover", 5_000);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(originalExpiry);
    clock = originalExpiry + 1;
    await expect(service.expireLeases(clock)).resolves.toBe(0);
    expect(service.controlLease(grant.screenLease.id)?.holder).toBe("human");
    await service.close();
  });

  it("human takeover invalidates pending Agent actions and hand-back requires a fresh safe observation before Agent control resumes", async () => {
    let releaseBrowser: (() => void) | undefined;
    const adapter = fakeAdapter({
      async runBrowserAction(request) {
        await new Promise<void>((resolve, reject) => {
          releaseBrowser = resolve;
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new Error("aborted")), { once: true });
        });
        return { mode: "playwright-dom", observation: observation(request.screenId) };
      },
    });
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-takeover" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");

    const pendingAction = service.runBrowserAction(
      grant.screenLease.id,
      "job-takeover",
      grant.controlLease.generation,
      { kind: "click", target: "Sign in" },
    );
    for (let attempt = 0; releaseBrowser === undefined && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(releaseBrowser).toBeDefined();
    const takeover = await service.takeOver(grant.screenLease.id, "human:operator", 5_000);
    expect(takeover.holder).toBe("human");
    expect(takeover.generation).toBeGreaterThan(grant.controlLease.generation);
    expect(takeover.transcriptPolicy).toEqual({ captureKeystrokes: false, captureSecrets: false, captureSensitiveScreenshots: false });
    await expect(pendingAction).rejects.toThrow();
    expect(() => service.assertAgentControl(grant.screenLease.id, "job-takeover", grant.controlLease.generation)).toThrow(/human control|stale/);

    let resumeSettled = false;
    const resume = service.waitForAgentControl(grant.screenLease.id, "job-takeover", grant.controlLease.generation);
    void resume.finally(() => { resumeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resumeSettled).toBe(false);
    expect(service.status().waitingForControl).toBe(1);

    const handedBack = await service.handBack(grant.screenLease.id, "human:operator");
    const resumed = await resume;
    expect(resumed).toMatchObject({
      resumedAfterTakeover: true,
      controlLease: { holder: "agent", holderId: "job-takeover", generation: handedBack.controlLease.generation },
      observation: { screenId: "agent-1", screenshotArtifactRef: "artifact:screen-safe" },
    });
    expect(service.status().waitingForControl).toBe(0);
    expect(handedBack.controlLease).toMatchObject({ holder: "agent", holderId: "job-takeover" });
    expect(handedBack.observation).toMatchObject({ screenId: "agent-1", screenshotArtifactRef: "artifact:screen-safe" });
    expect(adapter.observations).toBe(1);
    expect(() => service.assertAgentControl(
      grant.screenLease.id,
      "job-takeover",
      handedBack.controlLease.generation,
    )).not.toThrow();
    releaseBrowser?.();

    await service.close();
  });

  it("keeps human control when hand-back re-observation fails", async () => {
    const adapter = fakeAdapter({
      async observeScreen() {
        throw new Error("screen capture unavailable");
      },
    });
    const service = createComputerService({ idFactory: sequentialIds() });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-reobserve" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const takeover = await service.takeOver(grant.screenLease.id, "human:operator", null);

    await expect(service.handBack(grant.screenLease.id, "human:operator")).rejects.toThrow(/screen capture unavailable/);
    expect(service.controlLease(grant.screenLease.id)).toMatchObject({
      holder: "human",
      holderId: "human:operator",
      generation: takeover.generation + 1,
    });

    await service.close();
  });

  it("automatically hands control back after the configured idle grace and keeps managed lifecycle operations separate from active work", async () => {
    let clock = Date.parse("2026-09-11T08:00:00.000Z");
    const adapter = fakeAdapter();
    const service = createComputerService({ now: () => clock, idFactory: sequentialIds(), pollIntervalMs: 60_000 });
    await service.registerNode(adapter);
    const grant = await service.requestScreen({ ownerId: "job-idle", leaseTtlMs: 60_000 });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    await service.takeOver(grant.screenLease.id, "human:operator", 5_000);

    clock += 4_999;
    await expect(service.sweepIdleTakeovers(clock)).resolves.toBe(0);
    clock += 1;
    await expect(service.sweepIdleTakeovers(clock)).resolves.toBe(1);
    expect(service.controlLease(grant.screenLease.id)?.holder).toBe("agent");
    expect(adapter.observations).toBe(1);

    await expect(service.restartNode("node-1")).rejects.toThrow(/active screen lease/);
    await service.releaseScreen(grant.screenLease.id, "job-idle");
    await service.restartNode("node-1");
    await service.updateNode("node-1");
    await service.resetManagedState("node-1");
    expect(adapter.lifecycle).toEqual({ restarts: 1, updates: 1, resets: 1 });

    await service.close();
  });

  it("registers Computer as a capability with status/doctor/takeover/lifecycle System surfaces", async () => {
    const adapter = fakeAdapter();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await friday.activatePlugin(createComputerPlugin({ adapters: [adapter], service: { idFactory: sequentialIds(), pollIntervalMs: 60_000 } }));

    const computer = requireCapability(COMPUTER_CAPABILITY);
    expect(computer.nodes()).toHaveLength(1);
    const actions = collectContributions(SYSTEM_ACTION_CONTRIBUTION).map((entry) => entry.id);
    expect(actions).toEqual(expect.arrayContaining([
      "computer.status",
      "computer.doctor",
      "computer.takeover",
      "computer.hand-back",
      "computer.node.restart",
      "computer.node.update",
      "computer.node.reset-managed",
    ]));
    const status = collectContributions(SYSTEM_STATUS_CONTRIBUTION).find((entry) => entry.id === "computer");
    expect(status).toBeDefined();
    await expect(status!.snapshot()).resolves.toMatchObject({ nodes: 1, online: 1 });

    await friday.dispose();
  });
  it("exposes permission-gated Agent observe/browser tools only against the active leased Computer generation", async () => {
    const order: string[] = [];
    let sharedOpened = 0;
    const adapter = fakeAdapter({
      async openSharedScreen(request) {
        order.push("present");
        sharedOpened += 1;
        return {
          nodeId: "node-1",
          screenId: request.screenId,
          workspaceName: request.name ?? `FRIDAY ${request.screenId}`,
          backend: "x11-ewmh" as const,
          viewOnly: false as const,
          viewerId: `viewer-${request.screenId}`,
        };
      },
    });
    const authorization: PermissionRequest[] = [];
    const progressUpdates: TurnProgressUpdate[] = [];
    const permissions: PermissionsService = {
      normalizeMode: () => "auto",
      async authorize(request) { order.push("authorize"); authorization.push(request); return { allowed: true, approvedBy: "policy" }; },
      assertWorkspacePath: (_workspace, path) => path,
    };
    const permissionProvider = definePlugin(
      { id: "test-computer-permissions", provides: [PERMISSIONS_CAPABILITY] },
      (ctx) => { ctx.services.provide(PERMISSIONS_CAPABILITY, permissions); },
    );
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
    await friday.activatePlugin(permissionProvider);
    await friday.activatePlugin(createComputerPlugin({ adapters: [adapter], service: { idFactory: sequentialIds(), pollIntervalMs: 60_000 } }));

    const service = requireCapability(COMPUTER_CAPABILITY);
    const grant = await service.requestScreen({ ownerId: "job-agent-tools", preferredNodeId: "node-1" });
    if (grant.state !== "acquired") throw new Error("expected Computer screen grant");
    const binding = {
      nodeId: grant.screenLease.nodeId,
      screenId: grant.screenLease.screenId,
      screenLeaseId: grant.screenLease.id,
      ownerId: grant.screenLease.ownerId,
      ownerKind: "main-agent" as const,
      runId: "run-agent-tools",
      admission: { requireBrowser: true, demand: { browserRenderers: 1, gpu: true } },
      presentation: "shared" as const,
      generation: grant.controlLease.generation,
    };
    const executionContext: AgentToolExecutionContext = {
      cwd: "/workspace/project",
      sessionId: "session-computer-tools",
      jobId: "job-agent-tools",
      permissionMode: "auto",
      modelCapabilities: { imageInput: true },
      computerExecution: binding,
      async reportProgress(update) { progressUpdates.push(update); },
      deferAfterReply() {},
      deferOnFailure() {},
    };
    const tools = collectContributions(AGENT_TOOL_CONTRIBUTION);
    expect(tools.map((tool) => tool.id).sort()).toEqual(["computer-browser", "computer-observe", "computer-visual-probe"]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["computer_browser", "computer_observe", "computer_visual_probe"]);

    const observe = tools.find((tool) => tool.name === "computer_observe")!;
    await expect(observe.execute({}, undefined, executionContext)).resolves.toMatchObject({
      output: { screenId: "agent-1", observationId: "obs-1", elements: [{ ref: "obs-1:e1" }] },
    });
    expect(order).toEqual(["authorize", "present"]);
    expect(sharedOpened).toBe(1);
    const browser = tools.find((tool) => tool.name === "computer_browser")!;
    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      resources: Object.freeze({ ...healthySnapshot().resources, browserRendererCount: 12, gpuPercent: 95 }),
      browser: Object.freeze({ running: false, profileId: "shared-profile", persistentProfile: true, windows: Object.freeze([]), tabs: Object.freeze([]) }),
    }));
    await service.refreshNode("node-1");
    const waitingBrowser = browser.execute({ action: "click", target: "obs-1:e1" }, undefined, executionContext);
    for (let attempt = 0; service.status().waitingRequests === 0 && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(service.status().waitingRequests).toBe(1);
    expect(progressUpdates).toContainEqual(expect.objectContaining({
      jobStatus: "waiting-for-computer",
      computerWait: expect.objectContaining({
        reasons: expect.arrayContaining(["browser-unavailable", "browser-renderer-pressure", "gpu-pressure"]),
      }),
    }));
    adapter.setSnapshot(healthySnapshot());
    await service.refreshNode("node-1");
    await expect(waitingBrowser).resolves.toMatchObject({
      output: { mode: "playwright-dom", observation: { screenId: "agent-1" } },
    });
    expect(progressUpdates).toContainEqual(expect.objectContaining({ jobStatus: "running" }));
    const visual = tools.find((tool) => tool.name === "computer_visual_probe")!;
    await expect(visual.execute({ ref: "obs-1:e1", size: "tiny", return: "image" }, undefined, executionContext)).resolves.toMatchObject({
      content: [
        { type: "text" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
      ],
    });
    await expect(visual.execute(
      { ref: "obs-1:e1", size: "tiny", return: "image" },
      undefined,
      { ...executionContext, modelCapabilities: { imageInput: false } },
    )).rejects.toThrow(/requires an active model with image input/i);
    await expect(browser.execute({ action: "click", target: "#legacy-selector" }, undefined, executionContext))
      .rejects.toThrow(/current semantic ref/);
    await expect(visual.execute({ ref: "#legacy-selector", size: "tiny", return: "text" }, undefined, executionContext))
      .rejects.toThrow(/current semantic ref/);
    await expect(browser.execute({ action: "type", target: "password", text: "do-not-capture", sensitive: true }, undefined, executionContext))
      .rejects.toThrow(/human takeover|protected-credential/);
    expect(authorization.map((request) => request.action)).toEqual([
      { id: "computer.task.control", effect: "external-write", resource: "computer:node-1:screen:agent-1", network: true },
    ]);
    expect(authorization[0]?.reason).toMatch(/covers ordinary browser navigation\/click\/type\/scroll plus observation and bounded visual probes/i);
    expect(sharedOpened).toBe(1);

    await service.takeOver(grant.screenLease.id, "human:operator", null);
    const pausedObserve = observe.execute({}, undefined, executionContext);
    for (let attempt = 0; service.status().waitingForControl === 0 && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(service.status().waitingForControl).toBe(1);
    const handBack = await service.handBack(grant.screenLease.id, "human:operator");
    await expect(pausedObserve).resolves.toMatchObject({
      output: {
        resumedAfterHumanTakeover: true,
        staleActionReplayed: false,
        controlGeneration: handBack.controlLease.generation,
        observation: { screenId: "agent-1", observationId: "obs-1", elements: [{ ref: "obs-1:e1" }] },
      },
    });
    await expect(browser.execute({ action: "click", target: "obs-1:e1" }, undefined, executionContext)).resolves.toMatchObject({
      output: { mode: "playwright-dom", observation: { screenId: "agent-1" } },
    });
    expect(authorization).toHaveLength(1);
    // A durable retry can recreate the Agent run/owner/lease for the same admitted
    // request. It must reuse the request-scoped Computer approval/presentation.
    await expect(observe.execute({}, undefined, { ...executionContext, computerExecution: { ...binding, runId: "run-agent-tools-2" } })).resolves.toMatchObject({
      output: { screenId: "agent-1" },
    });
    expect(authorization.map((request) => request.action.id)).toEqual(["computer.task.control"]);
    expect(sharedOpened).toBe(1);
    expect(order.slice(0, 2)).toEqual(["authorize", "present"]);

    const secondRunContext: AgentToolExecutionContext = {
      ...executionContext,
      jobId: "job-agent-tools-2",
      computerExecution: { ...binding, runId: "run-agent-tools-2" },
    };
    adapter.armHighImpactBrowserGate();
    await expect(browser.execute({ action: "click", target: "obs-1:e1" }, undefined, secondRunContext)).resolves.toMatchObject({
      output: { performed: false, visualProbeRequired: { reason: "high-impact-action", ref: "obs-1:e1" } },
    });
    expect(authorization).toHaveLength(2);
    await expect(visual.execute({ ref: "obs-1:e1", size: "small", return: "text" }, undefined, secondRunContext)).resolves.toMatchObject({
      output: { probeToken: "probe-test" },
    });
    expect(authorization).toHaveLength(2);
    await expect(browser.execute({ action: "click", target: "obs-1:e1", probeToken: "probe-test" }, undefined, secondRunContext)).resolves.toMatchObject({
      output: { observation: { screenId: "agent-1" } },
    });
    expect(authorization.map((request) => request.action.id)).toEqual([
      "computer.task.control",
      "computer.task.control",
      "computer.browser.high-impact",
    ]);
    expect(adapter.browserRequests.at(-1)?.controlGeneration).toBe(handBack.controlLease.generation);

    const browserRequestsBeforeSecondTakeover = adapter.browserRequests.length;
    await service.takeOver(grant.screenLease.id, "human:operator", null);
    const pausedBrowser = browser.execute({ action: "click", target: "obs-1:e1" }, undefined, executionContext);
    for (let attempt = 0; service.status().waitingForControl === 0 && attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(service.status().waitingForControl).toBe(1);
    expect(adapter.browserRequests).toHaveLength(browserRequestsBeforeSecondTakeover);
    const secondHandBack = await service.handBack(grant.screenLease.id, "human:operator");
    await expect(pausedBrowser).resolves.toMatchObject({
      output: {
        resumedAfterHumanTakeover: true,
        staleActionReplayed: false,
        controlGeneration: secondHandBack.controlLease.generation,
        observation: { screenId: "agent-1", observationId: "obs-1", elements: [{ ref: "obs-1:e1" }] },
      },
    });
    expect(adapter.browserRequests).toHaveLength(browserRequestsBeforeSecondTakeover);
    await friday.dispose();
  });

});
