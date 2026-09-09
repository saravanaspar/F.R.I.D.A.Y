import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordSetupLog } from "../src/setup-log.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "friday-setup-log-"));
  roots.push(home);
  await chmod(home, 0o700);
  process.env.FRIDAY_HOME = home;
  return home;
}

describe("setup diagnostic log", () => {
  it("persists bounded private redacted setup failures for later diagnostics", async () => {
    const home = await tempHome();
    await recordSetupLog({
      component: "voice",
      operation: "provision chatterbox",
      outcome: "failure",
      message: "uv failed; api_key=SETUP_SECRET_SENTINEL; recent subprocess output: dependency conflict",
      durationMs: 1234,
    });

    const path = join(home, "logs", "setup.ndjson");
    const text = await readFile(path, "utf8");
    expect(text).toContain("provision chatterbox");
    expect(text).toContain("dependency conflict");
    expect(text).not.toContain("SETUP_SECRET_SENTINEL");
    expect(text).toContain("[REDACTED]");
    const info = await stat(path);
    if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
  });
});
