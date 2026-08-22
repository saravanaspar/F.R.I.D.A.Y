import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addAutonomousContinuation,
  addAutonomousUsage,
  autonomousLimitReason,
  autonomousStatus,
  buildAutonomousGateFailureContinuation,
  createAutonomousRuntimeState,
  DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
  nextAutonomousContinuation,
  setAutonomousEnabled,
  shouldAutonomouslyContinue,
} from "../src/autonomy.js";
import { installEvaluationAccess } from "../src/evaluation-access.js";
import { installExecutionAccess } from "../src/execution-access.js";
import type { AutonomyEvaluationResult, AutonomyProcessResult } from "../src/types.js";

const assistant = (stopReason = "stop") => ({ stopReason });
const tempPaths: string[] = [];

function result(overrides: Partial<AutonomyProcessResult> = {}): AutonomyProcessResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    ...overrides,
  };
}

function gate(overrides: Partial<AutonomyEvaluationResult> = {}): AutonomyEvaluationResult {
  return {
    passed: true,
    exitText: "exited 0",
    output: "",
    outputTruncated: false,
    ...overrides,
  };
}

function installFakeExecution(options?: {
  gateResults?: AutonomyEvaluationResult[];
  status?: () => string;
  diff?: () => string;
}) {
  const gateResults = [...(options?.gateResults ?? [])];
  installEvaluationAccess({
    async evaluateCommand() {
      return gateResults.shift() ?? gate();
    },
  });
  installExecutionAccess({
    async runProcess(command, args) {
      if (command !== "git") throw new Error(`unexpected process command: ${command}`);
      return result({ stdout: args.includes("status") ? (options?.status?.() ?? "") : (options?.diff?.() ?? "") });
    },
  });
}

beforeEach(() => {
  installFakeExecution();
});

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("autonomy state", () => {
  it("starts disabled unless explicitly enabled", () => {
    const state = createAutonomousRuntimeState();
    expect(state.enabled).toBe(false);
    expect(state.startedAt).toBeUndefined();
    expect(state.continuationsUsed).toBe(0);
  });

  it("normalizes invalid limits to defaults", () => {
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 0,
      maxTurns: -1,
      maxTokens: Number.NaN,
      timeoutMs: 0,
    });
    expect(state.limits.maxContinuations).toBeGreaterThan(0);
    expect(state.limits.maxTurns).toBeGreaterThan(0);
    expect(state.limits.maxTokens).toBeGreaterThan(0);
    expect(state.limits.timeoutMs).toBeGreaterThan(0);
  });

  it("resets counters when enabled again", () => {
    const state = createAutonomousRuntimeState({ enabled: true });
    state.turnsUsed = 4;
    state.tokensUsed = 99;
    state.continuationsUsed = 2;
    setAutonomousEnabled(state, false);
    setAutonomousEnabled(state, true);
    expect(state.turnsUsed).toBe(0);
    expect(state.tokensUsed).toBe(0);
    expect(state.continuationsUsed).toBe(0);
    expect(state.startedAt).toBeTypeOf("number");
  });

  it("returns a defensive status snapshot", () => {
    const state = createAutonomousRuntimeState({ enabled: true, gates: { commands: ["check"] } });
    const status = autonomousStatus(state);
    status.gates.commands.push("other");
    status.gateAttempts.check = 9;
    expect(state.gates.commands).toEqual(["check"]);
    expect(state.gateAttempts.check).toBeUndefined();
  });

  it("counts non-cache work but not cache reads", () => {
    const state = createAutonomousRuntimeState({ enabled: true, maxTokens: 100 });
    addAutonomousUsage(state, { input: 2, output: 3, cacheRead: 1000, cacheWrite: 4, totalTokens: 1009 });
    expect(state.turnsUsed).toBe(1);
    expect(state.tokensUsed).toBe(9);
  });

  it("tracks each configured limit reason", () => {
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 1,
      maxTurns: 2,
      maxTokens: 3,
      timeoutMs: 4,
    });
    state.continuationsUsed = 1;
    expect(autonomousLimitReason(state)).toBe("maxContinuations");
    state.continuationsUsed = 0;
    state.turnsUsed = 2;
    expect(autonomousLimitReason(state)).toBe("maxTurns");
    state.turnsUsed = 0;
    state.tokensUsed = 3;
    expect(autonomousLimitReason(state)).toBe("maxTokens");
    state.tokensUsed = 0;
    state.startedAt = 0;
    expect(autonomousLimitReason(state, 4)).toBe("timeoutMs");
  });
});

