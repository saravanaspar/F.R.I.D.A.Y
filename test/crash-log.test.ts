import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordFatalCrash } from "../src/crash-log.js";

const roots: string[] = [];
const originalFridayHome = process.env.FRIDAY_HOME;

afterEach(async () => {
  if (originalFridayHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalFridayHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fatal crash log", () => {
  it("persists a private redacted record before supervised restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-crash-log-"));
    roots.push(home);
    process.env.FRIDAY_HOME = home;

    recordFatalCrash("unit-test", new Error("token=super-secret-value Bearer abcdefghijklmnop"));

    const path = join(home, "logs", "crashes.ndjson");
    const info = await stat(path);
    expect(info.mode & 0o077).toBe(0);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ type: "friday.fatal-crash", operation: "unit-test", errorName: "Error" });
    expect(record.errorMessage).toContain("token=[REDACTED]");
    expect(record.errorMessage).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(record)).not.toContain("super-secret-value");
    expect(JSON.stringify(record)).not.toContain("abcdefghijklmnop");
  });
});
