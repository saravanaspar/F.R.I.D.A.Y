import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeEnvironment, prepareRuntimeWorkspace } from "../src/host/runtime-env.js";

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

  it("creates and enters the persisted dedicated workspace before plugin activation", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="UTC"',
      `FRIDAY_WORKSPACE=${JSON.stringify(join(tmpdir(), `friday-host-workspace-${process.pid}-${Date.now()}`))}`,
      "",
    ].join("\n"));
    const environment: NodeJS.ProcessEnv = { FRIDAY_HOME: home };
    await loadRuntimeEnvironment({ home, environment });
    const workspace = environment.FRIDAY_WORKSPACE!;
    roots.push(workspace);
    const previous = process.cwd();
    try {
      await expect(prepareRuntimeWorkspace(environment)).resolves.toBe(workspace);
      expect(process.cwd()).toBe(workspace);
    } finally {
      process.chdir(previous);
    }
  });

  it("rejects a workspace that overlaps protected FRIDAY state", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="UTC"',
      "",
    ].join("\n"));
    const environment: NodeJS.ProcessEnv = { FRIDAY_HOME: home, FRIDAY_WORKSPACE: join(home, "workspace") };
    await expect(prepareRuntimeWorkspace(environment)).rejects.toThrow(/must not overlap FRIDAY_HOME/);
  });

  it("rejects a workspace that reaches protected state through a symlinked parent", async () => {
    const home = await runtimeHome([
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-5"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="UTC"',
      "",
    ].join("\n"));
    const redirect = await mkdtemp(join(tmpdir(), "friday-workspace-redirect-"));
    roots.push(redirect);
    const linkedHome = join(redirect, "linked-home");
    await symlink(home, linkedHome, "dir");
    const environment: NodeJS.ProcessEnv = { FRIDAY_HOME: home, FRIDAY_WORKSPACE: join(linkedHome, "workspace") };
    await expect(prepareRuntimeWorkspace(environment)).rejects.toThrow(/after resolving filesystem links/);
  });
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