describe("autonomous continuation", () => {
  it("injects the default continuation while budget remains", async () => {
    const state = createAutonomousRuntimeState({ enabled: true, maxContinuations: 1 });
    const message = await nextAutonomousContinuation(state, assistant(), {}, 123);
    expect(message?.role).toBe("user");
    expect(message?.content[0]?.text).toBe(DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT);
    expect(message?.timestamp).toBe(123);
    expect(state.continuationsUsed).toBe(1);
  });

  it("uses a configured continuation prompt", async () => {
    const state = createAutonomousRuntimeState({ enabled: true, continuationPrompt: "keep going" });
    const message = await nextAutonomousContinuation(state, assistant());
    expect(message?.content[0]?.text).toBe("keep going");
  });

  it("does not continue failed or aborted assistant turns", async () => {
    const state = createAutonomousRuntimeState({ enabled: true });
    expect((await shouldAutonomouslyContinue(state, assistant("error"))).shouldContinue).toBe(false);
    expect((await shouldAutonomouslyContinue(state, assistant("aborted"))).shouldContinue).toBe(false);
  });

  it("stops when the continuation budget is exhausted", async () => {
    const state = createAutonomousRuntimeState({ enabled: true, maxContinuations: 1 });
    addAutonomousContinuation(state);
    expect(await nextAutonomousContinuation(state, assistant())).toBeUndefined();
  });

  it("does not trust assistant blocker prose as terminal evidence", async () => {
    const state = createAutonomousRuntimeState({ enabled: true });
    expect(await shouldAutonomouslyContinue(state, assistant())).toMatchObject({
      shouldContinue: true,
      reason: "missing_terminal_evidence",
    });
  });
});

