import { BUILTIN_MCP_CATALOG } from "./catalog.js";
import { McpHttpConnection, type JsonValue } from "./http-client.js";
import { createMcpOAuthProvider, type McpOAuthConfig } from "./oauth.js";
import { getMcpStateDir, loadMcpServers, saveMcpServers, type RemoteMcpAuth, type RemoteMcpServerConfig } from "./state.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./auth-access.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME_MAX = 256;
const OAUTH_CREDENTIAL_KIND = "mcp-oauth";

export interface McpNetworkAuthorization {
  server: string;
  operation: "login" | "list-tools" | "call-tool";
  tool?: string;
  mutatesExternalState: boolean;
}

export interface McpCredentialAccess {
  exists(ref: string): boolean;
  normalizeRef(ref: string): string;
  consume(ref: string, consumer: (secret: Uint8Array) => void | Promise<void>): Promise<void>;
  create(ref: string, kind: string, secret: string | Uint8Array): void;
  rotate(ref: string, secret: string | Uint8Array): void;
}

export interface McpManagerEvent {
  type: "mcp.tool.called";
  server: string;
  tool: string;
  isError: boolean;
}

export interface McpManagerOptions {
  stateDir?: string;
  credentials: McpCredentialAccess;
  authorize(request: McpNetworkAuthorization): Promise<void>;
  publish?(event: McpManagerEvent): void;
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface McpServerRegistrationInput {
  id: string;
  label?: string;
  url: string;
  authKind?: "none" | "bearer" | "oauth";
  credentialRef?: string;
  oauthClientId?: string;
  oauthScopes?: string;
}

export interface McpServerView {
  id: string;
  label: string;
  url: string;
  authKind: "none" | "bearer" | "oauth";
  builtIn: boolean;
  credentialConfigured: boolean;
  connected: boolean;
}

export interface McpToolView {
  server: string;
  name: string;
  description?: string;
  inputSchema: JsonValue;
}

export interface McpCallView {
  server: string;
  tool: string;
  isError: boolean;
  content: JsonValue;
}

function normalizeId(value: string): string {
  const id = value.trim();
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid MCP server id: ${JSON.stringify(value)}`);
  return id;
}

function normalizeToolName(value: string): string {
  const name = value.trim();
  if (!name || name.length > TOOL_NAME_MAX || /[\r\n\0]/.test(name)) throw new Error(`Invalid MCP tool name: ${JSON.stringify(value)}`);
  return name;
}

function validateUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.username || url.password) throw new Error("MCP endpoint URL must not contain credentials");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote MCP endpoints must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.hash) throw new Error("MCP endpoint URL must not include a fragment");
  return url.toString();
}

function defaultCredentialRef(id: string, kind: "bearer" | "oauth"): string {
  return `vault://mcp/${id}/${kind}`;
}

function builtinServers(credentials: McpCredentialAccess): RemoteMcpServerConfig[] {
  return BUILTIN_MCP_CATALOG.map((entry) => {
    const oauth = entry.oauth;
    const auth: RemoteMcpAuth = oauth?.kind === "oauth"
      ? {
          kind: "oauth",
          credentialRef: credentials.normalizeRef(defaultCredentialRef(entry.server, "oauth")),
          ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
          ...(oauth.scopes ? { scopes: oauth.scopes } : {}),
        }
      : { kind: "none" };
    return { id: entry.server, label: entry.label, url: validateUrl(entry.url), auth, builtIn: true };
  });
}

function oauthConfig(server: RemoteMcpServerConfig): McpOAuthConfig {
  if (server.auth.kind !== "oauth") throw new Error(`MCP server ${server.id} does not use OAuth`);
  return {
    server: server.id,
    label: server.label,
    url: server.url,
    ...(server.auth.clientId ? { clientId: server.auth.clientId } : {}),
    ...(server.auth.scopes ? { scopes: server.auth.scopes } : {}),
  };
}

function encodeCredentials(credentials: OAuthCredentials): string {
  return JSON.stringify(credentials);
}

function decodeCredentials(bytes: Uint8Array, server: string): OAuthCredentials {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`Stored MCP OAuth credential is malformed for ${server}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Stored MCP OAuth credential is malformed for ${server}`);
  const record = value as Record<string, unknown>;
  if (typeof record.access !== "string" || !record.access.trim() || typeof record.refresh !== "string" || typeof record.expires !== "number" || !Number.isFinite(record.expires)) {
    throw new Error(`Stored MCP OAuth credential is malformed for ${server}`);
  }
  return record as OAuthCredentials;
}

