import type { RefinementEdit, RefinementProposal, RefinementState } from "@friday/refinement";

export const AUTO_REFINE_TURN_INTERVAL = 4;
const MAX_TRAJECTORY_SEGMENTS = 8;
const MAX_SEGMENT_CHARS = 10_000;
const MAX_AUTOMATIC_EDITS = 8;

const HIGH_SIGNAL = /\b(?:remember this|note this|from now on|going forward|i prefer|prefer that|always do|never do|when i say|that was wrong|you got that wrong|instead do|correction|actually[, ]|next time)\b/i;
const SECRET_SHAPE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\b\s*[:=]\s*[^\s]{8,}|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))/i;
const EXPLICIT_MEMORY_MUTATION_TOOLS = new Set(["memory_remember", "memory_remember_relation", "memory_forget"]);

export function explicitMemoryMutationHandled(usedTools: readonly string[]): boolean {
  return usedTools.some((tool) => EXPLICIT_MEMORY_MUTATION_TOOLS.has(tool));
}

export interface AutoRefineAccumulator {
  turnsSinceReview: number;
  segments: string[];
}

export function createAutoRefineAccumulator(): AutoRefineAccumulator {
  return { turnsSinceReview: 0, segments: [] };
}

function clip(value: string, maximum: number): string {
  const normalized = value.replaceAll("\u0000", "\ufffd").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

export function recordAutoRefineTurn(
  state: AutoRefineAccumulator,
  input: { readonly userText: string; readonly assistantText: string; readonly usedTools: readonly string[] },
): void {
  state.turnsSinceReview += 1;
  state.segments.push([
    `USER:\n${clip(input.userText, 3_500)}`,
    input.usedTools.length === 0 ? "TOOLS: none" : `TOOLS: ${input.usedTools.slice(0, 32).join(", ")}`,
    `ASSISTANT:\n${clip(input.assistantText, 6_000)}`,
  ].join("\n\n"));
  if (state.segments.length > MAX_TRAJECTORY_SEGMENTS) {
    state.segments.splice(0, state.segments.length - MAX_TRAJECTORY_SEGMENTS);
  }
}

export type AutoRefineReason = "high_signal" | "turn_interval";

export function autoRefineReason(
  state: AutoRefineAccumulator,
  input: { readonly userText: string; readonly usedTools: readonly string[] },
): AutoRefineReason | undefined {
  if (HIGH_SIGNAL.test(input.userText)) return "high_signal";
  if (input.usedTools.length > 0 && state.turnsSinceReview >= AUTO_REFINE_TURN_INTERVAL) return "turn_interval";
  return undefined;
}

export function shouldRunAutoRefineReview(
  state: AutoRefineAccumulator,
  input: { readonly userText: string; readonly usedTools: readonly string[] },
): boolean {
  return autoRefineReason(state, input) !== undefined;
}

export function autoRefineTrajectory(state: AutoRefineAccumulator): string {
  return clip(state.segments.join("\n\n---\n\n"), MAX_TRAJECTORY_SEGMENTS * MAX_SEGMENT_CHARS);
}

export function resetAutoRefineReviewCounter(state: AutoRefineAccumulator): void {
  state.turnsSinceReview = 0;
  state.segments.splice(0);
}

function safeMemoryEdit(edit: RefinementEdit, localState: RefinementState): boolean {
  if (edit.kind !== "memory") return false;
  if (edit.action !== "create" && edit.action !== "update" && edit.action !== "delete") return false;
  if ((edit.title && SECRET_SHAPE.test(edit.title)) || (edit.content && SECRET_SHAPE.test(edit.content))) return false;
  if ((edit.action === "update" || edit.action === "delete") && (!edit.id || !localState.entries.memory[edit.id])) {
    // Automatic refinement may read global state as context, but it can mutate only session-local memory.
    return false;
  }
  return true;
}

/**
 * Automatic learning is deliberately narrower than explicit refinement:
 * only bounded session-local memory edits are allowed. Skills, prompts,
 * personas, and subagents require an explicit agent/user workflow.
 */
export function memoryOnlyAutoRefineProposal(
  proposal: RefinementProposal,
  localState: RefinementState,
): RefinementProposal {
  const edits = proposal.edits.filter((edit) => safeMemoryEdit(edit, localState)).slice(0, MAX_AUTOMATIC_EDITS);
  return {
    summary: clip(proposal.summary, 512),
    rationale: clip(proposal.rationale, 4_000),
    expectedOutcome: clip(proposal.expectedOutcome, 2_000),
    edits,
  };
}
