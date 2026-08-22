import { join } from "node:path";
import {
  LEGACY_MEMORY_STATE_FILE_NAME,
  MEMORY_DATABASE_FILE_NAME,
  MemoryDatabase,
} from "./database.js";
import {
  MEMORY_ENTRY_KINDS,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
} from "./types.js";

/** Backward-compatible name: the memory state path is now the SQLite database path. */
export const MEMORY_STATE_FILE_NAME = MEMORY_DATABASE_FILE_NAME;
export { LEGACY_MEMORY_STATE_FILE_NAME, MEMORY_DATABASE_FILE_NAME };

export function createEmptyMemoryState(): MemoryState {
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

export function getGlobalMemoryStateDir(agentDir: string): string {
  return join(agentDir, "memory");
}

export function getLocalMemoryStateDir(sessionArtifactDir: string | undefined): string | undefined {
  return sessionArtifactDir ? join(sessionArtifactDir, "memory") : undefined;
}

export function getMemoryStatePath(stateDir: string): string {
  return join(stateDir, MEMORY_DATABASE_FILE_NAME);
}

export function getLegacyMemoryStatePath(stateDir: string): string {
  return join(stateDir, LEGACY_MEMORY_STATE_FILE_NAME);
}

export function loadMemoryState(stateDir: string, scope: MemoryScope = "global"): MemoryState {
  const database = new MemoryDatabase({ stateDir, scope });
  try {
    return database.snapshot();
  } finally {
    database.close();
  }
}

export function saveMemoryState(stateDir: string, state: MemoryState): string {
  const database = new MemoryDatabase({ stateDir, scope: "global", migrateLegacy: false });
  try {
    database.replaceState(state);
    if (!database.path) throw new Error("memory database path is unavailable");
    return database.path;
  } finally {
    database.close();
  }
}

function normalizedScope(value: unknown, fallback: MemoryScope): MemoryScope {
  return value === "local" || value === "global" ? value : fallback;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry);
}

function setOwnMemoryEntry(entries: Record<string, MemoryEntry>, id: string, entry: MemoryEntry): void {
  Object.defineProperty(entries, id, {
    value: entry,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function mergeMemoryStates(globalState: MemoryState, localState?: MemoryState): MemoryState {
  const merged = createEmptyMemoryState();
  merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);

  for (const kind of MEMORY_ENTRY_KINDS) {
    for (const [id, entry] of Object.entries(globalState.entries[kind])) {
      setOwnMemoryEntry(merged.entries[kind], id, {
        ...cloneEntry(entry),
        scope: normalizedScope(entry.scope, "global"),
      });
    }
    for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
      const localEntry: MemoryEntry = {
        ...cloneEntry(entry),
        scope: normalizedScope(entry.scope, "local"),
      };
      const mergedId = Object.hasOwn(merged.entries[kind], id) ? `${localEntry.scope}:${id}` : id;
      setOwnMemoryEntry(merged.entries[kind], mergedId, localEntry);
    }
  }

  merged.refinements = [
    ...structuredClone(globalState.refinements),
    ...structuredClone(localState?.refinements ?? []),
  ];
  merged.relations = [
    ...structuredClone(globalState.relations ?? []),
    ...structuredClone(localState?.relations ?? []),
  ];
  return merged;
}
