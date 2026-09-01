import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportOperationalError } from "@friday/operational-errors";
import type { TurnFinalizerDescriptor } from "./contract.js";

const DATABASE_SCHEMA_VERSION = 1;
export const TURN_REPLY_OUTBOX_DATABASE_FILE = "reply-outbox.sqlite";

export interface TurnReplyOutboxRecord {
  readonly turnKey: string;
  readonly ownerScope: string;
  readonly text: string;
  readonly sha256: string;
  readonly finalizers: readonly TurnFinalizerDescriptor[];
  readonly requiresFinalization: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnReplyOutbox {
  put(input: Omit<TurnReplyOutboxRecord, "sha256" | "createdAt" | "updatedAt">): TurnReplyOutboxRecord;
  get(turnKey: string, ownerScope: string): TurnReplyOutboxRecord | undefined;
  delete(turnKey: string, ownerScope: string): void;
  close(): void;
}

function replyHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clone(record: TurnReplyOutboxRecord): TurnReplyOutboxRecord {
  return Object.freeze({
    ...record,
    finalizers: Object.freeze(record.finalizers.map((entry) => Object.freeze({
      type: entry.type,
      payload: structuredClone(entry.payload),
    }))),
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function parseFinalizers(value: unknown): readonly TurnFinalizerDescriptor[] {
  if (typeof value !== "string") throw new Error("Turn reply outbox finalizers are invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Turn reply outbox finalizers contain invalid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length > 64) throw new Error("Turn reply outbox finalizers are invalid");
  return Object.freeze(parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Turn reply outbox finalizer is invalid");
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.type !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(candidate.type)) {
      throw new Error("Turn reply outbox finalizer type is invalid");
    }
    if (!("payload" in candidate) || !isJsonValue(candidate.payload)) {
      throw new Error("Turn reply outbox finalizer payload is invalid");
    }
    return Object.freeze({ type: candidate.type, payload: structuredClone(candidate.payload) }) as TurnFinalizerDescriptor;
  }));
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Turn reply outbox column ${key} is invalid`);
  return value;
}

function rowToRecord(row: Record<string, unknown>): TurnReplyOutboxRecord {
  const requiresFinalization = row.requires_finalization;
  if (requiresFinalization !== 0 && requiresFinalization !== 1) {
    throw new Error("Turn reply outbox requires_finalization is invalid");
  }
  const record: TurnReplyOutboxRecord = {
    turnKey: rowString(row, "turn_key"),
    ownerScope: rowString(row, "owner_scope"),
    text: rowString(row, "reply_text"),
    sha256: rowString(row, "reply_sha256"),
    finalizers: parseFinalizers(rowString(row, "finalizers_json")),
    requiresFinalization: requiresFinalization === 1,
    createdAt: rowString(row, "created_at"),
    updatedAt: rowString(row, "updated_at"),
  };
  if (replyHash(record.text) !== record.sha256) throw new Error("Turn reply outbox hash verification failed");
  return clone(record);
}

export function getTurnLoopStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "turn-loop");
}

export class SqliteTurnReplyOutbox implements TurnReplyOutbox {
  readonly path: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(stateDir = getTurnLoopStateDir()) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    this.path = join(stateDir, TURN_REPLY_OUTBOX_DATABASE_FILE);
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
        throw new Error(`Turn reply outbox schema is unsupported: ${String(version)}`);
      }
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS turn_replies (
          turn_key TEXT PRIMARY KEY,
          owner_scope TEXT NOT NULL,
          reply_text TEXT NOT NULL,
          reply_sha256 TEXT NOT NULL,
          finalizers_json TEXT NOT NULL,
          requires_finalization INTEGER NOT NULL CHECK(requires_finalization IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS turn_replies_owner_idx ON turn_replies(owner_scope, updated_at);
        PRAGMA user_version = 1;
      `);
      const integrity = this.#db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
      if (integrity?.quick_check !== "ok") {
        throw new Error(`Turn reply outbox quick_check failed: ${String(integrity?.quick_check)}`);
      }
    } catch (error) {
      try {
        this.#db.close();
      } catch (cleanupError) {
        reportOperationalError({
          component: "turn-loop",
          operation: "close reply outbox after initialization failure",
          operationCode: "reply-outbox-close",
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

  put(input: Omit<TurnReplyOutboxRecord, "sha256" | "createdAt" | "updatedAt">): TurnReplyOutboxRecord {
    this.#assertOpen();
    const now = new Date().toISOString();
    const sha256 = replyHash(input.text);
    const finalizersJson = JSON.stringify(input.finalizers);
    parseFinalizers(finalizersJson);
    this.#db.prepare(`
      INSERT INTO turn_replies(
        turn_key, owner_scope, reply_text, reply_sha256, finalizers_json,
        requires_finalization, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_key) DO UPDATE SET
        updated_at = excluded.updated_at
      WHERE turn_replies.owner_scope = excluded.owner_scope
        AND turn_replies.reply_sha256 = excluded.reply_sha256
        AND turn_replies.finalizers_json = excluded.finalizers_json
        AND turn_replies.requires_finalization = excluded.requires_finalization
    `).run(
      input.turnKey,
      input.ownerScope,
      input.text,
      sha256,
      finalizersJson,
      input.requiresFinalization ? 1 : 0,
      now,
      now,
    );
    const record = this.#getByKey(input.turnKey);
    if (!record || record.ownerScope !== input.ownerScope || record.sha256 !== sha256
      || JSON.stringify(record.finalizers) !== finalizersJson
      || record.requiresFinalization !== input.requiresFinalization) {
      throw new Error("Turn reply outbox key collides with a different durable result");
    }
    return record;
  }

  get(turnKey: string, ownerScope: string): TurnReplyOutboxRecord | undefined {
    this.#assertOpen();
    const record = this.#getByKey(turnKey);
    if (!record) return undefined;
    if (record.ownerScope !== ownerScope) throw new Error("Turn reply outbox owner does not match the current principal");
    return record;
  }

  delete(turnKey: string, ownerScope: string): void {
    this.#assertOpen();
    const result = this.#db.prepare("DELETE FROM turn_replies WHERE turn_key = ? AND owner_scope = ?").run(turnKey, ownerScope);
    if (Number(result.changes) > 1) throw new Error("Turn reply outbox deletion affected multiple rows");
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  #getByKey(turnKey: string): TurnReplyOutboxRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM turn_replies WHERE turn_key = ?").get(turnKey) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Turn reply outbox is closed");
  }
}

export class MemoryTurnReplyOutbox implements TurnReplyOutbox {
  readonly #records = new Map<string, TurnReplyOutboxRecord>();
  #closed = false;

  put(input: Omit<TurnReplyOutboxRecord, "sha256" | "createdAt" | "updatedAt">): TurnReplyOutboxRecord {
    this.#assertOpen();
    const existing = this.#records.get(input.turnKey);
    const now = new Date().toISOString();
    const candidate = clone({ ...input, sha256: replyHash(input.text), createdAt: existing?.createdAt ?? now, updatedAt: now });
    if (existing && (existing.ownerScope !== candidate.ownerScope || existing.sha256 !== candidate.sha256
      || JSON.stringify(existing.finalizers) !== JSON.stringify(candidate.finalizers)
      || existing.requiresFinalization !== candidate.requiresFinalization)) {
      throw new Error("Turn reply outbox key collides with a different durable result");
    }
    this.#records.set(input.turnKey, candidate);
    return clone(candidate);
  }

  get(turnKey: string, ownerScope: string): TurnReplyOutboxRecord | undefined {
    this.#assertOpen();
    const record = this.#records.get(turnKey);
    if (!record) return undefined;
    if (record.ownerScope !== ownerScope) throw new Error("Turn reply outbox owner does not match the current principal");
    return clone(record);
  }

  delete(turnKey: string, ownerScope: string): void {
    this.#assertOpen();
    const record = this.#records.get(turnKey);
    if (record && record.ownerScope === ownerScope) this.#records.delete(turnKey);
  }

  close(): void {
    this.#closed = true;
    this.#records.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Turn reply outbox is closed");
  }
}
