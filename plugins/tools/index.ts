import { resolve } from "node:path";
import * as tools from "@friday/tools";
import { reportOperationalError } from "@friday/operational-errors";
import type { ExecutionTarget } from "@friday/execution-targets";
import {
  configureExecutionAccess,
  type ExecutionAccess,
  type Tool,
  type ToolName,
} from "@friday/tools";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import {
  COMPUTER_CAPABILITY,
  type ComputerAgentControlResume,
  type ComputerExecutionBinding,
  type ComputerService,
} from "../computer/contract.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionMode } from "../permissions/contract.js";
import { sandboxNetworkEnabled, SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import { TOOLS_CAPABILITY, type SecureToolOptions, type ToolsService } from "./contract.js";
import { createSecureEditOperations } from "./secure-edit.js";

function effectiveMode(requested: PermissionMode | undefined, normalize: (value?: string) => PermissionMode): PermissionMode {
  return requested ?? normalize(process.env.FRIDAY_PERMISSION_MODE);
}

function executionTarget(options: SecureToolOptions): ExecutionTarget | undefined {
  return options.executionTarget;
}

function usesSandbox(target: ExecutionTarget | undefined): boolean {
  return target === undefined || target.kind === "sandbox";
}

function currentComputerExecutionBinding(service: ComputerService, binding: ComputerExecutionBinding): ComputerExecutionBinding {
  const control = service.controlLease(binding.screenLeaseId);
  if (!control) throw new Error("Computer execution requires an active leased screen");
  if (control.nodeId !== binding.nodeId || control.screenId !== binding.screenId || control.agentOwnerId !== binding.ownerId) {
    throw new Error("Computer control lease does not match the execution binding");
  }
  if (control.holder === "agent" && control.holderId === binding.ownerId && control.generation >= binding.generation) {
    return control.generation === binding.generation ? binding : Object.freeze({ ...binding, generation: control.generation });
  }
  return binding;
}

async function resumeComputerExecutionAfterTakeover(
  service: ComputerService,
  binding: ComputerExecutionBinding,
  error: unknown,
  signal?: AbortSignal,
): Promise<Extract<ComputerAgentControlResume, { resumedAfterTakeover: true }>> {
  const control = service.controlLease(binding.screenLeaseId);
  if (!control
    || control.nodeId !== binding.nodeId
    || control.screenId !== binding.screenId
    || control.agentOwnerId !== binding.ownerId
    || control.generation <= binding.generation) {
    throw error;
  }
  const resume = await service.waitForAgentControl(binding.screenLeaseId, binding.ownerId, binding.generation, signal);
  if (!resume.resumedAfterTakeover) throw error;
  return resume;
}

const toolsPlugin: FridayPlugin = definePlugin({
  id: "tools",
  requires: [EXECUTION_CAPABILITY, PERMISSIONS_CAPABILITY, SANDBOX_CAPABILITY],
  optional: [COMPUTER_CAPABILITY],
  provides: [TOOLS_CAPABILITY],
}, (ctx) => {
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
        operation: "clean stale managed sandbox processes",
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

  const computerService = (): ComputerService => {
    const computer = ctx.services.optional(COMPUTER_CAPABILITY);
    if (!computer) throw new Error("Computer capability is unavailable for computer-node execution");
    return computer;
  };

  const createComputerTool = (name: ToolName, cwd: string, options: SecureToolOptions, target: ExecutionTarget, mode: PermissionMode): Tool => {
    const nodeId = target.computerNodeId;
    if (target.kind !== "computer-node" || !nodeId) throw new Error(`Execution target ${target.id} is not a valid Computer Node target`);
    const binding = options.computer;
    if (!binding) throw new Error(`Execution target ${target.id} requires a leased Computer screen from Turn Loop`);
    if (binding.nodeId !== nodeId) throw new Error(`Computer execution binding targets ${binding.nodeId}, not ${nodeId}`);

    const base = tools.createTool(name, cwd);
    const remote: Tool = {
      ...base,
      async execute(_toolCallId, rawInput, signal) {
        signal?.throwIfAborted();
        if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) throw new Error(`${name} input must be an object`);
        const input = rawInput as Readonly<Record<string, unknown>>;

        if (name === "bash") {
          const command = typeof input.command === "string" ? input.command : "";
          await permissions.authorize({
            mode,
            workspace: cwd,
            access: "write",
            action: { id: "tools.bash.execute", effect: "workspace-write", resource: cwd, network: true },
            reason: `bash on Computer ${nodeId}: ${command}`,
          });
        } else if (name === "edit") {
          const path = typeof input.path === "string" ? input.path : "";
          const absolutePath = resolve(cwd, path);
          await permissions.authorize({
            mode,
            workspace: cwd,
            access: "write",
            path: absolutePath,
            action: { id: "tools.edit.write", effect: "workspace-write", resource: absolutePath, network: false },
            reason: `edit ${absolutePath} on Computer ${nodeId}`,
          });
        } else if (name === "process" && input.action === "start") {
          if (binding.ownerKind !== "main-agent") throw new Error("Subagents cannot start persistent background processes");
          const command = typeof input.command === "string" ? input.command : "";
          await permissions.authorize({
            mode,
            workspace: cwd,
            access: "write",
            action: { id: "tools.process.start", effect: "workspace-write", resource: cwd, network: true },
            reason: `background process on Computer ${nodeId}: ${command}`,
          });
        } else if (name === "ipython") {
          await permissions.authorize({
            mode,
            workspace: cwd,
            access: "write",
            action: { id: "tools.ipython.execute", effect: "workspace-write", resource: cwd, network: true },
            reason: `ipython execution on Computer ${nodeId} in the selected workspace`,
          });
        }

        const service = computerService();
        const activeBinding = currentComputerExecutionBinding(service, binding);
        try {
          const result = await service.runTool(activeBinding, { workspace: cwd, tool: name, input }, signal);
          return {
            content: result.content.map((item) => item.type === "text"
              ? { type: "text" as const, text: item.text }
              : { type: "image" as const, data: item.data, mimeType: item.mimeType }),
            details: result.details,
            ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
          };
        } catch (error) {
          const resume = await resumeComputerExecutionAfterTakeover(service, activeBinding, error, signal);
          return {
            content: [{
              type: "text" as const,
              text: `Human takeover interrupted Computer ${name} execution. The interrupted operation was not replayed and may have partially executed. Re-check current state before acting again.`,
            }],
            details: {
              interruptedByHumanTakeover: true,
              staleActionReplayed: false,
              controlGeneration: resume.controlLease.generation,
              observation: resume.observation,
            },
          };
        }
      },
    };
    return remote;
  };

  const createTool = (name: ToolName, cwd: string, options: SecureToolOptions = {}): Tool => {
    const mode = effectiveMode(options.permissionMode, permissions.normalizeMode);
    const target = executionTarget(options);
    if (target?.kind === "computer-node") return createComputerTool(name, cwd, options, target, mode);
    const sandboxed = usesSandbox(target);
    if (name === "bash") {
      return tools.createTool("bash", cwd, {
        bash: {
          async spawnHook(context, input) {
            // Sandbox can enforce per-command network isolation. Core Host cannot, so
            // conservatively classify every host shell as network-capable for Permissions.
            const network = sandboxed ? sandboxNetworkEnabled(sandbox, input.network === true) : true;
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
            if (!sandboxed) return context;
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
          operations: createSecureEditOperations(cwd, execution, sandboxed ? sandbox : undefined),
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
            // A host process is not network-isolated even when the request does not
            // explicitly ask for network, so Permissions must treat it as capable.
            const network = sandboxed ? sandboxNetworkEnabled(sandbox, input.network === true) : true;
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
            if (!sandboxed) return context;
            const sandboxContext = sandbox.sandboxProcess({
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
              cwd: sandboxContext.cwd,
              env: sandboxContext.env,
              launch: { command: sandboxContext.command, args: sandboxContext.args },
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
            // Core Host Python is not network-isolated. Mark it network-capable so
            // approval policy cannot be bypassed by Python networking.
            const network = sandboxed ? sandboxNetworkEnabled(sandbox, false) : true;
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
          ...(sandboxed ? {
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
          } : {}),
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
