export type CandidateStatus =
  | "created"
  | "evaluating"
  | "passed"
  | "failed"
  | "error"
  | "promoted"
  | "rolled-back"
  | "abandoned";

export interface CandidateCheckSpec {
  id?: string;
  command: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface CandidateEvaluationResult {
  id: string;
  command: string;
  status: "pass" | "partial" | "fail" | "timeout" | "error" | "no-score";
  score: number | undefined;
  exitCode: number | null;
  exitText: string;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
}

export interface CandidateEvaluationSummary {
  total: number;
  passed: number;
  partial: number;
  failed: number;
  timedOut: number;
  errors: number;
  noScore: number;
  scoreTotal: number;
  scored: number;
  averageScore: number | undefined;
  durationMs: number;
}

export interface CandidateEvaluationRun {
  checks: CandidateCheckSpec[];
  results: CandidateEvaluationResult[];
  summary: CandidateEvaluationSummary;
  evaluatedAt: string;
  commit?: string | undefined;
}

export type GenerationHandoffStatus = "pending" | "resuming" | "completed" | "failed";

export interface GenerationHandoffRecord {
  id: string;
  candidateId: string;
  objective: string;
  repository: string;
  fromGenerationId: string | undefined;
  fromCommit: string;
  toGenerationId: string;
  toCommit: string;
  status: GenerationHandoffStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  resumeAttempts: number;
  claimedAt: string | undefined;
  completedAt: string | undefined;
  lastError: string | undefined;
}

export interface CandidateRecord {
  id: string;
  objective: string;
  repository: string;
  worktreeRoot: string;
  worktreeName: string;
  directory: string;
  baseCommit: string;
  branch: string | undefined;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  evaluation: CandidateEvaluationRun | undefined;
  promotedGenerationId?: string | undefined;
  promotedCommit?: string | undefined;
  promotedAt?: string | undefined;
  lastError: string | undefined;
}

export interface SelfImprovementState {
  schema: 1;
  candidates: Record<string, CandidateRecord>;
  handoffs: Record<string, GenerationHandoffRecord>;
}

export interface CandidateWorktreeInfo {
  name: string;
  directory: string;
  baseCommit: string;
  branch?: string;
}

export interface CandidateWorktreeCreateOptions {
  repository: string;
  root: string;
  name?: string;
  baseRef?: string;
  signal?: AbortSignal | undefined;
}

export interface CandidateWorktreeRemoveOptions {
  repository: string;
  directory: string;
  force?: boolean;
  deleteBranch?: boolean;
  signal?: AbortSignal | undefined;
}

export interface CandidateWorktreeInspectOptions {
  repository: string;
  directory: string;
  signal?: AbortSignal | undefined;
}

export interface CandidateWorktreeSnapshot {
  directory: string;
  head: string;
  branch: string | undefined;
  clean: boolean;
}

export interface SelfImprovementWorktreesAccess {
  createWorktree(options: CandidateWorktreeCreateOptions): Promise<CandidateWorktreeInfo>;
  inspectWorktree(options: CandidateWorktreeInspectOptions): Promise<CandidateWorktreeSnapshot>;
  removeWorktree(options: CandidateWorktreeRemoveOptions): Promise<boolean>;
}

export interface CandidateEvaluationCheck extends CandidateCheckSpec {
  cwd: string;
}

export interface SelfImprovementEvaluationSuiteResult {
  results: CandidateEvaluationResult[];
  summary: CandidateEvaluationSummary;
}

export interface SelfImprovementEvaluationAccess {
  runCommandEvaluationSuite(
    specs: readonly CandidateEvaluationCheck[],
    signal?: AbortSignal,
  ): Promise<SelfImprovementEvaluationSuiteResult>;
}


export interface SelfImprovementGenerationRecord {
  id: string;
  commit: string;
  parentId: string | undefined;
}

export interface SelfImprovementRollbackPlan {
  activeGenerationId: string;
  targetGenerationId: string;
  expectedHeadCommit: string;
  targetCommit: string;
  targetRef: string;
  plannedAt: string;
}

export interface SelfImprovementGenerationsManager {
  getActiveGeneration(): SelfImprovementGenerationRecord | undefined;
  checkpointCurrent(options?: { label?: string | undefined; signal?: AbortSignal | undefined }): Promise<SelfImprovementGenerationRecord>;
  activateDescendant(options: {
    targetCommit: string;
    expectedBaseCommit: string;
    label?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<SelfImprovementGenerationRecord>;
  planRollback(options: {
    targetGenerationId: string;
    signal?: AbortSignal | undefined;
  }): Promise<SelfImprovementRollbackPlan>;
  executeRollback(options: {
    plan: SelfImprovementRollbackPlan;
    signal?: AbortSignal | undefined;
  }): Promise<{ target: SelfImprovementGenerationRecord; recovered: boolean }>;
}

export interface SelfImprovementGenerationsAccess {
  openManager(options: { repository: string; stateDir: string }): SelfImprovementGenerationsManager;
}

export interface SelfImprovementManagerOptions {
  stateDir?: string;
  now?: () => string;
  idFactory?: () => string;
}

export interface CreateCandidateOptions {
  objective: string;
  repository: string;
  worktreeRoot: string;
  name?: string;
  baseRef?: string;
  signal?: AbortSignal | undefined;
}

export interface EvaluateCandidateOptions {
  id: string;
  checks: readonly CandidateCheckSpec[];
  signal?: AbortSignal | undefined;
}

export interface PromoteCandidateOptions {
  id: string;
  generationsStateDir: string;
  label?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ClaimGenerationHandoffOptions {
  generationId: string;
}

export interface CompleteGenerationHandoffOptions {
  id: string;
}

export interface ReleaseGenerationHandoffOptions {
  id: string;
  error?: string | undefined;
}

export interface FailGenerationHandoffOptions {
  id: string;
  error: string;
}

export interface MarkCandidateRolledBackOptions {
  id: string;
  error: string;
}

export interface AbandonCandidateOptions {
  id: string;
  force?: boolean;
  deleteBranch?: boolean;
  signal?: AbortSignal | undefined;
}
