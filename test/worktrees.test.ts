import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import worktreesPlugin from "../plugins/worktrees/index.js";
import { WORKTREES_CAPABILITY } from "../plugins/worktrees/contract.js";

const execFileAsync = promisify(execFile);

afterEach(() => uninstallCapabilityRegistry());

describe("worktrees plugin", () => {
  it("creates, resets, lists, and removes an isolated git worktree through execution", async () => {
    const repository = await mkdtemp(join(tmpdir(), "friday-worktrees-repo-"));
    const root = await mkdtemp(join(tmpdir(), "friday-worktrees-root-"));
    try {
      await execFileAsync("git", ["init"], { cwd: repository });
      await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
      await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
      await writeFile(join(repository, "base.txt"), "base\n");
      await execFileAsync("git", ["add", "base.txt"], { cwd: repository });
      await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });

      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(executionPlugin);
      await friday.activatePlugin(worktreesPlugin);

      const worktrees = requireCapability(WORKTREES_CAPABILITY);
      const candidate = await worktrees.createWorktree({
        repository,
        root,
        name: "candidate",
        detached: true,
      });
      expect(await readFile(join(candidate.directory, "base.txt"), "utf8")).toBe("base\n");
      expect((await worktrees.listWorktrees({ repository })).some((entry) => entry.directory === candidate.directory)).toBe(true);

      await writeFile(join(candidate.directory, "base.txt"), "changed\n");
      await writeFile(join(candidate.directory, "untracked.txt"), "remove me\n");
      await expect(worktrees.resetWorktree({ repository, directory: candidate.directory })).resolves.toBe(true);
      expect(await readFile(join(candidate.directory, "base.txt"), "utf8")).toBe("base\n");

      await expect(worktrees.removeWorktree({ repository, directory: candidate.directory, force: true })).resolves.toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
