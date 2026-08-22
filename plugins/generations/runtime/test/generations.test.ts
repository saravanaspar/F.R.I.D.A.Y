import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GenerationsConflictError,
  GenerationsManager,
  GenerationsRepositoryError,
  GenerationsStateError,
  createEmptyGenerationsState,
  createGenerationsManager,
  getGenerationsStatePath,
  installExecutionAccess,
  loadGenerationsState,
  saveGenerationsState,
  saveRollbackTransaction,
  getRollbackTransactionPath,
  uninstallExecutionAccess,
} from "../src/index.js";
import type { GenerationsProcessResult, GenerationsState, RollbackPlan } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  uninstallExecutionAccess();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix = "friday-generations-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

class FakeGit {
  readonly repository: string;
  head = "a".repeat(40);
  clean = true;
  repositoryValid = true;
  readonly refs = new Map<string, string>();
  readonly knownCommits = new Set<string>();
  readonly ancestors = new Set<string>();
  readonly calls: string[][] = [];
  failUpdateRef = false;
  failDeleteRef = false;
  failMerge = false;
  failReset = false;
  afterUpdateRef: (() => void) | undefined;
  afterMerge: (() => void) | undefined;

  constructor(repository: string) {
    this.repository = repository;
    this.knownCommits.add(this.head);
  }

  addAncestor(ancestor: string, descendant: string): void {
    this.knownCommits.add(ancestor);
    this.knownCommits.add(descendant);
    this.ancestors.add(`${ancestor}->${descendant}`);
  }

