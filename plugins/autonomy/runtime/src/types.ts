export interface AutonomousUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead?: number;
  totalTokens?: number;
}

export interface AutonomousAssistantMessage {
  stopReason?: string;
}

export interface AutonomousTextContent {
  type: "text";
  text: string;
}

export interface AutonomousUserMessage {
  role: "user";
  content: AutonomousTextContent[];
  timestamp: number;
}

export interface AutonomyProcessOptions {
  cwd?: string;
  shell?: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal | undefined;
}

export interface AutonomyProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
  outputTruncated: boolean;
}

export interface AutonomyExecutionAccess {
  runProcess(
    command: string,
    args: string[],
    options?: AutonomyProcessOptions,
  ): Promise<AutonomyProcessResult>;
}

export interface AutonomyEvaluationOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  signal?: AbortSignal | undefined;
}

export interface AutonomyEvaluationResult {
  passed: boolean;
  exitText: string;
  output: string;
  outputTruncated: boolean;
}

export interface AutonomyEvaluationAccess {
  evaluateCommand(
    command: string,
    options?: AutonomyEvaluationOptions,
  ): Promise<AutonomyEvaluationResult>;
}
