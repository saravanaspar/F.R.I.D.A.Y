import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  NotGitRepositoryError,
  WorktreeCommitError,
  WorktreeCreateError,
  WorktreeListError,
  WorktreeInspectError,
  WorktreeNameError,
  WorktreeRemoveError,
  WorktreeResetError,
  WorktreePromoteError,
} from "./errors.js";
import { git, gitMessage } from "./git.js";
import { parseWorktreePorcelain } from "./porcelain.js";
import type {
  CommitWorktreeOptions,
  CommitWorktreeResult,
  DiffWorktreeOptions,
  CreateWorktreeOptions,
  InspectWorktreeOptions,
  ListedWorktree,
  ListWorktreesOptions,
  RemoveWorktreeOptions,
  ResetWorktreeOptions,
  WorktreeInfo,
  WorktreeSnapshot,
  WorktreeDiff,
  PromoteWorktreeOptions,
  PromoteWorktreeResult,
} from "./types.js";

const MAX_NAME_ATTEMPTS = 26;
const DEFAULT_BRANCH_PREFIX = "friday";

interface LocatedWorktree {
  primary: string;
  target: string;
  entry: ListedWorktree;
}

interface TrustedGitContext {
  cwd: string;
  argsPrefix: string[];
  readOnlyMounts: string[];
}

class WorktreeTrustError extends Error {}

function trimEdgeCharacter(value: string, character: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === character) start += 1;
  while (end > start && value[end - 1] === character) end -= 1;
  return value.slice(start, end);
}

export function slugifyWorktreeName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return trimEdgeCharacter(normalized, "-").slice(0, 64);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorktreeNameError("Generated worktree directory escaped the configured root");
  }
}

async function repositoryRoot(repository: string, signal?: AbortSignal): Promise<string> {
  const cwd = resolve(repository);
  const result = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  if (result.code !== 0) {
    throw new NotGitRepositoryError(gitMessage(result, "Worktrees require a git repository"));
  }
  const root = result.stdout.trim();
  if (!root) throw new NotGitRepositoryError("Git did not return a repository root");
  return canonicalExisting(root);
}

async function resolveCommit(repository: string, ref: string, signal?: AbortSignal): Promise<string> {
  const result = await git(repository, ["rev-parse", "--verify", `${ref}^{commit}`], signal);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new WorktreeCreateError(gitMessage(result, `Unable to resolve git ref: ${ref}`));
  }
  return result.stdout.trim();
}

