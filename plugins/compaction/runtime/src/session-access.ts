import type { CompactionSessionPort } from "./types.js";

export interface CompactionSessionAccess {
  open(path: string, cwdOverride?: string): CompactionSessionPort;
}

let activeSessionAccess: CompactionSessionAccess | undefined;

export function installSessionAccess(access: CompactionSessionAccess): void {
  activeSessionAccess = access;
}

export function uninstallSessionAccess(): void {
  activeSessionAccess = undefined;
}

export function openSession(path: string, cwdOverride?: string): CompactionSessionPort {
  if (!activeSessionAccess) {
    throw new Error("Compaction session access is not installed");
  }
  return activeSessionAccess.open(path, cwdOverride);
}