export class McpManager {
  readonly #stateDir: string;
  readonly #credentials: McpCredentialAccess;
  readonly #authorize: McpManagerOptions["authorize"];
  readonly #publish: McpManagerOptions["publish"];
  readonly #now: () => Date;
  readonly #fetch: typeof fetch | undefined;
  readonly #builtins: RemoteMcpServerConfig[];
  readonly #connections = new Map<string, McpHttpConnection>();

  constructor(options: McpManagerOptions) {
    this.#stateDir = options.stateDir ?? getMcpStateDir();
    this.#credentials = options.credentials;
    this.#authorize = options.authorize;
    this.#publish = options.publish;
    this.#now = options.now ?? (() => new Date());
    this.#fetch = options.fetch;
    this.#builtins = builtinServers(options.credentials);
    this.#allServers(); // fail closed on corrupt persisted config during construction
  }

  servers(): readonly McpServerView[] {
    return this.#allServers().map((server) => this.#view(server));
  }

  status(id: string): McpServerView {
    return this.#view(this.#server(id));
  }

  credentialRef(id: string): string | undefined {
    const auth = this.#server(id).auth;
    return auth.kind === "none" ? undefined : auth.credentialRef;
  }

  registerServer(input: McpServerRegistrationInput): McpServerView {
    const id = normalizeId(input.id);
    if (this.#builtins.some((server) => server.id === id)) throw new Error(`Cannot replace built-in MCP server: ${id}`);
    const custom = [...loadMcpServers(this.#stateDir)];
    if (custom.some((server) => server.id === id)) throw new Error(`MCP server already exists: ${id}`);
    const authKind = input.authKind ?? "none";
    let auth: RemoteMcpAuth;
    if (authKind === "none") {
      if (input.credentialRef) throw new Error("credentialRef is not valid for authKind=none");
      auth = { kind: "none" };
    } else {
      const ref = this.#credentials.normalizeRef(input.credentialRef?.trim() || defaultCredentialRef(id, authKind));
      if (authKind === "bearer") {
        if (!this.#credentials.exists(ref)) throw new Error(`Bearer credential does not exist in Vault: ${ref}`);
        auth = { kind: "bearer", credentialRef: ref };
      } else {
        auth = {
          kind: "oauth",
          credentialRef: ref,
          ...(input.oauthClientId?.trim() ? { clientId: input.oauthClientId.trim() } : {}),
          ...(input.oauthScopes?.trim() ? { scopes: input.oauthScopes.trim() } : {}),
        };
      }
    }
    const timestamp = this.#now().toISOString();
    const server: RemoteMcpServerConfig = {
      id,
      label: input.label?.trim() || id,
      url: validateUrl(input.url),
      auth,
      builtIn: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    custom.push(server);
    saveMcpServers(this.#stateDir, custom);
    return this.#view(server);
  }

  async removeServer(idInput: string): Promise<boolean> {
    const id = normalizeId(idInput);
    if (this.#builtins.some((server) => server.id === id)) throw new Error(`Cannot remove built-in MCP server: ${id}`);
    const custom = [...loadMcpServers(this.#stateDir)];
    const next = custom.filter((server) => server.id !== id);
    if (next.length === custom.length) return false;
    saveMcpServers(this.#stateDir, next);
    await this.#dropConnection(id);
    return true;
  }

  async login(idInput: string, callbacks: OAuthLoginCallbacks): Promise<McpServerView> {
    const server = this.#server(idInput);
    if (server.auth.kind !== "oauth") throw new Error(`MCP server ${server.id} is not configured for OAuth`);
    callbacks.signal?.throwIfAborted();
    await this.#authorize({ server: server.id, operation: "login", mutatesExternalState: false });
    const provider = createMcpOAuthProvider(oauthConfig(server));
    const credentials = await provider.login(callbacks);
    callbacks.signal?.throwIfAborted();
    const encoded = encodeCredentials(credentials);
    if (this.#credentials.exists(server.auth.credentialRef)) this.#credentials.rotate(server.auth.credentialRef, encoded);
    else this.#credentials.create(server.auth.credentialRef, OAUTH_CREDENTIAL_KIND, encoded);
    await this.#dropConnection(server.id);
    return this.#view(server);
  }

  async listTools(idInput: string, signal?: AbortSignal): Promise<readonly McpToolView[]> {
    const server = this.#server(idInput);
    signal?.throwIfAborted();
    await this.#authorize({ server: server.id, operation: "list-tools", mutatesExternalState: false });
    signal?.throwIfAborted();
    const connection = await this.#connection(server);
    const tools = await connection.listTools(signal);
    return tools.map((tool) => ({ server: server.id, ...tool }));
  }

  async callTool(idInput: string, toolInput: string, args?: JsonValue, signal?: AbortSignal): Promise<McpCallView> {
    const server = this.#server(idInput);
    const tool = normalizeToolName(toolInput);
    signal?.throwIfAborted();
    // Fail safe: every remote MCP tool call is classified as an external mutation.
    // Remote tool annotations are hints, not a trusted authorization boundary.
    await this.#authorize({ server: server.id, operation: "call-tool", tool, mutatesExternalState: true });
    signal?.throwIfAborted();
    const connection = await this.#connection(server);
    const result = await connection.callTool(tool, args, signal);
    this.#publish?.({ type: "mcp.tool.called", server: server.id, tool, isError: result.isError === true });
    return { server: server.id, tool, isError: result.isError === true, content: result.content ?? [] };
  }

  async disconnect(idInput?: string): Promise<void> {
    if (idInput === undefined) {
      const connections = [...this.#connections.values()];
      this.#connections.clear();
      await Promise.all(connections.map((connection) => connection.close()));
      return;
    }
    await this.#dropConnection(normalizeId(idInput));
  }

  #allServers(): RemoteMcpServerConfig[] {
    const custom = [...loadMcpServers(this.#stateDir)];
    const seen = new Set(this.#builtins.map((server) => server.id));
    for (const server of custom) {
      if (seen.has(server.id)) throw new Error(`Persisted MCP server conflicts with built-in server: ${server.id}`);
      seen.add(server.id);
      server.url = validateUrl(server.url);
    }
    return [...this.#builtins, ...custom].sort((a, b) => a.id.localeCompare(b.id));
  }

  #server(idInput: string): RemoteMcpServerConfig {
    const id = normalizeId(idInput);
    const server = this.#allServers().find((candidate) => candidate.id === id);
    if (!server) throw new Error(`Unknown MCP server: ${id}`);
    return server;
  }

  #view(server: RemoteMcpServerConfig): McpServerView {
    return {
      id: server.id,
      label: server.label,
      url: server.url,
      authKind: server.auth.kind,
      builtIn: server.builtIn,
      credentialConfigured: server.auth.kind === "none" || this.#credentials.exists(server.auth.credentialRef),
      connected: this.#connections.get(server.id)?.connected === true,
    };
  }

  async #connection(server: RemoteMcpServerConfig): Promise<McpHttpConnection> {
    const existing = this.#connections.get(server.id);
    if (existing) return existing;
    const connection = new McpHttpConnection({
      server,
      tokenProvider: { token: (forceRefresh) => this.#token(server, forceRefresh === true) },
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
    this.#connections.set(server.id, connection);
    return connection;
  }

  async #token(server: RemoteMcpServerConfig, forceRefresh: boolean): Promise<string | undefined> {
    if (server.auth.kind === "none") return undefined;
    if (!this.#credentials.exists(server.auth.credentialRef)) {
      throw new Error(server.auth.kind === "oauth"
        ? `MCP OAuth login required for ${server.id}; run friday mcp login ${server.id}`
        : `MCP bearer credential is missing for ${server.id}`);
    }
    if (server.auth.kind === "bearer") {
      let token = "";
      await this.#credentials.consume(server.auth.credentialRef, (secret) => { token = new TextDecoder().decode(secret).trim(); });
      if (!token) throw new Error(`MCP bearer credential is empty for ${server.id}`);
      return token;
    }
    let credentials: OAuthCredentials | undefined;
    await this.#credentials.consume(server.auth.credentialRef, (secret) => { credentials = decodeCredentials(secret, server.id); });
    if (!credentials) throw new Error(`MCP OAuth credential is unavailable for ${server.id}`);
    if (forceRefresh || credentials.expires <= Date.now()) {
      const provider = createMcpOAuthProvider(oauthConfig(server));
      credentials = await provider.refreshToken(credentials);
      this.#credentials.rotate(server.auth.credentialRef, encodeCredentials(credentials));
    }
    return credentials.access;
  }

  async #dropConnection(id: string): Promise<void> {
    const connection = this.#connections.get(id);
    this.#connections.delete(id);
    if (connection) await connection.close();
  }
}
