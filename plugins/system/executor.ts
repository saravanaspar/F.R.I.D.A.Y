import type { ModelCredentialService } from "../auth/contract.js";
import type { ModelService } from "../model/contract.js";
import { permissionEffectAccess, type PermissionsService } from "../permissions/contract.js";
import type { RoutingDecision } from "../routing/contract.js";
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor, TurnFinalizerDescriptor } from "../turn-loop/contract.js";
import type {
  SystemActionContribution,
  SystemJsonObject,
  SystemJsonValue,
  SystemStatusContribution,
} from "./contract.js";

const MAX_PLAN_TOKENS = 512;
const MAX_OUTPUT_CHARS = 128_000;
const MAX_PRESENTATION_TOKENS = 1_200;

export interface SystemPlannerAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<SystemJsonObject>;
}

export interface SystemPlannerRequest {
  readonly text: string;
  readonly actions: readonly SystemPlannerAction[];
  readonly signal?: AbortSignal | undefined;
}

export type SystemPresentationMode = "raw" | "analyze";

export interface SystemTurnPlan {
  readonly actionId: string;
  readonly input: Readonly<SystemJsonObject>;
  readonly presentation?: SystemPresentationMode | undefined;
}

export interface SystemPresenterRequest {
  readonly userText: string;
  readonly action: SystemPlannerAction;
  readonly output: SystemJsonValue;
  readonly signal?: AbortSignal | undefined;
}

export type SystemPresenter = (request: SystemPresenterRequest) => Promise<string>;

export type SystemTurnPlanner = (request: SystemPlannerRequest) => Promise<SystemTurnPlan>;

export type SystemActionInputValidator = (
  action: SystemActionContribution,
  input: Readonly<SystemJsonObject>,
) => Readonly<SystemJsonObject>;

