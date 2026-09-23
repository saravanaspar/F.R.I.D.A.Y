import { defineCapability } from "../capabilities/protocol.js";
import type { CuaTool } from "./driver.js";

export interface CuaService {
  listTools(signal?: AbortSignal): Promise<readonly CuaTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

/** Local CUA Driver connection shared by FRIDAY's desktop and browser tools. */
export const CUA_CAPABILITY = defineCapability<CuaService>("cua");
