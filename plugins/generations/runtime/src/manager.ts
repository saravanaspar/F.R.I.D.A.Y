import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { GenerationsConflictError, GenerationsRepositoryError } from "./errors.js";
import {
  assertCleanRepository,
  assertRepositoryRoot,
  createPinnedRef,
  deletePinnedRef,
  fastForwardHead,
  isAncestor,
  resolveHeadCommit,
  resolveRefCommit,
  restoreHead,
} from "./git.js";
import {
  createEmptyGenerationsState,
  loadGenerationsState,
  saveGenerationsState,
} from "./state.js";
import {
  loadRollbackTransaction,
  removeRollbackTransaction,
  saveRollbackTransaction,
} from "./rollback-state.js";
import type {
  ActivateDescendantOptions,
  CheckpointGenerationOptions,
  ExecuteRollbackOptions,
  GenerationRecord,
  GenerationsManagerOptions,
  GenerationsState,
  PlanRollbackOptions,
  RollbackExecutionResult,
  RollbackPlan,
  RollbackPlanValidation,
  RollbackTransaction,
  ValidateRollbackPlanOptions,
} from "./types.js";

const GENERATION_REF_PREFIX = "refs/friday/generations";
const MAX_LABEL_LENGTH = 240;

function cloneGeneration(generation: GenerationRecord): GenerationRecord {
  return structuredClone(generation);
}

function cloneState(state: GenerationsState): GenerationsState {
  return structuredClone(state);
}

function normalizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_LABEL_LENGTH);
}

function generationId(sequence: number): string {
  return `gen-${String(sequence).padStart(6, "0")}`;
}

function generationRef(id: string): string {
  return `${GENERATION_REF_PREFIX}/${id}`;
}

function sameRollbackPlan(left: RollbackPlan, right: RollbackPlan): boolean {
  return left.activeGenerationId === right.activeGenerationId
    && left.targetGenerationId === right.targetGenerationId
    && left.expectedHeadCommit === right.expectedHeadCommit
    && left.targetCommit === right.targetCommit
    && left.targetRef === right.targetRef
    && left.plannedAt === right.plannedAt;
}

export class GenerationsManager {
  readonly repository: string;
  readonly stateDir: string;
  readonly now: () => string;
  private state: GenerationsState;

  constructor(options: GenerationsManagerOptions) {
    const repository = options.repository.trim();
    const stateDir = options.stateDir.trim();
    if (!repository) throw new Error("Generations manager requires a repository");
    if (!stateDir) throw new Error("Generations manager requires a state directory");
    this.repository = resolve(repository);
    this.stateDir = resolve(stateDir);
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = loadGenerationsState(this.stateDir);

    for (const generation of Object.values(this.state.generations)) {
      if (resolve(generation.repository) !== this.repository) {
        throw new GenerationsConflictError(
          `generation ${generation.id} belongs to ${generation.repository}, not ${this.repository}`,
        );
      }
    }
  }

  getState(): GenerationsState {
    return cloneState(this.state);
  }

  getGeneration(id: string): GenerationRecord | undefined {
    const generation = this.state.generations[id];
    return generation ? cloneGeneration(generation) : undefined;
  }

  getActiveGeneration(): GenerationRecord | undefined {
    const id = this.state.activeGenerationId;
    if (!id) return undefined;
    const generation = this.state.generations[id];
    return generation ? cloneGeneration(generation) : undefined;
  }

  listGenerations(): GenerationRecord[] {
    return Object.values(this.state.generations)
      .map(cloneGeneration)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }

  listRollbackTargets(): GenerationRecord[] {
    const activeId = this.state.activeGenerationId;
    if (!activeId) return [];
    const targets: GenerationRecord[] = [];
    let current = this.state.generations[activeId];
    while (current?.parentId) {
      const parent = this.state.generations[current.parentId];
      if (!parent) break;
      targets.push(cloneGeneration(parent));
      current = parent;
    }
    return targets;
  }

