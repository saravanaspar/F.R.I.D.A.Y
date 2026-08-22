import type { ModelCredentialService } from "../auth/contract.js";
import type { ModelService } from "../model/contract.js";
import type { PermissionsService } from "../permissions/contract.js";
import type { RoutingDecision } from "../routing/contract.js";
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from "../turn-loop/contract.js";
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

export interface SystemTurnExecutorOptions {
  readonly permissions: PermissionsService;
  readonly actions: () => readonly SystemActionContribution[];
  readonly planner: SystemTurnPlanner;
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
  const provider = environment.FRIDAY_SYSTEM_PROVIDER?.trim() || environment.FRIDAY_MODEL_PROVIDER?.trim();
  const modelId = environment.FRIDAY_SYSTEM_MODEL_ID?.trim() || environment.FRIDAY_MODEL_ID?.trim();
  if (!provider || !modelId) {
    throw new Error(
      "System model selection is required: set FRIDAY_SYSTEM_PROVIDER/FRIDAY_SYSTEM_MODEL_ID or FRIDAY_MODEL_PROVIDER/FRIDAY_MODEL_ID",
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
    "For general FRIDAY health/status requests choose system.status.",
    "For questions specifically asking what work/tasks/jobs are currently running, choose session.jobs.list when that action is available.",
    "For requests to stop/cancel background project work, choose session.jobs.cancel; the action itself performs deterministic disambiguation and confirmation.",
    "For requests to show a session/job transcript or recent prompts/answers/progress, choose session.transcript when available.",
    "If the user explicitly asks FRIDAY to add/build a software capability that no installed action can currently perform, and self-improvement.ensure-capability is available, choose that action with a concise feature name and implementation objective. That action performs feasibility analysis before messaging, authorization, or code changes.",
    "For other requests that do not match an installed action choose system.actions so the user can see the supported control surface.",
    "Also return presentation=raw unless the user explicitly asks to analyze, explain, diagnose, interpret, or summarize the action result; then return presentation=analyze.",
    "When the user explicitly asks for a count such as the last 50 records, put that count into the action input and do not silently reduce it.",
  ].join("\n");
}

export function createSystemModelPlanner(models: ModelService, credentials: () => ModelCredentialService | undefined = () => undefined): SystemTurnPlanner {
  return async (request) => {
    const selected = selectedModel();
    const model = models.api.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown system model: ${selected.provider}/${selected.modelId}`);
    const apiKey = await credentials()?.getApiKey(selected.provider);
    const response = await models.api.completeSimple(
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
    return normalizePlan(models.api.parseJsonWithRepair<unknown>(text));
  };
}

export function createSystemModelPresenter(models: ModelService, credentials: () => ModelCredentialService | undefined = () => undefined): SystemPresenter {
  return async (request) => {
    const selected = selectedModel();
    const model = models.api.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown system model: ${selected.provider}/${selected.modelId}`);
    const apiKey = await credentials()?.getApiKey(selected.provider);
    const serialized = outputText(request.output);
    const response = await models.api.completeSimple(
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

function actionMap(actions: readonly SystemActionContribution[]): Map<string, SystemActionContribution> {
  const result = new Map<string, SystemActionContribution>();
  for (const action of actions) {
    const id = nonEmptyString(action.id, "system action id");
    if (result.has(id)) throw new Error(`Duplicate system action contribution: ${id}`);
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
      const permission = action.permission?.(plan.input);
      if (permission) {
        await options.permissions.authorize({
          mode: options.permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
          workspace: process.cwd(),
          access: permission.effect === "workspace-read" || permission.effect === "external-read" ? "read" : "write",
          action: permission,
          reason: `system action ${action.id}`,
        });
      }
      context.signal?.throwIfAborted();
      const afterReply: Array<() => void | Promise<void>> = [];
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
        const output = await action.execute(plan.input, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          turn: context.turn,
          ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
          ...(context.decision.destination.kind === "session" ? { destinationId: context.decision.destination.id } : {}),
          deferAfterReply(callback) {
            if (typeof callback !== "function") throw new Error("after-reply finalizer must be a function");
            afterReply.push(callback);
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

export function createSystemActionsAction(
  actions: () => readonly SystemActionContribution[],
): SystemActionContribution {
  return Object.freeze({
    id: "system.actions",
    label: "FRIDAY system actions",
    description: "List the explicit system/status/configuration actions currently installed.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    execute() {
      return [...actionMap(actions()).values()]
        .filter((action) => action.id !== "system.actions")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((action) => ({ id: action.id, label: action.label, description: action.description }));
    },
  });
}
