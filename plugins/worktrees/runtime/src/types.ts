export interface WorktreeProcessOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export interface WorktreeProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  killed?: boolean;
  error?: Error;
}

export interface WorktreeExecutionAccess {
  runProcess(
    command: string,
    args: string[],
    options: WorktreeProcessOptions,
  ): Promise<WorktreeProcessResult>;
}

export interface WorktreeInfo {
  name: string;
  directory: string;
  baseCommit: string;
  branch?: string;
}

export interface ListedWorktree {
  directory: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  prunable: boolean;
}

export interface CreateWorktreeOptions {
  repository: string;
  root: string;
  name?: string;
  baseRef?: string;
  detached?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ListWorktreesOptions {
  repository: string;
  signal?: AbortSignal | undefined;
}

export interface InspectWorktreeOptions {
  repository: string;
  directory: string;
  signal?: AbortSignal | undefined;
}

export interface WorktreeSnapshot {
  directory: string;
  head: string;
  branch: string | undefined;
  clean: boolean;
}

export interface RemoveWorktreeOptions {
  repository: string;
  directory: string;
  force?: boolean;
  deleteBranch?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ResetWorktreeOptions {
  repository: string;
  directory: string;
  baseRef?: string;
  signal?: AbortSignal | undefined;
}

export interface CommitWorktreeOptions {
  repository: string;
  directory: string;
  message: string;
  signal?: AbortSignal | undefined;
}

export interface CommitWorktreeResult {
  directory: string;
  commit: string;
  changed: boolean;
}

export interface DiffWorktreeOptions {
  repository: string;
  directory: string;
  signal?: AbortSignal | undefined;
}

export interface WorktreeDiff {
  directory: string;
  patch: string;
  status: string;
}