export interface SystemTurnExecutorOptions {
  readonly permissions: PermissionsService;
  readonly actions: () => readonly SystemActionContribution[];
  readonly planner: SystemTurnPlanner;
  readonly validateInput: SystemActionInputValidator;
  readonly presenter?: SystemPresenter | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertJsonValue(value: unknown, label = "value"): asserts value is SystemJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${label}.${key}`);
    return;
  }
  throw new Error(`${label} must contain only JSON-safe values`);
}

function jsonObject(value: unknown, label: string): SystemJsonObject {
  const candidate = record(value);
  if (!candidate) throw new Error(`${label} must be a JSON object`);
  assertJsonValue(candidate, label);
  return candidate as SystemJsonObject;
}

function freezeJsonValue<T extends SystemJsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJsonValue(entry);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freezeJsonValue(entry);
    return Object.freeze(value) as T;
  }
  return value;
}

function nonEmptyString(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function normalizePlan(value: unknown): SystemTurnPlan {
  const candidate = record(value);
  if (!candidate) throw new Error("system plan must be a JSON object");
  return Object.freeze({
    actionId: nonEmptyString(candidate.actionId, "system plan actionId"),
    input: Object.freeze(jsonObject(candidate.input ?? {}, "system plan input")),
    presentation: candidate.presentation === "analyze" ? "analyze" : "raw",
  });
}

function selectedModel(environment: NodeJS.ProcessEnv = process.env): { provider: string; modelId: string } {
  const systemProvider = environment.FRIDAY_SYSTEM_PROVIDER?.trim();
  const systemModelId = environment.FRIDAY_SYSTEM_MODEL_ID?.trim();
  if (Boolean(systemProvider) !== Boolean(systemModelId)) {
    throw new Error("System model selection requires both FRIDAY_SYSTEM_PROVIDER and FRIDAY_SYSTEM_MODEL_ID");
  }
  const routingProvider = environment.FRIDAY_ROUTING_PROVIDER?.trim();
  const routingModelId = environment.FRIDAY_ROUTING_MODEL_ID?.trim();
  if (Boolean(routingProvider) !== Boolean(routingModelId)) {
    throw new Error("Routing model selection requires both FRIDAY_ROUTING_PROVIDER and FRIDAY_ROUTING_MODEL_ID");
  }
  const mainProvider = environment.FRIDAY_MODEL_PROVIDER?.trim();
  const mainModelId = environment.FRIDAY_MODEL_ID?.trim();
  if (Boolean(mainProvider) !== Boolean(mainModelId)) {
    throw new Error("Main model selection requires both FRIDAY_MODEL_PROVIDER and FRIDAY_MODEL_ID");
  }
  const provider = systemProvider || routingProvider || mainProvider;
  const modelId = systemModelId || routingModelId || mainModelId;
  if (!provider || !modelId) {
    throw new Error(
      "System model selection is required: configure a System, Routing, or main model provider/model pair",
    );
  }
  return { provider, modelId };
}

function plannerSystemPrompt(): string {
  return [
    "You are FRIDAY's explicit system-action selector.",
    "Return exactly one JSON object and no prose.",
    "Choose exactly one host-supplied actionId. Never invent action ids.",
    "Use only input fields declared by the selected action.",
    "For an operator dashboard or a combined view of jobs, approvals, schedules, delivery failures, and usage choose operator.dashboard.",
    "For general FRIDAY health/status requests choose system.status.",
    "For questions specifically asking what work/tasks/jobs are currently running, choose session.jobs.list when that action is available.",
    "For requests to stop/cancel background project work, choose session.jobs.cancel; the action itself performs deterministic disambiguation and confirmation.",
    "For requests to show a session/job transcript or recent prompts/answers/progress, choose session.transcript when available.",
    "For requests to create persistent conditional whenever/if-then/before-action/after-action/before-handover behavior, choose conditional-hooks.create when available and preserve the user's condition and instruction generically. Do not invent a condition-specific action or silently choose an invocation count.",
    "For requests to inspect or remove those rules, choose conditional-hooks.list or conditional-hooks.remove when available.",
    "If the user explicitly asks FRIDAY to add/build a software capability that no installed action can currently perform, and self-improvement.ensure-capability is available, choose that action with a concise feature name and implementation objective. That action performs feasibility analysis before messaging, authorization, or code changes.",
    "For other requests that do not match an installed action choose system.actions so the user can see the supported control surface.",
    "Also return presentation=raw unless the user explicitly asks to analyze, explain, diagnose, interpret, or summarize the action result; then return presentation=analyze.",
    "When the user explicitly asks for a count such as the last 50 records, put that count into the action input and do not silently reduce it.",
  ].join("\n");
}

export function createSystemModelPlanner(models: ModelService, credentials: () => ModelCredentialService | undefined = () => undefined): SystemTurnPlanner {
  return async (request) => {
    const selected = selectedModel();
    const model = models.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown system model: ${selected.provider}/${selected.modelId}`);
    const apiKey = await credentials()?.getApiKey(selected.provider);
    const response = await models.completeSimple(
      model,
      {
        systemPrompt: plannerSystemPrompt(),
        messages: [{
          role: "user",
          content: JSON.stringify({
            request: request.text,
            actions: request.actions,
            outputShape: { actionId: "host-action-id", input: {}, presentation: "raw|analyze" },
          }),
          timestamp: Date.now(),
        }],
      },
      {
        temperature: 0,
        maxTokens: MAX_PLAN_TOKENS,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`System model failed: ${response.errorMessage || response.stopReason}`);
    }
    if (response.stopReason === "length") throw new Error("System model output was truncated");
    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("System model returned no JSON action");
    return normalizePlan(models.parseJsonWithRepair<unknown>(text));
  };
}

