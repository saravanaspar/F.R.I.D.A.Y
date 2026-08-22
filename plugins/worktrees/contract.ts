import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type WorktreesModule = typeof import("@friday/worktrees");

export interface WorktreesService {
  readonly api: WorktreesModule;
}

export const WORKTREES_CAPABILITY: Capability<WorktreesService> =
  defineCapability<WorktreesService>("worktrees");