  async checkpointCurrent(options: CheckpointGenerationOptions = {}): Promise<GenerationRecord> {
    options.signal?.throwIfAborted();
    await assertRepositoryRoot(this.repository, options.signal);
    await assertCleanRepository(this.repository, options.signal);
    const commit = await resolveHeadCommit(this.repository, options.signal);
    options.signal?.throwIfAborted();

    const active = this.getActiveGeneration();
    if (active) {
      const resolvedRef = await resolveRefCommit(this.repository, active.ref, options.signal);
      if (resolvedRef !== active.commit) {
        throw new GenerationsConflictError(
          `active generation ${active.id} is not pinned to its recorded commit`,
        );
      }
      if (active.commit === commit) return active;
    }

    const existing = Object.values(this.state.generations).find((generation) => generation.commit === commit);
    if (existing) {
      throw new GenerationsConflictError(
        `commit ${commit} is already recorded as generation ${existing.id}; use the rollback activation flow instead of creating a duplicate generation`,
      );
    }

    if (active) {
      const descendant = await isAncestor(this.repository, active.commit, commit, options.signal);
      if (!descendant) {
        throw new GenerationsConflictError(
          `repository HEAD ${commit} is not a descendant of active generation ${active.id}; promotion or rollback must activate divergent history explicitly`,
        );
      }
    }

    const slot = await this.allocateGenerationSlot(options.signal);
    const generation: GenerationRecord = {
      id: slot.id,
      sequence: slot.sequence,
      repository: this.repository,
      commit,
      ref: slot.ref,
      parentId: active?.id,
      label: normalizeLabel(options.label),
      createdAt: this.now(),
    };

    options.signal?.throwIfAborted();
    await createPinnedRef(this.repository, generation.ref, commit);

    const previousState = this.state;
    const nextState: GenerationsState = {
      schema: 1,
      nextSequence: generation.sequence + 1,
      activeGenerationId: generation.id,
      generations: {
        ...previousState.generations,
        [generation.id]: generation,
      },
    };

    try {
      options.signal?.throwIfAborted();
      await assertCleanRepository(this.repository, options.signal);
      const confirmedHead = await resolveHeadCommit(this.repository, options.signal);
      if (confirmedHead !== commit) {
        throw new GenerationsConflictError(
          `repository HEAD changed from ${commit} to ${confirmedHead} while checkpoint ${generation.id} was being prepared`,
        );
      }
      saveGenerationsState(this.stateDir, nextState);
      this.state = nextState;
    } catch (error) {
      try {
        // Cleanup must not reuse an aborted caller signal or a cancellation could
        // strand a pinned ref that was never published in generation state.
        await deletePinnedRef(this.repository, generation.ref, commit);
      } catch (cleanupError) {
        throw new GenerationsRepositoryError(
          `failed to persist generation checkpoint (${error instanceof Error ? error.message : String(error)}); cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
        );
      }
      throw error;
    }

    return cloneGeneration(generation);
  }

  async activateDescendant(options: ActivateDescendantOptions): Promise<GenerationRecord> {
    options.signal?.throwIfAborted();
    const targetInput = options.targetCommit.trim();
    const expectedBaseCommit = options.expectedBaseCommit.trim();
    if (!targetInput) throw new Error("Generation activation requires a target commit");
    if (!expectedBaseCommit) throw new Error("Generation activation requires an expected base commit");

    await assertRepositoryRoot(this.repository, options.signal);
    await assertCleanRepository(this.repository, options.signal);

    const active = this.getActiveGeneration();
    if (!active) {
      throw new GenerationsConflictError("Generation activation requires an active baseline generation");
    }
    const activeRefCommit = await resolveRefCommit(this.repository, active.ref, options.signal);
    if (activeRefCommit !== active.commit) {
      throw new GenerationsConflictError(
        `active generation ${active.id} is not pinned to its recorded commit`,
      );
    }

    const targetCommit = await resolveRefCommit(this.repository, targetInput, options.signal);
    if (!targetCommit) {
      throw new GenerationsConflictError(`activation target ${targetInput} does not resolve to a commit`);
    }
    const head = await resolveHeadCommit(this.repository, options.signal);

    if (active.commit === targetCommit) {
      if (head !== active.commit) {
        throw new GenerationsConflictError(
          `repository HEAD ${head} does not match active generation ${active.id} at ${active.commit}`,
        );
      }
      const parent = active.parentId ? this.state.generations[active.parentId] : undefined;
      if (parent?.commit === expectedBaseCommit) return active;
      throw new GenerationsConflictError(
        `active generation ${active.id} is already at ${targetCommit}, but its parent does not match expected base ${expectedBaseCommit}`,
      );
    }

    if (active.commit !== expectedBaseCommit) {
      throw new GenerationsConflictError(
        `active generation ${active.id} is ${active.commit}, not candidate base ${expectedBaseCommit}`,
      );
    }

    const existing = Object.values(this.state.generations).find((generation) => generation.commit === targetCommit);
    if (existing) {
      throw new GenerationsConflictError(
        `commit ${targetCommit} is already recorded as generation ${existing.id}; use rollback activation instead`,
      );
    }

    const descendant = await isAncestor(this.repository, active.commit, targetCommit, options.signal);
    if (!descendant) {
      throw new GenerationsConflictError(
        `activation target ${targetCommit} is not a descendant of active generation ${active.id}`,
      );
    }

    const slot = await this.allocateActivationSlot(targetCommit, options.signal);
    if (head !== active.commit && !(head === targetCommit && slot.reusedPin)) {
      throw new GenerationsConflictError(
        `repository HEAD ${head} does not match active generation ${active.id} at ${active.commit}`,
      );
    }

    const generation: GenerationRecord = {
      id: slot.id,
      sequence: slot.sequence,
      repository: this.repository,
      commit: targetCommit,
      ref: slot.ref,
      parentId: active.id,
      label: normalizeLabel(options.label),
      createdAt: this.now(),
    };

    options.signal?.throwIfAborted();
    if (!slot.reusedPin) {
      await createPinnedRef(this.repository, generation.ref, targetCommit, options.signal);
    }

    const nextState: GenerationsState = {
      schema: 1,
      nextSequence: generation.sequence + 1,
      activeGenerationId: generation.id,
      generations: {
        ...this.state.generations,
        [generation.id]: generation,
      },
    };

    try {
      options.signal?.throwIfAborted();
      if (head === active.commit) {
        await fastForwardHead(this.repository, active.commit, targetCommit, options.signal);
      } else {
        const pendingRefCommit = await resolveRefCommit(this.repository, generation.ref, options.signal);
        if (pendingRefCommit !== targetCommit) {
          throw new GenerationsConflictError(
            `interrupted activation pin ${generation.ref} no longer resolves to ${targetCommit}`,
          );
        }
      }
      options.signal?.throwIfAborted();
      await assertCleanRepository(this.repository, options.signal);
      const confirmedHead = await resolveHeadCommit(this.repository, options.signal);
      if (confirmedHead !== targetCommit) {
        throw new GenerationsConflictError(
          `repository activation ended at ${confirmedHead}, expected ${targetCommit}`,
        );
      }
      saveGenerationsState(this.stateDir, nextState);
      this.state = nextState;
    } catch (error) {
      const cleanupErrors: Error[] = [];
      try {
        const currentHead = await resolveHeadCommit(this.repository);
        if (currentHead === targetCommit) {
          await restoreHead(this.repository, targetCommit, active.commit);
        } else if (currentHead !== active.commit) {
          cleanupErrors.push(
            new GenerationsRepositoryError(
              `activation cleanup found unexpected repository HEAD ${currentHead}; expected ${active.commit} or ${targetCommit}`,
            ),
          );
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
      try {
        await deletePinnedRef(this.repository, generation.ref, targetCommit);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error instanceof Error ? error : new Error(String(error)), ...cleanupErrors],
          "Generation activation failed and cleanup was incomplete",
        );
      }
      throw error;
    }

    return cloneGeneration(generation);
  }

  async verifyGeneration(id: string, signal?: AbortSignal): Promise<GenerationRecord> {
    signal?.throwIfAborted();
    await assertRepositoryRoot(this.repository, signal);
    const generation = this.state.generations[id];
    if (!generation) throw new Error(`Generation ${id} not found`);
    const commit = await resolveRefCommit(this.repository, generation.ref, signal);
    if (commit !== generation.commit) {
      throw new GenerationsConflictError(
        `generation ${id} ref does not resolve to recorded commit ${generation.commit}`,
      );
    }
    return cloneGeneration(generation);
  }

  async planRollback(options: PlanRollbackOptions): Promise<RollbackPlan> {
    options.signal?.throwIfAborted();
    await assertRepositoryRoot(this.repository, options.signal);
    const activeId = this.state.activeGenerationId;
    if (!activeId) throw new Error("No active generation exists");
    const target = this.state.generations[options.targetGenerationId];
    if (!target) throw new Error(`Generation ${options.targetGenerationId} not found`);
    if (target.id === activeId) {
      throw new GenerationsConflictError(`Generation ${target.id} is already active`);
    }

    const rollbackTargets = new Set(this.listRollbackTargets().map((generation) => generation.id));
    if (!rollbackTargets.has(target.id)) {
      throw new GenerationsConflictError(
        `generation ${target.id} is not in the active generation lineage`,
      );
    }

    const active = this.state.generations[activeId];
    if (!active) throw new GenerationsConflictError(`Active generation ${activeId} is missing`);
    const activeRefCommit = await resolveRefCommit(this.repository, active.ref, options.signal);
    if (activeRefCommit !== active.commit) {
      throw new GenerationsConflictError(
        `active generation ${active.id} is not pinned to its recorded commit`,
      );
    }
    const head = await resolveHeadCommit(this.repository, options.signal);
    if (head !== active.commit) {
      throw new GenerationsConflictError(
        `repository HEAD ${head} does not match active generation ${active.id} at ${active.commit}`,
      );
    }
    const targetRefCommit = await resolveRefCommit(this.repository, target.ref, options.signal);
    if (targetRefCommit !== target.commit) {
      throw new GenerationsConflictError(
        `rollback target ${target.id} is not pinned to its recorded commit`,
      );
    }

    return {
      activeGenerationId: active.id,
      targetGenerationId: target.id,
      expectedHeadCommit: active.commit,
      targetCommit: target.commit,
      targetRef: target.ref,
      plannedAt: this.now(),
    };
  }

  async validateRollbackPlan(
    options: ValidateRollbackPlanOptions,
  ): Promise<RollbackPlanValidation> {
    options.signal?.throwIfAborted();
    await assertRepositoryRoot(this.repository, options.signal);
    const { plan } = options;
    const active = this.state.generations[plan.activeGenerationId];
    const target = this.state.generations[plan.targetGenerationId];
    if (!active || this.state.activeGenerationId !== active.id) {
      throw new GenerationsConflictError("rollback plan is stale because the active generation changed");
    }
    if (!target) {
      throw new GenerationsConflictError("rollback plan is stale because the target generation is missing");
    }
    if (
      active.commit !== plan.expectedHeadCommit ||
      target.commit !== plan.targetCommit ||
      target.ref !== plan.targetRef
    ) {
      throw new GenerationsConflictError("rollback plan no longer matches generation history");
    }

    const rollbackTargets = new Set(this.listRollbackTargets().map((generation) => generation.id));
    if (!rollbackTargets.has(target.id)) {
      throw new GenerationsConflictError("rollback plan target is no longer in the active generation lineage");
    }

    const activeRefCommit = await resolveRefCommit(this.repository, active.ref, options.signal);
    if (activeRefCommit !== active.commit) {
      throw new GenerationsConflictError("rollback plan is stale because the active generation pin changed");
    }
    const head = await resolveHeadCommit(this.repository, options.signal);
    if (head !== plan.expectedHeadCommit) {
      throw new GenerationsConflictError("rollback plan is stale because repository HEAD changed");
    }
    const targetRefCommit = await resolveRefCommit(this.repository, target.ref, options.signal);
    if (targetRefCommit !== target.commit) {
      throw new GenerationsConflictError("rollback plan is stale because the target ref changed");
    }

    return { valid: true, active: cloneGeneration(active), target: cloneGeneration(target) };
  }

  async recoverInterruptedRollback(signal?: AbortSignal): Promise<RollbackExecutionResult | undefined> {
    signal?.throwIfAborted();
    const transaction = loadRollbackTransaction(this.stateDir);
    if (!transaction) return undefined;
    return this.resumeRollbackTransaction(transaction, true, signal);
  }

  async executeRollback(options: ExecuteRollbackOptions): Promise<RollbackExecutionResult> {
    options.signal?.throwIfAborted();
    const existing = loadRollbackTransaction(this.stateDir);
    if (existing) {
      if (!sameRollbackPlan(existing.plan, options.plan)) {
        throw new GenerationsConflictError(
          `rollback transaction ${existing.id} is already pending for ${existing.plan.targetGenerationId}`,
        );
      }
      return this.resumeRollbackTransaction(existing, true, options.signal);
    }

    const validation = await this.validateRollbackPlan({
      plan: options.plan,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await assertCleanRepository(this.repository, options.signal);
    options.signal?.throwIfAborted();

    const timestamp = this.now();
    const transaction: RollbackTransaction = {
      schema: 1,
      id: `rollback-${randomUUID()}`,
      phase: "prepared",
      plan: structuredClone(options.plan),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveRollbackTransaction(this.stateDir, transaction);

    // Once the journal is published, complete the transaction without honoring
    // later cancellation. This keeps repository HEAD and durable state atomic.
    return this.resumeRollbackTransaction(transaction, false, undefined, validation);
  }

  private async resumeRollbackTransaction(
    transaction: RollbackTransaction,
    recovered: boolean,
    signal?: AbortSignal,
    initialValidation?: RollbackPlanValidation,
  ): Promise<RollbackExecutionResult> {
    signal?.throwIfAborted();
    await assertRepositoryRoot(this.repository, signal);
    await assertCleanRepository(this.repository, signal);

    const plan = transaction.plan;
    const active = this.state.generations[plan.activeGenerationId];
    const target = this.state.generations[plan.targetGenerationId];
    if (!active || !target) {
      throw new GenerationsConflictError(`rollback transaction ${transaction.id} references missing generation history`);
    }
    const targetPin = await resolveRefCommit(this.repository, target.ref, signal);
    if (targetPin !== target.commit || target.commit !== plan.targetCommit || target.ref !== plan.targetRef) {
      throw new GenerationsConflictError(`rollback transaction ${transaction.id} target pin changed`);
    }
    const activePin = await resolveRefCommit(this.repository, active.ref, signal);
    if (activePin !== active.commit || active.commit !== plan.expectedHeadCommit) {
      throw new GenerationsConflictError(`rollback transaction ${transaction.id} active pin changed`);
    }

    const head = await resolveHeadCommit(this.repository, signal);
    const stateActive = this.state.activeGenerationId;
    if (head === target.commit && stateActive === target.id) {
      removeRollbackTransaction(this.stateDir);
      return { active: cloneGeneration(active), target: cloneGeneration(target), recovered };
    }
    if (stateActive !== active.id) {
      throw new GenerationsConflictError(
        `rollback transaction ${transaction.id} is stale because active generation is ${stateActive ?? "unset"}`,
      );
    }
    if (head === active.commit) {
      if (!initialValidation) await this.validateRollbackPlan({ plan, ...(signal ? { signal } : {}) });
      await restoreHead(this.repository, active.commit, target.commit);
    } else if (head !== target.commit) {
      throw new GenerationsConflictError(
        `rollback transaction ${transaction.id} cannot recover from repository HEAD ${head}`,
      );
    }

    saveRollbackTransaction(this.stateDir, { ...transaction, phase: "head-moved", updatedAt: this.now() });
    const confirmedHead = await resolveHeadCommit(this.repository);
    if (confirmedHead !== target.commit) {
      throw new GenerationsConflictError(
        `rollback transaction ${transaction.id} expected repository HEAD ${target.commit}, got ${confirmedHead}`,
      );
    }
    const nextState: GenerationsState = { ...this.state, activeGenerationId: target.id };
    saveGenerationsState(this.stateDir, nextState);
    this.state = nextState;
    removeRollbackTransaction(this.stateDir);
    return { active: cloneGeneration(active), target: cloneGeneration(target), recovered };
  }

  private async allocateActivationSlot(
    targetCommit: string,
    signal?: AbortSignal,
  ): Promise<{ sequence: number; id: string; ref: string; reusedPin: boolean }> {
    let sequence = this.state.nextSequence;
    while (true) {
      const id = generationId(sequence);
      const ref = generationRef(id);
      if (this.state.generations[id]) {
        sequence += 1;
        continue;
      }
      const existingRef = await resolveRefCommit(this.repository, ref, signal);
      if (existingRef === targetCommit) return { sequence, id, ref, reusedPin: true };
      if (existingRef === undefined) return { sequence, id, ref, reusedPin: false };
      sequence += 1;
    }
  }

  private async allocateGenerationSlot(signal?: AbortSignal): Promise<{ sequence: number; id: string; ref: string }> {
    let sequence = this.state.nextSequence;
    let id = generationId(sequence);
    let ref = generationRef(id);
    while (this.state.generations[id] || (await resolveRefCommit(this.repository, ref, signal))) {
      sequence += 1;
      id = generationId(sequence);
      ref = generationRef(id);
    }
    return { sequence, id, ref };
  }
}

export function createGenerationsManager(options: GenerationsManagerOptions): GenerationsManager {
  return new GenerationsManager(options);
}

export function createEmptyStateForTesting(): GenerationsState {
  return createEmptyGenerationsState();
}
