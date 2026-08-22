import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { McpAuthKind, McpServerDescriptor } from "./contract.js";

export interface McpServerRegistration {
  id: string;
  label?: string | undefined;
  url: string;
  authKind?: McpAuthKind | undefined;
  credentialRef?: string | undefined;
  oauthClientId?: string | undefined;
  oauthScopes?: string | undefined;
}

export interface McpOAuthLoginCallbacks {
  onAuth(info: { url: string; instructions?: string | undefined }): void;
  onPrompt(prompt: { message: string; placeholder?: string | undefined; allowEmpty?: boolean | undefined }): Promise<string>;
  onProgress?(message: string): void;
  signal?: AbortSignal | undefined;
}

export interface McpTrustedService {
  registerServer(input: McpServerRegistration): McpServerDescriptor;
  removeServer(server: string): Promise<boolean>;
  login(server: string, callbacks: McpOAuthLoginCallbacks): Promise<McpServerDescriptor>;
  credentialRef(server: string): string | undefined;
}

export const MCP_TRUSTED_CAPABILITY: Capability<McpTrustedService> =
  defineCapability<McpTrustedService>("mcp.trusted");