function generatedName(): string {
  return `candidate-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

async function branchExists(repository: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal);
  return result.code === 0;
}

export async function makeWorktreeInfo(options: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const repository = await repositoryRoot(options.repository, options.signal);
  const root = resolve(options.root);
  await mkdir(root, { recursive: true });
  const canonicalRoot = await canonicalExisting(root);
  const baseCommit = await resolveCommit(repository, options.baseRef ?? "HEAD", options.signal);
  const requested = options.name === undefined ? undefined : slugifyWorktreeName(options.name);
  if (options.name !== undefined && !requested) {
    throw new WorktreeNameError("Worktree name must contain at least one alphanumeric character");
  }

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const seed = requested ?? generatedName();
    const name = attempt === 0 ? seed : `${seed}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const directory = resolve(canonicalRoot, name);
    assertContained(canonicalRoot, directory);
    if (await exists(directory)) continue;

    if (options.detached === true) {
      return { name, directory, baseCommit };
    }

    const branch = `${DEFAULT_BRANCH_PREFIX}/${name}`;
    if (await branchExists(repository, branch, options.signal)) continue;
    return { name, directory, baseCommit, branch };
  }

  throw new WorktreeNameError("Failed to generate a unique worktree name");
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeInfo> {
  const repository = await repositoryRoot(options.repository, options.signal);
  const info = await makeWorktreeInfo({ ...options, repository });
  const args = info.branch
    ? ["worktree", "add", "-b", info.branch, info.directory, info.baseCommit]
    : ["worktree", "add", "--detach", info.directory, info.baseCommit];
  const created = await git(repository, args, options.signal);
  if (created.code !== 0) {
    throw new WorktreeCreateError(gitMessage(created, "Failed to create git worktree"));
  }
  return info;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<ListedWorktree[]> {
  const repository = await repositoryRoot(options.repository, options.signal);
  const result = await git(repository, ["worktree", "list", "--porcelain"], options.signal);
  if (result.code !== 0) {
    throw new WorktreeListError(gitMessage(result, "Failed to list git worktrees"));
  }
  return parseWorktreePorcelain(result.stdout);
}

async function findListedWorktree(
  repository: string,
  directory: string,
  signal?: AbortSignal,
  protectPrimary = true,
): Promise<LocatedWorktree> {
  const primary = await repositoryRoot(repository, signal);
  const target = await canonicalExisting(directory).catch(() => resolve(directory));
  if (protectPrimary && target === primary) {
    throw new WorktreeRemoveError("Cannot operate destructively on the primary worktree");
  }

  const list = await git(primary, ["worktree", "list", "--porcelain"], signal);
  if (list.code !== 0) {
    throw new WorktreeListError(gitMessage(list, "Failed to list git worktrees"));
  }
  const entries = parseWorktreePorcelain(list.stdout);
  const entry = entries.find((item) => resolve(item.directory) === target);
  if (!entry) throw new WorktreeRemoveError("Worktree not found");
  return { primary, target, entry };
}

function resolvePointerPath(base: string, pointer: string): string {
  return isAbsolute(pointer) ? resolve(pointer) : resolve(base, pointer);
}

function trustMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function trustedGitContext(
  located: LocatedWorktree,
  signal?: AbortSignal,
): Promise<TrustedGitContext> {
  if (located.target === located.primary) {
    return { cwd: located.target, argsPrefix: [], readOnlyMounts: [] };
  }

  try {
    const commonResult = await git(
      located.primary,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    );
    if (commonResult.code !== 0 || !commonResult.stdout.trim()) {
      throw new WorktreeTrustError(
        gitMessage(commonResult, "Failed to resolve trusted repository Git directory"),
      );
    }

    const commonDir = await canonicalExisting(commonResult.stdout.trim());
    const worktreesRoot = await canonicalExisting(join(commonDir, "worktrees"));
    const dotGit = resolve(located.target, ".git");
    const dotGitStat = await lstat(dotGit);
    if (!dotGitStat.isFile()) {
      throw new WorktreeTrustError("Candidate .git metadata must be a regular file");
    }

    const pointerText = (await readFile(dotGit, "utf8")).trim();
    const pointerMatch = /^gitdir:\s*(.+)$/.exec(pointerText);
    if (!pointerMatch?.[1]?.trim()) {
      throw new WorktreeTrustError("Candidate .git metadata is not a valid linked-worktree pointer");
    }

    const claimedGitDir = await canonicalExisting(
      resolvePointerPath(dirname(dotGit), pointerMatch[1].trim()),
    );
    const adminRelative = relative(worktreesRoot, claimedGitDir);
    if (
      !adminRelative ||
      adminRelative === "." ||
      adminRelative === ".." ||
      adminRelative.startsWith(`..${sep}`) ||
      isAbsolute(adminRelative) ||
      adminRelative.includes(sep)
    ) {
      throw new WorktreeTrustError(
        "Candidate .git metadata does not reference a linked-worktree admin directory",
      );
    }

    const backPointerText = (await readFile(join(claimedGitDir, "gitdir"), "utf8")).trim();
    if (!backPointerText) {
      throw new WorktreeTrustError("Linked-worktree admin metadata is missing its worktree pointer");
    }
    const backPointer = await canonicalExisting(resolvePointerPath(claimedGitDir, backPointerText));
    const candidateDotGit = await canonicalExisting(dotGit);
    if (backPointer !== candidateDotGit) {
      throw new WorktreeTrustError("Linked-worktree admin metadata does not point back to the candidate checkout");
    }

    const commonPointerText = (await readFile(join(claimedGitDir, "commondir"), "utf8")).trim();
    if (!commonPointerText) {
      throw new WorktreeTrustError("Linked-worktree admin metadata is missing its common repository pointer");
    }
    const adminCommonDir = await canonicalExisting(resolvePointerPath(claimedGitDir, commonPointerText));
    if (adminCommonDir !== commonDir) {
      throw new WorktreeTrustError("Linked-worktree admin metadata resolves to a different repository");
    }

    return {
      cwd: located.target,
      argsPrefix: [`--git-dir=${claimedGitDir}`, `--work-tree=${located.target}`],
      readOnlyMounts: [commonDir],
    };
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw error;
    throw new WorktreeTrustError(`Unable to validate linked-worktree Git metadata: ${trustMessage(error)}`);
  }
}

async function gitInWorktree(
  context: TrustedGitContext,
  args: string[],
  signal?: AbortSignal,
) {
  return git(context.cwd, [...context.argsPrefix, ...args], signal);
}

async function inspectLocatedWorktree(
  located: LocatedWorktree,
  context: TrustedGitContext,
  signal?: AbortSignal,
): Promise<WorktreeSnapshot> {
  if (located.entry.bare || located.entry.prunable) {
    throw new WorktreeInspectError("Candidate worktree is not an active checkout");
  }
  const head = await gitInWorktree(context, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new WorktreeInspectError(gitMessage(head, "Failed to resolve worktree HEAD"));
  }
  const commit = head.stdout.trim();
  if (located.entry.head && located.entry.head !== commit) {
    throw new WorktreeInspectError("Worktree metadata does not match its current HEAD");
  }
  const status = await gitInWorktree(
    context,
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
    signal,
  );
  if (status.code !== 0) {
    throw new WorktreeInspectError(gitMessage(status, "Failed to inspect worktree status"));
  }
  return {
    directory: located.target,
    head: commit,
    branch: located.entry.branch,
    clean: status.stdout.trim().length === 0,
  };
}


export async function trustedWorktreeReadOnlyMounts(options: InspectWorktreeOptions): Promise<string[]> {
  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal, false);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) throw new WorktreeInspectError(error.message);
    throw error;
  }
  try {
    const context = await trustedGitContext(located, options.signal);
    return [...context.readOnlyMounts];
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreeInspectError(error.message);
    throw error;
  }
}

