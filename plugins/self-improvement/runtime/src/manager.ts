import { randomUUID } from "node:crypto";
import { evaluateCandidateChecks } from "./evaluation-access.js";
import { openGenerationsManager } from "./generations-access.js";
import {
  createEmptySelfImprovementState,
  loadSelfImprovementState,
  saveSelfImprovementState,
} from "./state.js";
import type {
  AbandonCandidateOptions,
  CandidateCheckSpec,
  CandidateEvaluationRun,
  CandidateRecord,
  ClaimGenerationHandoffOptions,
  CompleteGenerationHandoffOptions,
  CreateCandidateOptions,
  FailGenerationHandoffOptions,
  MarkCandidateRolledBackOptions,
  EvaluateCandidateOptions,
  GenerationHandoffRecord,
  PromoteCandidateOptions,
  ReleaseGenerationHandoffOptions,
  SelfImprovementManagerOptions,
  SelfImprovementState,
} from "./types.js";
import {
  createCandidateWorktree,
  inspectCandidateWorktree,
  removeCandidateWorktree,
} from "./worktrees-access.js";

const MAX_ID_ATTEMPTS = 32;
const INTERRUPTED_EVALUATION_MESSAGE = "Candidate evaluation was interrupted before completion";
const INTERRUPTED_HANDOFF_MESSAGE = "Generation handoff was interrupted before completion";

