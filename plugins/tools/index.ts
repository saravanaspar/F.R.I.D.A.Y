import * as tools from "@friday/tools";
import { reportOperationalError } from "@friday/operational-errors";
import {
  configureExecutionAccess,
  type ExecutionAccess,
  type Tool,
  type ToolName,
} from "@friday/tools";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionMode } from "../permissions/contract.js";
import { sandboxNetworkEnabled, SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import { TOOLS_CAPABILITY, type SecureToolOptions, type ToolsService } from "./contract.js";
import { createSecureEditOperations } from "./secure-edit.js";

function effectiveMode(requested: PermissionMode | undefined, normalize: (value?: string) => PermissionMode): PermissionMode {
  return requested ?? normalize(process.env.FRIDAY_PERMISSION_MODE);
}

const toolsPlugin: FridayPlugin = definePlugin({ id: "tools", requires: [EXECUTION_CAPABILITY, PERMISSIONS_CAPABILITY, SANDBOX_CAPABILITY], provides: [TOOLS_CAPABILITY] }, (ctx) => {
  const execution = ctx.services.require(EXECUTION_CAPABILITY);
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const sandbox = ctx.services.require(SANDBOX_CAPABILITY);
  const access: ExecutionAccess = {
    createKernel: (options) => new execution.KernelManager(options),
    createLocalShellOperations: execution.createLocalShellOperations,
    managedProcesses: execution.processes,
  };
  configureExecutionAccess(access);
  ctx.afterReady(async () => {
    try {
      sandbox.cleanupStaleManagedProcesses?.();
    } catch (error) {
      reportOperationalError({
        component: "tools",
        operation: "clean stale managed Podman processes",
        operationCode: "sandbox.stale-cleanup-failed",
        error,
        severity: "warn",
      });
    }
    try {
      await tools.cleanupStaleOutputFiles();
    } catch (error) {
      reportOperationalError({ component: "tools", operation: "clean stale bash output files", error, severity: "warn" });
    }
  });

  const createTool = (name: ToolName, cwd: string, options: SecureToolOptions = {}): Tool => {
    const mode = effectiveMode(options.permissionMode, permissions.normalizeMode);
    if (name === "bash") {
      return tools.createTool("bash", cwd, {
        bash: {
          async spawnHook(context, input) {
            const network = sandboxNetworkEnabled(sandbox, input.network === true);
            await permissions.authorize({
              mode,
              workspace: cwd,
              access: "write",
              action: {
                id: "tools.bash.execute",
                effect: "workspace-write",
                resource: cwd,
                network,
              },
              reason: `bash: ${input.command}`,
            });
            return sandbox.sandboxShell({
              command: context.command,
              cwd: context.cwd,
              workspace: cwd,
              access: "write",
              network,
              env: context.env,
            });
          },
        },
      });
    }
    if (name === "edit") {
      return tools.createTool("edit", cwd, {
        edit: {
          operations: createSecureEditOperations(cwd, execution, sandbox),
          async pathGuard(absolutePath) {
            await permissions.authorize({
              mode,
              workspace: cwd,
              access: "write",
              path: absolutePath,
              action: {
                id: "tools.edit.write",
                effect: "workspace-write",
                resource: absolutePath,
                network: false,
              },
              reason: `edit ${absolutePath}`,
            });
          },
        },
      });
    }
    if (name === "process") {
      return tools.createTool("process", cwd, {
        process: {
          async startHook(context, input) {
            const network = sandboxNetworkEnabled(sandbox, input.network === true);
            await permissions.authorize({
              mode,
              workspace: cwd,
              access: "write",
              action: {
                id: "tools.process.start",
                effect: "workspace-write",
                resource: cwd,
                network,
              },
              reason: `background process: ${input.command ?? ""}`,
            });
            const sandboxed = sandbox.sandboxProcess({
              command: "/bin/bash",
              args: ["-c", context.command],
              cwd: context.cwd,
              workspace: cwd,
              access: "write",
              network,
              env: context.env,
              managed: { id: context.id, runId: context.owner.runId },
            });
            return {
              ...context,
              cwd: sandboxed.cwd,
              env: sandboxed.env,
              launch: { command: sandboxed.command, args: sandboxed.args },
              ...(sandbox.cleanupManagedProcess === undefined ? {} : { cleanup: () => sandbox.cleanupManagedProcess?.(context.id) }),
            };
          },
        },
      });
    }
    if (name === "ipython") {
      return tools.createTool("ipython", cwd, {
        ipython: {
          async beforeExecute(_code, signal) {
            signal?.throwIfAborted();
            const network = sandboxNetworkEnabled(sandbox, false);
            await permissions.authorize({
              mode,
              workspace: cwd,
              access: "write",
              action: {
                id: "tools.ipython.execute",
                effect: "workspace-write",
                resource: cwd,
                network,
              },
              reason: "ipython execution in the selected workspace",
            });
          },
          ...(options.ipython?.env === undefined ? {} : { env: options.ipython.env }),
          ...(options.ipython?.sessionId === undefined ? {} : { sessionId: options.ipython.sessionId }),
          ...(options.ipython?.hostHandlers === undefined ? {} : { hostHandlers: options.ipython.hostHandlers }),
          transport: "ipc",
          launcher(request) {
            return sandbox.sandboxKernel({
              python: request.python,
              connectionPath: request.connectionPath,
              tempDir: request.tempDir,
              cwd: request.cwd ?? cwd,
              workspace: cwd,
              env: request.env,
            });
          },
        },
      });
    }
    return tools.createTool(name, cwd);
  };

  const service: ToolsService = Object.freeze({
    createTool,
    createAllTools(cwd: string, options: SecureToolOptions = {}) {
      return {
        bash: createTool("bash", cwd, options),
        edit: createTool("edit", cwd, options),
        ipython: createTool("ipython", cwd, options),
        process: createTool("process", cwd, options),
      };
    },
    withManagedProcessRun: tools.withManagedProcessRun,
  });
  ctx.services.provide(TOOLS_CAPABILITY, service);
});

export default toolsPlugin;
