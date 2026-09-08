import type { ModelService } from "../model/contract.js";
import { permissionEffectAccess, type PermissionsService } from "../permissions/contract.js";
import type { PermissionsTrustedService } from "../permissions/trusted-contract.js";
import { ownerScopeAllows, principalScope, type PrincipalOrigin } from "../principal-scope.js";
import type { RoutingDecision } from "../routing/contract.js";
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from "../turn-loop/contract.js";
import {
  SCHEDULED_ACTION_TASK_TYPE,
  type JsonObject,
  type JsonValue,
  type MissedRunPolicy,
  type ScheduleSpec,
  type ScheduledActionContribution,
  type ScheduledActionPrepareContext,
  type ScheduledTask,
  type SchedulerService,
} from "./contract.js";

const MAX_PLAN_TOKENS = 768;
const MAX_NAME_CHARS = 160;
const MAX_RESPONSE_CHARS = 24_000;
const MAX_HISTORY = 100;

export interface SchedulerPlannerAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<JsonObject>;
}

export interface SchedulerPlannerTask {
  readonly id: string;
  readonly name: string;
  readonly actionId?: string | undefined;
  readonly enabled: boolean;
  readonly nextRunAt: string;
  readonly schedule: ScheduleSpec;
}

export interface SchedulerPlannerRequest {
  readonly text: string;
  readonly now: string;
  readonly timezone: string;
  readonly actions: readonly SchedulerPlannerAction[];
  readonly tasks: readonly SchedulerPlannerTask[];
  readonly signal?: AbortSignal | undefined;
}

export type SchedulerTurnPlan =
  | {
      readonly operation: "create";
      readonly actionId: string;
      readonly input: Readonly<JsonObject>;
      readonly schedule: ScheduleSpec;
      readonly name?: string | undefined;
      readonly missedRunPolicy?: MissedRunPolicy | undefined;
    }
  | { readonly operation: "list" }
  | { readonly operation: "cancel"; readonly taskId: string }
  | { readonly operation: "remove"; readonly taskId: string }
  | { readonly operation: "history"; readonly taskId?: string | undefined; readonly limit?: number | undefined };

export type SchedulerTurnPlanner = (request: SchedulerPlannerRequest) => Promise<SchedulerTurnPlan>;

export interface SchedulerTurnExecutorOptions {
  readonly scheduler: SchedulerService;
  readonly permissions: PermissionsService;
  readonly actions: () => readonly ScheduledActionContribution[];
  readonly planner: SchedulerTurnPlanner;
  readonly now?: (() => Date) | undefined;
  readonly timezone?: (() => string) | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
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

function jsonObject(value: unknown, label: string): JsonObject {
  const candidate = record(value);
  if (!candidate) throw new Error(`${label} must be a JSON object`);
  assertJsonValue(candidate, label);
  return candidate as JsonObject;
}

function nonEmptyString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function optionalName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonEmptyString(value, "scheduler plan name", MAX_NAME_CHARS);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function scheduleSpec(value: unknown): ScheduleSpec {
  const candidate = record(value);
  if (!candidate) throw new Error("scheduler plan schedule must be an object");
  if (candidate.kind === "once") {
    const at = nonEmptyString(candidate.at, "scheduler once.at", 128);
    if (Number.isNaN(Date.parse(at))) throw new Error("scheduler once.at must be an ISO timestamp");
    return { kind: "once", at };
  }
  if (candidate.kind === "interval") {
    const everyMs = positiveInteger(candidate.everyMs, "scheduler interval.everyMs");
    const startAt = candidate.startAt === undefined ? undefined : nonEmptyString(candidate.startAt, "scheduler interval.startAt", 128);
    if (startAt !== undefined && Number.isNaN(Date.parse(startAt))) {
      throw new Error("scheduler interval.startAt must be an ISO timestamp");
    }
    return { kind: "interval", everyMs, ...(startAt === undefined ? {} : { startAt }) };
  }
  if (candidate.kind === "cron") {
    return {
      kind: "cron",
      expression: nonEmptyString(candidate.expression, "scheduler cron.expression", 128),
      timezone: nonEmptyString(candidate.timezone, "scheduler cron.timezone", 128),
    };
  }
  throw new Error("scheduler plan schedule kind must be once, interval, or cron");
}

function missedRunPolicy(value: unknown): MissedRunPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "coalesce" || value === "catch-up" || value === "skip") return value;
  throw new Error("scheduler plan missedRunPolicy must be coalesce, catch-up, or skip");
}

