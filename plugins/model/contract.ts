import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

/** Public model module exposed through FRIDAY's capability graph. */
export type ModelModule = typeof import("@friday/model");

export interface ModelService {
  readonly api: ModelModule;
}

export const MODEL_CAPABILITY: Capability<ModelService> =
  defineCapability<ModelService>("model");
