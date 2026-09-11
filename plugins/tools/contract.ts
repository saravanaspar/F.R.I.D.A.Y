import type { IpythonToolOptions, Tool, ToolName } from "@friday/tools";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { PermissionMode } from "../permissions/contract.js";
import type { ExecutionTarget } from "@friday/execution-targets";

type ToolsRuntime = typeof import("@friday/tools");

export interface SecureToolOptions {
  permissionMode?: PermissionMode | undefined;
  /** Server-resolved execution target. Omitted means the existing Sandbox default. */
  executionTarget?: ExecutionTarget | undefined;
  ipython?: Pick<IpythonToolOptions, "env" | "sessionId" | "hostHandlers"> | undefined;
}

/** Secure tool construction and managed-run scoping. */
export interface ToolsService {
  createTool(name: ToolName, cwd: string, options?: SecureToolOptions): Tool;
  createAllTools(cwd: string, options?: SecureToolOptions): Record<ToolName, Tool>;
  readonly withManagedProcessRun: ToolsRuntime["withManagedProcessRun"];
}

export const TOOLS_CAPABILITY: Capability<ToolsService> =
  defineCapability<ToolsService>("tools");
