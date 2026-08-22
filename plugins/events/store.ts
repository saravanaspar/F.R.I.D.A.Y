import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { reportOperationalError } from "@friday/operational-errors";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EventConsumer,
  EventConsumerLease,
  EventDeliveryRecord,
  EventDeliveryStatus,
  EventJsonValue,
  EventMetadata,
  EventRecord,
  EventReplayOptions,
  EventRetryPolicy,
} from "./contract.js";

export const EVENTS_DATABASE_FILE_NAME = "events.sqlite";
const DATABASE_SCHEMA_VERSION = 1;

export interface EventsDatabaseOptions {
  stateDir: string;
}

export interface PersistedConsumerInput {
  id: string;
  types: readonly string[];
  retry: EventRetryPolicy;
  startAt: "beginning" | "latest";
  nowIso: string;
}

export interface ClaimedEventDelivery {
  consumer: EventConsumer;
  event: EventRecord;
  delivery: EventDeliveryRecord;
  leaseId: string;
}

export interface CompleteDeliveryUpdate {
  consumerId: string;
  leaseId: string;
  deliveryId: string;
  eventSequence: number;
  completedAt: string;
  status: "success" | "error" | "cancelled" | "dead-letter";
  error?: string | undefined;
  retryNotBefore?: string | undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isJsonValue(value: unknown): value is EventJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  const record = objectRecord(value);
  return record !== undefined && Object.values(record).every((entry) => isJsonValue(entry));
}

