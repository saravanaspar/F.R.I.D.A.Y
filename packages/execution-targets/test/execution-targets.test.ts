import { describe, expect, it } from "vitest";
import {
  computerNodeExecutionTarget,
  coreHostExecutionTarget,
  resolveExecutionTarget,
  sandboxExecutionTarget,
} from "../src/index.js";

describe("execution targets", () => {
  it("resolves the project default target and marks writes for worktree isolation", () => {
    const resolved = resolveExecutionTarget(
      [sandboxExecutionTarget(), coreHostExecutionTarget()],
      { defaultTargetId: "sandbox", allowedTargetIds: ["sandbox", "core-host"], requireWorktreeForWrites: true },
      { operation: "edit", access: "write" },
    );
    expect(resolved.target.kind).toBe("sandbox");
    expect(resolved.requiresWorktree).toBe(true);
  });

  it("fails closed for target-policy violations", () => {
    expect(() => resolveExecutionTarget(
      [sandboxExecutionTarget(), coreHostExecutionTarget()],
      { defaultTargetId: "sandbox", allowedTargetIds: ["sandbox"] },
      { operation: "shell", access: "read", requestedTargetId: "core-host" },
    )).toThrow(/not allowed/);
    expect(() => resolveExecutionTarget(
      [coreHostExecutionTarget()],
      { defaultTargetId: "core-host", allowedTargetIds: ["core-host"], allowCoreHostWrites: false },
      { operation: "edit", access: "write" },
    )).toThrow(/Core Host writes/);
  });

  it("represents future computer nodes without coupling to the Computer plugin", () => {
    const target = computerNodeExecutionTarget("desk-1");
    expect(target).toMatchObject({ id: "computer:desk-1", kind: "computer-node", computerNodeId: "desk-1" });
  });
});
