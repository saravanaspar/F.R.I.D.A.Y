import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { provideCapability, requireCapability } from "../plugins/capabilities/protocol.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import executionPlugin from "../plugins/execution/index.js";
import toolsPlugin from "../plugins/tools/index.js";
import { TOOLS_CAPABILITY } from "../plugins/tools/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionRequest } from "../plugins/permissions/contract.js";
import { createPermissionsController } from "../plugins/permissions/policy.js";
import { SANDBOX_CAPABILITY, type SandboxKernelRequest, type SandboxShellRequest } from "../plugins/sandbox/contract.js";
import { computerNodeExecutionTarget, coreHostExecutionTarget } from "@friday/execution-targets";
import {
  COMPUTER_CAPABILITY,
  type ComputerExecutionBinding,
  type ComputerService,
  type ComputerToolExecutionRequest,
} from "../plugins/computer/contract.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tools plugin", () => {
  it("exposes coding tools through the execution capability boundary", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    const approvals: PermissionRequest[] = [];
    const sandboxRequests: SandboxShellRequest[] = [];
    const kernelRequests: SandboxKernelRequest[] = [];
    const permissionController = createPermissionsController({
      approve: async (request) => {
        approvals.push(request);
        return true;
      },
    });
    provideCapability(PERMISSIONS_CAPABILITY, permissionController.permissions);
    provideCapability(SANDBOX_CAPABILITY, {
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) {
        sandboxRequests.push(request);
        return { command: request.command, cwd: request.cwd, env: request.env };
      },
      sandboxProcess(request) {
        return { command: request.command, args: request.args, cwd: request.cwd, env: request.env };
      },
      sandboxKernel(request) {
        kernelRequests.push(request);
        return { command: "true", args: [], cwd: request.cwd, env: request.env };
      },
    });
    await friday.activatePlugin(toolsPlugin);

    const service = requireCapability(TOOLS_CAPABILITY);
    const dir = await mkdtemp(join(tmpdir(), "friday-tools-integration-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "sample.txt"), "before\n", "utf8");

    const tools = service.createAllTools(dir, { permissionMode: "ask" });
    expect(Object.keys(tools)).toEqual(["bash", "edit", "ipython", "process"]);
    expect(tools.ipython.executionMode).toBe("sequential");
    expect(kernelRequests).toHaveLength(0);

    const bashParameters = tools.bash.parameters as { properties?: Record<string, unknown> };
    expect(bashParameters.properties).not.toHaveProperty("intent");

    const bash = await permissionController.trusted.runAsLocal(() => tools.bash.execute(
      "bash-1",
      { command: "printf friday-tools", intent: "read" } as never,
    ));
    expect(bash.content).toEqual([{ type: "text", text: "friday-tools" }]);
    expect(approvals[0]?.access).toBe("write");
    expect(approvals[0]?.action).toMatchObject({
      id: "tools.bash.execute",
      effect: "workspace-write",
      network: false,
    });
    expect(sandboxRequests[0]?.access).toBe("write");

    await permissionController.trusted.runAsLocal(() => tools.edit.execute("edit-1", {
      path: "sample.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }));
    expect(await readFile(join(dir, "sample.txt"), "utf8")).toBe("after\n");
  });

  it("routes Project Computer Node tools through the Computer capability without local or Sandbox execution", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    const approvals: PermissionRequest[] = [];
    let sandboxCalls = 0;
    const remoteCalls: Array<{ tool: string; workspace: string; input: Readonly<Record<string, unknown>>; runId: string; generation: number }> = [];
    let controlGeneration = 7;
    let humanControl = false;
    let interruptNext = false;
    const controlLeaseSnapshot = () => ({
      id: "control-1", screenLeaseId: "lease-1", nodeId: "desk-1", screenId: "agent-1",
      holder: humanControl ? "human" as const : "agent" as const, holderId: humanControl ? "client:desktop" : "job-1",
      agentOwnerId: "job-1", generation: controlGeneration, acquiredAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
      handBackAfterMs: null, transcriptPolicy: { captureKeystrokes: false as const, captureSecrets: false as const, captureSensitiveScreenshots: false as const },
    });
    const permissionController = createPermissionsController({
      approve: async (request) => { approvals.push(request); return true; },
    });
    provideCapability(PERMISSIONS_CAPABILITY, permissionController.permissions);
    provideCapability(SANDBOX_CAPABILITY, {
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) { sandboxCalls += 1; return { command: request.command, cwd: request.cwd, env: request.env }; },
      sandboxProcess(request) { sandboxCalls += 1; return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
      sandboxKernel(request) { sandboxCalls += 1; return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
    });
    provideCapability(COMPUTER_CAPABILITY, {
      controlLease() {
        return controlLeaseSnapshot();
      },
      async waitForAgentControl() {
        if (!humanControl) throw new Error("expected simulated human takeover");
        humanControl = false;
        controlGeneration += 1;
        return {
          resumedAfterTakeover: true as const,
          controlLease: controlLeaseSnapshot(),
          observation: {
            observedAt: new Date().toISOString(), screenId: "agent-1",
            safety: { protectedInputOmitted: true, keystrokesOmitted: true, captchaOmitted: true, sensitiveScreenshotOmitted: true },
            url: "https://example.com/after-login", domSummary: "signed in", accessibilitySummary: "main", tabs: [], processes: [],
          },
        };
      },
      async runTool(binding: ComputerExecutionBinding, request: ComputerToolExecutionRequest) {
        if (interruptNext) {
          interruptNext = false;
          humanControl = true;
          controlGeneration += 1;
          throw new Error("Human takeover invalidated pending Computer actions");
        }
        remoteCalls.push({ tool: request.tool, workspace: request.workspace, input: request.input, runId: binding.runId, generation: binding.generation });
        return { content: [{ type: "text", text: `remote:${request.tool}` }] };
      },
    } as unknown as ComputerService);
    await friday.activatePlugin(toolsPlugin);

    const service = requireCapability(TOOLS_CAPABILITY);
    const dir = await mkdtemp(join(tmpdir(), "friday-tools-computer-"));
    tempDirs.push(dir);
    const computer = {
      nodeId: "desk-1",
      screenId: "agent-1",
      screenLeaseId: "lease-1",
      ownerId: "job-1",
      ownerKind: "main-agent" as const,
      runId: "run-tools-computer",
      generation: 7,
    };
    const target = computerNodeExecutionTarget("desk-1");
    const remoteTools = service.createAllTools(dir, { permissionMode: "ask", executionTarget: target, computer });

    await permissionController.trusted.runAsLocal(() => remoteTools.bash.execute("computer-bash", { command: "pwd" }));
    await permissionController.trusted.runAsLocal(() => remoteTools.edit.execute("computer-edit", {
      path: "sample.ts",
      edits: [{ oldText: "before", newText: "after" }],
    }));
    await permissionController.trusted.runAsLocal(() => remoteTools.process.execute("computer-process", { action: "start", command: "npm run dev" }));
    await permissionController.trusted.runAsLocal(() => remoteTools.ipython.execute("computer-python", { code: "print('ok')" }));

    expect(remoteCalls.map((call) => call.tool)).toEqual(["bash", "edit", "process", "ipython"]);
    expect(remoteCalls.every((call) => call.workspace === dir)).toBe(true);
    expect(remoteCalls.every((call) => call.runId === "run-tools-computer")).toBe(true);
    expect(sandboxCalls).toBe(0);
    expect(approvals.map((entry) => entry.action.id)).toEqual([
      "tools.bash.execute",
      "tools.edit.write",
      "tools.process.start",
      "tools.ipython.execute",
    ]);
    expect(approvals.find((entry) => entry.action.id === "tools.bash.execute")?.action.network).toBe(true);
    expect(approvals.find((entry) => entry.action.id === "tools.process.start")?.action.network).toBe(true);
    expect(approvals.find((entry) => entry.action.id === "tools.ipython.execute")?.action.network).toBe(true);
    expect(approvals.find((entry) => entry.action.id === "tools.edit.write")?.action.network).toBe(false);

    interruptNext = true;
    const interrupted = await permissionController.trusted.runAsLocal(() => remoteTools.bash.execute("computer-bash-takeover", { command: "git status" }));
    expect(interrupted.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not replayed") });
    expect(interrupted.details).toMatchObject({
      interruptedByHumanTakeover: true,
      staleActionReplayed: false,
      controlGeneration: 9,
      observation: { domSummary: "signed in" },
    });
    await permissionController.trusted.runAsLocal(() => remoteTools.bash.execute("computer-bash-after-takeover", { command: "pwd" }));
    expect(remoteCalls.at(-1)?.generation).toBe(9);

    expect(() => service.createTool("bash", dir, { permissionMode: "ask", executionTarget: target }))
      .toThrow(/leased Computer screen/);
    await friday.dispose();
  });

  it("routes Project Core Host shell, edit, and process tools without entering the Sandbox", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin);
    await friday.activatePlugin(executionPlugin);
    const approvals: PermissionRequest[] = [];
    let sandboxCalls = 0;
    const permissionController = createPermissionsController({
      approve: async (request) => { approvals.push(request); return true; },
    });
    provideCapability(PERMISSIONS_CAPABILITY, permissionController.permissions);
    provideCapability(SANDBOX_CAPABILITY, {
      image: "test",
      assertAvailable() {},
      registerTrustedReadOnlyMount() { return () => {}; },
      sandboxShell(request) { sandboxCalls += 1; return { command: request.command, cwd: request.cwd, env: request.env }; },
      sandboxProcess(request) { sandboxCalls += 1; return { command: request.command, args: request.args, cwd: request.cwd, env: request.env }; },
      sandboxKernel(request) { sandboxCalls += 1; return { command: "true", args: [], cwd: request.cwd, env: request.env }; },
    });
    await friday.activatePlugin(toolsPlugin);

    const service = requireCapability(TOOLS_CAPABILITY);
    const dir = await mkdtemp(join(tmpdir(), "friday-tools-core-host-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "sample.txt"), "before\n", "utf8");
    const tools = service.createAllTools(dir, { permissionMode: "ask", executionTarget: coreHostExecutionTarget() });

    const bash = await permissionController.trusted.runAsLocal(() => tools.bash.execute("host-bash", { command: "pwd" }));
    expect(bash.content[0]).toMatchObject({ type: "text" });
    expect((bash.content[0] as { type: "text"; text: string }).text.trim()).toBe(dir);
    await permissionController.trusted.runAsLocal(() => tools.edit.execute("host-edit", {
      path: "sample.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }));
    expect(await readFile(join(dir, "sample.txt"), "utf8")).toBe("after\n");

    await service.withManagedProcessRun({ sessionId: "project-session", runId: "project-run", ownerKind: "main-agent" }, async () => {
      const started = await permissionController.trusted.runAsLocal(() => tools.process.execute("host-process", {
        action: "start",
        command: "sleep 30",
      }));
      expect(started.content[0]).toMatchObject({ type: "text" });
    });

    expect(sandboxCalls).toBe(0);
    expect(approvals.map((entry) => entry.action.id)).toEqual(expect.arrayContaining([
      "tools.bash.execute",
      "tools.edit.write",
      "tools.process.start",
    ]));
    expect(approvals.find((entry) => entry.action.id === "tools.bash.execute")?.action.network).toBe(true);
    expect(approvals.find((entry) => entry.action.id === "tools.process.start")?.action.network).toBe(true);
    expect(approvals.find((entry) => entry.action.id === "tools.edit.write")?.action.network).toBe(false);
    await friday.dispose();
  });

});
