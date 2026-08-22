import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitWorktree,
  installExecutionAccess,
  uninstallExecutionAccess,
  type WorktreeProcessResult,
} from "../src/index.js";

const created: string[] = [];

function run(command: string, args: string[], cwd: string, timeoutMs?: number): WorktreeProcessResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed: result.signal !== null,
    ...(result.error ? { error: result.error } : {}),
  };
}

function git(cwd: string, args: string[]): string {
  const result = run("git", args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return result.stdout.trim();
}

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

beforeEach(() => {
  installExecutionAccess({
    async runProcess(command, args, options) {
      options.signal?.throwIfAborted();
      const result = run(command, args, options.cwd, options.timeoutMs);
      options.signal?.throwIfAborted();
      return result;
    },
  });
});

afterEach(async () => {
  uninstallExecutionAccess();
  while (created.length) {
    const path = created.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("linked-worktree Git trust boundary", () => {
  it("rejects redirected candidate Git metadata without moving the primary branch", async () => {
    const root = await temp("friday-worktree-security-");
    const repository = join(root, "repository");
    const candidate = join(root, "candidate");
    await mkdir(repository, { recursive: true });

    git(repository, ["init", "-b", "main"]);
    await writeFile(join(repository, "baseline.txt"), "baseline\n", "utf8");
    git(repository, ["add", "baseline.txt"]);
    git(repository, [
      "-c", "user.name=FRIDAY Test",
      "-c", "user.email=friday-test@localhost",
      "commit", "-m", "baseline",
    ]);

    const primaryBefore = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["worktree", "add", "-b", "friday/candidate", candidate, primaryBefore]);
    const validPointer = await readFile(join(candidate, ".git"), "utf8");
    await writeFile(join(candidate, "candidate.txt"), "candidate change\n", "utf8");

    await writeFile(join(candidate, ".git"), `gitdir: ${join(repository, ".git")}\n`, "utf8");

    await expect(
      commitWorktree({
        repository,
        directory: candidate,
        message: "must not reach primary",
      }),
    ).rejects.toThrow(/linked-worktree admin directory/);

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(primaryBefore);

    await writeFile(join(candidate, ".git"), validPointer, "utf8");
    const committed = await commitWorktree({
      repository,
      directory: candidate,
      message: "valid candidate",
    });

    expect(committed.changed).toBe(true);
    expect(committed.commit).not.toBe(primaryBefore);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(primaryBefore);
    expect(git(candidate, ["rev-parse", "HEAD"])).toBe(committed.commit);
  });
});
