import { afterEach, describe, expect, it } from "vitest";
import {
  compactSession,
  compactSessionFile,
  installModelAccess,
  installSessionAccess,
  uninstallModelAccess,
  uninstallSessionAccess,
  type CompactionMessage,
  type CompactionSessionPort,
  type SessionEntry,
} from "../src/index.js";

class FakeSession implements CompactionSessionPort {
  entries: SessionEntry[] = [];
  appended: Array<{ summary: string; firstKeptEntryId: string; tokensBefore: number; customInstructions?: string }> = [];

  constructor() {
    this.add({ role: "user", content: "old request", timestamp: Date.now() });
    this.add({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    this.add({ role: "user", content: "new request", timestamp: Date.now() });
    this.add({
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(80) }],
      usage: { input: 950, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 980 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }

  private add(message: CompactionMessage): void {
    const previous = this.entries.at(-1)?.id ?? null;
    this.entries.push({
      type: "message",
      id: `e${this.entries.length + 1}`,
      parentId: previous,
      timestamp: new Date().toISOString(),
      message,
    });
  }

  getBranch(): SessionEntry[] {
    return this.entries.slice();
  }
  getEntry(id: string): SessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }
  buildSessionContext(): { messages: CompactionMessage[] } {
    return { messages: this.entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])) };
  }
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    _details?: unknown,
    _fromHook?: boolean,
    customInstructions?: string,
  ): string {
    this.appended.push({ summary, firstKeptEntryId, tokensBefore, customInstructions });
    return "compaction-entry";
  }
  branchWithSummary(): string {
    return "branch-entry";
  }
}

afterEach(() => {
  uninstallModelAccess();
  uninstallSessionAccess();
});

function installSummaryModel(): { calls: Array<{ reasoning?: string }> } {
  const calls: Array<{ reasoning?: string }> = [];
  installModelAccess({
    async completeSimple(_model, _context, options) {
      calls.push({ reasoning: options.reasoning });
      return { content: [{ type: "text", text: "generated summary" }], stopReason: "stop" };
    },
  });
  return { calls };
}

describe("session compaction coordinator", () => {
  it("does not compact below the automatic threshold", async () => {
    installSummaryModel();
    const session = new FakeSession();
    const result = await compactSession(session, {
      model: { contextWindow: 100000 },
      apiKey: "test",
      settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 5 },
    });
    expect(result).toBeUndefined();
    expect(session.appended).toHaveLength(0);
  });

  it("forces manual compaction and persists the generated entry", async () => {
    installSummaryModel();
    const session = new FakeSession();
    const result = await compactSession(session, {
      model: { contextWindow: 100000 },
      apiKey: "test",
      force: true,
      customInstructions: "focus on tests",
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 5 },
    });
    expect(result?.entryId).toBe("compaction-entry");
    expect(session.appended).toHaveLength(1);
    expect(session.appended[0].summary).toContain("generated summary");
    expect(session.appended[0].customInstructions).toBe("focus on tests");
  });

  it("passes reasoning level only to reasoning-capable models", async () => {
    const { calls } = installSummaryModel();
    const session = new FakeSession();
    await compactSession(session, {
      model: { contextWindow: 100000, reasoning: true },
      apiKey: "test",
      force: true,
      thinkingLevel: "high",
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 5 },
    });
    expect(calls.some((call) => call.reasoning === "high")).toBe(true);
  });

  it("can open and compact a session through the injected sessions port", async () => {
    installSummaryModel();
    const session = new FakeSession();
    installSessionAccess({ open: (path) => {
      expect(path).toBe("/tmp/session.jsonl");
      return session;
    } });
    const result = await compactSessionFile("/tmp/session.jsonl", {
      model: { contextWindow: 100000 },
      apiKey: "test",
      force: true,
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 5 },
    });
    expect(result?.entryId).toBe("compaction-entry");
  });
});