export function createSystemModelPresenter(models: ModelService, credentials: () => ModelCredentialService | undefined = () => undefined): SystemPresenter {
  return async (request) => {
    const selected = selectedModel();
    const model = models.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown system model: ${selected.provider}/${selected.modelId}`);
    const apiKey = await credentials()?.getApiKey(selected.provider);
    const serialized = outputText(request.output);
    const response = await models.completeSimple(
      model,
      {
        systemPrompt: [
          "You are FRIDAY's system-result analyst.",
          "Analyze only the sanitized host-provided action output.",
          "Answer the user's explicit analytical question concisely and accurately.",
          "Do not invent records or claim access to data not present in the output.",
        ].join("\n"),
        messages: [{ role: "user", content: JSON.stringify({ request: request.userText, action: request.action, output: serialized }), timestamp: Date.now() }],
      },
      { temperature: 0, maxTokens: MAX_PRESENTATION_TOKENS, ...(apiKey === undefined ? {} : { apiKey }), ...(request.signal === undefined ? {} : { signal: request.signal }) },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`System presentation model failed: ${response.errorMessage || response.stopReason}`);
    const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim();
    if (!text) throw new Error("System presentation model returned no text");
    return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS - 1)}…`;
  };
}

export function createSystemActionInputValidator(
  models: Pick<ModelService, "validateToolArguments">,
): SystemActionInputValidator {
  return (action, input) => {
    const validated = models.validateToolArguments(
      {
        name: action.id,
        description: action.description,
        parameters: action.parameters as never,
      },
      {
        type: "toolCall",
        id: `system:${action.id}`,
        name: action.id,
        arguments: structuredClone(input) as Record<string, unknown>,
      } as never,
    );
    return freezeJsonValue(jsonObject(validated, `system action ${action.id} input`));
  };
}

function actionMap(actions: readonly SystemActionContribution[]): Map<string, SystemActionContribution> {
  const result = new Map<string, SystemActionContribution>();
  for (const action of actions) {
    const id = nonEmptyString(action.id, "system action id");
    if (result.has(id)) throw new Error(`Duplicate system action contribution: ${id}`);
    if (typeof action.permission !== "function") {
      throw new Error(`System action ${id} has no explicit permission declaration`);
    }
    result.set(id, action);
  }
  return result;
}

