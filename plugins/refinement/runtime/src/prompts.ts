import type {
  AutoRefineReviewContext,
  RefinementResult,
  RefinementScope,
  RefinementState,
} from "./types.js";

const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

export const REFINEMENT_SYSTEM_PROMPT = `You are FRIDAY's continual refinement subsystem.

Improve the editable continual state from the current trajectory by emitting precise Create, Update, or Delete edits to reusable state. Never rewrite the immutable base system prompt and never edit source files directly.

Editable kinds:
- prompt: supplemental behavioral notes only.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: reusable Python-callable procedures. Create/update edits require a Python reference and an explicit arguments contract.
- subagent: reusable delegation specifications describing purpose, instructions, and when to invoke.

Scope policy:
- local is the default for session/task progress, temporary blockers, current-run coordination, and project facts that are not clearly cross-session reusable.
- global is only for durable cross-session lessons, stable user preferences, reusable skills/subagents, or explicitly project-qualified lessons likely to be reused.
- during local refinement, global entries are read-only context. Do not update or delete them; create a local override when needed.

Prefer small evidence-backed edits. If prior refinements caused issues, rollback or replace the faulty editable entries.

Return JSON only:
{
  "summary": "one sentence",
  "rationale": "trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update",
      "content": "required for create/update",
      "path": "optional grouping path",
      "reference": {"type":"python","import":"package.module","callable":"function_name","call_pattern":"await function_name(...)"},
      "arguments": {},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

export const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are FRIDAY's automatic refinement review gate.

Decide whether this checkpoint contains evidence worth persisting as session-local memory. Approve evidence useful to later turns in the same persistent session; reject one-off noise, unsupported hypotheses, raw tool output, and secrets. Automatic review never authors skills, prompt rules, personas, subagents, capabilities, or global memory. Reusable skills are created only through the explicit agent skill-authoring workflow, and global durable knowledge is written through explicit memory actions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions when shouldRefine is true"
}`;

function compactText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function overviewForRefinement(state: RefinementState): string {
  const lines: string[] = [];
  for (const kind of ["prompt", "memory", "skill", "subagent"] as const) {
    const entries = Object.values(state.entries[kind]).sort((left, right) =>
      [left.path, left.title, left.id].join("\0").localeCompare([right.path, right.title, right.id].join("\0")),
    );
    lines.push(`${kind}:`);
    for (const entry of entries.slice(0, DEFAULT_OVERVIEW_ENTRY_LIMIT)) {
      lines.push(
        `- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version}): ${compactText(entry.content, DEFAULT_OVERVIEW_CONTENT_LIMIT)}`,
      );
    }
    if (entries.length === 0) lines.push("- none");
    if (entries.length > DEFAULT_OVERVIEW_ENTRY_LIMIT) {
      lines.push(`- +${entries.length - DEFAULT_OVERVIEW_ENTRY_LIMIT} more`);
    }
  }
  return lines.join("\n");
}

export function historyForRefinement(history: readonly RefinementResult[]): string {
  if (history.length === 0) return "none";
  return history
    .slice(-DEFAULT_OVERVIEW_REFINEMENT_LIMIT)
    .map((item) => {
      const edits = item.appliedEdits
        .map((edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
        .join(", ");
      const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
      return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
    })
    .join("\n\n");
}

export function buildRefinementUserPrompt(options: {
  trajectory: string;
  state: RefinementState;
  history: readonly RefinementResult[];
  scope: RefinementScope;
  instructions?: string;
}): string {
  const scopeInstruction =
    options.scope === "global"
      ? "Requested refinement scope: global. Only propose stable cross-session edits, durable preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future sessions."
      : "Requested refinement scope: local. Prefer current-task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across sessions. Global entries are read-only context.";
  return [
    `<current_continual_state>\n${overviewForRefinement(options.state)}\n</current_continual_state>`,
    `<refinement_history>\n${historyForRefinement(options.history)}\n</refinement_history>`,
    `<trajectory>\n${options.trajectory.slice(-80_000)}\n</trajectory>`,
    `<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
    options.instructions
      ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>`
      : "",
    "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAutoRefineReviewUserPrompt(options: {
  trajectory: string;
  state: RefinementState;
  history: readonly RefinementResult[];
  context: AutoRefineReviewContext;
}): string {
  return [
    `<trigger>\n${options.context.reason}; ${options.context.turnsSinceLastReview} assistant turns since last review\n</trigger>`,
    `<current_continual_state>\n${overviewForRefinement(options.state)}\n</current_continual_state>`,
    `<refinement_history>\n${historyForRefinement(options.history)}\n</refinement_history>`,
    `<trajectory>\n${options.trajectory.slice(-40_000)}\n</trajectory>`,
    "Return shouldRefine=true only when the trajectory contains evidence worth carrying into later turns of this persistent session. Automatic learning is local-memory-only; never request a skill, prompt, persona, subagent, capability, or global edit here.",
  ].join("\n\n");
}
