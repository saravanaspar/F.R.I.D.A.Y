import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type AgentRuntime = typeof import("@friday/agent");

export type AgentEvent = import("@friday/agent").AgentEvent;
export type AgentMessage = import("@friday/agent").AgentMessage;
export type AgentTool = import("@friday/agent").AgentTool;
export type AssistantMessage = import("@friday/agent").AssistantMessage;

/** Public agent construction and retry policy available to FRIDAY plugins. */
export interface AgentService {
  readonly Agent: AgentRuntime["Agent"];
  readonly FRIDAY_MODEL_RETRY_MAX_RETRIES: AgentRuntime["FRIDAY_MODEL_RETRY_MAX_RETRIES"];
}

export const AGENT_CAPABILITY: Capability<AgentService> =
  defineCapability<AgentService>("agent");
