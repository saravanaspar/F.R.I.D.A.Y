import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceMutationCoordinator } from "../plugins/turn-loop/workspace-mutation-coordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceMutationCoordinator", () => {
  it("serializes sibling mutation operations that target the same shared workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-workspace-mutation-"));
    roots.push(root);
    const coordinator = new WorkspaceMutationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run(root, async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    await Promise.resolve();
    const second = coordinator.run(join(root, "."), async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not serialize independent project workspaces and releases the queue after failures", async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), "friday-workspace-a-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "friday-workspace-b-"));
    roots.push(firstWorkspace, secondWorkspace);
    const coordinator = new WorkspaceMutationCoordinator();
    let secondStarted = false;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run(firstWorkspace, async () => { await firstGate; });
    const independent = coordinator.run(secondWorkspace, async () => { secondStarted = true; });
    await independent;
    expect(secondStarted).toBe(true);
    releaseFirst();
    await first;

    await expect(coordinator.run(firstWorkspace, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(coordinator.run(firstWorkspace, async () => "recovered")).resolves.toBe("recovered");
  });
});
