import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  createEmptyMemoryState,
  formatMemoryOverview,
  getGlobalMemoryStateDir,
  getLegacyMemoryStatePath,
  getLocalMemoryStateDir,
  getMemoryStatePath,
  loadMemoryState,
  mergeMemoryStates,
  saveMemoryState,
  type MemoryEmbeddingProvider,
  type MemoryEntryKind,
} from "../src/index.js";

const tempDirs: string[] = [];

describe("relation retrieval candidate selection", () => {
  it("finds older matching relations before limiting candidates, including Unicode and predicate words", () => {
    const store = new MemoryStore({ inMemory: true, embeddingProvider: null });
    try {
      store.observeRelation({ subject: "user", predicate: "favorite_drink", object: "JÄSMINE", observedAt: "2025-01-01T00:00:00Z" });
      for (let i = 0; i < 600; i++) {
        store.observeRelation({ subject: "user", predicate: "uses", object: `unrelated-${i}`, observedAt: "2026-01-01T00:00:00Z" });
      }
      expect(store.queryRelations({ query: "jäsMine" }).map(({ relation }) => relation.object)).toEqual(["JÄSMINE"]);
      expect(store.queryRelations({ query: "favorite drink" })[0]?.relation.object).toBe("JÄSMINE");
      expect(store.queryRelations({ query: "jäsMine", subject: "someone-else" })).toEqual([]);
      expect(store.queryRelations({ query: "unrelated", limit: 3 })).toHaveLength(3);
    } finally {
      store.close();
    }
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "friday-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const skillReference = {
  type: "python",
  import: "agent_skills.example",
  callable: "run",
  call_pattern: "await run(...)"
};

const kinds = ["prompt", "memory", "skill", "subagent"] as const satisfies readonly MemoryEntryKind[];

const semanticTestProvider: MemoryEmbeddingProvider = {
  id: "test-semantic-v1",
  dimensions: 3,
  embed(text: string): Float32Array {
    const normalized = text.toLowerCase();
    if (
      normalized.includes("adaptive sequence") ||
      normalized.includes("learned chunks") ||
      normalized.includes("byte primitives")
    ) {
      return new Float32Array([1, 0, 0]);
    }
    if (normalized.includes("scheduler") || normalized.includes("cron") || normalized.includes("time jobs")) {
      return new Float32Array([0, 1, 0]);
    }
    if (normalized.includes("archive concept") || normalized.includes("legacy marker")) {
      return new Float32Array([0, 0, 1]);
    }
    return new Float32Array([0, 0, 0]);
  },
};

describe("memory state paths", () => {
  it("uses explicit memory directories beneath host-owned roots", () => {
    expect(getGlobalMemoryStateDir("/agent")).toBe(join("/agent", "memory"));
    expect(getLocalMemoryStateDir("/session/artifacts")).toBe(join("/session/artifacts", "memory"));
    expect(getLocalMemoryStateDir(undefined)).toBeUndefined();
  });

  it("uses one stable SQLite database name", () => {
    expect(getMemoryStatePath("/tmp/state")).toBe(join("/tmp/state", "memory.sqlite"));
  });
});

describe("memory SQLite persistence and migration", () => {
  it("starts with an empty logical schema", () => {
    expect(createEmptyMemoryState()).toEqual({
      schema: 1,
      entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
      refinements: [],
      relations: [],
    });
  });

  it("persists state transactionally and preserves database permissions", () => {
    const dir = makeTempDir();
    const state = createEmptyMemoryState();
    state.entries.memory.one = {
      id: "one",
      kind: "memory",
      title: "One",
      content: "content",
      path: "general",
      scope: "global",
      reference: {},
      arguments: {},
      metadata: {},
      source: "agent",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      version: 1,
    };

    const statePath = saveMemoryState(dir, state);
    expect(statePath).toBe(getMemoryStatePath(dir));
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    chmodSync(statePath, 0o640);
    saveMemoryState(dir, state);
    expect(statSync(statePath).mode & 0o777).toBe(0o640);
    expect(loadMemoryState(dir).entries.memory.one?.content).toBe("content");
  });

  it("fails closed on a corrupt SQLite database", () => {
    const dir = makeTempDir();
    writeFileSync(getMemoryStatePath(dir), "not sqlite", "utf8");
    expect(() => loadMemoryState(dir)).toThrow();
  });

  it("migrates the legacy JSON state once while preserving the source file", () => {
    const dir = makeTempDir();
    writeFileSync(
      getLegacyMemoryStatePath(dir),
      JSON.stringify({
        schema: 1,
        entries: {
          memory: {
            known: {
              id: "wrong",
              kind: "skill",
              title: "Known",
              content: "Loaded",
              path: 12,
              scope: "wrong",
              reference: "bad",
              arguments: null,
              metadata: { migrated: true },
              source: null,
              version: "2",
              extra: true,
            },
            missing_content: { title: "skip" },
          },
        },
        refinements: [
          { id: "r1", trigger: "loaded", changes: [1, "two"], extra: true },
          { id: "bad", trigger: "skip" },
        ],
      }),
      "utf8",
    );

    const state = loadMemoryState(dir, "local");
    expect(state.entries.memory.known).toMatchObject({
      id: "known",
      kind: "memory",
      path: "general",
      scope: "local",
      reference: {},
      arguments: {},
      metadata: { migrated: true },
      source: "agent",
      version: 2,
    });
    expect(state.entries.memory.missing_content).toBeUndefined();
    expect(state.refinements).toHaveLength(1);
    expect(state.refinements[0]?.changes).toEqual(["1", "two"]);
    expect(existsSync(getLegacyMemoryStatePath(dir))).toBe(true);
    expect(existsSync(getMemoryStatePath(dir))).toBe(true);
  });

  it("upgrades schema-1 SQLite state for embedding storage without losing entries", () => {
    const dir = makeTempDir();
    const store = new MemoryStore({ stateDir: dir, embeddingProvider: null });
    store.create("memory", {
      id: "pscls",
      title: "PSCLS",
      content: "Persistent learned chunks over UTF-8 byte primitives.",
    });

    const database = new DatabaseSync(getMemoryStatePath(dir));
    database.exec("DROP TABLE memory_embeddings; PRAGMA user_version = 1");
    database.close();

    const upgraded = new MemoryStore({ stateDir: dir, embeddingProvider: semanticTestProvider });
    expect(upgraded.search("adaptive sequence")[0]).toMatchObject({
      entry: { id: "pscls" },
      matchedBy: "semantic",
    });
    expect(upgraded.get("memory", "pscls")?.content).toContain("learned chunks");

    const reopened = new DatabaseSync(getMemoryStatePath(dir), { readOnly: true });
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    reopened.close();
    expect(version.user_version).toBe(3);
  });

  it("fails before creating SQLite state when legacy JSON is corrupt", () => {
    const dir = makeTempDir();
    writeFileSync(getLegacyMemoryStatePath(dir), "not json", "utf8");
    expect(() => loadMemoryState(dir)).toThrow("legacy memory state is not valid JSON");
    expect(existsSync(getMemoryStatePath(dir))).toBe(false);
  });
});

describe("MemoryStore", () => {
  it("creates, gets, and lists all continual entry kinds", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "local" });
    for (const kind of kinds) {
      const entry = store.create(kind, {
        id: `${kind}_entry`,
        title: `${kind} title`,
        content: `${kind} content`,
        path: `${kind}/path`,
        ...(kind === "skill" ? { reference: skillReference, arguments: {} } : {}),
      });
      expect(entry.kind).toBe(kind);
      expect(entry.scope).toBe("local");
      expect(store.get(kind, entry.id)?.content).toContain("content");
    }
    expect(store.list()).toHaveLength(4);
  });

  it("generates bounded ids and fills defaults", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global" });
    const entry = store.create("memory", {
      title: "Prefer Focused Patches!",
      content: "Small changes are easier to validate.",
    });
    expect(entry).toMatchObject({
      id: "prefer_focused_patches",
      path: "general",
      scope: "global",
      reference: {},
      arguments: {},
      metadata: {},
      source: "agent",
      version: 1,
    });
  });

  it("rejects duplicate creates and missing updates", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "one", title: "One", content: "first" });
    expect(() => store.create("memory", { id: "one", title: "One", content: "second" })).toThrow(
      "already exists",
    );
    expect(() => store.update("memory", "missing", { title: "Missing", content: "none" })).toThrow(
      "does not exist",
    );
  });

  it("updates version while preserving omitted structured fields", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("skill", {
      id: "check",
      title: "Check",
      content: "old",
      path: "validation",
      reference: skillReference,
      arguments: { target: { type: "string", required: true } },
      metadata: { source: "test" },
    });
    const updated = store.update("skill", "check", { title: "Check", content: "new" });
    expect(updated).toMatchObject({
      content: "new",
      path: "validation",
      reference: skillReference,
      arguments: { target: { type: "string", required: true } },
      metadata: { source: "test" },
      version: 2,
    });
  });

  it("upserts without resetting omitted fields", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    const first = store.upsert("memory", {
      id: "decision",
      title: "Decision",
      content: "first",
      path: "project",
      metadata: { stable: true },
    });
    const second = store.upsert("memory", {
      id: "decision",
      title: "Decision",
      content: "second",
    });
    expect(first.version).toBe(1);
    expect(second).toMatchObject({ content: "second", path: "project", metadata: { stable: true }, version: 2 });
  });

  it("deletes existing entries and reports missing entries", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "gone", title: "Gone", content: "delete me" });
    expect(store.delete("memory", "gone")).toBe(true);
    expect(store.get("memory", "gone")).toBeUndefined();
    expect(store.delete("memory", "gone")).toBe(false);
  });

  it("requires valid Python references for reusable skill descriptions", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    expect(() =>
      store.create("skill", { id: "missing", title: "Missing", content: "bad", arguments: {} }),
    ).toThrow("require a Python reference");
    expect(() =>
      store.create("skill", {
        id: "shell",
        title: "Shell",
        content: "bad",
        reference: { type: "shell", command: "x" },
        arguments: {},
      }),
    ).toThrow("reference.type must be 'python'");
    expect(() =>
      store.create("skill", {
        id: "no_import",
        title: "No import",
        content: "bad",
        reference: { type: "python", callable: "run" },
        arguments: {},
      }),
    ).toThrow("requires a Python import");
  });

  it("supports an in-memory store without touching disk", () => {
    const dir = makeTempDir();
    const store = new MemoryStore({ stateDir: dir, inMemory: true });
    store.create("memory", { id: "volatile", title: "Volatile", content: "only memory" });
    expect(store.get("memory", "volatile")?.content).toBe("only memory");
    expect(existsSync(getMemoryStatePath(dir))).toBe(false);
    expect(store.statePath).toBeUndefined();
  });

  it("returns defensive entry and state snapshots", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "safe", title: "Safe", content: "original", metadata: { nested: { value: 1 } } });
    const entry = store.get("memory", "safe");
    if (!entry) throw new Error("missing test entry");
    entry.content = "mutated";
    entry.metadata.nested = { value: 99 };
    const state = store.snapshot();
    state.entries.memory.safe!.content = "also mutated";
    expect(store.get("memory", "safe")?.content).toBe("original");
  });

  it("observes external writes before the next mutation", () => {
    const dir = makeTempDir();
    const first = new MemoryStore({ stateDir: dir });
    first.create("memory", { id: "first", title: "First", content: "one" });

    const second = new MemoryStore({ stateDir: dir });
    second.create("memory", { id: "external", title: "External", content: "two" });

    first.create("memory", { id: "third", title: "Third", content: "three" });
    const reloaded = new MemoryStore({ stateDir: dir });
    expect(reloaded.get("memory", "first")).toBeDefined();
    expect(reloaded.get("memory", "external")).toBeDefined();
    expect(reloaded.get("memory", "third")).toBeDefined();
  });

  it("records passive refinement events and persists them", () => {
    const dir = makeTempDir();
    const store = new MemoryStore({ stateDir: dir });
    const event = store.recordRefinement("validation repeated", ["update memory:check"], {
      evidence: "two failures",
      outcome: "next check passed",
    });
    expect(event.id).toBe("refine_0001");
    const reloaded = new MemoryStore({ stateDir: dir });
    expect(reloaded.snapshot().refinements[0]).toMatchObject({
      trigger: "validation repeated",
      evidence: "two failures",
      outcome: "next check passed",
    });
  });

  it("sorts lists by kind, path, title, and id", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "b", title: "Beta", content: "b", path: "z" });
    store.create("memory", { id: "a", title: "Alpha", content: "a", path: "a" });
    store.create("prompt", { id: "p", title: "Prompt", content: "p" });
    expect(store.list().map((entry) => entry.id)).toEqual(["a", "b", "p"]);
    expect(store.list("memory").map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("memory hybrid search", () => {
  it("searches title and content with scope, kind, and path filters", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global" });
    store.create("memory", {
      id: "pscls",
      title: "PSCLS byte representation",
      content: "Persistent learned chunks over UTF-8 byte primitives.",
      path: "projects/pscls",
    });
    store.create("memory", {
      id: "friday",
      title: "FRIDAY scheduler",
      content: "Durable cron scheduling and routing.",
      path: "projects/friday",
    });
    store.create("prompt", {
      id: "prompt_byte",
      title: "Byte prompt",
      content: "byte-only prompt note",
      path: "prompts",
    });

    expect(store.search("byte chunks")[0]?.entry.id).toBe("pscls");
    expect(store.search("byte", { kinds: ["memory"] }).map((result) => result.entry.id)).toEqual([
      "pscls",
    ]);
    expect(store.search("byte", { pathPrefix: "projects/ps" }).map((result) => result.entry.id)).toEqual([
      "pscls",
    ]);
    expect(store.search("byte", { scope: "local" })).toEqual([]);
  });

  it("keeps the FTS index synchronized across updates and deletes", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "changing", title: "Changing", content: "old searchable phrase" });
    expect(store.search("old phrase")[0]?.entry.id).toBe("changing");

    store.update("memory", "changing", {
      title: "Changing",
      content: "new adaptive sequence representation",
    });
    expect(store.search("old phrase")).toEqual([]);
    expect(store.search("adaptive sequence")[0]?.entry.id).toBe("changing");

    expect(store.delete("memory", "changing")).toBe(true);
    expect(store.search("adaptive sequence")).toEqual([]);
  });

  it("finds semantic-only matches and applies the same scope/kind/path filters", () => {
    const store = new MemoryStore({
      stateDir: makeTempDir(),
      scope: "global",
      embeddingProvider: semanticTestProvider,
    });
    store.create("memory", {
      id: "pscls",
      title: "PSCLS",
      content: "Persistent learned chunks over UTF-8 byte primitives.",
      path: "projects/pscls",
    });
    store.create("memory", {
      id: "friday",
      title: "FRIDAY scheduler",
      content: "Durable cron scheduling.",
      path: "projects/friday",
    });

    const result = store.search("adaptive sequence representation")[0];
    expect(result).toMatchObject({ entry: { id: "pscls" }, matchedBy: "semantic" });
    expect(result?.semanticScore).toBeGreaterThan(0.99);
    expect(store.search("adaptive sequence", { kinds: ["prompt"] })).toEqual([]);
    expect(store.search("adaptive sequence", { pathPrefix: "projects/fr" })).toEqual([]);
    expect(store.search("adaptive sequence", { scope: "local" })).toEqual([]);
  });

  it("combines lexical and vector evidence and refreshes vectors on update/delete", () => {
    const store = new MemoryStore({
      stateDir: makeTempDir(),
      embeddingProvider: semanticTestProvider,
    });
    store.create("memory", {
      id: "changing",
      title: "Adaptive sequence",
      content: "Persistent learned chunks over byte primitives.",
    });

    expect(store.search("adaptive sequence")[0]).toMatchObject({
      entry: { id: "changing" },
      matchedBy: "hybrid",
    });

    store.update("memory", "changing", {
      title: "Archived note",
      content: "legacy marker",
    });
    expect(store.search("adaptive sequence")).toEqual([]);
    expect(store.search("archive concept")[0]).toMatchObject({
      entry: { id: "changing" },
      matchedBy: "semantic",
    });

    expect(store.delete("memory", "changing")).toBe(true);
    expect(store.search("archive concept")).toEqual([]);
  });

  it("keeps entry mutations atomic when embedding generation fails", () => {
    const provider: MemoryEmbeddingProvider = {
      id: "throwing-v1",
      dimensions: 3,
      embed(text: string): Float32Array {
        if (text.includes("explode")) throw new Error("embedding failed");
        return new Float32Array([1, 0, 0]);
      },
    };
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: provider });

    expect(() =>
      store.create("memory", { id: "bad", title: "explode", content: "never persist" }),
    ).toThrow("embedding failed");
    expect(store.get("memory", "bad")).toBeUndefined();

    store.create("memory", { id: "stable", title: "Stable", content: "original" });
    expect(() =>
      store.update("memory", "stable", { title: "explode", content: "replacement" }),
    ).toThrow("embedding failed");
    expect(store.get("memory", "stable")).toMatchObject({
      title: "Stable",
      content: "original",
      version: 1,
    });
  });

  it("can disable embeddings for deterministic lexical-only callers", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: null });
    store.create("memory", {
      id: "pscls",
      title: "PSCLS byte representation",
      content: "Persistent learned chunks over UTF-8 byte primitives.",
    });
    const lexical = store.search("byte")[0];
    expect(lexical).toMatchObject({
      entry: { id: "pscls" },
      matchedBy: "fts",
    });
    expect(lexical?.semanticScore).toBeUndefined();
    expect(store.search("adaptive hierarchy encoding")).toEqual([]);
  });

  it("bounds search requests and safely handles empty queries", () => {
    const store = new MemoryStore({ stateDir: makeTempDir() });
    store.create("memory", { id: "one", title: "One", content: "searchable" });
    expect(store.search("   ")).toEqual([]);
    expect(store.search("!!!")).toEqual([]);
    expect(() => store.search("searchable", { limit: 0 })).toThrow("between 1 and 100");
    expect(() => store.search("searchable", { limit: 101 })).toThrow("between 1 and 100");
  });
});

