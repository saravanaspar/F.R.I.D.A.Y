import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_JOBS_DATABASE_FILE = "jobs.sqlite";
export const SESSION_JOBS_LEGACY_FILE = "jobs.json";
const MIGRATED_LEGACY_FILE = "jobs.v1.migrated.json";
const DATABASE_SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_DATABASE_BYTES = 96 * 1024 * 1024;

export interface StoredSessionJob {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: string;
}

export interface SessionJobStoreOptions<T extends StoredSessionJob> {
  readonly stateDir: string;
  readonly maxRecords: number;
  readonly maxActiveRecords: number;
  readonly isActive: (status: T["status"]) => boolean;
  readonly parse: (value: unknown) => T;
  readonly loadLegacy: (path: string) => Promise<readonly T[]>;
}

function assertPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`Session-jobs state must be a private directory: ${path}`);
  }
}

function assertPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`Session-jobs state permissions are too broad or the path is unsafe: ${path}`);
  }
}

function initialize(db: DatabaseSync): void {
  db.exec("PRAGMA trusted_schema = OFF");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
  if (typeof version !== "number" || version < 0 || version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Session-jobs database schema is unsupported: ${String(version)}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at, id);
    CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs(active, created_at DESC);
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
  const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: unknown } | undefined;
  if (integrity?.quick_check !== "ok") {
    throw new Error(`Session-jobs database quick_check failed: ${String(integrity?.quick_check)}`);
  }
}

function rowText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`Session-jobs database column ${field} is invalid`);
  return value;
}

export class SessionJobStore<T extends StoredSessionJob> {
  readonly #stateDir: string;
  readonly #databasePath: string;
  readonly #db: DatabaseSync;
  readonly #options: SessionJobStoreOptions<T>;
  #closed = false;

  private constructor(options: SessionJobStoreOptions<T>, db: DatabaseSync) {
    this.#stateDir = resolve(options.stateDir);
    this.#databasePath = join(this.#stateDir, SESSION_JOBS_DATABASE_FILE);
    this.#options = options;
    this.#db = db;
  }