export async function inspectWorktree(options: InspectWorktreeOptions): Promise<WorktreeSnapshot> {
  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal, false);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) {
      throw new WorktreeInspectError(error.message);
    }
    throw error;
  }

  let context: TrustedGitContext;
  try {
    context = await trustedGitContext(located, options.signal);
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreeInspectError(error.message);
    throw error;
  }
  return inspectLocatedWorktree(located, context, options.signal);
}

export async function removeWorktree(options: RemoveWorktreeOptions): Promise<boolean> {
  const { primary, target, entry } = await findListedWorktree(
    options.repository,
    options.directory,
    options.signal,
  );
  const args = ["worktree", "remove"];
  if (options.force === true) args.push("--force");
  args.push(target);
  const removed = await git(primary, args, options.signal);
  if (removed.code !== 0) {
    throw new WorktreeRemoveError(gitMessage(removed, "Failed to remove git worktree"));
  }

  if (options.deleteBranch === true && entry.branch) {
    const deleted = await git(primary, ["branch", "-D", entry.branch], options.signal);
    if (deleted.code !== 0) {
      throw new WorktreeRemoveError(gitMessage(deleted, `Removed worktree but failed to delete branch ${entry.branch}`));
    }
  }
  await git(primary, ["worktree", "prune"], options.signal);
  return true;
}

export async function resetWorktree(options: ResetWorktreeOptions): Promise<boolean> {
  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) {
      throw new WorktreeResetError(error.message);
    }
    throw error;
  }

  const base = await git(
    located.primary,
    ["rev-parse", "--verify", `${options.baseRef ?? "HEAD"}^{commit}`],
    options.signal,
  );
  if (base.code !== 0 || !base.stdout.trim()) {
    throw new WorktreeResetError(gitMessage(base, `Unable to resolve git ref: ${options.baseRef ?? "HEAD"}`));
  }
  const targetCommit = base.stdout.trim();
  let context: TrustedGitContext;
  try {
    context = await trustedGitContext(located, options.signal);
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreeResetError(error.message);
    throw error;
  }

  const steps: Array<{ args: string[]; fallback: string }> = [
    { args: ["reset", "--hard", targetCommit], fallback: "Failed to reset worktree" },
    { args: ["clean", "-ffdx"], fallback: "Failed to clean worktree" },
    { args: ["submodule", "update", "--init", "--recursive", "--force"], fallback: "Failed to update submodules" },
    { args: ["submodule", "foreach", "--recursive", "git", "reset", "--hard"], fallback: "Failed to reset submodules" },
    { args: ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"], fallback: "Failed to clean submodules" },
  ];

  for (const step of steps) {
    const result = await gitInWorktree(context, step.args, options.signal);
    if (result.code !== 0) {
      throw new WorktreeResetError(gitMessage(result, step.fallback));
    }
  }

  const status = await gitInWorktree(context, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], options.signal);
  if (status.code !== 0) {
    throw new WorktreeResetError(gitMessage(status, "Failed to verify worktree status"));
  }
  if (status.stdout.trim()) {
    throw new WorktreeResetError(`Worktree reset left local changes:\n${status.stdout.trim()}`);
  }
  return true;
}


