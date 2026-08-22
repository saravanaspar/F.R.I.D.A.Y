import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESTART_REQUEST_ID_ENV,
  RESTART_STATUS_PATH_ENV,
  RESTART_TOKEN_ENV,
  acknowledgeRestartFromEnvironment,
  acknowledgeTakeoverFromEnvironment,
  createCurrentProcessEnvironment,
  createCurrentProcessLaunchSpec,
  createLifecycleManager,
  installExecutionAccess,
  isRestartPredecessorAliveFromEnvironment,
  readRestartRecord,
  restartStatusPath,
  rejectTakeoverFromEnvironment,
  uninstallExecutionAccess,
  writeRestartRecord,
  type LifecycleProcessSnapshot,
  type RestartRecord,
} from "../src/index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "friday-lifecycle-"));
  tempDirs.push(directory);
  return directory;
}

function fakeProcess(overrides: Partial<LifecycleProcessSnapshot> = {}): LifecycleProcessSnapshot {
  return {
    pid: 100,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    argv: ["/usr/bin/node", "/repo/src/cli.ts", "serve", "--flag"],
    env: { KEEP: "yes", REMOVE: "old" },
    cwd: "/repo",
    ...overrides,
  };
}

function sampleRecord(overrides: Partial<RestartRecord> = {}): RestartRecord {
  return {
    version: 1,
    requestId: "request-1",
    tokenHash: "a".repeat(64),
    phase: "launching",
    predecessor: { pid: 100 },
    successor: undefined,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    message: undefined,
    ...overrides,
  };
}

