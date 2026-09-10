export interface KernelDisplayData {
  messageType: "display_data" | "update_display_data";
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface KernelExecuteResult {
  stdout: string;
  stderr: string;
  result?: string;
  displayData?: KernelDisplayData[];
  status: "ok" | "error" | "aborted";
  error?: { ename: string; evalue: string; traceback: string[] };
  durationMs: number;
}

export interface KernelHandle {
  execute(
    code: string,
    options?: {
      signal?: AbortSignal;
      onStream?: (chunk: string, name: "stdout" | "stderr") => void;
      maxOutputChars?: number;
    },
  ): Promise<KernelExecuteResult>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
  kill(): Promise<void>;
}

export interface ShellOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}


export interface ManagedProcessOwner {
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerKind: "main-agent" | "subagent";
}

export interface ManagedProcessSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: "running" | "exited" | "stopped" | "failed";
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: NodeJS.Signals | null | undefined;
  readonly totalOutputBytes: number;
  readonly logsTruncated: boolean;
}

export interface ManagedProcessOperations {
  currentOwner(): ManagedProcessOwner | undefined;
  start(request: {
    readonly id: string;
    readonly command: string;
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly launch?: {
      readonly command: string;
      readonly args: readonly string[];
    } | undefined;
    readonly maxLifetimeMs?: number | undefined;
    readonly cleanup?: (() => void | Promise<void>) | undefined;
  }): Promise<ManagedProcessSnapshot>;
  list(): readonly ManagedProcessSnapshot[];
  get(id: string): ManagedProcessSnapshot | undefined;
  logs(id: string): { readonly text: string; readonly truncated: boolean; readonly totalBytes: number };
  stop(id: string, reason?: string): Promise<ManagedProcessSnapshot>;
}

export interface KernelHostRequestContext {
  readonly requestId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export type KernelHostRequestHandler = (
  payload: Record<string, unknown>,
  context: KernelHostRequestContext,
) => Promise<Record<string, unknown>>;

export interface KernelLaunchRequest {
  python: string;
  connectionPath: string;
  tempDir: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface KernelLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutionAccess {
  createKernel(options: {
    python?: string;
    cwd?: string;
    env?: Record<string, string>;
    sessionId?: string;
    hostHandlers?: Record<string, KernelHostRequestHandler>;
    transport?: "tcp" | "ipc";
    launcher?: (request: KernelLaunchRequest) => KernelLaunchSpec;
  }): KernelHandle;
  createLocalShellOperations(options?: { shellPath?: string }): ShellOperations;
  managedProcesses: ManagedProcessOperations;
}

let activeExecutionAccess: ExecutionAccess | undefined;

export function configureExecutionAccess(access: ExecutionAccess): void {
  activeExecutionAccess = access;
}

export function resetExecutionAccess(): void {
  activeExecutionAccess = undefined;
}

export function executionAccess(): ExecutionAccess {
  if (!activeExecutionAccess) {
    throw new Error("tools runtime execution access is not configured");
  }
  return activeExecutionAccess;
}

export async function withManagedProcessRun<T>(
  owner: ManagedProcessOwner,
  operation: () => Promise<T>,
): Promise<T> {
  const operations = executionAccess().managedProcesses as ManagedProcessOperations & {
    withRun<R>(runOwner: ManagedProcessOwner, runOperation: () => Promise<R>): Promise<R>;
  };
  if (typeof operations.withRun !== "function") {
    throw new Error("managed process run scoping is not configured");
  }
  return await operations.withRun(owner, operation);
}
