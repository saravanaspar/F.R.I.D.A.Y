import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRuntimeLease, isVerifiedLifecycleSuccessor } from "../src/runtime-coordination.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime coordination lifecycle authorization", () => {
  it("binds new runtime leases to the process birth identity when Linux exposes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-runtime-lease-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const release = await acquireRuntimeLease({ environment: { FRIDAY_HOME: home }, waitMs: 1_000 });
    try {
      const leaseDir = join(root, ".home-coordination", "runtime-leases");
      const entries = await readdir(leaseDir);
      expect(entries).toHaveLength(1);
      const lease = JSON.parse(await readFile(join(leaseDir, entries[0]!), "utf8")) as { birthId?: string };
      if (process.platform === "linux") expect(lease.birthId).toMatch(/^[a-f0-9-]{36}:[0-9]+$/);
    } finally {
      await release();
    }
  });

  it("never treats a lone restart-looking environment variable as concurrent-runtime authorization", async () => {
    await expect(isVerifiedLifecycleSuccessor({ FRIDAY_LIFECYCLE_RESTART_STATUS: "/tmp/not-enough.json" }))
      .rejects.toThrow("Incomplete lifecycle restart environment");
  });

  it("accepts only a private status record matching request, token, and this successor pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-runtime-coordination-"));
    roots.push(root);
    const path = join(root, "restart.json");
    const token = "test-successor-token";
    await writeFile(path, `${JSON.stringify({
      version: 1,
      requestId: "request-1",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      phase: "ready",
      predecessor: { pid: process.pid },
      successor: { pid: process.pid },
    })}\n`, { mode: 0o600 });

    await expect(isVerifiedLifecycleSuccessor({
      FRIDAY_LIFECYCLE_RESTART_STATUS: path,
      FRIDAY_LIFECYCLE_RESTART_REQUEST: "request-1",
      FRIDAY_LIFECYCLE_RESTART_TOKEN: token,
    })).resolves.toBe(true);

    await expect(isVerifiedLifecycleSuccessor({
      FRIDAY_LIFECYCLE_RESTART_STATUS: path,
      FRIDAY_LIFECYCLE_RESTART_REQUEST: "request-1",
      FRIDAY_LIFECYCLE_RESTART_TOKEN: "wrong-token",
    })).rejects.toThrow("does not authorize this successor process");
  });
});
