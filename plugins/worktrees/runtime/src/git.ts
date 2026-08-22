import { runProcess } from "./execution-access.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  signal?.throwIfAborted();
  const result = await runProcess("git", args, {
    cwd,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    killed: result.killed ?? false,
  };
}

export function gitMessage(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}
