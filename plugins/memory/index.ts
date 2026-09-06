import * as memory from "@friday/memory";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { AGENT_TOOL_CONTRIBUTION, type AgentExtensionJsonValue } from "../turn-loop/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { ownerStateRoot, principalScope } from "../principal-scope.js";
import { SYSTEM_ACTION_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { MEMORY_CAPABILITY, type MemoryOpenOptions, type MemoryService } from "./contract.js";
import { homedir } from "node:os";

function rootDir(): string {
  return process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday");
}

function stringValue(value: unknown, label: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function contextValue(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context must be a JSON object");
  return value as Record<string, unknown>;
}

function withGlobalStore<T>(ownerScope: string | undefined, operation: (store: InstanceType<typeof memory.MemoryStore>) => T): T {
  const store = new memory.MemoryStore({
    stateDir: memory.getGlobalMemoryStateDir(ownerStateRoot(rootDir(), ownerScope)),
    scope: "global",
    embeddingProvider: null,
  });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function withScopedStore<T>(
  scope: "global" | "local",
  sessionArtifactDir: string | undefined,
  ownerScope: string | undefined,
  operation: (store: InstanceType<typeof memory.MemoryStore>) => T,
): T {
  const stateDir = scope === "global"
    ? memory.getGlobalMemoryStateDir(ownerStateRoot(rootDir(), ownerScope))
    : memory.getLocalMemoryStateDir(sessionArtifactDir);
  if (!stateDir) throw new Error("Local memory requires a persistent session");
  const store = new memory.MemoryStore({ stateDir, scope, embeddingProvider: null });
  try { return operation(store); } finally { store.close(); }
}

const SECRET_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization)\b\s*[:=]\s*[^\s]{8,}|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}))+/i;

function assertNonSecretMemory(value: string, label: string): void {
  if (SECRET_TEXT.test(value)) throw new Error(`${label} appears to contain authentication material; secrets belong in Vault, not Memory`);
}

function safeMemoryContext(value: unknown): Record<string, unknown> | undefined {
  const context = contextValue(value);
  if (context === undefined) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(context); } catch { throw new Error("memory relation context must be JSON-serializable"); }
  if (serialized.length > 8_000) throw new Error("memory relation context exceeds 8000 characters");
  assertNonSecretMemory(serialized, "memory relation context");
  return context;
}

function memoryText(value: unknown, label: string, maximum = 24_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.replaceAll("\u0000", "\ufffd").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  assertNonSecretMemory(normalized, label);
  return normalized;
}

function memoryScope(value: unknown): "global" | "local" {
  if (value === undefined || value === "global") return "global";
  if (value === "local") return "local";
  throw new Error("scope must be global or local");
}

function projectKey(cwd: string): string {
  const name = basename(resolve(cwd)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const suffix = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 8);
  return `${name}-${suffix}`;
}

interface ProjectDoc { readonly path: string; readonly content: string; readonly headings: readonly string[]; }

function projectDocs(cwd: string): readonly ProjectDoc[] {
  const root = resolve(cwd);
  const results: ProjectDoc[] = [];
  let totalBytes = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 4 || results.length >= 64 || totalBytes >= 2 * 1024 * 1024) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= 64 || totalBytes >= 2 * 1024 * 1024) break;
      if ([".git", "node_modules", "vendor", "dist", "build", ".next", ".venv", "venv"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      const rel = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (depth === 0 && entry.name !== "docs" && entry.name !== ".github") continue;
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.md(?:own)?$/i.test(entry.name)) continue;
      if (depth === 0 && !/^(README|AGENTS|CONTRIBUTING|ARCHITECTURE|DESIGN|ROADMAP|SECURITY)(?:\.[^.]+)?\.md$/i.test(entry.name) && !/^(README|AGENTS)\.md$/i.test(entry.name)) continue;
      if (info.size > 128 * 1024 || totalBytes + info.size > 2 * 1024 * 1024) continue;
      const raw = readFileSync(path, "utf8").replaceAll("\u0000", "\ufffd");
      if (SECRET_TEXT.test(raw)) continue;
      totalBytes += Buffer.byteLength(raw);
      const content = raw.slice(0, 48_000);
      const headings = content.split(/\r?\n/).flatMap((line) => {
        const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
        return match ? [match[1]!.trim().slice(0, 240)] : [];
      }).slice(0, 64);
      results.push(Object.freeze({ path: rel, content, headings: Object.freeze(headings) }));
    }
  };
  visit(root, 0);
  return Object.freeze(results);
}

