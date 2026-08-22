import { resolve } from "node:path";
import { runProcess } from "./execution-access.js";
import { GenerationsRepositoryError } from "./errors.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

async function git(
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
  if (result.error) {
    throw new GenerationsRepositoryError(result.error.message);
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    killed: result.killed ?? false,
  };
}

function message(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

export async function assertRepositoryRoot(repository: string, signal?: AbortSignal): Promise<void> {
  const result = await git(repository, ["rev-parse", "--show-toplevel"], signal);
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, "repository is not a git worktree"));
  }
  const actual = result.stdout.trim();
  if (!actual || resolve(actual) !== resolve(repository)) {
    throw new GenerationsRepositoryError(
      `generation repository must be the git worktree root: expected ${resolve(repository)}, got ${actual || "unknown"}`,
    );
  }
}

export async function assertCleanRepository(repository: string, signal?: AbortSignal): Promise<void> {
  const result = await git(
    repository,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    signal,
  );
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, "failed to inspect repository status"));
  }
  if (result.stdout.trim().length > 0) {
    throw new GenerationsRepositoryError(
      "generation checkpoints require a clean repository; commit or remove local changes before checkpointing",
    );
  }
}

export async function resolveHeadCommit(repository: string, signal?: AbortSignal): Promise<string> {
  const result = await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  const commit = result.stdout.trim();
  if (result.code !== 0 || !commit) {
    throw new GenerationsRepositoryError(message(result, "failed to resolve repository HEAD commit"));
  }
  return commit;
}

export async function resolveRefCommit(
  repository: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
  if (result.code === 1) return undefined;
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, `failed to resolve generation ref ${ref}`));
  }
  const commit = result.stdout.trim();
  return commit || undefined;
}

export async function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await git(repository, ["merge-base", "--is-ancestor", ancestor, descendant], signal);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GenerationsRepositoryError(message(result, "failed to compare generation ancestry"));
}

export async function createPinnedRef(
  repository: string,
  ref: string,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await resolveRefCommit(repository, ref, signal);
  if (existing !== undefined) {
    throw new GenerationsRepositoryError(`generation ref already exists: ${ref}`);
  }
  const result = await git(
    repository,
    ["update-ref", ref, commit, "0".repeat(commit.length)],
    signal,
  );
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, `failed to pin generation ref ${ref}`));
  }
}

export async function deletePinnedRef(
  repository: string,
  ref: string,
  expectedCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await git(repository, ["update-ref", "-d", ref, expectedCommit], signal);
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, `failed to remove generation ref ${ref}`));
  }
}

export async function fastForwardHead(
  repository: string,
  expectedHead: string,
  targetCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  const current = await resolveHeadCommit(repository, signal);
  if (current !== expectedHead) {
    throw new GenerationsRepositoryError(
      `repository HEAD changed before activation: expected ${expectedHead}, got ${current}`,
    );
  }
  const result = await git(
    repository,
    ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", targetCommit],
    signal,
  );
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, `failed to fast-forward repository to ${targetCommit}`));
  }
  const confirmed = await resolveHeadCommit(repository, signal);
  if (confirmed !== targetCommit) {
    throw new GenerationsRepositoryError(
      `repository activation ended at ${confirmed}, expected ${targetCommit}`,
    );
  }
}

export async function restoreHead(
  repository: string,
  expectedCurrentHead: string,
  targetCommit: string,
): Promise<void> {
  const current = await resolveHeadCommit(repository);
  if (current === targetCommit) return;
  if (current !== expectedCurrentHead) {
    throw new GenerationsRepositoryError(
      `refusing activation recovery because repository HEAD is ${current}, expected ${expectedCurrentHead}`,
    );
  }
  const result = await git(repository, ["reset", "--hard", targetCommit]);
  if (result.code !== 0) {
    throw new GenerationsRepositoryError(message(result, `failed to restore repository HEAD to ${targetCommit}`));
  }
  const confirmed = await resolveHeadCommit(repository);
  if (confirmed !== targetCommit) {
    throw new GenerationsRepositoryError(
      `repository recovery ended at ${confirmed}, expected ${targetCommit}`,
    );
  }
}
