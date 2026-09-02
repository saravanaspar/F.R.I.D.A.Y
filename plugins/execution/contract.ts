import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

type ExecutionRuntime = typeof import("@friday/execution");

/** Host execution primitives intentionally available to other FRIDAY plugins. */
export interface ExecutionService {
  readonly KernelManager: ExecutionRuntime["KernelManager"];
  readonly execCommand: ExecutionRuntime["execCommand"];
  readonly defaultKernelPythonPath: ExecutionRuntime["defaultKernelPythonPath"];
  readonly createLocalShellOperations: ExecutionRuntime["createLocalShellOperations"];
  readonly launchDetachedProcess: ExecutionRuntime["launchDetachedProcess"];
  readonly isProcessAlive: ExecutionRuntime["isProcessAlive"];
  readonly signalProcessGroupOrProcess: ExecutionRuntime["signalProcessGroupOrProcess"];
  readonly processes: InstanceType<ExecutionRuntime["ManagedProcessSupervisor"]>;
}

export const EXECUTION_CAPABILITY: Capability<ExecutionService> =
  defineCapability<ExecutionService>("execution");
