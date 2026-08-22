import type {
  AutonomyEvaluationAccess,
  AutonomyEvaluationOptions,
  AutonomyEvaluationResult,
} from "./types.js";

let activeEvaluationAccess: AutonomyEvaluationAccess | undefined;

export function installEvaluationAccess(access: AutonomyEvaluationAccess): void {
  activeEvaluationAccess = access;
}

export function uninstallEvaluationAccess(): void {
  activeEvaluationAccess = undefined;
}

export function evaluateCommand(
  command: string,
  options: AutonomyEvaluationOptions = {},
): Promise<AutonomyEvaluationResult> {
  if (!activeEvaluationAccess) {
    throw new Error("Autonomy evaluation access is not installed");
  }
  return activeEvaluationAccess.evaluateCommand(command, options);
}
