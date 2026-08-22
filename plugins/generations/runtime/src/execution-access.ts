import type {
  GenerationsExecutionAccess,
  GenerationsProcessOptions,
  GenerationsProcessResult,
} from "./types.js";

let activeExecutionAccess: GenerationsExecutionAccess | undefined;

export function installExecutionAccess(access: GenerationsExecutionAccess): void {
  activeExecutionAccess = access;
}

export function uninstallExecutionAccess(): void {
  activeExecutionAccess = undefined;
}

export function runProcess(
  command: string,
  args: string[],
  options: GenerationsProcessOptions,
): Promise<GenerationsProcessResult> {
  if (!activeExecutionAccess) {
    throw new Error("Generations execution access is not installed");
  }
  return activeExecutionAccess.runProcess(command, args, options);
}
