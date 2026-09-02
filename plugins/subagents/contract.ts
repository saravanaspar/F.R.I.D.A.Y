import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type SubagentsRuntime = typeof import("@friday/subagents");

/** Subagent creation, registry persistence, and model selection helpers. */
export interface SubagentsService {
  readonly SubagentManager: SubagentsRuntime["SubagentManager"];
  readonly createSessionSubagentRegistryStore: SubagentsRuntime["createSessionSubagentRegistryStore"];
  readonly findSubagentModelMatches: SubagentsRuntime["findSubagentModelMatches"];
}

export const SUBAGENTS_CAPABILITY: Capability<SubagentsService> =
  defineCapability<SubagentsService>("subagents");
