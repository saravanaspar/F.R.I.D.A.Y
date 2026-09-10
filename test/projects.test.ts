import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { createEventsPlugin } from "../plugins/events/index.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import worktreesPlugin from "../plugins/worktrees/index.js";
import projectsPlugin from "../plugins/projects/index.js";
import { PROJECTS_CAPABILITY } from "../plugins/projects/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const execFileAsync = promisify(execFile);
const originalStateDir = process.env.FRIDAY_STATE_DIR;

afterEach(() => {
  uninstallCapabilityRegistry();
  if (originalStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalStateDir;
});

async function gitRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "friday-project-repo-"));
  await execFileAsync("git", ["init"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
  await writeFile(join(repository, "base.txt"), "base\n");
  await execFileAsync("git", ["add", "base.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  return repository;
}

async function host(): Promise<PluginTestHost> {
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
  await friday.activatePlugin(sessionResourcesPlugin);
  await friday.activatePlugin(executionPlugin);
  await friday.activatePlugin(worktreesPlugin);
  await friday.activatePlugin(projectsPlugin);
  return friday;
}

describe("Phase 3 Projects and Execution Targets", () => {
  it("persists canonical project roots and server-owned target policy across restart", async () => {
    const repository = await gitRepository();
    const state = await mkdtemp(join(tmpdir(), "friday-project-state-"));
    const worktreeRoot = await mkdtemp(join(tmpdir(), "friday-project-worktrees-"));
    process.env.FRIDAY_STATE_DIR = state;
    try {
      const firstHost = await host();
      const first = requireCapability(PROJECTS_CAPABILITY);
      const created = await first.create({
        id: "atlas",
        name: "Atlas",
        rootPath: repository,
        repository: { kind: "git", defaultBranch: "main" },
        policy: {
          defaultTargetId: "sandbox",
          allowedTargetIds: ["sandbox", "core-host"],
          requireWorktreeForWrites: true,
          allowCoreHostWrites: false,
          worktreeRoot,
        },
      });
      expect(created.rootPath).toBe(repository);
      expect((await first.resolveExecution({ projectId: "atlas", operation: "shell", access: "read" })).target.kind).toBe("sandbox");
      await expect(first.resolveExecution({ projectId: "atlas", operation: "edit", access: "write", targetId: "core-host" })).rejects.toThrow(/Core Host writes/);
      await firstHost.dispose();

      const secondHost = await host();
      const second = requireCapability(PROJECTS_CAPABILITY);
      expect(second.get("atlas")).toMatchObject({ id: "atlas", rootPath: repository });
      expect(second.list()).toHaveLength(1);
      await secondHost.dispose();
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("reuses Worktrees for an isolated coding workspace and returns a trusted diff", async () => {
    const repository = await gitRepository();
    const state = await mkdtemp(join(tmpdir(), "friday-project-state-"));
    const worktreeRoot = await mkdtemp(join(tmpdir(), "friday-project-worktrees-"));
    process.env.FRIDAY_STATE_DIR = state;
    try {
      const friday = await host();
      const projects = requireCapability(PROJECTS_CAPABILITY);
      await projects.create({
        id: "atlas",
        name: "Atlas",
        rootPath: repository,
        repository: { kind: "git" },
        policy: { defaultTargetId: "sandbox", allowedTargetIds: ["sandbox"], worktreeRoot },
      });
      const workspace = await projects.createCodingWorkspace({ projectId: "atlas", name: "phase-3-test" });
      expect(workspace.target.kind).toBe("sandbox");
      expect(await readFile(join(workspace.directory, "base.txt"), "utf8")).toBe("base\n");

      await writeFile(join(workspace.directory, "base.txt"), "changed by project workspace\n");
      const diff = await projects.diffCodingWorkspace("atlas", workspace.directory);
      expect(diff.status).toContain("base.txt");
      expect(diff.patch).toContain("-base");
      expect(diff.patch).toContain("+changed by project workspace");

      const committed = await projects.commitCodingWorkspace("atlas", workspace.directory, "test: project workspace");
      expect(committed.changed).toBe(true);
      expect((await projects.inspectCodingWorkspace("atlas", workspace.directory)).clean).toBe(true);
      await projects.removeCodingWorkspace("atlas", workspace.directory, { force: true, deleteBranch: true });
      await friday.dispose();
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("rejects project roots and worktree roots that weaken path isolation", async () => {
    const repository = await gitRepository();
    const state = await mkdtemp(join(tmpdir(), "friday-project-state-"));
    process.env.FRIDAY_STATE_DIR = state;
    try {
      const friday = await host();
      const projects = requireCapability(PROJECTS_CAPABILITY);
      await expect(projects.create({ id: "relative", name: "Relative", rootPath: "./relative" })).rejects.toThrow(/absolute path/);
      await expect(projects.create({
        id: "overlap",
        name: "Overlap",
        rootPath: repository,
        repository: { kind: "git" },
        policy: { worktreeRoot: join(repository, ".friday-worktrees") },
      })).rejects.toThrow(/disjoint/);
      await friday.dispose();
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(state, { recursive: true, force: true });
    }
  });
});
