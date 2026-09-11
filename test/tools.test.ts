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
import { coreHostExecutionTarget } from "@friday/execution-targets";

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
