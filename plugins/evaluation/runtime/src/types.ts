export type EvaluationStatus = "pass" | "partial" | "fail" | "timeout" | "error" | "no-score";

export interface EvaluationProcessOptions {
  cwd?: string;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  network?: boolean | undefined;
}

export interface EvaluationProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
  outputTruncated: boolean;
}

export interface EvaluationExecutionAccess {
  runProcess(
    command: string,
    args: string[],
    options?: EvaluationProcessOptions,
  ): Promise<EvaluationProcessResult>;
}

export interface EvaluationObservation {
  score?: number;
  error?: string;
  timedOut?: boolean;
}

export interface CommandEvaluationSpec {
  id?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv | undefined;
  network?: boolean | undefined;
}

export interface CommandEvaluationResult {
  id: string;
  command: string;
  status: EvaluationStatus;
  score: number | undefined;
  exitCode: number | null;
  exitText: string;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
}

export interface EvaluationSummary {
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

export interface CommandEvaluationSuiteResult {
  results: CommandEvaluationResult[];
  summary: EvaluationSummary;
}
