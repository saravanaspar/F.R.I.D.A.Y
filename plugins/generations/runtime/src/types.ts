export interface GenerationsProcessOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface GenerationsProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  killed?: boolean | undefined;
  error?: Error | undefined;
}

export interface GenerationsExecutionAccess {
  runProcess(
    command: string,
    args: string[],
    options: GenerationsProcessOptions,
  ): Promise<GenerationsProcessResult>;
}

export interface GenerationRecord {
  id: string;
  sequence: number;
  repository: string;
  commit: string;
  ref: string;
  parentId: string | undefined;
  label: string | undefined;
  createdAt: string;
}

export interface GenerationsState {
  schema: 1;
  nextSequence: number;
  activeGenerationId: string | undefined;
  generations: Record<string, GenerationRecord>;
}

export interface GenerationsManagerOptions {
  repository: string;
  stateDir: string;
  now?: (() => string) | undefined;
}

export interface CheckpointGenerationOptions {
  label?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ActivateDescendantOptions {
  targetCommit: string;
  expectedBaseCommit: string;
  label?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RollbackPlan {
  activeGenerationId: string;
  targetGenerationId: string;
  expectedHeadCommit: string;
  targetCommit: string;
  targetRef: string;
  plannedAt: string;
}

export interface PlanRollbackOptions {
  targetGenerationId: string;
  signal?: AbortSignal | undefined;
}

export interface ValidateRollbackPlanOptions {
  plan: RollbackPlan;
  signal?: AbortSignal | undefined;
}

export interface RollbackPlanValidation {
  valid: true;
  active: GenerationRecord;
  target: GenerationRecord;
}

export type RollbackTransactionPhase = "prepared" | "head-moved";

export interface RollbackTransaction {
  schema: 1;
  id: string;
  phase: RollbackTransactionPhase;
  plan: RollbackPlan;
  createdAt: string;
  updatedAt: string;
}

export interface ExecuteRollbackOptions {
  plan: RollbackPlan;
  signal?: AbortSignal | undefined;
}

export interface RollbackExecutionResult {
  active: GenerationRecord;
  target: GenerationRecord;
  recovered: boolean;
}
