import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import authPlugin from "../plugins/auth/index.js";
import { AGENT_TOOL_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import eventsPlugin from "../plugins/events/index.js";
import {
  collectContributions,
  definePlugin,
  requireCapability,
  uninstallCapabilityRegistry,
} from "../plugins/capabilities/protocol.js";
import { createMcpPlugin } from "../plugins/mcp/index.js";
import { searchMcpRegistry } from "../plugins/mcp/discovery.js";
import { MCP_CAPABILITY } from "../plugins/mcp/contract.js";
import { MCP_TRUSTED_CAPABILITY } from "../plugins/mcp/trusted-contract.js";
import modelPlugin from "../plugins/model/index.js";
import {
  PERMISSIONS_CAPABILITY,
  type PermissionRequest,
  type PermissionsService,
} from "../plugins/permissions/contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { createVaultPlugin } from "../plugins/vault/index.js";
import { McpManager, getMcpStateDir } from "@friday/mcp";

const tempDirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "friday-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  uninstallCapabilityRegistry();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RequestRecord {
  method: string;
  url: string;
  authorization?: string | undefined;
  protocolVersion?: string | undefined;
  sessionId?: string | undefined;
  mcpMethod?: string | undefined;
  mcpName?: string | undefined;
  body?: Record<string, unknown> | undefined;
}

async function mockMcpServer(options: { bearer?: string; sseList?: boolean; expireFirstList?: boolean; modern?: boolean } = {}) {
  const requests: RequestRecord[] = [];
  let expiredList = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
      sessionId: req.headers["mcp-session-id"] as string | undefined,
      mcpMethod: req.headers["mcp-method"] as string | undefined,
      mcpName: req.headers["mcp-name"] as string | undefined,
      body,
    });

    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (options.bearer && req.headers.authorization !== `Bearer ${options.bearer}`) {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    if (body?.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (options.expireFirstList && !expiredList && body?.method === "tools/list") {
      expiredList = true;
      res.writeHead(404, { "content-type": "text/plain" }).end("session expired");
      return;
    }

    const id = body?.id;
    let result: unknown;
    if (body?.method === "server/discover" && options.modern) {
      result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    } else if (body?.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } };
      res.setHeader("Mcp-Session-Id", "test-session");
    } else if (body?.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
    } else if (body?.method === "tools/call") {
      const params = body.params as { arguments?: Record<string, unknown> };
      result = { content: [{ type: "text", text: String(params.arguments?.value ?? "") }], isError: false };
    } else {
      res.writeHead(400).end("unknown method");
      return;
    }

    const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (options.sseList && body?.method === "tools/list") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${payload}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock MCP server failed to bind");
  const handle = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  servers.push(handle);
  return handle;
}

function memoryCredentials(initial: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    secrets,
    access: {
      exists: (ref: string) => secrets.has(ref),
      normalizeRef: (ref: string) => ref,
      async consume(ref: string, consumer: (secret: Uint8Array) => void | Promise<void>) {
        const value = secrets.get(ref);
        if (value === undefined) throw new Error(`missing secret: ${ref}`);
        await consumer(new TextEncoder().encode(value));
      },
      create(ref: string, _kind: string, secret: string | Uint8Array) {
        if (secrets.has(ref)) throw new Error(`duplicate secret: ${ref}`);
        secrets.set(ref, typeof secret === "string" ? secret : new TextDecoder().decode(secret));
      },
      rotate(ref: string, secret: string | Uint8Array) {
        if (!secrets.has(ref)) throw new Error(`missing secret: ${ref}`);
        secrets.set(ref, typeof secret === "string" ? secret : new TextDecoder().decode(secret));
      },
    },
  };
}

