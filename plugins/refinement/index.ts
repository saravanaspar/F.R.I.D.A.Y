import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as refinement from "@friday/refinement";
import type { FridayPlugin } from "../../src/plugin.js";
import { AGENT_AFTER_TURN_CONTRIBUTION } from "../turn-loop/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MEMORY_CAPABILITY } from "../memory/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import { REFINEMENT_CAPABILITY, type RefinementService } from "./contract.js";
import { RefinementHistoryStore } from "./history-store.js";
import {
  autoRefineReason,
  autoRefineTrajectory,
  createAutoRefineAccumulator,
  explicitMemoryMutationHandled,
  memoryOnlyAutoRefineProposal,
  recordAutoRefineTurn,
  resetAutoRefineReviewCounter,
  type AutoRefineAccumulator,
} from "./auto-refine-policy.js";

function stateRoot(): string {
  const configured = process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim();
  if (!configured) return join(homedir(), ".friday");
  return isAbsolute(configured) ? configured : resolve(configured);
}

function systemString(
  input: Readonly<SystemJsonObject>,
  name: string,
  options: { required?: boolean; maximum?: number } = {},
): string | undefined {
  const value = input[name];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  const maximum = options.maximum ?? 8_192;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function positiveLimit(input: Readonly<SystemJsonObject>, fallback = 10): number {
  const value = input.limit;
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return value as number;
}

/**
 * Refinement stays a continual-state capability. The composition plugin adds
 * conversational planning/approval/history without moving persistence into the
 * runtime implementation package.
 */
const refinementPlugin: FridayPlugin = definePlugin({
  id: "refinement",
  requires: [MEMORY_CAPABILITY, MODEL_CAPABILITY, PERMISSIONS_CAPABILITY],
  optional: [MODEL_CREDENTIALS_CAPABILITY],
  provides: [REFINEMENT_CAPABILITY],
}, (ctx) => {
  const memory = ctx.services.require(MEMORY_CAPABILITY);
  const model = ctx.services.require(MODEL_CAPABILITY);
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const history = new RefinementHistoryStore();
  const autoRefine = new Map<string, AutoRefineAccumulator>();
  let mutationTail: Promise<void> = Promise.resolve();

  function serializeMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  const completeSimple = model.api.completeSimple as unknown as refinement.RefinementModelAccess["completeSimple"];
  refinement.installModelAccess({ completeSimple });
  refinement.installMemoryAccess({
    open: (stateDir, scope) =>
      new memory.api.MemoryStore({ stateDir, scope }),
  });

  const service: RefinementService = Object.freeze({ api: refinement });
  ctx.services.provide(REFINEMENT_CAPABILITY, service);

  function globalStore() {
    return new memory.api.MemoryStore({
      stateDir: memory.api.getGlobalMemoryStateDir(stateRoot()),
      scope: "global",
    });
  }

  function localStore(sessionArtifactDir: string) {
    const stateDir = memory.api.getLocalMemoryStateDir(sessionArtifactDir);
    if (!stateDir) throw new Error("Automatic refinement requires a persistent session");
    return new memory.api.MemoryStore({ stateDir, scope: "local" });
  }

  function assertAffectedEntriesUnchanged(
    store: ReturnType<typeof globalStore>,
    proposal: refinement.RefinementProposal,
    baseline: refinement.RefinementState,
  ): void {
    const checked = new Set<string>();
    for (const edit of proposal.edits) {
      // Updates/deletes and every generated rollback edit carry a concrete id.
      // Create-without-id conflicts remain validated by the runtime apply layer.
      if (!edit.id) continue;
      const key = `${edit.kind}:${edit.id}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const current = store.get(edit.kind, edit.id);
      const expected = baseline.entries[edit.kind][edit.id];
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error(`Refinement target ${key} changed during confirmation; regenerate the proposal before applying it`);
      }
    }
  }

  function applyAndRecord(
    store: ReturnType<typeof globalStore>,
    proposal: refinement.RefinementProposal,
    options: Parameters<typeof refinement.applyRefinementProposal>[2],
  ): refinement.RefinementResult {
    const baseline = store.snapshot();
    try {
      const result = refinement.applyRefinementProposal(store, proposal, options);
      history.record(result);
      return result;
    } catch (error) {
      try {
        store.replaceState(baseline);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Refinement failed and its memory-state compensation also failed",
        );
      }
      throw error;
    }
  }

  async function modelForRefinement() {
    const provider = process.env.FRIDAY_MODEL_PROVIDER?.trim();
    const modelId = process.env.FRIDAY_MODEL_ID?.trim();
    if (!provider || !modelId) throw new Error("Refinement requires a configured main model");
    const selected = model.api.getModel(provider as never, modelId as never);
    if (!selected) throw new Error(`Unknown refinement model: ${provider}/${modelId}`);
    const apiKey = await ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY)?.getApiKey(provider);
    return { selected: selected as refinement.RefinementModelLike, ...(apiKey ? { apiKey } : {}) };
  }

  function proposalText(plan: refinement.RefinementPlan): string {
    const edits = plan.proposal.edits.length === 0
      ? "No persistent edits proposed."
      : plan.proposal.edits.map((edit, index) => `${index + 1}. ${edit.action} ${edit.kind}:${edit.id ?? edit.title ?? "new"}${edit.reason ? ` — ${edit.reason}` : ""}`).join("\n");
    return [
      `Refinement proposal ${plan.id}`,
      plan.proposal.summary,
      "",
      edits,
      "",
      `Expected outcome: ${plan.proposal.expectedOutcome}`,
    ].join("\n");
  }

  ctx.contribute(AGENT_AFTER_TURN_CONTRIBUTION, {
    id: "refinement-auto-checkpoint",
    async afterTurn(context, signal) {
      // Transient turns intentionally do not accumulate private continual state.
      if (!context.sessionArtifactDir) return;
      // A capability handoff already creates a new verified generation and resumes
      // the original objective. Do not spend another model call trying to learn from
      // that transitional turn immediately before process takeover.
      if (context.usedTools.includes("capability_ensure")) return;
      const tracker = autoRefine.get(context.sessionId) ?? createAutoRefineAccumulator();
      autoRefine.set(context.sessionId, tracker);
      if (explicitMemoryMutationHandled(context.usedTools)) {
        // Explicit agent-facing memory tools are authoritative and should not be duplicated by the model-backed fallback learner.
        resetAutoRefineReviewCounter(tracker);
        return;
      }
      recordAutoRefineTurn(tracker, {
        userText: context.userText,
        assistantText: context.assistantText,
        usedTools: context.usedTools,
      });
      const reviewReason = autoRefineReason(tracker, { userText: context.userText, usedTools: context.usedTools });
      if (!reviewReason) return;

      const turnsSinceLastReview = tracker.turnsSinceReview;
      const trajectory = autoRefineTrajectory(tracker);
      signal?.throwIfAborted();

      const global = globalStore();
      const local = localStore(context.sessionArtifactDir);
      try {
        const combinedState = memory.api.mergeMemoryStates(global.snapshot(), local.snapshot());
        const { selected, apiKey } = await modelForRefinement();
        const review = await refinement.reviewAutoRefine(
          trajectory,
          combinedState,
          history.list(100),
          selected,
          { reason: reviewReason, turnsSinceLastReview },
          { ...(apiKey ? { apiKey } : {}), ...(signal ? { signal } : {}) },
        );
        if (!review.shouldRefine) {
          resetAutoRefineReviewCounter(tracker);
          return;
        }

        const plan = await refinement.planRefinement(
          trajectory,
          combinedState,
          history.list(100),
          selected,
          {
            scope: "local",
            instructions: [
              review.instructions,
              "Automatic checkpoint: propose ONLY session-local memory edits backed by the trajectory.",
              "Never create or modify prompt, skill, subagent, persona, capability, or global entries automatically.",
              "Do not persist secrets, raw credentials, transient tool output, or unsupported guesses.",
            ].filter(Boolean).join(" "),
          },
          { ...(apiKey ? { apiKey } : {}), ...(signal ? { signal } : {}) },
        );
        const localBaseline = local.snapshot();
        const proposal = memoryOnlyAutoRefineProposal(plan.proposal, localBaseline);
        if (proposal.edits.length === 0) {
          resetAutoRefineReviewCounter(tracker);
          return;
        }

        await serializeMutation(() => {
          const mutationStore = localStore(context.sessionArtifactDir!);
          try {
            return applyAndRecord(mutationStore, proposal, {
              id: plan.id,
              scope: "local",
              baselineState: localBaseline,
            });
          } finally {
            mutationStore.close();
          }
        });
        resetAutoRefineReviewCounter(tracker);
      } finally {
        local.close();
        global.close();
      }
    },
  });

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "refinement",
    label: "Refinement",
    snapshot: () => ({ recent: history.list(5).map((entry) => ({ id: entry.id, summary: entry.summary, rollbackOf: entry.rollbackOf ?? null })) }),
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "refinement.plan",
    label: "Plan refinement",
    description: "Generate a non-mutating proposal for global continual-state refinement using the user's supplied trajectory/instructions.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        trajectory: { type: "string" },
        instructions: { type: "string" },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      const trajectory = systemString(input, "trajectory", { maximum: 64_000 }) ?? context.turn.text;
      const instructions = systemString(input, "instructions", { maximum: 16_000 });
      const store = globalStore();
      try {
        const { selected, apiKey } = await modelForRefinement();
        return await refinement.planRefinement(
          trajectory,
          store.snapshot(),
          history.list(100),
          selected,
          { scope: "global", ...(instructions ? { instructions } : {}) },
          { ...(apiKey ? { apiKey } : {}), ...(context.signal ? { signal: context.signal } : {}) },
        );
      } finally {
        store.close();
      }
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "refinement.apply",
    label: "Apply refinement",
    description: "Plan a global continual-state refinement, show the proposal, request authorization, then atomically apply validated edits and retain rollback history.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        trajectory: { type: "string" },
        instructions: { type: "string" },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      const trajectory = systemString(input, "trajectory", { maximum: 64_000 }) ?? context.turn.text;
      const instructions = systemString(input, "instructions", { maximum: 16_000 });
      const store = globalStore();
      let baseline: refinement.RefinementState;
      let plan: refinement.RefinementPlan;
      try {
        baseline = store.snapshot();
        const { selected, apiKey } = await modelForRefinement();
        plan = await refinement.planRefinement(
          trajectory,
          baseline,
          history.list(100),
          selected,
          { scope: "global", ...(instructions ? { instructions } : {}) },
          { ...(apiKey ? { apiKey } : {}), ...(context.signal ? { signal: context.signal } : {}) },
        );
      } finally {
        store.close();
      }
      await context.turn.reply(proposalText(plan));
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: process.cwd(),
        access: "write",
        action: { id: "refinement.apply", effect: "system-write", resource: "refinement:global", network: false },
        reason: `apply refinement ${plan.id}`,
      });
      return serializeMutation(() => {
        const mutationStore = globalStore();
        try {
          assertAffectedEntriesUnchanged(mutationStore, plan.proposal, baseline);
          return applyAndRecord(mutationStore, plan.proposal, {
            id: plan.id,
            scope: "global",
            baselineState: baseline,
          });
        } finally {
          mutationStore.close();
        }
      });
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "refinement.history",
    label: "Refinement history",
    description: "Show bounded persistent refinement history. Defaults to the latest 10 results.",
    parameters: Object.freeze({
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    }),
    execute(input) {
      return history.list(positiveLimit(input));
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "refinement.rollback",
    label: "Rollback refinement",
    description: "Show and authorize the inverse edits for a previous refinement, then apply them as a new auditable refinement result.",
    parameters: Object.freeze({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      const id = systemString(input, "id", { required: true, maximum: 160 })!;
      const target = history.get(id);
      if (!target) throw new Error(`Refinement ${id} not found`);
      const proposal = refinement.buildRollbackProposal(target);
      const plan: refinement.RefinementPlan = { proposal, id: `rollback_${randomUUID()}`, rollbackOf: target.id, rollbackScope: "global" };
      const baselineStore = globalStore();
      let baseline: refinement.RefinementState;
      try {
        baseline = baselineStore.snapshot();
      } finally {
        baselineStore.close();
      }
      await context.turn.reply(proposalText(plan));
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: process.cwd(),
        access: "write",
        action: { id: "refinement.rollback", effect: "system-write", resource: `refinement:${target.id}`, network: false },
        reason: `rollback refinement ${target.id}`,
      });
      return serializeMutation(() => {
        const store = globalStore();
        try {
          assertAffectedEntriesUnchanged(store, proposal, baseline);
          return applyAndRecord(store, proposal, {
            id: plan.id,
            rollbackOf: target.id,
            scope: "global",
            baselineState: baseline,
          });
        } finally {
          store.close();
        }
      });
    },
  });
});

export default refinementPlugin;
