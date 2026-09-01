import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { reportOperationalError, sanitizeOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  JsonValue,
  MissedRunPolicy,
  ScheduledRetryPolicy,
  ScheduledRunRecord,
  ScheduledTask,
  ScheduledTaskLease,
  ScheduleSpec,
} from "./contract.js";
import { normalizeTimestamp, normalizeTimeZone, parseCronExpression } from "./cron.js";

export const SCHEDULER_DATABASE_FILE_NAME = "scheduler.sqlite";
export const LEGACY_SCHEDULER_STATE_FILE_NAME = "scheduler_state.json";
const DATABASE_SCHEMA_VERSION = 2;

interface SchedulerDatabaseOptions {
  stateDir: string;
  migrateLegacy?: boolean | undefined;
}

interface CompletionUpdate {
  taskId: string;
  leaseId: string;
  runId: string;
  completedAt: string;
  status: "success" | "error" | "cancelled";
  error?: string | undefined;
  enabled: boolean;
  nextRunAt: string;
  retryScheduledFor?: string | undefined;
  consecutiveFailures: number;
  consecutiveFailedOccurrences: number;
}

function assertExactlyOneChange(result: { readonly changes: number | bigint }, operation: string): void {
  if (Number(result.changes) !== 1) {
    throw new Error(`${operation} affected ${String(result.changes)} rows; expected exactly one`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  const record = objectRecord(value);
  return record !== undefined && Object.values(record).every((entry) => isJsonValue(entry));
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (typeof value !== "string") throw new Error(`scheduler database ${label} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`scheduler database ${label} contains invalid JSON`, { cause: error });
  }
  if (!isJsonValue(parsed)) throw new Error(`scheduler database ${label} is not a JSON value`);
  return parsed;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJsonValue(value, label);
  const record = objectRecord(parsed);
  if (!record) throw new Error(`scheduler database ${label} must contain a JSON object`);
  return record;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`scheduler database column ${key} is invalid`);
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`scheduler database column ${key} is invalid`);
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`scheduler database column ${key} is invalid`);
  return value;
}

function parseScheduleJson(value: unknown): ScheduleSpec {
  const record = parseJsonObject(value, "schedule_json");
  if (record.kind === "once" && typeof record.at === "string") {
    return { kind: "once", at: normalizeTimestamp(record.at, "once.at") };
  }
  if (record.kind === "interval" && typeof record.everyMs === "number" && Number.isInteger(record.everyMs) && record.everyMs > 0) {
    return {
      kind: "interval",
      everyMs: record.everyMs,
      ...(typeof record.startAt === "string" ? { startAt: normalizeTimestamp(record.startAt, "interval.startAt") } : {}),
    };
  }
  if (record.kind === "cron" && typeof record.expression === "string" && typeof record.timezone === "string") {
    const expression = record.expression.trim().replace(/\s+/g, " ");
    parseCronExpression(expression);
    return { kind: "cron", expression, timezone: normalizeTimeZone(record.timezone) };
  }
  throw new Error("scheduler database schedule_json is invalid");
}

function parseRetryJson(value: unknown): ScheduledRetryPolicy {
  const record = parseJsonObject(value, "retry_json");
  const maxAttempts = record.maxAttempts;
  const initialDelayMs = record.initialDelayMs;
  const multiplier = record.multiplier;
  const maxDelayMs = record.maxDelayMs;
  if (
    typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
    typeof initialDelayMs !== "number" || !Number.isInteger(initialDelayMs) || initialDelayMs < 1 ||
    typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 1 ||
    typeof maxDelayMs !== "number" || !Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs
  ) {
    throw new Error("scheduler database retry_json is invalid");
  }
  return { maxAttempts, initialDelayMs, multiplier, maxDelayMs };
}

function parseMissedRunPolicy(value: unknown): MissedRunPolicy {
  if (value === "coalesce" || value === "catch-up" || value === "skip") return value;
  throw new Error("scheduler database missed_run_policy is invalid");
}

function rowToLease(row: Record<string, unknown>): ScheduledTaskLease | undefined {
  const id = rowOptionalString(row, "lease_id");
  const claimedAt = rowOptionalString(row, "lease_claimed_at");
  const expiresAt = rowOptionalString(row, "lease_expires_at");
  if (!id && !claimedAt && !expiresAt) return undefined;
  if (!id || !claimedAt || !expiresAt) throw new Error("scheduler database lease columns are inconsistent");
  return {
    id,
    claimedAt: normalizeTimestamp(claimedAt, "lease.claimedAt"),
    expiresAt: normalizeTimestamp(expiresAt, "lease.expiresAt"),
  };
}

function rowToRun(row: Record<string, unknown>): ScheduledRunRecord {
  const status = rowString(row, "status");
  if (status !== "running" && status !== "success" && status !== "error" && status !== "cancelled" && status !== "abandoned") {
    throw new Error("scheduler database run status is invalid");
  }
  const completedAt = rowOptionalString(row, "completed_at");
  const error = rowOptionalString(row, "error");
  return {
    runId: rowString(row, "run_id"),
    taskId: rowString(row, "task_id"),
    scheduledFor: normalizeTimestamp(rowString(row, "scheduled_for"), "run.scheduledFor"),
    idempotencyKey: rowString(row, "idempotency_key"),
    attempt: rowInteger(row, "attempt"),
    startedAt: normalizeTimestamp(rowString(row, "started_at"), "run.startedAt"),
    ...(completedAt ? { completedAt: normalizeTimestamp(completedAt, "run.completedAt") } : {}),
    status,
    ...(error ? { error } : {}),
  };
}

function rowToTask(row: Record<string, unknown>, lastRun?: ScheduledRunRecord): ScheduledTask {
  const enabled = rowInteger(row, "enabled");
  if (enabled !== 0 && enabled !== 1) throw new Error("scheduler database enabled is invalid");
  const maxCatchUpRuns = rowInteger(row, "max_catch_up_runs");
  const consecutiveFailures = rowInteger(row, "consecutive_failures");
  const consecutiveFailedOccurrences = rowInteger(row, "consecutive_failed_occurrences");
  if (maxCatchUpRuns < 1 || consecutiveFailures < 0 || consecutiveFailedOccurrences < 0) throw new Error("scheduler database task counters are invalid");
  const retryScheduledFor = rowOptionalString(row, "retry_scheduled_for");
  return {
    id: rowString(row, "id"),
    name: rowString(row, "name"),
    taskType: rowString(row, "task_type"),
    payload: parseJsonValue(rowString(row, "payload_json"), "payload_json"),
    schedule: parseScheduleJson(rowString(row, "schedule_json")),
    enabled: enabled === 1,
    nextRunAt: normalizeTimestamp(rowString(row, "next_run_at"), "task.nextRunAt"),
    createdAt: normalizeTimestamp(rowString(row, "created_at"), "task.createdAt"),
    updatedAt: normalizeTimestamp(rowString(row, "updated_at"), "task.updatedAt"),
    missedRunPolicy: parseMissedRunPolicy(row.missed_run_policy),
    maxCatchUpRuns,
    retry: parseRetryJson(rowString(row, "retry_json")),
    consecutiveFailures,
    consecutiveFailedOccurrences,
    ...(retryScheduledFor ? { retryScheduledFor: normalizeTimestamp(retryScheduledFor, "task.retryScheduledFor") } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(rowToLease(row) ? { lease: rowToLease(row)! } : {}),
  };
}

function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
  if (version > DATABASE_SCHEMA_VERSION) throw new Error(`Scheduler database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      next_run_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      missed_run_policy TEXT NOT NULL,
      max_catch_up_runs INTEGER NOT NULL,
      retry_json TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      consecutive_failed_occurrences INTEGER NOT NULL DEFAULT 0,
      retry_scheduled_for TEXT,
      lease_id TEXT,
      lease_claimed_at TEXT,
      lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduler_tasks_due_idx
      ON scheduler_tasks(enabled, next_run_at, lease_expires_at);

    CREATE TABLE IF NOT EXISTS scheduler_runs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      lease_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      error TEXT,
      UNIQUE(task_id, scheduled_for, attempt),
      FOREIGN KEY(task_id) REFERENCES scheduler_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS scheduler_runs_task_idx
      ON scheduler_runs(task_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS scheduler_runs_idempotency_idx
      ON scheduler_runs(idempotency_key, sequence DESC);
  `);
  if (version < 2) {
    const columns = db.prepare("PRAGMA table_info(scheduler_tasks)").all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === "consecutive_failed_occurrences")) {
      db.exec("ALTER TABLE scheduler_tasks ADD COLUMN consecutive_failed_occurrences INTEGER NOT NULL DEFAULT 0");
    }
  }
  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
  const integrity = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (integrity?.quick_check !== "ok") throw new Error(`Scheduler database quick_check failed: ${String(integrity?.quick_check)}`);
}

function defaultRetry(): ScheduledRetryPolicy {
  return { maxAttempts: 5, initialDelayMs: 60_000, multiplier: 2, maxDelayMs: 15 * 60_000 };
}

function loadLegacyTasks(path: string): ScheduledTask[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse scheduler state: ${sanitizeOperationalError(error).safeMessage}`);
  }
  const root = objectRecord(parsed);
  const tasks = objectRecord(root?.tasks);
  if (!root || root.schema !== 1 || !tasks) throw new Error("Unsupported or malformed scheduler state");
  const result: ScheduledTask[] = [];
  for (const [id, raw] of Object.entries(tasks)) {
    const record = objectRecord(raw);
    if (!record || record.id !== id || typeof record.name !== "string" || typeof record.taskType !== "string" || !isJsonValue(record.payload)) {
      throw new Error(`Malformed scheduler task: ${id}`);
    }
    if (typeof record.enabled !== "boolean" || typeof record.nextRunAt !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
      throw new Error(`Malformed scheduler task: ${id}`);
    }
    const scheduleRecord = objectRecord(record.schedule);
    if (!scheduleRecord) throw new Error(`Malformed scheduler task: ${id}`);
    let schedule: ScheduleSpec;
    if (scheduleRecord.kind === "once" && typeof scheduleRecord.at === "string") {
      schedule = { kind: "once", at: normalizeTimestamp(scheduleRecord.at, "once.at") };
    } else if (scheduleRecord.kind === "interval" && typeof scheduleRecord.everyMs === "number" && Number.isInteger(scheduleRecord.everyMs) && scheduleRecord.everyMs > 0) {
      schedule = {
        kind: "interval",
        everyMs: scheduleRecord.everyMs,
        ...(typeof scheduleRecord.startAt === "string" ? { startAt: normalizeTimestamp(scheduleRecord.startAt, "interval.startAt") } : {}),
      };
    } else {
      throw new Error(`Malformed scheduler task: ${id}`);
    }
    result.push({
      id,
      name: record.name,
      taskType: record.taskType,
      payload: record.payload,
      schedule,
      enabled: record.enabled,
      nextRunAt: normalizeTimestamp(record.nextRunAt, "task.nextRunAt"),
      createdAt: normalizeTimestamp(record.createdAt, "task.createdAt"),
      updatedAt: normalizeTimestamp(record.updatedAt, "task.updatedAt"),
      missedRunPolicy: "coalesce",
      maxCatchUpRuns: 10,
      retry: defaultRetry(),
      consecutiveFailures: 0,
      consecutiveFailedOccurrences: 0,
    });
  }
  return result;
}

export function getSchedulerStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "scheduler");
}

