import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type RefinementRuntime = typeof import("@friday/refinement");

/** Refinement operations intentionally callable by other plugins. */
export interface RefinementService {
  readonly openMemory: RefinementRuntime["openMemory"];
  readonly applyRefinementProposal: RefinementRuntime["applyRefinementProposal"];
}

export const REFINEMENT_CAPABILITY: Capability<RefinementService> =
  defineCapability<RefinementService>("refinement");
