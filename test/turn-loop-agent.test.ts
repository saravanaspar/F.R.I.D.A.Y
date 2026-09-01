import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import agentPlugin from "../plugins/agent/index.js";
import { AGENT_CAPABILITY } from "../plugins/agent/contract.js";
import type { AgentInputContribution, AgentToolContribution } from "../plugins/turn-loop/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import memoryPlugin from "../plugins/memory/index.js";
import { MEMORY_CAPABILITY } from "../plugins/memory/contract.js";
import type { ObservabilityService } from "../plugins/observability/contract.js";
import { MODEL_CAPABILITY, type ModelService } from "../plugins/model/contract.js";
import { principalStateRoot } from "../plugins/principal-scope.js";
import promptsPlugin from "../plugins/prompts/index.js";
import { PROMPTS_CAPABILITY } from "../plugins/prompts/contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { SESSION_RESOURCES_CAPABILITY } from "../plugins/session-resources/contract.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import type { ToolsService } from "../plugins/tools/contract.js";
import type { RoutingDecision } from "../plugins/routing/contract.js";
import { createAgentTurnExecutor } from "../plugins/turn-loop/agent-executor.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";

const roots: string[] = [];
const previousProvider = process.env.FRIDAY_MODEL_PROVIDER;
const previousModelId = process.env.FRIDAY_MODEL_ID;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "friday-turn-agent-"));
  roots.push(root);
  return root;
}

function decision(id: string): RoutingDecision {
  return {
    messageId: "message",
    destination: { kind: "session", id },
    execution: { profile: "agent" },
    confidence: 1,
  };
}

function turn(id: string, text: string): InboundTurn {
  return {
    id,
    principal: {
      authority: "local",
      channel: "local-test",
      accountId: "local",
      conversationId: "terminal",
      senderId: "local-user",
    },
    text,
    timestamp: Date.now(),
    async reply() {},
  };
}

function channelTurn(id: string, text: string, senderId: string): InboundTurn {
  return {
    ...turn(id, text),
    principal: {
      authority: "channel",
      channel: "telegram",
      accountId: "main",
      conversationId: "shared-chat",
      senderId,
    },
  };
}

function withTestModel(
  models: ModelService,
  registration: ReturnType<ModelService["api"]["registerFauxProvider"]>,
): ModelService {
  const registered = registration.getModel();
  const api = new Proxy(models.api, {
    get(target, property, receiver) {
      if (property !== "getModel") return Reflect.get(target, property, receiver);
      return (provider: string, modelId: string) => {
        if (provider === String(registered.provider) && modelId === String(registered.id)) return registered;
        return models.api.getModel(provider as never, modelId as never);
      };
    },
  }) as ModelService["api"];
  return Object.freeze({ api });
}

afterEach(() => {
  uninstallCapabilityRegistry();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousProvider === undefined) delete process.env.FRIDAY_MODEL_PROVIDER;
  else process.env.FRIDAY_MODEL_PROVIDER = previousProvider;
  if (previousModelId === undefined) delete process.env.FRIDAY_MODEL_ID;
  else process.env.FRIDAY_MODEL_ID = previousModelId;
});

