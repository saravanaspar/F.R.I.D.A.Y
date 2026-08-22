import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type PromptsModule = typeof import("@friday/prompts");

export interface PromptsService {
  readonly api: PromptsModule;
}

export const PROMPTS_CAPABILITY: Capability<PromptsService> =
  defineCapability<PromptsService>("prompts");
