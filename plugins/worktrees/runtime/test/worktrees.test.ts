import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NotGitRepositoryError,
  WorktreeCommitError,
  WorktreeCreateError,
  WorktreeInspectError,
  WorktreeListError,
  WorktreeNameError,
  WorktreeRemoveError,
  WorktreeResetError,
  commitWorktree,
  createWorktree,
  installExecutionAccess,
  inspectWorktree,
  listWorktrees,
  makeWorktreeInfo,
  parseWorktreePorcelain,
  removeWorktree,
  resetWorktree,
  slugifyWorktreeName,
  trustedWorktreeReadOnlyMounts,
  uninstallExecutionAccess,
  type WorktreeProcessResult,
} from "../src/index.js";

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

const created: string[] = [];
let calls: Call[] = [];

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

function ok(stdout = "", stderr = ""): WorktreeProcessResult {
  return { status: 0, stdout, stderr, killed: false };
}

function fail(stderr = "failed"): WorktreeProcessResult {
  return { status: 1, stdout: "", stderr, killed: false };
}

function logicalGitArgs(args: string[]): string[] {
  let index = 0;
  while (args[index]?.startsWith("--git-dir=") || args[index]?.startsWith("--work-tree=")) index += 1;
  return args.slice(index);
}

async function installLinkedGitMetadata(
  repository: string,
  candidate: string,
  name = "candidate",
): Promise<string> {
  const adminDir = join(repository, ".git", "worktrees", name);
  await mkdir(adminDir, { recursive: true });
  await writeFile(join(candidate, ".git"), `gitdir: ${adminDir}\n`, "utf8");
  await writeFile(join(adminDir, "gitdir"), `${join(candidate, ".git")}\n`, "utf8");
  await writeFile(join(adminDir, "commondir"), "../..\n", "utf8");
  return adminDir;
}

function install(handler: (call: Call) => WorktreeProcessResult | Promise<WorktreeProcessResult>): void {
  installExecutionAccess({
    async runProcess(command, args, options) {
      const call = { command, args: [...args], cwd: options.cwd };
      calls.push(call);
      return handler(call);
    },
  });
}

