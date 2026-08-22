import { describe, expect, it } from "vitest";
import type { RefinementProposal, RefinementState } from "@friday/refinement";
import {
  AUTO_REFINE_TURN_INTERVAL,
  autoRefineReason,
  autoRefineTrajectory,
  createAutoRefineAccumulator,
  explicitMemoryMutationHandled,
  memoryOnlyAutoRefineProposal,
  recordAutoRefineTurn,
  resetAutoRefineReviewCounter,
  shouldRunAutoRefineReview,
} from "../plugins/refinement/auto-refine-policy.js";

function emptyState(): RefinementState {
  return {
    schema: 1,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  };
}

describe("automatic refinement policy", () => {
  it("reviews strong corrections immediately without waiting for the interval", () => {
    const state = createAutoRefineAccumulator();
    recordAutoRefineTurn(state, { userText: "From now on use pnpm", assistantText: "Understood", usedTools: [] });
    expect(shouldRunAutoRefineReview(state, { userText: "From now on use pnpm", usedTools: [] })).toBe(true);
    expect(autoRefineReason(state, { userText: "From now on use pnpm", usedTools: [] })).toBe("high_signal");
  });

  it("does not duplicate explicit agent-facing memory mutations through automatic refinement", () => {
    expect(explicitMemoryMutationHandled(["memory_remember"])).toBe(true);
    expect(explicitMemoryMutationHandled(["memory_remember_relation", "bash"])).toBe(true);
    expect(explicitMemoryMutationHandled(["memory_forget"])).toBe(true);
    expect(explicitMemoryMutationHandled(["memory_recall", "bash"])).toBe(false);
  });

  it("periodically reviews tool-using trajectories and resets the review counter", () => {
    const state = createAutoRefineAccumulator();
    for (let i = 0; i < AUTO_REFINE_TURN_INTERVAL; i += 1) {
      recordAutoRefineTurn(state, { userText: `task ${i}`, assistantText: `done ${i}`, usedTools: ["bash"] });
    }
    expect(shouldRunAutoRefineReview(state, { userText: "continue", usedTools: ["bash"] })).toBe(true);
    expect(autoRefineReason(state, { userText: "continue", usedTools: ["bash"] })).toBe("turn_interval");
    expect(autoRefineTrajectory(state)).toContain("TOOLS: bash");
    resetAutoRefineReviewCounter(state);
    expect(state.turnsSinceReview).toBe(0);
    expect(state.segments).toEqual([]);
  });

  it("filters automatic proposals to safe local memory edits only", () => {
    const state = emptyState();
    state.entries.memory.existing = {
      id: "existing", kind: "memory", title: "Old", content: "old", path: "notes", scope: "local", version: 1,
      reference: {}, arguments: {}, metadata: {}, source: "test",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    };
    const proposal: RefinementProposal = {
      summary: "learn useful context",
      rationale: "evidence",
      expectedOutcome: "reuse later",
      edits: [
        { action: "create", kind: "memory", title: "Project choice", content: "Use pnpm" },
        { action: "update", kind: "memory", id: "existing", title: "Old", content: "new" },
        { action: "update", kind: "memory", id: "global-only", title: "No", content: "no" },
        { action: "create", kind: "skill", title: "spam", content: "do it", arguments: {}, reference: { type: "python", import: "x", callable: "x" } },
        { action: "create", kind: "memory", title: "secret", content: "api_key=sk-abcdefghijklmnopqrstuvwxyz" },
      ],
    };
    const filtered = memoryOnlyAutoRefineProposal(proposal, state);
    expect(filtered.edits).toHaveLength(2);
    expect(filtered.edits.every((edit) => edit.kind === "memory")).toBe(true);
    expect(filtered.edits.map((edit) => edit.id ?? edit.title)).toEqual(["Project choice", "existing"]);
  });
});
