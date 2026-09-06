import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { reportOperationalError } from "@friday/operational-errors";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "./embedding.js";
import { loadLegacyMemoryState } from "./legacy.js";
import {
  MEMORY_ENTRY_KINDS,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryRefinementEvent,
  type MemoryRelation,
  type MemoryRelationQuery,
  type MemoryScope,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryState,
} from "./types.js";

export const MEMORY_DATABASE_FILE_NAME = "memory.sqlite";
export const LEGACY_MEMORY_STATE_FILE_NAME = "memory_state.json";
const DATABASE_SCHEMA_VERSION = 3;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 100;


export interface MemoryEmbeddingRecord {
  providerId: string;
  dimensions: number;
  vector: Float32Array;
  entryVersion: number;
  updatedAt: string;
}

export interface MemorySemanticResult {
  entry: MemoryEntry;
  semanticScore: number;
}

interface MemoryDatabaseOptions {
  stateDir?: string;
  scope: MemoryScope;
  inMemory?: boolean;
  migrateLegacy?: boolean;
}

function emptyState(): MemoryState {
  return {
    schema: 1,
    entries: {
      prompt: {},
      memory: {},
      skill: {},
      subagent: {},
    },
    refinements: [],
    relations: [],
  };
}

function setOwnStateEntry(state: MemoryState, entry: MemoryEntry): void {
  Object.defineProperty(state.entries[entry.kind], entry.id, {
    value: entry,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function assertKind(kind: string): asserts kind is MemoryEntryKind {
  if (!(MEMORY_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown memory entry kind ${JSON.stringify(kind)}`);
  }
}

function parseObjectJson(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`memory database ${field} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`memory database ${field} contains invalid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`memory database ${field} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringArrayJson(value: unknown, field: string): string[] {
  if (typeof value !== "string") throw new Error(`memory database ${field} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`memory database ${field} contains invalid JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`memory database ${field} must contain a JSON string array`);
  }
  return [...parsed];
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`memory database column ${key} is invalid`);
  return value;
}

function rowPositiveInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`memory database column ${key} is invalid`);
  }
  return value;
}

function rowFiniteNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`memory database column ${key} is invalid`);
  }
  return value;
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  const kind = rowString(row, "kind");
  assertKind(kind);
  const scope = rowString(row, "scope");
  if (scope !== "local" && scope !== "global") {
    throw new Error(`memory database column scope is invalid`);
  }

  return {
    id: rowString(row, "id"),
    kind,
    title: rowString(row, "title"),
    content: rowString(row, "content"),
    path: rowString(row, "path"),
    scope,
    reference: parseObjectJson(row.reference_json, "reference_json"),
    arguments: parseObjectJson(row.arguments_json, "arguments_json"),
    metadata: parseObjectJson(row.metadata_json, "metadata_json"),
    source: rowString(row, "source"),
    created_at: rowString(row, "created_at"),
    updated_at: rowString(row, "updated_at"),
    version: rowPositiveInteger(row, "version"),
  };
}

function rowToRefinement(row: Record<string, unknown>): MemoryRefinementEvent {
  return {
    id: rowString(row, "id"),
    trigger: rowString(row, "trigger"),
    changes: parseStringArrayJson(row.changes_json, "changes_json"),
    evidence: rowString(row, "evidence"),
    outcome: rowString(row, "outcome"),
    created_at: rowString(row, "created_at"),
  };
}

function rowToRelation(row: Record<string, unknown>): MemoryRelation {
  const scope = rowString(row, "scope");
  if (scope !== "local" && scope !== "global") throw new Error("memory database relation scope is invalid");
  return {
    id: rowString(row, "id"),
    scope,
    subject: rowString(row, "subject"),
    predicate: rowString(row, "predicate"),
    object: rowString(row, "object"),
    context: parseObjectJson(row.context_json, "relation context_json"),
    source: rowString(row, "source"),
    confidence: rowFiniteNumber(row, "confidence"),
    occurrences: rowPositiveInteger(row, "occurrences"),
    first_observed_at: rowString(row, "first_observed_at"),
    last_observed_at: rowString(row, "last_observed_at"),
    updated_at: rowString(row, "updated_at"),
  };
}

function serializeVector(vector: Float32Array): Buffer {
  if (vector.length < 1 || vector.length > 4096) {
    throw new Error("memory embedding dimensions must be between 1 and 4096");
  }
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value)) throw new Error("memory embedding contains a non-finite value");
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer;
}

