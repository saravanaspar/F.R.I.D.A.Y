import { existsSync, readFileSync } from "node:fs";
import {
  MEMORY_ENTRY_KINDS,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryRefinementEvent,
  type MemoryScope,
  type MemoryState,
} from "./types.js";

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
  };
}

function setOwnLegacyEntry(state: MemoryState, entry: MemoryEntry): void {
  Object.defineProperty(state.entries[entry.kind], entry.id, {
    value: entry,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizedScope(value: unknown, fallback: MemoryScope): MemoryScope {
  return value === "local" || value === "global" ? value : fallback;
}

function normalizedVersion(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function normalizedTimestamp(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : new Date(0).toISOString();
}

function parseEntry(
  id: string,
  kind: MemoryEntryKind,
  value: unknown,
  fallbackScope: MemoryScope,
): MemoryEntry | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  if (typeof record.title !== "string" || typeof record.content !== "string") return undefined;

  return {
    id,
    kind,
    title: record.title,
    content: record.content,
    path: typeof record.path === "string" ? record.path : "general",
    scope: normalizedScope(record.scope, fallbackScope),
    reference: objectRecord(record.reference) ?? {},
    arguments: objectRecord(record.arguments) ?? {},
    metadata: objectRecord(record.metadata) ?? {},
    source: typeof record.source === "string" ? record.source : "agent",
    created_at: normalizedTimestamp(record.created_at),
    updated_at: normalizedTimestamp(record.updated_at),
    version: normalizedVersion(record.version),
  };
}

function parseRefinement(value: unknown): MemoryRefinementEvent | undefined {
  const record = objectRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.trigger !== "string") return undefined;
  const rawChanges = record.changes;
  let changes: string[];
  if (typeof rawChanges === "string") changes = [rawChanges];
  else if (Array.isArray(rawChanges)) changes = rawChanges.map((change) => String(change));
  else return undefined;

  return {
    id: record.id,
    trigger: record.trigger,
    changes,
    evidence: typeof record.evidence === "string" ? record.evidence : "",
    outcome: typeof record.outcome === "string" ? record.outcome : "",
    created_at: normalizedTimestamp(record.created_at),
  };
}

export function loadLegacyMemoryState(
  statePath: string,
  fallbackScope: MemoryScope,
): MemoryState | undefined {
  if (!existsSync(statePath)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`legacy memory state is not valid JSON: ${statePath}`, { cause: error });
  }

  const parsed = objectRecord(raw);
  if (!parsed) {
    throw new Error(`legacy memory state must contain a JSON object: ${statePath}`);
  }

  const state = emptyState();
  const rawEntries = objectRecord(parsed.entries);
  if (rawEntries) {
    for (const kind of MEMORY_ENTRY_KINDS) {
      const records = objectRecord(rawEntries[kind]);
      if (!records) continue;
      for (const [id, value] of Object.entries(records)) {
        const entry = parseEntry(id, kind, value, fallbackScope);
        if (entry) setOwnLegacyEntry(state, entry);
      }
    }
  }

  if (Array.isArray(parsed.refinements)) {
    state.refinements = parsed.refinements
      .map((event) => parseRefinement(event))
      .filter((event): event is MemoryRefinementEvent => event !== undefined);
  }

  return state;
}