function parseJsonValue(value: unknown, label: string): EventJsonValue {
  if (typeof value !== "string") throw new Error(`events database ${label} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`events database ${label} contains invalid JSON`, { cause: error });
  }
  if (!isJsonValue(parsed)) throw new Error(`events database ${label} is not a JSON value`);
  return parsed;
}

function parseMetadata(value: unknown): EventMetadata {
  const parsed = parseJsonValue(value, "metadata_json");
  const record = objectRecord(parsed);
  if (!record) throw new Error("events database metadata_json must contain a JSON object");
  return record as EventMetadata;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`events database column ${key} is invalid`);
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`events database column ${key} is invalid`);
  return value;
}

function rowInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`events database column ${key} is invalid`);
  return value;
}

function parseTypes(value: unknown): string[] {
  const parsed = parseJsonValue(value, "types_json");
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("events database types_json is invalid");
  }
  return [...parsed];
}

function parseRetry(value: unknown): EventRetryPolicy {
  const parsed = parseJsonValue(value, "retry_json");
  const record = objectRecord(parsed);
  if (!record) throw new Error("events database retry_json is invalid");
  const { maxAttempts, initialDelayMs, multiplier, maxDelayMs } = record;
  if (
    typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
    typeof initialDelayMs !== "number" || !Number.isInteger(initialDelayMs) || initialDelayMs < 1 ||
    typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 1 ||
    typeof maxDelayMs !== "number" || !Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs
  ) {
    throw new Error("events database retry_json is invalid");
  }
  return { maxAttempts, initialDelayMs, multiplier, maxDelayMs };
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  const sequence = rowInteger(row, "sequence");
  if (sequence < 1) throw new Error("events database sequence is invalid");
  return {
    sequence,
    id: rowString(row, "id"),
    type: rowString(row, "type"),
    source: rowString(row, "source"),
    ...(rowOptionalString(row, "subject") ? { subject: rowOptionalString(row, "subject")! } : {}),
    occurredAt: rowString(row, "occurred_at"),
    publishedAt: rowString(row, "published_at"),
    data: parseJsonValue(rowString(row, "data_json"), "data_json"),
    metadata: parseMetadata(rowString(row, "metadata_json")),
    ...(rowOptionalString(row, "dedupe_key") ? { dedupeKey: rowOptionalString(row, "dedupe_key")! } : {}),
    ...(rowOptionalString(row, "correlation_id") ? { correlationId: rowOptionalString(row, "correlation_id")! } : {}),
    ...(rowOptionalString(row, "causation_id") ? { causationId: rowOptionalString(row, "causation_id")! } : {}),
  };
}

function rowToLease(row: Record<string, unknown>): EventConsumerLease | undefined {
  const id = rowOptionalString(row, "lease_id");
  const eventSequenceValue = row.lease_event_sequence;
  const claimedAt = rowOptionalString(row, "lease_claimed_at");
  const expiresAt = rowOptionalString(row, "lease_expires_at");
  if (!id && (eventSequenceValue === null || eventSequenceValue === undefined) && !claimedAt && !expiresAt) return undefined;
  if (!id || typeof eventSequenceValue !== "number" || !Number.isInteger(eventSequenceValue) || !claimedAt || !expiresAt) {
    throw new Error("events database consumer lease columns are inconsistent");
  }
  return { id, eventSequence: eventSequenceValue, claimedAt, expiresAt };
}

function rowToConsumer(row: Record<string, unknown>): EventConsumer {
  const cursorSequence = rowInteger(row, "cursor_sequence");
  if (cursorSequence < 0) throw new Error("events database cursor_sequence is invalid");
  const retryNotBefore = rowOptionalString(row, "retry_not_before");
  const lease = rowToLease(row);
  return {
    id: rowString(row, "id"),
    types: parseTypes(rowString(row, "types_json")),
    cursorSequence,
    retry: parseRetry(rowString(row, "retry_json")),
    createdAt: rowString(row, "created_at"),
    updatedAt: rowString(row, "updated_at"),
    ...(retryNotBefore ? { retryNotBefore } : {}),
    ...(lease ? { lease } : {}),
  };
}

function parseDeliveryStatus(value: unknown): EventDeliveryStatus {
  if (value === "running" || value === "success" || value === "error" || value === "cancelled" || value === "abandoned" || value === "dead-letter") {
    return value;
  }
  throw new Error("events database delivery status is invalid");
}

function rowToDelivery(row: Record<string, unknown>): EventDeliveryRecord {
  const attempt = rowInteger(row, "attempt");
  if (attempt < 1) throw new Error("events database delivery attempt is invalid");
  const eventSequence = rowInteger(row, "event_sequence");
  if (eventSequence < 1) throw new Error("events database delivery event_sequence is invalid");
  const completedAt = rowOptionalString(row, "completed_at");
  const error = rowOptionalString(row, "error");
  return {
    deliveryId: rowString(row, "delivery_id"),
    consumerId: rowString(row, "consumer_id"),
    eventId: rowString(row, "event_id"),
    eventSequence,
    idempotencyKey: rowString(row, "idempotency_key"),
    attempt,
    startedAt: rowString(row, "started_at"),
    ...(completedAt ? { completedAt } : {}),
    status: parseDeliveryStatus(row.status),
    ...(error ? { error } : {}),
  };
}

function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Events database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      subject TEXT,
      occurred_at TEXT NOT NULL,
      published_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      dedupe_key TEXT,
      correlation_id TEXT,
      causation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS events_type_sequence_idx ON events(type, sequence);
    CREATE INDEX IF NOT EXISTS events_source_sequence_idx ON events(source, sequence);
    CREATE INDEX IF NOT EXISTS events_occurred_idx ON events(occurred_at, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS events_source_dedupe_idx
      ON events(source, dedupe_key) WHERE dedupe_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS event_consumers (
      id TEXT PRIMARY KEY,
      types_json TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL DEFAULT 0,
      retry_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retry_not_before TEXT,
      lease_id TEXT,
      lease_event_sequence INTEGER,
      lease_claimed_at TEXT,
      lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS event_consumers_retry_idx ON event_consumers(retry_not_before, lease_expires_at);

    CREATE TABLE IF NOT EXISTS event_deliveries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      consumer_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      lease_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      error TEXT,
      UNIQUE(consumer_id, event_id, attempt),
      FOREIGN KEY(consumer_id) REFERENCES event_consumers(id) ON DELETE RESTRICT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS event_deliveries_consumer_idx ON event_deliveries(consumer_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS event_deliveries_event_idx ON event_deliveries(event_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS event_deliveries_idempotency_idx ON event_deliveries(idempotency_key, sequence DESC);
  `);
  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function configureDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
}

