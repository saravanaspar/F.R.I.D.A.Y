import { findModelMatches } from "./subagent-access.js";
import type {
  CreateRlmHostHandlersOptions,
  RlmHostRequestHandler,
  RlmHostRequestHandlers,
  RlmModelMatch,
  RlmSpawnHandle,
  RlmSubagentPortEntry,
  RlmSubagentRegistryEntry,
} from "./types.js";

export interface RlmRunRequest {
  prompt: string;
  kwargs: Record<string, unknown>;
  cellSourceCode?: string;
  signal?: AbortSignal;
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmSpawnHandle>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmModelMatch[] | Promise<RlmModelMatch[]>;
export type RlmListSubagentsHandler = () => RlmSubagentRegistryEntry[] | Promise<RlmSubagentRegistryEntry[]>;
export type RlmDeleteSubagentHandler = (target: string) => RlmSubagentRegistryEntry | Promise<RlmSubagentRegistryEntry>;

export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;
const RLM_SUBAGENT_NAME_MAX_LENGTH = 64;

const MAX_RLM_BATCH_SIZE = 32;
const DEFAULT_RLM_WAIT_TIMEOUT_MS = 30 * 60_000;
const MAX_RLM_WAIT_TIMEOUT_MS = 24 * 60 * 60_000;

function batchTask(value: unknown, index: number): { prompt: string; name?: string; model?: string } {
  if (!isRecord(value) || typeof value.prompt !== "string" || !value.prompt.trim()) {
    throw new Error(`rlm.spawn_many tasks[${index}] must include a non-empty prompt`);
  }
  const name = normalizeOptionalString("name", value.name);
  const model = normalizeOptionalString("model", value.model);
  return { prompt: value.prompt, ...(name === undefined ? {} : { name }), ...(model === undefined ? {} : { model }) };
}

function waitTargets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RLM_BATCH_SIZE) {
    throw new Error(`rlm.wait_subagents targets must contain between 1 and ${MAX_RLM_BATCH_SIZE} entries`);
  }
  return value.map((target, index) => {
    if (typeof target !== "string" || !target.trim()) throw new Error(`rlm.wait_subagents targets[${index}] must be a non-empty string`);
    return target.trim();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(
  key: "name" | "model",
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`rlm.run ${key} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`rlm.run ${key} must not be empty`);
  if (key === "name" && normalized.length > RLM_SUBAGENT_NAME_MAX_LENGTH) {
    throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_NAME_MAX_LENGTH} characters`);
  }
  return normalized;
}

function mapStatus(status: RlmSubagentPortEntry["status"]): RlmSubagentRegistryEntry["status"] {
  if (status === "completed") return "completed";
  if (status === "error" || status === "cancelled") return "error";
  return "running";
}

function toRegistryEntry(entry: RlmSubagentPortEntry): RlmSubagentRegistryEntry {
  return {
    rlm_child_id: entry.childId,
    active_session_id: entry.activeSessionId ?? null,
    session_id: entry.sessionId,
    session_name: entry.name,
    session_dir: entry.sessionDir,
    status: mapStatus(entry.status),
  };
}

export function createRlmRunHostHandler(handler: RlmRunHandler): RlmHostRequestHandler {
  return async (payload, context) => {
    context.signal.throwIfAborted();
    if (typeof payload.prompt !== "string") throw new Error("rlm.run prompt must be a string");
    const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
    const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
    const result = await handler({
      prompt: payload.prompt,
      kwargs,
      ...(cellSourceCode === undefined ? {} : { cellSourceCode }),
      signal: context.signal,
    });
    return { ...result };
  };
}

export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): RlmHostRequestHandler {
  return async (payload, context) => {
    context.signal.throwIfAborted();
    if (typeof payload.query !== "string") throw new Error("rlm.find_models query must be a string");
    const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
      throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
    }
    return { models: await handler(payload.query, limit as number) };
  };
}

export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): RlmHostRequestHandler {
  return async (_payload, context) => {
    context.signal.throwIfAborted();
    return { subagents: await handler() };
  };
}