export async function commitWorktree(options: CommitWorktreeOptions): Promise<CommitWorktreeResult> {
  options.signal?.throwIfAborted();
  const message = options.message.trim();
  if (!message) throw new WorktreeCommitError("Worktree commit message is required");
  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) throw new WorktreeCommitError(error.message);
    throw error;
  }
  if (located.entry.detached) throw new WorktreeCommitError("Candidate worktree must be branch-backed before committing");
  let context: TrustedGitContext;
  try {
    context = await trustedGitContext(located, options.signal);
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreeCommitError(error.message);
    throw error;
  }

  let before: WorktreeSnapshot;
  try {
    before = await inspectLocatedWorktree(located, context, options.signal);
  } catch (error) {
    if (error instanceof WorktreeInspectError) throw new WorktreeCommitError(error.message);
    throw error;
  }
  if (before.clean) return { directory: located.target, commit: before.head, changed: false };

  const add = await gitInWorktree(context, ["add", "-A", "--", "."], options.signal);
  if (add.code !== 0) throw new WorktreeCommitError(gitMessage(add, "Failed to stage candidate worktree changes"));
  const commit = await gitInWorktree(context, [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=FRIDAY", "-c", "user.email=friday@localhost",
    "commit", "--no-verify", "--no-gpg-sign", "-m", message,
  ], options.signal);
  if (commit.code !== 0) throw new WorktreeCommitError(gitMessage(commit, "Failed to commit candidate worktree changes"));

  let afterLocated: LocatedWorktree;
  try {
    afterLocated = await findListedWorktree(
      located.primary,
      located.target,
      options.signal,
    );
  } catch (error) {
    if (error instanceof WorktreeRemoveError) throw new WorktreeCommitError(error.message);
    throw error;
  }

  let after: WorktreeSnapshot;
  try {
    after = await inspectLocatedWorktree(afterLocated, context, options.signal);
  } catch (error) {
    if (error instanceof WorktreeInspectError) throw new WorktreeCommitError(error.message);
    throw error;
  }
  if (!after.clean) throw new WorktreeCommitError("Candidate commit completed but the worktree is still dirty");
  if (after.head === before.head) throw new WorktreeCommitError("Candidate commit did not advance worktree HEAD");
  return { directory: located.target, commit: after.head, changed: true };
}


export async function diffWorktree(options: DiffWorktreeOptions): Promise<WorktreeDiff> {
  options.signal?.throwIfAborted();
  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) throw new WorktreeInspectError(error.message);
    throw error;
  }
  let context: TrustedGitContext;
  try {
    context = await trustedGitContext(located, options.signal);
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreeInspectError(error.message);
    throw error;
  }
  const status = await gitInWorktree(
    context,
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
    options.signal,
  );
  if (status.code !== 0) throw new WorktreeInspectError(gitMessage(status, "Failed to inspect worktree status"));
  const diff = await gitInWorktree(
    context,
    ["diff", "--no-ext-diff", "--binary", "HEAD", "--", "."],
    options.signal,
  );
  if (diff.code !== 0) throw new WorktreeInspectError(gitMessage(diff, "Failed to render worktree diff"));
  return Object.freeze({ directory: located.target, patch: diff.stdout, status: status.stdout });
}

