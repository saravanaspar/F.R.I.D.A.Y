import { homedir } from "node:os";
import { reportOperationalError } from "@friday/operational-errors";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentMessage, AgentService, AgentTool, AssistantMessage } from "../agent/contract.js";
import type { ModelCredentialService } from "../auth/contract.js";
import type { ModelService } from "../model/contract.js";
import type { PermissionMode } from "../permissions/contract.js";
import type { PromptsService } from "../prompts/contract.js";
import type { SessionResourcesService } from "../session-resources/contract.js";
import type { SessionsService } from "../sessions/contract.js";
import type { ToolsService } from "../tools/contract.js";
import type {
  AutonomousRunOptions,
  AutonomousRunResult,
} from "./contract.js";

type AutonomyRuntime = Pick<
  typeof import("@friday/autonomy"),
  | "createAutonomousRuntimeState"
  | "nextAutonomousContinuation"
  | "addAutonomousUsage"
  | "refreshAutonomousQualityGates"
>;

const DEFAULT_AUTONOMOUS_SYSTEM_PROMPT =
  "You are operating autonomously. Work only inside the current workspace. Use host-observable evidence to finish the objective. Do not ask for human input while autonomous mode is enabled.";

export interface AutonomousRunnerDependencies {
  readonly agent: AgentService;
  readonly model: ModelService;
  readonly prompts: PromptsService;
  readonly sessionResources: SessionResourcesService;
  readonly sessions: SessionsService;
  readonly tools: ToolsService;
  readonly credentials?: (() => ModelCredentialService | undefined) | undefined;
}

function stateRoot(input?: string): string {
  return resolve(input ?? process.env.FRIDAY_STATE_DIR ?? join(homedir(), ".friday"));
}

function textFromAssistant(message: AssistantMessage | undefined): string {
  return message
    ? message.content
        .flatMap((content: { type: string; text?: string }) =>
          content.type === "text" && typeof content.text === "string" ? [content.text] : [],
        )
        .join("")
        .trim()
    : "";
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
}

function makeAutonomousTools(
  tools: ToolsService,
  cwd: string,
  permissionMode: PermissionMode | undefined,
): AgentTool[] {
  const bash = tools.createTool("bash", cwd, { permissionMode });
  const edit = tools.createTool("edit", cwd, { permissionMode });

  // Keep workspace-mutating autonomous tools sequential so concurrent tool calls
  // cannot race against one another in the same checkout.
  bash.executionMode = "sequential";
  edit.executionMode = "sequential";

  // Persistent host IPython is intentionally not exposed by this workflow.
  return [bash, edit] as AgentTool[];
}

function normalizeModel(models: ModelService, provider: string, modelId: string) {
  const model = models.getModel(provider as never, modelId as never);
  if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
  return model;
}

export async function runAutonomousObjective(
  autonomy: AutonomyRuntime,
  dependencies: AutonomousRunnerDependencies,
  options: AutonomousRunOptions,
): Promise<AutonomousRunResult> {
  const cwd = resolve(options.cwd);
  const root = stateRoot(options.stateDir);
  const model = normalizeModel(dependencies.model, options.provider, options.model);
  const session = dependencies.sessions.SessionManager.create(cwd, join(root, "sessions"));
  const gateCommands = options.gates?.map((gate) => gate.command) ?? [];
  const autonomousState = autonomy.createAutonomousRuntimeState(
    {
      enabled: true,
      ...(options.maxContinuations === undefined ? {} : { maxContinuations: options.maxContinuations }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      gates: { commands: gateCommands, maxRetries: 4 },
    },
    { cwd },
  );
  const tools = makeAutonomousTools(dependencies.tools, cwd, options.permissionMode);
  const messagesPath = session.getSessionFile();
  const systemPrompt = dependencies.prompts.buildSystemPrompt({
    cwd,
    ...(messagesPath === undefined ? {} : { messagesPath }),
    selectedTools: tools.map((tool) => tool.name),
    allowRecursion: false,
    appendSystemPrompt: [DEFAULT_AUTONOMOUS_SYSTEM_PROMPT, options.additionalSystemPrompt]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n"),
  });

  // The Agent owns the turn loop; autonomous continuation is injected through
  // getContinuationMessages, message_end persists the transcript, and assistant
  // usage feeds the autonomy budget.
  const agent = new dependencies.agent.Agent({
    initialState: {
      model: model as never,
      tools,
      systemPrompt,
      thinkingLevel: model.reasoning ? "high" : "off",
    },
    sessionId: session.getSessionId(),
    getApiKey: async (provider) => dependencies.credentials?.()?.getApiKey(provider),
    getContinuationMessages: async (context: { message: unknown }, signal?: AbortSignal) => {
      const next = await autonomy.nextAutonomousContinuation(autonomousState, context.message as never, {
        cwd,
        ...(signal ? { signal } : {}),
      });
      return next ? [next as never] : [];
    },
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const message = event.message;
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      session.appendMessage(message as never);
    }
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      if (assistant.stopReason !== "error") autonomy.addAutonomousUsage(autonomousState, assistant.usage);
    }
  });

  const onAbort = () => agent.abort();
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(options.objective);
    options.signal?.throwIfAborted();
    const gateState = gateCommands.length > 0
      ? await autonomy.refreshAutonomousQualityGates(autonomousState, { cwd })
      : undefined;
    return {
      sessionId: session.getSessionId(),
      finalText: textFromAssistant(lastAssistant(agent.state.messages)),
      gatesPassed: gateCommands.length === 0 || gateState === "passed",
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      dependencies.sessionResources.cleanupSessionResources(session.getSessionId());
    } catch (error) {
      reportOperationalError({ component: "autonomy", operation: `cleanup session ${session.getSessionId()}`, error });
    }
  }
}
