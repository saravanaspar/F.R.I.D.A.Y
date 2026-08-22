import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type McpJsonPrimitive = string | number | boolean | null;
export type McpJsonValue = McpJsonPrimitive | McpJsonValue[] | { [key: string]: McpJsonValue };

export type McpAuthKind = "none" | "bearer" | "oauth";

export interface McpServerDescriptor {
  id: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  builtIn: boolean;
  credentialConfigured: boolean;
  connected: boolean;
}

export interface McpToolDescriptor {
  server: string;
  name: string;
  description?: string | undefined;
  inputSchema: McpJsonValue;
}

export interface McpToolCallInput {
  server: string;
  tool: string;
  arguments?: McpJsonValue | undefined;
  signal?: AbortSignal | undefined;
}

export interface McpToolCallResult {
  server: string;
  tool: string;
  isError: boolean;
  content: McpJsonValue;
}

export interface McpService {
  servers(): readonly McpServerDescriptor[];
  status(server: string): McpServerDescriptor;
  listTools(server: string, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(input: McpToolCallInput): Promise<McpToolCallResult>;
  disconnect(server?: string): Promise<void>;
}

export const MCP_CAPABILITY: Capability<McpService> = defineCapability<McpService>("mcp");
