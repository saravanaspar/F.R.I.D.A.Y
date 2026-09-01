import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportOperationalError } from "@friday/operational-errors";
import type { ConditionalHookPhase, ConditionalHookRule } from "./contract.js";

const DATABASE_SCHEMA_VERSION = 1;
export const CONDITIONAL_HOOKS_DATABASE_FILE = "hooks.sqlite";

function stateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "conditional-hooks");
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Conditional-hook column ${key} is invalid`);
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Conditional-hook column ${key} is invalid`);
  return value;
}

function phase(value: unknown): ConditionalHookPhase {
  if (value === "turn" || value === "before-action" || value === "after-action" || value === "before-handover") return value;
  throw new Error("Conditional-hook phase is invalid");
}

function rowToRule(row: Record<string, unknown>): ConditionalHookRule {
  const maximum = row.max_invocations;
  if (maximum !== null && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)) {
    throw new Error("Conditional-hook max_invocations is invalid");
  }
  const enabled = rowInteger(row, "enabled");
  if (enabled !== 0 && enabled !== 1) throw new Error("Conditional-hook enabled flag is invalid");
  return Object.freeze({
    id: rowString(row, "id"),
    ownerScope: rowString(row, "owner_scope"),
    condition: rowString(row, "condition_text"),
    instruction: rowString(row, "instruction_text"),
    phase: phase(row.phase),
    maxInvocations: maximum as number | null,
    invocationCount: rowInteger(row, "invocation_count"),
    enabled: enabled === 1,
    createdAt: rowString(row, "created_at"),
    updatedAt: rowString(row, "updated_at"),
  });
}

function assertOne(result: { readonly changes: number | bigint }, operation: string): void {
  if (Number(result.changes) !== 1) throw new Error(`${operation} affected ${String(result.changes)} rows; expected exactly one`);
}

export class ConditionalHookStore {
  readonly path: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(explicitStateDir = stateDir()) {
    mkdirSync(explicitStateDir, { recursive: true, mode: 0o700 });
    chmodSync(explicitStateDir, 0o700);
    this.path = join(explicitStateDir, CONDITIONAL_HOOKS_DATABASE_FILE);
    const existed = existsSync(this.path);
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.#db.exec("PRAGMA trusted_schema = OFF");
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA synchronous = FULL");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
      if (typeof version !== "number" || version < 0 || version > DATABASE_SCHEMA_VERSION) {
        throw new Error(`Conditional-hooks database schema is unsupported: ${String(version)}`);
      }
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS conditional_hooks (
          id TEXT PRIMARY KEY,
          owner_scope TEXT NOT NULL,
          condition_text TEXT NOT NULL,
          instruction_text TEXT NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('turn', 'before-action', 'after-action', 'before-handover')),
          max_invocations INTEGER CHECK(max_invocations IS NULL OR max_invocations > 0),
          invocation_count INTEGER NOT NULL DEFAULT 0 CHECK(invocation_count >= 0),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conditional_hooks_owner_idx
          ON conditional_hooks(owner_scope, enabled, created_at);
        PRAGMA user_version = 1;
      `);
      const integrity = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
      if (integrity?.quick_check !== "ok") {
        throw new Error(`Conditional-hooks database quick_check failed: ${String(integrity?.quick_check)}`);
      }
    } catch (error) {
      try {
        this.#db.close();
      } catch (cleanupError) {
        reportOperationalError({
          component: "conditional-hooks",
          operation: "close database after initialization failure",
          operationCode: "database-close",
          error: cleanupError,
          severity: "warn",
          outcome: "degraded",
        });
      }
      if (!existed) {
        rmSync(this.path, { force: true });
        rmSync(`${this.path}-wal`, { force: true });
        rmSync(`${this.path}-shm`, { force: true });
      }
      throw error;
    }
  }

  list(ownerScope: string): readonly ConditionalHookRule[] {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT * FROM conditional_hooks WHERE owner_scope = ? ORDER BY created_at, id").all(ownerScope) as Record<string, unknown>[];
    return Object.freeze(rows.map(rowToRule));
  }

  create(input: {
    ownerScope: string;
    condition: string;
    instruction: string;
    phase: ConditionalHookPhase;
    maxInvocations: number | null;
  }): ConditionalHookRule {
    this.#assertOpen();
    const id = `hook-${randomUUID()}`;
    const now = new Date().toISOString();
    const result = this.#db.prepare(`
      INSERT INTO conditional_hooks(
        id, owner_scope, condition_text, instruction_text, phase,
        max_invocations, invocation_count, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
    `).run(id, input.ownerScope, input.condition, input.instruction, input.phase, input.maxInvocations, now, now);
    assertOne(result, "Conditional-hook insertion");
    return this.#get(input.ownerScope, id)!;
  }

  remove(ownerScope: string, id: string): boolean {
    this.#assertOpen();
    const result = this.#db.prepare("DELETE FROM conditional_hooks WHERE owner_scope = ? AND id = ?").run(ownerScope, id);
    if (Number(result.changes) > 1) throw new Error("Conditional-hook deletion affected multiple rows");
    return Number(result.changes) === 1;
  }

  invoke(ownerScope: string, id: string): ConditionalHookRule | undefined {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#get(ownerScope, id);
      if (!current || !current.enabled || (current.maxInvocations !== null && current.invocationCount >= current.maxInvocations)) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const now = new Date().toISOString();
      const result = this.#db.prepare(`
        UPDATE conditional_hooks
        SET invocation_count = invocation_count + 1,
            enabled = CASE
              WHEN max_invocations IS NOT NULL AND invocation_count + 1 >= max_invocations THEN 0
              ELSE enabled
            END,
            updated_at = ?
        WHERE owner_scope = ? AND id = ? AND enabled = 1
          AND (max_invocations IS NULL OR invocation_count < max_invocations)
      `).run(now, ownerScope, id);
      assertOne(result, "Conditional-hook invocation");
      const updated = this.#get(ownerScope, id)!;
      this.#db.exec("COMMIT");
      return updated;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch (rollbackError) {
        reportOperationalError({
          component: "conditional-hooks",
          operation: "rollback hook invocation",
          operationCode: "transaction-rollback",
          error: rollbackError,
          severity: "warn",
          outcome: "degraded",
        });
      }
      throw error;
    }
  }

  status(): { total: number; active: number; exhausted: number } {
    this.#assertOpen();
    const row = this.#db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS exhausted
      FROM conditional_hooks
    `).get() as Record<string, unknown>;
    const number = (name: string): number => typeof row[name] === "number" ? row[name] as number : 0;
    return Object.freeze({ total: number("total"), active: number("active"), exhausted: number("exhausted") });
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  #get(ownerScope: string, id: string): ConditionalHookRule | undefined {
    const row = this.#db.prepare("SELECT * FROM conditional_hooks WHERE owner_scope = ? AND id = ?").get(ownerScope, id) as Record<string, unknown> | undefined;
    return row ? rowToRule(row) : undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Conditional-hooks store is closed");
  }
}
