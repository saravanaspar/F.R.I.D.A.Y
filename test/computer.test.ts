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
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../plugins/system/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

function observation(screenId = "agent-1"): ComputerObservation {
  return Object.freeze({
    observedAt: new Date().toISOString(),
    screenId,
    safety: { protectedInputOmitted: true as const, keystrokesOmitted: true as const, captchaOmitted: true as const, sensitiveScreenshotOmitted: true as const },
    url: "https://example.com/after-takeover",
    domSummary: "signed-in page; secret fields omitted",
    accessibilitySummary: "main document",
    tabs: Object.freeze([{ id: "tab-1", title: "Example", url: "https://example.com/after-takeover", active: true }]),
    screenshotArtifactRef: "artifact:screen-safe",
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
  lifecycle: { restarts: number; updates: number; resets: number };
} {
  let snapshotValue = healthySnapshot();
  const browserRequests: ComputerBrowserActionRequest[] = [];
  const toolRequests: ComputerNodeToolExecutionRequest[] = [];
  const cleanupRequests: ComputerRunProcessCleanupRequest[] = [];
  let observations = 0;
  const lifecycle = { restarts: 0, updates: 0, resets: 0 };
  const adapter: ComputerNodeAdapter & {
    setSnapshot(value: ComputerNodeRuntimeSnapshot): void;
    browserRequests: ComputerBrowserActionRequest[];
    toolRequests: ComputerNodeToolExecutionRequest[];
    cleanupRequests: ComputerRunProcessCleanupRequest[];
    observations: number;
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
      return { mode: request.automationOrder[0]!, observation: observation(request.screenId) };
    },
    async restart() { lifecycle.restarts += 1; },
    async update() { lifecycle.updates += 1; },
    async resetManagedState() { lifecycle.resets += 1; },
    setSnapshot(value) { snapshotValue = value; },
    browserRequests,
    toolRequests,
    cleanupRequests,
    get observations() { return observations; },
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
    const adapter = fakeAdapter();
    const authorization: PermissionRequest[] = [];
    const progressUpdates: Array<{ jobStatus?: string; computerWait?: { reasons: readonly string[] } }> = [];
    const permissions: PermissionsService = {
      normalizeMode: () => "auto",
      async authorize(request) { authorization.push(request); return { allowed: true, approvedBy: "policy" }; },
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
      generation: grant.controlLease.generation,
    };
    const executionContext = {
      cwd: "/workspace/project",
      sessionId: "session-computer-tools",
      jobId: "job-agent-tools",
      permissionMode: "auto" as const,
      computerExecution: binding,
      async reportProgress(update: { jobStatus?: string; computerWait?: { reasons: readonly string[] } }) { progressUpdates.push(update); },
      deferAfterReply() {},
      deferOnFailure() {},
    } as never;
    const tools = collectContributions(AGENT_TOOL_CONTRIBUTION);
    expect(tools.map((tool) => tool.id).sort()).toEqual(["computer-browser", "computer-observe"]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["computer_browser", "computer_observe"]);

    const observe = tools.find((tool) => tool.name === "computer_observe")!;
    await expect(observe.execute({}, undefined, executionContext)).resolves.toMatchObject({
      output: { screenId: "agent-1", screenshotArtifactRef: "artifact:screen-safe" },
    });
    const browser = tools.find((tool) => tool.name === "computer_browser")!;
    adapter.setSnapshot(Object.freeze({
      ...healthySnapshot(),
      resources: Object.freeze({ ...healthySnapshot().resources, browserRendererCount: 12, gpuPercent: 95 }),
      browser: Object.freeze({ running: false, profileId: "shared-profile", persistentProfile: true, windows: Object.freeze([]), tabs: Object.freeze([]) }),
    }));
    await service.refreshNode("node-1");
    const waitingBrowser = browser.execute({ action: "click", target: "Continue" }, undefined, executionContext);
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
    await expect(browser.execute({ action: "type", target: "password", text: "do-not-capture", sensitive: true }, undefined, executionContext))
      .rejects.toThrow(/human takeover|protected-credential/);
    expect(authorization.map((request) => request.action)).toEqual([
      { id: "computer.observe", effect: "private-read", resource: "computer:node-1:screen:agent-1", network: true },
      { id: "computer.browser.action", effect: "external-write", resource: "computer:node-1:screen:agent-1", network: true },
    ]);

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
        observation: { screenId: "agent-1", screenshotArtifactRef: "artifact:screen-safe" },
      },
    });
    await expect(browser.execute({ action: "click", target: "Continue after login" }, undefined, executionContext)).resolves.toMatchObject({
      output: { mode: "playwright-dom", observation: { screenId: "agent-1" } },
    });
    expect(adapter.browserRequests.at(-1)?.controlGeneration).toBe(handBack.controlLease.generation);

    const browserRequestsBeforeSecondTakeover = adapter.browserRequests.length;
    await service.takeOver(grant.screenLease.id, "human:operator", null);
    const pausedBrowser = browser.execute({ action: "click", target: "Do not replay during takeover" }, undefined, executionContext);
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
        observation: { screenId: "agent-1", screenshotArtifactRef: "artifact:screen-safe" },
      },
    });
    expect(adapter.browserRequests).toHaveLength(browserRequestsBeforeSecondTakeover);
    await friday.dispose();
  });

});