export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): RlmHostRequestHandler {
  return async (payload, context) => {
    context.signal.throwIfAborted();
    if (typeof payload.target !== "string" || !payload.target.trim()) {
      throw new Error("rlm.delete_subagent target must be a non-empty string");
    }
    return { subagent: await handler(payload.target.trim()) };
  };
}

export function createRlmHostHandlers(options: CreateRlmHostHandlersOptions): RlmHostRequestHandlers {
  const models = options.models ?? [];
  return {
    "rlm.run": createRlmRunHostHandler(async ({ prompt, kwargs, cellSourceCode, signal }) => {
      const unsupportedKwargs = Object.keys(kwargs).filter((key) => key !== "name" && key !== "model");
      if (unsupportedKwargs.length > 0) {
        throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
      }
      const name = normalizeOptionalString("name", kwargs.name);
      const model = normalizeOptionalString("model", kwargs.model);
      const handle = await options.subagents.spawn(prompt, {
        ...(name === undefined ? {} : { name }),
        ...(model === undefined ? {} : { model }),
        ...(cellSourceCode === undefined ? {} : { spawnCode: cellSourceCode }),
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        rlm_child_id: handle.childId,
        name: handle.name,
        session_dir: handle.sessionDir,
        model: handle.model,
      };
    }),
    "rlm.spawn_many": async (payload, context) => {
      context.signal.throwIfAborted();
      if (!Array.isArray(payload.tasks) || payload.tasks.length === 0 || payload.tasks.length > MAX_RLM_BATCH_SIZE) {
        throw new Error(`rlm.spawn_many tasks must contain between 1 and ${MAX_RLM_BATCH_SIZE} entries`);
      }
      const tasks = payload.tasks.map(batchTask);
      const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
      const handles = options.subagents.spawnMany
        ? await options.subagents.spawnMany(tasks, {
            ...(cellSourceCode === undefined ? {} : { spawnCode: cellSourceCode }),
            signal: context.signal,
          })
        : await Promise.all(tasks.map((task) => options.subagents.spawn(task.prompt, {
            ...(task.name === undefined ? {} : { name: task.name }),
            ...(task.model === undefined ? {} : { model: task.model }),
            ...(cellSourceCode === undefined ? {} : { spawnCode: cellSourceCode }),
            signal: context.signal,
          })));
      return {
        subagents: handles.map((handle) => ({
          rlm_child_id: handle.childId,
          name: handle.name,
          session_dir: handle.sessionDir,
          model: handle.model,
        })),
      };
    },
    "rlm.wait_subagents": async (payload, context) => {
      context.signal.throwIfAborted();
      const targets = waitTargets(payload.targets);
      const timeoutMs = payload.timeoutMs === undefined ? DEFAULT_RLM_WAIT_TIMEOUT_MS : payload.timeoutMs;
      if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > MAX_RLM_WAIT_TIMEOUT_MS) {
        throw new Error(`rlm.wait_subagents timeoutMs must be an integer from 1 to ${MAX_RLM_WAIT_TIMEOUT_MS}`);
      }
      if (options.subagents.wait) {
        return { subagents: (await options.subagents.wait(targets, { timeoutMs: timeoutMs as number, signal: context.signal })).map(toRegistryEntry) };
      }
      const deadline = Date.now() + (timeoutMs as number);
      for (;;) {
        context.signal.throwIfAborted();
        const entries = options.subagents.list();
        const resolved = targets.map((target) => entries.find((entry) => entry.childId === target || entry.sessionId === target || entry.name === target));
        if (resolved.some((entry) => entry === undefined)) throw new Error("rlm.wait_subagents target is not a direct child");
        if (resolved.every((entry) => entry && ["completed", "error", "cancelled"].includes(entry.status))) {
          return { subagents: resolved.map((entry) => toRegistryEntry(entry!)) };
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for subagents after ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    "rlm.find_models": createRlmFindModelsHostHandler((query, limit) => findModelMatches(query, models, limit)),
    "rlm.list_subagents": createRlmListSubagentsHostHandler(() => options.subagents.list().map(toRegistryEntry)),
    "rlm.delete_subagent": createRlmDeleteSubagentHostHandler(async (target) =>
      toRegistryEntry(await options.subagents.delete(target)),
    ),
  };
}
