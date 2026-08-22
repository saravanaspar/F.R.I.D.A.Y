import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  buildSessionContext,
  loadEntriesFromFile,
  parseSessionEntries,
  type AssistantMessage,
  type UserMessage,
} from "../src/index.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function user(text: string, timestamp = Date.now()): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function assistant(text: string, timestamp = Date.now()): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionManager", () => {
  it("persists conversation history and restores it after reopen", () => {
    const root = tempDir("friday-sessions-persist-");
    const cwd = join(root, "project");
    const sessionsDir = join(root, "sessions");
    const session = SessionManager.create(cwd, sessionsDir);

    session.appendMessage(user("hello"));
    session.appendMessage(assistant("hi"));

    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeDefined();
    expect(existsSync(sessionFile!)).toBe(true);

    const restored = SessionManager.open(sessionFile!);
    expect(restored.getSessionId()).toBe(session.getSessionId());
    expect(restored.getCwd()).toBe(cwd);
    expect(restored.buildSessionContext().messages).toMatchObject([
      { role: "user" },
      { role: "assistant" },
    ]);
  });

  it("enforces private modes for custom session directories and transcript files", () => {
    const root = tempDir("friday-sessions-modes-");
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true, mode: 0o777 });
    chmodSync(sessionsDir, 0o777);

    const session = SessionManager.create(root, sessionsDir);
    session.appendMessage(user("private"));
    session.flushNow();
    const sessionFile = session.getSessionFile();

    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
    expect(sessionFile).toBeDefined();
    expect(statSync(sessionFile!).mode & 0o777).toBe(0o600);

    chmodSync(sessionFile!, 0o666);
    SessionManager.open(sessionFile!);
    expect(statSync(sessionFile!).mode & 0o777).toBe(0o600);
  });

  it("keeps abandoned history while resolving context from the active branch", () => {
    const session = SessionManager.inMemory("/tmp/project");
    const first = session.appendMessage(user("one"));
    const answer = session.appendMessage(assistant("one-answer"));
    const abandoned = session.appendMessage(user("abandoned"));

    session.branch(answer);
    const replacement = session.appendMessage(user("replacement"));

    expect(session.getEntry(abandoned)).toBeDefined();
    expect(session.getEntry(replacement)?.parentId).toBe(answer);
    expect(session.buildSessionContext().messages).toMatchObject([
      { role: "user", content: [{ text: "one" }] },
      { role: "assistant" },
      { role: "user", content: [{ text: "replacement" }] },
    ]);

    const tree = session.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.entry.id).toBe(first);
  });

  it("can reset to the root and create another root branch", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("original"));
    session.resetLeaf();
    const newRoot = session.appendMessage(user("new root"));

    expect(session.getEntry(newRoot)?.parentId).toBeNull();
    expect(session.getTree()).toHaveLength(2);
    expect(session.buildSessionContext().messages).toMatchObject([
      { role: "user", content: [{ text: "new root" }] },
    ]);
  });

  it("creates a new session containing only the selected branch", () => {
    const root = tempDir("friday-sessions-branch-");
    const sessionsDir = join(root, "sessions");
    const session = SessionManager.create(root, sessionsDir);
    session.appendMessage(user("u1"));
    const a1 = session.appendMessage(assistant("a1"));
    session.appendMessage(user("u2"));
    session.appendMessage(assistant("a2"));

    const originalFile = session.getSessionFile();
    const branchedFile = session.createBranchedSession(a1);

    expect(branchedFile).toBeDefined();
    expect(branchedFile).not.toBe(originalFile);
    expect(existsSync(branchedFile!)).toBe(true);
    expect(session.getHeader()?.parentSession).toBe(originalFile);
    expect(session.buildSessionContext().messages).toHaveLength(2);
  });

  it("stores branch summaries without generating them", () => {
    const session = SessionManager.inMemory();
    const root = session.appendMessage(user("before"));
    const summaryId = session.branchWithSummary(root, "abandoned branch summary");

    expect(session.getEntry(summaryId)).toMatchObject({
      type: "branch_summary",
      parentId: root,
      summary: "abandoned branch summary",
    });
    expect(session.buildSessionContext().messages.at(-1)).toMatchObject({
      role: "branchSummary",
      summary: "abandoned branch summary",
    });
  });

  it("projects a stored compaction summary into context without performing compaction", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old"));
    session.appendMessage(assistant("old answer"));
    const kept = session.appendMessage(user("keep me"));
    session.appendMessage(assistant("kept answer"));
    session.appendCompaction("summary text", kept, 500);
    session.appendMessage(user("after"));

    const context = session.buildSessionContext();
    expect(context.messages[0]).toMatchObject({
      role: "compactionSummary",
      summary: "summary text",
      tokensBefore: 500,
    });
    expect(context.messages.slice(1)).toMatchObject([
      { role: "user", content: [{ text: "keep me" }] },
      { role: "assistant" },
      { role: "user", content: [{ text: "after" }] },
    ]);
  });

  it("persists session names and lifecycle state", () => {
    const root = tempDir("friday-sessions-metadata-");
    const session = SessionManager.create(root, join(root, "sessions"));
    session.appendSessionInfo("Research");
    session.appendSessionState({ status: "archived" });

    const restored = SessionManager.open(session.getSessionFile()!);
    expect(restored.getSessionName()).toBe("Research");
    expect(restored.getSessionState()).toEqual({ status: "archived" });
  });

  it("lists persisted sessions for a working directory", async () => {
    const root = tempDir("friday-sessions-list-");
    const sessionsDir = join(root, "sessions");
    const session = SessionManager.create(root, sessionsDir);
    session.appendMessage(user("first message", 1000));
    session.appendMessage(assistant("answer", 2000));
    session.appendSessionInfo("Listed session");

    const listed = await SessionManager.list(root, sessionsDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: session.getSessionId(),
      cwd: root,
      name: "Listed session",
      messageCount: 2,
      firstMessage: "first message",
    });
  });

  it("skips malformed JSONL lines while preserving valid entries", () => {
    const content = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: "/tmp" }),
      "not-json",
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: user("hello"),
      }),
    ].join("\n");

    const entries = parseSessionEntries(content);
    expect(entries).toHaveLength(2);
    expect(buildSessionContext(entries.filter((entry) => entry.type !== "session"))).toMatchObject({
      messages: [{ role: "user" }],
    });
  });

  it("repairs an empty persisted file into a valid session header", () => {
    const root = tempDir("friday-sessions-empty-");
    const path = join(root, "empty.jsonl");
    writeFileSync(path, "");

    const session = SessionManager.open(path);
    session.flushNow();

    const loaded = loadEntriesFromFile(path);
    expect(loaded[0]).toMatchObject({ type: "session", version: 3 });
    expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0);
  });
});
