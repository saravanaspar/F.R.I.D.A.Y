import type {
  AutonomyExecutionAccess,
  AutonomyProcessOptions,
  AutonomyProcessResult,
} from "./types.js";

let activeExecutionAccess: AutonomyExecutionAccess | undefined;

export function installExecutionAccess(access: AutonomyExecutionAccess): void {
  activeExecutionAccess = access;
}

export function uninstallExecutionAccess(): void {
  activeExecutionAccess = undefined;
}

export function runProcess(
  command: string,
  args: string[],
  options: AutonomyProcessOptions = {},
): Promise<AutonomyProcessResult> {
  if (!activeExecutionAccess) {
    throw new Error("Autonomy execution access is not installed");
  }
  return activeExecutionAccess.runProcess(command, args, options);
}