describe("quality gates", () => {
  it("lets a passing gate terminate even when a usage limit was reached", async () => {
    installFakeExecution({ gateResults: [gate()] });
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxTurns: 1,
      gates: { commands: ["check"] },
    });
    state.turnsUsed = 1;
    expect(await shouldAutonomouslyContinue(state, assistant(), { cwd: "/tmp" })).toMatchObject({
      shouldContinue: false,
      reason: "not_needed",
    });
  });

  it("feeds failing gate output into the continuation", async () => {
    installFakeExecution({ gateResults: [gate({ passed: false, exitText: "exited 1", output: "tests failed" })] });
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 2,
      gates: { commands: ["check"], maxRetries: 2 },
    });
    const message = await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" }, 1000);
    expect(message?.content[0]?.text).toContain("Autonomous quality gate failed");
    expect(message?.content[0]?.text).toContain("tests failed");
    expect(state.lastGateFailure?.attempt).toBe(1);
  });

  it("suppresses a rerun when the worktree is unchanged", async () => {
    let gateRuns = 0;
    installEvaluationAccess({
      async evaluateCommand() {
        gateRuns++;
        return gate({ passed: false, exitText: "exited 1", output: "bad" });
      },
    });
    installExecutionAccess({
      async runProcess(command, args) {
        if (command !== "git") throw new Error(`unexpected process command: ${command}`);
        return result({ stdout: args.includes("status") ? "" : "same" });
      },
    });
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 3,
      gates: { commands: ["check"], maxRetries: 3 },
    });
    const first = await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" });
    const second = await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" });
    expect(first).toBeDefined();
    expect(second?.content[0]?.text).toContain("workspace has not changed");
    expect(gateRuns).toBe(1);
    expect(state.gateAttempts.check).toBe(2);
  });

  it("reruns a failed gate when the tracked diff changes", async () => {
    let diff = "before";
    let gateRuns = 0;
    installEvaluationAccess({
      async evaluateCommand() {
        gateRuns++;
        return gate(gateRuns === 1 ? { passed: false, exitText: "exited 1" } : {});
      },
    });
    installExecutionAccess({
      async runProcess(command, args) {
        if (command !== "git") throw new Error(`unexpected process command: ${command}`);
        return result({ stdout: args.includes("status") ? "" : diff });
      },
    });
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 3,
      gates: { commands: ["check"], maxRetries: 3 },
    });
    expect(await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" })).toBeDefined();
    diff = "after";
    expect(await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" })).toBeUndefined();
    expect(gateRuns).toBe(2);
    expect(state.lastGateFailure).toBeUndefined();
  });

  it("does not hash an untracked path that escapes the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "friday-autonomy-containment-"));
    tempPaths.push(parent);
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside-secret.txt");
    await mkdir(workspace);
    await writeFile(outside, "secret-v1");

    let gateRuns = 0;
    installEvaluationAccess({
      async evaluateCommand() {
        gateRuns++;
        return gate({ passed: false, exitText: "exited 1", output: "bad" });
      },
    });
    const escaped = relative(workspace, outside);
    installExecutionAccess({
      async runProcess(command, args) {
        if (command !== "git") throw new Error(`unexpected process command: ${command}`);
        return result({ stdout: args.includes("status") ? `?? ${escaped}\0` : "same" });
      },
    });

    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 3,
      gates: { commands: ["check"], maxRetries: 3 },
    });
    expect(await nextAutonomousContinuation(state, assistant(), { cwd: workspace })).toBeDefined();
    await writeFile(outside, "secret-v2");
    const second = await nextAutonomousContinuation(state, assistant(), { cwd: workspace });
    expect(second?.content[0]?.text).toContain("workspace has not changed");
    expect(gateRuns).toBe(1);
  });

  it("stops after gate retries are exhausted", async () => {
    installFakeExecution({ gateResults: [gate({ passed: false, exitText: "exited 1" }), gate({ passed: false, exitText: "exited 1" })] });
    let diffVersion = 0;
    installEvaluationAccess({
      async evaluateCommand() {
        return gate({ passed: false, exitText: "exited 1" });
      },
    });
    installExecutionAccess({
      async runProcess(command, args) {
        if (command !== "git") throw new Error(`unexpected process command: ${command}`);
        return result({ stdout: args.includes("status") ? "" : String(diffVersion++) });
      },
    });
    const state = createAutonomousRuntimeState({
      enabled: true,
      maxContinuations: 5,
      gates: { commands: ["check"], maxRetries: 1 },
    });
    expect(await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" })).toBeDefined();
    expect(await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" })).toBeUndefined();
  });

  it("marks timed-out gate failures", async () => {
    installFakeExecution({ gateResults: [gate({ passed: false, exitText: "timed out" })] });
    const state = createAutonomousRuntimeState({
      enabled: true,
      gates: { commands: ["check"] },
    });
    await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" });
    expect(state.lastGateFailure?.exitText).toBe("timed out");
  });

  it("bounds gate output included in continuation state", async () => {
    installFakeExecution({
      gateResults: [gate({ passed: false, exitText: "exited 1", output: "x".repeat(20_000), outputTruncated: true })],
    });
    const state = createAutonomousRuntimeState({ enabled: true, gates: { commands: ["check"] } });
    await nextAutonomousContinuation(state, assistant(), { cwd: "/tmp" });
    expect(state.lastGateFailure?.output).toContain("... [truncated]");
    expect(state.lastGateFailure?.output.length).toBeLessThan(6100);
  });

  it("formats standalone failure continuation text", () => {
    const text = buildAutonomousGateFailureContinuation(
      { command: "npm test", attempt: 2, exitText: "exited 1", output: "failed" },
      3,
      0,
    );
    expect(text).toContain("attempt 2/3");
    expect(text).toContain("npm test");
    expect(text).toContain("1970-01-01T00:00:00.000Z");
  });
});