describe("Turn Loop agent executor", () => {
  it("persists routed sessions, reuses live runtimes, and safely evicts/reopens them", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);

    const models = requireCapability(MODEL_CAPABILITY);
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const testModels = withTestModel(models, faux);
    const toolCalls: Array<{ cwd: string; sessionId?: string }> = [];
    const tools = {
      api: {},
      createTool() { throw new Error("not used"); },
      createAllTools(cwd: string, options?: { ipython?: { sessionId?: string } }) {
        toolCalls.push({ cwd, ...(options?.ipython?.sessionId === undefined ? {} : { sessionId: options.ipython.sessionId }) });
        return {};
      },
    } as unknown as ToolsService;

    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: testModels,
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools,
    }, {
      stateDir,
      defaultCwd: process.cwd(),
      maxCachedSessions: 1,
    });

    try {
      faux.setResponses([
        models.api.fauxAssistantMessage("first answer"),
        models.api.fauxAssistantMessage("same session answer"),
        models.api.fauxAssistantMessage("second session answer"),
        models.api.fauxAssistantMessage("reopened answer"),
      ]);

      const first = await executor.execute({ turn: turn("m1", "first prompt"), decision: decision("session:new") });
      expect(first.text).toBe("first answer");
      expect(first.sessionId).toBeTruthy();
      const firstId = first.sessionId!;
      const firstPath = join(stateDir, "sessions", `${firstId}.jsonl`);
      expect(existsSync(firstPath)).toBe(true);

      const same = await executor.execute({ turn: turn("m2", "same prompt"), decision: decision(`session:${firstId}`) });
      expect(same).toMatchObject({ text: "same session answer", sessionId: firstId });
      expect(toolCalls.filter((call) => call.sessionId === firstId)).toHaveLength(1);

      const second = await executor.execute({ turn: turn("m3", "new project"), decision: decision("session:new") });
      expect(second.text).toBe("second session answer");
      expect(second.sessionId).toBeTruthy();
      expect(second.sessionId).not.toBe(firstId);

      const reopened = await executor.execute({ turn: turn("m4", "resume first"), decision: decision(`session:${firstId}`) });
      expect(reopened).toMatchObject({ text: "reopened answer", sessionId: firstId });
      expect(toolCalls.filter((call) => call.sessionId === firstId)).toHaveLength(2);
      expect(faux.state.callCount).toBe(4);

      const transcript = readFileSync(firstPath, "utf8");
      expect(transcript).toContain("first prompt");
      expect(transcript).toContain("first answer");
      expect(transcript).toContain("same prompt");
      expect(transcript).toContain("same session answer");
      expect(transcript).toContain("resume first");
      expect(transcript).toContain("reopened answer");
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("re-authorizes a routed session against the exact principal even while its runtime is cached", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);
    const models = requireCapability(MODEL_CAPABILITY);
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: withTestModel(models, faux),
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools: { api: {}, createTool() { throw new Error("not used"); }, createAllTools() { return {}; } } as unknown as ToolsService,
    }, { stateDir, maxCachedSessions: 2 });

    try {
      faux.setResponses([models.api.fauxAssistantMessage("alice private answer")]);
      const created = await executor.execute({
        turn: channelTurn("owner-1", "create my private session", "alice"),
        decision: decision("session:new"),
      });
      await expect(executor.execute({
        turn: channelTurn("owner-2", "open Alice's cached session", "bob"),
        decision: decision(`session:${created.sessionId!}`),
      })).rejects.toThrow(/Permission policy denied session access/);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("injects only the current principal's global memory into model context", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(memoryPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);
    const models = requireCapability(MODEL_CAPABILITY);
    const memory = requireCapability(MEMORY_CAPABILITY);
    const aliceTurn = channelTurn("memory-alice", "What is my private launch phrase?", "alice");
    const aliceMemory = new memory.api.MemoryStore({
      stateDir: memory.api.getGlobalMemoryStateDir(principalStateRoot(stateDir, aliceTurn.principal)),
      scope: "global",
      embeddingProvider: null,
    });
    aliceMemory.create("memory", { id: "launch", title: "Private launch phrase", content: "Alice-only nebula launch phrase." });
    aliceMemory.close();
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const contexts: string[] = [];
    faux.setResponses([
      (context) => { contexts.push(JSON.stringify(context.messages)); return models.api.fauxAssistantMessage("alice answer"); },
      (context) => { contexts.push(JSON.stringify(context.messages)); return models.api.fauxAssistantMessage("bob answer"); },
    ]);
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: withTestModel(models, faux),
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools: { api: {}, createTool() { throw new Error("not used"); }, createAllTools() { return {}; } } as unknown as ToolsService,
      optional: { memory: () => memory },
    }, { stateDir, maxCachedSessions: 2 });

    try {
      await executor.execute({ turn: aliceTurn, decision: decision("session:new") });
      await executor.execute({
        turn: channelTurn("memory-bob", "What is Alice's private launch phrase?", "bob"),
        decision: decision("session:new"),
      });
      expect(contexts[0]).toContain("Alice-only nebula launch phrase");
      expect(contexts[1]).not.toContain("Alice-only nebula launch phrase");
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("refreshes generic Agent tool contributions for an already-open session", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);

    const models = requireCapability(MODEL_CAPABILITY);
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const testModels = withTestModel(models, faux);
    const tools = {
      api: {},
      createTool() { throw new Error("not used"); },
      createAllTools() { return {}; },
    } as unknown as ToolsService;
    const contributions: AgentToolContribution[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: testModels,
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools,
      toolContributions: () => contributions,
    }, { stateDir, maxCachedSessions: 2 });

    try {
      faux.setResponses([models.api.fauxAssistantMessage("opened")]);
      const opened = await executor.execute({ turn: turn("c1", "open session"), decision: decision("session:new") });
      const sessionId = opened.sessionId!;

      contributions.push({
        id: "example-tool",
        name: "example_tool",
        label: "Example tool",
        description: "Return a structured result from an installed plugin contribution.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async execute(input) {
          calls.push(input as Record<string, unknown>);
          return { output: { echoed: input.value ?? null } };
        },
      });
      faux.setResponses([
        models.api.fauxAssistantMessage(
          models.api.fauxToolCall("example_tool", { value: "hello" }),
          { stopReason: "toolUse" },
        ),
        models.api.fauxAssistantMessage("tool completed"),
      ]);

      let releaseProgress!: () => void;
      const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
      let markProgressStarted!: () => void;
      const progressStarted = new Promise<void>((resolve) => { markProgressStarted = resolve; });
      let settled = false;
      const pending = executor.execute({
        turn: turn("c2", "use the installed tool"),
        decision: decision(`session:${sessionId}`),
        progress: async (update) => {
          if (update.kind !== "tool" || !update.message.startsWith("Running tool")) return;
          markProgressStarted();
          await progressGate;
        },
      });
      void pending.finally(() => { settled = true; });
      await progressStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseProgress();
      const result = await pending;
      expect(result).toMatchObject({ text: "tool completed", sessionId });
      expect(calls).toEqual([{ value: "hello" }]);
      expect(faux.state.callCount).toBe(3);
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("keeps prepared attachment context out of user transcript text while carrying bounded attachment references across persistent turns", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);

    const models = requireCapability(MODEL_CAPABILITY);
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const testModels = withTestModel(models, faux);
    const contexts: string[] = [];
    const runtimeContexts: Array<{ sessionId: string; sessionArtifactDir?: string }> = [];
    const input: AgentInputContribution = {
      id: "test-attachments",
      async prepareRuntime(context) {
        runtimeContexts.push({ sessionId: context.sessionId, ...(context.sessionArtifactDir === undefined ? {} : { sessionArtifactDir: context.sessionArtifactDir }) });
        return undefined;
      },
      async prepare(context) {
        if (context.turn?.id !== "attach-1") return undefined;
        return {
          context: "Attachment current-turn preview: sample only",
          persistedContext: "Attachment file remains at /friday/session/attachments/data.json",
        };
      },
    };
    const tools = { api: {}, createTool() { throw new Error("not used"); }, createAllTools() { return {}; } } as unknown as ToolsService;
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: testModels,
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools,
      inputContributions: () => [input],
    }, { stateDir, maxCachedSessions: 2 });

    try {
      faux.setResponses([
        (context) => { contexts.push(JSON.stringify(context.messages)); return models.api.fauxAssistantMessage("first"); },
        (context) => { contexts.push(JSON.stringify(context.messages)); return models.api.fauxAssistantMessage("second"); },
      ]);
      const opened = await executor.execute({ turn: turn("attach-1", "Analyze the attached file."), decision: decision("session:new") });
      const sessionId = opened.sessionId!;
      await executor.execute({ turn: turn("attach-2", "What was that attachment again?"), decision: decision(`session:${sessionId}`) });

      expect(runtimeContexts).toHaveLength(1);
      expect(runtimeContexts[0]?.sessionArtifactDir).toContain(sessionId);
      expect(contexts[0]).toContain("<friday_attachment_context>");
      expect(contexts[0]).toContain("Attachment current-turn preview: sample only");
      expect(contexts[1]).toContain("<friday_persisted_input_context");
      expect(contexts[1]).toContain("/friday/session/attachments/data.json");
      expect(contexts[1]).not.toContain("Attachment current-turn preview: sample only");

      const transcript = readFileSync(join(stateDir, "sessions", `${sessionId}.jsonl`), "utf8");
      expect(transcript).toContain("Analyze the attached file.");
      expect(transcript).toContain("What was that attachment again?");
      expect(transcript).not.toContain("<friday_attachment_context>");
      expect(transcript).not.toContain("Attachment current-turn preview: sample only");
      expect(transcript).toContain("friday.agent-input:test-attachments");
      expect(transcript).toContain("/friday/session/attachments/data.json");
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("keeps volatile Memory out of the stable system prompt and transcript while exposing it ephemerally with cache metrics", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(memoryPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);

    const models = requireCapability(MODEL_CAPABILITY);
    const memory = requireCapability(MEMORY_CAPABILITY);
    const global = new memory.api.MemoryStore({ stateDir: memory.api.getGlobalMemoryStateDir(stateDir), scope: "global", embeddingProvider: null });
    global.create("memory", { id: "cache-lesson", title: "Cache lesson", content: "Stable prefixes improve provider cache reuse." });
    global.close();

    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const testModels = withTestModel(models, faux);
    const contexts: string[] = [];
    const systemPrompts: string[] = [];
    const metricIncrements: Array<{ name: string; value: number }> = [];
    const observability = {
      increment(name: string, value = 1) { metricIncrements.push({ name, value }); },
      observe() {}, log() {}, gauge() {}, currentTrace: () => undefined, startSpan: () => ({ context: { traceId: "t", spanId: "s" }, end() {} }),
      withSpan: (_input: unknown, operation: () => unknown) => operation(), logs: () => [], spans: () => [], metrics: () => [], status: () => ({ logCount: 0, spanCount: 0, metricSeriesCount: 0, maxLogRows: 0, maxSpanRows: 0, maxMetricSeries: 0, droppedLogs: 0, droppedSpans: 0, droppedMetrics: 0 }), close() {},
    } as unknown as ObservabilityService;
    const tools = { api: {}, createTool() { throw new Error("not used"); }, createAllTools() { return {}; } } as unknown as ToolsService;
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: testModels,
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools,
      optional: { credentials: () => undefined, memory: () => memory, observability: () => observability, skills: () => undefined, rlm: () => undefined, subagents: () => undefined, sandbox: () => undefined },
    }, { stateDir, maxCachedSessions: 2 });

    try {
      faux.setResponses([
        (context) => { contexts.push(JSON.stringify(context.messages)); systemPrompts.push(context.systemPrompt ?? ""); return models.api.fauxAssistantMessage("first"); },
        (context) => { contexts.push(JSON.stringify(context.messages)); systemPrompts.push(context.systemPrompt ?? ""); return models.api.fauxAssistantMessage("second"); },
      ]);
      const opened = await executor.execute({
        turn: turn("mem-1", "How do stable prefixes improve provider cache reuse?"),
        decision: decision("session:new"),
      });
      const sessionId = opened.sessionId!;

      const changed = new memory.api.MemoryStore({ stateDir: memory.api.getGlobalMemoryStateDir(stateDir), scope: "global", embeddingProvider: null });
      changed.update("memory", "cache-lesson", { title: "Cache lesson", content: "UPDATED memory is visible only in runtime context." });
      changed.close();
      await executor.execute({
        turn: turn("mem-2", "What does the updated memory say?"),
        decision: decision(`session:${sessionId}`),
      });

      expect(systemPrompts).toHaveLength(2);
      expect(systemPrompts[0]).toBe(systemPrompts[1]);
      expect(systemPrompts[0]).not.toContain("Stable prefixes improve provider cache reuse");
      expect(systemPrompts[1]).not.toContain("UPDATED memory");
      expect(contexts[0]).toContain("<friday_runtime_context>");
      expect(contexts[0]).toContain("Stable prefixes improve provider cache reuse");
      expect(contexts[1]).toContain("UPDATED memory is visible only in runtime context");

      const transcript = readFileSync(join(stateDir, "sessions", `${sessionId}.jsonl`), "utf8");
      expect(transcript).toContain("How do stable prefixes improve provider cache reuse?");
      expect(transcript).toContain("What does the updated memory say?");
      expect(transcript).not.toContain("<friday_runtime_context>");
      expect(transcript).not.toContain("UPDATED memory");
      expect(metricIncrements.some((metric) => metric.name === "model.tokens.cache_read" && metric.value > 0)).toBe(true);
      expect(metricIncrements.some((metric) => metric.name === "model.tokens.cache_write" && metric.value > 0)).toBe(true);
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });

  it("keeps transient utility turns in memory and disposes their session resources", async () => {
    process.env.FRIDAY_MODEL_PROVIDER = "faux";
    process.env.FRIDAY_MODEL_ID = "faux-1";
    const stateDir = tempRoot();
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(sessionsPlugin);
    await friday.activatePlugin(promptsPlugin);
    await friday.activatePlugin(modelPlugin);
    await friday.activatePlugin(agentPlugin);

    const models = requireCapability(MODEL_CAPABILITY);
    const faux = models.api.registerFauxProvider({ provider: "faux" });
    const testModels = withTestModel(models, faux);
    const tools = {
      api: {},
      createTool() { throw new Error("not used"); },
      createAllTools() { return {}; },
    } as unknown as ToolsService;
    const executor = createAgentTurnExecutor({
      agent: requireCapability(AGENT_CAPABILITY),
      model: testModels,
      prompts: requireCapability(PROMPTS_CAPABILITY),
      sessionResources: requireCapability(SESSION_RESOURCES_CAPABILITY),
      sessions: requireCapability(SESSIONS_CAPABILITY),
      tools,
    }, { stateDir });

    try {
      faux.setResponses([models.api.fauxAssistantMessage("utility answer")]);
      const result = await executor.execute({
        turn: turn("u1", "one off"),
        decision: {
          messageId: "u1",
          destination: { kind: "transient", id: "transient:utility" },
          execution: { profile: "utility" },
          confidence: 1,
        },
      });
      expect(result).toEqual({ text: "utility answer" });
      expect(existsSync(join(stateDir, "sessions"))).toBe(false);
    } finally {
      await executor.dispose();
      faux.unregister();
    }
  });
});
