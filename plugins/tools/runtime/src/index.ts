export * from "./types.js";
export * from "./execution-access.js";
export * from "./bash.js";
export * from "./edit.js";
export * from "./edit-diff.js";
export * from "./file-mutation-queue.js";
export * from "./ipython.js";
export * from "./ipython-cell-code.js";
export * from "./output-accumulator.js";
export * from "./path-utils.js";
export * from "./truncate.js";

import { createBashTool, type BashToolOptions } from "./bash.js";
import { createEditTool, type EditToolOptions } from "./edit.js";
import { createIpythonTool, type IpythonToolOptions } from "./ipython.js";
import { createProcessTool, type ProcessToolOptions } from "./process.js";
import type { Tool } from "./types.js";

export type ToolName = "bash" | "edit" | "ipython" | "process";
export const allToolNames: ReadonlySet<ToolName> = new Set(["bash", "edit", "ipython", "process"]);

export interface ToolsOptions {
  bash?: BashToolOptions;
  edit?: EditToolOptions;
  ipython?: IpythonToolOptions;
  process?: ProcessToolOptions;
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
  switch (toolName) {
    case "bash":
      return createBashTool(cwd, options?.bash);
    case "edit":
      return createEditTool(cwd, options?.edit);
    case "ipython":
      return createIpythonTool(cwd, options?.ipython);
    case "process":
      return createProcessTool(cwd, options?.process);
  }
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
  return {
    bash: createBashTool(cwd, options?.bash),
    edit: createEditTool(cwd, options?.edit),
    ipython: createIpythonTool(cwd, options?.ipython),
    process: createProcessTool(cwd, options?.process),
  };
}
export * from "./process.js";
