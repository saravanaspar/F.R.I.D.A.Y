import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type RlmModule = typeof import("@friday/rlm");

export interface RlmService {
  readonly api: RlmModule;
}

export const RLM_CAPABILITY: Capability<RlmService> =
  defineCapability<RlmService>("rlm");
