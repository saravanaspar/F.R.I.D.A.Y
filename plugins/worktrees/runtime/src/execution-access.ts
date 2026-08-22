import type {
  WorktreeExecutionAccess,
  WorktreeProcessOptions,
  WorktreeProcessResult,
} from "./types.js";

let activeExecutionAccess: WorktreeExecutionAccess | undefined;

export function installExecutionAccess(access: WorktreeExecutionAccess): void {
  activeExecutionAccess = access;
}

export function uninstallExecutionAccess(): void {
  activeExecutionAccess = undefined;
}

export function runProcess(
  command: string,
  args: string[],
  options: WorktreeProcessOptions,
): Promise<WorktreeProcessResult> {
  if (!activeExecutionAccess) {
    throw new Error("Worktree execution access is not installed");
  }
  return activeExecutionAccess.runProcess(command, args, options);
}
