import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { provideCapability, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import evaluationPlugin from "../plugins/evaluation/index.js";
import lifecyclePlugin from "../plugins/lifecycle/index.js";
import worktreesPlugin from "../plugins/worktrees/index.js";
import generationsPlugin from "../plugins/generations/index.js";
import selfImprovementPlugin from "../plugins/self-improvement/index.js";
import { GENERATIONS_CAPABILITY } from "../plugins/generations/contract.js";
import { AUTONOMY_CAPABILITY } from "../plugins/autonomy/contract.js";
import { SELF_IMPROVEMENT_CAPABILITY } from "../plugins/self-improvement/contract.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { createPermissionsService } from "../plugins/permissions/policy.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";


const execFileAsync = promisify(execFile);

afterEach(() => uninstallCapabilityRegistry());

describe("self-improvement plugin", () => {
  it("creates, evaluates, and promotes an isolated committed candidate through capability ports", async () => {
    const repository = await mkdtemp(join(tmpdir(), "friday-self-repo-"));
    const worktreeRoot = await mkdtemp(join(tmpdir(), "friday-self-worktrees-"));
    const stateDir = await mkdtemp(join(tmpdir(), "friday-self-state-"));
    const generationsStateDir = await mkdtemp(join(tmpdir(), "friday-self-generations-"));
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
    provideCapability(PERMISSIONS_CAPABILITY, createPermissionsService({ approve: async () => true }));
    provideCapability(AUTONOMY_CAPABILITY, {} as never);
    provideCapability(MODEL_CAPABILITY, {} as never);
    provideCapability(SANDBOX_CAPABILITY, {
      sandboxKind: "podman",
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) { return { command: request.command, cwd: request.cwd, env: request.env }; },
      sandboxProcess(request) { return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
      sandboxKernel(request) { return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
    });
      await friday.activatePlugin(lifecyclePlugin);
      await friday.activatePlugin(evaluationPlugin);
      await friday.activatePlugin(worktreesPlugin);
      await friday.activatePlugin(generationsPlugin);
      await friday.activatePlugin(selfImprovementPlugin);

      const selfImprovement = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
      const manager = selfImprovement.api.createSelfImprovementManager({ stateDir });
      const candidate = await manager.createCandidate({
        objective: "Promote a verified candidate without mutating the base during evaluation",
        repository,
        worktreeRoot,
        name: "integration-candidate",
      });
      expect(existsSync(candidate.directory)).toBe(true);
      expect(candidate.branch).toBe("friday/integration-candidate");

      await writeFile(join(candidate.directory, "promoted.txt"), "candidate\n");
      await execFileAsync("git", ["add", "promoted.txt"], { cwd: candidate.directory });
      await execFileAsync("git", ["commit", "-m", "candidate"], { cwd: candidate.directory });
      const candidateHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: candidate.directory })).stdout.trim();

      const evaluated = await manager.evaluateCandidate({
        id: candidate.id,
        checks: [
          { id: "base-file", command: "test -f base.txt" },
          { id: "candidate-file", command: "grep -q candidate promoted.txt" },
        ],
      });
      expect(evaluated.status).toBe("passed");
      expect(evaluated.evaluation?.summary.passed).toBe(2);
      expect(evaluated.evaluation?.commit).toBe(candidateHead);
      expect(existsSync(join(repository, "promoted.txt"))).toBe(false);

      const promoted = await manager.promoteCandidate({
        id: candidate.id,
        generationsStateDir,
        label: "integration promotion",
      });
      expect(promoted.status).toBe("promoted");
      expect(promoted.promotedCommit).toBe(candidateHead);
      expect(await readFile(join(repository, "promoted.txt"), "utf8")).toBe("candidate\n");

      const generations = requireCapability(GENERATIONS_CAPABILITY);
      const generationManager = generations.api.createGenerationsManager({ repository, stateDir: generationsStateDir });
      expect(generationManager.getActiveGeneration()?.id).toBe(promoted.promotedGenerationId);
      expect(generationManager.getActiveGeneration()?.commit).toBe(candidateHead);
      expect(generationManager.listGenerations()).toHaveLength(2);

      const reopened = selfImprovement.api.createSelfImprovementManager({ stateDir });
      expect(reopened.getCandidate(candidate.id)?.status).toBe("promoted");
      const [pendingHandoff] = reopened.listGenerationHandoffs();
      expect(pendingHandoff).toMatchObject({
        candidateId: candidate.id,
        objective: "Promote a verified candidate without mutating the base during evaluation",
        fromCommit: candidate.baseCommit,
        toGenerationId: promoted.promotedGenerationId,
        toCommit: candidateHead,
        status: "pending",
        resumeAttempts: 0,
      });

      const claimed = reopened.claimGenerationHandoff({ generationId: promoted.promotedGenerationId! });
      expect(claimed).toMatchObject({ status: "resuming", resumeAttempts: 1 });

      const restarted = selfImprovement.api.createSelfImprovementManager({ stateDir });
      expect(restarted.getGenerationHandoff(claimed!.id)).toMatchObject({
        status: "pending",
        resumeAttempts: 1,
        lastError: "Generation handoff was interrupted before completion",
      });
      const reclaimed = restarted.claimGenerationHandoff({ generationId: promoted.promotedGenerationId! });
      expect(reclaimed).toMatchObject({ status: "resuming", resumeAttempts: 2 });
      expect(restarted.completeGenerationHandoff({ id: reclaimed!.id })).toMatchObject({ status: "completed" });
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
      await rm(generationsStateDir, { recursive: true, force: true });
    }
  });
});
