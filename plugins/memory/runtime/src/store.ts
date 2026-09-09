import { MemoryDatabase, type MemoryEmbeddingRecord } from "./database.js";
import {
  createLocalEmbeddingProvider,
  memoryEntryEmbeddingText,
  normalizeEmbedding,
  type MemoryEmbeddingProvider,
} from "./embedding.js";
import { memoryRelationIdentity } from "./relation.js";
import { assertMemoryTextHasNoSecrets, memoryFieldMayContainSecret } from "./security.js";
import { getMemoryStatePath } from "./state.js";
import {
  MEMORY_ENTRY_KINDS,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryEntryUpdate,
  type MemoryEntryWrite,
  type MemoryRefinementEvent,
  type MemoryRelation,
  type MemoryRelationQuery,
  type MemoryRelationResult,
  type MemoryRelationUpdate,
  type MemoryRelationWrite,
  type MemoryScope,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryState,
} from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function trimEdgeUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") start += 1;
  while (end > start && value[end - 1] === "_") end -= 1;
  return value.slice(start, end);
}

function slug(raw: string, fallback: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return trimEdgeUnderscores(normalized).slice(0, 80) || fallback;
}

function assertKind(kind: string): asserts kind is MemoryEntryKind {
  if (!(MEMORY_ENTRY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown memory entry kind ${JSON.stringify(kind)}`);
  }
}

function validateSkillReference(reference: Record<string, unknown> | undefined): void {
  if (!reference) throw new Error("skill entries require a Python reference");
  if (reference.type !== "python") throw new Error("skill reference.type must be 'python'");
  const importName = reference.import ?? reference.python_import;
  const callable = reference.callable ?? reference.call_pattern;
  if (typeof importName !== "string" || importName.length === 0) {
    throw new Error("skill reference requires a Python import");
  }
  if (typeof callable !== "string" || callable.length === 0) {
    throw new Error("skill reference requires a callable or call_pattern");
  }
}

export interface MemoryStoreOptions {
  stateDir?: string;
  scope?: MemoryScope;
  inMemory?: boolean;
  /** Set null to force lexical-only search. Defaults to the local subword provider. */
  embeddingProvider?: MemoryEmbeddingProvider | null;
}

const DEFAULT_EMBEDDING_PROVIDER = createLocalEmbeddingProvider();
const HYBRID_CANDIDATE_FLOOR = 24;
const MAX_SEARCH_LIMIT = 100;
const MIN_SEMANTIC_SCORE = 0.2;
const MAX_RELATION_TEXT = 512;
const MAX_RELATION_CONTEXT_JSON = 8_192;
function assertNoSecretStructuredValue(value: unknown, label: string, depth = 0): void {
  if (depth > 8) throw new Error(`${label} is too deeply nested`);
  if (typeof value === "string") {
    assertMemoryTextHasNoSecrets(value, label);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoSecretStructuredValue(value[index], `${label}[${index}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (memoryFieldMayContainSecret(key)) {
      throw new Error(`${label}.${key} may contain authentication material; secrets belong in Vault, not Memory`);
    }
    assertNoSecretStructuredValue(item, `${label}.${key}`, depth + 1);
  }
}

function assertSafeMemoryEntry(entry: MemoryEntry): void {
  if (entry.kind !== "memory") return;
  assertMemoryTextHasNoSecrets(entry.title, "memory title");
  assertMemoryTextHasNoSecrets(entry.content, "memory content");
  assertMemoryTextHasNoSecrets(entry.path, "memory path");
  assertNoSecretStructuredValue(entry.reference, "memory reference");
  assertNoSecretStructuredValue(entry.arguments, "memory arguments");
  assertNoSecretStructuredValue(entry.metadata, "memory metadata");
}

function relationText(value: string, label: string, maximum = MAX_RELATION_TEXT): string {
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "\ufffd").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  assertMemoryTextHasNoSecrets(normalized, label);
  return normalized;
}

function setOwnContextField(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function safeRelationContext(value: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> {
  if (!value) return {};
  if (depth > 5) throw new Error("memory relation context is too deeply nested");
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("memory relation context has too many fields");
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!key.trim() || key.length > 128) throw new Error("memory relation context contains an invalid field name");
    if (memoryFieldMayContainSecret(key)) throw new Error(`memory relation context field ${key} may contain a secret`);
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      setOwnContextField(
        output,
        key,
        typeof item === "string" ? relationText(item, `memory relation context.${key}`, 1_024) : item,
      );
    } else if (typeof item === "number" && Number.isFinite(item)) {
      setOwnContextField(output, key, item);
    } else if (Array.isArray(item)) {
      if (item.length > 32) throw new Error(`memory relation context.${key} has too many items`);
      setOwnContextField(output, key, item.map((entry, index) => {
        if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) return entry;
        if (typeof entry === "string") return relationText(entry, `memory relation context.${key}[${index}]`, 1_024);
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) return safeRelationContext(entry as Record<string, unknown>, depth + 1);
        throw new Error(`memory relation context.${key}[${index}] is not JSON-safe`);
      }));
    } else if (typeof item === "object" && item !== null) {
      setOwnContextField(output, key, safeRelationContext(item as Record<string, unknown>, depth + 1));
    } else {
      throw new Error(`memory relation context.${key} is not JSON-safe`);
    }
  }
  if (JSON.stringify(output).length > MAX_RELATION_CONTEXT_JSON) throw new Error("memory relation context is too large");
  return output;
}

