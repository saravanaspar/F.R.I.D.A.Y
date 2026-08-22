import { describe, expect, it } from "vitest";
import { normalizeDiscordHeartbeatInterval } from "../plugins/channels/runtime/src/transports/discord.js";
import { createEmptyMemoryState, mergeMemoryStates } from "../plugins/memory/runtime/src/state.js";
import { MemoryStore } from "../plugins/memory/runtime/src/store.js";
import type { MemoryEntry } from "../plugins/memory/runtime/src/types.js";
import { normalizedUrlHostname, stripTrailingSlashes, urlHostnameMatches } from "../plugins/model/runtime/src/providers/url-security.js";
import { extractJsonObject } from "../plugins/refinement/runtime/src/json.js";
import { validateRefinementEdit } from "../plugins/refinement/runtime/src/refinement.js";
import { parseSkillBlock } from "../plugins/skills/runtime/src/skill-blocks.js";
import { slugifyWorktreeName } from "../plugins/worktrees/runtime/src/worktrees.js";

describe("CodeQL security hardening", () => {
  it("matches provider hosts on parsed DNS-label boundaries", () => {
    expect(urlHostnameMatches("https://api.openai.com/v1", "api.openai.com")).toBe(true);
    expect(urlHostnameMatches("https://edge.api.openai.com/v1", "api.openai.com")).toBe(true);
    expect(urlHostnameMatches("https://api.openai.com.attacker.example/v1", "api.openai.com")).toBe(false);
    expect(urlHostnameMatches("https://api.openai.com@attacker.example/v1", "api.openai.com")).toBe(false);
    expect(urlHostnameMatches("https://evilopenrouter.ai.example/v1", "openrouter.ai")).toBe(false);
    expect(normalizedUrlHostname("javascript:alert(1)")).toBeUndefined();
    expect(urlHostnameMatches("https://api.openai.com./v1", "api.openai.com")).toBe(true);
  });

  it("trims URL slashes without a backtracking expression", () => {
    expect(stripTrailingSlashes("https://example.test/v1////")).toBe("https://example.test/v1");
    expect(stripTrailingSlashes("////")).toBe("");
  });

  it("bounds Discord heartbeat timers", () => {
    expect(normalizeDiscordHeartbeatInterval(41_250)).toBe(41_250);
    expect(normalizeDiscordHeartbeatInterval("45000")).toBe(45_000);
    expect(normalizeDiscordHeartbeatInterval(99)).toBeUndefined();
    expect(normalizeDiscordHeartbeatInterval(300_001)).toBeUndefined();
    expect(normalizeDiscordHeartbeatInterval(2_147_483_648)).toBeUndefined();
    expect(normalizeDiscordHeartbeatInterval(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("parses large skill blocks deterministically", () => {
    const content = "x".repeat(100_000);
    const parsed = parseSkillBlock(`<skill name="review" location="/tmp/review">\n${content}\n</skill>\n\nPlease run it`);
    expect(parsed).toEqual({
      name: "review",
      location: "/tmp/review",
      content,
      userMessage: "Please run it",
    });
    expect(parseSkillBlock('<skill name="bad" location="/tmp/x" extra="y">\nx\n</skill>')).toBeNull();
  });

  it("extracts large fenced JSON without regex backtracking", () => {
    const payload = JSON.stringify({ summary: "safe", rationale: "x".repeat(100_000), edits: [] });
    const parsed = extractJsonObject(`\`\`\`json\n${payload}\n\`\`\``) as { summary?: string };
    expect(parsed.summary).toBe("safe");
  });

  it("normalizes very long worktree punctuation runs in linear edge trimming", () => {
    expect(slugifyWorktreeName(`${"-".repeat(100_000)}Feature${"-".repeat(100_000)}`)).toBe("feature");
  });

  it("stores prototype-like relation-context keys as own data properties", () => {
    const store = new MemoryStore({ inMemory: true, embeddingProvider: null });
    try {
      const context: Record<string, unknown> = {};
      Object.defineProperty(context, "__proto__", {
        value: "safe",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      const relation = store.observeRelation({
        subject: "user",
        predicate: "prefers",
        object: "safe context",
        context,
      });
      expect(Object.hasOwn(relation.context, "__proto__")).toBe(true);
      expect(relation.context["__proto__"]).toBe("safe");
      expect(Object.getPrototypeOf(relation.context)).toBe(Object.prototype);
    } finally {
      store.close();
    }
  });

  it("snapshots database entries with prototype-like ids as own data properties", () => {
    const store = new MemoryStore({ inMemory: true, embeddingProvider: null });
    try {
      store.create("memory", {
        id: "__proto__",
        title: "Safe own property",
        content: "value",
      });
      const snapshot = store.snapshot();
      expect(Object.hasOwn(snapshot.entries.memory, "__proto__")).toBe(true);
      expect(snapshot.entries.memory["__proto__"]?.content).toBe("value");
      expect(Object.getPrototypeOf(snapshot.entries.memory)).toBe(Object.prototype);
    } finally {
      store.close();
    }
  });

  it("merges persisted prototype-like memory ids as own data properties", () => {
    const global = createEmptyMemoryState();
    const entry: MemoryEntry = {
      id: "__proto__",
      kind: "memory",
      title: "Safe own property",
      content: "value",
      path: "general",
      scope: "global",
      reference: {},
      arguments: {},
      metadata: {},
      source: "test",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      version: 1,
    };
    Object.defineProperty(global.entries.memory, "__proto__", {
      value: entry,
      writable: true,
      enumerable: true,
      configurable: true,
    });

    const merged = mergeMemoryStates(global);
    expect(Object.hasOwn(merged.entries.memory, "__proto__")).toBe(true);
    expect(merged.entries.memory["__proto__"]?.content).toBe("value");
    expect(Object.getPrototypeOf(merged.entries.memory)).toBe(Object.prototype);
  });

  it("rejects refinement ids that can alias object prototype properties", () => {
    for (const id of ["__proto__", "prototype", "constructor"]) {
      expect(
        validateRefinementEdit({ action: "create", kind: "memory", id, title: "Unsafe", content: "x" }, id),
      ).toBe("reserved refinement id");
    }
  });
});