describe("MCP production client", () => {
  it("searches the official Registry with latest-version filtering and discards unsafe remote metadata", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://registry.modelcontextprotocol.io/v0.1/servers");
      expect(url.searchParams.get("search")).toBe("computer control");
      expect(url.searchParams.get("version")).toBe("latest");
      expect(url.searchParams.get("limit")).toBe("10");
      return new Response(JSON.stringify({
        servers: [{
          server: {
            name: "io.example/computer",
            version: "1.2.3",
            title: "Computer MCP",
            description: "Computer-control tools",
            repository: { url: "https://github.com/example/computer" },
            remotes: [
              { type: "streamable-http", url: "https://mcp.example.com/mcp" },
              { type: "streamable-http", url: "http://unsafe.example.com/mcp" },
            ],
            packages: [{ registryType: "npm", identifier: "@example/computer-mcp", version: "1.2.3", transport: { type: "stdio" } }],
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(searchMcpRegistry("computer control", fetchMock as unknown as typeof fetch)).resolves.toEqual([
      {
        name: "io.example/computer",
        version: "1.2.3",
        title: "Computer MCP",
        description: "Computer-control tools",
        repositoryUrl: "https://github.com/example/computer",
        remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
        packages: [{ registryType: "npm", identifier: "@example/computer-mcp", version: "1.2.3", transportType: "stdio" }],
      },
    ]);
  });

  it("discovers tools, calls a tool, reuses the negotiated session, authorizes network access, and persists custom server metadata", async () => {
    const remote = await mockMcpServer({ sseList: true });
    const stateDir = temp();
    const credentials = memoryCredentials();
    const authorizations: Array<{ operation: string; mutatesExternalState: boolean }> = [];
    const events: unknown[] = [];
    const manager = new McpManager({
      stateDir,
      credentials: credentials.access,
      authorize: async (request) => { authorizations.push(request); },
      publish: (event) => { events.push(event); },
    });

    manager.registerServer({ id: "local", label: "Local MCP", url: remote.url });
    const tools = await manager.listTools("local");
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(await manager.callTool("local", "echo", { value: 42 })).toMatchObject({ isError: false, content: [{ type: "text", text: "42" }] });

    expect(authorizations).toEqual([
      expect.objectContaining({ operation: "list-tools", mutatesExternalState: false }),
      expect.objectContaining({ operation: "call-tool", mutatesExternalState: true }),
    ]);
    expect(events).toEqual([expect.objectContaining({ type: "mcp.tool.called", server: "local", tool: "echo" })]);
    expect(remote.requests.some((request) => request.body?.method === "notifications/initialized" && request.protocolVersion === "2025-11-25")).toBe(true);
    expect(remote.requests.filter((request) => request.body?.method === "tools/list")[0]?.sessionId).toBe("test-session");

    const reopened = new McpManager({ stateDir, credentials: credentials.access, authorize: async () => {} });
    expect(reopened.status("local")).toMatchObject({ id: "local", builtIn: false, credentialConfigured: true });
    await manager.disconnect();
    await reopened.disconnect();
  });


  it("prefers the current stateless MCP era and sends per-request routing metadata", async () => {
    const remote = await mockMcpServer({ modern: true });
    const manager = new McpManager({ stateDir: temp(), credentials: memoryCredentials().access, authorize: async () => {} });
    manager.registerServer({ id: "modern", url: remote.url });

    expect((await manager.listTools("modern")).map((tool) => tool.name)).toEqual(["echo"]);
    expect(await manager.callTool("modern", "echo", { value: "modern" })).toMatchObject({ isError: false });
    expect(remote.requests.some((request) => request.body?.method === "initialize")).toBe(false);
    expect(remote.requests.some((request) => request.body?.method === "notifications/initialized")).toBe(false);

    const discover = remote.requests.find((request) => request.body?.method === "server/discover");
    expect(discover).toMatchObject({ protocolVersion: "2026-07-28", mcpMethod: "server/discover", sessionId: undefined });
    expect((discover?.body?.params as Record<string, unknown> | undefined)?._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "friday", version: "0.0.1" },
    });

    const call = remote.requests.find((request) => request.body?.method === "tools/call");
    expect(call).toMatchObject({ protocolVersion: "2026-07-28", mcpMethod: "tools/call", mcpName: "echo", sessionId: undefined });
    await manager.disconnect();
  });

  it("injects bearer credentials only at request time and never persists plaintext secrets", async () => {
    const remote = await mockMcpServer({ bearer: "super-secret-token" });
    const stateDir = temp();
    const credentials = memoryCredentials({ "vault://mcp/custom/bearer": "super-secret-token" });
    const manager = new McpManager({ stateDir, credentials: credentials.access, authorize: async () => {} });
    manager.registerServer({
      id: "secure",
      url: remote.url,
      authKind: "bearer",
      credentialRef: "vault://mcp/custom/bearer",
    });

    await manager.listTools("secure");
    expect(remote.requests.some((request) => request.authorization === "Bearer super-secret-token")).toBe(true);
    const statePath = join(stateDir, "mcp_state.json");
    const stateText = readFileSync(statePath, "utf8");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(stateText).toContain("vault://mcp/custom/bearer");
    expect(stateText).not.toContain("super-secret-token");
    expect(JSON.stringify(manager.status("secure"))).not.toContain("vault://");
    expect(JSON.stringify(manager.status("secure"))).not.toContain("super-secret-token");
    await manager.disconnect();
  });

  it("ships Linear and Notion as OAuth-backed built-ins without claiming credentials exist", () => {
    const credentials = memoryCredentials();
    const manager = new McpManager({ stateDir: temp(), credentials: credentials.access, authorize: async () => {} });
    expect(manager.status("linear")).toMatchObject({ authKind: "oauth", builtIn: true, credentialConfigured: false });
    expect(manager.status("notion")).toMatchObject({ authKind: "oauth", builtIn: true, credentialConfigured: false });
    expect(manager.credentialRef("linear")).toBe("vault://mcp/linear/oauth");
  });

  it("rejects unsafe remote URLs, absent bearer credentials, and non-object tool arguments", async () => {
    const credentials = memoryCredentials();
    const manager = new McpManager({ stateDir: temp(), credentials: credentials.access, authorize: async () => {} });
    expect(() => manager.registerServer({ id: "bad", url: "http://example.com/mcp" })).toThrow(/HTTPS/);
    expect(() => manager.registerServer({ id: "missing", url: "https://example.com/mcp", authKind: "bearer", credentialRef: "vault://mcp/missing/bearer" })).toThrow(/does not exist/);

    const remote = await mockMcpServer();
    manager.registerServer({ id: "local", url: remote.url });
    await expect(manager.callTool("local", "echo", [] as never)).rejects.toThrow(/arguments must be a JSON object/);
    await manager.disconnect();
  });


  it("reinitializes once when a negotiated MCP session expires", async () => {
    const remote = await mockMcpServer({ expireFirstList: true });
    const manager = new McpManager({ stateDir: temp(), credentials: memoryCredentials().access, authorize: async () => {} });
    manager.registerServer({ id: "recover", url: remote.url });

    expect((await manager.listTools("recover")).map((tool) => tool.name)).toEqual(["echo"]);
    expect(remote.requests.filter((request) => request.body?.method === "initialize")).toHaveLength(2);
    expect(remote.requests.filter((request) => request.body?.method === "tools/list")).toHaveLength(2);
    await manager.disconnect();
  });

  it("fails closed on corrupt persisted MCP server configuration", () => {
    const stateDir = temp();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "mcp_state.json"), "{not-json\n", { mode: 0o600 });
    expect(() => new McpManager({ stateDir, credentials: memoryCredentials().access, authorize: async () => {} })).toThrow(/Unable to parse MCP state/);
  });

  it("keeps the ordinary MCP capability secret-free while trusted registration/auth lives separately", async () => {
    const stateRoot = temp();
    const previousState = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateRoot;
    const authorizations: PermissionRequest[] = [];
    const permissions: PermissionsService = {
      normalizeMode: () => "auto",
      async authorize(request) {
        authorizations.push(request);
        return { allowed: true, approvedBy: "policy" };
      },
      assertWorkspacePath: (_workspace, path) => path,
    };
    const permissionProvider = definePlugin(
      { id: "test-mcp-permissions", provides: [PERMISSIONS_CAPABILITY] },
      (ctx) => { ctx.services.provide(PERMISSIONS_CAPABILITY, permissions); },
    );
    try {
      uninstallCapabilityRegistry();
      const friday = new PluginTestHost();
      await friday.activatePlugin(capabilitiesPlugin);
      await friday.activatePlugin(sessionResourcesPlugin);
      await friday.activatePlugin(modelPlugin);
      await friday.activatePlugin(permissionProvider);
      await friday.activatePlugin(createVaultPlugin({ stateDir: join(stateRoot, "vault"), workspaceRoot: process.cwd() }));
      await friday.activatePlugin(eventsPlugin);
      await friday.activatePlugin(authPlugin);
      await friday.activatePlugin(createMcpPlugin({ stateDir: join(stateRoot, "mcp") }));

      const safe = requireCapability(MCP_CAPABILITY);
      const trusted = requireCapability(MCP_TRUSTED_CAPABILITY);
      expect(Object.keys(safe).sort()).toEqual(["callTool", "disconnect", "listTools", "searchRegistry", "servers", "status"]);
      expect(Object.keys(trusted).sort()).toEqual(["credentialRef", "login", "registerServer", "removeServer"]);
      expect(JSON.stringify(safe.servers())).not.toContain("vault://");
      const tools = collectContributions(AGENT_TOOL_CONTRIBUTION);
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "mcp_call_tool",
        "mcp_list_tools",
        "mcp_search_registry",
        "mcp_servers",
      ]);
      await expect(tools.find((tool) => tool.name === "mcp_servers")!.execute({})).resolves.toMatchObject({
        output: expect.any(Array),
      });
      await expect(tools.find((tool) => tool.name === "mcp_list_tools")!.execute({ server: "missing" }))
        .rejects.toThrow(/Unknown MCP server/);
      await expect(tools.find((tool) => tool.name === "mcp_call_tool")!.execute({
        server: "missing",
        tool: "noop",
      })).rejects.toThrow(/Unknown MCP server/);
      expect(authorizations.map((request) => request.action)).toEqual([
        {
          id: "mcp.servers.read",
          effect: "global-operational-read",
          resource: "mcp:servers",
          network: false,
        },
        {
          id: "mcp.servers.read",
          effect: "global-operational-read",
          resource: "mcp:servers",
          network: false,
        },
        {
          id: "mcp.servers.read",
          effect: "global-operational-read",
          resource: "mcp:servers",
          network: false,
        },
      ]);
    } finally {
      if (previousState === undefined) delete process.env.FRIDAY_STATE_DIR;
      else process.env.FRIDAY_STATE_DIR = previousState;
    }
  });

  it("uses the stable MCP state directory under FRIDAY state", () => {
    expect(getMcpStateDir({ FRIDAY_STATE_DIR: "/tmp/friday-state" })).toBe("/tmp/friday-state/mcp");
  });
});
