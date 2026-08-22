import type { RefinementMemoryPort, RefinementScope } from "./types.js";

export interface RefinementMemoryAccess {
  open(stateDir: string, scope: RefinementScope): RefinementMemoryPort;
}

let activeMemoryAccess: RefinementMemoryAccess | undefined;

export function installMemoryAccess(access: RefinementMemoryAccess): void {
  activeMemoryAccess = access;
}

export function uninstallMemoryAccess(): void {
  activeMemoryAccess = undefined;
}

export function openMemory(stateDir: string, scope: RefinementScope): RefinementMemoryPort {
  if (!activeMemoryAccess) throw new Error("Refinement memory access is not installed");
  return activeMemoryAccess.open(stateDir, scope);
}
