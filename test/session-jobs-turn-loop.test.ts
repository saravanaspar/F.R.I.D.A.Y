import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventInput, EventRecord, EventsService } from "../plugins/events/contract.js";
import { createComputerService } from "../plugins/computer/service.js";
import type { ComputerNodeAdapter, ComputerObservation } from "../plugins/computer/contract.js";
import type { PermissionsTrustedService } from "../plugins/permissions/trusted-contract.js";
import type { RoutingService } from "../plugins/routing/contract.js";
import { SessionJobManager } from "../plugins/session-jobs/manager.js";
import type { InboundTurn, TurnExecutor } from "../plugins/turn-loop/contract.js";
import { createTurnRuntime } from "../plugins/turn-loop/turn-loop.js";

function events(): EventsService {
  const records = new Map<string, EventRecord>();
  let sequence = 0;
  return {
    publish(input: EventInput) {
      const now = new Date().toISOString();
      const id = input.id ?? `event-${++sequence}`;
      const existing = records.get(id);
      if (existing) return existing;
      const record: EventRecord = {
        sequence: ++sequence,
        id,
        type: input.type,
        source: input.source,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        occurredAt: input.occurredAt ?? now,
        publishedAt: now,
        data: input.data ?? null,
        metadata: input.metadata ?? {},
      };
      records.set(id, record);
      return record;
    },
    get: (id: string) => records.get(id),
  } as EventsService;
}

