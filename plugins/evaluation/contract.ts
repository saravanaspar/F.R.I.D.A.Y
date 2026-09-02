import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type EvaluationRuntime = typeof import("@friday/evaluation");

/** Deterministic command-gate evaluation used by autonomous and self-improvement flows. */
export interface EvaluationService {
  readonly runCommandEvaluation: EvaluationRuntime["runCommandEvaluation"];
  readonly runCommandEvaluationSuite: EvaluationRuntime["runCommandEvaluationSuite"];
}

export const EVALUATION_CAPABILITY: Capability<EvaluationService> =
  defineCapability<EvaluationService>("evaluation");