function normalizePlan(value: unknown): SchedulerTurnPlan {
  const candidate = record(value);
  if (!candidate) throw new Error("scheduler plan must be a JSON object");
  const operation = candidate.operation;
  if (operation === "create") {
    return Object.freeze({
      operation,
      actionId: nonEmptyString(candidate.actionId, "scheduler plan actionId", 128),
      input: Object.freeze(jsonObject(candidate.input ?? {}, "scheduler plan input")),
      schedule: Object.freeze(scheduleSpec(candidate.schedule)),
      ...(optionalName(candidate.name) === undefined ? {} : { name: optionalName(candidate.name)! }),
      ...(missedRunPolicy(candidate.missedRunPolicy) === undefined ? {} : { missedRunPolicy: missedRunPolicy(candidate.missedRunPolicy)! }),
    });
  }
  if (operation === "list") return Object.freeze({ operation });
  if (operation === "cancel" || operation === "remove") {
    return Object.freeze({ operation, taskId: nonEmptyString(candidate.taskId, "scheduler plan taskId", 128) });
  }
  if (operation === "history") {
    const taskId = candidate.taskId === undefined || candidate.taskId === null
      ? undefined
      : nonEmptyString(candidate.taskId, "scheduler plan taskId", 128);
    const limit = candidate.limit === undefined || candidate.limit === null
      ? undefined
      : positiveInteger(candidate.limit, "scheduler plan history limit", MAX_HISTORY);
    return Object.freeze({ operation, ...(taskId === undefined ? {} : { taskId }), ...(limit === undefined ? {} : { limit }) });
  }
  throw new Error("scheduler plan operation must be create, list, cancel, remove, or history");
}

function selectedModel(environment: NodeJS.ProcessEnv = process.env): { provider: string; modelId: string } {
  const provider = environment.FRIDAY_SCHEDULER_PROVIDER?.trim()
    || environment.FRIDAY_ROUTING_PROVIDER?.trim()
    || environment.FRIDAY_MODEL_PROVIDER?.trim();
  const modelId = environment.FRIDAY_SCHEDULER_MODEL_ID?.trim()
    || environment.FRIDAY_ROUTING_MODEL_ID?.trim()
    || environment.FRIDAY_MODEL_ID?.trim();
  if (!provider || !modelId) {
    throw new Error(
      "Scheduler model selection is required: configure a Scheduler, Routing, or main model provider/model pair",
    );
  }
  return { provider, modelId };
}

function plannerSystemPrompt(): string {
  return [
    "You are FRIDAY's scheduler request parser.",
    "Return exactly one JSON object and no prose.",
    "Allowed operations: create, list, cancel, remove, history.",
    "For create, choose exactly one host-supplied actionId and provide only its declared input fields.",
    "Never invent an action id or existing task id.",
    "For relative dates, resolve them from the supplied current time and timezone.",
    "The router may send a clear future commitment or appointment even when the user did not literally ask for a reminder. If the request contains a sufficiently unambiguous future date/time and a channels.reminder action is available, treat that as implicit reminder intent and create one once-scheduled reminder back to the originating conversation.",
    "For an implicit commitment reminder, make input.message concise and event-focused (for example 'Meeting with KKK client.') rather than meta text such as 'You asked me to remind you'.",
    "Never invent a missing date, clock time, or timezone. The router should avoid ambiguous implicit schedules; if the supplied request is still genuinely ambiguous, fail rather than guessing.",
    "Use schedule.kind=once with an ISO timestamp, interval with everyMs and optional startAt, or cron with a five-field expression and IANA timezone.",
    "Use list/history/cancel/remove for scheduler-management requests instead of creating a new task.",
  ].join("\n");
}

