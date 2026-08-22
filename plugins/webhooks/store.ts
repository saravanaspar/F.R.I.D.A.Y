import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { reportOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WEBHOOKS_DATABASE_FILE_NAME = "webhooks.sqlite";
const DATABASE_SCHEMA_VERSION = 1;

export interface WebhooksDatabaseOptions {
  stateDir: string;
}

export interface SeenNonce {
  routeId: string;
  nonce: string;
  eventId: string;
  seenAt: string;
  expiresAtMs: number;
}

function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Webhooks database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_nonces (
      route_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      event_id TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY(route_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS webhook_nonces_expiry_idx ON webhook_nonces(expires_at_ms);

    CREATE TABLE IF NOT EXISTS webhook_rate_limits (
      route_id TEXT NOT NULL,
      bucket_start_ms INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      PRIMARY KEY(route_id, bucket_start_ms)
    );
    CREATE INDEX IF NOT EXISTS webhook_rate_limits_bucket_idx ON webhook_rate_limits(bucket_start_ms);
  `);
  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
}

export function getWebhooksStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "webhooks");
}

export function getWebhooksDatabasePath(stateDir: string): string {
  return join(stateDir, WEBHOOKS_DATABASE_FILE_NAME);
}

export class WebhooksDatabase {
  readonly path: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(options: WebhooksDatabaseOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    this.path = getWebhooksDatabasePath(options.stateDir);
    const existed = existsSync(this.path);
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      configureDatabase(this.#db);
    } catch (error) {
      try {
        this.#db.close();
      } catch (closeError) {
        reportOperationalError({ component: "webhooks", operation: "close database after initialization failure", error: closeError });
      }
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

  getNonce(routeId: string, nonce: string, nowMs: number): SeenNonce | undefined {
    this.#assertOpen();
    this.#db.prepare("DELETE FROM webhook_nonces WHERE expires_at_ms < ?").run(nowMs);
    const row = this.#db.prepare(`
      SELECT route_id, nonce, event_id, seen_at, expires_at_ms
      FROM webhook_nonces WHERE route_id = ? AND nonce = ?
    `).get(routeId, nonce) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expiresAtMs = row.expires_at_ms;
    if (typeof row.route_id !== "string" || typeof row.nonce !== "string" || typeof row.event_id !== "string" ||
        typeof row.seen_at !== "string" || typeof expiresAtMs !== "number" || !Number.isInteger(expiresAtMs)) {
      throw new Error("Webhooks database nonce row is invalid");
    }
    return { routeId: row.route_id, nonce: row.nonce, eventId: row.event_id, seenAt: row.seen_at, expiresAtMs };
  }

  recordNonce(input: SeenNonce): { inserted: boolean; existingEventId?: string | undefined } {
    this.#assertOpen();
    return this.#transaction(() => {
      const existing = this.#db.prepare("SELECT event_id FROM webhook_nonces WHERE route_id = ? AND nonce = ?")
        .get(input.routeId, input.nonce) as Record<string, unknown> | undefined;
      if (existing) {
        if (typeof existing.event_id !== "string") throw new Error("Webhooks database nonce event_id is invalid");
        return { inserted: false, existingEventId: existing.event_id };
      }
      this.#db.prepare(`
        INSERT INTO webhook_nonces(route_id, nonce, event_id, seen_at, expires_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.routeId, input.nonce, input.eventId, input.seenAt, input.expiresAtMs);
      return { inserted: true };
    });
  }

  claimRateLimit(routeId: string, nowMs: number, windowMs: number, maxRequests: number): boolean {
    this.#assertOpen();
    const bucketStart = Math.floor(nowMs / windowMs) * windowMs;
    return this.#transaction(() => {
      this.#db.prepare("DELETE FROM webhook_rate_limits WHERE bucket_start_ms < ?").run(bucketStart - windowMs * 2);
      const row = this.#db.prepare(`
        SELECT request_count FROM webhook_rate_limits WHERE route_id = ? AND bucket_start_ms = ?
      `).get(routeId, bucketStart) as Record<string, unknown> | undefined;
      if (!row) {
        this.#db.prepare(`
          INSERT INTO webhook_rate_limits(route_id, bucket_start_ms, request_count) VALUES (?, ?, 1)
        `).run(routeId, bucketStart);
        return true;
      }
      const count = row.request_count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error("Webhooks database rate-limit count is invalid");
      }
      if (count >= maxRequests) return false;
      this.#db.prepare(`
        UPDATE webhook_rate_limits SET request_count = request_count + 1
        WHERE route_id = ? AND bucket_start_ms = ?
      `).run(routeId, bucketStart);
      return true;
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Webhooks database is closed");
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
        throw new AggregateError([error, rollbackError], "Webhook transaction failed and rollback also failed");
      }
      throw error;
    }
  }
}
