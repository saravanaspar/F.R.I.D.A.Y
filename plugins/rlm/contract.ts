import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type RlmRuntime = typeof import("@friday/rlm");

/** Recursive-language-model host bridge exposed to Turn Loop. */
export interface RlmService {
  readonly createRlmHostHandlers: RlmRuntime["createRlmHostHandlers"];
  readonly getRlmPythonPath: RlmRuntime["getRlmPythonPath"];
}

export const RLM_CAPABILITY: Capability<RlmService> =
  defineCapability<RlmService>("rlm");