function gitBase(repository: string, extra?: (call: Call) => WorktreeProcessResult | undefined): void {
  install((call) => {
    const overridden = extra?.(call);
    if (overridden) return overridden;
    const args = logicalGitArgs(call.args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repository}\n`);
    if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-common-dir") {
      return ok(`${join(repository, ".git")}\n`);
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") return ok(`${"a".repeat(40)}\n`);
    if (args[0] === "show-ref") return fail();
    return ok();
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(async () => {
  uninstallExecutionAccess();
  while (created.length) {
    const path = created.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("worktree names and porcelain", () => {
  it("normalizes requested names", () => {
    expect(slugifyWorktreeName("  My Candidate / Fix!  ")).toBe("my-candidate-fix");
  });

  it("bounds normalized names", () => {
    expect(slugifyWorktreeName("A".repeat(100))).toHaveLength(64);
  });

  it("parses branch and detached worktrees", () => {
    expect(
      parseWorktreePorcelain(
        `worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo/w1\nHEAD bbb\ndetached\n\n`,
      ),
    ).toEqual([
      { directory: "/repo", head: "aaa", branch: "main", detached: false, bare: false, prunable: false },
      { directory: "/repo/w1", head: "bbb", detached: true, bare: false, prunable: false },
    ]);
  });

  it("parses bare and prunable flags", () => {
    expect(parseWorktreePorcelain("worktree /repo/w2\nHEAD ccc\nbare\nprunable gitdir file points to non-existent location\n")).toEqual([
      { directory: "/repo/w2", head: "ccc", detached: false, bare: true, prunable: true },
    ]);
  });
});

describe("worktree creation", () => {
  it("builds branch-backed candidate info from the requested base ref", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository);

    const info = await makeWorktreeInfo({ repository, root, name: "Feature One", baseRef: "main" });
    expect(info.name).toBe("feature-one");
    expect(info.directory).toBe(resolve(root, "feature-one"));
    expect(info.branch).toBe("friday/feature-one");
    expect(info.baseCommit).toBe("a".repeat(40));
    expect(calls.some((call) => call.args.includes("main^{commit}"))).toBe(true);
  });

  it("supports detached worktrees without allocating a branch", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository);

    const info = await makeWorktreeInfo({ repository, root, name: "Detached", detached: true });
    expect(info.branch).toBeUndefined();
    expect(info.name).toBe("detached");
  });

  it("rejects names that normalize to nothing", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository);

    await expect(makeWorktreeInfo({ repository, root, name: "!!!" })).rejects.toBeInstanceOf(WorktreeNameError);
  });

  it("avoids an existing target directory", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    await mkdir(join(root, "same"));
    gitBase(repository);

    const info = await makeWorktreeInfo({ repository, root, name: "same" });
    expect(info.name).toMatch(/^same-[a-f0-9]{8}$/);
    expect(info.directory).not.toBe(resolve(root, "same"));
  });

  it("avoids an existing branch", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    let branchChecks = 0;
    gitBase(repository, (call) => {
      if (call.args[0] === "show-ref") {
        branchChecks += 1;
        return branchChecks === 1 ? ok() : fail();
      }
      return undefined;
    });

    const info = await makeWorktreeInfo({ repository, root, name: "same" });
    expect(info.name).toMatch(/^same-[a-f0-9]{8}$/);
    expect(branchChecks).toBe(2);
  });

  it("rejects non-git repositories", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    install(() => fail("not a git repository"));

    await expect(makeWorktreeInfo({ repository, root, name: "x" })).rejects.toBeInstanceOf(NotGitRepositoryError);
  });

  it("rejects an unresolved base ref", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository, (call) => (call.args[0] === "rev-parse" && call.args[1] === "--verify" ? fail("bad ref") : undefined));

    await expect(makeWorktreeInfo({ repository, root, name: "x", baseRef: "missing" })).rejects.toBeInstanceOf(WorktreeCreateError);
  });

  it("creates a branch-backed worktree with the resolved commit", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository);

    const info = await createWorktree({ repository, root, name: "candidate" });
    const create = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    expect(create?.args).toEqual(["worktree", "add", "-b", "friday/candidate", info.directory, "a".repeat(40)]);
  });

  it("creates detached worktrees with --detach", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository);

    const info = await createWorktree({ repository, root, name: "candidate", detached: true });
    const create = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    expect(create?.args).toEqual(["worktree", "add", "--detach", info.directory, "a".repeat(40)]);
  });

  it("surfaces git worktree creation failures", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    gitBase(repository, (call) => (call.args[0] === "worktree" && call.args[1] === "add" ? fail("cannot add") : undefined));

    await expect(createWorktree({ repository, root, name: "candidate" })).rejects.toThrow("cannot add");
  });
});

describe("worktree listing, removal, and reset", () => {
  it("lists worktrees from git porcelain output", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository, (call) =>
      call.args[0] === "worktree" && call.args[1] === "list"
        ? ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${repository}-candidate\nHEAD bbb\ndetached\n`)
        : undefined,
    );

    const list = await listWorktrees({ repository });
    expect(list).toHaveLength(2);
    expect(list[1]?.detached).toBe(true);
  });

  it("reports worktree list failures", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository, (call) => (call.args[0] === "worktree" && call.args[1] === "list" ? fail("list failed") : undefined));

    await expect(listWorktrees({ repository })).rejects.toBeInstanceOf(WorktreeListError);
  });

  it("inspects a linked worktree HEAD, branch, and cleanliness", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/friday/candidate\n`);
      }
      if (call.cwd === candidate && call.args[0] === "-c") return ok();
      return undefined;
    });

    await expect(inspectWorktree({ repository, directory: candidate })).resolves.toEqual({
      directory: resolve(candidate),
      head: "a".repeat(40),
      branch: "friday/candidate",
      clean: true,
    });
  });

  it("allows read-only inspection of the primary worktree", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository, (call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n`);
      }
      if (call.cwd === repository && call.args[0] === "-c") return ok();
      return undefined;
    });

    await expect(inspectWorktree({ repository, directory: repository })).resolves.toMatchObject({
      directory: resolve(repository),
      head: "a".repeat(40),
      branch: "main",
      clean: true,
    });
  });

  it("exposes only the validated common Git directory as a trusted read-only mount", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) => {
      const args = logicalGitArgs(call.args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/friday/candidate\n`);
      }
      return undefined;
    });

    await expect(
      trustedWorktreeReadOnlyMounts({ repository, directory: candidate }),
    ).resolves.toEqual([join(repository, ".git")]);
  });

  it("reports dirty candidate worktrees without mutating them", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) => {
      const args = logicalGitArgs(call.args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/friday/candidate\n`);
      }
      if (call.cwd === candidate && args[0] === "-c") return ok("?? changed.txt\n");
      return undefined;
    });

    expect((await inspectWorktree({ repository, directory: candidate })).clean).toBe(false);
    expect(calls.some((call) => call.args[0] === "reset" || call.args[0] === "clean")).toBe(false);
  });

  it("rejects inconsistent worktree metadata during inspection", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) =>
      call.args[0] === "worktree" && call.args[1] === "list"
        ? ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${"b".repeat(40)}\nbranch refs/heads/friday/candidate\n`)
        : undefined,
    );

    await expect(inspectWorktree({ repository, directory: candidate })).rejects.toBeInstanceOf(WorktreeInspectError);
  });

  it("finalizes a dirty branch-backed candidate with hooks and signing disabled", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    const adminDir = await installLinkedGitMetadata(repository, candidate);
    const before = "a".repeat(40);
    const after = "b".repeat(40);
    let head = before;
    let dirty = true;
    gitBase(repository, (call) => {
      const args = logicalGitArgs(call.args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD deadbeef\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${head}\nbranch refs/heads/friday/candidate\n`);
      }
      if (call.cwd === candidate && args[0] === "rev-parse") return ok(`${head}\n`);
      if (call.cwd === candidate && args[0] === "-c" && args[1] === "core.fsmonitor=false") return ok(dirty ? " M changed.ts\n" : "");
      if (call.cwd === candidate && args[0] === "add") return ok();
      if (call.cwd === candidate && args.includes("commit")) { head = after; dirty = false; return ok("committed\n"); }
      return undefined;
    });
    await expect(commitWorktree({ repository, directory: candidate, message: "verified candidate" })).resolves.toEqual({ directory: resolve(candidate), commit: after, changed: true });
    const commitCall = calls.find((call) => call.cwd === candidate && call.args.includes("commit"));
    expect(commitCall?.args.slice(0, 2)).toEqual([`--git-dir=${adminDir}`, `--work-tree=${resolve(candidate)}`]);
    expect(commitCall?.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "commit.gpgsign=false", "--no-verify", "--no-gpg-sign"]));
  });

  it("rejects candidate Git metadata redirected at the primary repository", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    await writeFile(join(candidate, ".git"), `gitdir: ${join(repository, ".git")}\n`, "utf8");

    gitBase(repository, (call) => {
      const args = logicalGitArgs(call.args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/friday/candidate\n`);
      }
      return undefined;
    });

    await expect(
      commitWorktree({ repository, directory: candidate, message: "must not reach primary" }),
    ).rejects.toThrow(/linked-worktree admin directory/);
    expect(
      calls.some((call) => call.cwd === candidate && logicalGitArgs(call.args)[0] === "add"),
    ).toBe(false);
  });

  it("refuses to commit the primary worktree", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository);
    await expect(commitWorktree({ repository, directory: repository, message: "no" })).rejects.toBeInstanceOf(WorktreeCommitError);
  });

  it("refuses to remove the primary worktree", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository);
    await expect(removeWorktree({ repository, directory: repository })).rejects.toBeInstanceOf(WorktreeRemoveError);
  });

  it("refuses to remove an unknown worktree", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    gitBase(repository, (call) =>
      call.args[0] === "worktree" && call.args[1] === "list"
        ? ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n`)
        : undefined,
    );

    await expect(removeWorktree({ repository, directory: candidate })).rejects.toThrow("Worktree not found");
  });

  it("removes a worktree, optionally deletes its branch, and prunes metadata", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    gitBase(repository, (call) =>
      call.args[0] === "worktree" && call.args[1] === "list"
        ? ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD bbb\nbranch refs/heads/friday/candidate\n`)
        : undefined,
    );

    await expect(removeWorktree({ repository, directory: candidate, force: true, deleteBranch: true })).resolves.toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `worktree remove --force ${candidate}`)).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === "branch -D friday/candidate")).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === "worktree prune")).toBe(true);
  });

  it("refuses to reset the primary worktree", async () => {
    const repository = await temp("friday-worktrees-repo-");
    gitBase(repository);
    await expect(resetWorktree({ repository, directory: repository })).rejects.toBeInstanceOf(WorktreeResetError);
  });

  it("hard-resets, cleans, restores submodules, and verifies cleanliness", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) => {
      if (call.args[0] === "worktree" && call.args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD bbb\ndetached\n`);
      }
      return undefined;
    });

    await expect(resetWorktree({ repository, directory: candidate, baseRef: "main" })).resolves.toBe(true);
    expect(calls.some((call) => call.cwd === candidate && logicalGitArgs(call.args).slice(0, 2).join(" ") === "reset --hard")).toBe(true);
    expect(calls.some((call) => call.cwd === candidate && logicalGitArgs(call.args).join(" ") === "clean -ffdx")).toBe(true);
    expect(calls.some((call) => call.cwd === candidate && logicalGitArgs(call.args).join(" ") === "submodule update --init --recursive --force")).toBe(true);
    expect(calls.some((call) => call.cwd === candidate && logicalGitArgs(call.args).join(" ") === "-c core.fsmonitor=false status --porcelain=v1")).toBe(true);
  });

  it("rejects a reset that leaves local changes", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const candidate = await temp("friday-worktrees-candidate-");
    await installLinkedGitMetadata(repository, candidate);
    gitBase(repository, (call) => {
      const args = logicalGitArgs(call.args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${repository}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${candidate}\nHEAD bbb\ndetached\n`);
      }
      if (args[0] === "-c") return ok("?? leftover.txt\n");
      return undefined;
    });

    await expect(resetWorktree({ repository, directory: candidate })).rejects.toThrow("left local changes");
  });

  it("forwards abort before git execution", async () => {
    const repository = await temp("friday-worktrees-repo-");
    const root = await temp("friday-worktrees-root-");
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    install(() => {
      invoked = true;
      return ok();
    });

    await expect(makeWorktreeInfo({ repository, root, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(invoked).toBe(false);
  });
});
