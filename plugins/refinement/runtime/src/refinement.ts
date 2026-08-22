import { completeSimple } from "./model-access.js";
import { parseAutoRefineReview, parseProposal, TRUNCATED_JSON_ERROR } from "./json.js";
import {
  AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
  buildAutoRefineReviewUserPrompt,
  buildRefinementUserPrompt,
  REFINEMENT_SYSTEM_PROMPT,
} from "./prompts.js";
import type {
  AppliedRefinementEdit,
  AutoRefineReview,
  AutoRefineReviewContext,
  RefineOptions,
  RefinementCustomEntryLike,
  RefinementEdit,
  RefinementEntry,
  RefinementKind,
  RefinementMemoryPort,
  RefinementModelLike,
  RefinementPlan,
  RefinementProposal,
  RefinementResult,
  RefinementScope,
  RefinementState,
} from "./types.js";

export const REFINEMENT_CUSTOM_TYPE = "friday.refinement";
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;
const RESERVED_REFINEMENT_IDS = new Set(["__proto__", "prototype", "constructor"]);

function refinementMaxOutputTokens(model: RefinementModelLike): number {
  return Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
}

function autoRefineReviewMaxOutputTokens(model: RefinementModelLike): number {
  return Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
}

function trimEdgeUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;
  return value.slice(start, end);
}

function slug(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return trimEdgeUnderscores(normalized).slice(0, 80) || fallback;
}

function cloneEntry(entry: RefinementEntry | undefined): RefinementEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

export function inferRefinementResultScope(result: RefinementResult): RefinementScope | undefined {
  if (result.scope) return result.scope;
  const scopes = new Set<RefinementScope>();
  for (const edit of result.appliedEdits) {
    const scope = edit.after?.scope ?? edit.before?.scope;
    if (scope) scopes.add(scope);
  }
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

export function validateRefinementEdit(edit: RefinementEdit, computedId?: string): string | undefined {
  if (!["create", "update", "delete"].includes(edit.action)) {
    return `unsupported action ${String(edit.action)}`;
  }
  if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
    return `unsupported kind ${String(edit.kind)}`;
  }
  const effectiveId = computedId ?? edit.id;
  if (effectiveId && RESERVED_REFINEMENT_IDS.has(effectiveId)) {
    return "reserved refinement id";
  }
  if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
    return "base system prompt is not editable";
  }
  if (edit.action !== "create" && !edit.id) return `${edit.action} requires id`;
  if (edit.action !== "delete" && (!edit.title || !edit.content)) {
    return `${edit.action} requires title and content`;
  }
  if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
    return `${edit.action} skill requires arguments`;
  }
  if (edit.action !== "delete" && edit.kind === "skill") {
    const reference = edit.reference;
    if (!reference) return `${edit.action} skill requires python reference`;
    if (reference.type !== "python") return `${edit.action} skill reference.type must be python`;
    const importName = reference.import ?? reference.python_import;
    const callable = reference.callable ?? reference.call_pattern;
    if (typeof importName !== "string" || importName.length === 0) {
      return `${edit.action} skill requires python import`;
    }
    if (typeof callable !== "string" || callable.length === 0) {
      return `${edit.action} skill requires callable or call_pattern`;
    }
  }
  return undefined;
}

export function applyRefinementProposal(
  store: RefinementMemoryPort,
  proposal: RefinementProposal,
  options: {
    id: string;
    rollbackOf?: string;
    scope?: RefinementScope;
    baselineState?: RefinementState;
  },
): RefinementResult {
  const appliedEdits: AppliedRefinementEdit[] = [];
  const proposalModifiedKeys = new Set<string>();

  for (const edit of proposal.edits) {
    const computedId = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
    const id = computedId ?? "";
    const validationError = validateRefinementEdit(edit, id);
    if (validationError) {
      appliedEdits.push({ ...edit, id, applied: false, error: validationError });
      continue;
    }

    const before = cloneEntry(store.get(edit.kind, id));
    const baselineEntries = options.baselineState?.entries[edit.kind];
    const baseline = cloneEntry(
      baselineEntries && Object.hasOwn(baselineEntries, id) ? baselineEntries[id] : undefined,
    );
    const key = `${edit.kind}:${id}`;
    if (
      options.baselineState &&
      !proposalModifiedKeys.has(key) &&
      JSON.stringify(before) !== JSON.stringify(baseline)
    ) {
      appliedEdits.push({
        ...edit,
        id,
        ...(before ? { before } : {}),
        applied: false,
        error: "entry changed during refinement planning",
      });
      continue;
    }

    if (edit.action === "delete") {
      if (!before) {
        appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
        continue;
      }
      store.delete(edit.kind, id);
      proposalModifiedKeys.add(key);
      appliedEdits.push({ ...edit, id, before, applied: true });
      continue;
    }

    if (edit.action === "create" && before) {
      appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
      continue;
    }
    if (edit.action === "update" && !before) {
      appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
      continue;
    }

    let after: RefinementEntry;
    const input = {
      title: edit.title ?? before?.title ?? id,
      content: edit.content ?? before?.content ?? "",
      ...(edit.path !== undefined ? { path: edit.path } : before ? { path: before.path } : {}),
      ...(edit.reference !== undefined
        ? { reference: edit.reference }
        : before
          ? { reference: before.reference }
          : {}),
      ...(edit.arguments !== undefined
        ? { arguments: edit.arguments }
        : before
          ? { arguments: before.arguments }
          : {}),
      ...(edit.metadata !== undefined
        ? { metadata: edit.metadata }
        : before
          ? { metadata: before.metadata }
          : {}),
      source: "refinement",
    };
    if (edit.action === "create") {
      after = store.create(edit.kind, { id, ...input });
    } else {
      after = store.update(edit.kind, id, input);
    }
    proposalModifiedKeys.add(key);
    appliedEdits.push({ ...edit, id, ...(before ? { before } : {}), after: structuredClone(after), applied: true });
  }

  const changes = appliedEdits
    .filter((edit) => edit.applied)
    .map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
  store.recordRefinement(proposal.summary, changes, {
    id: options.id,
    evidence: proposal.rationale,
    outcome: proposal.expectedOutcome,
  });

  return {
    id: options.id,
    summary: proposal.summary,
    rationale: proposal.rationale,
    expectedOutcome: proposal.expectedOutcome,
    appliedEdits,
    ...(options.rollbackOf ? { rollbackOf: options.rollbackOf } : {}),
    scope: options.scope ?? store.scope,
  };
}

