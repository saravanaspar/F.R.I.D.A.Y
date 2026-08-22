import { runProcess } from "./execution-access.js";
import type {
  CommandEvaluationResult,
  CommandEvaluationSpec,
  CommandEvaluationSuiteResult,
  EvaluationObservation,
  EvaluationStatus,
  EvaluationSummary,
} from "./types.js";

export const DEFAULT_EVALUATION_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_EVALUATION_OUTPUT_CHARS = 6000;

export function classifyEvaluation(observation: EvaluationObservation): EvaluationStatus {
  const score = observation.score;
  if (score !== undefined && Number.isFinite(score) && score > 0) {
    return score >= 1 ? "pass" : "partial";
  }
  if (observation.timedOut === true) return "timeout";
  if (observation.error) return "error";
  if (score === undefined || !Number.isFinite(score)) return "no-score";
  return "fail";
}

export async function runCommandEvaluation(
  spec: CommandEvaluationSpec,
  signal?: AbortSignal,
): Promise<CommandEvaluationResult> {
  signal?.throwIfAborted();
  const command = spec.command.trim();
  if (!command) throw new Error("Evaluation command must not be empty");

  const startedAt = Date.now();
  const maxOutputChars = normalizePositiveInteger(spec.maxOutputChars, DEFAULT_EVALUATION_OUTPUT_CHARS);
  const timeoutMs = normalizePositiveInteger(spec.timeoutMs, DEFAULT_EVALUATION_TIMEOUT_MS);
  const result = await runProcess(command, [], {
    shell: true,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    timeoutMs,
    maxOutputChars,
    ...(signal ? { signal } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.network === undefined ? {} : { network: spec.network }),
  });
  signal?.throwIfAborted();

  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const output = truncateOutput(rawOutput, result.outputTruncated, maxOutputChars);
  const error = result.error?.message;
  const passed = result.status === 0 && !result.error && result.timedOut !== true;
  const score = passed ? 1 : 0;
  const status = classifyEvaluation({
    score,
    ...(error ? { error } : {}),
    ...(result.timedOut === true ? { timedOut: true } : {}),
  });

  return {
    id: spec.id?.trim() || command,
    command,
    status,
    score,
    exitCode: result.status,
    exitText: formatProcessExit(result),
    output,
    outputTruncated: result.outputTruncated || rawOutput.length > maxOutputChars,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

export async function runCommandEvaluationSuite(
  specs: readonly CommandEvaluationSpec[],
  signal?: AbortSignal,
): Promise<CommandEvaluationSuiteResult> {
  const results: CommandEvaluationResult[] = [];
  for (const spec of specs) {
    signal?.throwIfAborted();
    results.push(await runCommandEvaluation(spec, signal));
  }
  return { results, summary: summarizeEvaluations(results) };
}

export function summarizeEvaluations(
  results: readonly Pick<CommandEvaluationResult, "status" | "score" | "durationMs">[],
): EvaluationSummary {
  let passed = 0;
  let partial = 0;
  let failed = 0;
  let timedOut = 0;
  let errors = 0;
  let noScore = 0;
  let scoreTotal = 0;
  let scored = 0;
  let durationMs = 0;

  for (const result of results) {
    durationMs += Math.max(0, result.durationMs);
    switch (result.status) {
      case "pass": passed++; break;
      case "partial": partial++; break;
      case "fail": failed++; break;
      case "timeout": timedOut++; break;
      case "error": errors++; break;
      case "no-score": noScore++; break;
    }
    if (result.score !== undefined && Number.isFinite(result.score)) {
      scoreTotal += result.score;
      scored++;
    }
  }

  return {
    total: results.length,
    passed,
    partial,
    failed,
    timedOut,
    errors,
    noScore,
    scoreTotal,
    scored,
    averageScore: scored > 0 ? scoreTotal / scored : undefined,
    durationMs,
  };
}

function formatProcessExit(result: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut?: boolean;
}): string {
  if (result.timedOut) return "timed out";
  if (result.error) return result.error.message;
  return result.signal ? `terminated by ${result.signal}` : `exited ${result.status ?? "unknown"}`;
}

function truncateOutput(output: string, alreadyTruncated: boolean, maxChars: number): string {
  if (output.length <= maxChars && !alreadyTruncated) return output;
  return `${output.slice(0, maxChars)}\n... [truncated]`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}
