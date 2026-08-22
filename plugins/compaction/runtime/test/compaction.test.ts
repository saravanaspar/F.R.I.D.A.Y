import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSummarizationPrompt,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
  type CompactionMessage,
  type CompactionSettings,
  type SessionEntry,
  type Usage,
} from "../src/index.js";

let counter = 0;
let lastId: string | null = null;

beforeEach(() => {
  counter = 0;
  lastId = null;
});

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

function user(text: string): CompactionMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string, tokenUsage = usage(100, 50)): CompactionMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: tokenUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function message(message: CompactionMessage): SessionEntry {
  const id = `entry-${counter++}`;
  const entry: SessionEntry = {
    type: "message",
    id,
    parentId: lastId,
    timestamp: new Date().toISOString(),
    message,
  };
  lastId = id;
  return entry;
}

function compaction(summary: string, firstKeptEntryId: string): SessionEntry {
  const id = `entry-${counter++}`;
  const entry: SessionEntry = {
    type: "compaction",
    id,
    parentId: lastId,
    timestamp: new Date().toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
  };
  lastId = id;
  return entry;
}

describe("summarization prompt", () => {
  it("keeps the structured summary format and persistent kernel note", () => {
    const prompt = buildSummarizationPrompt();
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Critical Context");
    expect(prompt).toContain("IPython kernel keeps running");
    expect(prompt).not.toContain("<user-instructions>");
  });

  it("includes custom focus instructions in a delimited block", () => {
    const prompt = buildSummarizationPrompt("remember the migration command");
    expect(prompt).toContain("<user-instructions>");
    expect(prompt).toContain("remember the migration command");
    expect(prompt.indexOf("</user-instructions>")).toBeLessThan(prompt.indexOf("IPython kernel"));
  });

  it("uses the iterative update template when a previous summary exists", () => {
    expect(buildSummarizationPrompt(undefined, "old summary")).toContain("existing summary provided");
  });
});

describe("token accounting", () => {
  it("uses provider totalTokens when present", () => {
    expect(calculateContextTokens({ ...usage(1, 2, 3, 4), totalTokens: 99 })).toBe(99);
  });

  it("falls back to usage components when totalTokens is zero", () => {
    expect(calculateContextTokens({ ...usage(1, 2, 3, 4), totalTokens: 0 })).toBe(10);
  });

  it("finds the last usable assistant usage", () => {
    const first = message(assistant("one", usage(10, 2)));
    const aborted = message({ ...assistant("two", usage(20, 3)), stopReason: "aborted" });
    expect(getLastAssistantUsage([first, aborted])?.input).toBe(10);
  });

  it("estimates trailing messages after the last provider usage", () => {
    const messages = [assistant("used", usage(100, 50)), user("12345678")];
    expect(estimateContextTokens(messages)).toEqual({
      tokens: 152,
      usageTokens: 150,
      trailingTokens: 2,
      lastUsageIndex: 0,
    });
  });

  it("estimates text and images conservatively", () => {
    expect(estimateTokens(user("12345678"))).toBe(2);
    expect(
      estimateTokens({
        role: "toolResult",
        content: [{ type: "image" }],
        timestamp: Date.now(),
      }),
    ).toBe(1200);
  });
});

describe("automatic trigger", () => {
  const settings: CompactionSettings = { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 };

  it("triggers above the reserve threshold", () => {
    expect(shouldCompact(95000, 100000, settings)).toBe(true);
    expect(shouldCompact(89000, 100000, settings)).toBe(false);
  });

  it("does not trigger when disabled", () => {
    expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
  });

  it("does not trigger when the model context window is unknown", () => {
    expect(shouldCompact(95000, 0, settings)).toBe(false);
  });
});

describe("cut points", () => {
  it("keeps everything when the recent budget covers the session", () => {
    const entries = [message(user("one")), message(assistant("two"))];
    expect(findCutPoint(entries, 0, entries.length, 50000).firstKeptEntryIndex).toBe(0);
  });

  it("never chooses a tool result as a cut point", () => {
    const entries = [
      message(user("start")),
      message(assistant("call".repeat(20))),
      message({ role: "toolResult", content: [{ type: "text", text: "result" }], timestamp: Date.now() }),
    ];
    const result = findCutPoint(entries, 0, entries.length, 1);
    expect((entries[result.firstKeptEntryIndex] as { type: string; message?: CompactionMessage }).message?.role).not.toBe(
      "toolResult",
    );
  });

  it("marks a mid-turn assistant cut as a split turn", () => {
    const entries = [
      message(user("turn one")),
      message(assistant("a")),
      message(user("turn two")),
      message(assistant("x".repeat(80))),
    ];
    const result = findCutPoint(entries, 0, entries.length, 5);
    expect(result.firstKeptEntryIndex).toBe(3);
    expect(result.turnStartIndex).toBe(2);
    expect(result.isSplitTurn).toBe(true);
  });
});

describe("preparation", () => {
  it("skips compaction when there is nothing old enough to summarize", () => {
    const entries = [message(user("hello")), message(assistant("hi", usage(5000, 1000)))];
    const context = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, context)).toBeUndefined();
  });

  it("carries the previous summary forward on repeated compaction", () => {
    const first = message(user("old"));
    message(assistant("old answer"));
    const kept = message(user("kept"));
    message(assistant("kept answer"));
    compaction("previous summary", kept.id);
    const current = message(user("new work"));
    const currentAssistant = message(assistant("new answer", usage(8000, 2000)));
    const entries = [first, ...([] as SessionEntry[])];
    void entries;
    const branch = [
      first,
      { type: "message", id: "entry-1", parentId: first.id, timestamp: new Date().toISOString(), message: assistant("old answer") },
      kept,
      { type: "message", id: "entry-3", parentId: kept.id, timestamp: new Date().toISOString(), message: assistant("kept answer") },
      { type: "compaction", id: "entry-4", parentId: "entry-3", timestamp: new Date().toISOString(), summary: "previous summary", firstKeptEntryId: kept.id, tokensBefore: 1000 },
      current,
      currentAssistant,
    ] as SessionEntry[];
    const resolved = [
      { role: "compactionSummary", summary: "previous summary", tokensBefore: 1000, timestamp: Date.now() },
      user("kept"),
      assistant("kept answer"),
      user("new work"),
      assistant("new answer", usage(8000, 2000)),
    ] as CompactionMessage[];
    const prepared = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS, resolved);
    expect(prepared?.previousSummary).toBe("previous summary");
    expect(prepared?.tokensBefore).toBe(estimateContextTokens(resolved).tokens);
  });
});
