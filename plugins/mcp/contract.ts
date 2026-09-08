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

export interface McpRegistryRemoteEndpoint {
  readonly type: string;
  readonly url: string;
}

export interface McpRegistryPackageDescriptor {
  readonly registryType: string;
  readonly identifier: string;
  readonly version?: string | undefined;
  readonly transportType?: string | undefined;
}

export interface McpDiscoveryCandidate {
  readonly name: string;
  readonly version: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly repositoryUrl?: string | undefined;
  readonly remotes: readonly McpRegistryRemoteEndpoint[];
  readonly packages: readonly McpRegistryPackageDescriptor[];
}

export interface McpService {
  servers(): readonly McpServerDescriptor[];
  status(server: string): McpServerDescriptor;
  listTools(server: string, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  searchRegistry(query: string, signal?: AbortSignal): Promise<readonly McpDiscoveryCandidate[]>;
  callTool(input: McpToolCallInput): Promise<McpToolCallResult>;
  disconnect(server?: string): Promise<void>;
}

export const MCP_CAPABILITY: Capability<McpService> = defineCapability<McpService>("mcp");
