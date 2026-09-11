import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability } from "../plugins/capabilities/protocol.js";
import agentPlugin from "../plugins/agent/index.js";
import { AGENT_CAPABILITY } from "../plugins/agent/contract.js";
import { createComputerPlugin } from "../plugins/computer/index.js";
import { COMPUTER_CAPABILITY, type ComputerNodeAdapter, type ComputerObservation } from "../plugins/computer/contract.js";
import { createEventsService } from "../plugins/events/index.js";
import { EVENTS_CAPABILITY, type EventInput, type EventRecord, type EventsService } from "../plugins/events/contract.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import * as modelRuntime from "@friday/model";
import promptsPlugin from "../plugins/prompts/index.js";
import { PROMPTS_CAPABILITY } from "../plugins/prompts/contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { SESSION_RESOURCES_CAPABILITY } from "../plugins/session-resources/contract.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import type { ProjectsService } from "../plugins/projects/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionRequest, type PermissionsService } from "../plugins/permissions/contract.js";
import { computerNodeExecutionTarget } from "@friday/execution-targets";
import type { ToolsService } from "../plugins/tools/contract.js";
import type { PermissionsTrustedService } from "../plugins/permissions/trusted-contract.js";
import type { RoutingService } from "../plugins/routing/contract.js";
import { SessionJobManager } from "../plugins/session-jobs/manager.js";
import { createAgentTurnExecutor } from "../plugins/turn-loop/agent-executor.js";
import { AGENT_PROMPT_SECTION_CONTRIBUTION, AGENT_TOOL_CONTRIBUTION, type InboundTurn, type TurnExecutor } from "../plugins/turn-loop/contract.js";
import { createTurnRuntime } from "../plugins/turn-loop/turn-loop.js";
import { withTestModel } from "./helpers/faux-model.js";

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

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
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
  it("keeps the same Session Job alive through the real Agent/Computer tool path across a login-wall human takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-turn-computer-takeover-"));
    const previousProvider = process.env.FRIDAY_MODEL_PROVIDER;
    const previousModelId = process.env.FRIDAY_MODEL_ID;
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";

    let faux: ReturnType<typeof modelRuntime.registerFauxProvider> | undefined;
    let executor: ReturnType<typeof createAgentTurnExecutor> | undefined;
    let jobs: Awaited<ReturnType<typeof SessionJobManager.open>> | undefined;
    let host: PluginTestHost | undefined;
    try {
      host = new PluginTestHost();
      await host.activatePlugin(capabilitiesPlugin);
      const eventService = createEventsService({ stateDir: join(root, "events") });
      await host.activatePlugin(definePlugin(
        { id: "test-login-computer-events", provides: [EVENTS_CAPABILITY] },
        (ctx) => {
          ctx.services.provide(EVENTS_CAPABILITY, eventService);
          ctx.effect(() => eventService.close());
        },
      ));
      await host.activatePlugin(sessionResourcesPlugin);
      await host.activatePlugin(sessionsPlugin);
      await host.activatePlugin(promptsPlugin);
      await host.activatePlugin(modelPlugin);
      await host.activatePlugin(agentPlugin);

      const authorization: PermissionRequest[] = [];
      const agentPermissions: PermissionsService = {
        normalizeMode: () => "auto",
        async authorize(request) {
          authorization.push(request);
          return { allowed: true, approvedBy: "policy" };
        },
        assertWorkspacePath: (_workspace, path) => path,
      };
      await host.activatePlugin(definePlugin(
        { id: "test-login-computer-permissions", provides: [PERMISSIONS_CAPABILITY] },
        (ctx) => { ctx.services.provide(PERMISSIONS_CAPABILITY, agentPermissions); },
      ));

      let signedIn = false;
      let browserActionCount = 0;
      let observationCount = 0;
      const observation = (screenId: string): ComputerObservation => ({
        observedAt: new Date().toISOString(),
        screenId,
        safety: { protectedInputOmitted: true, keystrokesOmitted: true, captchaOmitted: true, sensitiveScreenshotOmitted: true },
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
        async cleanupRunProcesses() {},
        async runBrowserAction(request) {
          browserActionCount += 1;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(request.signal?.reason ?? new Error("aborted"));
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener("abort", abort, { once: true });
          });
          throw new Error("unreachable");
        },
      };
      let computerId = 0;
      await host.activatePlugin(createComputerPlugin({
        adapters: [adapter],
        service: { idFactory: () => `takeover-${++computerId}`, pollIntervalMs: 60_000 },
      }));
      await host.completePluginBootstrap();

      const computer = requireCapability(COMPUTER_CAPABILITY);
      const target = computerNodeExecutionTarget("desk-login");
      const acquireCalls: Array<{ projectId: string; ownerId: string; targetId?: string; signal?: AbortSignal }> = [];
      const projects = {
        get(projectId: string) {
          if (projectId !== "atlas") return undefined;
          return { id: "atlas", policy: { computerAdmission: { requireBrowser: true } } } as never;
        },
        async acquireAgentWorkspace(input: { projectId: string; ownerId: string; targetId?: string; signal?: AbortSignal }) {
          acquireCalls.push(input);
          return { projectId: "atlas", projectRoot: root, workspacePath: root, target, isolated: false };
        },
      } as unknown as ProjectsService;
      const tools = {
        createTool() { throw new Error("local tool creation is not expected"); },
        createAllTools() { return {}; },
      } as unknown as ToolsService;
      faux = modelRuntime.registerFauxProvider({ provider: "faux" });
      faux.setResponses([
        modelRuntime.fauxAssistantMessage(modelRuntime.fauxToolCall("computer_observe", {}), { stopReason: "toolUse" }),
        modelRuntime.fauxAssistantMessage(modelRuntime.fauxToolCall("computer_browser", { action: "click", target: "Sign in" }), { stopReason: "toolUse" }),
        (context: unknown) => {
          expect(JSON.stringify(context)).not.toContain("never-model-visible-password-otp");
          return modelRuntime.fauxAssistantMessage("Login complete; resumed from fresh observation");
        },
      ]);
      executor = createAgentTurnExecutor({
        agent: requireCapability(AGENT_CAPABILITY),
        model: withTestModel(requireCapability(MODEL_CAPABILITY), faux),
        prompts: requireCapability(PROMPTS_CAPABILITY),
        sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
        sessions: requireCapability(SESSIONS_CAPABILITY),
        tools,
        toolContributions: () => collectContributions(AGENT_TOOL_CONTRIBUTION),
        promptSectionContributions: () => collectContributions(AGENT_PROMPT_SECTION_CONTRIBUTION),
        optional: { projects: () => projects, computer: () => computer },
      }, { stateDir: root, defaultCwd: root });

      jobs = await SessionJobManager.open({
        stateDir: join(root, "jobs"),
        events: requireCapability(EVENTS_CAPABILITY),
        idFactory: () => "job-login-takeover",
        resolveLabel: () => "Login takeover",
        progressNotifyIntervalMs: 0,
      });
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
      const decision = {
        messageId: turn.id,
        destination: { kind: "session" as const, id: "session:new" },
        execution: { profile: "agent" as const },
        confidence: 1,
      };
      const started = await jobs.start({
        sourceKey: "acceptance:login-turn",
        turnId: turn.id,
        destinationId: decision.destination.id,
        text: turn.text,
        timestamp: turn.timestamp,
        origin: {
          authority: turn.principal.authority,
          channel: turn.principal.channel,
          accountId: turn.principal.accountId,
          conversationId: turn.principal.conversationId,
          senderId: turn.principal.senderId,
          ...(turn.projectId === undefined ? {} : { projectId: turn.projectId }),
          ...(turn.projectTargetId === undefined ? {} : { projectTargetId: turn.projectTargetId }),
        },
        run: async (signal, report, jobContext) => {
          const result = await executor!.execute({
            turn,
            decision,
            signal,
            progress: report,
            ...(jobContext?.jobId === undefined ? {} : { jobId: jobContext.jobId }),
            ...(jobContext?.onDirective === undefined ? {} : { onDirective: jobContext.onDirective }),
          });
          return {
            text: result.text,
            ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
            ...(result.afterReply === undefined ? {} : { afterNotify: result.afterReply }),
            ...(result.afterReplyFinalizers === undefined ? {} : { afterNotifyFinalizers: result.afterReplyFinalizers }),
          };
        },
        notify: async (text) => { replies.push(text); },
      });
      expect(started.id).toBe("job-login-takeover");
      await waitUntil(
        () => browserActionCount === 1,
        `real Computer browser action (job=${jobs.get("job-login-takeover")?.status ?? "missing"}, model calls=${faux.state.callCount}, workspace acquisitions=${acquireCalls.length}, leases=${computer.screenLeases().length})`,
        5_000,
      );
      const lease = computer.screenLeases()[0];
      expect(lease).toBeDefined();
      expect(jobs.get("job-login-takeover")?.status).toBe("running");
      expect(acquireCalls).toHaveLength(1);
      expect(acquireCalls[0]).toEqual(expect.objectContaining({
        projectId: "atlas",
        ownerId: "job-login-takeover",
        targetId: "computer:desk-login",
        signal: expect.any(AbortSignal),
      }));
      expect(acquireCalls[0]?.signal?.aborted).toBe(false);

      const secretEnteredByHuman = "never-model-visible-password-otp";
      await computer.takeOver(lease!.id, "client:desktop-login", null);
      await waitUntil(() => computer.status().waitingForControl === 1, "Agent control pause");
      expect(jobs.get("job-login-takeover")?.status).toBe("running");

      signedIn = true;
      await computer.recordHumanActivity(lease!.id, "client:desktop-login");
      const handBack = await computer.handBack(lease!.id, "client:desktop-login");
      expect(handBack.observation.url).toBe("https://example.com/account");
      await waitUntil(() => jobs!.get("job-login-takeover")?.status === "completed", "same Session Job completion after hand-back");
      expect(jobs.list()).toHaveLength(1);
      expect(jobs.get("job-login-takeover")).toMatchObject({ status: "completed", sessionId: expect.any(String) });
      expect(browserActionCount).toBe(1);
      expect(observationCount).toBe(2);
      expect(faux.state.callCount).toBe(3);
      expect(authorization.map((request) => ({ id: request.action.id, jobId: request.jobId }))).toEqual([
        { id: "computer.observe", jobId: "job-login-takeover" },
        { id: "computer.browser.action", jobId: "job-login-takeover" },
      ]);
      expect(JSON.stringify(jobs.get("job-login-takeover"))).not.toContain(secretEnteredByHuman);
      expect(replies.join("\n")).not.toContain(secretEnteredByHuman);
      expect(replies.at(-1)).toContain("Login complete; resumed from fresh observation");
    } finally {
      const activeJob = jobs?.get("job-login-takeover");
      if (jobs && activeJob && ["queued", "running", "waiting-for-computer"].includes(activeJob.status)) {
        await jobs.cancel(activeJob.id, "Acceptance test cleanup").catch(() => undefined);
      }
      await executor?.dispose();
      await jobs?.close();
      faux?.unregister();
      await host?.dispose();
      await rm(root, { recursive: true, force: true });
      if (previousProvider === undefined) delete process.env.FRIDAY_MODEL_PROVIDER;
      else process.env.FRIDAY_MODEL_PROVIDER = previousProvider;
      if (previousModelId === undefined) delete process.env.FRIDAY_MODEL_ID;
      else process.env.FRIDAY_MODEL_ID = previousModelId;
    }
  }, 15_000);

});
