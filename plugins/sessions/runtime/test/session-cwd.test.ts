import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSessionCwdExists,
  getMissingSessionCwdIssue,
  MissingSessionCwdError,
  SessionManager,
} from "../src/index.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "friday-session-cwd-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session cwd", () => {
  it("reports a stored cwd that no longer exists", () => {
    const dir = root();
    const missing = join(dir, "missing");
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: missing })}\n`);

    const session = SessionManager.open(file);
    expect(getMissingSessionCwdIssue(session, dir)).toEqual({
      sessionFile: file,
      sessionCwd: missing,
      fallbackCwd: dir,
    });
    expect(() => assertSessionCwdExists(session, dir)).toThrow(MissingSessionCwdError);
  });

  it("accepts an existing stored cwd", () => {
    const dir = root();
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd })}\n`);

    expect(getMissingSessionCwdIssue(SessionManager.open(file), dir)).toBeUndefined();
  });

  it("supports overriding the effective cwd when opening", () => {
    const dir = root();
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: "/missing" })}\n`);

    const session = SessionManager.open(file, undefined, dir);
    expect(session.getCwd()).toBe(dir);
  });
});
