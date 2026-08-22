import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type EvaluationModule = typeof import("@friday/evaluation");

export interface EvaluationService {
  readonly api: EvaluationModule;
}

export const EVALUATION_CAPABILITY: Capability<EvaluationService> =
  defineCapability<EvaluationService>("evaluation");
