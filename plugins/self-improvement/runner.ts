import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { reportOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AutonomyService } from "../autonomy/contract.js";
import type { EvaluationService } from "../evaluation/contract.js";
import type { ExecutionService } from "../execution/contract.js";
import type { GenerationsService } from "../generations/contract.js";
import { lifecycleHandoff, type LifecycleService } from "../lifecycle/contract.js";
import type { SandboxService } from "../sandbox/contract.js";
import type { WorktreesService } from "../worktrees/contract.js";
import type {
  SelfImproveRunOptions,
  SelfImproveRunResult,
  SelfImprovementHandoffOptions,
  SelfImprovementGateSpec,
  SelfImprovementService,
} from "./contract.js";

type SelfImprovementRuntime = typeof import("@friday/self-improvement");

import {
  SelfImprovementMissionStore,
  type SelfImprovementMission,
} from "./mission-state.js";

const DEFAULT_RESTART_TIMEOUT_MS = 30_000;
const DEFAULT_TAKEOVER_TIMEOUT_MS = 30 * 60_000;
const SELF_IMPROVEMENT_AGENT_PROMPT = [
  "You are implementing a self-improvement candidate in an isolated Git worktree. Modify only this worktree. Do not edit .git metadata and do not commit; the host finalizes a verified commit after strict gates pass.",
  "Obey the objective's explicit placement decision. Before editing, search plugins/*/contract.ts and the relevant plugin manifests. Treat those typed contracts as FRIDAY's public reusable API catalog: if a required operation already exists, declare that capability in requires/optional and call it through ctx.services.require/optional instead of duplicating logic or importing sibling runtime implementation. Extend the closest owner's semantic contract only when the operation is genuinely absent. Use an MCP integration for externally supplied tool protocols. Create a new plugin only for a genuinely distinct durable domain boundary. Put code in src/ only for framework-neutral boot, orchestration, lifecycle, or security invariants. Never weaken architecture tests.",
  "For a new connector or integration, define an explicit capability/contribution boundary, lifecycle ownership, configuration/status surface, least-privilege authorization, secret handling through trusted credential/Vault mechanisms, and deterministic tests. The plugin must boot safely while unconfigured and expose an explicit unconfigured/auth-required status; credentials or OAuth/pairing are acquired only after the verified successor is running. Add a test proving unconfigured startup does not crash activation. Never embed credentials or make model-visible chat carry secrets.",
  "Preserve compatibility with existing plugin boundaries. Add tests that prove the new feature, its failure/security cases, and lifecycle cleanup. Do not weaken, skip, delete, or rewrite unrelated tests merely to make gates pass.",
  "Use bash and edit to inspect, implement, test, and repair the objective. Continue until the configured host gates pass.",
].join(" ");

export interface SelfImprovementRunnerDependencies {
  readonly autonomy: AutonomyService;
  readonly evaluation: EvaluationService;
  readonly execution: ExecutionService;
  readonly generations: GenerationsService;
  readonly lifecycle: LifecycleService;
  readonly sandbox: SandboxService;
  readonly worktrees: WorktreesService;
}

export function getSelfImprovementStateRoot(input?: string): string {
  return resolve(input ?? process.env.FRIDAY_STATE_DIR ?? join(homedir(), ".friday"));
}

export function getSelfImprovementMissionDir(root: string): string {
  return join(root, "self-improvement");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferGates(
  repository: string,
  supplied: readonly SelfImprovementGateSpec[] | undefined,
): SelfImprovementGateSpec[] {
  const gates: SelfImprovementGateSpec[] = [
    { id: "diff-check", command: "git diff --check", timeoutMs: 2 * 60_000 },
  ];
  const packagePath = join(repository, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
      if (typeof parsed.scripts?.typecheck === "string") {
        gates.push({ id: "typecheck", command: "npm run typecheck", timeoutMs: 10 * 60_000 });
      }
      if (typeof parsed.scripts?.["check:silent-failures"] === "string") {
        gates.push({ id: "silent-failures", command: "npm run check:silent-failures", timeoutMs: 5 * 60_000 });
      }
      if (typeof parsed.scripts?.["check:models"] === "string") {
        gates.push({ id: "model-catalog", command: "npm run check:models", timeoutMs: 5 * 60_000 });
      }
      if (typeof parsed.scripts?.test === "string") {
        gates.push({ id: "test", command: "npm test", timeoutMs: 20 * 60_000 });
      }
    } catch (error) {
      throw new Error(`Unable to inspect repository scripts at ${packagePath}`, { cause: error });
    }
  }
  for (const gate of supplied ?? []) {
    if (!gates.some((existing) => existing.command === gate.command)) gates.push({ ...gate });
  }
  if (gates.length === 1 && (!supplied || supplied.length === 0)) {
    throw new Error("Autonomous self-improvement requires repository typecheck/test gates or at least one deterministic --gate command");
  }
  return gates;
}

