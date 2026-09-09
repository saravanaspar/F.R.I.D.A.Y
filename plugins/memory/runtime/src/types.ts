export const MEMORY_ENTRY_KINDS = ["prompt", "memory", "skill", "subagent"] as const;

export type MemoryEntryKind = (typeof MEMORY_ENTRY_KINDS)[number];
export type MemoryScope = "local" | "global";

export interface MemoryEntry {
  id: string;
  kind: MemoryEntryKind;
  title: string;
  content: string;
  path: string;
  scope: MemoryScope;
  reference: Record<string, unknown>;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface MemoryRefinementEvent {
  id: string;
  trigger: string;
  changes: string[];
  evidence: string;
  outcome: string;
  created_at: string;
}

export interface MemoryState {
  schema: number;
  entries: Record<MemoryEntryKind, Record<string, MemoryEntry>>;
  refinements: MemoryRefinementEvent[];
  /** Additive graph state; older snapshots may omit it. */
  relations?: MemoryRelation[] | undefined;
}

export interface MemoryRelation {
  id: string;
  scope: MemoryScope;
  subject: string;
  predicate: string;
  object: string;
  context: Record<string, unknown>;
  source: string;
  confidence: number;
  occurrences: number;
  first_observed_at: string;
  last_observed_at: string;
  updated_at: string;
}

export interface MemoryRelationWrite {
  subject: string;
  predicate: string;
  object: string;
  context?: Record<string, unknown> | undefined;
  source?: string | undefined;
  confidence?: number | undefined;
  observedAt?: string | undefined;
}

/** Atomic replacement patch for one existing relation. Omitted fields are preserved. */
export interface MemoryRelationUpdate {
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
  context?: Record<string, unknown> | undefined;
  source?: string | undefined;
  confidence?: number | undefined;
  observedAt?: string | undefined;
  /** Fail rather than replacing a relation that changed after it was reviewed. */
  expectedUpdatedAt?: string | undefined;
}

export interface MemoryRelationQuery {
  query?: string | undefined;
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
  minimumOccurrences?: number | undefined;
  limit?: number | undefined;
}

export interface MemoryRelationResult {
  relation: MemoryRelation;
  /** Frequency/recency/text relevance; larger is more useful. */
  score: number;
}

export interface MemoryEntryWrite {
  id?: string;
  title: string;
  content: string;
  path?: string;
  reference?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface MemoryEntryUpdate {
  /** Omitted fields preserve the current persisted value. */
  title?: string;
  content?: string;
  path?: string;
  reference?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: string;
  /** Fail rather than overwriting when the caller corrected a stale snapshot. */
  expectedVersion?: number;
}

export interface MemorySearchOptions {
  kinds?: readonly MemoryEntryKind[];
  scope?: MemoryScope;
  pathPrefix?: string;
  limit?: number;
}

export interface MemoryEmbeddingStatus {
  /** Whether semantic retrieval is enabled for this store. */
  enabled: boolean;
  /** Configured embedding-space identifier. Different provider ids are never mixed. */
  providerId?: string | undefined;
  dimensions?: number | undefined;
  /** Whether the configured provider runtime/model is ready for inference. */
  ready: boolean;
  /** Whether a provider-owned inference worker is currently warm. */
  active?: boolean | undefined;
  /** Bounded operator-facing explanation when semantic inference is unavailable. */
  reason?: string | undefined;
  totalEntries: number;
  readyEntries: number;
  staleEntries: number;
  missingEntries: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  /** Combined hybrid relevance score; larger is more relevant. */
  score: number;
  /** Native FTS5 bm25 rank; lower is more relevant when present. */
  lexicalRank?: number;
  /** Cosine similarity from the configured local embedding provider when present. */
  semanticScore?: number;
  matchedBy: "fts" | "semantic" | "hybrid";
}

export interface MemoryOverviewOptions {
  maxEntriesPerKind?: number;
  maxRefinements?: number;
  maxContentLength?: number;
}
