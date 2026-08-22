import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeEnvironment } from "../src/host/runtime-env.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeHome(contents: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "friday-host-env-"));
  roots.push(home);
  await chmod(home, 0o700);
  await mkdir(join(home, "unused"), { mode: 0o700 });
  await writeFile(join(home, "runtime.env"), contents, { mode: 0o600 });
  return home;
}

describe("host runtime environment", () => {
  it("loads the onboarding timezone into the runtime process environment", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="Asia/Kolkata"',
      "",
    ].join("\n"));
    const environment: NodeJS.ProcessEnv = {};

    await loadRuntimeEnvironment({ home, environment });

    expect(environment.FRIDAY_TIMEZONE).toBe("Asia/Kolkata");
  });

  it("loads the saved self-improvement source repository into the runtime environment", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="UTC"',
      'FRIDAY_SELF_REPOSITORY="/srv/friday-source"',
      "",
    ].join("\n"));
    const environment: NodeJS.ProcessEnv = {};

    await loadRuntimeEnvironment({ home, environment });

    expect(environment.FRIDAY_SELF_REPOSITORY).toBe("/srv/friday-source");
  });

  it("rejects an invalid configured timezone before plugin activation", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_TIMEZONE="Mars/Olympus"',
      "",
    ].join("\n"));

    await expect(loadRuntimeEnvironment({ home, environment: {} }))
      .rejects.toThrow("Invalid IANA timezone");
  });
});
