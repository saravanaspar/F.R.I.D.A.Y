import type { IpythonToolOptions, Tool, ToolName } from "@friday/tools";
import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { PermissionMode } from "../permissions/contract.js";

export type ToolsModule = typeof import("@friday/tools");

export interface SecureToolOptions {
  permissionMode?: PermissionMode | undefined;
  ipython?: Pick<IpythonToolOptions, "env" | "sessionId" | "hostHandlers"> | undefined;
}

export interface ToolsService {
  readonly api: ToolsModule;
  createTool(name: ToolName, cwd: string, options?: SecureToolOptions): Tool;
  createAllTools(cwd: string, options?: SecureToolOptions): Record<ToolName, Tool>;
}

export const TOOLS_CAPABILITY: Capability<ToolsService> =
  defineCapability<ToolsService>("tools");
