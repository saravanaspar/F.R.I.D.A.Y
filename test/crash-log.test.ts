import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("fingerprints consecutive crashes and marks a restart storm", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-crash-log-"));
    roots.push(home);
    process.env.FRIDAY_HOME = home;

    for (let index = 0; index < 5; index += 1) recordFatalCrash("same-operation", new Error("same failure"));

    const lines = (await readFile(join(home, "logs", "crashes.ndjson"), "utf8")).trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(new Set(records.map((record) => record.fingerprint)).size).toBe(1);
    expect(records.map((record) => record.consecutiveCount)).toEqual([1, 2, 3, 4, 5]);
    expect(records.at(-1)).toMatchObject({ restartStorm: true, consecutiveCount: 5 });
  });

  it("rotates a bounded crash log before appending the next record", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-crash-log-"));
    roots.push(home);
    process.env.FRIDAY_HOME = home;
    const logDir = join(home, "logs");
    await mkdir(logDir, { mode: 0o700 });
    const path = join(logDir, "crashes.ndjson");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, "x"), { mode: 0o600 });

    recordFatalCrash("rotation-test", new Error("bounded failure"));

    expect((await stat(`${path}.1`)).size).toBe(2 * 1024 * 1024);
    const current = (await readFile(path, "utf8")).trim();
    expect(JSON.parse(current)).toMatchObject({ operation: "rotation-test", consecutiveCount: 1 });
  });
});
