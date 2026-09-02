import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type PromptsRuntime = typeof import("@friday/prompts");

/** Host prompt composition. Consumers receive prompt semantics, not the prompts module. */
export interface PromptsService {
  readonly buildSystemPrompt: PromptsRuntime["buildSystemPrompt"];
  readonly buildSystemPromptPlan: PromptsRuntime["buildSystemPromptPlan"];
}

export const PROMPTS_CAPABILITY: Capability<PromptsService> =
  defineCapability<PromptsService>("prompts");
