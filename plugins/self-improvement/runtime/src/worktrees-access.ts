import type {
  CandidateWorktreeCreateOptions,
  CandidateWorktreeInfo,
  CandidateWorktreeInspectOptions,
  CandidateWorktreeSnapshot,
  CandidateWorktreeRemoveOptions,
  SelfImprovementWorktreesAccess,
} from "./types.js";

let activeAccess: SelfImprovementWorktreesAccess | undefined;

export function installWorktreesAccess(access: SelfImprovementWorktreesAccess): void {
  activeAccess = access;
}

export function uninstallWorktreesAccess(): void {
  activeAccess = undefined;
}

function requireAccess(): SelfImprovementWorktreesAccess {
  if (!activeAccess) throw new Error("Self-improvement worktrees access is not installed");
  return activeAccess;
}

export function createCandidateWorktree(options: CandidateWorktreeCreateOptions): Promise<CandidateWorktreeInfo> {
  return requireAccess().createWorktree(options);
}

export function inspectCandidateWorktree(options: CandidateWorktreeInspectOptions): Promise<CandidateWorktreeSnapshot> {
  return requireAccess().inspectWorktree(options);
}

export function removeCandidateWorktree(options: CandidateWorktreeRemoveOptions): Promise<boolean> {
  return requireAccess().removeWorktree(options);
}
