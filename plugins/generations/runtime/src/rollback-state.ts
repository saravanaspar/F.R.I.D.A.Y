import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GenerationsStateError } from "./errors.js";
import type { RollbackPlan, RollbackTransaction, RollbackTransactionPhase } from "./types.js";

export const GENERATIONS_ROLLBACK_FILE_NAME = "rollback.json";

export function getRollbackTransactionPath(stateDir: string): string {
  return join(stateDir, GENERATIONS_ROLLBACK_FILE_NAME);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GenerationsStateError(`invalid rollback transaction at ${path}: ${field} must be a string`);
  }
  return value;
}

function parsePlan(value: unknown, path: string): RollbackPlan {
  const raw = record(value);
  if (!raw) throw new GenerationsStateError(`invalid rollback transaction at ${path}: plan must be an object`);
  return {
    activeGenerationId: requiredString(raw.activeGenerationId, "plan.activeGenerationId", path),
    targetGenerationId: requiredString(raw.targetGenerationId, "plan.targetGenerationId", path),
    expectedHeadCommit: requiredString(raw.expectedHeadCommit, "plan.expectedHeadCommit", path),
    targetCommit: requiredString(raw.targetCommit, "plan.targetCommit", path),
    targetRef: requiredString(raw.targetRef, "plan.targetRef", path),
    plannedAt: requiredString(raw.plannedAt, "plan.plannedAt", path),
  };
}

export function loadRollbackTransaction(stateDir: string): RollbackTransaction | undefined {
  const path = getRollbackTransactionPath(stateDir);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new GenerationsStateError(
      `invalid rollback transaction at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = record(parsed);
  if (!raw || raw.schema !== 1) throw new GenerationsStateError(`invalid rollback transaction at ${path}`);
  const phase = raw.phase;
  if (phase !== "prepared" && phase !== "head-moved") {
    throw new GenerationsStateError(`invalid rollback transaction at ${path}: unknown phase`);
  }
  return {
    schema: 1,
    id: requiredString(raw.id, "id", path),
    phase: phase as RollbackTransactionPhase,
    plan: parsePlan(raw.plan, path),
    createdAt: requiredString(raw.createdAt, "createdAt", path),
    updatedAt: requiredString(raw.updatedAt, "updatedAt", path),
  };
}

export function saveRollbackTransaction(stateDir: string, transaction: RollbackTransaction): string {
  const path = getRollbackTransactionPath(stateDir);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  try {
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
    writeFileSync(tempPath, `${JSON.stringify(transaction, null, 2)}\n`, { encoding: "utf8", mode });
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return path;
}

export function removeRollbackTransaction(stateDir: string): void {
  const path = getRollbackTransactionPath(stateDir);
  if (existsSync(path)) unlinkSync(path);
}