export function createSchedulerModelPlanner(models: ModelService): SchedulerTurnPlanner {
  return async (request) => {
    const selected = selectedModel();
    const model = models.getModel(selected.provider as never, selected.modelId as never);
    if (!model) throw new Error(`Unknown scheduler model: ${selected.provider}/${selected.modelId}`);
    const response = await models.completeSimple(
      model,
      {
        systemPrompt: plannerSystemPrompt(),
        messages: [{
          role: "user",
          content: JSON.stringify({
            now: request.now,
            timezone: request.timezone,
            request: request.text,
            actions: request.actions,
            tasks: request.tasks,
            outputShapes: {
              create: { operation: "create", actionId: "host-action-id", input: {}, schedule: { kind: "once", at: "ISO timestamp" }, name: "optional", missedRunPolicy: "coalesce|catch-up|skip" },
              list: { operation: "list" },
              cancel: { operation: "cancel", taskId: "existing-task-id" },
              remove: { operation: "remove", taskId: "existing-task-id" },
              history: { operation: "history", taskId: "optional-existing-task-id", limit: 20 },
            },
          }),
          timestamp: Date.now(),
        }],
      },
      {
        temperature: 0,
        maxTokens: MAX_PLAN_TOKENS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Scheduler model failed: ${response.errorMessage || response.stopReason}`);
    }
    if (response.stopReason === "length") throw new Error("Scheduler model output was truncated");
    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Scheduler model returned no JSON plan");
    return normalizePlan(models.parseJsonWithRepair<unknown>(text));
  };
}

function actionMap(actions: readonly ScheduledActionContribution[]): Map<string, ScheduledActionContribution> {
  const result = new Map<string, ScheduledActionContribution>();
  for (const action of actions) {
    const id = nonEmptyString(action.id, "scheduled action id", 128);
    if (result.has(id)) throw new Error(`Duplicate scheduled action contribution: ${id}`);
    if (typeof action.permission !== "function") {
      throw new Error(`Scheduled action ${id} has no explicit permission declaration`);
    }
    result.set(id, action);
  }
  return result;
}

function envelope(task: ScheduledTask): { actionId: string; payload: JsonValue } {
  const payload = record(task.payload);
  if (!payload || (payload.version !== 1 && payload.version !== 2)) throw new Error(`Scheduled action payload is invalid for task ${task.id}`);
  const actionId = nonEmptyString(payload.actionId, "scheduled action payload actionId", 128);
  assertJsonValue(payload.payload, "scheduled action payload");
  return { actionId, payload: payload.payload as JsonValue };
}

function taskOwnerScope(task: ScheduledTask): string | undefined {
  if (task.taskType !== SCHEDULED_ACTION_TASK_TYPE) return undefined;
  const payload = record(task.payload);
  if (!payload || payload.version !== 2) return undefined;
  const ownerScope = payload.ownerScope;
  if (typeof ownerScope !== "string" || (ownerScope !== "local:operator" && !/^channel:[a-f0-9]{32}$/.test(ownerScope))) {
    throw new Error(`Scheduled action owner scope is invalid for task ${task.id}`);
  }
  return ownerScope;
}

function taskVisibleTo(task: ScheduledTask, origin: PrincipalOrigin): boolean {
  return ownerScopeAllows(taskOwnerScope(task), origin);
}

export function installScheduledActionDispatcher(options: {
  readonly scheduler: SchedulerService;
  readonly permissions: PermissionsTrustedService;
  readonly actions: () => readonly ScheduledActionContribution[];
}): () => void {
  return options.scheduler.registerExecutor(SCHEDULED_ACTION_TASK_TYPE, async (execution) => {
    const stored = envelope(execution.task);
    const action = actionMap(options.actions()).get(stored.actionId);
    if (!action) throw new Error(`Scheduled action is not installed: ${stored.actionId}`);
    await options.permissions.runAsSystem("scheduler", async () => {
      execution.signal?.throwIfAborted();
      await action.execute(stored.payload, {
        task: execution.task,
        run: execution.run,
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
      });
    });
  });
}

function taskActionId(task: ScheduledTask): string | undefined {
  if (task.taskType !== SCHEDULED_ACTION_TASK_TYPE) return undefined;
  try {
    return envelope(task).actionId;
  } catch {
    return undefined;
  }
}

function plannerTasks(tasks: readonly ScheduledTask[]): readonly SchedulerPlannerTask[] {
  return Object.freeze(tasks.slice(0, 100).map((task) => Object.freeze({
    id: task.id,
    name: task.name,
    ...(taskActionId(task) === undefined ? {} : { actionId: taskActionId(task)! }),
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    schedule: Object.freeze({ ...task.schedule }),
  })));
}

function plannerActions(actions: readonly ScheduledActionContribution[]): readonly SchedulerPlannerAction[] {
  return Object.freeze([...actionMap(actions).values()].map((action) => Object.freeze({
    id: action.id,
    label: action.label,
    description: action.description,
    parameters: action.parameters,
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

function defaultTimezone(): string {
  const configured = process.env.FRIDAY_TIMEZONE?.trim();
  return configured || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function authorizeMutation(
  permissions: PermissionsService,
  id: string,
  resource: string,
  reason: string,
): Promise<void> {
  await permissions.authorize({
    mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
    workspace: process.cwd(),
    access: "write",
    action: { id, effect: "system-write", resource, network: false },
    reason,
  });
}

async function authorizePreparedAction(
  permissions: PermissionsService,
  action: ScheduledActionContribution,
  payload: JsonValue,
  context: ScheduledActionPrepareContext,
): Promise<void> {
  const permission = action.permission(payload, context);
  if (!permission || typeof permission !== "object") {
    throw new Error(`Scheduled action ${action.id} returned no permission declaration`);
  }
  await permissions.authorize({
    mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
    workspace: process.cwd(),
    access: permissionEffectAccess(permission.effect),
    action: permission,
    reason: `schedule future action ${action.id}`,
  });
}

function resultText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS - 1)}…`;
}

function createPrepareContext(context: TurnExecutionContext, now: Date, timezone: string): ScheduledActionPrepareContext {
  return Object.freeze({
    origin: Object.freeze({ ...context.turn.principal }),
    requestText: context.turn.text,
    now: now.toISOString(),
    timezone,
  });
}

function exactSchedulerDecision(decision: RoutingDecision): boolean {
  return decision.destination.kind === "scheduler"
    && decision.destination.id === "scheduler"
    && decision.execution.profile === "scheduler";
}

export function createSchedulerTurnExecutor(options: SchedulerTurnExecutorOptions): TurnExecutor {
  const now = options.now ?? (() => new Date());
  const timezone = options.timezone ?? defaultTimezone;

  return Object.freeze({
    id: "scheduler",
    canHandle: exactSchedulerDecision,
    async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
      context.signal?.throwIfAborted();
      const current = now();
      const zone = timezone();
      const actions = options.actions();
      const visibleTasks = (): readonly ScheduledTask[] => options.scheduler.list()
        .filter((task) => taskVisibleTo(task, context.turn.principal));
      const tasks = visibleTasks();
      const plan = await options.planner({
        text: context.turn.text,
        now: current.toISOString(),
        timezone: zone,
        actions: plannerActions(actions),
        tasks: plannerTasks(tasks),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });

      if (plan.operation === "list") {
        const listed = visibleTasks().map((task) => ({
          id: task.id,
          name: task.name,
          actionId: taskActionId(task) ?? null,
          enabled: task.enabled,
          nextRunAt: task.nextRunAt,
          schedule: task.schedule,
          lastStatus: task.lastRun?.status ?? null,
        }));
        return Object.freeze({ text: listed.length === 0 ? "No scheduled tasks." : resultText(listed), metadata: { operation: "list" } });
      }

      if (plan.operation === "history") {
        const limit = plan.limit ?? 20;
        const currentTasks = visibleTasks();
        const history = plan.taskId === undefined
          ? currentTasks
              .flatMap((task) => options.scheduler.history({ taskId: task.id, limit }))
              .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId))
              .slice(0, limit)
          : (() => {
              if (!currentTasks.some((task) => task.id === plan.taskId)) {
                throw new Error(`Unknown scheduled task: ${plan.taskId}`);
              }
              return options.scheduler.history({ taskId: plan.taskId, limit });
            })();
        return Object.freeze({ text: history.length === 0 ? "No scheduler history." : resultText(history), metadata: { operation: "history" } });
      }

      if (plan.operation === "cancel") {
        const task = options.scheduler.get(plan.taskId);
        if (!task || !taskVisibleTo(task, context.turn.principal)) throw new Error(`Unknown scheduled task: ${plan.taskId}`);
        await authorizeMutation(options.permissions, "scheduler.task.cancel", `scheduler:${plan.taskId}`, `cancel scheduled task ${plan.taskId}`);
        const cancelled = options.scheduler.cancel(plan.taskId);
        return Object.freeze({
          text: `Cancelled scheduled task ${cancelled.name} (${cancelled.id}).`,
          metadata: { operation: "cancel", taskId: cancelled.id },
        });
      }

      if (plan.operation === "remove") {
        const task = options.scheduler.get(plan.taskId);
        if (!task || !taskVisibleTo(task, context.turn.principal)) throw new Error(`Unknown scheduled task: ${plan.taskId}`);
        await authorizeMutation(options.permissions, "scheduler.task.remove", `scheduler:${plan.taskId}`, `remove scheduled task ${plan.taskId}`);
        const removed = options.scheduler.remove(plan.taskId);
        if (!removed) throw new Error(`Unknown scheduled task: ${plan.taskId}`);
        return Object.freeze({ text: `Removed scheduled task ${plan.taskId}.`, metadata: { operation: "remove", taskId: plan.taskId } });
      }

      const action = actionMap(actions).get(plan.actionId);
      if (!action) throw new Error(`Scheduler plan selected an unavailable action: ${plan.actionId}`);
      const prepareContext = createPrepareContext(context, current, zone);
      const prepared = action.prepare(plan.input, prepareContext);
      assertJsonValue(prepared, `prepared payload for ${action.id}`);
      await authorizePreparedAction(options.permissions, action, prepared, prepareContext);
      await authorizeMutation(options.permissions, "scheduler.task.create", `scheduler:${action.id}`, `create scheduled ${action.id} task`);
      // Cron is a wall-clock schedule. The host-selected user timezone is authoritative;
      // never let a model-provided zone silently move a recurring task to another locale.
      const schedule = plan.schedule.kind === "cron"
        ? Object.freeze({ ...plan.schedule, timezone: zone })
        : plan.schedule;
      const task = options.scheduler.schedule({
        taskType: SCHEDULED_ACTION_TASK_TYPE,
        payload: {
          version: 2,
          ownerScope: principalScope(context.turn.principal),
          actionId: action.id,
          payload: prepared,
        },
        schedule,
        ...(plan.name === undefined ? {} : { name: plan.name }),
        ...(plan.missedRunPolicy === undefined ? {} : { missedRunPolicy: plan.missedRunPolicy }),
      });
      return Object.freeze({
        text: `Scheduled ${task.name} (${task.id}); next run ${task.nextRunAt}.`,
        metadata: { operation: "create", taskId: task.id, actionId: action.id },
      });
    },
  });
}