function plannerActions(actions: readonly SystemActionContribution[]): readonly SystemPlannerAction[] {
  return Object.freeze([...actionMap(actions).values()].map((action) => Object.freeze({
    id: action.id,
    label: action.label,
    description: action.description,
    parameters: action.parameters,
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

function outputText(value: SystemJsonValue): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS - 1)}…`;
}

function exactSystemDecision(decision: RoutingDecision): boolean {
  return decision.destination.kind === "system"
    && decision.destination.id === "system"
    && decision.execution.profile === "system";
}

export function createSystemTurnExecutor(options: SystemTurnExecutorOptions): TurnExecutor {
  return Object.freeze({
    id: "system",
    canHandle: exactSystemDecision,
    async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
      context.signal?.throwIfAborted();
      const actions = options.actions();
      const plan = await options.planner({
        text: context.turn.text,
        actions: plannerActions(actions),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const action = actionMap(actions).get(plan.actionId);
      if (!action) throw new Error(`System plan selected an unavailable action: ${plan.actionId}`);
      const input = options.validateInput(action, plan.input);
      const permission = action.permission(input);
      if (!permission || typeof permission !== "object") {
        throw new Error(`System action ${action.id} returned no permission declaration`);
      }
      await options.permissions.authorize({
        mode: options.permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: process.cwd(),
        access: permissionEffectAccess(permission.effect),
        action: permission,
        reason: `system action ${action.id}`,
        ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
      });
      context.signal?.throwIfAborted();
      const afterReply: Array<() => void | Promise<void>> = [];
      const afterReplyFinalizers: TurnFinalizerDescriptor[] = [];
      const afterFailure: Array<(error: unknown) => void | Promise<void>> = [];
      let failureFinalized = false;
      const finalizeFailure = async (error: unknown): Promise<void> => {
        if (failureFinalized) return;
        failureFinalized = true;
        const failures: unknown[] = [];
        for (const callback of [...afterFailure].reverse()) {
          try {
            await callback(error);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError([error, ...failures], `System action ${action.id} failed and compensation was incomplete`);
        }
      };
      try {
        const output = await action.execute(input, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          turn: context.turn,
          ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
          ...(context.decision.destination.kind === "session" ? { destinationId: context.decision.destination.id } : {}),
          deferAfterReply(callback, durable) {
            if (typeof callback !== "function") throw new Error("after-reply finalizer must be a function");
            afterReply.push(callback);
            if (durable) afterReplyFinalizers.push(durable);
          },
          deferOnFailure(callback) {
            if (typeof callback !== "function") throw new Error("failure finalizer must be a function");
            afterFailure.push(callback);
          },
        });
        assertJsonValue(output, `system action ${action.id} output`);
        const presentation = plan.presentation ?? "raw";
        const text = presentation === "analyze" && options.presenter
          ? await options.presenter({
              userText: context.turn.text,
              action: { id: action.id, label: action.label, description: action.description, parameters: action.parameters },
              output,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            })
          : outputText(output);
        return Object.freeze({
          text,
          metadata: { actionId: action.id, presentation },
          ...(afterReply.length === 0 ? {} : {
            afterReply: async () => {
              for (const callback of afterReply) await callback();
            },
          }),
          ...(afterReplyFinalizers.length === 0 ? {} : {
            afterReplyFinalizers: Object.freeze(afterReplyFinalizers.map((entry) => Object.freeze({
              type: entry.type,
              payload: structuredClone(entry.payload),
            }))),
          }),
          ...(afterFailure.length === 0 ? {} : { afterFailure: finalizeFailure }),
        });
      } catch (error) {
        await finalizeFailure(error);
        throw error;
      }
    },
  });
}

export function createSystemStatusAction(
  statuses: () => readonly SystemStatusContribution[],
): SystemActionContribution {
  return Object.freeze({
    id: "system.status",
    label: "FRIDAY status",
    description: "Show current status snapshots contributed by installed FRIDAY plugins.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "system.status", effect: "global-operational-read", resource: "system:status", network: false } as const;
    },
    async execute() {
      const seen = new Set<string>();
      const sections: Record<string, SystemJsonValue> = {};
      const contributions = [...statuses()].sort((left, right) => left.id.localeCompare(right.id));
      for (const status of contributions) {
        const id = nonEmptyString(status.id, "system status id");
        if (seen.has(id)) throw new Error(`Duplicate system status contribution: ${id}`);
        seen.add(id);
        const snapshot = await status.snapshot();
        assertJsonValue(snapshot, `system status ${id}`);
        sections[id] = { label: status.label, snapshot };
      }
      return sections;
    },
  });
}

export function createOperatorDashboardAction(
  statuses: () => readonly SystemStatusContribution[],
): SystemActionContribution {
  return Object.freeze({
    id: "operator.dashboard",
    label: "Operator dashboard",
    description: "Show one correlated operator view of active jobs, pending approvals/questions, delivery failures, schedules, and current usage.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "operator.dashboard", effect: "global-operational-read", resource: "system:operator-dashboard", network: false } as const;
    },
    async execute() {
      const sections: Record<string, SystemJsonValue> = {};
      const seen = new Set<string>();
      for (const status of [...statuses()].sort((left, right) => left.id.localeCompare(right.id))) {
        const id = nonEmptyString(status.id, "operator dashboard status id");
        if (seen.has(id)) throw new Error(`Duplicate system status contribution: ${id}`);
        seen.add(id);
        const snapshot = await status.snapshot();
        assertJsonValue(snapshot, `operator dashboard ${id}`);
        sections[id] = { label: status.label, snapshot };
      }
      return { generatedAt: new Date().toISOString(), sections };
    },
  });
}

export function createSystemActionsAction(
  actions: () => readonly SystemActionContribution[],
): SystemActionContribution {
  return Object.freeze({
    id: "system.actions",
    label: "FRIDAY system actions",
    description: "List the explicit system/status/configuration actions currently installed.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "system.actions", effect: "public-read", resource: "system:actions", network: false } as const;
    },
    execute() {
      return [...actionMap(actions()).values()]
        .filter((action) => action.id !== "system.actions")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((action) => ({ id: action.id, label: action.label, description: action.description }));
    },
  });
}