  async runProcess(command: string, args: string[]): Promise<GenerationsProcessResult> {
    this.calls.push([command, ...args]);
    if (command !== "git") return { status: 127, stdout: "", stderr: "unknown command" };

    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return this.repositoryValid
        ? { status: 0, stdout: `${this.repository}\n`, stderr: "" }
        : { status: 128, stdout: "", stderr: "not a git repository" };
    }
    if (args[0] === "status") {
      return { status: 0, stdout: this.clean ? "" : " M changed.ts\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}") {
      return { status: 0, stdout: `${this.head}\n`, stderr: "" };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "--quiet" &&
      typeof args[3] === "string"
    ) {
      const ref = args[3].replace(/\^\{commit\}$/, "");
      const commit = this.refs.get(ref) ?? (this.knownCommits.has(ref) ? ref : undefined);
      return commit
        ? { status: 0, stdout: `${commit}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const ancestor = args[2] ?? "";
      const descendant = args[3] ?? "";
      return {
        status: ancestor === descendant || this.ancestors.has(`${ancestor}->${descendant}`) ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    if (args[0] === "-c" && args[1] === "core.hooksPath=/dev/null" && args[2] === "merge") {
      const target = args.at(-1) ?? "";
      if (this.failMerge) return { status: 1, stdout: "", stderr: "merge failed" };
      if (!this.knownCommits.has(target) || !this.ancestors.has(`${this.head}->${target}`)) {
        return { status: 1, stdout: "", stderr: "not a fast-forward" };
      }
      this.head = target;
      this.afterMerge?.();
      return { status: 0, stdout: "Fast-forward\n", stderr: "" };
    }
    if (args[0] === "reset" && args[1] === "--hard") {
      const target = args[2] ?? "";
      if (this.failReset) return { status: 1, stdout: "", stderr: "reset failed" };
      if (!this.knownCommits.has(target)) return { status: 1, stdout: "", stderr: "unknown commit" };
      this.head = target;
      this.clean = true;
      return { status: 0, stdout: `HEAD is now at ${target}\n`, stderr: "" };
    }
    if (args[0] === "update-ref" && args[1] === "-d") {
      const ref = args[2] ?? "";
      const expected = args[3] ?? "";
      if (this.failDeleteRef) return { status: 1, stdout: "", stderr: "delete failed" };
      if (this.refs.get(ref) !== expected) return { status: 1, stdout: "", stderr: "mismatch" };
      this.refs.delete(ref);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "update-ref") {
      if (this.failUpdateRef) return { status: 1, stdout: "", stderr: "update failed" };
      const ref = args[1] ?? "";
      const commit = args[2] ?? "";
      this.knownCommits.add(commit);
      this.refs.set(ref, commit);
      this.afterUpdateRef?.();
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `unexpected git args: ${args.join(" ")}` };
  }
}

async function harness(): Promise<{ repository: string; stateDir: string; git: FakeGit }> {
  const repository = await tempDir("friday-generation-repo-");
  const stateDir = await tempDir("friday-generation-state-");
  const git = new FakeGit(repository);
  installExecutionAccess({ runProcess: (command, args) => git.runProcess(command, args) });
  return { repository, stateDir, git };
}

async function twoGenerations() {
  const ctx = await harness();
  let tick = 0;
  const manager = createGenerationsManager({
    repository: ctx.repository,
    stateDir: ctx.stateDir,
    now: () => `2026-08-18T00:00:0${tick++}.000Z`,
  });
  const first = await manager.checkpointCurrent({ label: "baseline" });
  const secondCommit = "b".repeat(40);
  ctx.git.addAncestor(first.commit, secondCommit);
  ctx.git.head = secondCommit;
  const second = await manager.checkpointCurrent({ label: "next" });
  return { ...ctx, manager, first, second };
}

describe("generations state", () => {
  it("uses one stable state file name", async () => {
    const dir = await tempDir();
    expect(getGenerationsStatePath(dir)).toBe(join(dir, "generations.json"));
  });

  it("starts with an empty schema", () => {
    expect(createEmptyGenerationsState()).toEqual({
      schema: 1,
      nextSequence: 1,
      activeGenerationId: undefined,
      generations: {},
    });
  });

  it("atomically replaces state and preserves private permissions", async () => {
    const dir = await tempDir();
    const state = createEmptyGenerationsState();
    const path = saveGenerationsState(dir, state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o640);
    state.nextSequence = 2;
    saveGenerationsState(dir, state);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readFileSync(path, "utf8")).toMatch(/\"nextSequence\": 2/);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("fails closed on corrupt JSON instead of silently losing generation history", async () => {
    const dir = await tempDir();
    await writeFile(getGenerationsStatePath(dir), "{not json");
    expect(() => loadGenerationsState(dir)).toThrow(/failed to parse generations state/);
  });

  it("rejects unsupported schemas", async () => {
    const dir = await tempDir();
    await writeFile(getGenerationsStatePath(dir), JSON.stringify({ schema: 2, generations: {} }));
    expect(() => loadGenerationsState(dir)).toThrow(/unsupported or malformed/);
  });

  it("rejects a missing active pointer for non-empty history", async () => {
    const dir = await tempDir();
    const record = {
      id: "gen-000001",
      sequence: 1,
      repository: "/repo",
      commit: "a".repeat(40),
      ref: "refs/friday/generations/gen-000001",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      getGenerationsStatePath(dir),
      JSON.stringify({ schema: 1, nextSequence: 2, generations: { [record.id]: record } }),
    );
    expect(() => loadGenerationsState(dir)).toThrow(/requires an active generation/);
  });

  it("rejects generation records that point outside the reserved git ref namespace", async () => {
    const dir = await tempDir();
    const record = {
      id: "gen-000001",
      sequence: 1,
      repository: "/repo",
      commit: "a".repeat(40),
      ref: "refs/heads/main",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      getGenerationsStatePath(dir),
      JSON.stringify({
        schema: 1,
        nextSequence: 2,
        activeGenerationId: record.id,
        generations: { [record.id]: record },
      }),
    );
    expect(() => loadGenerationsState(dir)).toThrow(/unexpected ref/);
  });

  it("rejects records with missing parents", async () => {
    const dir = await tempDir();
    const record = {
      id: "gen-000001",
      sequence: 1,
      repository: "/repo",
      commit: "a".repeat(40),
      ref: "refs/friday/generations/gen-000001",
      parentId: "gen-000000",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      getGenerationsStatePath(dir),
      JSON.stringify({
        schema: 1,
        nextSequence: 2,
        activeGenerationId: record.id,
        generations: { [record.id]: record },
      }),
    );
    expect(() => loadGenerationsState(dir)).toThrow(/missing parent/);
  });

  it("rejects nextSequence values that could reuse recorded generation ids", async () => {
    const dir = await tempDir();
    const record = {
      id: "gen-000001",
      sequence: 1,
      repository: "/repo",
      commit: "a".repeat(40),
      ref: "refs/friday/generations/gen-000001",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      getGenerationsStatePath(dir),
      JSON.stringify({
        schema: 1,
        nextSequence: 1,
        activeGenerationId: record.id,
        generations: { [record.id]: record },
      }),
    );
    expect(() => loadGenerationsState(dir)).toThrow(/nextSequence must be greater/);
  });

  it("rejects generation ids that do not match their recorded sequence", async () => {
    const dir = await tempDir();
    const base = {
      sequence: 1,
      repository: "/repo",
      commit: "a".repeat(40),
      ref: "refs/friday/generations/gen-000001",
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      getGenerationsStatePath(dir),
      JSON.stringify({
        schema: 1,
        nextSequence: 3,
        activeGenerationId: "gen-000002",
        generations: {
          "gen-000001": { ...base, id: "gen-000001" },
          "gen-000002": { ...base, id: "gen-000002", ref: "refs/friday/generations/gen-000002" },
        },
      }),
    );
    expect(() => loadGenerationsState(dir)).toThrow(/does not match sequence/);
  });
});

describe("generation checkpointing", () => {
  it("requires repository and state directory options", async () => {
    const dir = await tempDir();
    expect(() => new GenerationsManager({ repository: "", stateDir: dir })).toThrow(/repository/);
    expect(() => new GenerationsManager({ repository: dir, stateDir: "" })).toThrow(/state directory/);
  });

  it("rejects a non-git repository", async () => {
    const { repository, stateDir, git } = await harness();
    git.repositoryValid = false;
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/not a git repository/);
  });

  it("requires the configured repository to be the git worktree root", async () => {
    const { repository, stateDir, git } = await harness();
    const different = await tempDir("different-root-");
    git.repositoryValid = true;
    installExecutionAccess({
      runProcess: async (command, args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { status: 0, stdout: `${different}\n`, stderr: "" };
        }
        return git.runProcess(command, args);
      },
    });
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/must be the git worktree root/);
  });

  it("refuses to checkpoint dirty tracked changes", async () => {
    const { repository, stateDir, git } = await harness();
    git.clean = false;
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/require a clean repository/);
  });

  it("creates and pins the first clean HEAD as the active generation", async () => {
    const { repository, stateDir, git } = await harness();
    const manager = createGenerationsManager({
      repository,
      stateDir,
      now: () => "2026-08-18T00:00:00.000Z",
    });
    const generation = await manager.checkpointCurrent({ label: " baseline " });
    expect(generation).toEqual({
      id: "gen-000001",
      sequence: 1,
      repository,
      commit: git.head,
      ref: "refs/friday/generations/gen-000001",
      parentId: undefined,
      label: "baseline",
      createdAt: "2026-08-18T00:00:00.000Z",
    });
    expect(git.refs.get(generation.ref)).toBe(generation.commit);
    expect(manager.getActiveGeneration()).toEqual(generation);
  });

  it("is idempotent when HEAD already matches the active generation", async () => {
    const { repository, stateDir, git } = await harness();
    const manager = createGenerationsManager({ repository, stateDir });
    const first = await manager.checkpointCurrent();
    const second = await manager.checkpointCurrent({ label: "ignored because this is the same generation" });
    expect(second).toEqual(first);
    expect(manager.listGenerations()).toHaveLength(1);
    expect(git.calls.filter((call) => call[1] === "update-ref")).toHaveLength(1);
  });

  it("refuses idempotency when the active pin ref was lost", async () => {
    const { repository, stateDir, git } = await harness();
    const manager = createGenerationsManager({ repository, stateDir });
    const first = await manager.checkpointCurrent();
    git.refs.delete(first.ref);
    await expect(manager.checkpointCurrent()).rejects.toThrow(/not pinned/);
  });

  it("records a clean descendant HEAD as the next generation", async () => {
    const { manager, first, second } = await twoGenerations();
    expect(second.id).toBe("gen-000002");
    expect(second.sequence).toBe(2);
    expect(second.parentId).toBe(first.id);
    expect(manager.getState().nextSequence).toBe(3);
    expect(manager.getActiveGeneration()?.id).toBe(second.id);
  });

  it("refuses divergent HEAD history", async () => {
    const { repository, stateDir, git } = await harness();
    const manager = createGenerationsManager({ repository, stateDir });
    await manager.checkpointCurrent();
    git.head = "c".repeat(40);
    await expect(manager.checkpointCurrent()).rejects.toThrow(/not a descendant/);
  });

  it("refuses to duplicate a commit that already belongs to an older generation", async () => {
    const { manager, first, git } = await twoGenerations();
    git.head = first.commit;
    await expect(manager.checkpointCurrent()).rejects.toThrow(/already recorded/);
  });

  it("skips a generation id whose git ref already exists", async () => {
    const { repository, stateDir, git } = await harness();
    git.refs.set("refs/friday/generations/gen-000001", "f".repeat(40));
    const manager = createGenerationsManager({ repository, stateDir });
    const generation = await manager.checkpointCurrent();
    expect(generation.id).toBe("gen-000002");
    expect(generation.sequence).toBe(2);
  });

  it("bounds checkpoint labels", async () => {
    const { repository, stateDir } = await harness();
    const manager = createGenerationsManager({ repository, stateDir });
    const generation = await manager.checkpointCurrent({ label: `  ${"x".repeat(300)}  ` });
    expect(generation.label).toHaveLength(240);
  });

  it("persists and reopens generation history", async () => {
    const { repository, stateDir, manager, second } = await twoGenerations();
    const reopened = createGenerationsManager({ repository, stateDir });
    expect(reopened.getActiveGeneration()).toEqual(second);
    expect(reopened.listGenerations()).toEqual(manager.listGenerations());
  });

  it("returns defensive generation and state snapshots", async () => {
    const { manager, first } = await twoGenerations();
    const generation = manager.getGeneration(first.id);
    const state = manager.getState();
    if (!generation) throw new Error("missing generation");
    generation.commit = "mutated";
    state.generations[first.id]!.commit = "mutated";
    expect(manager.getGeneration(first.id)?.commit).toBe(first.commit);
  });

  it("sorts generation history by sequence", async () => {
    const { manager } = await twoGenerations();
    expect(manager.listGenerations().map((generation) => generation.sequence)).toEqual([1, 2]);
  });

  it("cleans up the pin if repository HEAD changes before checkpoint publication", async () => {
    const { repository, stateDir, git } = await harness();
    git.afterUpdateRef = () => {
      git.head = "9".repeat(40);
    };
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/HEAD changed/);
    expect(git.refs.size).toBe(0);
    expect(existsSync(getGenerationsStatePath(stateDir))).toBe(false);
  });

  it("cleans up a newly pinned ref when cancellation arrives immediately after pinning", async () => {
    const { repository, stateDir, git } = await harness();
    const controller = new AbortController();
    git.afterUpdateRef = () => controller.abort(new Error("cancel after pin"));
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent({ signal: controller.signal })).rejects.toThrow(/cancel after pin/);
    expect(git.refs.size).toBe(0);
    expect(existsSync(getGenerationsStatePath(stateDir))).toBe(false);
  });

  it("cleans up a newly pinned ref when state persistence fails", async () => {
    const repository = await tempDir("friday-generation-repo-");
    const badStateDir = join(await tempDir("friday-generation-parent-"), "state-file");
    writeFileSync(badStateDir, "not a directory");
    const git = new FakeGit(repository);
    installExecutionAccess({ runProcess: (command, args) => git.runProcess(command, args) });
    const manager = createGenerationsManager({ repository, stateDir: badStateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow();
    expect(git.refs.size).toBe(0);
  });

  it("reports cleanup failure when persistence and ref cleanup both fail", async () => {
    const repository = await tempDir("friday-generation-repo-");
    const badStateDir = join(await tempDir("friday-generation-parent-"), "state-file");
    writeFileSync(badStateDir, "not a directory");
    const git = new FakeGit(repository);
    git.failDeleteRef = true;
    installExecutionAccess({ runProcess: (command, args) => git.runProcess(command, args) });
    const manager = createGenerationsManager({ repository, stateDir: badStateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/cleanup also failed/);
  });

  it("surfaces ref creation failures without persisting generation state", async () => {
    const { repository, stateDir, git } = await harness();
    git.failUpdateRef = true;
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/update failed/);
    expect(existsSync(getGenerationsStatePath(stateDir))).toBe(false);
  });

  it("forwards an already-aborted signal before git execution", async () => {
    const { repository, stateDir, git } = await harness();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent({ signal: controller.signal })).rejects.toThrow(/stop/);
    expect(git.calls).toHaveLength(0);
  });
});

describe("generation activation", () => {
  async function baselineWithTarget() {
    const ctx = await harness();
    const manager = createGenerationsManager({ repository: ctx.repository, stateDir: ctx.stateDir });
    const baseline = await manager.checkpointCurrent({ label: "baseline" });
    const target = "b".repeat(40);
    ctx.git.addAncestor(baseline.commit, target);
    return { ...ctx, manager, baseline, target };
  }

  it("requires an active baseline generation", async () => {
    const { repository, stateDir, git } = await harness();
    const target = "b".repeat(40);
    git.addAncestor(git.head, target);
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: git.head })).rejects.toThrow(/active baseline/);
  });

  it("fast-forwards a verified descendant and publishes the next generation", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    const generation = await manager.activateDescendant({
      targetCommit: target,
      expectedBaseCommit: baseline.commit,
      label: "candidate",
    });
    expect(generation).toMatchObject({
      id: "gen-000002",
      sequence: 2,
      commit: target,
      parentId: baseline.id,
      label: "candidate",
    });
    expect(git.head).toBe(target);
    expect(git.refs.get(generation.ref)).toBe(target);
    expect(manager.getActiveGeneration()).toEqual(generation);
    expect(git.calls.some((call) => call.includes("merge") && call.includes("--ff-only"))).toBe(true);
  });

  it("resumes an interrupted activation that pinned the target before moving HEAD", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    const pendingRef = "refs/friday/generations/gen-000002";
    git.refs.set(pendingRef, target);
    const generation = await manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit });
    expect(generation.id).toBe("gen-000002");
    expect(generation.ref).toBe(pendingRef);
    expect(git.head).toBe(target);
    expect(git.calls.some((call) => call.includes("merge") && call.includes("--ff-only"))).toBe(true);
    expect(manager.listGenerations()).toHaveLength(2);
  });

  it("publishes an interrupted activation when the pinned target already moved HEAD", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    const pendingRef = "refs/friday/generations/gen-000002";
    git.refs.set(pendingRef, target);
    git.head = target;
    const callCount = git.calls.length;
    const generation = await manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit });
    expect(generation.id).toBe("gen-000002");
    expect(generation.ref).toBe(pendingRef);
    expect(git.calls.slice(callCount).some((call) => call.includes("merge"))).toBe(false);
    expect(manager.getActiveGeneration()).toEqual(generation);
  });

  it("is idempotent when the requested descendant is already the active child of the expected base", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    const first = await manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit });
    const callCount = git.calls.length;
    const second = await manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit });
    expect(second).toEqual(first);
    expect(git.calls.slice(callCount).some((call) => call.includes("merge"))).toBe(false);
    expect(manager.listGenerations()).toHaveLength(2);
  });

  it("rejects a stale expected base", async () => {
    const { manager, target } = await baselineWithTarget();
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: "c".repeat(40) })).rejects.toThrow(/not candidate base/);
  });

  it("rejects an unresolved activation target", async () => {
    const { manager, baseline } = await baselineWithTarget();
    await expect(manager.activateDescendant({ targetCommit: "f".repeat(40), expectedBaseCommit: baseline.commit })).rejects.toThrow(/does not resolve/);
  });

  it("rejects a target that is not a descendant of the active generation", async () => {
    const { manager, baseline, git } = await baselineWithTarget();
    const target = "c".repeat(40);
    git.knownCommits.add(target);
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit })).rejects.toThrow(/not a descendant/);
  });

  it("refuses activation while the primary repository is dirty", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    git.clean = false;
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit })).rejects.toThrow(/clean repository/);
    expect(git.head).toBe(baseline.commit);
  });

  it("deletes the unpublished pin if the fast-forward fails", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    git.failMerge = true;
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit })).rejects.toThrow(/merge failed/);
    expect(git.head).toBe(baseline.commit);
    expect(git.refs.size).toBe(1);
    expect(manager.listGenerations()).toHaveLength(1);
  });

  it("restores HEAD and removes the pin if generation-state publication fails", async () => {
    const { manager, baseline, target, git, stateDir } = await baselineWithTarget();
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, "not a directory");
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit })).rejects.toThrow();
    expect(git.head).toBe(baseline.commit);
    expect(git.refs.size).toBe(1);
    expect(manager.getActiveGeneration()?.id).toBe(baseline.id);
  });

  it("restores HEAD and removes the pin when cancellation arrives after fast-forward", async () => {
    const { manager, baseline, target, git } = await baselineWithTarget();
    const controller = new AbortController();
    git.afterMerge = () => controller.abort(new Error("cancel after activation"));
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit, signal: controller.signal })).rejects.toThrow(/cancel after activation/);
    expect(git.head).toBe(baseline.commit);
    expect(git.refs.size).toBe(1);
    expect(manager.getActiveGeneration()?.id).toBe(baseline.id);
  });

  it("reports incomplete cleanup if activation recovery cannot restore HEAD", async () => {
    const { manager, baseline, target, git, stateDir } = await baselineWithTarget();
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, "not a directory");
    git.failReset = true;
    await expect(manager.activateDescendant({ targetCommit: target, expectedBaseCommit: baseline.commit })).rejects.toBeInstanceOf(AggregateError);
    expect(git.head).toBe(target);
    expect(git.refs.size).toBe(1);
  });
});

describe("generation verification and rollback planning", () => {
  it("verifies that a generation pin resolves to its recorded commit", async () => {
    const { manager, first } = await twoGenerations();
    await expect(manager.verifyGeneration(first.id)).resolves.toEqual(first);
  });

  it("rejects a generation whose pin was changed", async () => {
    const { manager, first, git } = await twoGenerations();
    git.refs.set(first.ref, "f".repeat(40));
    await expect(manager.verifyGeneration(first.id)).rejects.toThrow(/does not resolve/);
  });

  it("lists only prior active-lineage generations as rollback targets", async () => {
    const { manager, first } = await twoGenerations();
    expect(manager.listRollbackTargets().map((generation) => generation.id)).toEqual([first.id]);
  });

  it("rejects an unknown rollback target", async () => {
    const { manager } = await twoGenerations();
    await expect(manager.planRollback({ targetGenerationId: "missing" })).rejects.toThrow(/not found/);
  });

  it("rejects rollback to the already active generation", async () => {
    const { manager, second } = await twoGenerations();
    await expect(manager.planRollback({ targetGenerationId: second.id })).rejects.toThrow(/already active/);
  });

  it("creates a non-mutating rollback plan for an ancestor generation", async () => {
    const { manager, first, second, git } = await twoGenerations();
    const before = manager.getState();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    expect(plan).toEqual({
      activeGenerationId: second.id,
      targetGenerationId: first.id,
      expectedHeadCommit: second.commit,
      targetCommit: first.commit,
      targetRef: first.ref,
      plannedAt: "2026-08-18T00:00:02.000Z",
    });
    expect(manager.getState()).toEqual(before);
    expect(git.head).toBe(second.commit);
  });

  it("refuses rollback planning when repository HEAD no longer matches active state", async () => {
    const { manager, first, git } = await twoGenerations();
    git.head = "d".repeat(40);
    await expect(manager.planRollback({ targetGenerationId: first.id })).rejects.toThrow(/does not match active/);
  });

  it("refuses rollback planning when the target pin is missing", async () => {
    const { manager, first, git } = await twoGenerations();
    git.refs.delete(first.ref);
    await expect(manager.planRollback({ targetGenerationId: first.id })).rejects.toThrow(/not pinned/);
  });

  it("validates a fresh rollback plan", async () => {
    const { manager, first } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    const validation = await manager.validateRollbackPlan({ plan });
    expect(validation.valid).toBe(true);
    expect(validation.target.id).toBe(first.id);
  });

  it("rejects a rollback plan after repository HEAD changes", async () => {
    const { manager, first, git } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    git.head = "e".repeat(40);
    await expect(manager.validateRollbackPlan({ plan })).rejects.toThrow(/HEAD changed/);
  });


  it("executes an ancestor rollback transactionally and clears its journal", async () => {
    const { manager, first, second, git, stateDir } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    const result = await manager.executeRollback({ plan });
    expect(result).toMatchObject({ recovered: false, active: { id: second.id }, target: { id: first.id } });
    expect(git.head).toBe(first.commit);
    expect(manager.getActiveGeneration()?.id).toBe(first.id);
    expect(existsSync(getRollbackTransactionPath(stateDir))).toBe(false);
    expect(git.calls.some((call) => call[1] === "reset" && call[2] === "--hard" && call[3] === first.commit)).toBe(true);
  });

  it("recovers a crash after HEAD moved but before active-generation publication", async () => {
    const { manager, first, second, git, stateDir } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    saveRollbackTransaction(stateDir, {
      schema: 1,
      id: "rollback-crash-window",
      phase: "head-moved",
      plan,
      createdAt: "2026-08-18T00:00:03.000Z",
      updatedAt: "2026-08-18T00:00:04.000Z",
    });
    git.head = first.commit;
    const reopened = createGenerationsManager({ repository: git.repository, stateDir });
    const recovered = await reopened.recoverInterruptedRollback();
    expect(recovered).toMatchObject({ recovered: true, active: { id: second.id }, target: { id: first.id } });
    expect(reopened.getActiveGeneration()?.id).toBe(first.id);
    expect(git.head).toBe(first.commit);
    expect(existsSync(getRollbackTransactionPath(stateDir))).toBe(false);
  });

  it("rejects a rollback plan whose recorded target was tampered", async () => {
    const { manager, first } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    const tampered: RollbackPlan = { ...plan, targetCommit: "0".repeat(40) };
    await expect(manager.validateRollbackPlan({ plan: tampered })).rejects.toThrow(/no longer matches/);
  });

  it("rejects a rollback plan when its target ref changes", async () => {
    const { manager, first, git } = await twoGenerations();
    const plan = await manager.planRollback({ targetGenerationId: first.id });
    git.refs.set(first.ref, "f".repeat(40));
    await expect(manager.validateRollbackPlan({ plan })).rejects.toThrow(/target ref changed/);
  });
});

describe("capability port", () => {
  it("fails clearly when execution access is not installed", async () => {
    const repository = await tempDir();
    const stateDir = await tempDir();
    uninstallExecutionAccess();
    const manager = createGenerationsManager({ repository, stateDir });
    await expect(manager.checkpointCurrent()).rejects.toThrow(/execution access is not installed/);
  });
});