describe("graph preferences and habits", () => {
  it("reinforces and recalls a repeated action without scanning turn history", () => {
    const directory = makeTempDir();
    const store = new MemoryStore({ stateDir: directory, scope: "global", embeddingProvider: null });
    const observation = {
      subject: "user",
      predicate: "usually_orders",
      object: "biryani from RR Biryani",
      context: { integration: "swiggy", item: "chicken biryani" },
      source: "test",
      observedAt: "2026-08-20T12:00:00.000Z",
    };
    const first = store.observeRelation(observation);
    const second = store.observeRelation({ ...observation, observedAt: "2026-08-21T12:00:00.000Z" });
    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);
    expect(store.queryRelations({ query: "order the usual stuff" })[0]).toMatchObject({
      relation: { object: "biryani from RR Biryani", occurrences: 2 },
    });
    expect(store.queryRelations({ query: "same biryani" })[0]?.relation.context).toEqual({
      integration: "swiggy",
      item: "chicken biryani",
    });
    store.close();

    const reopened = new MemoryStore({ stateDir: directory, scope: "global", embeddingProvider: null });
    expect(reopened.snapshot().relations).toHaveLength(1);
    expect(reopened.queryRelations({ minimumOccurrences: 2 })[0]?.relation.occurrences).toBe(2);
  });

  it("rejects secret-shaped graph context", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: null });
    expect(() => store.observeRelation({
      subject: "user",
      predicate: "uses",
      object: "service",
      context: { access_token: "must-not-persist" },
    })).toThrow(/secret/);
  });
});

