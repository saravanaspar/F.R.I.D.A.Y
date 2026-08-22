import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type RefinementModule = typeof import("@friday/refinement");

export interface RefinementService {
  readonly api: RefinementModule;
}

export const REFINEMENT_CAPABILITY: Capability<RefinementService> =
  defineCapability<RefinementService>("refinement");
