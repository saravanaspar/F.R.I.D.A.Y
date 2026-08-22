import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type SubagentsModule = typeof import("@friday/subagents");

export interface SubagentsService {
  readonly api: SubagentsModule;
}

export const SUBAGENTS_CAPABILITY: Capability<SubagentsService> =
  defineCapability<SubagentsService>("subagents");
