import type {
  CandidateEvaluationCheck,
  SelfImprovementEvaluationAccess,
  SelfImprovementEvaluationSuiteResult,
} from "./types.js";

let activeAccess: SelfImprovementEvaluationAccess | undefined;

export function installEvaluationAccess(access: SelfImprovementEvaluationAccess): void {
  activeAccess = access;
}

export function uninstallEvaluationAccess(): void {
  activeAccess = undefined;
}

function requireAccess(): SelfImprovementEvaluationAccess {
  if (!activeAccess) throw new Error("Self-improvement evaluation access is not installed");
  return activeAccess;
}

export function evaluateCandidateChecks(
  specs: readonly CandidateEvaluationCheck[],
  signal?: AbortSignal,
): Promise<SelfImprovementEvaluationSuiteResult> {
  return requireAccess().runCommandEvaluationSuite(specs, signal);
}
