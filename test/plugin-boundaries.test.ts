import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import alertsPlugin from "../plugins/alerts/index.js";
import artifactsPlugin from "../plugins/artifacts/index.js";
import computerPlugin from "../plugins/computer/index.js";
import auditPlugin from "../plugins/audit/index.js";
import diagnosticsPlugin from "../plugins/diagnostics/index.js";
import hostDoctorPlugin from "../plugins/host-doctor/index.js";
import hostPrivilegesPlugin from "../plugins/host-privileges/index.js";
import mcpPlugin from "../plugins/mcp/index.js";
import modelPlugin from "../plugins/model/index.js";
import observabilityPlugin from "../plugins/observability/index.js";
import permissionsPlugin from "../plugins/permissions/index.js";
import routingPlugin from "../plugins/routing/index.js";
import sandboxPlugin from "../plugins/sandbox/index.js";
import runtimeSettingsPlugin from "../plugins/runtime-settings/index.js";
import schedulerPlugin from "../plugins/scheduler/index.js";
import sessionJobsPlugin from "../plugins/session-jobs/index.js";
import selfImprovementPlugin from "../plugins/self-improvement/index.js";
import skillsPlugin from "../plugins/skills/index.js";
import systemPlugin from "../plugins/system/index.js";
import toolsPlugin from "../plugins/tools/index.js";
import turnLoopPlugin from "../plugins/turn-loop/index.js";
import voicePlugin from "../plugins/voice/index.js";
import { getPluginManifest } from "../plugins/capabilities/protocol.js";