export async function promoteWorktree(options: PromoteWorktreeOptions): Promise<PromoteWorktreeResult> {
  options.signal?.throwIfAborted();
  if (options.strategy !== "merge" && options.strategy !== "cherry-pick") {
    throw new WorktreePromoteError(`Unsupported worktree promotion strategy: ${String(options.strategy)}`);
  }

  let located: LocatedWorktree;
  try {
    located = await findListedWorktree(options.repository, options.directory, options.signal);
  } catch (error) {
    if (error instanceof WorktreeRemoveError) throw new WorktreePromoteError(error.message);
    throw error;
  }
  if (located.entry.detached) throw new WorktreePromoteError("Candidate worktree must be branch-backed before promotion");

  let context: TrustedGitContext;
  try {
    context = await trustedGitContext(located, options.signal);
  } catch (error) {
    if (error instanceof WorktreeTrustError) throw new WorktreePromoteError(error.message);
    throw error;
  }
  let candidate: WorktreeSnapshot;
  try {
    candidate = await inspectLocatedWorktree(located, context, options.signal);
  } catch (error) {
    if (error instanceof WorktreeInspectError) throw new WorktreePromoteError(error.message);
    throw error;
  }
  if (!candidate.clean) throw new WorktreePromoteError("Candidate worktree must be clean and committed before promotion");

  const primaryStatus = await git(
    located.primary,
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
    options.signal,
  );
  if (primaryStatus.code !== 0) throw new WorktreePromoteError(gitMessage(primaryStatus, "Failed to inspect primary worktree"));
  if (primaryStatus.stdout.trim()) throw new WorktreePromoteError("Primary worktree must be clean before promotion");

  const primaryHeadResult = await git(located.primary, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal);
  if (primaryHeadResult.code !== 0 || !primaryHeadResult.stdout.trim()) {
    throw new WorktreePromoteError(gitMessage(primaryHeadResult, "Failed to resolve primary worktree HEAD"));
  }
  const previousHead = primaryHeadResult.stdout.trim();
  const candidateHead = candidate.head;
  if (previousHead === candidateHead) {
    return Object.freeze({
      repository: located.primary,
      directory: located.target,
      strategy: options.strategy,
      previousHead,
      head: previousHead,
      candidateHead,
      changed: false,
      commits: Object.freeze([]),
    });
  }

  const alreadyIntegrated = await git(located.primary, ["merge-base", "--is-ancestor", candidateHead, previousHead], options.signal);
  if (alreadyIntegrated.code === 0) {
    return Object.freeze({
      repository: located.primary,
      directory: located.target,
      strategy: options.strategy,
      previousHead,
      head: previousHead,
      candidateHead,
      changed: false,
      commits: Object.freeze([]),
    });
  }
  if (alreadyIntegrated.code !== 1) {
    throw new WorktreePromoteError(gitMessage(alreadyIntegrated, "Failed to compare candidate and primary history"));
  }

  const commitListResult = await git(
    located.primary,
    ["rev-list", "--reverse", `${previousHead}..${candidateHead}`],
    options.signal,
  );
  if (commitListResult.code !== 0) throw new WorktreePromoteError(gitMessage(commitListResult, "Failed to resolve candidate commits"));
  const commits = commitListResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (commits.length === 0) throw new WorktreePromoteError("Candidate does not contain any promotable commits");

  if (options.strategy === "merge") {
    const merged = await git(
      located.primary,
      ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", candidateHead],
      options.signal,
    );
    if (merged.code !== 0) {
      throw new WorktreePromoteError(`Fast-forward merge failed: ${gitMessage(merged, "use cherry-pick for a diverged primary branch")}`);
    }
  } else {
    const picked = await git(
      located.primary,
      [
        "-c", "core.hooksPath=/dev/null",
        "-c", "commit.gpgsign=false",
        "-c", "user.name=FRIDAY",
        "-c", "user.email=friday@localhost",
        "cherry-pick", "--no-gpg-sign", ...commits,
      ],
      options.signal,
    );
    if (picked.code !== 0) {
      const failure = `Cherry-pick promotion failed: ${gitMessage(picked, "unknown Git failure")}`;
      const aborted = await git(located.primary, ["cherry-pick", "--abort"]);
      if (aborted.code !== 0) {
        throw new WorktreePromoteError(`${failure}; cherry-pick abort also failed: ${gitMessage(aborted, "unknown abort failure")}`);
      }
      throw new WorktreePromoteError(`${failure}; cherry-pick was aborted`);
    }
  }

  const afterHeadResult = await git(located.primary, ["rev-parse", "--verify", "HEAD^{commit}"], options.signal);
  if (afterHeadResult.code !== 0 || !afterHeadResult.stdout.trim()) {
    throw new WorktreePromoteError(gitMessage(afterHeadResult, "Promotion completed but primary HEAD could not be resolved"));
  }
  const afterStatus = await git(
    located.primary,
    ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
    options.signal,
  );
  if (afterStatus.code !== 0 || afterStatus.stdout.trim()) {
    throw new WorktreePromoteError("Promotion completed but the primary worktree is not clean");
  }
  const head = afterHeadResult.stdout.trim();
  if (head === previousHead) throw new WorktreePromoteError("Promotion did not advance primary HEAD");
  return Object.freeze({
    repository: located.primary,
    directory: located.target,
    strategy: options.strategy,
    previousHead,
    head,
    candidateHead,
    changed: true,
    commits: Object.freeze([...commits]),
  });
}
