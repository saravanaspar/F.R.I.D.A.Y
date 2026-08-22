import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CandidateCheckSpec,
  CandidateEvaluationResult,
  CandidateEvaluationRun,
  CandidateEvaluationSummary,
  CandidateRecord,
  CandidateStatus,
  GenerationHandoffRecord,
  GenerationHandoffStatus,
  SelfImprovementState,
} from "./types.js";

export const SELF_IMPROVEMENT_STATE_FILE_NAME = "candidates.json";

function assertPrivateStateDir(stateDir: string, create: boolean): void {
  if (!existsSync(stateDir)) {
    if (!create) return;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Self-improvement state directory must be a private directory: ${stateDir}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Self-improvement state directory permissions are too broad: ${stateDir}`);
  }
}

const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  "created",
  "evaluating",
  "passed",
  "failed",
  "error",
  "promoted",
  "rolled-back",
  "abandoned",
]);
const GENERATION_HANDOFF_STATUSES = new Set<GenerationHandoffStatus>([
  "pending",
  "resuming",
  "completed",
  "failed",
]);


export function createEmptySelfImprovementState(): SelfImprovementState {
  return { schema: 1, candidates: {}, handoffs: {} };
}

export function getSelfImprovementStatePath(stateDir: string): string {
  return join(stateDir, SELF_IMPROVEMENT_STATE_FILE_NAME);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown, fallback = 1): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseCheck(value: unknown): CandidateCheckSpec | undefined {
  const raw = record(value);
  const command = stringValue(raw?.command);
  if (!raw || !command) return undefined;
  const id = stringValue(raw.id);
  return {
    ...(id ? { id } : {}),
    command,
    ...(typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? { timeoutMs: raw.timeoutMs } : {}),
    ...(typeof raw.maxOutputChars === "number" && Number.isFinite(raw.maxOutputChars)
      ? { maxOutputChars: raw.maxOutputChars }
      : {}),
  };
}

function parseEvaluationResult(value: unknown): CandidateEvaluationResult | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const id = stringValue(raw.id);
  const command = stringValue(raw.command);
  const status = stringValue(raw.status);
  const exitText = typeof raw.exitText === "string" ? raw.exitText : undefined;
  const output = typeof raw.output === "string" ? raw.output : undefined;
  if (
    !id ||
    !command ||
    !status ||
    !["pass", "partial", "fail", "timeout", "error", "no-score"].includes(status) ||
    exitText === undefined ||
    output === undefined
  ) {
    return undefined;
  }
  return {
    id,
    command,
    status: status as CandidateEvaluationResult["status"],
    score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : undefined,
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null,
    exitText,
    output,
    outputTruncated: raw.outputTruncated === true,
    durationMs: Math.max(0, finiteNumber(raw.durationMs)),
  };
}

function parseSummary(value: unknown): CandidateEvaluationSummary | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  return {
    total: Math.max(0, finiteNumber(raw.total)),
    passed: Math.max(0, finiteNumber(raw.passed)),
    partial: Math.max(0, finiteNumber(raw.partial)),
    failed: Math.max(0, finiteNumber(raw.failed)),
    timedOut: Math.max(0, finiteNumber(raw.timedOut)),
    errors: Math.max(0, finiteNumber(raw.errors)),
    noScore: Math.max(0, finiteNumber(raw.noScore)),
    scoreTotal: finiteNumber(raw.scoreTotal),
    scored: Math.max(0, finiteNumber(raw.scored)),
    averageScore:
      typeof raw.averageScore === "number" && Number.isFinite(raw.averageScore) ? raw.averageScore : undefined,
    durationMs: Math.max(0, finiteNumber(raw.durationMs)),
  };
}

function parseEvaluation(value: unknown): CandidateEvaluationRun | undefined {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.checks) || !Array.isArray(raw.results)) return undefined;
  const summary = parseSummary(raw.summary);
  const evaluatedAt = stringValue(raw.evaluatedAt);
  if (!summary || !evaluatedAt) return undefined;
  return {
    checks: raw.checks.map(parseCheck).filter((item): item is CandidateCheckSpec => item !== undefined),
    results: raw.results
      .map(parseEvaluationResult)
      .filter((item): item is CandidateEvaluationResult => item !== undefined),
    summary,
    evaluatedAt,
    ...(typeof raw.commit === "string" && raw.commit.length > 0 ? { commit: raw.commit } : {}),
  };
}

function parseGenerationHandoff(id: string, value: unknown): GenerationHandoffRecord | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const candidateId = stringValue(raw.candidateId);
  const objective = stringValue(raw.objective);
  const repository = stringValue(raw.repository);
  const fromCommit = stringValue(raw.fromCommit);
  const toGenerationId = stringValue(raw.toGenerationId);
  const toCommit = stringValue(raw.toCommit);
  const statusText = stringValue(raw.status);
  const createdAt = stringValue(raw.createdAt);
  const updatedAt = stringValue(raw.updatedAt);
  if (
    !candidateId ||
    !objective ||
    !repository ||
    !fromCommit ||
    !toGenerationId ||
    !toCommit ||
    !statusText ||
    !GENERATION_HANDOFF_STATUSES.has(statusText as GenerationHandoffStatus) ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  return {
    id,
    candidateId,
    objective,
    repository,
    fromGenerationId: typeof raw.fromGenerationId === "string" && raw.fromGenerationId.length > 0
      ? raw.fromGenerationId
      : undefined,
    fromCommit,
    toGenerationId,
    toCommit,
    status: statusText as GenerationHandoffStatus,
    createdAt,
    updatedAt,
    version: positiveInteger(raw.version),
    resumeAttempts: nonNegativeInteger(raw.resumeAttempts),
    claimedAt: typeof raw.claimedAt === "string" && raw.claimedAt.length > 0 ? raw.claimedAt : undefined,
    completedAt: typeof raw.completedAt === "string" && raw.completedAt.length > 0 ? raw.completedAt : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
  };
}

function parseCandidate(id: string, value: unknown): CandidateRecord | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const objective = stringValue(raw.objective);
  const repository = stringValue(raw.repository);
  const worktreeRoot = stringValue(raw.worktreeRoot);
  const worktreeName = stringValue(raw.worktreeName);
  const directory = stringValue(raw.directory);
  const baseCommit = stringValue(raw.baseCommit);
  const statusText = stringValue(raw.status);
  const createdAt = stringValue(raw.createdAt);
  const updatedAt = stringValue(raw.updatedAt);
  if (
    !objective ||
    !repository ||
    !worktreeRoot ||
    !worktreeName ||
    !directory ||
    !baseCommit ||
    !statusText ||
    !CANDIDATE_STATUSES.has(statusText as CandidateStatus) ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  return {
    id,
    objective,
    repository,
    worktreeRoot,
    worktreeName,
    directory,
    baseCommit,
    branch: typeof raw.branch === "string" ? raw.branch : undefined,
    status: statusText as CandidateStatus,
    createdAt,
    updatedAt,
    version: positiveInteger(raw.version),
    evaluation: parseEvaluation(raw.evaluation),
    ...(typeof raw.promotedGenerationId === "string" && raw.promotedGenerationId.length > 0
      ? { promotedGenerationId: raw.promotedGenerationId }
      : {}),
    ...(typeof raw.promotedCommit === "string" && raw.promotedCommit.length > 0
      ? { promotedCommit: raw.promotedCommit }
      : {}),
    ...(typeof raw.promotedAt === "string" && raw.promotedAt.length > 0 ? { promotedAt: raw.promotedAt } : {}),
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
  };
}

export function loadSelfImprovementState(stateDir: string): SelfImprovementState {
  assertPrivateStateDir(stateDir, false);
  const statePath = getSelfImprovementStatePath(stateDir);
  if (!existsSync(statePath)) return createEmptySelfImprovementState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse self-improvement state: ${statePath}`, { cause: error });
  }
  const raw = record(parsed);
  const candidates = record(raw?.candidates);
  if (!raw || !candidates) throw new Error(`Malformed self-improvement state: ${statePath}`);
  const handoffs = record(raw.handoffs);
  if (raw.handoffs !== undefined && !handoffs) throw new Error(`Malformed self-improvement handoff state: ${statePath}`);

  const state = createEmptySelfImprovementState();
  for (const [id, value] of Object.entries(candidates)) {
    const candidate = parseCandidate(id, value);
    if (!candidate) throw new Error(`Malformed self-improvement candidate: ${id}`);
    state.candidates[id] = candidate;
  }
  if (handoffs) {
    for (const [id, value] of Object.entries(handoffs)) {
      const handoff = parseGenerationHandoff(id, value);
      if (!handoff) throw new Error(`Malformed self-improvement generation handoff: ${id}`);
      state.handoffs[id] = handoff;
    }
  }
  return state;
}

export function saveSelfImprovementState(stateDir: string, state: SelfImprovementState): string {
  const statePath = getSelfImprovementStatePath(stateDir);
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  assertPrivateStateDir(stateDir, true);
  try {
    const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
    // Make permissions final before publication so rename is the last fallible
    // step that can expose a new state snapshot.
    chmodSync(tempPath, mode);
    renameSync(tempPath, statePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return statePath;
}