function assertSafeMemoryRelation(relation: MemoryRelation): void {
  relationText(relation.subject, "memory relation subject");
  relationText(relation.predicate, "memory relation predicate", 128);
  relationText(relation.object, "memory relation object");
  relationText(relation.source, "memory relation source", 128);
  safeRelationContext(relation.context);
}

function relationTerms(value: string): string[] {
  return [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((term) => !["the", "a", "an", "my", "usual", "same", "again", "repeat", "thing", "stuff"].includes(term))
    .slice(0, 24);
}

export class MemoryStore {
  readonly stateDir: string | undefined;
  readonly scope: MemoryScope;
  #inMemoryDatabase: MemoryDatabase | undefined;
  #embeddingProvider: MemoryEmbeddingProvider | undefined;
  #closed = false;

  constructor(options: MemoryStoreOptions = {}) {
    this.scope = options.scope ?? "local";
    this.stateDir = options.inMemory ? undefined : options.stateDir;
    this.#embeddingProvider = options.embeddingProvider === null
      ? undefined
      : (options.embeddingProvider ?? DEFAULT_EMBEDDING_PROVIDER);
    if (this.#embeddingProvider) this.#assertEmbeddingProvider(this.#embeddingProvider);
    if (!options.inMemory && !this.stateDir) {
      throw new Error("file-backed memory requires a stateDir");
    }
    if (options.inMemory) {
      this.#inMemoryDatabase = new MemoryDatabase({ scope: this.scope, inMemory: true });
    }
  }

  get statePath(): string | undefined {
    return this.stateDir ? getMemoryStatePath(this.stateDir) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#inMemoryDatabase?.close();
    this.#closed = true;
  }

  snapshot(): MemoryState {
    return this.#withDatabase((database) => structuredClone(database.snapshot()));
  }

  /** Replace the complete scope in one database transaction (used for host-owned compensation). */
  replaceState(state: MemoryState): void {
    const replacement = structuredClone(state);
    for (const entry of Object.values(replacement.entries.memory)) assertSafeMemoryEntry(entry);
    for (const relation of replacement.relations ?? []) assertSafeMemoryRelation(relation);
    this.#withDatabase((database) => database.replaceState(replacement));
  }

  get(kind: MemoryEntryKind, id: string): MemoryEntry | undefined {
    assertKind(kind);
    return this.#withDatabase((database) => {
      const entry = database.getEntry(kind, id);
      return entry ? structuredClone(entry) : undefined;
    });
  }

  list(kind?: MemoryEntryKind): MemoryEntry[] {
    if (kind) assertKind(kind);
    return this.#withDatabase((database) =>
      database
        .listEntries(kind)
        .map((entry) => structuredClone(entry))
        .sort((left, right) =>
          [left.kind, left.path, left.title, left.id]
            .join("\0")
            .localeCompare([right.kind, right.path, right.title, right.id].join("\0")),
        ),
    );
  }

  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
    return this.#withDatabase((database) => {
      const provider = this.#embeddingProvider;
      if (!provider) {
        return database.search(query, options).map((result) => ({
          ...result,
          entry: structuredClone(result.entry),
        }));
      }

      const requestedLimit = options.limit ?? 8;
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_SEARCH_LIMIT) {
        throw new Error(`memory search limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
      }
      if (!query.trim()) return [];

      // Search never backfills or persists embeddings as a retrieval side effect.
      // Missing/stale vectors are maintained by mutations or explicit maintenance.
      const candidateLimit = Math.min(
        MAX_SEARCH_LIMIT,
        Math.max(HYBRID_CANDIDATE_FLOOR, requestedLimit * 4),
      );
      const candidateOptions = { ...options, limit: candidateLimit };
      const lexical = database.search(query, candidateOptions);
      const queryVector = this.#embed(provider, query);
      const semantic = database
        .searchSemantic(queryVector, provider.id, candidateOptions)
        .filter((result) => result.semanticScore >= MIN_SEMANTIC_SCORE);

      const combined = new Map<string, MemorySearchResult & { lexicalPosition?: number }>();
      lexical.forEach((result, index) => {
        const key = `${result.entry.kind}\0${result.entry.id}`;
        combined.set(key, {
          ...result,
          score: 0.45 * (1 / (index + 1)),
          matchedBy: "fts",
          lexicalPosition: index,
        });
      });

      semantic.forEach((result) => {
        const key = `${result.entry.kind}\0${result.entry.id}`;
        const existing = combined.get(key);
        const semanticScore = Math.max(0, Math.min(1, result.semanticScore));
        if (existing) {
          existing.semanticScore = result.semanticScore;
          existing.score += 0.55 * semanticScore;
          existing.matchedBy = "hybrid";
        } else {
          combined.set(key, {
            entry: result.entry,
            score: 0.55 * semanticScore,
            semanticScore: result.semanticScore,
            matchedBy: "semantic",
          });
        }
      });

      return [...combined.values()]
        .sort((left, right) =>
          right.score - left.score ||
          right.entry.updated_at.localeCompare(left.entry.updated_at) ||
          left.entry.kind.localeCompare(right.entry.kind) ||
          left.entry.id.localeCompare(right.entry.id),
        )
        .slice(0, requestedLimit)
        .map(({ lexicalPosition: _lexicalPosition, ...result }) => ({
          ...result,
          entry: structuredClone(result.entry),
        }));
    });
  }

  /**
   * Explicitly backfill stale/missing embeddings for this store. Search never
   * performs embedding maintenance implicitly.
   */
  refreshEmbeddings(): number {
    const provider = this.#embeddingProvider;
    if (!provider) return 0;
    return this.#withDatabase((database) => this.#refreshEmbeddings(database, provider));
  }

  create(kind: MemoryEntryKind, input: MemoryEntryWrite): MemoryEntry {
    assertKind(kind);
    return this.#withDatabase((database) => this.#create(database, kind, input));
  }

  update(kind: MemoryEntryKind, id: string, input: MemoryEntryUpdate): MemoryEntry {
    assertKind(kind);
    return this.#withDatabase((database) => this.#update(database, kind, id, input));
  }

  upsert(kind: MemoryEntryKind, input: MemoryEntryWrite): MemoryEntry {
    assertKind(kind);
    return this.#withDatabase((database) => {
      const id = input.id ?? slug(input.title, kind);
      const existing = database.getEntry(kind, id);
      if (!existing) return this.#create(database, kind, { ...input, id });
      return this.#update(database, kind, id, {
        title: input.title,
        content: input.content,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.reference !== undefined ? { reference: input.reference } : {}),
        ...(input.arguments !== undefined ? { arguments: input.arguments } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      });
    });
  }

  delete(kind: MemoryEntryKind, id: string): boolean {
    assertKind(kind);
    return this.#withDatabase((database) => database.deleteEntry(kind, id));
  }

  recordRefinement(
    trigger: string,
    changes: readonly string[] | string,
    options: { id?: string; evidence?: string; outcome?: string } = {},
  ): MemoryRefinementEvent {
    assertMemoryTextHasNoSecrets(trigger, "memory refinement trigger");
    const changeList = typeof changes === "string" ? [changes] : [...changes];
    for (const [index, change] of changeList.entries()) {
      assertMemoryTextHasNoSecrets(change, `memory refinement change[${index}]`);
    }
    if (options.evidence !== undefined) assertMemoryTextHasNoSecrets(options.evidence, "memory refinement evidence");
    if (options.outcome !== undefined) assertMemoryTextHasNoSecrets(options.outcome, "memory refinement outcome");
    return this.#withDatabase((database) => {
      const event = database.recordRefinement(
        trigger,
        changeList,
        {
          ...options,
          createdAt: now(),
        },
      );
      return structuredClone(event);
    });
  }

  observeRelation(input: MemoryRelationWrite): MemoryRelation {
    return this.#withDatabase((database) => {
      const subject = relationText(input.subject, "memory relation subject");
      const predicate = relationText(input.predicate, "memory relation predicate", 128).toLowerCase().replace(/\s+/g, "_");
      const object = relationText(input.object, "memory relation object");
      const context = safeRelationContext(input.context);
      const source = relationText(input.source ?? "agent", "memory relation source", 128);
      const confidence = input.confidence ?? 1;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error("memory relation confidence must be between 0 and 1");
      }
      const observedAt = input.observedAt ?? now();
      if (Number.isNaN(Date.parse(observedAt))) throw new Error("memory relation observedAt must be an ISO timestamp");
      const relation: MemoryRelation = {
        id: memoryRelationIdentity(this.scope, subject, predicate, object),
        scope: this.scope,
        subject,
        predicate,
        object,
        context,
        source,
        confidence,
        occurrences: 1,
        first_observed_at: observedAt,
        last_observed_at: observedAt,
        updated_at: now(),
      };
      return structuredClone(database.observeRelation(relation));
    });
  }

  getRelation(id: string): MemoryRelation | undefined {
    const normalized = relationText(id, "memory relation id", 128);
    return this.#withDatabase((database) => {
      const relation = database.getRelation(normalized);
      return relation ? structuredClone(relation) : undefined;
    });
  }

  /**
   * Replace one relation atomically. The old row is restored automatically if
   * validation/insertion fails, and an optional reviewed timestamp prevents
   * overwriting a relation changed by another process.
   */
  replaceRelation(id: string, input: MemoryRelationUpdate): MemoryRelation {
    const normalized = relationText(id, "memory relation id", 128);
    if (
      input.subject === undefined
      && input.predicate === undefined
      && input.object === undefined
      && input.context === undefined
      && input.source === undefined
      && input.confidence === undefined
      && input.observedAt === undefined
    ) {
      throw new Error("memory relation replacement requires at least one changed field");
    }
    return this.#withDatabase((database) => database.replaceRelation(
      normalized,
      (existing) => {
        const subject = input.subject === undefined
          ? existing.subject
          : relationText(input.subject, "memory relation subject");
        const predicate = input.predicate === undefined
          ? existing.predicate
          : relationText(input.predicate, "memory relation predicate", 128).toLowerCase().replace(/\s+/g, "_");
        const object = input.object === undefined
          ? existing.object
          : relationText(input.object, "memory relation object");
        const context = input.context === undefined
          ? structuredClone(existing.context)
          : safeRelationContext(input.context);
        const source = input.source === undefined
          ? existing.source
          : relationText(input.source, "memory relation source", 128);
        const confidence = input.confidence ?? existing.confidence;
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error("memory relation confidence must be between 0 and 1");
        }
        const nextId = memoryRelationIdentity(this.scope, subject, predicate, object);
        const sameSemanticEdge = nextId === existing.id;
        const observedAt = input.observedAt ?? (sameSemanticEdge ? existing.last_observed_at : now());
        if (Number.isNaN(Date.parse(observedAt))) throw new Error("memory relation observedAt must be an ISO timestamp");
        const updatedAt = now();
        return {
          id: nextId,
          scope: this.scope,
          subject,
          predicate,
          object,
          context,
          source,
          confidence,
          occurrences: sameSemanticEdge ? existing.occurrences : 1,
          first_observed_at: sameSemanticEdge ? existing.first_observed_at : observedAt,
          last_observed_at: sameSemanticEdge
            ? (existing.last_observed_at.localeCompare(observedAt) >= 0 ? existing.last_observed_at : observedAt)
            : observedAt,
          updated_at: updatedAt,
        };
      },
      input.expectedUpdatedAt,
    ));
  }

  queryRelations(options: MemoryRelationQuery = {}): MemoryRelationResult[] {
    const limit = options.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("memory relation query limit must be between 1 and 100");
    if (options.minimumOccurrences !== undefined && (!Number.isInteger(options.minimumOccurrences) || options.minimumOccurrences < 1)) {
      throw new Error("memory relation minimumOccurrences must be a positive integer");
    }
    const terms = relationTerms(options.query ?? "");
    return this.#withDatabase((database) => database.listRelations({ ...options, limit: Math.max(limit * 8, 100) }, terms)
      .map((relation) => {
        const haystack = `${relation.subject} ${relation.predicate.replaceAll("_", " ")} ${relation.object} ${JSON.stringify(relation.context)}`.toLowerCase();
        const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
        const ageDays = Math.max(0, (Date.now() - Date.parse(relation.last_observed_at)) / 86_400_000);
        const recency = 1 / (1 + ageDays / 30);
        const frequency = Math.log2(relation.occurrences + 1);
        const textScore = terms.length === 0 ? 0 : matches / terms.length;
        return { relation, score: textScore * 6 + frequency * 2 + recency + relation.confidence };
      })
      .sort((left, right) => right.score - left.score || right.relation.last_observed_at.localeCompare(left.relation.last_observed_at) || left.relation.id.localeCompare(right.relation.id))
      .slice(0, limit)
      .map((result) => ({ ...result, relation: structuredClone(result.relation) })));
  }

  deleteRelation(id: string): boolean {
    const normalized = relationText(id, "memory relation id", 128);
    return this.#withDatabase((database) => database.deleteRelation(normalized));
  }

  #create(database: MemoryDatabase, kind: MemoryEntryKind, input: MemoryEntryWrite): MemoryEntry {
    const id = input.id ?? slug(input.title, kind);
    if (database.getEntry(kind, id)) {
      throw new Error(`${kind} entry ${JSON.stringify(id)} already exists`);
    }
    if (kind === "skill") validateSkillReference(input.reference);
    const timestamp = now();
    const entry: MemoryEntry = {
      id,
      kind,
      title: input.title,
      content: input.content,
      path: input.path ?? "general",
      scope: this.scope,
      reference: structuredClone(input.reference ?? {}),
      arguments: structuredClone(input.arguments ?? {}),
      metadata: structuredClone(input.metadata ?? {}),
      source: input.source ?? "agent",
      created_at: timestamp,
      updated_at: timestamp,
      version: 1,
    };
    assertSafeMemoryEntry(entry);
    try {
      const provider = this.#embeddingProvider;
      if (provider) database.insertEntryWithEmbedding(entry, this.#embeddingRecord(provider, entry));
      else database.insertEntry(entry);
    } catch (error) {
      if (database.getEntry(kind, id)) {
        throw new Error(`${kind} entry ${JSON.stringify(id)} already exists`, { cause: error });
      }
      throw error;
    }
    return structuredClone(entry);
  }

  #update(
    database: MemoryDatabase,
    kind: MemoryEntryKind,
    id: string,
    input: MemoryEntryUpdate,
  ): MemoryEntry {
    const existing = database.getEntry(kind, id);
    if (!existing) throw new Error(`${kind} entry ${JSON.stringify(id)} does not exist`);
    if (kind === "skill" && input.reference !== undefined) validateSkillReference(input.reference);
    if (
      input.title === undefined
      && input.content === undefined
      && input.path === undefined
      && input.reference === undefined
      && input.arguments === undefined
      && input.metadata === undefined
      && input.source === undefined
    ) {
      throw new Error("memory update requires at least one changed field");
    }

    if (input.expectedVersion !== undefined) {
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error("memory expectedVersion must be a positive integer");
      }
      if (existing.version !== input.expectedVersion) {
        throw new Error(`${kind} entry ${JSON.stringify(id)} changed concurrently; retry the update`);
      }
    }

    const expectedVersion = existing.version;
    if (input.title !== undefined) existing.title = input.title;
    if (input.content !== undefined) existing.content = input.content;
    if (input.path !== undefined) existing.path = input.path;
    if (input.reference !== undefined) existing.reference = structuredClone(input.reference);
    if (input.arguments !== undefined) existing.arguments = structuredClone(input.arguments);
    if (input.metadata !== undefined) existing.metadata = structuredClone(input.metadata);
    existing.source = input.source ?? existing.source;
    existing.updated_at = now();
    existing.version += 1;
    assertSafeMemoryEntry(existing);

    const provider = this.#embeddingProvider;
    const updated = provider
      ? database.updateEntryWithEmbedding(existing, expectedVersion, this.#embeddingRecord(provider, existing))
      : database.updateEntry(existing, expectedVersion);
    if (!updated) {
      throw new Error(`${kind} entry ${JSON.stringify(id)} changed concurrently; retry the update`);
    }
    return structuredClone(existing);
  }

  #assertEmbeddingProvider(provider: MemoryEmbeddingProvider): void {
    if (!provider.id.trim()) throw new Error("memory embedding provider id is required");
    if (!Number.isInteger(provider.dimensions) || provider.dimensions < 1 || provider.dimensions > 4096) {
      throw new Error("memory embedding dimensions must be between 1 and 4096");
    }
  }

  #embed(provider: MemoryEmbeddingProvider, text: string): Float32Array {
    const raw = provider.embed(text);
    if (!(raw instanceof Float32Array)) {
      throw new Error("memory embedding provider must return Float32Array");
    }
    if (raw.length !== provider.dimensions) {
      throw new Error("memory embedding provider returned the wrong dimensions");
    }
    return normalizeEmbedding(new Float32Array(raw));
  }

  #embeddingRecord(provider: MemoryEmbeddingProvider, entry: MemoryEntry): MemoryEmbeddingRecord {
    return {
      providerId: provider.id,
      dimensions: provider.dimensions,
      vector: this.#embed(provider, memoryEntryEmbeddingText(entry)),
      entryVersion: entry.version,
      updatedAt: entry.updated_at,
    };
  }

  #refreshEmbeddings(database: MemoryDatabase, provider: MemoryEmbeddingProvider): number {
    const entries = database.listEntriesNeedingEmbedding(provider.id, provider.dimensions);
    for (const entry of entries) {
      database.upsertEmbedding(entry.kind, entry.id, this.#embeddingRecord(provider, entry));
    }
    return entries.length;
  }

  #withDatabase<T>(operation: (database: MemoryDatabase) => T): T {
    if (this.#closed) throw new Error("memory store is closed");
    if (this.#inMemoryDatabase) return operation(this.#inMemoryDatabase);
    if (!this.stateDir) throw new Error("memory state directory is unavailable");

    const database = new MemoryDatabase({ stateDir: this.stateDir, scope: this.scope });
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
}
