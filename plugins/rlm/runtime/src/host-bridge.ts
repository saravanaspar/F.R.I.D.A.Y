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
    "rlm.find_models": createRlmFindModelsHostHandler((query, limit) => findModelMatches(query, models, limit)),
    "rlm.list_subagents": createRlmListSubagentsHostHandler(() => options.subagents.list().map(toRegistryEntry)),
    "rlm.delete_subagent": createRlmDeleteSubagentHostHandler(async (target) =>
      toRegistryEntry(await options.subagents.delete(target)),
    ),
  };
}