function defaultIdFactory(): string {
  return `cand_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function cloneCandidate(candidate: CandidateRecord): CandidateRecord {
  return structuredClone(candidate);
}

function cloneHandoff(handoff: GenerationHandoffRecord): GenerationHandoffRecord {
  return structuredClone(handoff);
}

function handoffId(candidateId: string, generationId: string): string {
  return `handoff:${candidateId}:${generationId}`;
}

function normalizedText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function cloneCheck(check: CandidateCheckSpec): CandidateCheckSpec {
  return {
    ...(check.id === undefined ? {} : { id: check.id }),
    command: check.command,
    ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
    ...(check.maxOutputChars === undefined ? {} : { maxOutputChars: check.maxOutputChars }),
  };
}

function allChecksPassed(run: CandidateEvaluationRun): boolean {
  return run.summary.total > 0 && run.summary.total === run.results.length && run.summary.passed === run.summary.total;
}

export class SelfImprovementManager {
  private readonly stateDir: string | undefined;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly activeEvaluations = new Set<string>();
  private readonly activePromotions = new Set<string>();
  private state: SelfImprovementState;

  constructor(options: SelfImprovementManagerOptions = {}) {
    this.stateDir = options.stateDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.state = this.stateDir ? loadSelfImprovementState(this.stateDir) : createEmptySelfImprovementState();
    this.recoverInterruptedState();
  }

  getCandidate(id: string): CandidateRecord | undefined {
    const candidate = this.state.candidates[id];
    return candidate ? cloneCandidate(candidate) : undefined;
  }

  listCandidates(): CandidateRecord[] {
    return Object.values(this.state.candidates)
      .map(cloneCandidate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  snapshot(): SelfImprovementState {
    return structuredClone(this.state);
  }

  getGenerationHandoff(id: string): GenerationHandoffRecord | undefined {
    const normalized = normalizedText(id, "Generation handoff id");
    const handoff = this.state.handoffs[normalized];
    return handoff ? cloneHandoff(handoff) : undefined;
  }

  listGenerationHandoffs(): GenerationHandoffRecord[] {
    return Object.values(this.state.handoffs)
      .map(cloneHandoff)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  claimGenerationHandoff(options: ClaimGenerationHandoffOptions): GenerationHandoffRecord | undefined {
    const generationId = normalizedText(options.generationId, "Generation id");
    const matching = Object.values(this.state.handoffs).filter(
      (handoff) => handoff.toGenerationId === generationId && handoff.status !== "completed",
    );
    const resuming = matching.find((handoff) => handoff.status === "resuming");
    if (resuming) {
      throw new Error(`Generation handoff ${resuming.id} is already resuming`);
    }
    const pending = matching.filter((handoff) => handoff.status === "pending");
    if (pending.length === 0) return undefined;
    if (pending.length > 1) {
      throw new Error(`Generation ${generationId} has multiple pending handoffs`);
    }
    const handoff = pending[0]!;
    this.assertHandoffMatchesCandidate(handoff);
    const timestamp = this.now();
    const next: GenerationHandoffRecord = {
      ...handoff,
      status: "resuming",
      updatedAt: timestamp,
      version: handoff.version + 1,
      resumeAttempts: handoff.resumeAttempts + 1,
      claimedAt: timestamp,
      completedAt: undefined,
      lastError: undefined,
    };
    this.replaceHandoff(next);
    return cloneHandoff(next);
  }

  completeGenerationHandoff(options: CompleteGenerationHandoffOptions): GenerationHandoffRecord {
    const handoff = this.requireHandoff(options.id);
    if (handoff.status === "completed") return cloneHandoff(handoff);
    if (handoff.status !== "resuming") {
      throw new Error(`Generation handoff ${handoff.id} must be resuming before completion`);
    }
    this.assertHandoffMatchesCandidate(handoff);
    const timestamp = this.now();
    const next: GenerationHandoffRecord = {
      ...handoff,
      status: "completed",
      updatedAt: timestamp,
      version: handoff.version + 1,
      completedAt: timestamp,
      lastError: undefined,
    };
    this.replaceHandoff(next);
    return cloneHandoff(next);
  }

  releaseGenerationHandoff(options: ReleaseGenerationHandoffOptions): GenerationHandoffRecord {
    const handoff = this.requireHandoff(options.id);
    if (handoff.status !== "resuming") {
      throw new Error(`Generation handoff ${handoff.id} is not currently resuming`);
    }
    const next: GenerationHandoffRecord = {
      ...handoff,
      status: "pending",
      updatedAt: this.now(),
      version: handoff.version + 1,
      completedAt: undefined,
      lastError: options.error === undefined ? undefined : normalizedText(options.error, "Generation handoff error"),
    };
    this.replaceHandoff(next);
    return cloneHandoff(next);
  }

  failGenerationHandoff(options: FailGenerationHandoffOptions): GenerationHandoffRecord {
    const handoff = this.requireHandoff(options.id);
    if (handoff.status === "completed") throw new Error(`Generation handoff ${handoff.id} is already completed`);
    if (handoff.status === "failed") return cloneHandoff(handoff);
    const next: GenerationHandoffRecord = {
      ...handoff,
      status: "failed",
      updatedAt: this.now(),
      version: handoff.version + 1,
      completedAt: undefined,
      lastError: normalizedText(options.error, "Generation handoff error"),
    };
    this.replaceHandoff(next);
    return cloneHandoff(next);
  }

  async createCandidate(options: CreateCandidateOptions): Promise<CandidateRecord> {
    options.signal?.throwIfAborted();
    const objective = normalizedText(options.objective, "Candidate objective");
    const repository = normalizedText(options.repository, "Candidate repository");
    const worktreeRoot = normalizedText(options.worktreeRoot, "Candidate worktree root");
    const id = this.nextCandidateId();

    const worktree = await createCandidateWorktree({
      repository,
      root: worktreeRoot,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let candidate: CandidateRecord | undefined;
    try {
      options.signal?.throwIfAborted();
      const timestamp = this.now();
      candidate = {
        id,
        objective,
        repository,
        worktreeRoot,
        worktreeName: worktree.name,
        directory: worktree.directory,
        baseCommit: worktree.baseCommit,
        branch: worktree.branch,
        status: "created",
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        evaluation: undefined,
        lastError: undefined,
      };
      this.state.candidates[id] = candidate;
      this.persist();
      return cloneCandidate(candidate);
    } catch (error) {
      delete this.state.candidates[id];
      try {
        await removeCandidateWorktree({
          repository,
          directory: worktree.directory,
          force: true,
          deleteBranch: true,
        });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Candidate creation failed and worktree cleanup also failed");
      }
      throw error;
    }
  }

  async evaluateCandidate(options: EvaluateCandidateOptions): Promise<CandidateRecord> {
    options.signal?.throwIfAborted();
    const candidate = this.requireCandidate(options.id);
    if (candidate.status === "abandoned") throw new Error(`Candidate ${candidate.id} is abandoned`);
    if (candidate.status === "promoted") throw new Error(`Candidate ${candidate.id} is already promoted`);
    if (this.activePromotions.has(candidate.id)) throw new Error(`Candidate ${candidate.id} is being promoted`);
    if (candidate.status === "evaluating" || this.activeEvaluations.has(candidate.id)) {
      throw new Error(`Candidate ${candidate.id} is already evaluating`);
    }
    if (options.checks.length === 0) throw new Error("Candidate evaluation requires at least one check");

    this.activeEvaluations.add(candidate.id);
    try {
      const before = await this.inspectCandidate(candidate, options.signal);

      const checks = options.checks.map((check) => {
        const command = normalizedText(check.command, "Evaluation command");
        return {
          ...cloneCheck({ ...check, command }),
          cwd: candidate.directory,
        };
      });

      this.replaceCandidate({
        ...candidate,
        status: "evaluating",
        updatedAt: this.now(),
        version: candidate.version + 1,
        lastError: undefined,
      });

      try {
        const suite = await evaluateCandidateChecks(checks, options.signal);
        options.signal?.throwIfAborted();
        if (suite.results.length !== checks.length || suite.summary.total !== checks.length) {
          throw new Error("Evaluation returned an inconsistent result count");
        }
        const after = await this.inspectCandidate(candidate, options.signal);
        if (after.head !== before.head) {
          throw new Error(`Candidate HEAD changed during evaluation from ${before.head} to ${after.head}`);
        }
        const evaluatedAt = this.now();
        const run: CandidateEvaluationRun = {
          checks: options.checks.map(cloneCheck),
          results: structuredClone(suite.results),
          summary: structuredClone(suite.summary),
          evaluatedAt,
          commit: before.head,
        };
        const current = this.requireCandidate(candidate.id);
        const next: CandidateRecord = {
          ...current,
          status: allChecksPassed(run) ? "passed" : "failed",
          updatedAt: evaluatedAt,
          version: current.version + 1,
          evaluation: run,
          lastError: undefined,
        };
        this.replaceCandidate(next);
        return cloneCandidate(next);
      } catch (error) {
        const current = this.requireCandidate(candidate.id);
        const message = error instanceof Error ? error.message : String(error);
        this.replaceCandidate({
          ...current,
          status: "error",
          updatedAt: this.now(),
          version: current.version + 1,
          lastError: message,
        });
        throw error;
      }
    } finally {
      this.activeEvaluations.delete(candidate.id);
    }
  }

  async promoteCandidate(options: PromoteCandidateOptions): Promise<CandidateRecord> {
    options.signal?.throwIfAborted();
    const candidate = this.requireCandidate(options.id);
    if (candidate.status === "promoted") {
      this.ensureHandoffForPromotedCandidate(candidate);
      return cloneCandidate(candidate);
    }
    if (this.activeEvaluations.has(candidate.id) || candidate.status === "evaluating") {
      throw new Error(`Candidate ${candidate.id} is evaluating`);
    }
    if (this.activePromotions.has(candidate.id)) {
      throw new Error(`Candidate ${candidate.id} is already being promoted`);
    }
    if (candidate.status !== "passed") {
      throw new Error(`Candidate ${candidate.id} must pass evaluation before promotion`);
    }
    const evaluatedCommit = candidate.evaluation?.commit;
    if (!evaluatedCommit) {
      throw new Error(`Candidate ${candidate.id} has no sealed evaluation commit; evaluate it again before promotion`);
    }
    if (evaluatedCommit === candidate.baseCommit) {
      throw new Error(`Candidate ${candidate.id} has no committed change beyond its base`);
    }

    this.activePromotions.add(candidate.id);
    try {
      const generationsStateDir = normalizedText(options.generationsStateDir, "Generations state directory");
      const snapshot = await this.inspectCandidate(candidate, options.signal);
      if (snapshot.head !== evaluatedCommit) {
        throw new Error(
          `Candidate ${candidate.id} changed after evaluation: expected ${evaluatedCommit}, found ${snapshot.head}`,
        );
      }

      const generations = openGenerationsManager({
        repository: candidate.repository,
        stateDir: generationsStateDir,
      });
      if (!generations.getActiveGeneration()) {
        await generations.checkpointCurrent({
          label: `baseline before ${candidate.id}`,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }

      const generation = await generations.activateDescendant({
        targetCommit: evaluatedCommit,
        expectedBaseCommit: candidate.baseCommit,
        label: options.label ?? candidate.objective,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();

      const promotedAt = this.now();
      const current = this.requireCandidate(candidate.id);
      const next: CandidateRecord = {
        ...current,
        status: "promoted",
        updatedAt: promotedAt,
        version: current.version + 1,
        promotedGenerationId: generation.id,
        promotedCommit: generation.commit,
        promotedAt,
        lastError: undefined,
      };
      const handoff = this.createPromotionHandoff(next, generation.parentId);
      try {
        this.replaceCandidateAndHandoff(next, handoff);
      } catch (persistenceError) {
        if (!generation.parentId) {
          throw new AggregateError(
            [persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError))],
            `Candidate ${candidate.id} was activated as ${generation.id}, but self-improvement state persistence failed and no previous generation exists for rollback`,
          );
        }
        try {
          const rollbackPlan = await generations.planRollback({
            targetGenerationId: generation.parentId,
          });
          await generations.executeRollback({ plan: rollbackPlan });
        } catch (rollbackError) {
          throw new AggregateError(
            [
              persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError)),
              rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
            ],
            `Candidate ${candidate.id} activation succeeded, self-improvement state persistence failed, and rollback was incomplete`,
          );
        }
        throw new AggregateError(
          [persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError))],
          `Candidate ${candidate.id} activation was rolled back because self-improvement state persistence failed`,
        );
      }
      return cloneCandidate(next);
    } finally {
      this.activePromotions.delete(candidate.id);
    }
  }

  markCandidateRolledBack(options: MarkCandidateRolledBackOptions): CandidateRecord {
    const candidate = this.requireCandidate(options.id);
    if (candidate.status === "rolled-back") return cloneCandidate(candidate);
    if (candidate.status !== "promoted") {
      throw new Error(`Candidate ${candidate.id} must be promoted before it can be marked rolled back`);
    }
    const next: CandidateRecord = {
      ...candidate,
      status: "rolled-back",
      updatedAt: this.now(),
      version: candidate.version + 1,
      lastError: normalizedText(options.error, "Candidate rollback error"),
    };
    this.replaceCandidate(next);
    return cloneCandidate(next);
  }

  async abandonCandidate(options: AbandonCandidateOptions): Promise<CandidateRecord> {
    options.signal?.throwIfAborted();
    const candidate = this.requireCandidate(options.id);
    if (candidate.status === "evaluating" || this.activeEvaluations.has(candidate.id)) {
      throw new Error(`Candidate ${candidate.id} is evaluating`);
    }
    if (this.activePromotions.has(candidate.id)) throw new Error(`Candidate ${candidate.id} is being promoted`);
    if (candidate.status === "promoted") throw new Error(`Candidate ${candidate.id} is promoted and cannot be abandoned`);
    if (candidate.status === "abandoned") return cloneCandidate(candidate);

    await removeCandidateWorktree({
      repository: candidate.repository,
      directory: candidate.directory,
      force: options.force ?? true,
      deleteBranch: options.deleteBranch ?? true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();

    const next: CandidateRecord = {
      ...candidate,
      status: "abandoned",
      updatedAt: this.now(),
      version: candidate.version + 1,
      lastError: undefined,
    };
    this.replaceCandidate(next);
    return cloneCandidate(next);
  }

  private async inspectCandidate(candidate: CandidateRecord, signal?: AbortSignal): Promise<{ head: string; branch: string | undefined }> {
    const snapshot = await inspectCandidateWorktree({
      repository: candidate.repository,
      directory: candidate.directory,
      ...(signal ? { signal } : {}),
    });
    if (!snapshot.clean) {
      throw new Error(`Candidate ${candidate.id} worktree must be clean and committed before evaluation or promotion`);
    }
    if (candidate.branch !== undefined && snapshot.branch !== candidate.branch) {
      throw new Error(
        `Candidate ${candidate.id} branch changed from ${candidate.branch} to ${snapshot.branch ?? "detached"}`,
      );
    }
    return { head: snapshot.head, branch: snapshot.branch };
  }

  private createPromotionHandoff(
    candidate: CandidateRecord,
    fromGenerationId: string | undefined,
  ): GenerationHandoffRecord {
    const generationId = candidate.promotedGenerationId;
    const commit = candidate.promotedCommit;
    if (!generationId || !commit) {
      throw new Error(`Candidate ${candidate.id} is missing promoted generation metadata`);
    }
    const id = handoffId(candidate.id, generationId);
    const existing = this.state.handoffs[id];
    if (existing) {
      if (
        existing.candidateId !== candidate.id ||
        existing.toGenerationId !== generationId ||
        existing.toCommit !== commit
      ) {
        throw new Error(`Generation handoff ${id} conflicts with promoted candidate metadata`);
      }
      return existing;
    }
    const timestamp = candidate.promotedAt ?? this.now();
    return {
      id,
      candidateId: candidate.id,
      objective: candidate.objective,
      repository: candidate.repository,
      fromGenerationId,
      fromCommit: candidate.baseCommit,
      toGenerationId: generationId,
      toCommit: commit,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      resumeAttempts: 0,
      claimedAt: undefined,
      completedAt: undefined,
      lastError: undefined,
    };
  }

  private ensureHandoffForPromotedCandidate(candidate: CandidateRecord): void {
    if (!candidate.promotedGenerationId || !candidate.promotedCommit) return;
    const id = handoffId(candidate.id, candidate.promotedGenerationId);
    if (this.state.handoffs[id]) return;
    const handoff = this.createPromotionHandoff(candidate, undefined);
    this.replaceHandoff(handoff);
  }

  private assertHandoffMatchesCandidate(handoff: GenerationHandoffRecord): void {
    const candidate = this.state.candidates[handoff.candidateId];
    if (!candidate || candidate.status !== "promoted") {
      throw new Error(`Generation handoff ${handoff.id} does not reference a promoted candidate`);
    }
    if (
      candidate.promotedGenerationId !== handoff.toGenerationId ||
      candidate.promotedCommit !== handoff.toCommit ||
      candidate.objective !== handoff.objective ||
      candidate.repository !== handoff.repository ||
      candidate.baseCommit !== handoff.fromCommit
    ) {
      throw new Error(`Generation handoff ${handoff.id} no longer matches candidate ${candidate.id}`);
    }
  }

  private requireHandoff(id: string): GenerationHandoffRecord {
    const normalized = normalizedText(id, "Generation handoff id");
    const handoff = this.state.handoffs[normalized];
    if (!handoff) throw new Error(`Generation handoff ${normalized} does not exist`);
    return handoff;
  }

  private requireCandidate(id: string): CandidateRecord {
    const normalized = normalizedText(id, "Candidate id");
    const candidate = this.state.candidates[normalized];
    if (!candidate) throw new Error(`Candidate ${normalized} does not exist`);
    return candidate;
  }

  private nextCandidateId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = normalizedText(this.idFactory(), "Candidate id");
      if (!this.state.candidates[id]) return id;
    }
    throw new Error("Failed to allocate a unique candidate id");
  }

  private replaceCandidate(candidate: CandidateRecord): void {
    const previous = this.state.candidates[candidate.id];
    this.state.candidates[candidate.id] = candidate;
    try {
      this.persist();
    } catch (error) {
      if (previous) this.state.candidates[candidate.id] = previous;
      else delete this.state.candidates[candidate.id];
      throw error;
    }
  }

  private replaceHandoff(handoff: GenerationHandoffRecord): void {
    const previous = this.state.handoffs[handoff.id];
    this.state.handoffs[handoff.id] = handoff;
    try {
      this.persist();
    } catch (error) {
      if (previous) this.state.handoffs[handoff.id] = previous;
      else delete this.state.handoffs[handoff.id];
      throw error;
    }
  }

  private replaceCandidateAndHandoff(candidate: CandidateRecord, handoff: GenerationHandoffRecord): void {
    const previousCandidate = this.state.candidates[candidate.id];
    const previousHandoff = this.state.handoffs[handoff.id];
    this.state.candidates[candidate.id] = candidate;
    this.state.handoffs[handoff.id] = handoff;
    try {
      this.persist();
    } catch (error) {
      if (previousCandidate) this.state.candidates[candidate.id] = previousCandidate;
      else delete this.state.candidates[candidate.id];
      if (previousHandoff) this.state.handoffs[handoff.id] = previousHandoff;
      else delete this.state.handoffs[handoff.id];
      throw error;
    }
  }

  private persist(): void {
    if (this.stateDir) saveSelfImprovementState(this.stateDir, this.state);
  }

  private recoverInterruptedState(): void {
    let changed = false;
    let timestamp: string | undefined;
    for (const [id, candidate] of Object.entries(this.state.candidates)) {
      if (candidate.status !== "evaluating") continue;
      this.state.candidates[id] = {
        ...candidate,
        status: "error",
        updatedAt: (timestamp ??= this.now()),
        version: candidate.version + 1,
        lastError: INTERRUPTED_EVALUATION_MESSAGE,
      };
      changed = true;
    }
    for (const [id, handoff] of Object.entries(this.state.handoffs)) {
      if (handoff.status !== "resuming") continue;
      this.state.handoffs[id] = {
        ...handoff,
        status: "pending",
        updatedAt: (timestamp ??= this.now()),
        version: handoff.version + 1,
        completedAt: undefined,
        lastError: INTERRUPTED_HANDOFF_MESSAGE,
      };
      changed = true;
    }
    if (changed) this.persist();
  }
}

export function createSelfImprovementManager(options: SelfImprovementManagerOptions = {}): SelfImprovementManager {
  return new SelfImprovementManager(options);
}
