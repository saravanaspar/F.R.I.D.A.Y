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
import generationsPlugin from "../plugins/generations/index.js";
import { GENERATIONS_CAPABILITY } from "../plugins/generations/contract.js";

const execFileAsync = promisify(execFile);

afterEach(() => uninstallCapabilityRegistry());

describe("generations plugin", () => {
  it("checkpoints clean commits, preserves lineage, and validates rollback plans through execution", async () => {
    const repository = await mkdtemp(join(tmpdir(), "friday-generations-repo-"));
    const stateDir = await mkdtemp(join(tmpdir(), "friday-generations-state-"));
    try {
      await execFileAsync("git", ["init"], { cwd: repository });
      await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
      await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
      await writeFile(join(repository, "generation.txt"), "generation one\n");
      await execFileAsync("git", ["add", "generation.txt"], { cwd: repository });
      await execFileAsync("git", ["commit", "-m", "generation one"], { cwd: repository });

      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(executionPlugin);
      await friday.activatePlugin(generationsPlugin);

      const generations = requireCapability(GENERATIONS_CAPABILITY);
      const manager = generations.createGenerationsManager({ repository, stateDir });
      const first = await manager.checkpointCurrent({ label: "baseline" });
      expect(first.id).toBe("gen-000001");

      await writeFile(join(repository, "generation.txt"), "generation two\n");
      await execFileAsync("git", ["add", "generation.txt"], { cwd: repository });
      await execFileAsync("git", ["commit", "-m", "generation two"], { cwd: repository });
      const second = await manager.checkpointCurrent({ label: "next" });
      expect(second.parentId).toBe(first.id);

      const plan = await manager.planRollback({ targetGenerationId: first.id });
      const validation = await manager.validateRollbackPlan({ plan });
      expect(validation.valid).toBe(true);
      expect(validation.active.id).toBe(second.id);
      expect(validation.target.id).toBe(first.id);

      const rolledBack = await manager.executeRollback({ plan });
      expect(rolledBack.target.id).toBe(first.id);
      expect(manager.getActiveGeneration()?.id).toBe(first.id);
      expect((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()).toBe(first.commit);
      expect(await readFile(join(repository, "generation.txt"), "utf8")).toBe("generation one\n");

      const firstRef = await execFileAsync("git", ["rev-parse", "--verify", first.ref], { cwd: repository });
      expect(firstRef.stdout.trim()).toBe(first.commit);

      const reopened = generations.createGenerationsManager({ repository, stateDir });
      expect(reopened.getActiveGeneration()?.id).toBe(first.id);
      expect(reopened.listRollbackTargets()).toEqual([]);
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  it("activates a verified descendant into the primary checkout and publishes its generation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "friday-generations-activate-repo-"));
    const candidateRoot = await mkdtemp(join(tmpdir(), "friday-generations-activate-worktree-"));
    const stateDir = await mkdtemp(join(tmpdir(), "friday-generations-activate-state-"));
    const candidateDirectory = join(candidateRoot, "candidate");
    try {
      await execFileAsync("git", ["init"], { cwd: repository });
      await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
      await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
      await writeFile(join(repository, "generation.txt"), "baseline\n");
      await execFileAsync("git", ["add", "generation.txt"], { cwd: repository });
      await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: repository });
      const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();

      await execFileAsync("git", ["worktree", "add", "-b", "friday/activation-test", candidateDirectory, baseCommit], { cwd: repository });
      await writeFile(join(candidateDirectory, "activated.txt"), "activated\n");
      await execFileAsync("git", ["add", "activated.txt"], { cwd: candidateDirectory });
      await execFileAsync("git", ["commit", "-m", "candidate"], { cwd: candidateDirectory });
      const candidateCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: candidateDirectory })).stdout.trim();

      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(executionPlugin);
      await friday.activatePlugin(generationsPlugin);

      const generations = requireCapability(GENERATIONS_CAPABILITY);
      const manager = generations.createGenerationsManager({ repository, stateDir });
      const baseline = await manager.checkpointCurrent({ label: "baseline" });
      expect(baseline.commit).toBe(baseCommit);

      const activated = await manager.activateDescendant({
        targetCommit: candidateCommit,
        expectedBaseCommit: baseCommit,
        label: "activation",
      });
      expect(activated.parentId).toBe(baseline.id);
      expect(activated.commit).toBe(candidateCommit);
      expect(manager.getActiveGeneration()?.id).toBe(activated.id);
      expect((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()).toBe(candidateCommit);
      expect(await readFile(join(repository, "activated.txt"), "utf8")).toBe("activated\n");
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(candidateRoot, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

});