  static async open<T extends StoredSessionJob>(options: SessionJobStoreOptions<T>): Promise<SessionJobStore<T>> {
    const stateDir = resolve(options.stateDir);
    assertPrivateDirectory(stateDir);
    const databasePath = join(stateDir, SESSION_JOBS_DATABASE_FILE);
    if (existsSync(databasePath)) assertPrivateFile(databasePath);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath);
      chmodSync(databasePath, 0o600);
      assertPrivateFile(databasePath);
      initialize(db);
      const store = new SessionJobStore(options, db);
      await store.#migrateLegacy();
      store.#assertSidecarPermissions();
      return store;
    } catch (error) {
      try { db?.close(); } catch (closeError) {
        throw new AggregateError([error, closeError], "Session-jobs database failed to open and close");
      }
      throw error;
    }
  }

  load(): T[] {
    this.#assertOpen();
    this.#assertDatabaseBounds();
    const counts = this.#db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM jobs
    `).get() as { total: number; active: number };
    if (Number(counts.total) > this.#options.maxRecords) {
      throw new Error(`session-jobs record limit exceeded (${this.#options.maxRecords})`);
    }
    if (Number(counts.active) > this.#options.maxActiveRecords) {
      throw new Error(`session-jobs active job limit exceeded (${this.#options.maxActiveRecords})`);
    }
    const rows = this.#db.prepare("SELECT id, created_at, updated_at, active, payload_json FROM jobs ORDER BY created_at, id").all() as Record<string, unknown>[];
    return rows.map((row) => {
      const payload = rowText(row, "payload_json");
      if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error(`Session-jobs payload is too large: ${rowText(row, "id")}`);
      let parsed: unknown;
      try { parsed = JSON.parse(payload) as unknown; } catch (error) {
        throw new Error(`Session-jobs payload is corrupt: ${rowText(row, "id")}`, { cause: error });
      }
      const job = this.#options.parse(parsed);
      if (
        job.id !== rowText(row, "id")
        || job.createdAt !== rowText(row, "created_at")
        || job.updatedAt !== rowText(row, "updated_at")
        || Number(row.active) !== (this.#options.isActive(job.status) ? 1 : 0)
      ) throw new Error(`Session-jobs database metadata disagrees with payload: ${job.id}`);
      return job;
    });
  }

  save(records: readonly T[]): ReadonlySet<string> {
    this.#assertOpen();
    const unique = new Set<string>();
    for (const record of records) {
      if (unique.has(record.id)) throw new Error(`duplicate session-job update ${record.id}`);
      unique.add(record.id);
    }
    const upsert = this.#db.prepare(`
      INSERT INTO jobs(id, created_at, updated_at, active, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        active = excluded.active,
        payload_json = excluded.payload_json
    `);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const payload = JSON.stringify(record);
        if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error(`Session-job payload is too large: ${record.id}`);
        const result = upsert.run(record.id, record.createdAt, record.updatedAt, this.#options.isActive(record.status) ? 1 : 0, payload);
        if (Number(result.changes) !== 1) throw new Error(`Session-job save affected ${String(result.changes)} rows for ${record.id}`);
      }
      const active = Number((this.#db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE active = 1").get() as { count: number }).count);
      if (active > this.#options.maxActiveRecords) {
        throw new Error(`session-jobs active job limit exceeded (${this.#options.maxActiveRecords})`);
      }
      const inactiveBudget = Math.max(0, this.#options.maxRecords - active);
      this.#db.prepare(`
        DELETE FROM jobs WHERE id IN (
          SELECT id FROM jobs WHERE active = 0 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
        )
      `).run(inactiveBudget);
      this.#db.exec("COMMIT");
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Session-jobs transaction and rollback both failed");
      }
      throw error;
    }
    this.#assertSidecarPermissions();
    this.#assertDatabaseBounds();
    const retained = new Set((this.#db.prepare("SELECT id FROM jobs").all() as Record<string, unknown>[]).map((row) => rowText(row, "id")));
    return retained;
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }

  async #migrateLegacy(): Promise<void> {
    const legacyPath = join(this.#stateDir, SESSION_JOBS_LEGACY_FILE);
    const migratedPath = join(this.#stateDir, MIGRATED_LEGACY_FILE);
    const marker = this.#db.prepare("SELECT value FROM metadata WHERE key = 'legacy-v1-migrated'").get() as { value?: unknown } | undefined;
    if (!existsSync(legacyPath)) {
      if (marker?.value !== "1") this.#db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('legacy-v1-migrated', '1')").run();
      return;
    }
    assertPrivateFile(legacyPath);
    if (marker?.value === "1") {
      if (existsSync(migratedPath)) throw new Error("Both live and migrated legacy session-job files exist");
      renameSync(legacyPath, migratedPath);
      return;
    }
    const legacy = await this.#options.loadLegacy(legacyPath);
    if (legacy.length > this.#options.maxRecords) throw new Error("Legacy session-jobs state exceeds the record limit");
    if ((this.#db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count !== 0) {
      throw new Error("Refusing ambiguous session-jobs migration into a non-empty database");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.#db.prepare("INSERT INTO jobs(id, created_at, updated_at, active, payload_json) VALUES (?, ?, ?, ?, ?)");
      for (const record of legacy) {
        const result = insert.run(record.id, record.createdAt, record.updatedAt, this.#options.isActive(record.status) ? 1 : 0, JSON.stringify(record));
        if (Number(result.changes) !== 1) throw new Error(`Legacy session-job insertion affected ${String(result.changes)} rows for ${record.id}`);
      }
      const marker = this.#db.prepare("INSERT INTO metadata(key, value) VALUES ('legacy-v1-migrated', '1')").run();
      if (Number(marker.changes) !== 1) throw new Error("Legacy session-jobs migration marker was not persisted exactly once");
      this.#db.exec("COMMIT");
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Legacy session-jobs migration and rollback both failed");
      }
      throw error;
    }
    if (existsSync(migratedPath)) throw new Error("Legacy session-jobs migration target already exists");
    renameSync(legacyPath, migratedPath);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session-jobs database is closed");
  }

  #assertSidecarPermissions(): void {
    chmodSync(this.#databasePath, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const path = `${this.#databasePath}${suffix}`;
      if (!existsSync(path)) continue;
      chmodSync(path, 0o600);
      assertPrivateFile(path);
    }
  }

  #assertDatabaseBounds(): void {
    const size = lstatSync(this.#databasePath).size;
    if (size > MAX_DATABASE_BYTES) {
      throw new Error(`Session-jobs database exceeds the ${MAX_DATABASE_BYTES}-byte safety limit`);
    }
  }
}
