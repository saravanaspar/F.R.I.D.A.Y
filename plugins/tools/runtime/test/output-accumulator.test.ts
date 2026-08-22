import { chmodSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupStaleOutputFiles, OutputAccumulator } from "../src/output-accumulator.js";

describe("OutputAccumulator", () => {
  it("hard-caps persisted output and creates private temp files", async () => {
    const output = new OutputAccumulator({ maxBytes: 8, maxLines: 2, maxTotalBytes: 32, tempFilePrefix: "friday-bash-test" });
    expect(output.append(Buffer.from("0123456789abcdef"))).toBe(true);
    expect(output.append(Buffer.from("x".repeat(64)))).toBe(false);
    output.finish();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    await output.closeTempFile();

    expect(snapshot.fullOutputPath).toBeDefined();
    const path = snapshot.fullOutputPath!;
    try {
      expect(statSync(path).size).toBeLessThanOrEqual(32);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path).length).toBeLessThanOrEqual(32);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("removes only stale FRIDAY output files with the requested prefix", async () => {
    const name = `friday-bash-cleanup-test-${process.pid}-${Date.now()}.log`;
    const output = new OutputAccumulator({ maxBytes: 1, maxLines: 1, maxTotalBytes: 16, tempFilePrefix: name.replace(/\.log$/, "") });
    output.append(Buffer.from("abcdef"));
    output.finish();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    await output.closeTempFile();
    const actual = snapshot.fullOutputPath!;
    chmodSync(actual, 0o600);
    utimesSync(actual, new Date(0), new Date(0));
    try {
      const removed = await cleanupStaleOutputFiles({ prefix: name.replace(/\.log$/, ""), maxAgeMs: 1, now: Date.now() });
      expect(removed).toBe(1);
      expect(() => statSync(actual)).toThrow();
    } finally {
      rmSync(actual, { force: true });
    }
  });
});
