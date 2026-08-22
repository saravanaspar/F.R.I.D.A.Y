import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSessionFile } from "../src/index.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "friday-session-delete-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session file deletion", () => {
  it("removes the session file and its artifact directory", async () => {
    const dir = root();
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir);
    const file = join(sessionsDir, "session-1.jsonl");
    writeFileSync(file, "{}\n");
    const artifacts = join(dir, "session-artifacts", "session-1");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "state.bin"), "data");

    const result = await deleteSessionFile(file);

    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(artifacts)).toBe(false);
  });

  it("runs the removal callback before deleting artifacts", async () => {
    const dir = root();
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir);
    const file = join(sessionsDir, "session-2.jsonl");
    writeFileSync(file, "{}\n");
    const artifacts = join(dir, "session-artifacts", "session-2");
    mkdirSync(artifacts, { recursive: true });

    let observed = false;
    await deleteSessionFile(file, {
      afterFileRemoved: () => {
        observed = !existsSync(file) && existsSync(artifacts);
      },
    });

    expect(observed).toBe(true);
  });
});
