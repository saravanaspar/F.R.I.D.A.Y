import type {
  EvaluationExecutionAccess,
  EvaluationProcessOptions,
  EvaluationProcessResult,
} from "./types.js";

let activeExecutionAccess: EvaluationExecutionAccess | undefined;

export function installExecutionAccess(access: EvaluationExecutionAccess): void {
  activeExecutionAccess = access;
}

export function uninstallExecutionAccess(): void {
  activeExecutionAccess = undefined;
}

export function runProcess(
  command: string,
  args: string[],
  options: EvaluationProcessOptions = {},
): Promise<EvaluationProcessResult> {
  if (!activeExecutionAccess) {
    throw new Error("Evaluation execution access is not installed");
  }
  return activeExecutionAccess.runProcess(command, args, options);
}
