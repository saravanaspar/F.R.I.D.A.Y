import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyEvaluation,
  runCommandEvaluation,
  runCommandEvaluationSuite,
  summarizeEvaluations,
} from "../src/evaluation.js";
import { installExecutionAccess } from "../src/execution-access.js";
import type { EvaluationProcessOptions, EvaluationProcessResult } from "../src/types.js";

function processResult(overrides: Partial<EvaluationProcessResult> = {}): EvaluationProcessResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  installExecutionAccess({
    async runProcess() {
      return processResult();
    },
  });
});

describe("evaluation classification", () => {
  it("treats a full positive score as a pass even when teardown also reported an error", () => {
    expect(classifyEvaluation({ score: 1, error: "late teardown" })).toBe("pass");
  });

  it("treats a fractional positive score as partial even when a timeout was also recorded", () => {
    expect(classifyEvaluation({ score: 0.5, timedOut: true })).toBe("partial");
  });

  it("classifies timeout before ordinary zero-score failure", () => {
    expect(classifyEvaluation({ score: 0, timedOut: true })).toBe("timeout");
  });

  it("classifies provider or process errors", () => {
    expect(classifyEvaluation({ score: 0, error: "boom" })).toBe("error");
  });

  it("distinguishes missing scores", () => {
    expect(classifyEvaluation({})).toBe("no-score");
  });

  it("does not treat non-finite scores as valid evidence", () => {
    expect(classifyEvaluation({ score: Number.NaN })).toBe("no-score");
  });

  it("classifies a zero score as failure", () => {
    expect(classifyEvaluation({ score: 0 })).toBe("fail");
  });
});

describe("command evaluation", () => {
  it("rejects empty commands", async () => {
    await expect(runCommandEvaluation({ command: "   " })).rejects.toThrow("must not be empty");
  });

  it("forwards shell execution options through the injected process port", async () => {
    let seen: { command: string; args: string[]; options: EvaluationProcessOptions | undefined } | undefined;
    installExecutionAccess({
      async runProcess(command, args, options) {
        seen = { command, args, options };
        return processResult();
      },
    });
    await runCommandEvaluation({ command: "npm test", cwd: "/repo", timeoutMs: 1234, maxOutputChars: 321 });
    expect(seen).toMatchObject({
      command: "npm test",
      args: [],
      options: { cwd: "/repo", shell: true, timeoutMs: 1234, maxOutputChars: 321 },
    });
  });

  it("records successful commands as pass", async () => {
    const result = await runCommandEvaluation({ command: "check" });
    expect(result).toMatchObject({ status: "pass", score: 1, exitCode: 0, exitText: "exited 0" });
  });

  it("records non-zero commands as fail", async () => {
    installExecutionAccess({ async runProcess() { return processResult({ status: 2, stderr: "bad" }); } });
    const result = await runCommandEvaluation({ command: "check" });
    expect(result).toMatchObject({ status: "fail", score: 0, exitCode: 2, exitText: "exited 2", output: "bad" });
  });

  it("records timed-out commands distinctly", async () => {
    installExecutionAccess({ async runProcess() { return processResult({ status: null, timedOut: true }); } });
    const result = await runCommandEvaluation({ command: "check" });
    expect(result).toMatchObject({ status: "timeout", score: 0, exitText: "timed out" });
  });

  it("records process errors distinctly", async () => {
    installExecutionAccess({ async runProcess() { return processResult({ status: null, error: new Error("launch failed") }); } });
    const result = await runCommandEvaluation({ command: "check" });
    expect(result).toMatchObject({ status: "error", score: 0, exitText: "launch failed" });
  });

  it("combines stdout and stderr into stable evidence", async () => {
    installExecutionAccess({ async runProcess() { return processResult({ status: 1, stdout: "out", stderr: "err" }); } });
    const result = await runCommandEvaluation({ command: "check" });
    expect(result.output).toBe("out\nerr");
  });

  it("bounds command evidence and marks truncation", async () => {
    installExecutionAccess({ async runProcess() { return processResult({ status: 1, stdout: "x".repeat(100), outputTruncated: true }); } });
    const result = await runCommandEvaluation({ command: "check", maxOutputChars: 10 });
    expect(result.output).toBe(`${"x".repeat(10)}\n... [truncated]`);
    expect(result.outputTruncated).toBe(true);
  });

  it("uses an explicit id without changing the command", async () => {
    const result = await runCommandEvaluation({ id: "unit", command: "npm test" });
    expect(result.id).toBe("unit");
    expect(result.command).toBe("npm test");
  });

  it("honors an already-aborted signal before invoking execution", async () => {
    let called = false;
    installExecutionAccess({ async runProcess() { called = true; return processResult(); } });
    const controller = new AbortController();
    controller.abort();
    await expect(runCommandEvaluation({ command: "check" }, controller.signal)).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("evaluation suites and summaries", () => {
  it("runs command suites in supplied order", async () => {
    const seen: string[] = [];
    installExecutionAccess({
      async runProcess(command) {
        seen.push(command);
        return processResult({ status: command === "two" ? 1 : 0 });
      },
    });
    const suite = await runCommandEvaluationSuite([{ command: "one" }, { command: "two" }, { command: "three" }]);
    expect(seen).toEqual(["one", "two", "three"]);
    expect(suite.results.map((item) => item.status)).toEqual(["pass", "fail", "pass"]);
  });

  it("summarizes every evaluation status and scored average", () => {
    const summary = summarizeEvaluations([
      { status: "pass", score: 1, durationMs: 1 },
      { status: "partial", score: 0.5, durationMs: 2 },
      { status: "fail", score: 0, durationMs: 3 },
      { status: "timeout", score: 0, durationMs: 4 },
      { status: "error", score: 0, durationMs: 5 },
      { status: "no-score", score: undefined, durationMs: 6 },
    ]);
    expect(summary).toEqual({
      total: 6,
      passed: 1,
      partial: 1,
      failed: 1,
      timedOut: 1,
      errors: 1,
      noScore: 1,
      scoreTotal: 1.5,
      scored: 5,
      averageScore: 0.3,
      durationMs: 21,
    });
  });

  it("leaves average score undefined when no result was scored", () => {
    expect(summarizeEvaluations([{ status: "no-score", score: undefined, durationMs: 1 }]).averageScore).toBeUndefined();
  });

  it("never lets malformed negative durations reduce aggregate duration", () => {
    expect(summarizeEvaluations([{ status: "pass", score: 1, durationMs: -100 }]).durationMs).toBe(0);
  });
});
