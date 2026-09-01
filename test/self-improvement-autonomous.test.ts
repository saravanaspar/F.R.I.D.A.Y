import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import {
  provideCapability,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import worktreesPlugin from "../plugins/worktrees/index.js";
import generationsPlugin from "../plugins/generations/index.js";
import autonomyPlugin from "../plugins/autonomy/index.js";
import selfImprovementPlugin from "../plugins/self-improvement/index.js";
import { AGENT_CAPABILITY } from "../plugins/agent/contract.js";
import { EVALUATION_CAPABILITY } from "../plugins/evaluation/contract.js";
import { GENERATIONS_CAPABILITY } from "../plugins/generations/contract.js";
import { LIFECYCLE_CAPABILITY } from "../plugins/lifecycle/contract.js";
import {
  activateFridayExecutable,
  describeFridayExecutable,
  removeFridayStagedExecutable,
  stageFridayExecutable,
} from "../plugins/lifecycle/runtime/src/active-executable.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { PROMPTS_CAPABILITY } from "../plugins/prompts/contract.js";
import { SELF_IMPROVEMENT_CAPABILITY } from "../plugins/self-improvement/contract.js";
import { SelfImprovementMissionStore } from "../plugins/self-improvement/mission-state.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import { TOOLS_CAPABILITY } from "../plugins/tools/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { SANDBOX_CAPABILITY } from "../plugins/sandbox/contract.js";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];
let previousStateDir: string | undefined;
const originalFridayHome = process.env.FRIDAY_HOME;
const originalSingleBinary = process.env.FRIDAY_SINGLE_BINARY;
const originalFridayVersion = process.env.FRIDAY_VERSION;

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (previousStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = previousStateDir;
  previousStateDir = undefined;
  if (originalFridayHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalFridayHome;
  if (originalSingleBinary === undefined) delete process.env.FRIDAY_SINGLE_BINARY;
  else process.env.FRIDAY_SINGLE_BINARY = originalSingleBinary;
  if (originalFridayVersion === undefined) delete process.env.FRIDAY_VERSION;
  else process.env.FRIDAY_VERSION = originalFridayVersion;
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function initRepository(): Promise<{ repository: string; baseCommit: string }> {
  const repository = await tempDir("friday-self-host-repo-");
  await execFileAsync("git", ["init"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "friday-test@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "FRIDAY Test"], { cwd: repository });
  const packageJson = {
    name: "friday-self-host-fixture",
    version: "1.0.0",
    private: true,
    scripts: { "build:binary": "node build-binary.mjs" },
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: packageJson.name, version: packageJson.version } },
  };
  await writeFile(join(repository, "baseline.txt"), "baseline\n");
  await writeFile(join(repository, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(join(repository, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);
  await writeFile(join(repository, "build-binary.mjs"), [
    'import { chmodSync, mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = join(process.cwd(), "build", "binary");',
    'mkdirSync(root, { recursive: true });',
    'const output = join(root, process.platform === "win32" ? "friday.exe" : "friday");',
    'const version = process.env.FRIDAY_BUILD_VERSION || "fixture";',
    'writeFileSync(output, `#!/usr/bin/env node\\nif (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(version)} + "\\\\n");\\n`, { mode: 0o700 });',
    'if (process.platform !== "win32") chmodSync(output, 0o700);',
    '',
  ].join("\n"));
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: repository });
  const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  return { repository, baseCommit };
}

function passingEvaluation(specs: readonly { id?: string; command: string; cwd: string; network?: boolean }[]) {
  const results = specs.map((spec, index) => {
    const preparation = spec.command.startsWith("npm ci") || spec.command === "npm run setup:execution-python";
    if (!preparation && !existsSync(join(spec.cwd, "autonomous-change.txt"))) {
      throw new Error(`gate ran before autonomous change existed in ${spec.cwd}`);
    }
    return {
      id: spec.id ?? `check-${index + 1}`,
      command: spec.command,
      status: "pass" as const,
      score: 1,
      exitCode: 0,
      exitText: "0",
      output: "ok",
      outputTruncated: false,
      durationMs: 1,
    };
  });
  return {
    results,
    summary: {
      total: results.length,
      passed: results.length,
      partial: 0,
      failed: 0,
      timedOut: 0,
      errors: 0,
      noScore: 0,
      scoreTotal: results.length,
      scored: results.length,
      averageScore: 1,
      durationMs: results.length,
    },
  };
}

async function installSelfHostingHarness(
  lifecycleMode: "ready" | "fail" | "takeover-fail",
  options: { failTrustedMountRegistration?: boolean } = {},
): Promise<{
  readonly launches: Array<{ readonly executable?: string; readonly args?: readonly string[] }>;
  readonly evaluations: Array<{ readonly id?: string; readonly command: string; readonly network?: boolean }>;
}> {
  const launches: Array<{ readonly executable?: string; readonly args?: readonly string[] }> = [];
  const evaluations: Array<{ readonly id?: string; readonly command: string; readonly network?: boolean }> = [];
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(sessionResourcesPlugin);
  await friday.activatePlugin(executionPlugin);

  provideCapability(EVALUATION_CAPABILITY, {
    api: {
      async runCommandEvaluation(spec: { id?: string; command: string; cwd?: string }) {
        return passingEvaluation([{ ...spec, cwd: spec.cwd ?? process.cwd() }]).results[0]!;
      },
      async runCommandEvaluationSuite(specs: readonly { id?: string; command: string; cwd: string; network?: boolean }[]) {
        evaluations.push(...specs.map((spec) => ({
          ...(spec.id === undefined ? {} : { id: spec.id }),
          command: spec.command,
          ...(spec.network === undefined ? {} : { network: spec.network }),
        })));
        return passingEvaluation(specs);
      },
    } as never,
  });
  await friday.activatePlugin(worktreesPlugin);
  await friday.activatePlugin(generationsPlugin);

  let activeCwd = "";
  class FakeAgent {
    readonly state = { messages: [] as unknown[] };
    #subscribers: Array<(event: { type: string; message: unknown }) => void> = [];

    subscribe(subscriber: (event: { type: string; message: unknown }) => void) {
      this.#subscribers.push(subscriber);
      return () => undefined;
    }

    async prompt(objective: string) {
      await writeFile(join(activeCwd, "autonomous-change.txt"), `${objective}\n`);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "candidate implemented" }],
        stopReason: "stop",
        usage: {},
      };
      this.state.messages.push(message);
      for (const subscriber of this.#subscribers) subscriber({ type: "message_end", message });
    }
  }

  provideCapability(AGENT_CAPABILITY, { api: { Agent: FakeAgent } as never });
  provideCapability(MODEL_CAPABILITY, {
    api: { getModel() { return { provider: "test", id: "model", reasoning: false }; } } as never,
  });
  provideCapability(PROMPTS_CAPABILITY, { api: { buildSystemPrompt() { return "system"; } } as never });
  provideCapability(SESSIONS_CAPABILITY, {
    api: {
      SessionManager: {
        create(cwd: string) {
          activeCwd = cwd;
          return {
            getSessionId() { return "session-test"; },
            getSessionFile() { return join(cwd, ".friday-session.jsonl"); },
            appendMessage() {},
          };
        },
      },
    } as never,
  });
  provideCapability(TOOLS_CAPABILITY, {
    api: {} as never,
    createTool(name: string) { return { name } as never; },
    createAllTools() { return {} as never; },
  });
  provideCapability(PERMISSIONS_CAPABILITY, {
    normalizeMode(value?: string) {
      return value === "auto" || value === "full" ? value : "ask";
    },
    async authorize() { return { allowed: true, approvedBy: "policy" }; },
    assertWorkspacePath(_workspace: string, path: string) { return path; },
  });
  provideCapability(SANDBOX_CAPABILITY, {
    sandboxKind: "podman",
    image: "test",
    assertAvailable() {},
    registerTrustedReadOnlyMount() {
      if (options.failTrustedMountRegistration) throw new Error("trusted mount registration failed");
      return () => {};
    },
    sandboxShell(request) { return { command: request.command, cwd: request.cwd, env: request.env }; },
    sandboxProcess(request) { return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
    sandboxKernel(request) { return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
  });
  provideCapability(LIFECYCLE_CAPABILITY, {
    api: {
      createLifecycleManager() {
        return {
          async launchReplacement(options?: { executable?: string; args?: readonly string[] }) {
            launches.push({
              ...(options?.executable === undefined ? {} : { executable: options.executable }),
              ...(options?.args === undefined ? {} : { args: options.args }),
            });
            if (lifecycleMode === "fail") throw new Error("replacement failed readiness");
            return { requestId: "restart-test", phase: "ready" };
          },
          async waitForTakeover() {
            if (lifecycleMode === "takeover-fail") {
              throw new Error("replacement exited before takeover acknowledgement");
            }
            return { requestId: "restart-test", phase: "accepted" };
          },
        };
      },
      describeFridayExecutable,
      stageFridayExecutable,
      activateFridayExecutable,
      removeFridayStagedExecutable,
      acknowledgeRestartFromEnvironment() {},
      acknowledgeTakeoverFromEnvironment() {},
      rejectTakeoverFromEnvironment() {},
      isRestartPredecessorAliveFromEnvironment() { return true; },
    } as never,
  });

  await friday.activatePlugin(autonomyPlugin);
  await friday.activatePlugin(selfImprovementPlugin);
  return { launches, evaluations };
}

describe("self-improvement autonomous composition", () => {
  it("abandons a new candidate if sandbox mount setup fails", async () => {
    const { repository } = await initRepository();
    const stateDir = await tempDir("friday-self-host-mount-failure-state-");
    const worktreeRoot = await tempDir("friday-self-host-mount-failure-worktrees-");
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    await installSelfHostingHarness("ready", { failTrustedMountRegistration: true });

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    await expect(
      service.selfImprove({
        objective: "fail before autonomous execution",
        cwd: repository,
        provider: "test",
        model: "model",
        gates: [{ command: "verify autonomous change" }],
        stateDir,
        worktreeRoot,
      }),
    ).rejects.toThrow(/trusted mount registration failed/);

    const selfManager = service.api.createSelfImprovementManager({ stateDir: join(stateDir, "self-improvement") });
    const candidate = selfManager.listCandidates()[0];
    expect(candidate?.status).toBe("abandoned");
    expect(candidate ? existsSync(candidate.directory) : true).toBe(false);
  });

  it("composes autonomous editing, promotion, handoff resume, verification, and cleanup", async () => {
    const { repository, baseCommit } = await initRepository();
    const stateDir = await tempDir("friday-self-host-state-");
    const worktreeRoot = await tempDir("friday-self-host-worktrees-");
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    await installSelfHostingHarness("ready");

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    const promoted = await service.selfImprove({
      objective: "add an autonomous change",
      cwd: repository,
      provider: "test",
      model: "model",
      gates: [{ id: "evidence", command: "verify autonomous change" }],
      stateDir,
      worktreeRoot,
    });

    expect(promoted.generationId).toBe("gen-000002");
    expect(promoted.commit).not.toBe(baseCommit);
    expect(await readFile(join(repository, "autonomous-change.txt"), "utf8")).toContain("add an autonomous change");
    expect(new SelfImprovementMissionStore(join(stateDir, "self-improvement")).get(promoted.candidateId)?.status).toBe("restarting");

    await service.resumeGeneration(promoted.generationId);

    const generations = requireCapability(GENERATIONS_CAPABILITY).api.createGenerationsManager({
      repository,
      stateDir: join(stateDir, "generations"),
    });
    expect(generations.getActiveGeneration()?.id).toBe(promoted.generationId);
    expect(new SelfImprovementMissionStore(join(stateDir, "self-improvement")).get(promoted.candidateId)?.status).toBe("completed");
    const selfManager = service.api.createSelfImprovementManager({ stateDir: join(stateDir, "self-improvement") });
    expect(selfManager.getCandidate(promoted.candidateId)?.status).toBe("promoted");
    expect(
      selfManager
        .listGenerationHandoffs()
        .find((handoff: { candidateId: string; status: string }) => handoff.candidateId === promoted.candidateId)
        ?.status,
    ).toBe("completed");
  });

  it("builds and hands off to a verified staged successor in single-binary mode", async () => {
    const { repository } = await initRepository();
    const stateDir = await tempDir("friday-self-binary-state-");
    const home = await tempDir("friday-self-binary-home-");
    const worktreeRoot = await tempDir("friday-self-binary-worktrees-");
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    process.env.FRIDAY_HOME = home;
    process.env.FRIDAY_SINGLE_BINARY = "1";
    process.env.FRIDAY_VERSION = "0.1.0";
    const harness = await installSelfHostingHarness("ready");

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    const promoted = await service.selfImprove({
      objective: "build a release-mode successor",
      cwd: repository,
      provider: "test",
      model: "model",
      gates: [{ id: "evidence", command: "verify autonomous change" }],
      stateDir,
      worktreeRoot,
    });

    const launch = harness.launches.at(-1);
    expect(launch?.executable).toBeTruthy();
    expect(launch?.executable).not.toBe(process.execPath);
    expect(launch?.executable).toContain(join(home, ".updates", "binaries", promoted.generationId));
    expect(existsSync(launch!.executable!)).toBe(true);
    expect(launch?.args).toContain("--resume-generation");

    const mission = new SelfImprovementMissionStore(join(stateDir, "self-improvement")).get(promoted.candidateId);
    expect(mission?.targetExecutable?.path).toBe(launch?.executable);
    expect(mission?.targetExecutable?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mission?.previousExecutable?.path).toBe(describeFridayExecutable(process.execPath).path);

    const preparation = harness.evaluations.filter((entry) => entry.command.startsWith("npm ci"));
    expect(preparation.length).toBeGreaterThanOrEqual(2);
    expect(preparation.every((entry) => entry.network === true)).toBe(true);
  }, 15_000);

  it("rolls back the promoted generation when replacement readiness fails", async () => {
    const { repository, baseCommit } = await initRepository();
    const stateDir = await tempDir("friday-self-host-rollback-state-");
    const worktreeRoot = await tempDir("friday-self-host-rollback-worktrees-");
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    await installSelfHostingHarness("fail");

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    await expect(
      service.selfImprove({
        objective: "change then fail restart",
        cwd: repository,
        provider: "test",
        model: "model",
        gates: [{ command: "verify autonomous change" }],
        stateDir,
        worktreeRoot,
      }),
    ).rejects.toThrow(/rolled back/);

    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    expect(head).toBe(baseCommit);
    expect(existsSync(join(repository, "autonomous-change.txt"))).toBe(false);
    const generations = requireCapability(GENERATIONS_CAPABILITY).api.createGenerationsManager({
      repository,
      stateDir: join(stateDir, "generations"),
    });
    expect(generations.getActiveGeneration()?.id).toBe("gen-000001");
    const selfManager = service.api.createSelfImprovementManager({ stateDir: join(stateDir, "self-improvement") });
    const candidate = selfManager.listCandidates()[0]!;
    expect(candidate.status).toBe("rolled-back");
    expect(selfManager.listGenerationHandoffs()[0]?.status).toBe("failed");
    expect(new SelfImprovementMissionStore(join(stateDir, "self-improvement")).get(candidate.id)?.status).toBe("rolled-back");
  });

  it("rolls back when a ready successor fails before full takeover", async () => {
    const { repository, baseCommit } = await initRepository();
    const stateDir = await tempDir("friday-self-host-takeover-state-");
    const worktreeRoot = await tempDir("friday-self-host-takeover-worktrees-");
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    await installSelfHostingHarness("takeover-fail");

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    await expect(
      service.selfImprove({
        objective: "change then fail takeover",
        cwd: repository,
        provider: "test",
        model: "model",
        gates: [{ command: "verify autonomous change" }],
        stateDir,
        worktreeRoot,
      }),
    ).rejects.toThrow(/rolled back/);

    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    expect(head).toBe(baseCommit);
    const generations = requireCapability(GENERATIONS_CAPABILITY).api.createGenerationsManager({
      repository,
      stateDir: join(stateDir, "generations"),
    });
    expect(generations.getActiveGeneration()?.id).toBe("gen-000001");
  });

  it("rolls back if durable self-improvement mission publication fails after promotion", async () => {
    const { repository, baseCommit } = await initRepository();
    const stateDir = await tempDir("friday-self-host-mission-state-");
    const worktreeRoot = await tempDir("friday-self-host-mission-worktrees-");
    const selfImprovementStateDir = join(stateDir, "self-improvement");
    await mkdir(selfImprovementStateDir, { mode: 0o700 });
    await mkdir(join(selfImprovementStateDir, "missions.json"), { mode: 0o700 });
    previousStateDir = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
    await installSelfHostingHarness("ready");

    const service = requireCapability(SELF_IMPROVEMENT_CAPABILITY);
    await expect(
      service.selfImprove({
        objective: "change with broken mission persistence",
        cwd: repository,
        provider: "test",
        model: "model",
        gates: [{ command: "verify autonomous change" }],
        stateDir,
        worktreeRoot,
      }),
    ).rejects.toThrow(/durable self-improvement mission could not be persisted|mission persistence failed/);

    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    expect(head).toBe(baseCommit);
    const generations = requireCapability(GENERATIONS_CAPABILITY).api.createGenerationsManager({
      repository,
      stateDir: join(stateDir, "generations"),
    });
    expect(generations.getActiveGeneration()?.id).toBe("gen-000001");
    const selfManager = service.api.createSelfImprovementManager({ stateDir: join(stateDir, "self-improvement") });
    expect(selfManager.listCandidates()[0]?.status).toBe("rolled-back");
  });
});