async function runStrictEvaluationCommand(
  evaluation: EvaluationService,
  spec: { readonly id: string; readonly command: string; readonly cwd: string; readonly timeoutMs: number; readonly network?: boolean },
): Promise<void> {
  const suite = await evaluation.runCommandEvaluationSuite([{
    ...spec,
    maxOutputChars: 12_000,
    ...(spec.network === undefined ? {} : { network: spec.network }),
  }]);
  const result = suite.results[0];
  if (!result || result.status !== "pass") {
    throw new Error(`${spec.id} failed${result?.output ? `:\n${result.output}` : ""}`);
  }
}

async function prepareCandidateEnvironment(evaluation: EvaluationService, repository: string): Promise<void> {
  if (!existsSync(join(repository, "package-lock.json"))) {
    throw new Error("Strict self-improvement requires package-lock.json so candidate dependencies are reproducible");
  }
  await runStrictEvaluationCommand(evaluation, {
    id: "candidate-npm-ci",
    command: "npm ci --no-audit --no-fund",
    cwd: repository,
    timeoutMs: 20 * 60_000,
    network: true,
  });
}

async function runSandboxedPromotionCommand(
  execution: ExecutionService,
  sandbox: SandboxService,
  repository: string,
  command: string,
  options: { readonly timeoutMs: number; readonly network: boolean; readonly signal?: AbortSignal },
): Promise<Awaited<ReturnType<ExecutionService["execCommand"]>>> {
  const context = sandbox.sandboxProcess({
    command: "/bin/bash",
    args: ["-lc", command],
    cwd: repository,
    workspace: repository,
    access: "write",
    network: options.network,
    env: process.env,
  });
  const result = await execution.execCommand(context.command, context.args, context.cwd, {
    timeout: options.timeoutMs,
    maxOutputBytes: 16 * 1024 * 1024,
    env: context.env,
    replaceEnv: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.code !== 0 || result.killed || result.outputLimitExceeded) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-12_000);
    throw new Error(`Sandboxed promotion command failed (${command})${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function preparePromotedEnvironment(
  execution: ExecutionService,
  sandbox: SandboxService,
  repository: string,
  signal?: AbortSignal,
): Promise<void> {
  await runSandboxedPromotionCommand(execution, sandbox, repository, "npm ci --no-audit --no-fund", {
    timeoutMs: 20 * 60_000,
    network: true,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function buildPromotedExecutable(
  lifecycle: LifecycleService,
  execution: ExecutionService,
  sandbox: SandboxService,
  repository: string,
  generationId: string,
  commit: string,
  signal?: AbortSignal,
) {
  const sandboxPlatform = await runSandboxedPromotionCommand(
    execution,
    sandbox,
    repository,
    `node -p 'process.platform + ":" + process.arch'`,
    { timeoutMs: 60_000, network: false, ...(signal === undefined ? {} : { signal }) },
  );
  const expectedPlatform = `${process.platform}:${process.arch}`;
  const actualPlatform = sandboxPlatform.stdout.trim();
  if (actualPlatform !== expectedPlatform) {
    throw new Error(
      `Self-improvement binary promotion requires a sandbox build environment matching the F.R.I.D.A.Y host (${expectedPlatform}); got ${actualPlatform || "unknown"}`,
    );
  }

  await preparePromotedEnvironment(execution, sandbox, repository, signal);
  const baseVersion = (process.env.FRIDAY_VERSION?.trim() || "1.0.0-dev").split("+")[0]!;
  const suffix = generationId.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 24) || "generation";
  const buildVersion = `${baseVersion}+self.${suffix}`;
  await runSandboxedPromotionCommand(
    execution,
    sandbox,
    repository,
    `FRIDAY_BUILD_VERSION=${shellQuote(buildVersion)} npm run build:binary`,
    { timeoutMs: 30 * 60_000, network: false, ...(signal === undefined ? {} : { signal }) },
  );
  const built = join(repository, "build", "binary", process.platform === "win32" ? "friday.exe" : "friday");
  if (!existsSync(built)) throw new Error(`Self-improvement binary build did not produce ${built}`);
  return lifecycle.stageFridayExecutable(built, { generationId, commit });
}

async function evaluateRepository(
  evaluation: EvaluationService,
  repository: string,
  gates: readonly SelfImprovementGateSpec[],
): Promise<boolean> {
  const result = await evaluation.runCommandEvaluationSuite(
    gates.map((gate) => ({ ...gate, command: gate.command, cwd: repository })),
  );
  return result.results.length === gates.length
    && result.results.every((entry: { status: string }) => entry.status === "pass");
}

function missionStore(root: string): SelfImprovementMissionStore {
  return new SelfImprovementMissionStore(getSelfImprovementMissionDir(root));
}

async function removeCandidateWorktree(
  selfImprovement: SelfImprovementRuntime,
  worktrees: WorktreesService,
  mission: SelfImprovementMission,
  root: string,
): Promise<string | undefined> {
  const selfManager = selfImprovement.createSelfImprovementManager({ stateDir: getSelfImprovementMissionDir(root) });
  const candidate = selfManager.getCandidate(mission.candidateId);
  if (!candidate) return undefined;
  try {
    await worktrees.removeWorktree({
      repository: mission.repository,
      directory: candidate.directory,
      force: true,
      deleteBranch: true,
    });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

async function rollbackMission(
  selfImprovement: SelfImprovementRuntime,
  dependencies: SelfImprovementRunnerDependencies,
  mission: SelfImprovementMission,
  error: unknown,
  root: string,
): Promise<Error[]> {
  const { generations, worktrees } = dependencies;
  const message = errorMessage(error);
  const manager = generations.createGenerationsManager({
    repository: mission.repository,
    stateDir: join(root, "generations"),
  });

  // Generation rollback is authoritative. Metadata cleanup is best effort after
  // known-good code is active so bookkeeping errors cannot prevent recovery.
  await manager.recoverInterruptedRollback();
  if (!mission.fromGenerationId) {
    throw new Error(`Cannot rollback mission ${mission.id}: no previous generation was recorded`);
  }
  if (manager.getActiveGeneration()?.id !== mission.fromGenerationId) {
    const plan = await manager.planRollback({ targetGenerationId: mission.fromGenerationId });
    await manager.executeRollback({ plan });
  }

  const warnings: Error[] = [];
  let candidate: { id: string; directory: string; status: string } | undefined;
  try {
    const selfManager = selfImprovement.createSelfImprovementManager({ stateDir: getSelfImprovementMissionDir(root) });
    const handoff = selfManager
      .listGenerationHandoffs()
      .find(
        (entry: { candidateId: string; toGenerationId: string; status: string }) =>
          entry.candidateId === mission.candidateId && entry.toGenerationId === mission.targetGenerationId,
      );
    if (handoff && handoff.status !== "failed") {
      try {
        selfManager.failGenerationHandoff({ id: handoff.id, error: message });
      } catch (metadataError) {
        warnings.push(metadataError instanceof Error ? metadataError : new Error(String(metadataError)));
      }
    }
    candidate = selfManager.getCandidate(mission.candidateId) as typeof candidate;
    if (candidate?.status === "promoted") {
      try {
        selfManager.markCandidateRolledBack({ id: candidate.id, error: message });
        candidate = selfManager.getCandidate(mission.candidateId) as typeof candidate;
      } catch (metadataError) {
        warnings.push(metadataError instanceof Error ? metadataError : new Error(String(metadataError)));
      }
    }
  } catch (metadataError) {
    warnings.push(metadataError instanceof Error ? metadataError : new Error(String(metadataError)));
  }

  if (candidate) {
    try {
      await worktrees.removeWorktree({
        repository: mission.repository,
        directory: candidate.directory,
        force: true,
        deleteBranch: true,
      });
    } catch (cleanupError) {
      warnings.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
    }
  }

  if (mission.targetExecutable) {
    try {
      dependencies.lifecycle.removeFridayStagedExecutable(mission.targetExecutable);
    } catch (cleanupError) {
      warnings.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
    }
  }

  const warningText = warnings.length > 0
    ? `; recovery warnings: ${warnings.map((warning) => warning.message).join("; ")}`
    : "";
  try {
    const store = missionStore(root);
    if (store.get(mission.id)) {
      store.update(mission.id, {
        status: "rolled-back",
        updatedAt: new Date().toISOString(),
        lastError: `${message}${warningText}`,
      });
    }
  } catch (stateError) {
    warnings.push(stateError instanceof Error ? stateError : new Error(String(stateError)));
  }
  return warnings;
}

function requireMissionForGeneration(root: string, generationId: string): SelfImprovementMission {
  const mission = missionStore(root).findByGeneration(generationId);
  if (!mission) throw new Error(`No self-improvement mission targets generation ${generationId}`);
  return mission;
}

export function createSelfImprovementRunner(
  selfImprovement: SelfImprovementRuntime,
  dependencies: SelfImprovementRunnerDependencies,
): Pick<
  SelfImprovementService,
  | "selfImprove"
  | "finalizeHandoff"
  | "preflightGenerationResume"
  | "preflightRollbackRecovery"
  | "resumeGeneration"
  | "reportRollbackRecovery"
> {
  const { lifecycle } = dependencies;
  const handoffCoordinator = lifecycleHandoff(lifecycle);
  const runner = {
    async selfImprove(options: SelfImproveRunOptions): Promise<SelfImproveRunResult> {
      const repository = resolve(options.cwd);
      const root = getSelfImprovementStateRoot(options.stateDir);
      const gates = inferGates(repository, options.gates);
      const worktreeRoot = resolve(options.worktreeRoot ?? join(dirname(repository), ".friday-worktrees"));
      const { autonomy, evaluation, execution, lifecycle, sandbox, worktrees } = dependencies;
      const primary = await worktrees.inspectWorktree({ repository, directory: repository });
      if (!primary.clean) throw new Error("Autonomous self-improvement requires a clean primary checkout");

      const selfManager = selfImprovement.createSelfImprovementManager({ stateDir: getSelfImprovementMissionDir(root) });
      const candidate = await selfManager.createCandidate({
        objective: options.objective,
        repository,
        worktreeRoot,
      });
      const unregisterTrustedMounts: Array<() => void> = [];
      let promoted = false;
      try {
        // Candidate dependencies and the private Python kernel are provisioned from
        // the lockfile before the model starts. Re-run this after edits so host
        // gates never depend on stale predecessor dependencies.
        await prepareCandidateEnvironment(evaluation, candidate.directory);
        const trustedMounts = await worktrees.trustedWorktreeReadOnlyMounts({
          repository,
          directory: candidate.directory,
        });
        for (const path of new Set(trustedMounts)) {
          unregisterTrustedMounts.push(
            sandbox.registerTrustedReadOnlyMount(candidate.directory, path),
          );
        }
        const dependencySource = join(repository, "node_modules");
        const dependencyTarget = join(candidate.directory, "node_modules");
        if (existsSync(dependencySource) && !existsSync(dependencyTarget)) {
          mkdirSync(dependencyTarget);
          unregisterTrustedMounts.push(
            sandbox.registerTrustedReadOnlyMount(
              candidate.directory,
              realpathSync(dependencySource),
              dependencyTarget,
            ),
          );
        }

        const agentResult = await autonomy.runObjective({
          ...options,
          cwd: candidate.directory,
          gates,
          stateDir: root,
          additionalSystemPrompt: SELF_IMPROVEMENT_AGENT_PROMPT,
        });
        if (!agentResult.gatesPassed) {
          throw new Error("Autonomous candidate stopped before all configured gates passed");
        }

        await prepareCandidateEnvironment(evaluation, candidate.directory);
        const committed = await worktrees.commitWorktree({
          repository,
          directory: candidate.directory,
          message: `friday: ${options.objective.slice(0, 120)}`,
        });
        if (!committed.changed) throw new Error("Autonomous candidate produced no committed source changes");

        const evaluated = await selfManager.evaluateCandidate({ id: candidate.id, checks: gates });
        if (evaluated.status !== "passed") {
          throw new Error(`Candidate ${candidate.id} failed deterministic evaluation`);
        }
        const promotedCandidate = await selfManager.promoteCandidate({
          id: candidate.id,
          generationsStateDir: join(root, "generations"),
          label: options.objective.slice(0, 240),
        });
        promoted = true;
        const generationId = promotedCandidate.promotedGenerationId;
        const commit = promotedCandidate.promotedCommit;
        if (!generationId || !commit) {
          throw new Error(`Promotion ${candidate.id} did not record generation metadata`);
        }
        const handoff = selfManager
          .listGenerationHandoffs()
          .find(
            (entry) => entry.candidateId === candidate.id && entry.toGenerationId === generationId,
          );
        if (!handoff) throw new Error(`Promotion ${generationId} did not publish a generation handoff`);

        const singleBinary = process.env.FRIDAY_SINGLE_BINARY === "1";
        const previousExecutable = singleBinary
          ? lifecycle.describeFridayExecutable(process.execPath)
          : undefined;
        const targetExecutable = singleBinary
          ? await buildPromotedExecutable(lifecycle, execution, sandbox, repository, generationId, commit, options.signal)
          : undefined;

        const now = new Date().toISOString();
        const mission: SelfImprovementMission = {
          id: candidate.id,
          objective: options.objective,
          repository,
          worktreeRoot,
          provider: options.provider,
          model: options.model,
          permissionMode: options.permissionMode ?? "ask",
          gates,
          status: "restarting",
          candidateId: candidate.id,
          fromGenerationId: handoff.fromGenerationId,
          targetGenerationId: handoff.toGenerationId,
          targetCommit: handoff.toCommit,
          ...(targetExecutable === undefined ? {} : { targetExecutable }),
          ...(previousExecutable === undefined ? {} : { previousExecutable }),
          createdAt: now,
          updatedAt: now,
          lastError: undefined,
          ...(options.continuation === undefined ? {} : { continuation: options.continuation }),
        };

        try {
          missionStore(root).put(mission);
        } catch (missionStateError) {
          let rollbackWarnings: Error[];
          try {
            rollbackWarnings = await rollbackMission(selfImprovement, dependencies, mission, missionStateError, root);
          } catch (rollbackError) {
            throw new AggregateError(
              [
                missionStateError instanceof Error ? missionStateError : new Error(String(missionStateError)),
                rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
              ],
              `Promotion ${generationId} succeeded, mission persistence failed, and generation rollback was incomplete`,
            );
          }
          throw new AggregateError(
            [
              missionStateError instanceof Error ? missionStateError : new Error(String(missionStateError)),
              ...rollbackWarnings,
            ],
            `Promotion ${generationId} was rolled back because the durable self-improvement mission could not be persisted`,
          );
        }

        const lifecycleManager = lifecycle.createLifecycleManager({ stateDir: join(root, "lifecycle") });
        try {
          const restart = await lifecycleManager.launchReplacement({
            ...(mission.targetExecutable === undefined ? {} : { executable: mission.targetExecutable.path }),
            args: ["--resume-generation", generationId, "--state-dir", root, "--permission", mission.permissionMode],
            cwd: repository,
            timeoutMs: options.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS,
          });
          for (const unregister of unregisterTrustedMounts.splice(0)) unregister();
          return {
            candidateId: candidate.id,
            generationId,
            commit,
            restartRequestId: restart.requestId,
          };
        } catch (restartError) {
          const rollbackWarnings = await rollbackMission(selfImprovement, dependencies, mission, restartError, root);
          throw new AggregateError(
            [restartError instanceof Error ? restartError : new Error(String(restartError)), ...rollbackWarnings],
            `Replacement generation ${generationId} failed readiness and was rolled back`,
          );
        }
      } catch (error) {
        for (const unregister of unregisterTrustedMounts.splice(0)) unregister();
        if (!promoted) {
          const current = selfManager.getCandidate(candidate.id);
          if (current && current.status !== "abandoned") {
            try {
              await selfManager.abandonCandidate({ id: candidate.id, force: true, deleteBranch: true });
            } catch (cleanup) {
              throw new AggregateError(
                [
                  error instanceof Error ? error : new Error(String(error)),
                  cleanup instanceof Error ? cleanup : new Error(String(cleanup)),
                ],
                `Self-improvement candidate ${candidate.id} failed and cleanup also failed`,
              );
            }
          }
        }
        throw error;
      }
    },

    async finalizeHandoff(
      result: SelfImproveRunResult,
      options: SelfImprovementHandoffOptions = {},
    ): Promise<void> {
      const root = getSelfImprovementStateRoot(options.stateDir);
      const manager = lifecycle.createLifecycleManager({ stateDir: join(root, "lifecycle") });
      const compatibleManager = manager as typeof manager & {
        releaseForTakeover?: ((requestId: string) => unknown) | undefined;
        retireReplacement?: ((requestId: string, reason?: string) => Promise<unknown>) | undefined;
      };
      const mission = requireMissionForGeneration(root, result.generationId);
      let quiesced = false;
      try {
        // Long self-improvement runs can outlive the set of jobs that existed when
        // they began. Check restart consent at the real ownership-transfer boundary.
        await options.beforeHandoff?.();
        await handoffCoordinator.quiesce();
        quiesced = true;
        compatibleManager.releaseForTakeover?.(result.restartRequestId);
        await manager.waitForTakeover(result.restartRequestId, {
          timeoutMs: options.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (primaryError) {
        const errors: Error[] = [primaryError instanceof Error ? primaryError : new Error(String(primaryError))];
        try {
          if (compatibleManager.retireReplacement) {
            await compatibleManager.retireReplacement(result.restartRequestId, `Self-improvement handoff failed: ${errorMessage(primaryError)}`);
          }
        } catch (retireError) {
          errors.push(retireError instanceof Error ? retireError : new Error(String(retireError)));
        }
        try {
          errors.push(...await rollbackMission(selfImprovement, dependencies, mission, primaryError, root));
        } catch (rollbackError) {
          errors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        }
        if (quiesced) {
          try {
            await handoffCoordinator.resume();
          } catch (resumeError) {
            errors.push(resumeError instanceof Error ? resumeError : new Error(String(resumeError)));
          }
        }
        throw new AggregateError(errors, "Self-improvement takeover failed, was rolled back, and predecessor resources were restored");
      }
    },

    async preflightGenerationResume(generationId: string, explicitStateDir?: string): Promise<void> {
      const root = getSelfImprovementStateRoot(explicitStateDir);
      const mission = requireMissionForGeneration(root, generationId);
      if (mission.status !== "restarting" && mission.status !== "resuming") {
        throw new Error(`Mission ${mission.id} cannot resume from status ${mission.status}`);
      }
      const manager = dependencies.generations.createGenerationsManager({
        repository: mission.repository,
        stateDir: join(root, "generations"),
      });
      await manager.recoverInterruptedRollback();
      const active = manager.getActiveGeneration();
      if (active?.id !== generationId || active.commit !== mission.targetCommit) {
        throw new Error(`Restarted process is not running promoted generation ${generationId}`);
      }
      if (mission.targetExecutable) {
        const running = dependencies.lifecycle.describeFridayExecutable(process.execPath);
        if (running.path !== mission.targetExecutable.path || running.sha256 !== mission.targetExecutable.sha256) {
          throw new Error(`Restarted process is not executing the verified binary for generation ${generationId}`);
        }
      }
      const selfManager = selfImprovement.createSelfImprovementManager({ stateDir: getSelfImprovementMissionDir(root) });
      const handoff = selfManager
        .listGenerationHandoffs()
        .find(
          (entry: { candidateId: string; toGenerationId: string; status: string }) =>
            entry.candidateId === mission.candidateId && entry.toGenerationId === generationId,
        );
      if (!handoff || handoff.status === "completed" || handoff.status === "failed") {
        throw new Error(`No resumable generation handoff exists for ${generationId}`);
      }
    },

    async preflightRollbackRecovery(missionId: string, explicitStateDir?: string): Promise<void> {
      const root = getSelfImprovementStateRoot(explicitStateDir);
      const mission = missionStore(root).get(missionId);
      if (!mission) throw new Error(`Self-improvement mission ${missionId} not found`);
      if (!mission.fromGenerationId) throw new Error(`Mission ${missionId} has no previous generation`);
      const manager = dependencies.generations.createGenerationsManager({
        repository: mission.repository,
        stateDir: join(root, "generations"),
      });
      await manager.recoverInterruptedRollback();
      if (manager.getActiveGeneration()?.id !== mission.fromGenerationId) {
        throw new Error(`Rollback recovery for mission ${mission.id} did not restore its previous generation`);
      }
    },

    async resumeGeneration(generationId: string) {
      const root = getSelfImprovementStateRoot();
      await runner.preflightGenerationResume(generationId, root);
      const mission = requireMissionForGeneration(root, generationId);
      const { generations, lifecycle } = dependencies;
      const manager = generations.createGenerationsManager({
        repository: mission.repository,
        stateDir: join(root, "generations"),
      });
      const selfManager = selfImprovement.createSelfImprovementManager({ stateDir: getSelfImprovementMissionDir(root) });
      const handoff = selfManager.claimGenerationHandoff({ generationId });
      if (!handoff) throw new Error(`No pending generation handoff exists for ${generationId}`);
      missionStore(root).update(mission.id, {
        status: "resuming",
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      });

      try {
        const passed = await evaluateRepository(dependencies.evaluation, mission.repository, mission.gates);
        if (!passed) throw new Error(`Promoted generation ${generationId} failed post-restart verification`);
        await manager.checkpointCurrent();
        if (mission.targetExecutable) {
          lifecycle.activateFridayExecutable(mission.targetExecutable, {
            generationId: mission.targetGenerationId,
            commit: mission.targetCommit,
          });
        }
        selfManager.completeGenerationHandoff({ id: handoff.id });
        const cleanupError = await removeCandidateWorktree(selfImprovement, dependencies.worktrees, mission, root);
        missionStore(root).update(mission.id, {
          status: "completed",
          updatedAt: new Date().toISOString(),
          lastError: cleanupError
            ? `Generation accepted but candidate cleanup failed: ${cleanupError}`
            : undefined,
        });
        return mission.continuation;
      } catch (error) {
        await rollbackMission(selfImprovement, dependencies, mission, error, root);

        let predecessorAlive = false;
        try {
          lifecycle.rejectTakeoverFromEnvironment({ error });
          predecessorAlive = lifecycle.isRestartPredecessorAliveFromEnvironment() === true;
        } catch (contextError) {
          reportOperationalError({ component: "self-improvement", operation: "inspect predecessor during rollback", error: contextError });
          // If restart context cannot be trusted, start a known-good process rather
          // than assuming another process will recover the mission.
        }
        if (predecessorAlive) throw error;

        let rollbackExecutable: string | undefined;
        if (mission.previousExecutable) {
          const verifiedPrevious = lifecycle.describeFridayExecutable(mission.previousExecutable.path);
          if (verifiedPrevious.sha256 !== mission.previousExecutable.sha256) {
            throw new Error("Previous FRIDAY executable changed after self-improvement began; refusing unverified rollback launch");
          }
          rollbackExecutable = verifiedPrevious.path;
        }
        const lifecycleManager = lifecycle.createLifecycleManager({ stateDir: join(root, "lifecycle") });
        const recovery = await lifecycleManager.launchReplacement({
          ...(rollbackExecutable === undefined ? {} : { executable: rollbackExecutable }),
          args: ["--rollback-recovered", mission.id, "--state-dir", root, "--permission", mission.permissionMode],
          cwd: mission.repository,
          timeoutMs: DEFAULT_RESTART_TIMEOUT_MS,
        });
        lifecycleManager.releaseForTakeover(recovery.requestId);
        await lifecycleManager.waitForTakeover(recovery.requestId, {
          timeoutMs: DEFAULT_RESTART_TIMEOUT_MS,
        });
        return undefined;
      }
    },

    async reportRollbackRecovery(missionId: string): Promise<void> {
      const root = getSelfImprovementStateRoot();
      await runner.preflightRollbackRecovery(missionId, root);
    },
  } satisfies Pick<
    SelfImprovementService,
    | "selfImprove"
    | "finalizeHandoff"
    | "preflightGenerationResume"
    | "preflightRollbackRecovery"
    | "resumeGeneration"
    | "reportRollbackRecovery"
  >;

  return Object.freeze(runner);
}
