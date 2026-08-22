import type { LifecycleExecutionAccess } from "./types.js";

let executionAccess: LifecycleExecutionAccess | undefined;

export function installExecutionAccess(access: LifecycleExecutionAccess): void {
  executionAccess = Object.freeze({ ...access });
}

export function uninstallExecutionAccess(): void {
  executionAccess = undefined;
}

export function requireExecutionAccess(): LifecycleExecutionAccess {
  if (!executionAccess) {
    throw new Error("Lifecycle execution access is not installed");
  }
  return executionAccess;
}