export function buildRollbackProposal(target: RefinementResult): RefinementProposal {
  const edits: RefinementEdit[] = [];
  for (const edit of [...target.appliedEdits].reverse()) {
    if (!edit.applied) continue;
    if (edit.before) {
      edits.push({
        action: edit.after ? "update" : "create",
        kind: edit.kind,
        id: edit.id,
        title: edit.before.title,
        content: edit.before.content,
        path: edit.before.path,
        reference: edit.before.reference,
        arguments: edit.before.arguments,
        metadata: edit.before.metadata,
        reason: `Rollback ${target.id}`,
      });
    } else if (edit.after) {
      edits.push({
        action: "delete",
        kind: edit.kind,
        id: edit.id,
        reason: `Rollback ${target.id}`,
      });
    }
  }
  return {
    summary: `Rollback refinement ${target.id}`,
    rationale: `Restores continual state snapshots from refinement ${target.id}.`,
    expectedOutcome: "Faulty refinement edits are reverted.",
    edits,
  };
}

export function getRefinementHistory(entries: readonly RefinementCustomEntryLike[]): RefinementResult[] {
  return entries
    .filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
    .map((entry) => entry.data)
    .filter((data): data is RefinementResult => {
      return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
    });
}

function nextRefinementId(): string {
  return `refine_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

export async function planRefinement(
  trajectory: string,
  state: RefinementState,
  history: readonly RefinementResult[],
  model: RefinementModelLike,
  options: RefineOptions = {},
  request: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<RefinementPlan> {
  const id = nextRefinementId();
  if (options.rollbackId) {
    const target = history.find((item) => item.id === options.rollbackId);
    if (!target) throw new Error(`Refinement ${options.rollbackId} not found`);
    return {
      proposal: buildRollbackProposal(target),
      id,
      rollbackOf: target.id,
      rollbackScope: inferRefinementResultScope(target) ?? options.scope ?? "local",
    };
  }

  const userPrompt = buildRefinementUserPrompt({
    trajectory,
    state,
    history,
    scope: options.scope ?? "local",
    ...(options.instructions ? { instructions: options.instructions } : {}),
  });
  const response = await completeSimple(
    model,
    {
      systemPrompt: REFINEMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
    },
    {
      maxTokens: refinementMaxOutputTokens(model),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
    },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Refinement failed: ${response.errorMessage || response.stopReason}`);
  }
  if (response.stopReason === "length") throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
  const text = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return { proposal: parseProposal(text), id };
}

export async function reviewAutoRefine(
  trajectory: string,
  state: RefinementState,
  history: readonly RefinementResult[],
  model: RefinementModelLike,
  context: AutoRefineReviewContext,
  request: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<AutoRefineReview> {
  const userPrompt = buildAutoRefineReviewUserPrompt({ trajectory, state, history, context });
  const response = await completeSimple(
    model,
    {
      systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
    },
    {
      maxTokens: autoRefineReviewMaxOutputTokens(model),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Auto-refine review failed: ${response.errorMessage || response.stopReason}`);
  }
  if (response.stopReason === "length") {
    throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
  }
  const text = response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return parseAutoRefineReview(text);
}

export async function refine(
  store: RefinementMemoryPort,
  trajectory: string,
  contextState: RefinementState,
  history: readonly RefinementResult[],
  model: RefinementModelLike,
  options: RefineOptions = {},
  request: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<RefinementResult> {
  const baselineState = store.snapshot();
  const effectiveOptions: RefineOptions = options.scope ? options : { ...options, scope: store.scope };
  const plan = await planRefinement(trajectory, contextState, history, model, effectiveOptions, request);
  if (plan.rollbackScope && plan.rollbackScope !== store.scope) {
    throw new Error(`Rollback ${plan.rollbackOf ?? plan.id} requires a ${plan.rollbackScope} memory store`);
  }
  return applyRefinementProposal(store, plan.proposal, {
    id: plan.id,
    ...(plan.rollbackOf ? { rollbackOf: plan.rollbackOf } : {}),
    scope: plan.rollbackScope ?? effectiveOptions.scope ?? store.scope,
    baselineState,
  });
}