export function getSchedulerDatabasePath(stateDir: string): string {
  return join(stateDir, SCHEDULER_DATABASE_FILE_NAME);
}

export function getSchedulerStatePath(stateDir: string): string {
  return join(stateDir, LEGACY_SCHEDULER_STATE_FILE_NAME);
}

export class SchedulerDatabase {
  readonly path: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(options: SchedulerDatabaseOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    this.path = getSchedulerDatabasePath(options.stateDir);
    const existed = existsSync(this.path);
    const legacyTasks = !existed && options.migrateLegacy !== false ? loadLegacyTasks(getSchedulerStatePath(options.stateDir)) : [];
    if (!existed) {
      const descriptor = openSync(this.path, "a", 0o600);
      closeSync(descriptor);
    } else {
      chmodSync(this.path, 0o600);
    }
    this.#db = new DatabaseSync(this.path);
    try {
      configureDatabase(this.#db);
      chmodSync(this.path, 0o600);
      if (legacyTasks.length > 0 && this.listTasks().length === 0) {
        this.#transaction(() => {
          for (const task of legacyTasks) this.#insertTask(task);
        });
      }
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      if (!existed) {
        rmSync(this.path, { force: true });
        rmSync(`${this.path}-wal`, { force: true });
        rmSync(`${this.path}-shm`, { force: true });
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  createTask(task: ScheduledTask): ScheduledTask {
    this.#assertOpen();
    this.#transaction(() => this.#insertTask(task));
    return this.getTask(task.id)!;
  }

  getTask(id: string): ScheduledTask | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const lastRunRow = this.#db.prepare("SELECT * FROM scheduler_runs WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
    return rowToTask(row, lastRunRow ? rowToRun(lastRunRow) : undefined);
  }

  listTasks(): ScheduledTask[] {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT * FROM scheduler_tasks ORDER BY next_run_at, id").all() as Record<string, unknown>[];
    return rows.map((row) => {
      const id = rowString(row, "id");
      const lastRunRow = this.#db.prepare("SELECT * FROM scheduler_runs WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return rowToTask(row, lastRunRow ? rowToRun(lastRunRow) : undefined);
    });
  }

  listDueTaskIds(nowIso: string, limit: number): string[] {
    this.#assertOpen();
    const rows = this.#db.prepare(`
      SELECT id FROM scheduler_tasks
      WHERE enabled = 1
        AND next_run_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY next_run_at, id
      LIMIT ?
    `).all(nowIso, nowIso, limit) as Record<string, unknown>[];
    return rows.map((row) => rowString(row, "id"));
  }

  cancelTask(id: string, updatedAt: string): ScheduledTask | undefined {
    this.#assertOpen();
    const result = this.#db.prepare("UPDATE scheduler_tasks SET enabled = 0, updated_at = ? WHERE id = ?").run(updatedAt, id);
    if (Number(result.changes) > 1) throw new Error("scheduler task cancellation affected multiple rows");
    return this.getTask(id);
  }

  removeTask(id: string, nowIso: string): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT lease_expires_at FROM scheduler_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return false;
      const leaseExpiresAt = rowOptionalString(row, "lease_expires_at");
      if (leaseExpiresAt && leaseExpiresAt > nowIso) throw new Error(`Cannot remove scheduled task with an active lease: ${id}`);
      return this.#db.prepare("DELETE FROM scheduler_tasks WHERE id = ?").run(id).changes > 0;
    });
  }

  updateMissedTask(
    id: string,
    nextRunAt: string,
    enabled: boolean,
    updatedAt: string,
    originalScheduledFor?: string,
  ): void {
    this.#assertOpen();
    const result = this.#db.prepare(`
      UPDATE scheduler_tasks
      SET next_run_at = ?, enabled = ?, updated_at = ?,
          retry_scheduled_for = COALESCE(retry_scheduled_for, ?)
      WHERE id = ? AND (lease_id IS NULL OR lease_expires_at <= ?)
    `).run(nextRunAt, enabled ? 1 : 0, updatedAt, originalScheduledFor ?? null, id, updatedAt);
    assertExactlyOneChange(result, "scheduler missed-task update");
  }

  claimTask(id: string, nowIso: string, leaseMs: number, leaseId: string, runId: string): { task: ScheduledTask; run: ScheduledRunRecord } | undefined {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const task = rowToTask(row);
      if (!task.enabled || task.nextRunAt > nowIso) return undefined;
      if (task.lease && task.lease.expiresAt > nowIso) return undefined;

      if (task.lease) {
        const abandoned = this.#db.prepare(`
          UPDATE scheduler_runs
          SET status = 'abandoned', completed_at = ?, error = COALESCE(error, 'execution lease expired before completion')
          WHERE task_id = ? AND lease_id = ? AND status = 'running'
        `).run(nowIso, id, task.lease.id);
        assertExactlyOneChange(abandoned, "scheduler expired-run abandonment");
      }

      const scheduledFor = task.retryScheduledFor ?? task.nextRunAt;
      const attemptRow = this.#db.prepare(`
        SELECT COALESCE(MAX(attempt), 0) AS max_attempt
        FROM scheduler_runs WHERE task_id = ? AND scheduled_for = ?
      `).get(id, scheduledFor) as Record<string, unknown>;
      const attempt = rowInteger(attemptRow, "max_attempt") + 1;
      const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
      const idempotencyKey = `scheduler:${id}:${scheduledFor}`;
      const leaseUpdate = this.#db.prepare(`
        UPDATE scheduler_tasks
        SET lease_id = ?, lease_claimed_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(leaseId, nowIso, expiresAt, nowIso, id);
      assertExactlyOneChange(leaseUpdate, "scheduler task claim");
      const runInsert = this.#db.prepare(`
        INSERT INTO scheduler_runs(
          run_id, task_id, scheduled_for, idempotency_key, attempt, lease_id, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
      `).run(runId, id, scheduledFor, idempotencyKey, attempt, leaseId, nowIso);
      assertExactlyOneChange(runInsert, "scheduler run insertion");
      const claimed = this.getTask(id)!;
      const run: ScheduledRunRecord = {
        runId,
        taskId: id,
        scheduledFor,
        idempotencyKey,
        attempt,
        startedAt: nowIso,
        status: "running",
      };
      return { task: claimed, run };
    });
  }

  renewLease(taskId: string, leaseId: string, nowIso: string, leaseMs: number): boolean {
    this.#assertOpen();
    const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
    const result = this.#db.prepare(`
      UPDATE scheduler_tasks
      SET lease_claimed_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).run(nowIso, expiresAt, nowIso, taskId, leaseId);
    return result.changes > 0;
  }

  completeClaim(update: CompletionUpdate): ScheduledTask {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(update.taskId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Scheduled task disappeared while executing: ${update.taskId}`);
      const persisted = rowToTask(row);
      if (persisted.lease?.id !== update.leaseId) throw new Error(`Scheduled task lease changed while executing: ${update.taskId}`);
      const effectiveEnabled = persisted.enabled && update.enabled;
      const runUpdate = this.#db.prepare(`
        UPDATE scheduler_runs
        SET completed_at = ?, status = ?, error = ?
        WHERE run_id = ? AND lease_id = ? AND status = 'running'
      `).run(update.completedAt, update.status, update.error ?? null, update.runId, update.leaseId);
      assertExactlyOneChange(runUpdate, "scheduler run completion");
      const taskUpdate = this.#db.prepare(`
        UPDATE scheduler_tasks
        SET enabled = ?, next_run_at = ?, updated_at = ?,
            consecutive_failures = ?, consecutive_failed_occurrences = ?, retry_scheduled_for = ?,
            lease_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_id = ?
      `).run(
        effectiveEnabled ? 1 : 0,
        update.nextRunAt,
        update.completedAt,
        update.consecutiveFailures,
        update.consecutiveFailedOccurrences,
        update.retryScheduledFor ?? null,
        update.taskId,
        update.leaseId,
      );
      assertExactlyOneChange(taskUpdate, "scheduler task completion");
      return this.getTask(update.taskId)!;
    });
  }

  abandonExpiredLeases(nowIso: string): number {
    this.#assertOpen();
    return this.#transaction(() => {
      const expired = this.#db.prepare(`
        SELECT id, lease_id FROM scheduler_tasks
        WHERE lease_id IS NOT NULL AND lease_expires_at <= ?
      `).all(nowIso) as Record<string, unknown>[];
      for (const row of expired) {
        const taskId = rowString(row, "id");
        const leaseId = rowString(row, "lease_id");
        const runUpdate = this.#db.prepare(`
          UPDATE scheduler_runs
          SET status = 'abandoned', completed_at = ?, error = COALESCE(error, 'execution lease expired before completion')
          WHERE task_id = ? AND lease_id = ? AND status = 'running'
        `).run(nowIso, taskId, leaseId);
        assertExactlyOneChange(runUpdate, "scheduler expired-run recovery");
      }
      const taskUpdate = this.#db.prepare(`
        UPDATE scheduler_tasks
        SET lease_id = NULL, lease_claimed_at = NULL, lease_expires_at = NULL
        WHERE lease_id IS NOT NULL AND lease_expires_at <= ?
      `).run(nowIso);
      if (Number(taskUpdate.changes) !== expired.length) {
        throw new Error(`scheduler expired-lease recovery affected ${String(taskUpdate.changes)} rows; expected ${expired.length}`);
      }
      return expired.length;
    });
  }

  history(taskId: string | undefined, limit: number): ScheduledRunRecord[] {
    this.#assertOpen();
    const rows = (taskId
      ? this.#db.prepare("SELECT * FROM scheduler_runs WHERE task_id = ? ORDER BY sequence DESC LIMIT ?").all(taskId, limit)
      : this.#db.prepare("SELECT * FROM scheduler_runs ORDER BY sequence DESC LIMIT ?").all(limit)) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  #insertTask(task: ScheduledTask): void {
    this.#db.prepare(`
      INSERT INTO scheduler_tasks(
        id, name, task_type, payload_json, schedule_json, enabled, next_run_at,
        created_at, updated_at, missed_run_policy, max_catch_up_runs, retry_json,
        consecutive_failures, consecutive_failed_occurrences, retry_scheduled_for, lease_id, lease_claimed_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.name,
      task.taskType,
      JSON.stringify(task.payload),
      JSON.stringify(task.schedule),
      task.enabled ? 1 : 0,
      task.nextRunAt,
      task.createdAt,
      task.updatedAt,
      task.missedRunPolicy,
      task.maxCatchUpRuns,
      JSON.stringify(task.retry),
      task.consecutiveFailures,
      task.consecutiveFailedOccurrences,
      task.retryScheduledFor ?? null,
      task.lease?.id ?? null,
      task.lease?.claimedAt ?? null,
      task.lease?.expiresAt ?? null,
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("scheduler database is closed");
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch (rollbackError) {
        reportOperationalError({ component: "scheduler", operation: "rollback failed database transaction", error: rollbackError });
        throw new AggregateError([error, rollbackError], "Scheduler transaction failed and rollback also failed");
      }
      throw error;
    }
  }
}
