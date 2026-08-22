import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_IMPROVEMENT_STATE_FILE_NAME,
  SelfImprovementManager,
  createEmptySelfImprovementState,
  createSelfImprovementManager,
  evaluateCandidateChecks,
  getSelfImprovementStatePath,
  installEvaluationAccess,
  installGenerationsAccess,
  installWorktreesAccess,
  loadSelfImprovementState,
  saveSelfImprovementState,
  uninstallEvaluationAccess,
  uninstallGenerationsAccess,
  uninstallWorktreesAccess,
} from "../src/index.js";
import type {
  CandidateEvaluationResult,
  CandidateEvaluationSummary,
  CandidateRecord,
  CandidateWorktreeCreateOptions,
  CandidateWorktreeInspectOptions,
  CandidateWorktreeRemoveOptions,
  CandidateWorktreeSnapshot,
  GenerationHandoffRecord,
  SelfImprovementGenerationRecord,
} from "../src/types.js";

const tempPaths: string[] = [];

afterEach(async () => {
  uninstallEvaluationAccess();
  uninstallGenerationsAccess();
  uninstallWorktreesAccess();
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

function passingResult(id = "check"): CandidateEvaluationResult {
  return {
    id,
    command: "npm test",
    status: "pass",
    score: 1,
    exitCode: 0,
    exitText: "exited 0",
    output: "ok",
    outputTruncated: false,
    durationMs: 5,
  };
}

function summary(overrides: Partial<CandidateEvaluationSummary> = {}): CandidateEvaluationSummary {
  return {
    total: 1,
    passed: 1,
    partial: 0,
    failed: 0,
    timedOut: 0,
    errors: 0,
    noScore: 0,
    scoreTotal: 1,
    scored: 1,
    averageScore: 1,
    durationMs: 5,
    ...overrides,
  };
}

function installDefaultWorktrees(overrides: {
  onCreate?: (options: CandidateWorktreeCreateOptions) => void;
  onInspect?: (options: CandidateWorktreeInspectOptions) => void;
  onRemove?: (options: CandidateWorktreeRemoveOptions) => void;
  inspect?: CandidateWorktreeSnapshot | (() => CandidateWorktreeSnapshot);
  removeError?: Error;
} = {}): {
  creates: CandidateWorktreeCreateOptions[];
  inspections: CandidateWorktreeInspectOptions[];
  removes: CandidateWorktreeRemoveOptions[];
} {
  const creates: CandidateWorktreeCreateOptions[] = [];
  let defaultBranch = "friday/candidate-worktree";
  const inspections: CandidateWorktreeInspectOptions[] = [];
  const removes: CandidateWorktreeRemoveOptions[] = [];
  installWorktreesAccess({
    async createWorktree(options) {
      creates.push(structuredClone(options));
      overrides.onCreate?.(options);
      defaultBranch = `friday/${options.name ?? "candidate-worktree"}`;
      return {
        name: options.name ?? "candidate-worktree",
        directory: "/tmp/candidate-worktree",
        baseCommit: "abc123",
        branch: defaultBranch,
      };
    },
    async inspectWorktree(options) {
      inspections.push(structuredClone(options));
      overrides.onInspect?.(options);
      const snapshot = typeof overrides.inspect === "function" ? overrides.inspect() : overrides.inspect;
      return snapshot ?? {
        directory: options.directory,
        head: "def456",
        branch: defaultBranch,
        clean: true,
      };
    },
    async removeWorktree(options) {
      removes.push(structuredClone(options));
      overrides.onRemove?.(options);
      if (overrides.removeError) throw overrides.removeError;
      return true;
    },
  });
  return { creates, inspections, removes };
}

function generation(
  id: string,
  commit: string,
  parentId: string | undefined,
): SelfImprovementGenerationRecord {
  return { id, commit, parentId };
}

function installDefaultGenerations(overrides: {
  active?: SelfImprovementGenerationRecord | undefined;
  checkpoint?: SelfImprovementGenerationRecord | undefined;
  activate?: SelfImprovementGenerationRecord | undefined;
  activateError?: Error | undefined;
} = {}): {
  opens: Array<{ repository: string; stateDir: string }>;
  checkpoints: Array<{ label?: string | undefined; signal?: AbortSignal | undefined } | undefined>;
  activations: Array<{
    targetCommit: string;
    expectedBaseCommit: string;
    label?: string | undefined;
    signal?: AbortSignal | undefined;
  }>;
} {
  const opens: Array<{ repository: string; stateDir: string }> = [];
  const checkpoints: Array<{ label?: string | undefined; signal?: AbortSignal | undefined } | undefined> = [];
  const activations: Array<{
    targetCommit: string;
    expectedBaseCommit: string;
    label?: string | undefined;
    signal?: AbortSignal | undefined;
  }> = [];
  let active = overrides.active;
  installGenerationsAccess({
    openManager(options) {
      opens.push(structuredClone(options));
      return {
        getActiveGeneration() {
          return active;
        },
        async checkpointCurrent(options) {
          checkpoints.push(options === undefined ? undefined : { ...options });
          active = overrides.checkpoint ?? generation("gen-000001", "abc123", undefined);
          return active;
        },
        async activateDescendant(options) {
          activations.push({ ...options });
          if (overrides.activateError) throw overrides.activateError;
          active = overrides.activate ?? generation("gen-000002", options.targetCommit, "gen-000001");
          return active;
        },
        async planRollback(options) {
          if (!active) throw new Error("no active generation");
          return {
            activeGenerationId: active.id,
            targetGenerationId: options.targetGenerationId,
            expectedHeadCommit: active.commit,
            targetCommit: "abc123",
            targetRef: `refs/friday/generations/${options.targetGenerationId}`,
            plannedAt: "2026-08-18T00:00:00.000Z",
          };
        },
        async executeRollback(options) {
          active = generation(options.plan.targetGenerationId, options.plan.targetCommit, undefined);
          return { target: active, recovered: false };
        },
      };
    },
  });
  return { opens, checkpoints, activations };
}

function installPassingEvaluation(onRun?: (specs: readonly { cwd: string; command: string }[]) => void): void {
  installEvaluationAccess({
    async runCommandEvaluationSuite(specs) {
      onRun?.(specs);
      return { results: specs.map((spec, index) => passingResult(spec.id ?? `check-${index + 1}`)), summary: summary({ total: specs.length, passed: specs.length, scoreTotal: specs.length, scored: specs.length }) };
    },
  });
}

async function createdManager(options: ConstructorParameters<typeof SelfImprovementManager>[0] = {}): Promise<{ manager: SelfImprovementManager; candidate: CandidateRecord }> {
  installDefaultWorktrees();
  const manager = new SelfImprovementManager({ idFactory: () => "cand_test", ...options });
  const candidate = await manager.createCandidate({
    objective: "Improve reliability",
    repository: "/repo",
    worktreeRoot: "/worktrees",
    name: "reliability",
  });
  return { manager, candidate };
}

describe("self-improvement state", () => {
  it("uses one stable state file name", () => {
    expect(SELF_IMPROVEMENT_STATE_FILE_NAME).toBe("candidates.json");
    expect(getSelfImprovementStatePath("/tmp/state")).toBe(join("/tmp/state", "candidates.json"));
  });

  it("starts with an empty schema", () => {
    expect(createEmptySelfImprovementState()).toEqual({ schema: 1, candidates: {}, handoffs: {} });
  });

  it("creates a private state directory and fails closed if it later becomes broad", async () => {
    const root = await tempDir("friday-self-private-root-");
    const stateDir = join(root, "self-improvement");
    saveSelfImprovementState(stateDir, createEmptySelfImprovementState());
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);

    chmodSync(stateDir, 0o755);
    expect(() => loadSelfImprovementState(stateDir)).toThrow("Self-improvement state directory permissions are too broad");
  });

  it("atomically replaces state and preserves permissions", async () => {
    const stateDir = await tempDir("friday-self-state-");
    const state = createEmptySelfImprovementState();
    saveSelfImprovementState(stateDir, state);
    const path = getSelfImprovementStatePath(stateDir);
    chmodSync(path, 0o640);
    state.candidates.example = {
      id: "example",
      objective: "test",
      repository: "/repo",
      worktreeRoot: "/worktrees",
      worktreeName: "example",
      directory: "/worktrees/example",
      baseCommit: "abc",
      branch: "friday/example",
      status: "created",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
      evaluation: undefined,
      lastError: undefined,
    };
    saveSelfImprovementState(stateDir, state);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(stateDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["not json", "null", "[]", '"string"'])
  ("fails closed on corrupt or non-object state (%s)", async (content) => {
    const stateDir = await tempDir("friday-self-corrupt-");
    writeFileSync(getSelfImprovementStatePath(stateDir), content);
    expect(() => loadSelfImprovementState(stateDir)).toThrow(/parse|malformed/i);
  });

  it("fails closed on malformed candidate records", async () => {
    const stateDir = await tempDir("friday-self-malformed-");
    writeFileSync(
      getSelfImprovementStatePath(stateDir),
      JSON.stringify({ schema: 1, candidates: { bad: { status: "created" } } }),
    );
    expect(() => loadSelfImprovementState(stateDir)).toThrow(/malformed self-improvement candidate/i);
  });

  it("fails closed on malformed generation handoff records", async () => {
    const stateDir = await tempDir("friday-self-malformed-handoff-");
    const state = createEmptySelfImprovementState();
    state.candidates.valid = {
      id: "valid", objective: "continue", repository: "/repo", worktreeRoot: "/root", worktreeName: "valid",
      directory: "/root/valid", baseCommit: "abc", branch: "friday/valid", status: "promoted",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 2,
      evaluation: undefined, promotedGenerationId: "gen-000002", promotedCommit: "def",
      promotedAt: "2026-01-01T00:00:00.000Z", lastError: undefined,
    };
    const raw = { ...state, handoffs: { bad: { status: "pending" } } };
    writeFileSync(getSelfImprovementStatePath(stateDir), JSON.stringify(raw));
    expect(() => loadSelfImprovementState(stateDir)).toThrow(/malformed self-improvement generation handoff/i);
  });
});

describe("candidate creation and registry", () => {
  it("requires an objective", async () => {
    installDefaultWorktrees();
    const manager = createSelfImprovementManager();
    await expect(manager.createCandidate({ objective: "   ", repository: "/repo", worktreeRoot: "/root" })).rejects.toThrow("objective");
  });

  it("requires a repository", async () => {
    installDefaultWorktrees();
    const manager = createSelfImprovementManager();
    await expect(manager.createCandidate({ objective: "x", repository: "  ", worktreeRoot: "/root" })).rejects.toThrow("repository");
  });

  it("requires a worktree root", async () => {
    installDefaultWorktrees();
    const manager = createSelfImprovementManager();
    await expect(manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "" })).rejects.toThrow("worktree root");
  });

  it("creates a branch-backed isolated candidate through the worktrees port", async () => {
    const { creates } = installDefaultWorktrees();
    const manager = new SelfImprovementManager({ idFactory: () => "cand_a", now: () => "2026-08-18T00:00:00.000Z" });
    const candidate = await manager.createCandidate({
      objective: "  Improve tests  ",
      repository: " /repo ",
      worktreeRoot: " /root ",
      name: "tests",
      baseRef: "main",
    });
    expect(creates).toEqual([{ repository: "/repo", root: "/root", name: "tests", baseRef: "main" }]);
    expect(candidate).toMatchObject({
      id: "cand_a",
      objective: "Improve tests",
      repository: "/repo",
      worktreeRoot: "/root",
      worktreeName: "tests",
      directory: "/tmp/candidate-worktree",
      baseCommit: "abc123",
      branch: "friday/tests",
      status: "created",
      version: 1,
    });
  });

  it("retries colliding candidate ids", async () => {
    installDefaultWorktrees();
    const ids = ["same", "same", "second"];
    const manager = new SelfImprovementManager({ idFactory: () => ids.shift() ?? "fallback" });
    const first = await manager.createCandidate({ objective: "one", repository: "/repo", worktreeRoot: "/root", name: "one" });
    const second = await manager.createCandidate({ objective: "two", repository: "/repo", worktreeRoot: "/root", name: "two" });
    expect(first.id).toBe("same");
    expect(second.id).toBe("second");
  });

  it("persists and reopens candidate history", async () => {
    const stateDir = await tempDir("friday-self-persist-");
    installDefaultWorktrees();
    const manager = new SelfImprovementManager({ stateDir, idFactory: () => "persisted" });
    await manager.createCandidate({ objective: "persist me", repository: "/repo", worktreeRoot: "/root" });
    const reopened = new SelfImprovementManager({ stateDir });
    expect(reopened.getCandidate("persisted")?.objective).toBe("persist me");
  });

  it("returns defensive candidate and state snapshots", async () => {
    const { manager, candidate } = await createdManager();
    const fetched = manager.getCandidate(candidate.id)!;
    fetched.objective = "mutated";
    const listed = manager.listCandidates();
    listed[0]!.status = "abandoned";
    const snapshot = manager.snapshot();
    snapshot.candidates[candidate.id]!.objective = "snapshot mutation";
    expect(manager.getCandidate(candidate.id)?.objective).toBe("Improve reliability");
    expect(manager.getCandidate(candidate.id)?.status).toBe("created");
  });

  it("sorts candidate history by creation time and id", async () => {
    installDefaultWorktrees();
    const ids = ["b", "a"];
    const times = ["2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"];
    const manager = new SelfImprovementManager({ idFactory: () => ids.shift()!, now: () => times.shift()! });
    await manager.createCandidate({ objective: "later", repository: "/repo", worktreeRoot: "/root", name: "later" });
    await manager.createCandidate({ objective: "earlier", repository: "/repo", worktreeRoot: "/root", name: "earlier" });
    expect(manager.listCandidates().map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });

  it("cleans up a worktree when cancellation arrives immediately after creation", async () => {
    const controller = new AbortController();
    const { removes } = installDefaultWorktrees({ onCreate: () => controller.abort() });
    const manager = new SelfImprovementManager({ idFactory: () => "cancelled" });
    await expect(manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root", signal: controller.signal })).rejects.toThrow();
    expect(removes).toHaveLength(1);
    expect(manager.listCandidates()).toEqual([]);
  });

  it("cleans up a newly created worktree when candidate-state persistence fails", async () => {
    const parent = await tempDir("friday-self-save-fail-");
    const stateDir = join(parent, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const { removes } = installDefaultWorktrees({
      onCreate: () => chmodSync(stateDir, 0o755),
    });
    const manager = new SelfImprovementManager({ stateDir, idFactory: () => "cleanup" });
    await expect(manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" })).rejects.toThrow(
      "Self-improvement state directory permissions are too broad",
    );
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({ force: true, deleteBranch: true });
    expect(manager.listCandidates()).toEqual([]);
  });

  it("reports both persistence and cleanup failures", async () => {
    const parent = await tempDir("friday-self-save-cleanup-fail-");
    const stateDir = join(parent, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    installDefaultWorktrees({
      onCreate: () => chmodSync(stateDir, 0o755),
      removeError: new Error("cleanup failed"),
    });
    const manager = new SelfImprovementManager({ stateDir, idFactory: () => "cleanup" });
    await expect(manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" })).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("candidate evaluation", () => {
  it("rejects unknown candidates", async () => {
    installPassingEvaluation();
    const manager = createSelfImprovementManager();
    await expect(manager.evaluateCandidate({ id: "missing", checks: [{ command: "npm test" }] })).rejects.toThrow("does not exist");
  });

  it("requires at least one check", async () => {
    const { manager, candidate } = await createdManager();
    installPassingEvaluation();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [] })).rejects.toThrow("at least one check");
  });

  it("forces every evaluation check into the candidate worktree", async () => {
    const { manager, candidate } = await createdManager();
    let observed: readonly { cwd: string; command: string }[] = [];
    installPassingEvaluation((specs) => { observed = specs; });
    await manager.evaluateCandidate({
      id: candidate.id,
      checks: [
        { id: "test", command: " npm test ", timeoutMs: 1000 },
        { id: "types", command: "npm run typecheck", maxOutputChars: 2000 },
      ],
    });
    expect(observed.map((spec) => spec.cwd)).toEqual([candidate.directory, candidate.directory]);
    expect(observed.map((spec) => spec.command)).toEqual(["npm test", "npm run typecheck"]);
  });

  it("marks the candidate evaluating before invoking the evaluator", async () => {
    const { manager, candidate } = await createdManager();
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        expect(manager.getCandidate(candidate.id)?.status).toBe("evaluating");
        return { results: [passingResult()], summary: summary() };
      },
    });
    await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
  });

  it("marks an all-pass evaluation as passed and records bounded evidence", async () => {
    const { manager, candidate } = await createdManager();
    installPassingEvaluation();
    const result = await manager.evaluateCandidate({ id: candidate.id, checks: [{ id: "test", command: "npm test" }] });
    expect(result.status).toBe("passed");
    expect(result.version).toBe(3);
    expect(result.evaluation?.results[0]?.output).toBe("ok");
    expect(result.evaluation?.checks).toEqual([{ id: "test", command: "npm test" }]);
    expect(result.evaluation?.commit).toBe("def456");
  });

  it("marks partial evaluation evidence as failed", async () => {
    const { manager, candidate } = await createdManager();
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        return {
          results: [{ ...passingResult(), status: "partial", score: 0.5 }],
          summary: summary({ passed: 0, partial: 1, scoreTotal: 0.5, averageScore: 0.5 }),
        };
      },
    });
    expect((await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).status).toBe("failed");
  });

  it("marks ordinary failing checks as failed", async () => {
    const { manager, candidate } = await createdManager();
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        return {
          results: [{ ...passingResult(), status: "fail", score: 0, exitCode: 1 }],
          summary: summary({ passed: 0, failed: 1, scoreTotal: 0, averageScore: 0 }),
        };
      },
    });
    expect((await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).status).toBe("failed");
  });

  it("records evaluator exceptions as candidate errors", async () => {
    const { manager, candidate } = await createdManager();
    installEvaluationAccess({ async runCommandEvaluationSuite() { throw new Error("evaluator unavailable"); } });
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow("evaluator unavailable");
    expect(manager.getCandidate(candidate.id)).toMatchObject({ status: "error", lastError: "evaluator unavailable" });
  });

  it("rejects inconsistent evaluator result counts", async () => {
    const { manager, candidate } = await createdManager();
    installEvaluationAccess({ async runCommandEvaluationSuite() { return { results: [], summary: summary({ total: 0, passed: 0, scoreTotal: 0, scored: 0, averageScore: undefined }) }; } });
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow("inconsistent result count");
    expect(manager.getCandidate(candidate.id)?.status).toBe("error");
  });

  it("allows a failed candidate to be re-evaluated successfully", async () => {
    const { manager, candidate } = await createdManager();
    let pass = false;
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        if (pass) return { results: [passingResult()], summary: summary() };
        return {
          results: [{ ...passingResult(), status: "fail", score: 0, exitCode: 1 }],
          summary: summary({ passed: 0, failed: 1, scoreTotal: 0, averageScore: 0 }),
        };
      },
    });
    expect((await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).status).toBe("failed");
    pass = true;
    expect((await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).status).toBe("passed");
  });

  it("rejects a concurrent second evaluation", async () => {
    const { manager, candidate } = await createdManager();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        await wait;
        return { results: [passingResult()], summary: summary() };
      },
    });
    const first = manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
    await Promise.resolve();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow("already evaluating");
    release();
    await first;
  });

  it("forwards an already-aborted signal without running evaluation", async () => {
    const { manager, candidate } = await createdManager();
    let runs = 0;
    installEvaluationAccess({ async runCommandEvaluationSuite() { runs += 1; return { results: [passingResult()], summary: summary() }; } });
    const controller = new AbortController();
    controller.abort();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }], signal: controller.signal })).rejects.toThrow();
    expect(runs).toBe(0);
  });

  it("refuses to evaluate a dirty candidate worktree", async () => {
    installDefaultWorktrees({
      inspect: { directory: "/tmp/candidate-worktree", head: "def456", branch: "friday/reliability", clean: false },
    });
    const manager = new SelfImprovementManager({ idFactory: () => "dirty" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root", name: "reliability" });
    let runs = 0;
    installEvaluationAccess({ async runCommandEvaluationSuite() { runs += 1; return { results: [passingResult()], summary: summary() }; } });
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow(/clean and committed/);
    expect(runs).toBe(0);
    expect(manager.getCandidate(candidate.id)?.status).toBe("created");
  });

  it("rejects a candidate whose branch changed before evaluation", async () => {
    installDefaultWorktrees({
      inspect: { directory: "/tmp/candidate-worktree", head: "def456", branch: "friday/other", clean: true },
    });
    const manager = new SelfImprovementManager({ idFactory: () => "branch" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root", name: "reliability" });
    installPassingEvaluation();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow(/branch changed/);
  });

  it("marks evaluation as an error if candidate HEAD changes while checks run", async () => {
    let inspections = 0;
    installDefaultWorktrees({
      inspect: () => ({
        directory: "/tmp/candidate-worktree",
        head: inspections++ === 0 ? "def456" : "fedcba",
        branch: "friday/reliability",
        clean: true,
      }),
    });
    const manager = new SelfImprovementManager({ idFactory: () => "moving" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root", name: "reliability" });
    installPassingEvaluation();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow(/HEAD changed during evaluation/);
    expect(manager.getCandidate(candidate.id)?.status).toBe("error");
  });
});

describe("candidate promotion", () => {
  async function passedCandidate(options: {
    inspect?: CandidateWorktreeSnapshot | (() => CandidateWorktreeSnapshot);
    stateDir?: string;
  } = {}) {
    installDefaultWorktrees({ ...(options.inspect ? { inspect: options.inspect } : {}) });
    const manager = new SelfImprovementManager({ idFactory: () => "cand_promote", ...(options.stateDir ? { stateDir: options.stateDir } : {}) });
    const candidate = await manager.createCandidate({
      objective: "Promote a verified improvement",
      repository: "/repo",
      worktreeRoot: "/root",
      name: "promotion",
    });
    installPassingEvaluation();
    const passed = await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
    expect(passed.status).toBe("passed");
    return { manager, candidate: passed };
  }

  it("requires a passed candidate", async () => {
    const { manager, candidate } = await createdManager();
    installDefaultGenerations();
    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" })).rejects.toThrow(/must pass/);
  });

  it("requires a sealed evaluation commit", async () => {
    const stateDir = await tempDir("friday-self-legacy-pass-");
    const state = createEmptySelfImprovementState();
    state.candidates.legacy = {
      id: "legacy", objective: "x", repository: "/repo", worktreeRoot: "/root", worktreeName: "legacy",
      directory: "/root/legacy", baseCommit: "abc123", branch: "friday/legacy", status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 3,
      evaluation: { checks: [{ command: "npm test" }], results: [passingResult()], summary: summary(), evaluatedAt: "2026-01-01T00:00:00.000Z" },
      lastError: undefined,
    };
    saveSelfImprovementState(stateDir, state);
    installDefaultWorktrees({ inspect: { directory: "/root/legacy", head: "def456", branch: "friday/legacy", clean: true } });
    installDefaultGenerations();
    const manager = new SelfImprovementManager({ stateDir });
    await expect(manager.promoteCandidate({ id: "legacy", generationsStateDir: "/generations" })).rejects.toThrow(/sealed evaluation commit/);
  });

  it("refuses to promote a no-op candidate", async () => {
    const { manager, candidate } = await passedCandidate({
      inspect: { directory: "/tmp/candidate-worktree", head: "abc123", branch: "friday/promotion", clean: true },
    });
    installDefaultGenerations();
    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" })).rejects.toThrow(/no committed change/);
  });

  it("refuses promotion if the candidate changed after evaluation", async () => {
    let head = "def456";
    const { manager, candidate } = await passedCandidate({
      inspect: () => ({ directory: "/tmp/candidate-worktree", head, branch: "friday/promotion", clean: true }),
    });
    head = "fedcba";
    const generations = installDefaultGenerations();
    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" })).rejects.toThrow(/changed after evaluation/);
    expect(generations.opens).toHaveLength(0);
  });

  it("checkpoints the current repository as a baseline before first promotion", async () => {
    const { manager, candidate } = await passedCandidate();
    const generations = installDefaultGenerations();
    const promoted = await manager.promoteCandidate({ id: candidate.id, generationsStateDir: " /generations ", label: " verified " });
    expect(generations.opens).toEqual([{ repository: "/repo", stateDir: "/generations" }]);
    expect(generations.checkpoints).toHaveLength(1);
    expect(generations.activations).toEqual([{
      targetCommit: "def456",
      expectedBaseCommit: "abc123",
      label: " verified ",
    }]);
    expect(promoted).toMatchObject({
      status: "promoted",
      promotedGenerationId: "gen-000002",
      promotedCommit: "def456",
    });
    expect(promoted.promotedAt).toBeTruthy();
  });

  it("uses an existing active generation without creating another baseline", async () => {
    const { manager, candidate } = await passedCandidate();
    const generations = installDefaultGenerations({ active: generation("gen-000001", "abc123", undefined) });
    await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    expect(generations.checkpoints).toHaveLength(0);
    expect(generations.activations[0]).toMatchObject({ targetCommit: "def456", expectedBaseCommit: "abc123" });
  });

  it("leaves a passed candidate retryable when generation activation fails", async () => {
    const { manager, candidate } = await passedCandidate();
    installDefaultGenerations({
      active: generation("gen-000001", "abc123", undefined),
      activateError: new Error("activation failed"),
    });
    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" })).rejects.toThrow("activation failed");
    expect(manager.getCandidate(candidate.id)?.status).toBe("passed");
  });

  it("rolls generation activation back if promoted candidate state cannot be persisted", async () => {
    const root = await tempDir("friday-self-promotion-persist-failure-");
    const stateDir = join(root, "state");
    const { manager, candidate } = await passedCandidate({ stateDir });
    let active = generation("gen-000001", "abc123", undefined);
    let rollbackCount = 0;
    installGenerationsAccess({
      openManager() {
        return {
          getActiveGeneration() {
            return active;
          },
          async checkpointCurrent() {
            return active;
          },
          async activateDescendant(options) {
            active = generation("gen-000002", options.targetCommit, "gen-000001");
            return active;
          },
          async planRollback(options) {
            return {
              activeGenerationId: active.id,
              targetGenerationId: options.targetGenerationId,
              expectedHeadCommit: active.commit,
              targetCommit: "abc123",
              targetRef: `refs/friday/generations/${options.targetGenerationId}`,
              plannedAt: "2026-08-18T00:00:00.000Z",
            };
          },
          async executeRollback(options) {
            rollbackCount += 1;
            active = generation(options.plan.targetGenerationId, options.plan.targetCommit, undefined);
            return { target: active, recovered: false };
          },
        };
      },
    });

    renameSync(stateDir, `${stateDir}-before-failure`);
    writeFileSync(stateDir, "block state directory recreation");

    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" }))
      .rejects.toThrow(/activation was rolled back/);
    expect(rollbackCount).toBe(1);
    expect(active.id).toBe("gen-000001");
    expect(manager.getCandidate(candidate.id)?.status).toBe("passed");
  });

  it("persists promoted metadata so restart recovery sees the accepted generation", async () => {
    const stateDir = await tempDir("friday-self-promoted-state-");
    const { manager, candidate } = await passedCandidate({ stateDir });
    installDefaultGenerations({ active: generation("gen-000001", "abc123", undefined) });
    const promoted = await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });

    const reopened = new SelfImprovementManager({ stateDir });
    expect(reopened.getCandidate(candidate.id)).toMatchObject({
      status: "promoted",
      promotedGenerationId: promoted.promotedGenerationId,
      promotedCommit: "def456",
      promotedAt: promoted.promotedAt,
    });
  });

  it("serializes promotion and blocks evaluation or abandonment while activation is in flight", async () => {
    const { manager, candidate } = await passedCandidate();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    installGenerationsAccess({
      openManager() {
        return {
          getActiveGeneration() {
            return generation("gen-000001", "abc123", undefined);
          },
          async checkpointCurrent() {
            throw new Error("baseline checkpoint should not run");
          },
          async activateDescendant(options) {
            await wait;
            return generation("gen-000002", options.targetCommit, "gen-000001");
          },
          async planRollback(options) {
            return {
              activeGenerationId: "gen-000002",
              targetGenerationId: options.targetGenerationId,
              expectedHeadCommit: "def456",
              targetCommit: "abc123",
              targetRef: `refs/friday/generations/${options.targetGenerationId}`,
              plannedAt: "2026-08-18T00:00:00.000Z",
            };
          },
          async executeRollback() {
            return { target: generation("gen-000001", "abc123", undefined), recovered: false };
          },
        };
      },
    });

    const first = manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    await Promise.resolve();
    await expect(manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" })).rejects.toThrow(/already being promoted/);
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow(/being promoted/);
    await expect(manager.abandonCandidate({ id: candidate.id })).rejects.toThrow(/being promoted/);
    release();
    expect((await first).status).toBe("promoted");
  });

  it("makes repeated promotion idempotent at candidate state", async () => {
    const { manager, candidate } = await passedCandidate();
    const generations = installDefaultGenerations({ active: generation("gen-000001", "abc123", undefined) });
    const first = await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    const second = await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    expect(second).toEqual(first);
    expect(generations.activations).toHaveLength(1);
  });

  it("refuses to evaluate or abandon a promoted candidate", async () => {
    const { manager, candidate } = await passedCandidate();
    installDefaultGenerations({ active: generation("gen-000001", "abc123", undefined) });
    await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow(/already promoted/);
    await expect(manager.abandonCandidate({ id: candidate.id })).rejects.toThrow(/promoted/);
  });
});

describe("generation handoff continuation", () => {
  async function promotedForHandoff(options: { stateDir?: string; now?: () => string } = {}) {
    installDefaultWorktrees();
    const manager = new SelfImprovementManager({
      idFactory: () => "cand_handoff",
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const candidate = await manager.createCandidate({
      objective: "Continue self-development after restart",
      repository: "/repo",
      worktreeRoot: "/root",
      name: "handoff",
    });
    installPassingEvaluation();
    await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
    installDefaultGenerations({ active: generation("gen-000001", "abc123", undefined) });
    const promoted = await manager.promoteCandidate({ id: candidate.id, generationsStateDir: "/generations" });
    return { manager, promoted };
  }

  function handoffFor(manager: SelfImprovementManager): GenerationHandoffRecord {
    const [handoff] = manager.listGenerationHandoffs();
    if (!handoff) throw new Error("expected generation handoff");
    return handoff;
  }

  it("publishes one pending self-contained handoff with the promoted candidate", async () => {
    const { manager, promoted } = await promotedForHandoff();
    const handoff = handoffFor(manager);
    expect(handoff).toMatchObject({
      candidateId: promoted.id,
      objective: "Continue self-development after restart",
      repository: "/repo",
      fromGenerationId: "gen-000001",
      fromCommit: "abc123",
      toGenerationId: "gen-000002",
      toCommit: "def456",
      status: "pending",
      version: 1,
      resumeAttempts: 0,
    });
    expect(handoff.id).toBe(`handoff:${promoted.id}:gen-000002`);
  });

  it("persists the pending handoff across manager restart", async () => {
    const stateDir = await tempDir("friday-self-handoff-persist-");
    const { manager } = await promotedForHandoff({ stateDir });
    const id = handoffFor(manager).id;
    const reopened = new SelfImprovementManager({ stateDir });
    expect(reopened.getGenerationHandoff(id)).toMatchObject({ id, status: "pending", resumeAttempts: 0 });
  });

  it("claims only the handoff for the running generation", async () => {
    const { manager } = await promotedForHandoff();
    expect(manager.claimGenerationHandoff({ generationId: "gen-999999" })).toBeUndefined();
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" });
    expect(claimed).toMatchObject({ status: "resuming", resumeAttempts: 1, toGenerationId: "gen-000002" });
    expect(claimed?.claimedAt).toBeTruthy();
  });

  it("prevents a second in-process claim while the handoff is resuming", async () => {
    const { manager } = await promotedForHandoff();
    manager.claimGenerationHandoff({ generationId: "gen-000002" });
    expect(() => manager.claimGenerationHandoff({ generationId: "gen-000002" })).toThrow(/already resuming/);
  });

  it("releases a claimed handoff for an explicit retry without losing the objective", async () => {
    const { manager } = await promotedForHandoff();
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" })!;
    const released = manager.releaseGenerationHandoff({ id: claimed.id, error: "resume host unavailable" });
    expect(released).toMatchObject({
      status: "pending",
      resumeAttempts: 1,
      objective: "Continue self-development after restart",
      lastError: "resume host unavailable",
    });
    const claimedAgain = manager.claimGenerationHandoff({ generationId: "gen-000002" });
    expect(claimedAgain?.resumeAttempts).toBe(2);
  });

  it("records a promoted candidate as rolled back without reopening promotion", async () => {
    const { manager, promoted } = await promotedForHandoff();
    const rolledBack = manager.markCandidateRolledBack({ id: promoted.id, error: "successor startup failed" });
    expect(rolledBack).toMatchObject({ status: "rolled-back", lastError: "successor startup failed" });
    expect(manager.markCandidateRolledBack({ id: promoted.id, error: "different" })).toEqual(rolledBack);
    await expect(manager.promoteCandidate({ id: promoted.id, generationsStateDir: "/generations" })).rejects.toThrow(/must pass evaluation/);
  });

  it("marks an unrecoverable handoff failed and prevents another claim", async () => {
    const { manager } = await promotedForHandoff();
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" })!;
    const failed = manager.failGenerationHandoff({ id: claimed.id, error: "successor failed post-restart verification" });
    expect(failed).toMatchObject({
      status: "failed",
      resumeAttempts: 1,
      lastError: "successor failed post-restart verification",
    });
    expect(manager.failGenerationHandoff({ id: claimed.id, error: "different" })).toEqual(failed);
    expect(manager.claimGenerationHandoff({ generationId: "gen-000002" })).toBeUndefined();
    expect(() => manager.completeGenerationHandoff({ id: claimed.id })).toThrow(/failed|resuming/);
  });

  it("completes a claimed handoff idempotently and prevents another claim", async () => {
    const { manager } = await promotedForHandoff();
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" })!;
    const completed = manager.completeGenerationHandoff({ id: claimed.id });
    expect(completed).toMatchObject({ status: "completed", resumeAttempts: 1 });
    expect(completed.completedAt).toBeTruthy();
    expect(manager.completeGenerationHandoff({ id: claimed.id })).toEqual(completed);
    expect(manager.claimGenerationHandoff({ generationId: "gen-000002" })).toBeUndefined();
  });

  it("refuses to complete or release a handoff that has not been claimed", async () => {
    const { manager } = await promotedForHandoff();
    const handoff = handoffFor(manager);
    expect(() => manager.completeGenerationHandoff({ id: handoff.id })).toThrow(/must be resuming/);
    expect(() => manager.releaseGenerationHandoff({ id: handoff.id })).toThrow(/not currently resuming/);
  });

  it("recovers an interrupted resuming handoff to pending on restart", async () => {
    const stateDir = await tempDir("friday-self-handoff-recover-");
    const times = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
    ];
    const { manager } = await promotedForHandoff({ stateDir, now: () => times.shift() ?? "2026-01-01T00:00:06.000Z" });
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" })!;

    const reopened = new SelfImprovementManager({ stateDir, now: () => "2026-01-02T00:00:00.000Z" });
    expect(reopened.getGenerationHandoff(claimed.id)).toMatchObject({
      status: "pending",
      resumeAttempts: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
      lastError: "Generation handoff was interrupted before completion",
    });
    expect(reopened.claimGenerationHandoff({ generationId: "gen-000002" })?.resumeAttempts).toBe(2);
  });

  it("returns defensive handoff snapshots", async () => {
    const { manager } = await promotedForHandoff();
    const first = handoffFor(manager);
    first.objective = "mutated";
    const listed = manager.listGenerationHandoffs();
    listed[0]!.status = "completed";
    const snapshot = manager.snapshot();
    snapshot.handoffs[handoffFor(manager).id]!.objective = "snapshot mutation";
    expect(handoffFor(manager).objective).toBe("Continue self-development after restart");
    expect(handoffFor(manager).status).toBe("pending");
  });

  it("backfills a missing handoff when an older promoted candidate is promoted again", async () => {
    const stateDir = await tempDir("friday-self-handoff-backfill-");
    const state = createEmptySelfImprovementState();
    state.candidates.legacy = {
      id: "legacy",
      objective: "Continue legacy objective",
      repository: "/repo",
      worktreeRoot: "/root",
      worktreeName: "legacy",
      directory: "/root/legacy",
      baseCommit: "abc123",
      branch: "friday/legacy",
      status: "promoted",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      version: 4,
      evaluation: undefined,
      promotedGenerationId: "gen-000002",
      promotedCommit: "def456",
      promotedAt: "2026-01-01T00:00:01.000Z",
      lastError: undefined,
    };
    saveSelfImprovementState(stateDir, state);
    const manager = new SelfImprovementManager({ stateDir });
    await manager.promoteCandidate({ id: "legacy", generationsStateDir: "/generations" });
    const [handoff] = manager.listGenerationHandoffs();
    expect(handoff).toMatchObject({
      id: "handoff:legacy:gen-000002",
      candidateId: "legacy",
      fromGenerationId: undefined,
      status: "pending",
    });
  });

  it("ignores a handoff that was already completed when looking for continuation work", async () => {
    const { manager } = await promotedForHandoff();
    const claimed = manager.claimGenerationHandoff({ generationId: "gen-000002" })!;
    manager.completeGenerationHandoff({ id: claimed.id });
    expect(manager.claimGenerationHandoff({ generationId: "gen-000002" })).toBeUndefined();
  });
});

describe("candidate abandonment and recovery", () => {
  it("removes the isolated worktree and marks the candidate abandoned", async () => {
    const { removes } = installDefaultWorktrees();
    const manager = new SelfImprovementManager({ idFactory: () => "abandon" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" });
    const result = await manager.abandonCandidate({ id: candidate.id });
    expect(removes).toEqual([{ repository: "/repo", directory: candidate.directory, force: true, deleteBranch: true }]);
    expect(result.status).toBe("abandoned");
  });

  it("honors explicit worktree-removal flags", async () => {
    const { removes } = installDefaultWorktrees();
    const manager = new SelfImprovementManager({ idFactory: () => "abandon" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" });
    await manager.abandonCandidate({ id: candidate.id, force: false, deleteBranch: false });
    expect(removes[0]).toMatchObject({ force: false, deleteBranch: false });
  });

  it("makes repeated abandonment idempotent", async () => {
    const { removes } = installDefaultWorktrees();
    const manager = new SelfImprovementManager({ idFactory: () => "abandon" });
    const candidate = await manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" });
    await manager.abandonCandidate({ id: candidate.id });
    await manager.abandonCandidate({ id: candidate.id });
    expect(removes).toHaveLength(1);
  });

  it("refuses to evaluate an abandoned candidate", async () => {
    const { manager, candidate } = await createdManager();
    installPassingEvaluation();
    await manager.abandonCandidate({ id: candidate.id });
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow("abandoned");
  });

  it("refuses to abandon a candidate while evaluation is active", async () => {
    const { manager, candidate } = await createdManager();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    installEvaluationAccess({
      async runCommandEvaluationSuite() {
        await wait;
        return { results: [passingResult()], summary: summary() };
      },
    });
    const evaluating = manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
    await Promise.resolve();
    await expect(manager.abandonCandidate({ id: candidate.id })).rejects.toThrow("evaluating");
    release();
    await evaluating;
  });

  it("recovers an interrupted persisted evaluation as an error", async () => {
    const stateDir = await tempDir("friday-self-recover-");
    mkdirSync(stateDir, { recursive: true });
    const state = createEmptySelfImprovementState();
    state.candidates.interrupted = {
      id: "interrupted",
      objective: "x",
      repository: "/repo",
      worktreeRoot: "/root",
      worktreeName: "x",
      directory: "/root/x",
      baseCommit: "abc",
      branch: "friday/x",
      status: "evaluating",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 2,
      evaluation: undefined,
      lastError: undefined,
    };
    saveSelfImprovementState(stateDir, state);
    const manager = new SelfImprovementManager({ stateDir, now: () => "2026-01-02T00:00:00.000Z" });
    expect(manager.getCandidate("interrupted")).toMatchObject({
      status: "error",
      version: 3,
      updatedAt: "2026-01-02T00:00:00.000Z",
      lastError: "Candidate evaluation was interrupted before completion",
    });
    expect(loadSelfImprovementState(stateDir).candidates.interrupted?.status).toBe("error");
  });
});

describe("capability ports", () => {
  it("fails clearly when worktrees access is not installed", async () => {
    const manager = new SelfImprovementManager({ idFactory: () => "missing-port" });
    await expect(manager.createCandidate({ objective: "x", repository: "/repo", worktreeRoot: "/root" })).rejects.toThrow("worktrees access is not installed");
  });

  it("fails clearly when evaluation access is not installed", async () => {
    const { manager, candidate } = await createdManager();
    await expect(manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] })).rejects.toThrow("evaluation access is not installed");
    expect(manager.getCandidate(candidate.id)?.status).toBe("error");
  });

  it("fails clearly when generations access is not installed for promotion", async () => {
    const { manager, candidate } = await createdManager();
    installPassingEvaluation();
    const passed = await manager.evaluateCandidate({ id: candidate.id, checks: [{ command: "npm test" }] });
    uninstallGenerationsAccess();
    await expect(manager.promoteCandidate({ id: passed.id, generationsStateDir: "/generations" })).rejects.toThrow(/generations access is not installed/);
  });

  it("forwards direct evaluation access without adding policy", async () => {
    installEvaluationAccess({ async runCommandEvaluationSuite(specs) { return { results: specs.map(() => passingResult()), summary: summary({ total: specs.length, passed: specs.length, scoreTotal: specs.length, scored: specs.length }) }; } });
    await expect(evaluateCandidateChecks([{ command: "npm test", cwd: "/candidate" }])).resolves.toMatchObject({ summary: { passed: 1 } });
  });
});