function parseVector(value: unknown, dimensions: number): Float32Array {
  if (!(value instanceof Uint8Array)) throw new Error("memory embedding vector is not binary data");
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    throw new Error("memory embedding dimensions are invalid");
  }
  if (value.byteLength !== dimensions * 4) {
    throw new Error("memory embedding vector length does not match its dimensions");
  }
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const component = buffer.readFloatLE(index * 4);
    if (!Number.isFinite(component)) throw new Error("memory embedding contains a non-finite value");
    vector[index] = component;
  }
  return vector;
}

function initializeSchema(db: DatabaseSync): void {
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = Number(versionRow?.user_version ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("memory database has an invalid schema version");
  }
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `memory database schema ${version} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      rowid INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('prompt', 'memory', 'skill', 'subagent')),
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('local', 'global')),
      reference_json TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      UNIQUE (kind, id)
    );

    CREATE INDEX IF NOT EXISTS memory_entries_scope_kind_idx
      ON memory_entries(scope, kind);
    CREATE INDEX IF NOT EXISTS memory_entries_path_idx
      ON memory_entries(path);
    CREATE INDEX IF NOT EXISTS memory_entries_updated_idx
      ON memory_entries(updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_refinements (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      trigger TEXT NOT NULL,
      changes_json TEXT NOT NULL,
      evidence TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      entry_rowid INTEGER NOT NULL REFERENCES memory_entries(rowid) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions >= 1 AND dimensions <= 4096),
      vector BLOB NOT NULL,
      entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entry_rowid, provider_id)
    );

    CREATE INDEX IF NOT EXISTS memory_embeddings_provider_idx
      ON memory_embeddings(provider_id);

    CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('local', 'global')),
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      context_json TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      occurrences INTEGER NOT NULL CHECK (occurrences >= 1),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_relations_scope_subject_idx
      ON memory_relations(scope, subject);
    CREATE INDEX IF NOT EXISTS memory_relations_predicate_idx
      ON memory_relations(predicate);
    CREATE INDEX IF NOT EXISTS memory_relations_rank_idx
      ON memory_relations(occurrences DESC, last_observed_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
      title,
      content,
      path,
      source,
      content='memory_entries',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(rowid, title, content, path, source)
      VALUES (new.rowid, new.title, new.content, new.path, new.source);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content, path, source)
      VALUES ('delete', old.rowid, old.title, old.content, old.path, old.source);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_entries_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content, path, source)
      VALUES ('delete', old.rowid, old.title, old.content, old.path, old.source);
      INSERT INTO memory_entries_fts(rowid, title, content, path, source)
      VALUES (new.rowid, new.title, new.content, new.path, new.source);
    END;
  `);

  if (version < DATABASE_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

function configureDatabase(db: DatabaseSync, diskBacked: boolean): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  if (diskBacked) db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function searchTerms(query: string): string[] {
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms)].slice(0, 24);
}