function permissions(): PermissionsTrustedService {
  return {
    identities: () => [],
    trustChannelIdentity: () => { throw new Error("unused"); },
    revokeChannelIdentity: () => false,
    runAsLocal: <T>(operation: () => T) => operation(),
    runAsSystem: <T>(_service: string, operation: () => T) => operation(),
    runAsChannel: <T>(_selector: unknown, operation: () => T) => operation(),
  } as PermissionsTrustedService;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Turn Loop detached session jobs", () => {
  it("acknowledges persistent work immediately and reports completion later", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-turn-jobs-"));
    const eventService = events();
    const jobs = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      events: eventService,
      idFactory: () => "job-1234",
      resolveLabel: () => "PSCLS — brain",
      progressNotifyIntervalMs: 0,
      finalizeNotification: async (_job, descriptors, context) => {
        expect(descriptors).toEqual([{ type: "test.finalize", payload: { request: "m1" } }]);
        expect(context).toEqual({ turnId: "m1", text: "work on PSCLS brain" });
        finalized = true;
      },
    });
    let releaseComputer!: () => void;
    const computerReady = new Promise<void>((resolve) => { releaseComputer = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    let finalized = false;
    const executor: TurnExecutor = {
      id: "agent-session",
      canHandle: () => true,
      async execute(context) {
        executions += 1;
        await context.progress?.({
          kind: "status",
          message: "Waiting for Computer desk-1: cpu-pressure",
          jobStatus: "waiting-for-computer",
          computerWait: { code: "WAITING_FOR_COMPUTER", nodeId: "desk-1", reasons: ["cpu-pressure"] },
        });
        await computerReady;
        await context.progress?.({ kind: "status", message: "Computer acquired; resuming", jobStatus: "running", notify: false });
        await context.progress?.({ kind: "tool", message: "Running persistence tests" });
        await gate;
        return {
          text: "PSCLS report complete", sessionId: "pscls-brain",
          afterReplyFinalizers: [{ type: "test.finalize", payload: { request: "m1" } }],
        };
      },
    };
    const routing: RoutingService = {
      async route(message) {
        return {
          messageId: message.id,
          destination: { kind: "session", id: "session:pscls-brain" },
          execution: { profile: "agent" },
          confidence: 1,
        };
      },
      subscribe: () => () => {},
      recentContext: () => [],
    };
    const replies: string[] = [];
    const turn: InboundTurn = {
      id: "m1",
      principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      text: "work on PSCLS brain",
      projectId: "atlas",
      projectTargetId: "computer:desk-1",
      timestamp: Date.now(),
      reply: async (text) => { replies.push(text); },
    };
    const runtime = createTurnRuntime({
      routing,
      permissions: permissions(),
      events: eventService,
      executors: () => [executor],
      sessionJobs: () => jobs,
    });

    const result = await runtime.submit(turn);
    expect(result.status).toBe("completed");
    expect(replies[0]).toContain("Started background work: PSCLS — brain (job-1234)");
    await waitUntil(() => executions === 1 && jobs.get("job-1234")?.status === "waiting-for-computer", "Computer admission wait");
    expect(jobs.get("job-1234")?.origin).toMatchObject({ projectId: "atlas", projectTargetId: "computer:desk-1" });
    expect(jobs.get("job-1234")?.computerWait).toMatchObject({
      code: "WAITING_FOR_COMPUTER",
      nodeId: "desk-1",
      reasons: ["cpu-pressure"],
    });
    releaseComputer();
    await waitUntil(() => jobs.get("job-1234")?.status === "running", "Computer admission resume");
    await waitUntil(() => replies.some((text) => text.includes("Running persistence tests")), "progress notification");

    release();
    await waitUntil(() => jobs.get("job-1234")?.status === "completed", "job completion");
    await waitUntil(() => replies.at(-1)?.includes("PSCLS report complete") === true, "completion notification");
    expect(replies.at(-1)).toContain("PSCLS report complete");
    await waitUntil(() => finalized && jobs.get("job-1234")?.deliveryStatus === undefined, "durable finalizer forwarding");
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  });
  it("keeps the same Session Job alive across a login-wall human takeover and resumes from the fresh hand-back observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-turn-computer-takeover-"));
    const eventService = events();
    let signedIn = false;
    let browserActionCount = 0;
    let observationCount = 0;
    let browserStarted!: () => void;
    const browserStartedPromise = new Promise<void>((resolve) => { browserStarted = resolve; });
    const observation = (screenId: string): ComputerObservation => ({
      observedAt: new Date().toISOString(),
      screenId,
      url: signedIn ? "https://example.com/account" : "https://example.com/login",
      domSummary: signedIn ? "signed-in account page; protected values omitted" : "login wall; password and OTP fields omitted",
      accessibilitySummary: signedIn ? "account main document" : "sign-in form with protected fields",
      tabs: [{ id: "tab-1", title: signedIn ? "Account" : "Sign in", url: signedIn ? "https://example.com/account" : "https://example.com/login", active: true }],
      screenshotArtifactRef: signedIn ? "artifact:after-login-safe" : "artifact:login-wall-safe",
      processes: [{ pid: 123, name: "chromium" }],
    });
    const adapter: ComputerNodeAdapter = {
      descriptor: {
        id: "desk-login",
        label: "Login test Computer",
        platform: "test",
        capabilities: {
          executionOperations: ["shell", "edit", "process", "git"],
          browser: true, playwright: true, accessibility: true, cdp: true, visualControl: true,
          screenCapture: true, rawInput: true, virtualDisplays: true, managedLifecycle: false,
        },
      },
      async snapshot() {
        return {
          availability: "online",
          resources: { totalMemoryMb: 8_192, availableMemoryMb: 6_144, cpuPercent: 10, browserRendererCount: 2, screenWorkloadPercent: 10 },
          screens: [{ id: "human-1", label: "Human", kind: "human" }, { id: "agent-1", label: "Agent", kind: "agent" }],
          browser: {
            running: true, profileId: "shared-profile", contextId: "shared-context", persistentProfile: true,
            windows: [
              { id: "window-human", owner: "human", screenId: "human-1", tabIds: [] },
              { id: "window-friday", owner: "friday", screenId: "agent-1", tabIds: ["tab-1"] },
            ],
            tabs: [{ id: "tab-1", title: signedIn ? "Account" : "Sign in", url: signedIn ? "https://example.com/account" : "https://example.com/login", active: true }],
          },
        };
      },
      async observeScreen(screenId) { observationCount += 1; return observation(screenId); },
      async runBrowserAction(request) {
        browserActionCount += 1;
        browserStarted();
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new Error("aborted")), { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const computer = createComputerService({ idFactory: (() => { let value = 0; return () => `takeover-${++value}`; })(), pollIntervalMs: 60_000 });
    await computer.registerNode(adapter);
    const jobs = await SessionJobManager.open({
      stateDir: join(root, "jobs"),
      events: eventService,
      idFactory: () => "job-login-takeover",
      resolveLabel: () => "Login takeover",
      progressNotifyIntervalMs: 0,
    });
    const executor: TurnExecutor = {
      id: "agent-session",
      canHandle: () => true,
      async execute(context) {
        const jobId = context.jobId;
        if (!jobId) throw new Error("expected durable Session Job id");
        const grant = await computer.waitForScreen({ ownerId: jobId, preferredNodeId: "desk-login", requireBrowser: true }, context.signal);
        const initial = await computer.observeScreen(grant.screenLease.id, jobId, grant.controlLease.generation, context.signal);
        expect(initial.url).toContain("/login");
        try {
          await computer.runBrowserAction(
            grant.screenLease.id, jobId, grant.controlLease.generation,
            { kind: "click", target: "Sign in" }, context.signal,
          );
          throw new Error("expected human takeover to interrupt the stale browser action");
        } catch (error) {
          const control = computer.controlLease(grant.screenLease.id);
          if (!control || control.generation <= grant.controlLease.generation) throw error;
          const resumed = await computer.waitForAgentControl(grant.screenLease.id, jobId, grant.controlLease.generation, context.signal);
          if (!resumed.resumedAfterTakeover) throw new Error("expected takeover resume");
          expect(resumed.observation).toMatchObject({
            url: "https://example.com/account",
            domSummary: "signed-in account page; protected values omitted",
            screenshotArtifactRef: "artifact:after-login-safe",
          });
          await computer.releaseScreen(grant.screenLease.id, jobId);
          return { text: "Login complete; resumed from fresh observation", sessionId: "computer-login" };
        }
      },
    };
    const routing: RoutingService = {
      async route(message) {
        return { messageId: message.id, destination: { kind: "session", id: "session:computer-login" }, execution: { profile: "agent" }, confidence: 1 };
      },
      subscribe: () => () => {},
      recentContext: () => [],
    };
    const replies: string[] = [];
    const turn: InboundTurn = {
      id: "login-turn",
      principal: { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice" },
      text: "finish the account setup",
      projectId: "atlas",
      projectTargetId: "computer:desk-login",
      timestamp: Date.now(),
      reply: async (text) => { replies.push(text); },
    };
    const runtime = createTurnRuntime({ routing, permissions: permissions(), events: eventService, executors: () => [executor], sessionJobs: () => jobs });

    const submitted = await runtime.submit(turn);
    expect(submitted.status).toBe("completed");
    await browserStartedPromise;
    const lease = computer.screenLeases()[0];
    expect(lease).toBeDefined();
    const jobBeforeTakeover = jobs.get("job-login-takeover");
    expect(jobBeforeTakeover?.status).toBe("running");
    const secretEnteredByHuman = "never-model-visible-password-otp";
    await computer.takeOver(lease!.id, "client:desktop-login", null);
    await waitUntil(() => computer.status().waitingForControl === 1, "Agent control pause");
    expect(jobs.get("job-login-takeover")?.status).toBe("running");

    signedIn = true;
    await computer.recordHumanActivity(lease!.id, "client:desktop-login");
    const handBack = await computer.handBack(lease!.id, "client:desktop-login");
    expect(handBack.observation.url).toBe("https://example.com/account");
    await waitUntil(() => jobs.get("job-login-takeover")?.status === "completed", "same Session Job completion after hand-back");
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.get("job-login-takeover")).toMatchObject({ status: "completed", sessionId: "computer-login" });
    expect(browserActionCount).toBe(1);
    expect(observationCount).toBe(2);
    expect(JSON.stringify(jobs.get("job-login-takeover"))).not.toContain(secretEnteredByHuman);
    expect(replies.join("\n")).not.toContain(secretEnteredByHuman);
    expect(replies.at(-1)).toContain("Login complete; resumed from fresh observation");

    await jobs.close();
    await computer.close();
    await rm(root, { recursive: true, force: true });
  });

});
