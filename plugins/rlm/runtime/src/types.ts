export interface RlmModel {
  provider: string;
  id: string;
  name?: string;
}

export interface RlmModelMatch {
  provider: string;
  id: string;
  name: string;
  selector: string;
}

export interface RlmSpawnHandle {
  rlm_child_id: string;
  name: string;
  session_dir: string;
  model: string;
}

export type RlmSubagentStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
  rlm_child_id: string;
  active_session_id: string | null;
  session_id: string | null;
  session_name: string;
  session_dir: string;
  status: RlmSubagentStatus;
}

export interface RlmSubagentPortEntry {
  childId: string;
  activeSessionId?: string | null;
  sessionId: string | null;
  name: string;
  sessionDir: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
}

export interface RlmSubagentPort {
  spawn(
    prompt: string,
    options?: { name?: string; model?: string; spawnCode?: string; signal?: AbortSignal },
  ): Promise<{ childId: string; name: string; sessionDir: string; model: string }>;
  list(): RlmSubagentPortEntry[];
  delete(target: string): Promise<RlmSubagentPortEntry>;
}

export interface RlmHostRequestContext {
  readonly requestId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export type RlmHostRequestHandler = (
  payload: Record<string, unknown>,
  context: RlmHostRequestContext,
) => Promise<Record<string, unknown>>;

export type RlmHostRequestHandlers = Record<string, RlmHostRequestHandler>;

export interface CreateRlmHostHandlersOptions {
  subagents: RlmSubagentPort;
  models?: readonly RlmModel[];
}
