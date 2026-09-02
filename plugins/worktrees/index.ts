import * as worktrees from "@friday/worktrees";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { WORKTREES_CAPABILITY, type WorktreesService } from "./contract.js";

const worktreesPlugin: FridayPlugin = definePlugin({ id: "worktrees", requires: [EXECUTION_CAPABILITY], provides: [WORKTREES_CAPABILITY] }, (ctx) => {
  const execution = ctx.services.require(EXECUTION_CAPABILITY);

  worktrees.installExecutionAccess({
    async runProcess(command, args, options) {
      options.signal?.throwIfAborted();
      try {
        const result = await execution.execCommand(command, args, options.cwd, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        });
        options.signal?.throwIfAborted();
        return {
          status: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          killed: result.killed,
        };
      } catch (error) {
        options.signal?.throwIfAborted();
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  });

  const service: WorktreesService = Object.freeze({
    createWorktree: worktrees.createWorktree,
    inspectWorktree: worktrees.inspectWorktree,
    listWorktrees: worktrees.listWorktrees,
    resetWorktree: worktrees.resetWorktree,
    removeWorktree: worktrees.removeWorktree,
    trustedWorktreeReadOnlyMounts: worktrees.trustedWorktreeReadOnlyMounts,
    commitWorktree: worktrees.commitWorktree,
  });
  ctx.services.provide(WORKTREES_CAPABILITY, service);
});

export default worktreesPlugin;
