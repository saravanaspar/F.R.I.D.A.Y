import { afterEach, describe, expect, it } from "vitest";
import {
  collectEntriesForBranchSummary,
  generateBranchSummary,
  installModelAccess,
  prepareBranchEntries,
  summarizeAndBranch,
  uninstallModelAccess,
  type CompactionMessage,
  type CompactionSessionPort,
  type SessionEntry,
} from "../src/index.js";

function message(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

class TreeSession implements CompactionSessionPort {
  entries: SessionEntry[] = [
    message("a", null, "root"),
    message("b", "a", "left one"),
    message("c", "b", "left two"),
    message("d", "a", "right one"),
  ];
  branchSummary?: { target: string | null; summary: string; details?: unknown };

  getEntry(id: string): SessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }
  getBranch(fromId = "c"): SessionEntry[] {
    const result: SessionEntry[] = [];
    let current = this.getEntry(fromId);
    while (current) {
      result.push(current);
      current = current.parentId ? this.getEntry(current.parentId) : undefined;
    }
    return result.reverse();
  }
  buildSessionContext(): { messages: CompactionMessage[] } {
    return { messages: [] };
  }
  appendCompaction(): string {
    return "unused";
  }
  branchWithSummary(target: string | null, summary: string, details?: unknown): string {
    this.branchSummary = { target, summary, details };
    return "branch-summary-entry";
  }
}

afterEach(() => uninstallModelAccess());

describe("branch summarization", () => {
  it("collects only the abandoned branch after the common ancestor", () => {
    const session = new TreeSession();
    const result = collectEntriesForBranchSummary(session, "c", "d");
    expect(result.commonAncestorId).toBe("a");
    expect(result.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  it("returns no entries when there was no previous leaf", () => {
    const session = new TreeSession();
    expect(collectEntriesForBranchSummary(session, null, "d").entries).toEqual([]);
  });

  it("keeps newest entries when a branch exceeds the token budget", () => {
    const entries = [message("a", null, "a".repeat(40)), message("b", "a", "b".repeat(40))];
    const prepared = prepareBranchEntries(entries, 10);
    expect(prepared.messages).toHaveLength(1);
    expect((prepared.messages[0] as { content?: unknown }).content).toBe("b".repeat(40));
  });

  it("generates a structured abandoned-branch summary", async () => {
    installModelAccess({
      async completeSimple() {
        return { content: [{ type: "text", text: "## Goal\nFinish branch" }], stopReason: "stop" };
      },
    });
    const result = await generateBranchSummary([message("a", null, "work")], {
      model: { contextWindow: 100000 },
      apiKey: "test",
      signal: new AbortController().signal,
    });
    expect(result.summary).toContain("explored a different conversation branch");
    expect(result.summary).toContain("## Goal");
  });

  it("returns an aborted result without persisting a summary", async () => {
    installModelAccess({
      async completeSimple() {
        return { content: [], stopReason: "aborted" };
      },
    });
    const result = await generateBranchSummary([message("a", null, "work")], {
      model: { contextWindow: 100000 },
      apiKey: "test",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ aborted: true });
  });

  it("summarizes and appends at the target branch point", async () => {
    installModelAccess({
      async completeSimple() {
        return { content: [{ type: "text", text: "branch summary" }], stopReason: "stop" };
      },
    });
    const session = new TreeSession();
    const result = await summarizeAndBranch(session, "c", "d", {
      model: { contextWindow: 100000 },
      apiKey: "test",
      signal: new AbortController().signal,
    });
    expect(result.entryId).toBe("branch-summary-entry");
    expect(session.branchSummary?.target).toBe("d");
    expect(session.branchSummary?.summary).toContain("branch summary");
  });
});
