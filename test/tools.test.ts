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
      sandboxKind: "podman",
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
});
