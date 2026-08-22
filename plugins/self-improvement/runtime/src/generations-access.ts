import type {
  SelfImprovementGenerationsAccess,
  SelfImprovementGenerationsManager,
} from "./types.js";

let activeAccess: SelfImprovementGenerationsAccess | undefined;

export function installGenerationsAccess(access: SelfImprovementGenerationsAccess): void {
  activeAccess = access;
}

export function uninstallGenerationsAccess(): void {
  activeAccess = undefined;
}

function requireAccess(): SelfImprovementGenerationsAccess {
  if (!activeAccess) throw new Error("Self-improvement generations access is not installed");
  return activeAccess;
}

export function openGenerationsManager(options: {
  repository: string;
  stateDir: string;
}): SelfImprovementGenerationsManager {
  return requireAccess().openManager(options);
}
