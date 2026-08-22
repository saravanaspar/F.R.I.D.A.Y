export const REFINEMENT_ENTRY_KINDS = ["prompt", "memory", "skill", "subagent"] as const;

export type RefinementKind = (typeof REFINEMENT_ENTRY_KINDS)[number];
export type RefinementAction = "create" | "update" | "delete";
export type RefinementScope = "local" | "global";
export type AutoRefineReason = "turn_interval" | "compact" | "high_signal";

export interface RefinementEntry {
  id: string;
  kind: RefinementKind;
  title: string;
  content: string;
  path: string;
  scope: RefinementScope;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface RefinementEvent {
  id: string;
  trigger: string;
  changes: string[];
  evidence: string;
  outcome: string;
  created_at: string;
}

export interface RefinementState {
  schema: number;
  entries: Record<RefinementKind, Record<string, RefinementEntry>>;
  refinements: RefinementEvent[];
}

export interface RefinementEdit {
  action: RefinementAction;
  kind: RefinementKind;
  id?: string;
  title?: string;
  content?: string;
  path?: string;
  reference?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export interface RefinementProposal {
  summary: string;
  rationale: string;
  edits: RefinementEdit[];
  expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
  id: string;
  before?: RefinementEntry;
  after?: RefinementEntry;
  applied: boolean;
  error?: string;
}

export interface RefinementResult {
  id: string;
  summary: string;
  rationale: string;
  expectedOutcome: string;
  appliedEdits: AppliedRefinementEdit[];
  rollbackOf?: string;
  scope?: RefinementScope;
}

export interface RefineOptions {
  instructions?: string;
  rollbackId?: string;
  scope?: RefinementScope;
}

export interface RefinementPlan {
  proposal: RefinementProposal;
  id: string;
  rollbackOf?: string;
  rollbackScope?: RefinementScope;
}

export interface AutoRefineReviewContext {
  reason: AutoRefineReason;
  turnsSinceLastReview: number;
}

export interface AutoRefineReview {
  shouldRefine: boolean;
  rationale: string;
  instructions?: string;
}

export interface RefinementModelLike {
  maxTokens: number;
}

export interface RefinementTextContent {
  type: "text";
  text: string;
}

export interface RefinementCompletionResponse {
  content: Array<RefinementTextContent | { type: string; [key: string]: unknown }>;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
}

export interface RefinementCompletionContext {
  systemPrompt: string;
  messages: Array<{
    role: "user";
    content: RefinementTextContent[];
    timestamp: number;
  }>;
}

export interface RefinementCompletionOptions {
  maxTokens: number;
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface RefinementMemoryPort {
  readonly scope: RefinementScope;
  snapshot(): RefinementState;
  get(kind: RefinementKind, id: string): RefinementEntry | undefined;
  create(
    kind: RefinementKind,
    input: {
      id?: string;
      title: string;
      content: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
    },
  ): RefinementEntry;
  update(
    kind: RefinementKind,
    id: string,
    input: {
      title: string;
      content: string;
      path?: string;
      reference?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      source?: string;
    },
  ): RefinementEntry;
  delete(kind: RefinementKind, id: string): boolean;
  recordRefinement(
    trigger: string,
    changes: readonly string[] | string,
    options?: { id?: string; evidence?: string; outcome?: string },
  ): RefinementEvent;
}

export interface RefinementCustomEntryLike {
  customType: string;
  data: unknown;
}
