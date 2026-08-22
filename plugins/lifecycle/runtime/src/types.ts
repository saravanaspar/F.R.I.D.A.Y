export type RestartPhase = "launching" | "ready" | "quiesced" | "accepted" | "failed";

export interface RestartProcessIdentity {
  pid: number;
}

export interface RestartRecord {
  version: 1;
  requestId: string;
  tokenHash: string;
  phase: RestartPhase;
  predecessor: RestartProcessIdentity;
  successor: RestartProcessIdentity | undefined;
  /**
   * New handoffs pause predecessor-owned listeners/workers before the successor
   * activates them. Omitted records retain the legacy ready -> accepted flow so
   * persisted v1 records and external lifecycle consumers remain readable.
   */
  handoffRequired?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
  message: string | undefined;
}

export interface CurrentProcessLaunchSpec {
  command: string;
  args: string[];
}

export interface LifecycleProcessSnapshot {
  pid: number;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface LifecycleManagerOptions {
  stateDir: string;
  now?: () => string;
  requestIdFactory?: () => string;
  tokenFactory?: () => string;
  process?: LifecycleProcessSnapshot;
  pollIntervalMs?: number;
}

export interface LaunchReplacementOptions {
  /** Optional verified successor executable. Used by single-binary self-improvement. */
  executable?: string | undefined;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface AcknowledgeRestartOptions {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => string;
}

export interface WaitForTakeoverOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface WaitForReleaseOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface RejectRestartOptions extends AcknowledgeRestartOptions {
  error: unknown;
}

export interface DetachedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DetachedProcessResult {
  pid: number;
}

export interface LifecycleExecutionAccess {
  launchDetachedProcess(
    command: string,
    args: readonly string[],
    options?: DetachedProcessOptions,
  ): Promise<DetachedProcessResult>;
  isProcessAlive(pid: number): boolean;
  terminateProcess?(pid: number): void | Promise<void>;
  signalProcess?(pid: number, signal: NodeJS.Signals): void | Promise<void>;
}