describe("memory merging and overview", () => {
  it("merges global and local state without hiding colliding ids", () => {
    const globalStore = new MemoryStore({ stateDir: makeTempDir(), scope: "global" });
    const localStore = new MemoryStore({ stateDir: makeTempDir(), scope: "local" });
    globalStore.create("memory", { id: "shared", title: "Shared", content: "global" });
    localStore.create("memory", { id: "shared", title: "Shared", content: "local" });

    const merged = mergeMemoryStates(globalStore.snapshot(), localStore.snapshot());
    expect(merged.entries.memory.shared).toMatchObject({ content: "global", scope: "global" });
    expect(merged.entries.memory["local:shared"]).toMatchObject({ id: "shared", content: "local", scope: "local" });
  });

  it("preserves an explicit stored scope during merge", () => {
    const state = createEmptyMemoryState();
    state.entries.memory.session_note = {
      id: "session_note",
      kind: "memory",
      title: "Session note",
      content: "local even in shared state",
      path: "general",
      scope: "local",
      reference: {},
      arguments: {},
      metadata: {},
      source: "agent",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      version: 1,
    };
    expect(mergeMemoryStates(state).entries.memory.session_note?.scope).toBe("local");
  });

  it("formats a bounded data-only overview for host composition", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global" });
    store.create("memory", { id: "one", title: "One", content: "A".repeat(80), path: "p" });
    store.create("memory", { id: "two", title: "Two", content: "second", path: "p" });
    store.create("skill", {
      id: "review",
      title: "Review",
      content: "Run review",
      reference: skillReference,
      arguments: { target: { type: "string" } },
    });
    store.recordRefinement("updated", "update memory:one", { outcome: "passed" });
    const overview = formatMemoryOverview(store.snapshot(), {
      maxEntriesPerKind: 1,
      maxRefinements: 1,
      maxContentLength: 40,
    });
    expect(overview).toContain("# Continual Memory State");
    expect(overview).toContain("memory: 2");
    expect(overview).toContain("+1 more memory entries");
    expect(overview).toContain("[global:review]");
    expect(overview).toContain("recent refinements: 1");
    expect(overview).not.toContain("await rlm");
    expect(overview).not.toContain("system prompt");
  });

  it("renders an explicit empty-state marker", () => {
    expect(formatMemoryOverview(createEmptyMemoryState())).toContain("No saved memory entries yet.");
  });
});