const implementationPluginNames = ["session-resources", "sessions", "memory", "vault", "channels", "execution", "lifecycle", "evaluation", "worktrees", "generations", "self-improvement", "model", "refinement", "compaction", "autonomy", "subagents", "rlm", "prompts", "auth", "mcp", "agent", "tools", "skills", "voice"] as const;
const forbiddenSiblingPackageImport = /(?:from|import\()\s*["']@friday\/(?!operational-errors(?:["'/])|client-protocol(?:["'/])|execution-targets(?:["'/]))/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("plugin boundaries", () => {

  it("keeps session, agent, self-improvement, generation, and update policy outside lifecycle", async () => {
    const root = resolve("plugins/lifecycle/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(session-manager|agent-session|agent-loop|self-improvement|generations?|worktrees?|evaluation|scheduler|voice|update)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("promoteCandidate");
      expect(source, path).not.toContain("claimGenerationHandoff");
      expect(source, path).not.toContain("git worktree");
      expect(source, path).not.toContain("git merge");
      expect(source, path).not.toContain("runCommandEvaluation");
    }
  });

  it("keeps configured behavior declarative so config order is not orchestration", async () => {
    const config = JSON.parse(await readFile(resolve("friday.config.json"), "utf8")) as { plugins: string[] };
    expect(config.plugins[0]).toBe("./plugins/capabilities/index.ts");
    expect(config.plugins.indexOf("./plugins/agent/index.ts"))
      .toBeLessThan(config.plugins.indexOf("./plugins/model/index.ts"));
    expect(config.plugins.indexOf("./plugins/channels/index.ts"))
      .toBeLessThan(config.plugins.indexOf("./plugins/vault/index.ts"));
    for (const entrypoint of config.plugins.slice(1)) {
      const path = resolve(entrypoint.replace(/^\.\//, ""));
      const source = await readFile(path, "utf8");
      expect(source, path).toContain("definePlugin(");
      expect(
        source.includes(".services.provide(") || source.includes(".contribute("),
        `${path} must provide a service or contribute an extension`,
      ).toBe(true);
      expect(source, path).not.toContain("requireCapability(");
      expect(source, path).not.toContain("provideCapability(");
      expect(source, path).not.toContain("activeCapabilityRegistry(");

      const pluginRoot = resolve(path, "..");
      for (const pluginSourcePath of await sourceFiles(pluginRoot)) {
        if (pluginSourcePath.replaceAll("\\", "/").includes("/runtime/")) continue;
        const pluginSource = await readFile(pluginSourcePath, "utf8");
        expect(pluginSource, pluginSourcePath).not.toContain("requireCapability(");
        expect(pluginSource, pluginSourcePath).not.toContain("provideCapability(");
        expect(pluginSource, pluginSourcePath).not.toContain("activeCapabilityRegistry(");
      }
    }

    await expect(access(resolve("src/command-handler.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    const bootstrap = await readFile(resolve("src/bootstrap.ts"), "utf8");
    expect(bootstrap).not.toContain("registerCommand");
    expect(bootstrap).not.toMatch(/(?:from|import\()\s*["']\.\.\/plugins\//);
    const pluginProtocol = await readFile(resolve("src/plugin.ts"), "utf8");
    expect(pluginProtocol).not.toContain("registerCommand");
  });

  it("keeps cross-plugin APIs explicit, typed, and contract-only", async () => {
    const config = JSON.parse(await readFile(resolve("friday.config.json"), "utf8")) as { plugins: string[] };
    const configured = config.plugins
      .map((entry) => /^\.\/plugins\/([A-Za-z0-9._-]+)\/index\.ts$/.exec(entry)?.[1])
      .filter((name): name is string => Boolean(name));

    for (const pluginName of configured) {
      const pluginRoot = resolve(`plugins/${pluginName}`);
      if (pluginName !== "capabilities") {
        const contractPath = resolve(pluginRoot, "contract.ts");
        await expect(access(contractPath), `${pluginName} must expose a public contract.ts`).resolves.toBeUndefined();
        const contract = await readFile(contractPath, "utf8");
        expect(contract, contractPath).not.toMatch(/\breadonly\s+api\s*:/);
        expect(contract, contractPath).not.toMatch(/\bapi\s*:\s*typeof\s+import\s*\(/);
        expect(contract, contractPath).not.toMatch(/interface\s+\w+Service\s+extends\s+\w*Runtime\b/);
      }

      for (const path of await sourceFiles(pluginRoot)) {
        if (path.replaceAll("\\", "/").includes("/runtime/")) continue;
        const source = await readFile(path, "utf8");
        const siblingImports = [...source.matchAll(/(?:from|import\()\s*["']@friday\/([A-Za-z0-9._-]+)/g)]
          .map((match) => match[1]!)
          .filter((packageName) => packageName !== pluginName && packageName !== "operational-errors" && packageName !== "client-protocol" && packageName !== "execution-targets");
        expect(siblingImports, `${path} must consume sibling plugins through ../<plugin>/contract.ts`).toEqual([]);
      }
    }

    const memoryContract = await readFile(resolve("plugins/memory/contract.ts"), "utf8");
    expect(memoryContract).toContain("interface MemoryStoreService");
    expect(memoryContract).toContain("openStore(");
    expect(memoryContract).not.toContain("MemoryService {\n  readonly api");

    const selfImprovementRunner = await readFile(resolve("plugins/self-improvement/runner.ts"), "utf8");
    expect(selfImprovementRunner).toContain("plugins/*/contract.ts");
    expect(selfImprovementRunner).toContain("ctx.services.require/optional");
  });

  it("keeps operational-errors as a dependency-free utility package owned by Observability, not a plugin", async () => {
    await expect(access(resolve("plugins/operational-errors"))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(await readFile(resolve("packages/operational-errors/package.json"), "utf8")) as { name?: string };
    expect(manifest.name).toBe("@friday/operational-errors");

    const utility = await readFile(resolve("packages/operational-errors/src/index.ts"), "utf8");
    expect(utility).not.toContain("FridayPlugin");
    expect(utility).not.toContain("definePlugin");
    expect(utility).not.toMatch(/(?:from|import\()\s*["']\.\.\/\.\.\/plugins\//);

    const observability = await readFile(resolve("plugins/observability/index.ts"), "utf8");
    expect(observability).toContain('installOperationalErrorSink');
    expect(observability).toContain('@friday/operational-errors');
  });

  it("keeps Shared Agent Computer as a provider-neutral capability owner instead of duplicating execution, jobs, or platform providers", async () => {
    const contract = await readFile(resolve("plugins/computer/contract.ts"), "utf8");
    const service = await readFile(resolve("plugins/computer/service.ts"), "utf8");
    const entry = await readFile(resolve("plugins/computer/index.ts"), "utf8");

    expect(contract).toContain('defineCapability<ComputerService>("computer")');
    expect(contract).toContain("ComputerNodeAdapter");
    expect(contract).toContain("ScreenLease");
    expect(contract).toContain("ControlLease");
    expect(contract).toContain("WAITING_FOR_COMPUTER");
    expect(contract).toContain("ComputerExecutionBinding");
    expect(contract).toContain("ComputerNodeToolExecutionRequest");
    expect(contract).toContain("runTool?");
    expect(service).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:execution|session-jobs|tools|projects|vault|subagents)\//);
    expect(entry).toContain("SYSTEM_STATUS_CONTRIBUTION");
    expect(entry).toContain('id: "computer.takeover"');
    expect(entry).toContain('id: "computer.hand-back"');
    expect(entry).toContain('id: "computer.node.reset-managed"');

    const manifest = getPluginManifest(computerPlugin)!;
    expect(manifest.requires.map((capability) => capability.id)).toEqual(["events"]);
    expect(manifest.optional.map((capability) => capability.id)).toEqual([]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["computer"]);

    const toolsManifest = getPluginManifest(toolsPlugin)!;
    expect(toolsManifest.optional.map((capability) => capability.id)).toContain("computer");
    const turnLoopManifest = getPluginManifest(turnLoopPlugin)!;
    expect(turnLoopManifest.optional.map((capability) => capability.id)).toContain("computer");
    const projectsEntry = await readFile(resolve("plugins/projects/index.ts"), "utf8");
    expect(projectsEntry).not.toContain("COMPUTER_CAPABILITY");
  });

  it("keeps execution-targets as a provider-neutral shared package rather than a plugin", async () => {
    await expect(access(resolve("plugins/execution-targets"))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(await readFile(resolve("packages/execution-targets/package.json"), "utf8")) as { name?: string };
    expect(manifest.name).toBe("@friday/execution-targets");
    const source = await readFile(resolve("packages/execution-targets/src/index.ts"), "utf8");
    expect(source).not.toContain("FridayPlugin");
    expect(source).not.toContain("definePlugin");
    expect(source).not.toMatch(/(?:from|import\()\s*["']\.\.\/\.\.\/plugins\//);
  });

  it("keeps Voice behind generic artifact enrichment instead of coupling Channels or Turn Loop to speech providers", async () => {
    const voice = await readFile(resolve("plugins/voice/index.ts"), "utf8");
    expect(voice).toContain("ARTIFACT_INPUT_ENRICHMENT_CONTRIBUTION");
    expect(voice).toContain("VOICE_CAPABILITY");
    expect(voice).not.toMatch(/(?:from|import\()\s*["']\.\.\/channels\//);
    expect(voice).not.toMatch(/(?:from|import\()\s*["']\.\.\/turn-loop\//);

    const artifactsContract = await readFile(resolve("plugins/artifacts/contract.ts"), "utf8");
    expect(artifactsContract).toContain('defineContribution<ArtifactInputEnricher>("artifact.input-enrichment")');

    const channels = await readFile(resolve("plugins/channels/index.ts"), "utf8");
    const turnLoop = await readFile(resolve("plugins/turn-loop/index.ts"), "utf8");
    expect(channels).not.toMatch(/(?:openai|deepgram|elevenlabs).*transcri/i);
    expect(turnLoop).not.toMatch(/(?:openai|deepgram|elevenlabs).*transcri/i);
  });

  it("uses plain subsystem names instead of -runtime plugin identities", async () => {
    const pluginEntries = await readdir(resolve("plugins"), { withFileTypes: true });
    const suffixedDirectories = pluginEntries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("-runtime"))
      .map((entry) => entry.name);
    expect(suffixedDirectories).toEqual([]);

    const config = await readFile(resolve("friday.config.json"), "utf8");
    expect(config).not.toContain("-runtime");

    for (const pluginName of implementationPluginNames) {
      const packagePath = resolve(`plugins/${pluginName}/runtime/package.json`);
      const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { name?: string };
      expect(manifest.name, packagePath).toBe(`@friday/${pluginName}`);
    }
  });
  it("keeps implementation packages free of sibling FRIDAY dependencies except the dependency-free error reporter", async () => {
    for (const pluginName of implementationPluginNames) {
      const packagePath = resolve(`plugins/${pluginName}/runtime/package.json`);
      const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const fridayDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
        name.startsWith("@friday/") && name !== "@friday/operational-errors",
      );
      expect(fridayDependencies, packagePath).toEqual([]);
    }
  });

  it("keeps implementation source free of direct sibling imports except the dependency-free error reporter", async () => {
    for (const pluginName of implementationPluginNames) {
      const root = resolve(`plugins/${pluginName}/runtime/src`);
      for (const path of await sourceFiles(root)) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      }
    }
  });

  it("keeps MCP, OAuth, and session-resource implementations outside model", async () => {
    const files = (await sourceFiles(resolve("plugins/model/runtime/src"))).map((path) =>
      path.replaceAll("\\", "/"),
    );
    expect(files.some((path) => /\/mcp(?:\/|\.ts$)/.test(path))).toBe(false);
    expect(files.some((path) => /\/oauth(?:\/|\.ts$)/.test(path))).toBe(false);
    expect(files.some((path) => path.endsWith("/session-resources.ts"))).toBe(false);
  });

  it("keeps tools, skills, sessions, RLM, and policy implementations outside execution", async () => {
    const root = resolve("plugins/execution/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(files.some((path) => /\/(tools|skills|rlm|mcp|oauth)\//.test(path))).toBe(false);
    expect(files.some((path) => /\/(session-manager|session-action-store|session-file-actions|permissions|sandbox)\.ts$/.test(path))).toBe(false);
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("FRIDAY_LIFECYCLE_RESTART");
      expect(source, path).not.toContain("acknowledgeRestart");
      expect(source, path).not.toContain("RestartRecord");
    }
  });

  it("keeps orchestration, policy, persistence, and model behavior outside evaluation", async () => {
    const root = resolve("plugins/evaluation/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(session-manager|agent-session|agent-loop|model|provider|prompts?|memory|refinement|compaction|autonomy|scheduler|sandbox|permissions|worktree)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("buildSystemPrompt");
    }
  });

  it("keeps candidate policy, evaluation, orchestration, and process transport outside worktrees", async () => {
    const root = resolve("plugins/worktrees/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(self-improvement|candidate|promotion|evaluation|agent-session|agent-loop|session-manager|model|provider|prompts?|memory|refinement|compaction|autonomy|scheduler|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("runCommandEvaluation");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("promoteCandidate");
    }
  });

  it("keeps candidate policy, evaluation, restart, sessions, and model behavior outside generations", async () => {
    const root = resolve("plugins/generations/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(self-improvement|candidate|evaluation|promotion|handoff|session-manager|agent-session|agent-loop|model|provider|prompts?|memory|refinement|compaction|autonomy|scheduler|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("git worktree add");
      expect(source, path).not.toContain("git worktree remove");
      expect(source, path).not.toContain("promoteCandidate");
      expect(source, path).not.toContain("runCommandEvaluation");
      expect(source, path).not.toContain("restartGeneration");
      expect(source, path).not.toContain("process.exit");
      expect(source, path).not.toContain("process.kill");
      expect(source, path).not.toMatch(/\bspawn\s*\(/);
    }
  });

  it("keeps git transport, evaluator and generation implementations, sessions, and model behavior outside self-improvement", async () => {
    const root = resolve("plugins/self-improvement/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(git|promotion|checkpoint|handoff|session-manager|agent-session|agent-loop|model|provider|prompts?|refinement|scheduler|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("git worktree");
      expect(source, path).not.toContain("update-ref");
      expect(source, path).not.toContain("execCommand(");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("buildSystemPrompt");
      expect(source, path).not.toContain("restartGeneration");
      expect(source, path).not.toContain("process.exit");
      expect(source, path).not.toContain("process.kill");
      expect(source, path).not.toMatch(/\bspawn\s*\(/);
    }
  });

  it("keeps skills, RLM, sessions, policy, and transport implementations outside tools", async () => {
    const files = (await sourceFiles(resolve("plugins/tools/runtime/src"))).map((path) =>
      path.replaceAll("\\", "/"),
    );
    expect(files.some((path) => /\/(skills|rlm|mcp|oauth)\//.test(path))).toBe(false);
    expect(
      files.some((path) =>
        /\/(session-manager|session-action-store|session-file-actions|permissions|sandbox|proxy)\.ts$/.test(path),
      ),
    ).toBe(false);
  });

  it("keeps prompt composition, sessions, RLM, tools, and execution outside skills", async () => {
    const root = resolve("plugins/skills/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(files.some((path) => /\/(prompts?|rlm|tools?|sessions?)\//.test(path))).toBe(false);
    expect(
      files.some((path) =>
        /\/(agent-session|session-manager|session-action-store|session-file-actions|kernel|bash|ipython|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    const skillsSource = await readFile(resolve("plugins/skills/runtime/src/skills.ts"), "utf8");
    expect(skillsSource).not.toContain("formatSkillsForPrompt");
  });

  it("keeps refinement, prompts, sessions, model transport, and execution outside memory", async () => {
    const root = resolve("plugins/memory/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(refinement|prompts?|session-manager|agent-session|kernel|ipython|bash|model|provider|scheduler|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("completeSimple");
      expect(source, path).not.toContain("buildSystemPrompt");
      expect(source, path).not.toContain("createAgentSession");
      if (!path.endsWith("/bge.ts")) expect(source, path).not.toContain("node:child_process");
    }
  });

  it("keeps orchestration, RLM, scheduling, tools, and prompt generation outside sessions", async () => {
    const root = resolve("plugins/sessions/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(files.some((path) => /\/(rlm|subagents?|tools?|skills?|prompts?|scheduler|autonomy)\//.test(path))).toBe(false);
    expect(
      files.some((path) =>
        /\/(agent-session|session-action-store|cron-jobs|rlm-runtime|resource-loader|sdk)\.ts$/.test(path),
      ),
    ).toBe(false);

    const managerSource = await readFile(resolve("plugins/sessions/runtime/src/session-manager.ts"), "utf8");
    expect(managerSource).not.toContain("RLM_DEPTH");
    expect(managerSource).not.toContain("createAgentSession");
    expect(managerSource).not.toContain("runCompaction");
  });

  it("keeps persistence, sessions, orchestration, scheduling, tools, and execution outside refinement", async () => {
    const root = resolve("plugins/refinement/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(session-manager|agent-session|agent-loop|kernel|ipython|bash|cron-jobs|scheduler|tools|compaction|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("node:fs");
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("buildSystemPrompt");
    }
  });

  it("keeps sessions implementation, agent orchestration, tools, skills, RLM, and scheduling outside compaction", async () => {
    const root = resolve("plugins/compaction/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(session-manager|session-file-actions|agent-session|agent-loop|bash|ipython|skills|cron-jobs|scheduler|rlm-runtime|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("formatSkillsForPrompt");
    }
  });

  it("keeps agent orchestration, goals, scheduling, recursion, refinement, and process transport outside autonomy", async () => {
    const root = resolve("plugins/autonomy/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(agent-session|agent-loop|goals|cron-jobs|rlm-runtime|refinement|session-manager|bash|ipython|skills|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toMatch(/\bspawn\s*\(/);
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("classifyEvaluation");
      expect(source, path).not.toContain("runCommandEvaluation");
    }
  });

  it("keeps RLM transport, session implementation, tools, scheduling, and refinement outside subagents", async () => {
    const root = resolve("plugins/subagents/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(rlm-runtime|session-manager|agent-session|kernel|ipython|bash|cron-jobs|scheduler|refinement|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("host.request");
      expect(source, path).not.toContain("rlm.run");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
    }
  });

  it("keeps child lifecycle, kernel transport, sessions, tools, and orchestration outside RLM", async () => {
    const root = resolve("plugins/rlm/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(subagents?|session-manager|agent-session|agent-loop|kernel|ipython|bash|cron-jobs|scheduler|refinement|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("node:child_process");
    }
  });

  it("keeps discovery, model transport, sessions, and execution outside prompts", async () => {
    const root = resolve("plugins/prompts/runtime/src");
    const files = (await sourceFiles(root)).map((path) => path.replaceAll("\\", "/"));
    expect(
      files.some((path) =>
        /\/(skills|session-manager|agent-session|kernel|ipython|bash|model|provider|refinement|scheduler|sandbox|permissions)\.ts$/.test(path),
      ),
    ).toBe(false);

    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toContain("loadSkills(");
      expect(source, path).not.toContain("createAgentSession");
    }
  });

  it("keeps scheduler policy independent from autonomy, integrations, and process transport", async () => {
    const root = resolve("plugins/scheduler");
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:autonomy|channels|integrations|self-improvement|execution)\//);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("createAgentSession");
    }

    const entry = await readFile(resolve("plugins/scheduler/index.ts"), "utf8");
    expect(entry).toContain("TURN_EXECUTOR_CONTRIBUTION");
    expect(entry).toContain("SCHEDULED_ACTION_CONTRIBUTION");
    const manifest = getPluginManifest(schedulerPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual([
      "model",
      "permissions",
      "permissions.trusted",
    ]);
  });

  it("keeps event persistence and delivery independent from producers, routing, and execution", async () => {
    const root = resolve("plugins/events");
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:channels|scheduler|webhooks|routing|sessions|memory|model|agent|autonomy|integrations|execution)\//);
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("fetch(");
    }
  });

  it("keeps provider-specific APIs and secrets out of the generic integrations implementation", async () => {
    const root = resolve("plugins/integrations");
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/gmail|googleapis|slack|calendar\.events|microsoft graph/i);
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:auth|mcp|scheduler|autonomy)\//);
    }
    const implementation = await readFile(resolve("plugins/integrations/integrations.ts"), "utf8");
    expect(implementation).not.toContain("node:child_process");
    expect(implementation).not.toContain("fetch(");
    const entry = await readFile(resolve("plugins/integrations/index.ts"), "utf8");
    expect(entry).toContain("AGENT_TOOL_CONTRIBUTION");
    expect(entry).toContain('from "../turn-loop/contract.js"');
    expect(entry).not.toContain("AGENT_CAPABILITY");
    expect(entry).not.toContain("TURN_LOOP_CAPABILITY");
    expect(entry).not.toContain('from "../turn-loop/index.js"');
  });

  it("keeps Audit as an append-only integrity ledger separate from telemetry and policy", async () => {
    for (const path of await sourceFiles(resolve("plugins/audit"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:agent|autonomy|permissions|vault|events|observability|channels|scheduler|mcp|tools|execution|lifecycle)\//,
      );
    }

    const publicContract = await readFile(resolve("plugins/audit/contract.ts"), "utf8");
    const trustedContract = await readFile(resolve("plugins/audit/trusted-contract.ts"), "utf8");
    const store = await readFile(resolve("plugins/audit/store.ts"), "utf8");
    expect(publicContract).toContain("AUDIT_CAPABILITY");
    expect(publicContract).not.toContain("append(input");
    expect(publicContract).not.toMatch(/\b(clear|delete|remove|truncate)\s*\(/);
    expect(trustedContract).toContain("AUDIT_TRUSTED_CAPABILITY");
    expect(trustedContract).toContain("append(input");
    expect(store).not.toMatch(/\b(?:DELETE\s+FROM|UPDATE)\s+audit_records\b/i);

    const permissionsEntry = await readFile(resolve("plugins/permissions/index.ts"), "utf8");
    const permissionsPolicy = await readFile(resolve("plugins/permissions/policy.ts"), "utf8");
    expect(permissionsEntry).toContain("AUDIT_TRUSTED_CAPABILITY");
    expect(permissionsPolicy).not.toMatch(/audit\/(?:contract|trusted-contract)/);

    const auditManifest = getPluginManifest(auditPlugin)!;
    const permissionsManifest = getPluginManifest(permissionsPlugin)!;
    expect(auditManifest.provides.map((capability) => capability.id)).toContain("audit.trusted");
    expect(permissionsManifest.requires.map((capability) => capability.id)).toContain("audit.trusted");
  });

  it("keeps trusted Audit append access out of model-facing plugins", async () => {
    const modelFacingPlugins = [
      "agent", "autonomy", "routing", "compaction", "memory", "model", "prompts", "refinement",
      "rlm", "sessions", "skills", "subagents", "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      for (const path of await sourceFiles(resolve(`plugins/${pluginName}`))) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("AUDIT_CAPABILITY");
        expect(source, path).not.toContain("AUDIT_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/audit\/(?:contract|trusted-contract)/);
      }
    }
  });

  it("keeps trusted Permissions identity context out of model-facing plugins", async () => {
    const modelFacingPlugins = [
      "agent",
      "autonomy",
      "routing",
      "compaction",
      "memory",
      "model",
      "prompts",
      "refinement",
      "rlm",
      "sessions",
      "skills",
      "subagents",
      "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      const root = resolve(`plugins/${pluginName}`);
      for (const path of await sourceFiles(root)) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("PERMISSIONS_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/permissions\/trusted-contract/);
      }
    }

    for (const path of await sourceFiles(resolve("plugins/permissions"))) {
      const source = await readFile(path, "utf8");
      const normalized = path.replaceAll("\\", "/");
      if (normalized.endsWith("/plugins/permissions/index.ts")) {
        expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:routing|agent|tools|mcp)\//);
        expect(source, path).not.toMatch(/@friday\/channels|channels\/runtime/);
      } else {
        expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:channels|routing|agent|tools|mcp)\//);
      }
    }

    const permissionsEntry = await readFile(resolve("plugins/permissions/index.ts"), "utf8");
    expect(permissionsEntry).toContain("PERMISSIONS_CAPABILITY");
    expect(permissionsEntry).toContain("PERMISSIONS_TRUSTED_CAPABILITY");
    expect(permissionsEntry).toContain("CHANNELS_TRUSTED_CAPABILITY");
  });

  it("keeps the Vault implementation package behind its composition plugin", async () => {
    const pluginRoot = resolve("plugins");
    for (const path of await sourceFiles(pluginRoot)) {
      const normalized = path.replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      if (normalized.endsWith("/plugins/vault/index.ts")) {
        expect(source, path).toContain('from "@friday/vault"');
      } else {
        expect(source, path).not.toMatch(/(?:from|import\()\s*["']@friday\/vault["']/);
      }
    }
  });

  it("keeps trusted Vault access out of model-facing plugin code", async () => {
    const modelFacingPlugins = [
      "agent",
      "autonomy",
      "routing",
      "compaction",
      "memory",
      "model",
      "prompts",
      "refinement",
      "rlm",
      "sessions",
      "skills",
      "subagents",
      "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      const root = resolve(`plugins/${pluginName}`);
      for (const path of await sourceFiles(root)) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("VAULT_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/vault\/trusted-contract/);
      }
    }

    const vaultEntry = await readFile(resolve("plugins/vault/index.ts"), "utf8");
    expect(vaultEntry).toContain("VAULT_CAPABILITY");
    expect(vaultEntry).toContain("VAULT_TRUSTED_CAPABILITY");
  });

  it("keeps the Channels implementation package behind its composition plugin", async () => {
    const pluginRoot = resolve("plugins");
    for (const path of await sourceFiles(pluginRoot)) {
      const normalized = path.replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      if (normalized.endsWith("/plugins/channels/index.ts") || normalized.endsWith("/plugins/channels/contract.ts") || normalized.endsWith("/plugins/channels/trusted-contract.ts")) {
        expect(source, path).toContain('from "@friday/channels"');
      } else {
        expect(source, path).not.toMatch(/(?:from|import\()\s*["']@friday\/channels["']/);
      }
    }
  });

  it("keeps channel ingress separate from routing, sessions, memory, and model behavior", async () => {
    for (const path of await sourceFiles(resolve("plugins/channels"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:sessions|memory|model|agent|autonomy|integrations)\//);
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']@friday\/(?:sessions|memory|model|agent|autonomy)["']/);
    }
    const entry = await readFile(resolve("plugins/channels/index.ts"), "utf8");
    expect(entry).toContain("TURN_INGRESS_HOOK");
    expect(entry).toContain("SCHEDULED_ACTION_CONTRIBUTION");
    expect(entry).not.toContain("SCHEDULER_CAPABILITY");
    expect(entry).not.toContain("TURN_LOOP_CAPABILITY");
  });

  it("keeps trusted Channels access out of model-facing plugin code", async () => {
    const modelFacingPlugins = [
      "agent", "autonomy", "routing", "compaction", "memory", "model", "prompts", "refinement",
      "rlm", "sessions", "skills", "subagents", "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      for (const path of await sourceFiles(resolve(`plugins/${pluginName}`))) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("CHANNELS_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/channels\/trusted-contract/);
      }
    }
    const channelsEntry = await readFile(resolve("plugins/channels/index.ts"), "utf8");
    expect(channelsEntry).toContain("CHANNELS_CAPABILITY");
    expect(channelsEntry).toContain("CHANNELS_TRUSTED_CAPABILITY");
  });


  it("keeps Observability as telemetry rather than execution, policy, or audit authority", async () => {
    for (const path of await sourceFiles(resolve("plugins/observability"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:agent|autonomy|audit|permissions|vault|channels|scheduler|mcp|tools|execution|lifecycle)\//,
      );
      expect(source, path).not.toContain("PERMISSIONS_TRUSTED_CAPABILITY");
      expect(source, path).not.toContain("VAULT_TRUSTED_CAPABILITY");
    }

    const entry = await readFile(resolve("plugins/observability/index.ts"), "utf8");
    expect(entry).toContain("EVENTS_CAPABILITY");
    expect(entry).toContain("OBSERVABILITY_CAPABILITY");
    expect(entry).not.toContain("AGENT_CAPABILITY");
    expect(entry).not.toContain("PERMISSIONS_CAPABILITY");

    const modelRuntimeFiles = await sourceFiles(resolve("plugins/model/runtime/src"));
    for (const path of modelRuntimeFiles) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/\.\.\/observability\//);
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']@friday\/observability["']/);
    }
    const modelEntry = await readFile(resolve("plugins/model/index.ts"), "utf8");
    expect(modelEntry).toContain("OBSERVABILITY_CAPABILITY");

    const observabilityManifest = getPluginManifest(observabilityPlugin)!;
    const modelManifest = getPluginManifest(modelPlugin)!;
    expect(observabilityManifest.requires.map((capability) => capability.id)).toContain("events");
    expect(modelManifest.optional.map((capability) => capability.id)).toContain("observability");
    expect(modelManifest.provides.map((capability) => capability.id)).toEqual(["model", "model.registry"]);
  });

  it("keeps Webhooks as an inbound HTTP boundary instead of an orchestration plugin", async () => {
    for (const path of await sourceFiles(resolve("plugins/webhooks"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:agent|autonomy|channels|scheduler|integrations|mcp|model|sessions|memory)\//,
      );
    }
    const entry = await readFile(resolve("plugins/webhooks/index.ts"), "utf8");
    expect(entry).toContain("EVENTS_CAPABILITY");
    expect(entry).toContain("VAULT_TRUSTED_CAPABILITY");
    expect(entry).toContain("WEBHOOKS_TRUSTED_CAPABILITY");
  });

  it("keeps trusted Webhooks access out of model-facing plugin code", async () => {
    const modelFacingPlugins = [
      "agent", "autonomy", "routing", "compaction", "memory", "model", "prompts", "refinement",
      "rlm", "sessions", "skills", "subagents", "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      for (const path of await sourceFiles(resolve(`plugins/${pluginName}`))) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("WEBHOOKS_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/webhooks\/trusted-contract/);
      }
    }
  });

  it("keeps MCP transport sibling-independent and composed behind its plugin boundary", async () => {
    for (const path of await sourceFiles(resolve("plugins/mcp/runtime/src"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/\.\.\/(?:agent|routing|scheduler|vault|permissions|events)\//);
    }

    const entry = await readFile(resolve("plugins/mcp/index.ts"), "utf8");
    expect(entry).toContain("AUTH_CAPABILITY");
    expect(entry).toContain("EVENTS_CAPABILITY");
    expect(entry).toContain("OBSERVABILITY_CAPABILITY");
    expect(entry).toContain("PERMISSIONS_CAPABILITY");
    expect(entry).toContain("VAULT_CAPABILITY");
    expect(entry).toContain("VAULT_TRUSTED_CAPABILITY");
    expect(entry).toContain("MCP_CAPABILITY");
    expect(entry).toContain("MCP_TRUSTED_CAPABILITY");
    expect(entry).toContain("AGENT_TOOL_CONTRIBUTION");
    expect(entry).toContain('from "../turn-loop/contract.js"');
    expect(entry).not.toContain("AGENT_CAPABILITY");
    expect(entry).not.toContain("TURN_LOOP_CAPABILITY");
    expect(entry).not.toContain('from "../turn-loop/index.js"');
    expect(entry).not.toContain("ROUTING_CAPABILITY");
    expect(entry).not.toContain("SCHEDULER_CAPABILITY");
  });

  it("keeps trusted MCP credential and registration access out of model-facing plugins", async () => {
    const modelFacingPlugins = [
      "agent", "autonomy", "routing", "compaction", "memory", "model", "prompts", "refinement",
      "rlm", "sessions", "skills", "subagents", "tools",
    ];
    for (const pluginName of modelFacingPlugins) {
      for (const path of await sourceFiles(resolve(`plugins/${pluginName}`))) {
        const source = await readFile(path, "utf8");
        expect(source, path).not.toContain("MCP_TRUSTED_CAPABILITY");
        expect(source, path).not.toMatch(/mcp\/trusted-contract/);
      }
    }
  });

  it("declares MCP dependencies so config position does not orchestrate activation", () => {
    const manifest = getPluginManifest(mcpPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual([
      "auth",
      "events",
      "permissions",
      "vault",
      "vault.trusted",
    ]);
    expect(manifest.optional.map((capability) => capability.id).sort()).toEqual(["artifacts", "channels.trusted", "observability", "runtime-settings", "self-improvement"]);
  });

  it("keeps Routing as a classifier rather than an execution or mutation boundary", async () => {
    for (const path of await sourceFiles(resolve("plugins/routing"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:agent|autonomy|tools|vault|mcp|permissions|scheduler|webhooks|execution|lifecycle)\//,
      );
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toContain("fetch(");
      expect(source, path).not.toContain("createAgentSession");
      expect(source, path).not.toContain("store.create(");
      expect(source, path).not.toContain("store.update(");
      expect(source, path).not.toContain("store.upsert(");
      expect(source, path).not.toContain("store.delete(");
    }

    const entry = await readFile(resolve("plugins/routing/index.ts"), "utf8");
    expect(entry).toContain("EVENTS_CAPABILITY");
    expect(entry).toContain("MEMORY_CAPABILITY");
    expect(entry).toContain("MODEL_CAPABILITY");
    expect(entry).toContain("SESSIONS_CAPABILITY");
    expect(entry).not.toContain("CHANNELS_CAPABILITY");
    expect(entry).not.toContain("OBSERVABILITY_CAPABILITY");
    expect(entry).not.toContain("AGENT_CAPABILITY");
    expect(entry).not.toContain("TOOLS_CAPABILITY");
    expect(entry).not.toContain("VAULT_CAPABILITY");
    expect(entry).not.toContain("MCP_CAPABILITY");

    const manifest = getPluginManifest(routingPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual([
      "events",
      "memory",
      "model",
      "sessions",
    ]);
    expect(manifest.optional.map((capability) => capability.id)).toEqual(["model-credentials", "session-jobs"]);
  });

  it("keeps Turn Loop as a replaceable outer lifecycle over contracts and generic extension points", async () => {
    for (const path of await sourceFiles(resolve("plugins/turn-loop"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:channels|scheduler|webhooks|mcp|vault|integrations|lifecycle)\//,
      );
    }

    const core = await readFile(resolve("plugins/turn-loop/turn-loop.ts"), "utf8");
    expect(core).not.toContain('=== "scheduler"');
    expect(core).not.toContain('=== "system"');
    expect(core).toContain("options.executors()");

    const entry = await readFile(resolve("plugins/turn-loop/index.ts"), "utf8");
    expect(entry).toContain("TURN_EXECUTOR_CONTRIBUTION");
    expect(entry).toContain("TURN_INGRESS_HOOK");
    expect(entry).toContain("AGENT_TOOL_CONTRIBUTION");
    expect(entry).toContain("PERMISSIONS_TRUSTED_CAPABILITY");

    const turnContract = await readFile(resolve("plugins/turn-loop/contract.ts"), "utf8");
    expect(turnContract).toContain('defineContribution<AgentToolContribution>("agent.tool")');
    expect(turnContract).toContain('defineContribution<AgentInputContribution>("agent.input")');
    const agentContract = await readFile(resolve("plugins/agent/contract.ts"), "utf8");
    expect(agentContract).not.toContain("AGENT_TOOL_CONTRIBUTION");
    expect(agentContract).not.toContain("AGENT_INPUT_CONTRIBUTION");

    const manifest = getPluginManifest(turnLoopPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual([
      "agent",
      "events",
      "model",
      "permissions.trusted",
      "prompts",
      "routing",
      "session.resources",
      "sessions",
      "tools",
    ]);
    expect(manifest.optional.map((capability) => capability.id).sort()).toEqual([
      "agent-profiles",
      "computer",
      "conversations",
      "memory",
      "model-credentials",
      "observability",
      "projects",
      "rlm",
      "sandbox",
      "session-jobs",
      "skills",
      "subagents",
    ]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["turn-runtime"]);
  });

  it("keeps detached session-job lifecycle outside Turn Loop and Agent implementations", async () => {
    const manager = await readFile(resolve("plugins/session-jobs/manager.ts"), "utf8");
    expect(manager).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:agent|turn-loop|channels|sessions)\//);
    expect(manager).not.toContain("node:child_process");

    const manifest = getPluginManifest(sessionJobsPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual(["events", "sessions"]);
    expect(manifest.optional.map((capability) => capability.id)).toEqual(["channels.trusted"]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["session-jobs"]);
  });

  it("keeps System as a replaceable action executor rather than a central plugin owner", async () => {
    for (const path of await sourceFiles(resolve("plugins/system"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(forbiddenSiblingPackageImport);
      expect(source, path).not.toMatch(
        /(?:from|import\()\s*["']\.\.\/(?:audit|channels|scheduler|sandbox|observability|lifecycle|integrations|mcp|vault)\//,
      );
      expect(source, path).not.toContain("node:child_process");
    }
    const entry = await readFile(resolve("plugins/system/index.ts"), "utf8");
    expect(entry).toContain("SYSTEM_ACTION_CONTRIBUTION");
    expect(entry).toContain("SYSTEM_STATUS_CONTRIBUTION");
    expect(entry).toContain("TURN_EXECUTOR_CONTRIBUTION");
    const manifest = getPluginManifest(systemPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual(["model", "permissions"]);
    expect(manifest.optional.map((capability) => capability.id)).toEqual(["model-credentials"]);
    expect(manifest.provides).toEqual([]);
  });


  it("keeps Artifacts as a generic safe package-intake boundary", async () => {
    for (const path of await sourceFiles(resolve("plugins/artifacts"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:skills|mcp|agent|self-improvement)\//);
      expect(source, path).not.toContain("registerCommand");
    }
    const manifest = getPluginManifest(artifactsPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual(["execution", "sandbox"]);
    expect(manifest.optional.map((capability) => capability.id)).toEqual(["channels.trusted"]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["artifacts"]);
  });

  it("keeps Runtime Settings typed and lifecycle-backed instead of reintroducing a command registry", async () => {
    for (const path of await sourceFiles(resolve("plugins/runtime-settings"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("registerCommand");
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:agent|scheduler|mcp|integrations|self-improvement)\//);
    }
    const manifest = getPluginManifest(runtimeSettingsPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual(["lifecycle", "model", "model.registry", "permissions"]);
    expect(manifest.optional.map((capability) => capability.id).sort()).toEqual(["channels.trusted", "model-credentials"]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["runtime-settings"]);
  });

  it("keeps Alerts as a metadata-only notification policy over Events and Channels", async () => {
    for (const path of await sourceFiles(resolve("plugins/alerts"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:observability|audit|agent|scheduler|routing)\//);
      expect(source, path).not.toContain("event.data");
      expect(source, path).not.toContain("registerCommand");
    }
    const manifest = getPluginManifest(alertsPlugin)!;
    expect(manifest.requires.map((capability) => capability.id).sort()).toEqual([
      "channels.trusted", "events", "permissions", "permissions.trusted",
    ]);
    expect(manifest.provides.map((capability) => capability.id)).toEqual(["alerts"]);
  });

  it("keeps remote administration capabilities typed and fail-closed", async () => {
    const diagnosticsManifest = getPluginManifest(diagnosticsPlugin)!;
    expect(diagnosticsManifest.requires.map((capability) => capability.id).sort()).toEqual([
      "doctor.host",
      "observability",
      "runtime-settings",
    ]);
    expect(diagnosticsManifest.provides.map((capability) => capability.id)).toEqual(["diagnostics"]);

    for (const path of await sourceFiles(resolve("plugins/diagnostics"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toContain("node:child_process");
      expect(source, path).not.toMatch(/(?:from|import\()\s*["']\.\.\/(?:agent|tools|vault|channels|execution)\//);
    }

    const hostDoctorManifest = getPluginManifest(hostDoctorPlugin)!;
    expect(hostDoctorManifest.requires.map((capability) => capability.id).sort()).toEqual([
      "channels",
      "host-privileges",
      "model-credentials",
      "runtime-settings",
      "sandbox.health",
      "voice",
    ]);
    expect(hostDoctorManifest.provides.map((capability) => capability.id)).toEqual(["doctor.host"]);
    const hostDoctor = await readFile(resolve("plugins/host-doctor/index.ts"), "utf8");
    expect(hostDoctor).not.toContain("SYSTEM_ACTION_CONTRIBUTION");
    expect(hostDoctor).not.toContain("sudo");

    const hostPrivilegesManifest = getPluginManifest(hostPrivilegesPlugin)!;
    expect(hostPrivilegesManifest.requires.map((capability) => capability.id)).toEqual(["runtime-settings"]);
    expect(hostPrivilegesManifest.provides.map((capability) => capability.id)).toEqual(["host-privileges"]);
    const privileged = await readFile(resolve("plugins/host-privileges/privileged.ts"), "utf8");
    expect(privileged).toContain('"voice-deps"');
    expect(privileged).not.toContain("NOPASSWD: ALL");
    expect(privileged).not.toContain("sudo -S");

    const sandboxManifest = getPluginManifest(sandboxPlugin)!;
    expect(sandboxManifest.optional.map((capability) => capability.id).sort()).toEqual(["observability", "runtime-settings"]);
    expect(sandboxManifest.provides.map((capability) => capability.id).sort()).toEqual(["sandbox", "sandbox.health"]);

    const skillsManifest = getPluginManifest(skillsPlugin)!;
    expect(skillsManifest.requires.map((capability) => capability.id).sort()).toEqual(["artifacts", "permissions"]);
    expect(skillsManifest.optional.map((capability) => capability.id)).toEqual(["runtime-settings"]);

    const voiceManifest = getPluginManifest(voicePlugin)!;
    expect(voiceManifest.requires.map((capability) => capability.id).sort()).toEqual([
      "model-credentials",
      "vault",
      "vault.trusted",
    ]);
    expect(voiceManifest.optional.map((capability) => capability.id).sort()).toEqual([
      "artifacts",
      "host-privileges",
      "observability",
      "protected-credentials",
      "runtime-settings",
    ]);

    const selfImprovementManifest = getPluginManifest(selfImprovementPlugin)!;
    expect(selfImprovementManifest.optional.map((capability) => capability.id).sort()).toEqual([
      "artifacts",
      "channels.trusted",
      "diagnostics",
      "mcp",
      "mcp.trusted",
      "model-credentials",
    ]);
  });

  it("keeps proxy transport outside agent", async () => {
    const files = (await sourceFiles(resolve("plugins/agent/runtime/src"))).map((path) =>
      path.replaceAll("\\", "/"),
    );
    expect(files.some((path) => path.endsWith("/proxy.ts"))).toBe(false);
  });
  it("keeps autonomous workflow ownership local", async () => {
    const config = JSON.parse(await readFile(resolve("friday.config.json"), "utf8")) as { plugins: string[] };
    const names = config.plugins.map((entry) => entry.replace(/^\.\/plugins\//, "").replace(/\/index\.ts$/, ""));
    expect(names).not.toContain("application");
    expect(names).toContain("alerts");
    expect(names).toContain("artifacts");
    expect(names).toContain("audit");
    expect(names).toContain("permissions");
    expect(names).toContain("sandbox");
    expect(names).toContain("vault");
    expect(names).toContain("events");
    expect(names).toContain("observability");
    expect(names).toContain("webhooks");
    expect(names).toContain("channels");
    expect(names).toContain("turn-loop");
    expect(names).toContain("scheduler");
    expect(names).toContain("system");
    expect(names).toContain("runtime-settings");
    expect(names).toContain("integrations");
    expect(names).toContain("computer");
    expect(names[0]).toBe("capabilities");
    const selfImprovementManifest = getPluginManifest(selfImprovementPlugin)!;
    expect(selfImprovementManifest.activation).toBe("last");
    expect(selfImprovementManifest.requires.map((capability) => capability.id)).toContain("autonomy");

    const autonomyEntry = await readFile(resolve("plugins/autonomy/index.ts"), "utf8");
    expect(autonomyEntry).toContain("SYSTEM_ACTION_CONTRIBUTION");
    expect(autonomyEntry).toContain('id: "autonomy.run"');
    expect(autonomyEntry).not.toContain("registerCommand");

    const autonomyRunner = await readFile(resolve("plugins/autonomy/runner.ts"), "utf8");
    expect(autonomyRunner).toContain('tools.createTool("bash"');
    expect(autonomyRunner).toContain('tools.createTool("edit"');
    expect(autonomyRunner).not.toContain("tools.api");

    const selfImprovementEntry = await readFile(resolve("plugins/self-improvement/index.ts"), "utf8");
    expect(selfImprovementEntry).toContain("SYSTEM_ACTION_CONTRIBUTION");
    expect(selfImprovementEntry).toContain('id: "self-improvement.run"');
    expect(selfImprovementEntry).not.toContain("registerCommand");

    const runStart = selfImprovementEntry.indexOf('id: "self-improvement.run"');
    const runPermission = selfImprovementEntry.indexOf("permission()", runStart);
    const runParameters = selfImprovementEntry.slice(runStart, runPermission);
    expect(runParameters).toContain('objective: { type: "string"');
    for (const hostOwnedField of [
      "repository:",
      "provider:",
      "model:",
      "gates:",
      "stateDir:",
      "worktreeRoot:",
      "permissionMode:",
      "maxContinuations:",
      "maxTurns:",
      "maxTokens:",
      "timeoutMs:",
      "restartTimeoutMs:",
      "takeoverTimeoutMs:",
    ]) {
      expect(runParameters, hostOwnedField).not.toContain(hostOwnedField);
    }
    expect(selfImprovementEntry.slice(runPermission, selfImprovementEntry.indexOf("ctx.contribute(AGENT_TOOL_CONTRIBUTION", runPermission)))
      .toContain("const repository = configuredSelfRepository();");

    const ensureMarker = 'ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {\n    id: "self-improvement.ensure-capability"';
    const ensureStart = selfImprovementEntry.indexOf(ensureMarker);
    const ensurePermission = selfImprovementEntry.indexOf("permission()", ensureStart);
    const ensureParameters = selfImprovementEntry.slice(ensureStart, ensurePermission);
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    expect(ensureParameters).not.toContain("repository:");
    expect(selfImprovementEntry.slice(ensurePermission, selfImprovementEntry.indexOf('id: "self-improvement.status"', ensurePermission)))
      .toContain("const repository = configuredSelfRepository();");

    const runtime = await readFile(resolve("src/runtime.ts"), "utf8");
    expect(runtime).toContain("activateConfiguredPlugins");
    expect(runtime).not.toMatch(/(?:from|import\()\s*["']\.\.\/plugins\//);
    expect(runtime).not.toContain("registerCommand");

    const onboardingCli = await readFile(resolve("src/cli.ts"), "utf8");
    expect(onboardingCli).toContain("runOnboarding");
    expect(onboardingCli).not.toContain("activateConfiguredPlugins");
    expect(onboardingCli).not.toContain("registerCommand");

    for (const entry of ["channels", "events", "scheduler", "webhooks"]) {
      const lifecycleOwner = await readFile(resolve(`plugins/${entry}/index.ts`), "utf8");
      expect(lifecycleOwner, entry).toContain("ctx.afterReady(");
    }

    for (const pluginSourcePath of await sourceFiles(resolve("plugins"))) {
      const pluginSource = await readFile(pluginSourcePath, "utf8");
      expect(pluginSource, pluginSourcePath).not.toContain("registerCommand");
    }
  });

});
