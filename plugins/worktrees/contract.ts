import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type WorktreesRuntime = typeof import("@friday/worktrees");

/** Isolated Git worktree operations used by self-improvement. */
export interface WorktreesService {
  readonly createWorktree: WorktreesRuntime["createWorktree"];
  readonly inspectWorktree: WorktreesRuntime["inspectWorktree"];
  readonly listWorktrees: WorktreesRuntime["listWorktrees"];
  readonly resetWorktree: WorktreesRuntime["resetWorktree"];
  readonly removeWorktree: WorktreesRuntime["removeWorktree"];
  readonly trustedWorktreeReadOnlyMounts: WorktreesRuntime["trustedWorktreeReadOnlyMounts"];
  readonly commitWorktree: WorktreesRuntime["commitWorktree"];
  readonly diffWorktree: WorktreesRuntime["diffWorktree"];
  readonly promoteWorktree: WorktreesRuntime["promoteWorktree"];
}

export const WORKTREES_CAPABILITY: Capability<WorktreesService> =
  defineCapability<WorktreesService>("worktrees");