afterEach(() => {
  uninstallExecutionAccess();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("current process environment", () => {
  it("discovers the project tsconfig for a tsx-launched replacement", () => {
    const root = tempDir();
    const entrypoint = join(root, "src", "cli.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "tsx"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(join(root, "node_modules", "tsx", "package.json"), "{}\n");
    expect(createCurrentProcessEnvironment({}, entrypoint, ["--import", "tsx"]).TSX_TSCONFIG_PATH).toBe(join(root, "tsconfig.json"));
  });

  it("preserves an explicit tsx config path", () => {
    expect(createCurrentProcessEnvironment({ TSX_TSCONFIG_PATH: "/custom/tsconfig.json" }, "/repo/src/cli.ts", ["tsx"]).TSX_TSCONFIG_PATH).toBe("/custom/tsconfig.json");
  });
});

describe("current process launch spec", () => {
  it("preserves the current runtime arguments before the resolved entrypoint", () => {
    expect(createCurrentProcessLaunchSpec(["resume", "123"], "/node", ["--import", "tsx"], "/repo/src/cli.ts")).toEqual({
      command: "/node",
      args: ["--import", "tsx", "/repo/src/cli.ts", "resume", "123"],
    });
  });

  it("resolves a relative entrypoint", () => {
    expect(createCurrentProcessLaunchSpec([], "/node", [], "src/cli.ts").args[0]).toBe(resolve("src/cli.ts"));
  });

  it("rejects a missing entrypoint", () => {
    expect(() => createCurrentProcessLaunchSpec([], "/node", [], "")).toThrow(/entrypoint/);
  });
});

describe("restart state", () => {
  it("uses a bounded request id as the restart status filename", () => {
    expect(restartStatusPath("/tmp/friday", "restart-1")).toBe(resolve("/tmp/friday/restarts/restart-1.json"));
  });

  it("rejects path-like restart request ids", () => {
    expect(() => restartStatusPath("/tmp/friday", "../escape")).toThrow(/request id/);
  });

  it("atomically writes restart state with private permissions", () => {
    const path = restartStatusPath(tempDir(), "request-1");
    writeRestartRecord(path, sampleRecord());
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ requestId: "request-1", phase: "launching" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("returns undefined for missing restart state", () => {
    expect(readRestartRecord(join(tempDir(), "missing.json"))).toBeUndefined();
  });

  it("fails closed on corrupt restart JSON", () => {
    const path = join(tempDir(), "bad.json");
    writeFileSync(path, "{broken");
    expect(() => readRestartRecord(path)).toThrow(/Invalid lifecycle restart state/);
  });

  it("fails closed on malformed restart records", () => {
    const path = join(tempDir(), "bad.json");
    writeFileSync(path, JSON.stringify({ version: 1, requestId: "x" }));
    expect(() => readRestartRecord(path)).toThrow(/malformed record/);
  });
});

describe("restart acknowledgement", () => {
  it("returns undefined when no restart environment is present", () => {
    expect(acknowledgeRestartFromEnvironment({ env: {}, pid: 200 })).toBeUndefined();
  });

  it("rejects a partial restart environment", () => {
    expect(() => acknowledgeRestartFromEnvironment({ env: { [RESTART_REQUEST_ID_ENV]: "x" }, pid: 200 })).toThrow(/Incomplete/);
  });

  it("rejects a wrong restart token", async () => {
    const stateDir = tempDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        capturedEnv = options?.env;
        return { pid: 200 };
      },
      isProcessAlive: () => false,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement({ timeoutMs: 50 })).rejects.toThrow(/exited before readiness/);
    expect(() => acknowledgeRestartFromEnvironment({ env: { ...capturedEnv, [RESTART_TOKEN_ENV]: "wrong" }, pid: 200 })).toThrow(/token mismatch/);
  });

  it("marks the exact successor ready and is idempotent", async () => {
    const stateDir = tempDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        capturedEnv = options?.env;
        return { pid: 200 };
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    const launched = manager.launchReplacement({ timeoutMs: 100 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    const ready = acknowledgeRestartFromEnvironment({ env: capturedEnv!, pid: 200, now: () => "2026-08-18T00:00:01.000Z" });
    expect(ready?.phase).toBe("ready");
    expect(acknowledgeRestartFromEnvironment({ env: capturedEnv!, pid: 200 })).toEqual(ready);
    await expect(launched).resolves.toMatchObject({ phase: "ready", successor: { pid: 200 } });
  });

  it("rejects acknowledgement from an unexpected successor pid", () => {
    const stateDir = tempDir();
    const path = restartStatusPath(stateDir, "request-1");
    writeRestartRecord(path, sampleRecord({ tokenHash: createHash("sha256").update("secret").digest("hex"), successor: { pid: 200 } }));
    expect(() => acknowledgeRestartFromEnvironment({
      env: {
        [RESTART_STATUS_PATH_ENV]: path,
        [RESTART_REQUEST_ID_ENV]: "request-1",
        [RESTART_TOKEN_ENV]: "secret",
      },
      pid: 201,
    })).toThrow(/expected successor 200/);
  });

  it("keeps the predecessor alive until the successor accepts full takeover", async () => {
    const stateDir = tempDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        capturedEnv = options?.env;
        return { pid: 200 };
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    const launched = manager.launchReplacement({ timeoutMs: 100 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    acknowledgeRestartFromEnvironment({ env: capturedEnv!, pid: 200 });
    await expect(launched).resolves.toMatchObject({ phase: "ready" });

    const takeover = manager.waitForTakeover("request-1", { timeoutMs: 100 });
    expect(isRestartPredecessorAliveFromEnvironment({ env: capturedEnv!, pid: 200 })).toBe(true);
    manager.releaseForTakeover("request-1");
    const accepted = acknowledgeTakeoverFromEnvironment({ env: capturedEnv!, pid: 200 });
    expect(accepted?.phase).toBe("accepted");
    await expect(takeover).resolves.toMatchObject({ phase: "accepted", successor: { pid: 200 } });
  });

  it("lets the successor reject takeover so the waiting predecessor can recover", async () => {
    const stateDir = tempDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        capturedEnv = options?.env;
        return { pid: 200 };
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    const launched = manager.launchReplacement({ timeoutMs: 100 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    acknowledgeRestartFromEnvironment({ env: capturedEnv!, pid: 200 });
    await launched;
    const takeover = manager.waitForTakeover("request-1", { timeoutMs: 100 });
    const rejected = rejectTakeoverFromEnvironment({ env: capturedEnv!, pid: 200, error: new Error("post-start gate failed") });
    expect(rejected?.phase).toBe("failed");
    await expect(takeover).rejects.toThrow(/post-start gate failed/);
  });

  it("detects a successor that dies after readiness but before takeover", async () => {
    const stateDir = tempDir();
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let alive = true;
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        capturedEnv = options?.env;
        return { pid: 200 };
      },
      isProcessAlive: () => alive,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    const launched = manager.launchReplacement({ timeoutMs: 100 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    acknowledgeRestartFromEnvironment({ env: capturedEnv!, pid: 200 });
    await launched;
    alive = false;
    await expect(manager.waitForTakeover("request-1", { timeoutMs: 100 })).rejects.toThrow(/exited before takeover/);
    expect(manager.readRestart("request-1")?.phase).toBe("failed");
  });
});

describe("replacement launch", () => {
  it("retires an accepted successor when the predecessor cannot finish handoff", async () => {
    const stateDir = tempDir();
    const terminated: number[] = [];
    installExecutionAccess({
      async launchDetachedProcess() { throw new Error("not used"); },
      isProcessAlive: (pid) => pid === 200,
      terminateProcess: (pid) => { terminated.push(pid); },
    });
    writeRestartRecord(restartStatusPath(stateDir, "request-1"), sampleRecord({
      phase: "accepted",
      successor: { pid: 200 },
    }));
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), now: () => "2026-08-18T00:00:02.000Z" });

    await expect(manager.retireReplacement("request-1", "final reply failed")).resolves.toMatchObject({
      phase: "failed",
      message: "final reply failed",
    });
    expect(terminated).toEqual([200]);
    expect(readRestartRecord(restartStatusPath(stateDir, "request-1"))?.phase).toBe("failed");
  });

  it("fails clearly when execution access is not installed", async () => {
    const manager = createLifecycleManager({ stateDir: tempDir(), process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement()).rejects.toThrow(/execution access is not installed/);
  });

  it("launches a detached copy of the current CLI with restart-only environment", async () => {
    const stateDir = tempDir();
    let command = "";
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv | undefined;
    let cwd = "";
    installExecutionAccess({
      async launchDetachedProcess(nextCommand, nextArgs, options) {
        command = nextCommand;
        args = nextArgs;
        env = options?.env;
        cwd = options?.cwd ?? "";
        queueMicrotask(() => acknowledgeRestartFromEnvironment({ env: env!, pid: 200 }));
        return { pid: 200 };
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    await expect(manager.launchReplacement({ args: ["resume"], env: { REMOVE: undefined, EXTRA: "yes" } })).resolves.toMatchObject({ phase: "ready" });
    expect(command).toBe("/usr/bin/node");
    expect(args).toEqual(["--import", "tsx", "/repo/src/cli.ts", "resume"]);
    expect(cwd).toBe("/repo");
    expect(env?.KEEP).toBe("yes");
    expect(env?.REMOVE).toBeUndefined();
    expect(env?.EXTRA).toBe("yes");
    expect(env?.[RESTART_REQUEST_ID_ENV]).toBe("request-1");
    expect(env?.[RESTART_TOKEN_ENV]).toBe("secret");
  });

  it("supports acknowledgement that races ahead of the parent spawn publication", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess(_command, _args, options) {
        acknowledgeRestartFromEnvironment({ env: options!.env!, pid: 200 });
        return { pid: 200 };
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement()).resolves.toMatchObject({ phase: "ready", successor: { pid: 200 } });
  });

  it("marks spawn failures as failed without losing the error", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess() {
        throw new Error("spawn denied");
      },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement()).rejects.toThrow("spawn denied");
    expect(manager.readRestart("request-1")?.phase).toBe("failed");
    expect(manager.readRestart("request-1")?.message).toMatch(/spawn denied/);
  });

  it("marks a successor that exits before acknowledgement as failed", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess() { return { pid: 200 }; },
      isProcessAlive: () => false,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    await expect(manager.launchReplacement()).rejects.toThrow(/exited before readiness/);
    expect(manager.readRestart("request-1")?.phase).toBe("failed");
  });

  it("times out a live successor that never acknowledges readiness", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess() { return { pid: 200 }; },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    await expect(manager.launchReplacement({ timeoutMs: 5 })).rejects.toThrow(/Timed out/);
    expect(manager.readRestart("request-1")?.phase).toBe("failed");
  });

  it("rejects a duplicate request id rather than overwriting prior restart state", async () => {
    const stateDir = tempDir();
    const path = restartStatusPath(stateDir, "request-1");
    writeRestartRecord(path, sampleRecord());
    installExecutionAccess({
      async launchDetachedProcess() { return { pid: 200 }; },
      isProcessAlive: () => true,
    });
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement()).rejects.toThrow(/already exists/);
    expect(readRestartRecord(path)).toEqual(sampleRecord());
  });

  it("rejects concurrent replacement launches from one manager", async () => {
    const stateDir = tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    installExecutionAccess({
      async launchDetachedProcess() {
        await gate;
        return { pid: 200 };
      },
      isProcessAlive: () => false,
    });
    let sequence = 0;
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => `request-${++sequence}`, tokenFactory: () => "secret", pollIntervalMs: 1 });
    const first = manager.launchReplacement();
    await expect(manager.launchReplacement()).rejects.toThrow(/already in progress/);
    release();
    await expect(first).rejects.toThrow(/exited before readiness/);
  });

  it("honors an already-aborted signal before creating restart state", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess() { throw new Error("should not launch"); },
      isProcessAlive: () => true,
    });
    const controller = new AbortController();
    controller.abort();
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement({ signal: controller.signal })).rejects.toThrow();
    expect(manager.readRestart("request-1")).toBeUndefined();
  });

  it("marks a post-spawn cancellation as failed", async () => {
    const stateDir = tempDir();
    installExecutionAccess({
      async launchDetachedProcess() { return { pid: 200 }; },
      isProcessAlive: () => true,
    });
    const controller = new AbortController();
    const manager = createLifecycleManager({ stateDir, process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret", pollIntervalMs: 1 });
    const launched = manager.launchReplacement({ signal: controller.signal, timeoutMs: 100 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    controller.abort();
    await expect(launched).rejects.toThrow();
    expect(manager.readRestart("request-1")?.phase).toBe("failed");
  });

  it("rejects invalid timeout and poll interval configuration", async () => {
    expect(() => createLifecycleManager({ stateDir: tempDir(), pollIntervalMs: 0 })).toThrow(/poll interval/);
    const manager = createLifecycleManager({ stateDir: tempDir(), process: fakeProcess(), requestIdFactory: () => "request-1", tokenFactory: () => "secret" });
    await expect(manager.launchReplacement({ timeoutMs: 0 })).rejects.toThrow(/timeout/);
  });
});
