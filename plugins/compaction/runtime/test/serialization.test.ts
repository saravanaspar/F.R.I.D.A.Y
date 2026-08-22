import { describe, expect, it } from "vitest";
import { convertToLlm, serializeConversation, type CompactionMessage } from "../src/index.js";

describe("summary serialization", () => {
  it("truncates long tool results", () => {
    const serialized = serializeConversation([
      {
        role: "toolResult",
        content: [{ type: "text", text: "x".repeat(3000) }],
        timestamp: Date.now(),
      },
    ]);
    expect(serialized).toContain("more characters truncated");
    expect(serialized.length).toBeLessThan(2300);
  });

  it("preserves assistant thinking, text, and tool calls", () => {
    const serialized = serializeConversation([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "text", text: "answer" },
          { type: "toolCall", name: "edit", arguments: { path: "a.ts" } },
        ],
        timestamp: Date.now(),
      },
    ]);
    expect(serialized).toContain("[Assistant thinking]: reason");
    expect(serialized).toContain("[Assistant]: answer");
    expect(serialized).toContain('edit(path="a.ts")');
  });

  it("converts branch and compaction summaries into user context", () => {
    const converted = convertToLlm([
      { role: "branchSummary", summary: "branch", fromId: "a", timestamp: Date.now() },
      { role: "compactionSummary", summary: "compact", tokensBefore: 10, timestamp: Date.now() },
    ]);
    expect(converted).toHaveLength(2);
    expect(JSON.stringify(converted)).toContain("branch");
    expect(JSON.stringify(converted)).toContain("compact");
  });

  it("skips command bookkeeping custom messages", () => {
    const messages: CompactionMessage[] = [
      {
        role: "custom",
        customType: "session_slash_command",
        content: "/compact",
        display: true,
        timestamp: Date.now(),
      },
      {
        role: "custom",
        customType: "useful_context",
        content: "keep this",
        display: true,
        timestamp: Date.now(),
      },
    ];
    const converted = convertToLlm(messages);
    expect(converted).toHaveLength(1);
    expect(JSON.stringify(converted[0])).toContain("keep this");
  });

  it("preserves bash output with a safe dynamic fence", () => {
    const converted = convertToLlm([
      {
        role: "bashExecution",
        command: "printf test",
        output: "```inside```",
        exitCode: 0,
        timestamp: Date.now(),
      },
    ]);
    expect(JSON.stringify(converted[0])).toContain("Ran `printf test`");
    expect(JSON.stringify(converted[0])).toContain("````");
  });
});