function toFtsQuery(query: string): string | undefined {
  const terms = searchTerms(query);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function normalizedSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`memory search limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  return limit;
}

const SEMANTIC_CANDIDATE_MULTIPLIER = 32;
const SEMANTIC_CANDIDATE_MIN = 512;
const SEMANTIC_CANDIDATE_MAX = 4096;

export class MemoryDatabase {
  readonly path: string | undefined;
  readonly scope: MemoryScope;
  #db: DatabaseSync;
  #closed = false;

  constructor(options: MemoryDatabaseOptions) {
    this.scope = options.scope;
    const inMemory = options.inMemory === true;
    if (!inMemory && !options.stateDir) {
      throw new Error("file-backed memory requires a stateDir");
    }

    let legacyState: MemoryState | undefined;
    let databaseExisted = false;
    if (!inMemory && options.stateDir) {
      mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
      this.path = join(options.stateDir, MEMORY_DATABASE_FILE_NAME);
      databaseExisted = existsSync(this.path);
      if (!databaseExisted && options.migrateLegacy !== false) {
        legacyState = loadLegacyMemoryState(
          join(options.stateDir, LEGACY_MEMORY_STATE_FILE_NAME),
          options.scope,
        );
      }
    }

    const databasePath = this.path ?? ":memory:";
    const previousMode = this.path && databaseExisted ? statSync(this.path).mode & 0o777 : undefined;
    this.#db = new DatabaseSync(databasePath);

    try {
      configureDatabase(this.#db, this.path !== undefined);
      this.#db.function("memory_relation_search_text", { deterministic: true }, (subject, predicate, object, context) =>
        `${subject} ${String(predicate).replaceAll("_", " ")} ${object} ${context}`.toLowerCase());
      if (this.path) chmodSync(this.path, previousMode ?? 0o600);
      if (legacyState) this.replaceState(legacyState);
    } catch (error) {
      try { this.#db.close(); } catch (closeError) {
        reportOperationalError({ component: "memory", operation: "close database after initialization failure", error: closeError });
      }
      this.#closed = true;
      if (this.path && !databaseExisted) {
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

  snapshot(): MemoryState {
    this.#assertOpen();
    const state = emptyState();
    const entryRows = this.#db
      .prepare(`
        SELECT kind, id, title, content, path, scope,
               reference_json, arguments_json, metadata_json,
               source, created_at, updated_at, version
        FROM memory_entries
        ORDER BY rowid
      `)
      .all() as Record<string, unknown>[];
    for (const row of entryRows) {
      const entry = rowToEntry(row);
      setOwnStateEntry(state, entry);
    }

    const refinementRows = this.#db
      .prepare(`
        SELECT id, trigger, changes_json, evidence, outcome, created_at
        FROM memory_refinements
        ORDER BY sequence
      `)
      .all() as Record<string, unknown>[];
    state.refinements = refinementRows.map(rowToRefinement);
    const relationRows = this.#db
      .prepare(`
        SELECT id, scope, subject, predicate, object, context_json, source,
               confidence, occurrences, first_observed_at, last_observed_at, updated_at
        FROM memory_relations
        ORDER BY first_observed_at, id
      `)
      .all() as Record<string, unknown>[];
    state.relations = relationRows.map(rowToRelation);
    return state;
  }

  replaceState(state: MemoryState): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#db.exec("DELETE FROM memory_entries; DELETE FROM memory_refinements; DELETE FROM memory_relations;");
      for (const kind of MEMORY_ENTRY_KINDS) {
        for (const entry of Object.values(state.entries[kind])) this.insertEntry(entry);
      }
      for (const event of state.refinements) this.insertRefinement(event);
      for (const relation of state.relations ?? []) this.insertRelation(relation);
    });
  }

  getEntry(kind: MemoryEntryKind, id: string): MemoryEntry | undefined {
    this.#assertOpen();
    assertKind(kind);
    const row = this.#db
      .prepare(`
        SELECT kind, id, title, content, path, scope,
               reference_json, arguments_json, metadata_json,
               source, created_at, updated_at, version
        FROM memory_entries
        WHERE kind = ? AND id = ?
      `)
      .get(kind, id) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  listEntries(kind?: MemoryEntryKind): MemoryEntry[] {
    this.#assertOpen();
    if (kind) assertKind(kind);
    const rows = (kind
      ? this.#db
          .prepare(`
            SELECT kind, id, title, content, path, scope,
                   reference_json, arguments_json, metadata_json,
                   source, created_at, updated_at, version
            FROM memory_entries
            WHERE kind = ?
          `)
          .all(kind)
      : this.#db
          .prepare(`
            SELECT kind, id, title, content, path, scope,
                   reference_json, arguments_json, metadata_json,
                   source, created_at, updated_at, version
            FROM memory_entries
          `)
          .all()) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  listEntriesNeedingEmbedding(providerId: string, dimensions: number): MemoryEntry[] {
    this.#assertOpen();
    if (!providerId.trim()) throw new Error("memory embedding provider id is required");
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
      throw new Error("memory embedding dimensions must be between 1 and 4096");
    }
    const rows = this.#db
      .prepare(`
        SELECT e.kind, e.id, e.title, e.content, e.path, e.scope,
               e.reference_json, e.arguments_json, e.metadata_json,
               e.source, e.created_at, e.updated_at, e.version
        FROM memory_entries AS e
        LEFT JOIN memory_embeddings AS m
          ON m.entry_rowid = e.rowid AND m.provider_id = ?
        WHERE m.entry_rowid IS NULL OR m.entry_version <> e.version OR m.dimensions <> ?
        ORDER BY e.rowid
      `)
      .all(providerId, dimensions) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  upsertEmbedding(kind: MemoryEntryKind, id: string, embedding: MemoryEmbeddingRecord): void {
    this.#assertOpen();
    assertKind(kind);
    if (!embedding.providerId.trim()) throw new Error("memory embedding provider id is required");
    if (embedding.vector.length !== embedding.dimensions) {
      throw new Error("memory embedding vector length does not match its dimensions");
    }
    const row = this.#db
      .prepare("SELECT rowid FROM memory_entries WHERE kind = ? AND id = ?")
      .get(kind, id) as Record<string, unknown> | undefined;
    const rowid = row?.rowid;
    if (typeof rowid !== "number" || !Number.isInteger(rowid)) {
      throw new Error(`${kind} entry ${JSON.stringify(id)} does not exist`);
    }
    this.#db
      .prepare(`
        INSERT INTO memory_embeddings (
          entry_rowid, provider_id, dimensions, vector, entry_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_rowid, provider_id) DO UPDATE SET
          dimensions = excluded.dimensions,
          vector = excluded.vector,
          entry_version = excluded.entry_version,
          updated_at = excluded.updated_at
      `)
      .run(
        rowid,
        embedding.providerId,
        embedding.dimensions,
        serializeVector(embedding.vector),
        embedding.entryVersion,
        embedding.updatedAt,
      );
  }

  insertEntryWithEmbedding(entry: MemoryEntry, embedding: MemoryEmbeddingRecord): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.insertEntry(entry);
      this.upsertEmbedding(entry.kind, entry.id, embedding);
    });
  }

  updateEntryWithEmbedding(
    entry: MemoryEntry,
    expectedVersion: number,
    embedding: MemoryEmbeddingRecord,
  ): boolean {
    this.#assertOpen();
    return this.#transaction(() => {
      const updated = this.updateEntry(entry, expectedVersion);
      if (updated) this.upsertEmbedding(entry.kind, entry.id, embedding);
      return updated;
    });
  }

  insertEntry(entry: MemoryEntry): void {
    this.#assertOpen();
    assertKind(entry.kind);
    this.#db
      .prepare(`
        INSERT INTO memory_entries (
          kind, id, title, content, path, scope,
          reference_json, arguments_json, metadata_json,
          source, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.kind,
        entry.id,
        entry.title,
        entry.content,
        entry.path,
        entry.scope,
        JSON.stringify(entry.reference),
        JSON.stringify(entry.arguments),
        JSON.stringify(entry.metadata),
        entry.source,
        entry.created_at,
        entry.updated_at,
        entry.version,
      );
  }

  updateEntry(entry: MemoryEntry, expectedVersion: number): boolean {
    this.#assertOpen();
    assertKind(entry.kind);
    const result = this.#db
      .prepare(`
        UPDATE memory_entries
        SET title = ?, content = ?, path = ?, scope = ?,
            reference_json = ?, arguments_json = ?, metadata_json = ?,
            source = ?, updated_at = ?, version = ?
        WHERE kind = ? AND id = ? AND version = ?
      `)
      .run(
        entry.title,
        entry.content,
        entry.path,
        entry.scope,
        JSON.stringify(entry.reference),
        JSON.stringify(entry.arguments),
        JSON.stringify(entry.metadata),
        entry.source,
        entry.updated_at,
        entry.version,
        entry.kind,
        entry.id,
        expectedVersion,
      );
    return Number(result.changes) === 1;
  }

  deleteEntry(kind: MemoryEntryKind, id: string): boolean {
    this.#assertOpen();
    assertKind(kind);
    const result = this.#db.prepare("DELETE FROM memory_entries WHERE kind = ? AND id = ?").run(kind, id);
    return Number(result.changes) === 1;
  }

  insertRefinement(event: MemoryRefinementEvent): void {
    this.#assertOpen();
    this.#db
      .prepare(`
        INSERT INTO memory_refinements (id, trigger, changes_json, evidence, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.trigger,
        JSON.stringify(event.changes),
        event.evidence,
        event.outcome,
        event.created_at,
      );
  }

  recordRefinement(
    trigger: string,
    changes: readonly string[],
    options: { id?: string; evidence?: string; outcome?: string; createdAt: string },
  ): MemoryRefinementEvent {
    this.#assertOpen();
    return this.#transaction(() => {
      const sequenceRow = this.#db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM memory_refinements")
        .get() as Record<string, unknown> | undefined;
      const nextSequence = Number(sequenceRow?.next_sequence ?? 1);
      const event: MemoryRefinementEvent = {
        id: options.id ?? `refine_${String(nextSequence).padStart(4, "0")}`,
        trigger,
        changes: [...changes],
        evidence: options.evidence ?? "",
        outcome: options.outcome ?? "",
        created_at: options.createdAt,
      };
      this.insertRefinement(event);
      return event;
    });
  }

  insertRelation(relation: MemoryRelation): void {
    this.#assertOpen();
    this.#db.prepare(`
      INSERT INTO memory_relations(
        id, scope, subject, predicate, object, context_json, source,
        confidence, occurrences, first_observed_at, last_observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      relation.id,
      relation.scope,
      relation.subject,
      relation.predicate,
      relation.object,
      JSON.stringify(relation.context),
      relation.source,
      relation.confidence,
      relation.occurrences,
      relation.first_observed_at,
      relation.last_observed_at,
      relation.updated_at,
    );
  }

  observeRelation(relation: MemoryRelation): MemoryRelation {
    this.#assertOpen();
    return this.#transaction(() => {
      const existingRow = this.#db.prepare(`
        SELECT id, scope, subject, predicate, object, context_json, source,
               confidence, occurrences, first_observed_at, last_observed_at, updated_at
        FROM memory_relations WHERE id = ?
      `).get(relation.id) as Record<string, unknown> | undefined;
      if (!existingRow) {
        this.insertRelation(relation);
        return structuredClone(relation);
      }
      const existing = rowToRelation(existingRow);
      if (
        existing.scope !== relation.scope
        || existing.subject !== relation.subject
        || existing.predicate !== relation.predicate
        || existing.object !== relation.object
        || JSON.stringify(existing.context) !== JSON.stringify(relation.context)
      ) {
        throw new Error(`memory relation identity collision: ${relation.id}`);
      }
      const next: MemoryRelation = {
        ...existing,
        source: relation.source,
        confidence: Math.max(existing.confidence, relation.confidence),
        occurrences: existing.occurrences + 1,
        last_observed_at: existing.last_observed_at.localeCompare(relation.last_observed_at) >= 0
          ? existing.last_observed_at
          : relation.last_observed_at,
        updated_at: relation.updated_at,
      };
      this.#db.prepare(`
        UPDATE memory_relations
        SET source = ?, confidence = ?, occurrences = ?, last_observed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(next.source, next.confidence, next.occurrences, next.last_observed_at, next.updated_at, next.id);
      return next;
    });
  }

  listRelations(query: MemoryRelationQuery = {}, terms: readonly string[] = []): MemoryRelation[] {
    this.#assertOpen();
    const clauses = ["scope = ?"];
    const parameters: Array<string | number> = [this.scope];
    if (query.subject?.trim()) { clauses.push("subject = ?"); parameters.push(query.subject.trim()); }
    if (query.predicate?.trim()) { clauses.push("predicate = ?"); parameters.push(query.predicate.trim()); }
    if (query.object?.trim()) { clauses.push("object = ?"); parameters.push(query.object.trim()); }
    if (query.minimumOccurrences !== undefined) {
      clauses.push("occurrences >= ?");
      parameters.push(query.minimumOccurrences);
    }
    if (terms.length > 0) {
      clauses.push(`(${terms.map(() => "instr(memory_relation_search_text(subject, predicate, object, context_json), ?) > 0").join(" OR ")})`);
      parameters.push(...terms);
    }
    parameters.push(Math.min(500, Math.max(query.limit ?? 100, 100)));
    const rows = this.#db.prepare(`
      SELECT id, scope, subject, predicate, object, context_json, source,
             confidence, occurrences, first_observed_at, last_observed_at, updated_at
      FROM memory_relations
      WHERE ${clauses.join(" AND ")}
      ORDER BY occurrences DESC, last_observed_at DESC, id ASC
      LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map(rowToRelation);
  }

  deleteRelation(id: string): boolean {
    this.#assertOpen();
    return Number(this.#db.prepare("DELETE FROM memory_relations WHERE id = ? AND scope = ?").run(id, this.scope).changes) === 1;
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
    this.#assertOpen();
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = normalizedSearchLimit(options.limit);

    const where = ["memory_entries_fts MATCH ?"];
    const params: Array<string | number> = [ftsQuery];

    if (options.scope !== undefined) {
      if (options.scope !== "local" && options.scope !== "global") {
        throw new Error(`unknown memory scope ${JSON.stringify(options.scope)}`);
      }
      where.push("e.scope = ?");
      params.push(options.scope);
    }

    if (options.kinds !== undefined) {
      if (options.kinds.length === 0) return [];
      for (const kind of options.kinds) assertKind(kind);
      where.push(`e.kind IN (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }

    if (options.pathPrefix !== undefined) {
      where.push("e.path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikePrefix(options.pathPrefix)}%`);
    }

    params.push(limit);
    const rows = this.#db
      .prepare(`
        SELECT e.kind, e.id, e.title, e.content, e.path, e.scope,
               e.reference_json, e.arguments_json, e.metadata_json,
               e.source, e.created_at, e.updated_at, e.version,
               bm25(memory_entries_fts, 5.0, 2.0, 1.0, 0.5) AS lexical_rank
        FROM memory_entries_fts
        JOIN memory_entries AS e ON e.rowid = memory_entries_fts.rowid
        WHERE ${where.join(" AND ")}
        ORDER BY lexical_rank ASC, e.updated_at DESC, e.kind ASC, e.id ASC
        LIMIT ?
      `)
      .all(...params) as Record<string, unknown>[];

    return rows.map((row, index) => ({
      entry: rowToEntry(row),
      score: 1 / (index + 1),
      lexicalRank: typeof row.lexical_rank === "number" ? row.lexical_rank : 0,
      matchedBy: "fts" as const,
    }));
  }

  searchSemantic(
    queryVector: Float32Array,
    providerId: string,
    options: MemorySearchOptions = {},
  ): MemorySemanticResult[] {
    this.#assertOpen();
    if (!providerId.trim()) throw new Error("memory embedding provider id is required");
    if (queryVector.length < 1 || queryVector.length > 4096) {
      throw new Error("memory embedding dimensions must be between 1 and 4096");
    }
    const limit = normalizedSearchLimit(options.limit);
    const candidateLimit = Math.min(
      SEMANTIC_CANDIDATE_MAX,
      Math.max(SEMANTIC_CANDIDATE_MIN, limit * SEMANTIC_CANDIDATE_MULTIPLIER),
    );
    const where = ["m.provider_id = ?", "m.dimensions = ?"];
    const params: Array<string | number> = [providerId, queryVector.length];

    if (options.scope !== undefined) {
      if (options.scope !== "local" && options.scope !== "global") {
        throw new Error(`unknown memory scope ${JSON.stringify(options.scope)}`);
      }
      where.push("e.scope = ?");
      params.push(options.scope);
    }

    if (options.kinds !== undefined) {
      if (options.kinds.length === 0) return [];
      for (const kind of options.kinds) assertKind(kind);
      where.push(`e.kind IN (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }

    if (options.pathPrefix !== undefined) {
      where.push("e.path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikePrefix(options.pathPrefix)}%`);
    }

    const rows = this.#db
      .prepare(`
        SELECT e.kind, e.id, e.title, e.content, e.path, e.scope,
               e.reference_json, e.arguments_json, e.metadata_json,
               e.source, e.created_at, e.updated_at, e.version,
               m.dimensions, m.vector
        FROM memory_embeddings AS m
        JOIN memory_entries AS e ON e.rowid = m.entry_rowid
        WHERE ${where.join(" AND ")}
        ORDER BY e.updated_at DESC, m.entry_rowid DESC
        LIMIT ?
      `)
      .all(...params, candidateLimit) as Record<string, unknown>[];

    return rows
      .map((row) => {
        const dimensions = row.dimensions;
        if (typeof dimensions !== "number" || !Number.isInteger(dimensions)) {
          throw new Error("memory embedding dimensions are invalid");
        }
        return {
          entry: rowToEntry(row),
          semanticScore: cosineSimilarity(queryVector, parseVector(row.vector, dimensions)),
        };
      })
      .sort((left, right) =>
        right.semanticScore - left.semanticScore ||
        right.entry.updated_at.localeCompare(left.entry.updated_at) ||
        left.entry.kind.localeCompare(right.entry.kind) ||
        left.entry.id.localeCompare(right.entry.id),
      )
      .slice(0, limit);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("memory database is closed");
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch (rollbackError) {
        reportOperationalError({ component: "memory", operation: "rollback failed database transaction", error: rollbackError });
        throw new AggregateError([error, rollbackError], "Memory transaction failed and rollback also failed");
      }
      throw error;
    }
  }
}
