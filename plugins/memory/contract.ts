import type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEntryUpdate,
  MemoryEntryWrite,
  MemoryRefinementEvent,
  MemoryRelation,
  MemoryRelationQuery,
  MemoryRelationResult,
  MemoryRelationUpdate,
  MemoryRelationWrite,
  MemoryScope,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryState,
} from "@friday/memory";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";


export interface MemoryOpenOptions {
  readonly stateDir?: string | undefined;
  readonly scope?: MemoryScope | undefined;
  readonly inMemory?: boolean | undefined;
  /** Disable semantic/vector retrieval while preserving lexical memory behavior. */
  readonly semanticSearch?: boolean | undefined;
}

/**
 * Storage-neutral memory store contract. Consumers depend on memory semantics,
 * not the concrete SQLite-backed MemoryStore class.
 */
export interface MemoryStoreService {
  readonly stateDir: string | undefined;
  readonly scope: MemoryScope;
  readonly statePath: string | undefined;
  close(): void;
  snapshot(): MemoryState;
  replaceState(state: MemoryState): void;
  get(kind: MemoryEntryKind, id: string): MemoryEntry | undefined;
  list(kind?: MemoryEntryKind): MemoryEntry[];
  search(query: string, options?: MemorySearchOptions): MemorySearchResult[];
  /** Explicit maintenance; search/recall never backfills vectors as a side effect. */
  refreshEmbeddings(): number;
  create(kind: MemoryEntryKind, input: MemoryEntryWrite): MemoryEntry;
  update(kind: MemoryEntryKind, id: string, input: MemoryEntryUpdate): MemoryEntry;
  upsert(kind: MemoryEntryKind, input: MemoryEntryWrite): MemoryEntry;
  delete(kind: MemoryEntryKind, id: string): boolean;
  recordRefinement(
    trigger: string,
    changes: readonly string[] | string,
    options?: { id?: string; evidence?: string; outcome?: string },
  ): MemoryRefinementEvent;
  observeRelation(input: MemoryRelationWrite): MemoryRelation;
  getRelation(id: string): MemoryRelation | undefined;
  replaceRelation(id: string, input: MemoryRelationUpdate): MemoryRelation;
  queryRelations(options?: MemoryRelationQuery): MemoryRelationResult[];
  deleteRelation(id: string): boolean;
}

/** Durable memory semantics shared across Routing, Turn Loop, and Refinement. */
export interface MemoryService {
  /** Open one scoped memory store. The concrete backend remains private to Memory. */
  openStore(options?: MemoryOpenOptions): MemoryStoreService;
  globalStateDir(agentDir: string): string;
  localStateDir(sessionArtifactDir: string | undefined): string | undefined;
  statePath(stateDir: string): string;
  formatRelevant(
    entries: readonly MemorySearchResult[],
    relations: readonly MemoryRelationResult[],
    options?: { maxCharacters?: number | undefined },
  ): string | undefined;
  mergeStates(globalState: MemoryState, localState?: MemoryState): MemoryState;
}

export const MEMORY_CAPABILITY: Capability<MemoryService> =
  defineCapability<MemoryService>("memory");

export type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEntryUpdate,
  MemoryEntryWrite,
  MemoryRefinementEvent,
  MemoryRelation,
  MemoryRelationQuery,
  MemoryRelationResult,
  MemoryRelationUpdate,
  MemoryRelationWrite,
  MemoryScope,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryState,
};