export function getEventsStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.FRIDAY_STATE_DIR?.trim() || environment.FRIDAY_HOME?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "events");
}

export function getEventsDatabasePath(stateDir: string): string {
  return join(stateDir, EVENTS_DATABASE_FILE_NAME);
}

export class EventsDatabase {
  readonly path: string;
  #db: DatabaseSync;
  #closed = false;

  constructor(options: EventsDatabaseOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    this.path = getEventsDatabasePath(options.stateDir);
    const existed = existsSync(this.path);
    this.#db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      configureDatabase(this.#db);
    } catch (error) {
      try {
        this.#db.close();
      } catch (closeError) {
        reportOperationalError({ component: "events", operation: "close database after initialization failure", error: closeError });
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

  persistEvent(candidate: Omit<EventRecord, "sequence">): { event: EventRecord; duplicate: boolean } {
    this.#assertOpen();
    return this.#transaction(() => {
      const existingById = this.#getEventById(candidate.id);
      const existingByDedupe = candidate.dedupeKey
        ? this.#getEventByDedupe(candidate.source, candidate.dedupeKey)
        : undefined;
      if (existingById && existingByDedupe && existingById.id !== existingByDedupe.id) {
        throw new Error(`Event identity collides with an existing dedupe key: ${candidate.id}`);
      }
      const existing = existingById ?? existingByDedupe;
      if (existing) return { event: existing, duplicate: true };

      this.#db.prepare(`
        INSERT INTO events(
          id, type, source, subject, occurred_at, published_at, data_json, metadata_json,
          dedupe_key, correlation_id, causation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidate.id,
        candidate.type,
        candidate.source,
        candidate.subject ?? null,
        candidate.occurredAt,
        candidate.publishedAt,
        JSON.stringify(candidate.data),
        JSON.stringify(candidate.metadata),
        candidate.dedupeKey ?? null,
        candidate.correlationId ?? null,
        candidate.causationId ?? null,
      );
      return { event: this.#getEventById(candidate.id)!, duplicate: false };
    });
  }

  getEvent(id: string): EventRecord | undefined {
    this.#assertOpen();
    return this.#getEventById(id);
  }

  replay(options: EventReplayOptions & { types?: readonly string[] | undefined; source?: string | undefined; limit: number; order: "asc" | "desc" }): EventRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      args.push(options.afterSequence);
    }
    if (options.beforeSequence !== undefined) {
      clauses.push("sequence < ?");
      args.push(options.beforeSequence);
    }
    if (options.source !== undefined) {
      clauses.push("source = ?");
      args.push(options.source);
    }
    if (options.types && options.types.length > 0) {
      clauses.push(`type IN (${options.types.map(() => "?").join(", ")})`);
      args.push(...options.types);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT * FROM events ${where}
      ORDER BY sequence ${options.order === "asc" ? "ASC" : "DESC"}
      LIMIT ?
    `).all(...args, options.limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  ensureConsumer(input: PersistedConsumerInput): EventConsumer {
    this.#assertOpen();
    return this.#transaction(() => {
      const existingRow = this.#db.prepare("SELECT * FROM event_consumers WHERE id = ?").get(input.id) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = rowToConsumer(existingRow);
        if (JSON.stringify(existing.types) !== JSON.stringify(input.types)) {
          throw new Error(`Event consumer type filter is immutable once created: ${input.id}`);
        }
        this.#db.prepare(`
          UPDATE event_consumers SET retry_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(input.retry), input.nowIso, input.id);
        return this.getConsumer(input.id)!;
      }
      const cursorSequence = input.startAt === "latest" ? this.latestSequence() : 0;
      this.#db.prepare(`
        INSERT INTO event_consumers(id, types_json, cursor_sequence, retry_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, JSON.stringify(input.types), cursorSequence, JSON.stringify(input.retry), input.nowIso, input.nowIso);
      return this.getConsumer(input.id)!;
    });
  }

  getConsumer(id: string): EventConsumer | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT * FROM event_consumers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToConsumer(row) : undefined;
  }

  listConsumers(): EventConsumer[] {
    this.#assertOpen();
    const rows = this.#db.prepare("SELECT * FROM event_consumers ORDER BY id").all() as Record<string, unknown>[];
    return rows.map(rowToConsumer);
  }

  rewindConsumer(id: string, afterSequence: number, updatedAt: string): EventConsumer {
    this.#assertOpen();
    return this.#transaction(() => {
      const consumer = this.getConsumer(id);
      if (!consumer) throw new Error(`Unknown event consumer: ${id}`);
      if (consumer.lease) throw new Error(`Cannot rewind event consumer with an active lease: ${id}`);
      if (afterSequence > consumer.cursorSequence) {
        throw new Error(`Event consumer can only rewind to an earlier sequence: ${id}`);
      }
      this.#db.prepare(`
        UPDATE event_consumers
        SET cursor_sequence = ?, retry_not_before = NULL, updated_at = ?
        WHERE id = ?
      `).run(afterSequence, updatedAt, id);
      return this.getConsumer(id)!;
    });
  }

  claimDelivery(consumerId: string, nowIso: string, leaseMs: number, leaseId: string, deliveryId: string): ClaimedEventDelivery | undefined {
    this.#assertOpen();
    return this.#transaction(() => {
      const row = this.#db.prepare("SELECT * FROM event_consumers WHERE id = ?").get(consumerId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      let consumer = rowToConsumer(row);
      if (consumer.lease) {
        if (consumer.lease.expiresAt > nowIso) return undefined;
        this.#db.prepare(`
          UPDATE event_deliveries
          SET status = 'abandoned', completed_at = ?, error = COALESCE(error, 'delivery lease expired before completion')
          WHERE consumer_id = ? AND lease_id = ? AND status = 'running'
        `).run(nowIso, consumerId, consumer.lease.id);
        this.#db.prepare(`
          UPDATE event_consumers
          SET lease_id = NULL, lease_event_sequence = NULL, lease_claimed_at = NULL, lease_expires_at = NULL,
              retry_not_before = NULL, updated_at = ?
          WHERE id = ? AND lease_id = ?
        `).run(nowIso, consumerId, consumer.lease.id);
        consumer = this.getConsumer(consumerId)!;
      }
      if (consumer.retryNotBefore && consumer.retryNotBefore > nowIso) return undefined;

      const event = this.#nextEventForConsumer(consumer);
      if (!event) return undefined;
      const attemptRow = this.#db.prepare(`
        SELECT COALESCE(MAX(attempt), 0) AS max_attempt
        FROM event_deliveries WHERE consumer_id = ? AND event_id = ?
      `).get(consumerId, event.id) as Record<string, unknown>;
      const attempt = rowInteger(attemptRow, "max_attempt") + 1;
      const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
      const idempotencyKey = `events:${consumerId}:${event.id}`;
      this.#db.prepare(`
        UPDATE event_consumers
        SET lease_id = ?, lease_event_sequence = ?, lease_claimed_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(leaseId, event.sequence, nowIso, expiresAt, nowIso, consumerId);
      this.#db.prepare(`
        INSERT INTO event_deliveries(
          delivery_id, consumer_id, event_id, event_sequence, idempotency_key,
          attempt, lease_id, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
      `).run(deliveryId, consumerId, event.id, event.sequence, idempotencyKey, attempt, leaseId, nowIso);
      const claimedConsumer = this.getConsumer(consumerId)!;
      return {
        consumer: claimedConsumer,
        event,
        leaseId,
        delivery: {
          deliveryId,
          consumerId,
          eventId: event.id,
          eventSequence: event.sequence,
          idempotencyKey,
          attempt,
          startedAt: nowIso,
          status: "running",
        },
      };
    });
  }

  renewLease(consumerId: string, leaseId: string, nowIso: string, leaseMs: number): boolean {
    this.#assertOpen();
    const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
    const result = this.#db.prepare(`
      UPDATE event_consumers
      SET lease_claimed_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_id = ?
    `).run(nowIso, expiresAt, nowIso, consumerId, leaseId);
    return result.changes > 0;
  }

  completeDelivery(update: CompleteDeliveryUpdate): EventConsumer {
    this.#assertOpen();
    return this.#transaction(() => {
      const consumer = this.getConsumer(update.consumerId);
      if (!consumer) throw new Error(`Event consumer disappeared while delivering: ${update.consumerId}`);
      if (consumer.lease?.id !== update.leaseId || consumer.lease.eventSequence !== update.eventSequence) {
        throw new Error(`Event consumer lease changed while delivering: ${update.consumerId}`);
      }
      this.#db.prepare(`
        UPDATE event_deliveries
        SET completed_at = ?, status = ?, error = ?
        WHERE delivery_id = ? AND lease_id = ? AND status = 'running'
      `).run(update.completedAt, update.status, update.error ?? null, update.deliveryId, update.leaseId);
      const advance = update.status === "success" || update.status === "dead-letter";
      this.#db.prepare(`
        UPDATE event_consumers
        SET cursor_sequence = CASE WHEN ? = 1 THEN MAX(cursor_sequence, ?) ELSE cursor_sequence END,
            retry_not_before = ?,
            lease_id = NULL, lease_event_sequence = NULL, lease_claimed_at = NULL, lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND lease_id = ?
      `).run(
        advance ? 1 : 0,
        update.eventSequence,
        update.retryNotBefore ?? null,
        update.completedAt,
        update.consumerId,
        update.leaseId,
      );
      return this.getConsumer(update.consumerId)!;
    });
  }

  deliveryHistory(options: {
    consumerId?: string | undefined;
    eventId?: string | undefined;
    status?: EventDeliveryStatus | undefined;
    limit: number;
  }): EventDeliveryRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const args: string[] = [];
    if (options.consumerId) {
      clauses.push("consumer_id = ?");
      args.push(options.consumerId);
    }
    if (options.eventId) {
      clauses.push("event_id = ?");
      args.push(options.eventId);
    }
    if (options.status) {
      clauses.push("status = ?");
      args.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#db.prepare(`
      SELECT * FROM event_deliveries ${where} ORDER BY sequence DESC LIMIT ?
    `).all(...args, options.limit) as Record<string, unknown>[];
    return rows.map(rowToDelivery);
  }

  latestSequence(): number {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) AS latest FROM events").get() as Record<string, unknown>;
    return rowInteger(row, "latest");
  }

  #getEventById(id: string): EventRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  #getEventByDedupe(source: string, dedupeKey: string): EventRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM events WHERE source = ? AND dedupe_key = ?").get(source, dedupeKey) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  #nextEventForConsumer(consumer: EventConsumer): EventRecord | undefined {
    if (consumer.types.length === 0) {
      const row = this.#db.prepare(`
        SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT 1
      `).get(consumer.cursorSequence) as Record<string, unknown> | undefined;
      return row ? rowToEvent(row) : undefined;
    }
    const placeholders = consumer.types.map(() => "?").join(", ");
    const row = this.#db.prepare(`
      SELECT * FROM events
      WHERE sequence > ? AND type IN (${placeholders})
      ORDER BY sequence ASC LIMIT 1
    `).get(consumer.cursorSequence, ...consumer.types) as Record<string, unknown> | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("events database is closed");
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
        throw new AggregateError([error, rollbackError], "Events transaction failed and rollback also failed");
      }
      throw error;
    }
  }
}
