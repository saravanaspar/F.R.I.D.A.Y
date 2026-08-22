import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

/** Public agent module exposed through FRIDAY's capability graph. */
export type AgentModule = typeof import("@friday/agent");

export interface AgentService {
  readonly api: AgentModule;
}

export const AGENT_CAPABILITY: Capability<AgentService> =
  defineCapability<AgentService>("agent");