const memoryPlugin: FridayPlugin = definePlugin({
  id: "memory",
  optional: [PERMISSIONS_CAPABILITY],
  provides: [MEMORY_CAPABILITY],
}, (ctx) => {
  const service: MemoryService = Object.freeze({
    openStore(options: MemoryOpenOptions = {}) {
      return new memory.MemoryStore({
        ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.inMemory === undefined ? {} : { inMemory: options.inMemory }),
        ...(options.semanticSearch === false ? { embeddingProvider: null } : {}),
      });
    },
    globalStateDir: memory.getGlobalMemoryStateDir,
    localStateDir: memory.getLocalMemoryStateDir,
    statePath: memory.getMemoryStatePath,
    formatRelevant: memory.formatRelevantMemory,
    mergeStates: memory.mergeMemoryStates,
  });
  ctx.services.provide(MEMORY_CAPABILITY, service);

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "memory-recall",
    name: "memory_recall",
    label: "Recall durable memory",
    description: "Recall saved notes plus compact knowledge-graph relations. Use this when the user refers to something remembered earlier, a project decision, person/entity relationship, preference, habit, or 'the usual'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What preference, habit, person, place, item, or repeated action to recall" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, _signal, executionContext) {
      const query = stringValue(input.query, "query")!;
      const limit = typeof input.limit === "number" ? input.limit : 8;
      const global = withGlobalStore(executionContext?.ownerScope, (store) => ({
        notes: store.search(query, { kinds: ["memory"], limit }),
        relations: store.queryRelations({ query, limit }),
      }));
      const local = executionContext?.sessionArtifactDir
        ? withScopedStore("local", executionContext.sessionArtifactDir, executionContext.ownerScope, (store) => ({
            notes: store.search(query, { kinds: ["memory"], limit: Math.min(limit, 6) }),
            relations: store.queryRelations({ query, limit: Math.min(limit, 6) }),
          }))
        : { notes: [], relations: [] };
      return { output: { global, local } as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "memory-remember-note",
    name: "memory_remember",
    label: "Remember a durable note",
    description: "Persist a durable non-secret note when the user explicitly says to remember/note something, or when a durable project decision or follow-up fact clearly needs future recall. Do not use for transient tool output or casual chatter.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short descriptive note title" },
        content: { type: "string", description: "Durable fact, decision, project note, or future context to remember" },
        path: { type: "string", description: "Logical grouping such as projects/t-project or preferences" },
        scope: { type: "string", enum: ["global", "local"], description: "global survives across sessions; local belongs only to this project session" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    async execute(input, _signal, executionContext) {
      const title = memoryText(input.title, "memory title", 240);
      const content = memoryText(input.content, "memory content");
      const path = input.path === undefined ? "notes" : memoryText(input.path, "memory path", 240);
      const scope = memoryScope(input.scope);
      const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
      await permissions?.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "memory.remember", effect: "system-write", resource: `memory:${scope}:${path}`, network: false },
        reason: `remember durable ${scope} note: ${title}`,
      });
      const entry = withScopedStore(scope, executionContext?.sessionArtifactDir, executionContext?.ownerScope, (store) => store.upsert("memory", {
        title,
        content,
        path,
        source: "agent-explicit-memory",
        metadata: { rememberedBy: "agent", explicit: true },
      }));
      return { output: entry as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "memory-forget-note",
    name: "memory_forget",
    label: "Forget a saved note or relation",
    description: "Delete a specific saved memory note or graph relation when the user explicitly asks FRIDAY to forget it. Recall first if the exact id is unknown.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["note", "relation"] },
        scope: { type: "string", enum: ["global", "local"] },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    async execute(input, _signal, executionContext) {
      const id = memoryText(input.id, "memory id", 160);
      const kind = input.kind;
      if (kind !== "note" && kind !== "relation") throw new Error("kind must be note or relation");
      const scope = memoryScope(input.scope);
      const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
      await permissions?.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "memory.forget", effect: "system-write", resource: `memory:${scope}:${id}`, network: false },
        reason: `forget saved ${kind} ${id}`,
      });
      const deleted = withScopedStore(scope, executionContext?.sessionArtifactDir, executionContext?.ownerScope, (store) => kind === "note"
        ? store.delete("memory", id)
        : store.deleteRelation(id));
      return { output: { id, kind, scope, deleted } };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "memory-remember-relation",
    name: "memory_remember_relation",
    label: "Remember a knowledge relation",
    description: "Save or reinforce one compact non-secret knowledge-graph relation: preferences/habits, people/entities, project facts, decisions, document relationships, or repeated successful actions. Use memory_remember instead for richer prose.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Entity, project, document, person, or usually 'user'" },
        predicate: { type: "string", description: "Short relation such as prefers, uses, next_goal, contact_person, has_document, or decided" },
        object: { type: "string", description: "Related entity/value/action/document" },
        context: { type: "object", additionalProperties: true, description: "Optional non-secret repeat-action details" },
        scope: { type: "string", enum: ["global", "local"] },
      },
      required: ["subject", "predicate", "object"],
      additionalProperties: false,
    },
    async execute(input, _signal, executionContext) {
      const subject = memoryText(input.subject, "subject", 512);
      const predicate = memoryText(input.predicate, "predicate", 128);
      const object = memoryText(input.object, "object", 512);
      const scope = memoryScope(input.scope);
      const relationContext = safeMemoryContext(input.context);
      const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
      await permissions?.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext?.cwd ?? process.cwd(),
        access: "write",
        action: { id: "memory.relation.remember", effect: "system-write", resource: `memory:${scope}:graph`, network: false },
        reason: "remember a durable knowledge relation",
      });
      const relation = withScopedStore(scope, executionContext?.sessionArtifactDir, executionContext?.ownerScope, (store) => store.observeRelation({
        subject,
        predicate,
        object,
        ...(relationContext === undefined ? {} : { context: relationContext }),
        source: "agent-observation",
      }));
      return { output: relation as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "memory-index-project-docs",
    name: "memory_index_project_docs",
    label: "Index project Markdown knowledge",
    description: "Build/update a bounded project knowledge index from README/AGENTS and docs Markdown files in the current workspace. This indexes documentation and heading relations only, not the full codebase. Use when durable project documentation should be recallable later.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, signal, executionContext) {
      if (!executionContext) throw new Error("Project memory indexing requires an agent execution context");
      signal?.throwIfAborted();
      const docs = projectDocs(executionContext.cwd);
      const key = projectKey(executionContext.cwd);
      const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
      await permissions?.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: executionContext.cwd,
        access: "write",
        action: { id: "memory.project-docs.index", effect: "system-write", resource: `memory:project:${key}`, network: false },
        reason: `index bounded Markdown knowledge for project ${key}`,
      });
      const result = withGlobalStore(executionContext.ownerScope, (store) => {
        const manifestId = `project_${createHash("sha256").update(`${key}\0manifest`).digest("hex").slice(0, 24)}`;
        const previousManifest = store.get("memory", manifestId);
        const previousFilesRaw = previousManifest?.metadata.files;
        const previousFiles = previousFilesRaw && typeof previousFilesRaw === "object" && !Array.isArray(previousFilesRaw)
          ? previousFilesRaw as Record<string, unknown>
          : {};
        const currentFiles: Record<string, string> = {};
        let updated = 0;
        let unchanged = 0;
        let removed = 0;
        let relationChanges = 0;

        const deleteRelations = (subject: string, predicate?: string, object?: string): void => {
          const matches = store.queryRelations({
            subject,
            ...(predicate === undefined ? {} : { predicate }),
            ...(object === undefined ? {} : { object }),
            limit: 100,
          });
          for (const match of matches) {
            if (match.relation.source !== "project-doc-index") continue;
            if (store.deleteRelation(match.relation.id)) relationChanges += 1;
          }
        };

        for (const doc of docs) {
          signal?.throwIfAborted();
          const digest = createHash("sha256").update(doc.content).digest("hex");
          currentFiles[doc.path] = digest;
          if (previousFiles[doc.path] === digest) {
            unchanged += 1;
            continue;
          }
          const id = `project_${createHash("sha256").update(`${key}\0${doc.path}`).digest("hex").slice(0, 24)}`;
          const existed = typeof previousFiles[doc.path] === "string";
          if (existed) deleteRelations(`document:${key}:${doc.path}`, "has_heading");
          store.upsert("memory", {
            id,
            title: `${basename(executionContext.cwd)} · ${doc.path}`,
            content: doc.content,
            path: `projects/${key}/docs`,
            source: "project-documentation",
            metadata: {
              project: key,
              relativePath: doc.path,
              cwd: executionContext.cwd,
              contentSha256: digest,
              indexedAt: new Date().toISOString(),
            },
          });
          updated += 1;
          if (!existed) {
            store.observeRelation({ subject: `project:${key}`, predicate: "has_document", object: doc.path, context: { project: key }, source: "project-doc-index" });
            relationChanges += 1;
          }
          for (const heading of doc.headings) {
            store.observeRelation({ subject: `document:${key}:${doc.path}`, predicate: "has_heading", object: heading, context: { project: key }, source: "project-doc-index" });
            relationChanges += 1;
          }
        }

        for (const path of Object.keys(previousFiles)) {
          if (path in currentFiles) continue;
          signal?.throwIfAborted();
          const id = `project_${createHash("sha256").update(`${key}\0${path}`).digest("hex").slice(0, 24)}`;
          if (store.delete("memory", id)) removed += 1;
          deleteRelations(`document:${key}:${path}`, "has_heading");
          deleteRelations(`project:${key}`, "has_document", path);
        }

        store.upsert("memory", {
          id: manifestId,
          title: `${basename(executionContext.cwd)} · documentation index`,
          content: `Bounded documentation index for ${basename(executionContext.cwd)}.`,
          path: `projects/${key}/index`,
          source: "project-documentation-manifest",
          metadata: { project: key, cwd: executionContext.cwd, files: currentFiles, indexedAt: new Date().toISOString() },
        });
        return {
          project: key,
          documents: docs.length,
          updated,
          unchanged,
          removed,
          relationChanges,
          paths: docs.map((doc) => doc.path),
        };
      });
      return { output: result as unknown as AgentExtensionJsonValue };
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "memory.preferences",
    label: "User preferences and habits",
    description: "Query compact graph memory for preferences, habits, and repeated successful actions.",
    parameters: Object.freeze({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    }),
    permission() {
      return { id: "memory.preferences", effect: "private-read", resource: "memory:preferences", network: false };
    },
    execute(input, context) {
      const query = stringValue(input.query, "query", false);
      const limit = typeof input.limit === "number" ? input.limit : 20;
      return withGlobalStore(principalScope(context.turn.principal), (store) => store.queryRelations({ ...(query === undefined ? {} : { query }), limit }));
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "memory.review",
    label: "Review remembered information",
    description: "Show what FRIDAY remembers, including stable ids, scope, source, timestamps, and conflicting relation values that may need correction.",
    parameters: Object.freeze({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    }),
    permission() {
      return { id: "memory.review", effect: "private-read", resource: "memory:review", network: false };
    },
    execute(input, context) {
      const query = stringValue(input.query, "query", false)?.toLocaleLowerCase();
      const limit = typeof input.limit === "number" ? Math.max(1, Math.min(200, Math.trunc(input.limit))) : 100;
      return withGlobalStore(principalScope(context.turn.principal), (store) => {
        const notes = store.list("memory")
          .filter((entry) => !query || `${entry.title} ${entry.content} ${entry.path} ${entry.source}`.toLocaleLowerCase().includes(query))
          .slice(0, limit)
          .map((entry) => ({
            id: entry.id,
            title: entry.title,
            content: entry.content,
            path: entry.path,
            scope: entry.scope,
            source: entry.source,
            createdAt: entry.created_at,
            updatedAt: entry.updated_at,
            version: entry.version,
          }));
        const relations = (store.snapshot().relations ?? [])
          .filter((relation) => !query || `${relation.subject} ${relation.predicate} ${relation.object} ${relation.source}`.toLocaleLowerCase().includes(query))
          .slice(0, limit);
        const groups = new Map<string, typeof relations>();
        for (const relation of relations) {
          const key = `${relation.subject.trim().toLocaleLowerCase()}\u0000${relation.predicate.trim().toLocaleLowerCase()}`;
          groups.set(key, [...(groups.get(key) ?? []), relation]);
        }
        const conflicts = [...groups.values()]
          .filter((group) => new Set(group.map((relation) => relation.object.trim().toLocaleLowerCase())).size > 1)
          .map((group) => ({
            subject: group[0]!.subject,
            predicate: group[0]!.predicate,
            values: group.map((relation) => ({ id: relation.id, object: relation.object, source: relation.source, updatedAt: relation.updated_at })),
          }));
        return { notes, relations, conflicts, noteCount: notes.length, relationCount: relations.length };
      });
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "memory.correct",
    label: "Correct remembered information",
    description: "Replace one outdated memory note or relation by its exact id while preserving correction provenance.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["note", "relation"] },
        title: { type: "string" },
        content: { type: "string" },
        path: { type: "string" },
        subject: { type: "string" },
        predicate: { type: "string" },
        object: { type: "string" },
        context: { type: "object", additionalProperties: true },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    }),
    permission(input) {
      const id = stringValue(input.id, "id")!;
      return { id: "memory.correct", effect: "system-write", resource: `memory:correction:${id}`, network: false };
    },
    execute(input, context) {
      const id = memoryText(input.id, "memory id", 160);
      if (input.kind !== "note" && input.kind !== "relation") throw new Error("kind must be note or relation");
      return withGlobalStore(principalScope(context.turn.principal), (store) => {
        if (input.kind === "note") {
          const existing = store.get("memory", id);
          if (!existing) throw new Error(`Memory note not found: ${id}`);
          const corrected = store.update("memory", id, {
            title: memoryText(input.title, "title", 240),
            content: memoryText(input.content, "content"),
            path: input.path === undefined ? existing.path : memoryText(input.path, "path", 240),
            reference: existing.reference,
            arguments: existing.arguments,
            metadata: { ...existing.metadata, correctedAt: new Date().toISOString(), correctedFromSource: existing.source },
            source: "operator-correction",
          });
          return { kind: "note", replacedId: id, memory: corrected };
        }
        const previous = store.snapshot();
        const existing = (previous.relations ?? []).find((relation) => relation.id === id);
        if (!existing) throw new Error(`Memory relation not found: ${id}`);
        const relationContext = safeMemoryContext(input.context) ?? existing.context;
        try {
          if (!store.deleteRelation(id)) throw new Error(`Memory relation changed before correction: ${id}`);
          const corrected = store.observeRelation({
            subject: input.subject === undefined ? existing.subject : memoryText(input.subject, "subject", 512),
            predicate: input.predicate === undefined ? existing.predicate : memoryText(input.predicate, "predicate", 128),
            object: memoryText(input.object, "object", 512),
            context: { ...relationContext, correctedAt: new Date().toISOString(), correctedFromId: id, correctedFromSource: existing.source },
            source: "operator-correction",
          });
          return { kind: "relation", replacedId: id, memory: corrected };
        } catch (error) {
          store.replaceState(previous);
          throw error;
        }
      });
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "memory.preference.remember",
    label: "Remember preference",
    description: "Store or reinforce one non-secret user preference/habit relation.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        subject: { type: "string" }, predicate: { type: "string" }, object: { type: "string" },
        context: { type: "object", additionalProperties: true },
      },
      required: ["subject", "predicate", "object"],
      additionalProperties: false,
    }),
    permission() {
      return { id: "memory.preference.remember", effect: "system-write", resource: "memory:preferences", network: false };
    },
    execute(input: Readonly<SystemJsonObject>, context) {
      const relationContext = safeMemoryContext(input.context);
      return withGlobalStore(principalScope(context.turn.principal), (store) => store.observeRelation({
        subject: memoryText(input.subject, "subject", 512),
        predicate: memoryText(input.predicate, "predicate", 128),
        object: memoryText(input.object, "object", 512),
        ...(relationContext === undefined ? {} : { context: relationContext }),
        source: "system-action",
      }));
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "memory.preference.forget",
    label: "Forget preference",
    description: "Permanently delete one graph-memory preference or habit by the relation id returned by memory.preferences.",
    parameters: Object.freeze({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    }),
    permission(input) {
      const id = stringValue(input.id, "id")!;
      return { id: "memory.preference.forget", effect: "system-write", resource: `memory:relation:${id}`, network: false };
    },
    execute(input, context) {
      const id = stringValue(input.id, "id")!;
      return { id, deleted: withGlobalStore(principalScope(context.turn.principal), (store) => store.deleteRelation(id)) };
    },
  });
});

export default memoryPlugin;
