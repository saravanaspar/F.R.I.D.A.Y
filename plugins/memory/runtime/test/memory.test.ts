import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { MemoryDatabase } from "../src/database.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  BGE_SMALL_EN_V15_DIMENSIONS,
  BGE_SMALL_EN_V15_INT8_PROVIDER_ID,
  BGE_SMALL_EN_V15_MODEL_ID,
  BGE_SMALL_EN_V15_MODEL_REVISION,
  BGE_SMALL_EN_V15_MODEL_SHA256,
  MEMORY_BGE_PROFILE_SCHEMA,
  BgeSmallEnV15Int8EmbeddingProvider,
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

function fakeBgeToolingRoot(): string {
  const root = makeTempDir();
  const bin = join(root, "venv", "bin");
  const model = join(root, "models", "Xenova", "bge-small-en-v1.5");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(model, "onnx"), { recursive: true });
  const fakePython = join(bin, "python");
  writeFileSync(fakePython, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const vector = Array(${BGE_SMALL_EN_V15_DIMENSIONS}).fill(0);
  vector[0] = 1;
  if (request.texts[0] === "noise") process.stdout.write("null\\nnot-json\\n");
  const vectors = request.texts[0] === "wrong-count" ? [] : request.texts.map(() => vector);
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, vectors }) + "\\n");
  }, request.texts[0] === "slow" ? 100 : 0);
});
`, "utf8");
  chmodSync(fakePython, 0o755);
  writeFileSync(join(root, "bge_worker.py"), "# fake worker path marker\n", "utf8");
  writeFileSync(join(model, "tokenizer.json"), "{}\n", "utf8");
  writeFileSync(join(model, "onnx", "model_int8.onnx"), "fake", "utf8");
  writeFileSync(join(root, "profile.json"), `${JSON.stringify({
    schema: MEMORY_BGE_PROFILE_SCHEMA,
    providerId: BGE_SMALL_EN_V15_INT8_PROVIDER_ID,
    dimensions: BGE_SMALL_EN_V15_DIMENSIONS,
    modelId: BGE_SMALL_EN_V15_MODEL_ID,
    modelRevision: BGE_SMALL_EN_V15_MODEL_REVISION,
    modelSha256: BGE_SMALL_EN_V15_MODEL_SHA256,
    runtime: "test",
  })}\n`, "utf8");
  return root;
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

describe("BGE semantic provider", () => {
  it("fails closed to lexical mode when the pinned local INT8 tooling is not provisioned", () => {
    const provider = new BgeSmallEnV15Int8EmbeddingProvider({ toolingRoot: makeTempDir() });
    expect(provider.id).toBe(BGE_SMALL_EN_V15_INT8_PROVIDER_ID);
    expect(provider.dimensions).toBe(BGE_SMALL_EN_V15_DIMENSIONS);
    expect(provider.status()).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/friday setup memory/),
    });
  });

  it("keeps one warm worker during activity, unloads it after idle, and disposes explicitly", async () => {
    if (process.platform === "win32") return;
    const provider = new BgeSmallEnV15Int8EmbeddingProvider({
      toolingRoot: fakeBgeToolingRoot(),
      idleTimeoutMs: 25,
    });
    try {
      expect(provider.status()).toMatchObject({ ready: true, active: false });
      expect((await provider.embed("first document"))[0]).toBe(1);
      expect(provider.status()).toMatchObject({ ready: true, active: true });
      expect((await provider.embedQuery("second query"))[0]).toBe(1);
      expect(provider.status()).toMatchObject({ ready: true, active: true });
      await new Promise((resolveWait) => setTimeout(resolveWait, 80));
      expect(provider.status()).toMatchObject({ ready: true, active: false });
      await provider.embed("restart worker");
      expect(provider.status()).toMatchObject({ ready: true, active: true });
      provider.dispose();
      expect(provider.status()).toMatchObject({ ready: true, active: false });
    } finally {
      provider.dispose();
    }
  });

  it.skipIf(process.platform === "win32")("isolates replacement requests from a disposed worker and keeps pending inference alive past idle", async () => {
    const provider = new BgeSmallEnV15Int8EmbeddingProvider({ toolingRoot: fakeBgeToolingRoot(), idleTimeoutMs: 25 });
    try {
      await provider.embed("ready");
      const pending = expect(provider.embed("slow")).rejects.toThrow(/disposed/);
      provider.dispose();
      const replacement = provider.embed("slow");
      await pending;
      expect((await replacement)[0]).toBe(1);
      expect(provider.status().active).toBe(true);
      expect(await provider.embedBatch(Array.from({ length: 17 }, () => "document"))).toHaveLength(17);
    } finally {
      provider.dispose();
    }
  });

  it.skipIf(process.platform === "win32")("ignores protocol noise and rejects a wrong response count without poisoning later requests", async () => {
    const provider = new BgeSmallEnV15Int8EmbeddingProvider({ toolingRoot: fakeBgeToolingRoot() });
    try {
      expect((await provider.embed("noise"))[0]).toBe(1);
      await expect(provider.embedBatch(["wrong-count", "second"])).rejects.toThrow(/batch size/);
      expect((await provider.embed("healthy"))[0]).toBe(1);
    } finally {
      provider.dispose();
    }
  });

  it.skipIf(process.platform === "win32")("finishes inference in a one-shot process and exits without waiting for idle", () => {
    const root = fakeBgeToolingRoot();
    const moduleUrl = new URL("../dist/bge.js", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { BgeSmallEnV15Int8EmbeddingProvider } from ${JSON.stringify(moduleUrl)};
      const provider = new BgeSmallEnV15Int8EmbeddingProvider({ toolingRoot: ${JSON.stringify(root)} });
      const vector = await provider.embed("slow");
      console.log(vector[0]);
    `], { encoding: "utf8", timeout: 5_000 });
    expect(output.trim()).toBe("1");
  });
});

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

  it("keeps read-only recall from creating or mutating file-backed state", () => {
    const parent = makeTempDir();
    const missing = join(parent, "not-created", "memory");
    const emptyRead = new MemoryStore({
      stateDir: missing,
      scope: "global",
      readOnly: true,
      embeddingProvider: null,
    });
    expect(emptyRead.list("memory")).toEqual([]);
    expect(existsSync(join(parent, "not-created"))).toBe(false);
    expect(() => emptyRead.create("memory", { title: "blocked", content: "blocked" })).toThrow(/read-only/);
    emptyRead.close();

    const dir = makeTempDir();
    const writable = new MemoryStore({ stateDir: dir, scope: "global", embeddingProvider: null });
    writable.create("memory", { id: "known", title: "Known", content: "durable" });
    writable.close();
    const database = new DatabaseSync(getMemoryStatePath(dir));
    database.exec("PRAGMA user_version = 3");
    database.close();

    const reader = new MemoryStore({ stateDir: dir, scope: "global", readOnly: true, embeddingProvider: null });
    expect(reader.get("memory", "known")?.content).toBe("durable");
    expect(() => reader.delete("memory", "known")).toThrow(/read-only/);
    reader.close();
    const reopened = new DatabaseSync(getMemoryStatePath(dir), { readOnly: true });
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    reopened.close();
    expect(version.user_version).toBe(3);
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

  it("upgrades schema-1 SQLite state for embedding storage without losing entries", async () => {
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
    expect(upgraded.search("adaptive sequence")).toEqual([]);
    expect(await upgraded.refreshEmbeddings()).toBe(1);
    expect(await upgraded.refreshEmbeddings()).toBe(0);
    expect((await upgraded.hybridSearch("adaptive sequence"))[0]).toMatchObject({
      entry: { id: "pscls" },
      matchedBy: "semantic",
    });
    expect(upgraded.get("memory", "pscls")?.content).toContain("learned chunks");

    const reopened = new DatabaseSync(getMemoryStatePath(dir), { readOnly: true });
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    reopened.close();
    expect(version.user_version).toBe(4);
  });

  it("migrates context-split relation identities into one semantic edge", () => {
    const dir = makeTempDir();
    const initialized = new MemoryStore({ stateDir: dir, scope: "global", embeddingProvider: null });
    initialized.snapshot();
    initialized.close();

    const database = new DatabaseSync(getMemoryStatePath(dir));
    database.exec("PRAGMA user_version = 3");
    const insert = database.prepare(`
      INSERT INTO memory_relations(
        id, scope, subject, predicate, object, context_json, source,
        confidence, occurrences, first_observed_at, last_observed_at, updated_at
      ) VALUES (?, 'global', 'user', 'usually_orders', 'biryani', ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "rel_legacy_a",
      JSON.stringify({ integration: "swiggy", item: "chicken" }),
      "legacy-a",
      0.7,
      2,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    insert.run(
      "rel_legacy_b",
      JSON.stringify({ integration: "swiggy", coupon: "SAVE" }),
      "legacy-b",
      0.9,
      3,
      "2026-01-03T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    );
    database.close();

    const upgraded = new MemoryStore({ stateDir: dir, scope: "global", embeddingProvider: null });
    const relations = upgraded.snapshot().relations ?? [];
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      subject: "user",
      predicate: "usually_orders",
      object: "biryani",
      source: "legacy-b",
      confidence: 0.9,
      occurrences: 5,
      first_observed_at: "2026-01-01T00:00:00.000Z",
      last_observed_at: "2026-01-04T00:00:00.000Z",
      context: { integration: "swiggy", item: "chicken", coupon: "SAVE" },
    });
    expect(relations[0]?.id).not.toBe("rel_legacy_a");
    expect(relations[0]?.id).not.toBe("rel_legacy_b");
    upgraded.close();

    const reopened = new DatabaseSync(getMemoryStatePath(dir), { readOnly: true });
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    reopened.close();
    expect(version.user_version).toBe(4);
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

  it("lists recent entries with a SQL-level bound", () => {
    const dir = makeTempDir();
    const state = createEmptyMemoryState();
    for (const [id, updated] of [["old", "2026-01-01T00:00:00.000Z"], ["mid", "2026-02-01T00:00:00.000Z"], ["new", "2026-03-01T00:00:00.000Z"]] as const) {
      state.entries.memory[id] = {
        id, kind: "memory", title: id, content: id, path: "review", scope: "global",
        reference: {}, arguments: {}, metadata: {}, source: "test",
        created_at: updated, updated_at: updated, version: 1,
      };
    }
    const store = new MemoryStore({ stateDir: dir, scope: "global", embeddingProvider: null });
    store.replaceState(state);
    expect(store.listRecent("memory", 2).map((entry) => entry.id)).toEqual(["new", "mid"]);
    expect(() => store.listRecent("memory", 201)).toThrow(/list limit/);
    store.close();
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

  it("supports partial updates and rejects stale optimistic corrections", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: null });
    const created = store.create("memory", {
      id: "patchable",
      title: "Original title",
      content: "Original content",
      path: "notes/original",
      metadata: { stable: true },
    });

    const updated = store.update("memory", "patchable", {
      content: "Corrected content",
      expectedVersion: created.version,
    });
    expect(updated).toMatchObject({
      title: "Original title",
      content: "Corrected content",
      path: "notes/original",
      metadata: { stable: true },
      version: 2,
    });

    expect(() => store.update("memory", "patchable", {
      path: "notes/stale",
      expectedVersion: created.version,
    })).toThrow(/changed concurrently/);
    expect(store.get("memory", "patchable")?.path).toBe("notes/original");
  });

  it("rejects secret-shaped durable notes at the Memory storage boundary", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: null });
    expect(() => store.create("memory", {
      id: "secret",
      title: "Credential",
      content: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
    })).toThrow(/secrets belong in Vault/);
    expect(store.get("memory", "secret")).toBeUndefined();

    store.create("memory", { id: "safe", title: "Safe", content: "ordinary durable note" });
    expect(() => store.update("memory", "safe", {
      metadata: { access_token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    })).toThrow(/secrets belong in Vault/);
    expect(() => store.update("memory", "safe", {
      metadata: { nested: [["api_key=sk-abcdefghijklmnopqrstuvwxyz123456"]] },
    })).toThrow(/secrets belong in Vault/);
    expect(store.get("memory", "safe")?.metadata).toEqual({});
  });

  it("keeps secret rejection intact across bulk replacement and refinement records", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global", embeddingProvider: null });
    const clean = store.snapshot();
    clean.entries.memory.leak = {
      id: "leak",
      kind: "memory",
      title: "Credential",
      content: "password=super-secret-value",
      path: "notes",
      scope: "global",
      reference: {},
      arguments: {},
      metadata: {},
      source: "test",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      version: 1,
    };
    expect(() => store.replaceState(clean)).toThrow(/secrets belong in Vault/);
    expect(() => store.recordRefinement("review", ["changed memory"], {
      evidence: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
    })).toThrow(/secrets belong in Vault/);
    expect(store.snapshot().refinements).toEqual([]);
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

  it("finds semantic-only matches and applies the same scope/kind/path filters", async () => {
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
    expect(await store.refreshEmbeddings()).toBe(2);

    const result = (await store.hybridSearch("adaptive sequence representation"))[0];
    expect(result).toMatchObject({ entry: { id: "pscls" }, matchedBy: "semantic" });
    expect(result?.semanticScore).toBeGreaterThan(0.99);
    expect(await store.hybridSearch("adaptive sequence", { kinds: ["prompt"] })).toEqual([]);
    expect(await store.hybridSearch("adaptive sequence", { pathPrefix: "projects/fr" })).toEqual([]);
    expect(await store.hybridSearch("adaptive sequence", { scope: "local" })).toEqual([]);
  });

  it("combines lexical and vector evidence and ignores stale vectors until explicit refresh", async () => {
    const store = new MemoryStore({
      stateDir: makeTempDir(),
      embeddingProvider: semanticTestProvider,
    });
    store.create("memory", {
      id: "changing",
      title: "Adaptive sequence",
      content: "Persistent learned chunks over byte primitives.",
    });
    expect(await store.refreshEmbeddings()).toBe(1);

    expect((await store.hybridSearch("adaptive sequence"))[0]).toMatchObject({
      entry: { id: "changing" },
      matchedBy: "hybrid",
    });

    store.update("memory", "changing", {
      title: "Archived note",
      content: "legacy marker",
    });
    expect(await store.hybridSearch("adaptive sequence")).toEqual([]);
    // The vector for version 1 is stale and must never be reused for version 2.
    expect(await store.hybridSearch("archive concept")).toEqual([]);
    expect(store.embeddingStatus()).toMatchObject({ readyEntries: 0, staleEntries: 1, missingEntries: 0 });
    expect(await store.refreshEmbeddings()).toBe(1);
    expect((await store.hybridSearch("archive concept"))[0]).toMatchObject({
      entry: { id: "changing" },
      matchedBy: "semantic",
    });

    expect(store.delete("memory", "changing")).toBe(true);
    expect(await store.hybridSearch("archive concept")).toEqual([]);
  });

  it("keeps durable entry mutations successful when neural embedding maintenance fails", async () => {
    const provider: MemoryEmbeddingProvider = {
      id: "throwing-v1",
      dimensions: 3,
      embed(text: string): Float32Array {
        if (text.includes("explode")) throw new Error("embedding failed");
        return new Float32Array([1, 0, 0]);
      },
    };
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: provider });

    store.create("memory", { id: "bad", title: "explode", content: "durable first" });
    expect(store.get("memory", "bad")).toMatchObject({ title: "explode", content: "durable first", version: 1 });
    await expect(store.refreshEmbeddings()).rejects.toThrow("embedding failed");
    expect(store.get("memory", "bad")).toMatchObject({ title: "explode", version: 1 });

    store.update("memory", "bad", { title: "explode again", content: "replacement persisted" });
    expect(store.get("memory", "bad")).toMatchObject({
      title: "explode again",
      content: "replacement persisted",
      version: 2,
    });
  });

  it("does not attach an asynchronously computed vector to a newer entry version", async () => {
    let release: ((value: Float32Array) => void) | undefined;
    const provider: MemoryEmbeddingProvider = {
      id: "delayed-v1",
      dimensions: 3,
      embed(): Promise<Float32Array> {
        return new Promise<Float32Array>((resolve) => { release = resolve; });
      },
    };
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: provider });
    store.create("memory", { id: "race", title: "Original", content: "version one" });
    const refreshing = store.refreshEmbedding("memory", "race");
    await Promise.resolve();
    store.update("memory", "race", { content: "version two" });
    release?.(new Float32Array([1, 0, 0]));
    expect(await refreshing).toBe(false);
    expect(store.embeddingStatus()).toMatchObject({ readyEntries: 0, staleEntries: 0, missingEntries: 1 });
    expect(store.get("memory", "race")?.version).toBe(2);
  });

  it("can disable embeddings for deterministic lexical-only callers", async () => {
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
    await expect(store.hybridSearch("byte")).resolves.toMatchObject([{ entry: { id: "pscls" }, matchedBy: "fts" }]);
    expect(store.embeddingStatus()).toMatchObject({ enabled: false, ready: false, totalEntries: 1, missingEntries: 1 });
  });

  it("uses a provider-specific query embedding path without mixing it with document embedding", async () => {
    let documentCalls = 0;
    let queryCalls = 0;
    const provider: MemoryEmbeddingProvider = {
      id: "query-aware-v1",
      dimensions: 3,
      embed(): Float32Array {
        documentCalls += 1;
        return new Float32Array([1, 0, 0]);
      },
      embedQuery(): Float32Array {
        queryCalls += 1;
        return new Float32Array([1, 0, 0]);
      },
    };
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: provider });
    store.create("memory", { id: "semantic", title: "Stored document", content: "different lexical words" });
    expect(await store.refreshEmbeddings()).toBe(1);
    expect(documentCalls).toBe(1);
    expect((await store.hybridSearch("unrelated query"))[0]).toMatchObject({
      entry: { id: "semantic" },
      matchedBy: "semantic",
    });
    expect(queryCalls).toBe(1);
  });

  it("reports missing, ready, and stale embedding maintenance state", async () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: semanticTestProvider });
    store.create("memory", { id: "one", title: "Adaptive sequence", content: "learned chunks" });
    expect(store.embeddingStatus()).toMatchObject({
      enabled: true, providerId: "test-semantic-v1", ready: true, totalEntries: 1, readyEntries: 0, staleEntries: 0, missingEntries: 1,
    });
    expect(await store.refreshEmbeddings()).toBe(1);
    expect(store.embeddingStatus()).toMatchObject({ readyEntries: 1, staleEntries: 0, missingEntries: 0 });
    store.update("memory", "one", { content: "legacy marker" });
    expect(store.embeddingStatus()).toMatchObject({ readyEntries: 0, staleEntries: 1, missingEntries: 0 });
    expect(await store.refreshEmbedding("memory", "one")).toBe(true);
    expect(store.embeddingStatus()).toMatchObject({ readyEntries: 1, staleEntries: 0, missingEntries: 0 });
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
    const second = store.observeRelation({
      ...observation,
      context: { integration: "swiggy", occasion: "weekend" },
      observedAt: "2026-08-21T12:00:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);
    expect(store.queryRelations({ query: "order the usual stuff" })[0]).toMatchObject({
      relation: { object: "biryani from RR Biryani", occurrences: 2 },
    });
    expect(store.queryRelations({ query: "same biryani" })[0]?.relation.context).toEqual({
      integration: "swiggy",
      occasion: "weekend",
      item: "chicken biryani",
    });
    store.close();

    const reopened = new MemoryStore({ stateDir: directory, scope: "global", embeddingProvider: null });
    expect(reopened.snapshot().relations).toHaveLength(1);
    expect(reopened.queryRelations({ minimumOccurrences: 2 })[0]?.relation.occurrences).toBe(2);
  });

  it("replaces relations atomically and merges into an already-known corrected edge", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global", embeddingProvider: null });
    const old = store.observeRelation({
      subject: "user",
      predicate: "prefers_editor",
      object: "vim",
      context: { evidence: "old" },
    });
    const corrected = store.replaceRelation(old.id, {
      object: "helix",
      expectedUpdatedAt: old.updated_at,
    });
    expect(corrected).toMatchObject({ subject: "user", predicate: "prefers_editor", object: "helix" });
    expect(store.getRelation(old.id)).toBeUndefined();
    expect(store.getRelation(corrected.id)?.object).toBe("helix");

    const first = store.observeRelation({
      subject: "project", predicate: "uses", object: "sqlite", context: { evidence: "old" },
    });
    const second = store.observeRelation({
      subject: "project", predicate: "uses", object: "postgres", context: { evidence: "confirmed" },
    });
    const merged = store.replaceRelation(first.id, {
      subject: second.subject,
      predicate: second.predicate,
      object: second.object,
      context: { corrected: true },
      expectedUpdatedAt: first.updated_at,
    });
    expect(store.getRelation(first.id)).toBeUndefined();
    expect(merged.id).toBe(second.id);
    expect(merged).toMatchObject({ object: "postgres", occurrences: 2 });
    expect(merged.context).toMatchObject({ evidence: "confirmed", corrected: true });
  });

  it("rolls back a relation replacement when insertion fails after deletion", () => {
    const database = new MemoryDatabase({ scope: "global", inMemory: true });
    const original = {
      id: "rel_original",
      scope: "global" as const,
      subject: "user",
      predicate: "uses",
      object: "sqlite",
      context: {},
      source: "test",
      confidence: 1,
      occurrences: 1,
      first_observed_at: "2026-01-01T00:00:00.000Z",
      last_observed_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    database.insertRelation(original);
    expect(() => database.replaceRelation(original.id, (existing) => ({
      ...existing,
      id: "rel_broken",
      context: { invalid: 1n } as unknown as Record<string, unknown>,
    }))).toThrow();
    expect(database.getRelation(original.id)).toEqual(original);
    expect(database.getRelation("rel_broken")).toBeUndefined();
    database.close();
  });

  it("rejects replacing a relation reviewed at a stale timestamp", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), scope: "global", embeddingProvider: null });
    const relation = store.observeRelation({ subject: "user", predicate: "uses", object: "zed" });
    expect(() => store.replaceRelation(relation.id, {
      object: "helix",
      expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
    })).toThrow(/changed concurrently/);
    expect(store.getRelation(relation.id)?.object).toBe("zed");
  });

  it("rejects secret-shaped graph context", () => {
    const store = new MemoryStore({ stateDir: makeTempDir(), embeddingProvider: null });
    expect(() => store.observeRelation({
      subject: "user",
      predicate: "uses",
      object: "service",
      context: { access_token: "must-not-persist" },
    })).toThrow(/secret/);
    expect(() => store.observeRelation({
      subject: "user",
      predicate: "uses",
      object: "service",
      context: { note: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456" },
    })).toThrow(/secrets belong in Vault/);
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
