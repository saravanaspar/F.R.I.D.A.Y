import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as mcp from "@friday/mcp";
import { reportOperationalError } from "@friday/operational-errors";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { AGENT_TOOL_CONTRIBUTION, type AgentExtensionJsonValue } from "../turn-loop/contract.js";
import { AUTH_CAPABILITY } from "../auth/contract.js";
import { ARTIFACTS_CAPABILITY } from "../artifacts/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { SELF_IMPROVEMENT_CAPABILITY, type SelfImprovementContinuation } from "../self-improvement/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_ACTIVE_WORK_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  summarizeSystemActiveWork,
  type SystemActionExecutionContext,
  type SystemJsonObject,
} from "../system/contract.js";
import { VAULT_CAPABILITY } from "../vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../vault/trusted-contract.js";
import {
  MCP_CAPABILITY,
  type McpDiscoveryCandidate,
  type McpJsonValue,
  type McpService,
} from "./contract.js";
import { searchMcpRegistry } from "./discovery.js";
import {
  MCP_TRUSTED_CAPABILITY,
  type McpOAuthLoginCallbacks,
  type McpTrustedService,
} from "./trusted-contract.js";

function systemString(
  input: Readonly<SystemJsonObject>,
  name: string,
  options: { required?: boolean; maximum?: number } = {},
): string | undefined {
  const value = input[name];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  const maximum = options.maximum ?? 512;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemAuthKind(input: Readonly<SystemJsonObject>): "none" | "bearer" | "oauth" {
  const value = systemString(input, "authKind", { maximum: 16 }) ?? "none";
  if (value !== "none" && value !== "bearer" && value !== "oauth") {
    throw new Error("authKind must be one of: none, bearer, oauth");
  }
  return value;
}

function agentString(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function terminalOAuthCallbacks(): McpOAuthLoginCallbacks {
  return {
    onAuth(info) {
      process.stdout.write(`${info.instructions ?? "Complete MCP login in your browser."}\n${info.url}\n`);
    },
    async onPrompt(prompt) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("MCP OAuth login requires an interactive terminal for manual input");
      }
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await readline.question(`${prompt.message}${prompt.placeholder ? `\n${prompt.placeholder}\n` : "\n"}> `);
      } finally {
        readline.close();
      }
    },
    onProgress(message) {
      process.stdout.write(`${message}\n`);
    },
  };
}

function channelPrincipal(turn: SystemActionExecutionContext["turn"]) {
  if (turn.principal.authority !== "channel") throw new Error("Channel interaction requires a channel-originated turn");
  return Object.freeze({
    channel: turn.principal.channel,
    accountId: turn.principal.accountId,
    conversationId: turn.principal.conversationId,
    senderId: turn.principal.senderId,
    ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
  });
}

function installUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("MCP install URL must be a valid HTTPS URL"); }
  if (url.protocol !== "https:") throw new Error("MCP install URL must use HTTPS");
  if (url.username || url.password) throw new Error("MCP install URL must not contain embedded credentials");
  return url;
}

function serverIdFromUrl(url: URL): string {
  const path = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "mcp";
  const raw = `${url.hostname.split(".")[0] ?? "mcp"}-${path}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (raw || "mcp-server").slice(0, 96);
}

export interface McpPluginOptions {
  stateDir?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export function createMcpPlugin(options: McpPluginOptions = {}): FridayPlugin {
  return definePlugin({ id: "mcp", requires: [AUTH_CAPABILITY, EVENTS_CAPABILITY, PERMISSIONS_CAPABILITY, VAULT_CAPABILITY, VAULT_TRUSTED_CAPABILITY], optional: [ARTIFACTS_CAPABILITY, CHANNELS_TRUSTED_CAPABILITY, OBSERVABILITY_CAPABILITY, SELF_IMPROVEMENT_CAPABILITY], provides: [MCP_CAPABILITY, MCP_TRUSTED_CAPABILITY] }, (bootstrap) => {
    const auth = bootstrap.services.require(AUTH_CAPABILITY);
    const events = bootstrap.services.require(EVENTS_CAPABILITY);
    const permissions = bootstrap.services.require(PERMISSIONS_CAPABILITY);
    const vault = bootstrap.services.require(VAULT_CAPABILITY);
    const vaultTrusted = bootstrap.services.require(VAULT_TRUSTED_CAPABILITY);
    const observability = bootstrap.services.optional(OBSERVABILITY_CAPABILITY);

    async function confirmRestartWithActiveWork(context: SystemActionExecutionContext, reason: string): Promise<void> {
      const active = summarizeSystemActiveWork(bootstrap.collect(SYSTEM_ACTIVE_WORK_CONTRIBUTION), {
        ...(context.jobId === undefined ? {} : { excludeJobId: context.jobId }),
        excludeForegroundTurns: context.jobId === undefined ? 1 : 0,
      });
      if (active.backgroundSessions === 0 && active.foregroundTurns === 0) return;
      const channels = bootstrap.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) {
        throw new Error(`Restart blocked because ${active.backgroundSessions} other background session(s) and ${active.foregroundTurns} other foreground turn(s) are active and the trusted channel approval service is unavailable.`);
      }
      const approved = await channels.requestApproval({
        principal: context.turn.principal,
        actionId: "lifecycle.restart-with-active-sessions",
        effect: "system-write",
        resource: "runtime-restart",
        reason: [
          `${reason} requires restarting FRIDAY while ${active.backgroundSessions} other background session(s) and ${active.foregroundTurns} other foreground turn(s) are active.`,
          "If you continue, FRIDAY will pause them and resume them after verified restart from their last durable transcript and original user request.",
          "Content and tool outputs already recorded in the transcript remain available. Private model thinking that has not yet been recorded can be lost.",
          "Approve stopping the active work temporarily and resuming it after restart?",
        ].join(" "),
      });
      if (!approved) throw new Error("Restart cancelled; active background sessions were left running.");
    }

    function oauthCallbacksForTurn(turn: SystemActionExecutionContext["turn"]): McpOAuthLoginCallbacks {
      if (turn.principal.authority !== "channel") return terminalOAuthCallbacks();
      const channels = bootstrap.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("Channel MCP OAuth requires Channels trusted interaction support");
      const principal = channelPrincipal(turn);
      return {
        onAuth(info) {
          void channels.send(principal, [
            info.instructions ?? "Complete MCP authorization in your browser.",
            info.url,
          ].join("\n")).catch((error: unknown) => {
            reportOperationalError({ component: "mcp", operation: "deliver OAuth authorization instructions", error });
          });
        },
        onPrompt(prompt) {
          return channels.requestPrompt({
            principal,
            message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
            ...(prompt.allowEmpty === undefined ? {} : { allowEmpty: prompt.allowEmpty }),
          });
        },
        onProgress(message) {
          void channels.send(principal, message).catch((error: unknown) => {
            reportOperationalError({ component: "mcp", operation: "deliver OAuth progress", error });
          });
        },
      };
    }

    mcp.configureAuthAccess({
      getOAuthProvider: (id) => auth.getOAuthProvider(id),
      registerOAuthProvider: (provider) => auth.registerOAuthProvider(provider),
      oauthErrorHtml: (message, details) => auth.oauthErrorHtml(message, details),
      oauthSuccessHtml: (message) => auth.oauthSuccessHtml(message),
      generatePKCE: () => auth.generatePKCE(),
    });
    mcp.registerBuiltinMcpOAuthProviders();

    const manager = new mcp.McpManager({
      ...(options.stateDir ? { stateDir: options.stateDir } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      credentials: {
        exists: (ref) => vault.exists(ref),
        normalizeRef: (ref) => vault.normalizeRef(ref),
        consume: (ref, consumer) => vaultTrusted.consume(ref, consumer),
        create: (ref, kind, secret) => { vaultTrusted.create({ ref, kind, secret }); },
        rotate: (ref, secret) => { vaultTrusted.rotate(ref, secret); },
      },
      async authorize(request) {
        const mode = permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE);
        await permissions.authorize({
          mode,
          workspace: process.cwd(),
          access: request.operation === "login" || request.mutatesExternalState ? "write" : "read",
          action: {
            id: request.operation === "login"
              ? "mcp.login"
              : request.operation === "list-tools"
                ? "mcp.list-tools"
                : "mcp.call-tool",
            effect: request.operation === "login"
              ? "credential-write"
              : request.mutatesExternalState
                ? "external-write"
                : "external-read",
            resource: request.tool ? `${request.server}:${request.tool}` : request.server,
            network: true,
          },
          reason: request.tool
            ? `MCP ${request.operation} ${request.server}:${request.tool}`
            : `MCP ${request.operation} ${request.server}`,
        });
      },
      publish(event) {
        events.publish({
          type: event.type,
          source: "mcp",
          subject: event.server,
          data: { server: event.server, tool: event.tool, isError: event.isError },
        });
      },
    });

    async function authorizeConfiguredServerAccess(reason: string): Promise<void> {
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: process.cwd(),
        access: "read",
        action: {
          id: "mcp.servers.read",
          effect: "global-operational-read",
          resource: "mcp:servers",
          network: false,
        },
        reason,
      });
    }

    const service = Object.freeze<McpService>({
      servers: () => manager.servers(),
      status: (server) => manager.status(server),
      listTools: (server, signal) => {
        const operation = () => manager.listTools(server, signal);
        return observability
          ? observability.withSpan({ name: "mcp.list-tools", component: "mcp", attributes: { server } }, operation)
          : operation();
      },
      async searchRegistry(query, signal): Promise<readonly McpDiscoveryCandidate[]> {
        await permissions.authorize({
          mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
          workspace: process.cwd(),
          access: "read",
          action: { id: "mcp.registry.search", effect: "external-read", resource: "registry.modelcontextprotocol.io", network: true },
          reason: `search the official MCP Registry for capability candidates matching ${query.slice(0, 160)}`,
        });
        const operation = () => searchMcpRegistry(query, options.fetch ?? globalThis.fetch, signal);
        return observability
          ? observability.withSpan({ name: "mcp.registry.search", component: "mcp", attributes: { query: query.slice(0, 160) } }, operation)
          : operation();
      },
      callTool: (input) => {
        const operation = () => manager.callTool(
          input.server,
          input.tool,
          input.arguments as mcp.McpJsonValue | undefined,
          input.signal,
        );
        return observability
          ? observability.withSpan({
              name: "mcp.call-tool",
              component: "mcp",
              attributes: { server: input.server, tool: input.tool },
            }, operation)
          : operation();
      },
      disconnect: (server) => manager.disconnect(server),
    });
    bootstrap.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "mcp-servers",
      name: "mcp_servers",
      label: "MCP servers",
      description: "List configured MCP servers and whether each is ready for use.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        await authorizeConfiguredServerAccess("list configured MCP servers");
        return {
          output: service.servers().map((server) => ({
            id: server.id,
            label: server.label,
            authKind: server.authKind,
            builtIn: server.builtIn,
            credentialConfigured: server.credentialConfigured,
            connected: server.connected,
          })),
        };
      },
    });
    bootstrap.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "mcp-search-registry",
      name: "mcp_search_registry",
      label: "Search MCP Registry",
      description: "Search the official MCP Registry for exact capability candidates before building a new integration. Registry metadata is discovery evidence only; inspect live tools before assuming a candidate supports an operation.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Short capability or operation search phrase" } },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, signal) {
        const query = agentString(input, "query");
        const candidates = await service.searchRegistry(query, signal);
        return {
          output: candidates.map((candidate) => ({
            name: candidate.name,
            version: candidate.version,
            ...(candidate.title === undefined ? {} : { title: candidate.title }),
            ...(candidate.description === undefined ? {} : { description: candidate.description }),
            ...(candidate.repositoryUrl === undefined ? {} : { repositoryUrl: candidate.repositoryUrl }),
            remotes: candidate.remotes.map((remote) => ({ type: remote.type, url: remote.url })),
            packages: candidate.packages.map((entry) => ({
              registryType: entry.registryType,
              identifier: entry.identifier,
              ...(entry.version === undefined ? {} : { version: entry.version }),
              ...(entry.transportType === undefined ? {} : { transportType: entry.transportType }),
            })),
          })),
        };
      },
    });
    bootstrap.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "mcp-list-tools",
      name: "mcp_list_tools",
      label: "List MCP tools",
      description: "Discover the tools exposed by one configured MCP server.",
      parameters: {
        type: "object",
        properties: { server: { type: "string", description: "Configured MCP server id" } },
        required: ["server"],
        additionalProperties: false,
      },
      async execute(input, signal) {
        const server = agentString(input, "server");
        await authorizeConfiguredServerAccess(`access configured MCP server ${server}`);
        const tools = await service.listTools(server, signal);
        return {
          output: tools.map((tool) => ({
            server: tool.server,
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
          })),
        };
      },
    });
    bootstrap.contribute(AGENT_TOOL_CONTRIBUTION, {
      id: "mcp-call-tool",
      name: "mcp_call_tool",
      label: "Call MCP tool",
      description: "Call a named tool on a configured MCP server. Use mcp_list_tools first when the tool schema is unknown.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Configured MCP server id" },
          tool: { type: "string", description: "Exact MCP tool name" },
          arguments: { type: "object", description: "Arguments matching the MCP tool input schema", additionalProperties: true },
        },
        required: ["server", "tool"],
        additionalProperties: false,
      },
      async execute(input, signal) {
        const server = agentString(input, "server");
        await authorizeConfiguredServerAccess(`access configured MCP server ${server}`);
        const result = await service.callTool({
          server,
          tool: agentString(input, "tool"),
          ...(input.arguments === undefined ? {} : { arguments: input.arguments as McpJsonValue }),
          ...(signal === undefined ? {} : { signal }),
        });
        return { output: result.content, isError: result.isError };
      },
    });

    const trusted = Object.freeze<McpTrustedService>({
      registerServer: (input) => manager.registerServer({
        id: input.id,
        url: input.url,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.authKind !== undefined ? { authKind: input.authKind } : {}),
        ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
        ...(input.oauthClientId !== undefined ? { oauthClientId: input.oauthClientId } : {}),
        ...(input.oauthScopes !== undefined ? { oauthScopes: input.oauthScopes } : {}),
      }),
      removeServer: (server) => manager.removeServer(server),
      login: (server, callbacks) => {
        const operation = () => manager.login(server, {
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          ...(callbacks.onProgress !== undefined ? { onProgress: callbacks.onProgress } : {}),
          ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
        });
        return observability
          ? observability.withSpan({ name: "mcp.login", component: "mcp", attributes: { server } }, operation)
          : operation();
      },
      credentialRef: (server) => manager.credentialRef(server),
    });

    bootstrap.services.provide(MCP_CAPABILITY, service);
    bootstrap.services.provide(MCP_TRUSTED_CAPABILITY, trusted);

    bootstrap.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "mcp",
      label: "MCP",
      snapshot: () => ({
        servers: service.servers().map((server) => ({
          id: server.id,
          authKind: server.authKind,
          builtIn: server.builtIn,
          credentialConfigured: server.credentialConfigured,
          connected: server.connected,
        })),
      }),
    });
    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.servers",
      label: "MCP servers",
      description: "List configured MCP servers and their non-secret connection status.",
      parameters: Object.freeze({
        type: "object",
        properties: { server: { type: "string" } },
        additionalProperties: false,
      }),
      permission() {
        return { id: "mcp.servers", effect: "global-operational-read", resource: "mcp:servers", network: false };
      },
      execute(input) {
        const server = systemString(input, "server");
        return server === undefined ? service.servers() : service.status(server);
      },
    });
    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.add-server",
      label: "Add MCP server",
      description: "Register MCP server metadata using an opaque credential reference when authentication is required.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          label: { type: "string" },
          authKind: { type: "string", enum: ["none", "bearer", "oauth"] },
          credentialRef: { type: "string" },
          oauthClientId: { type: "string" },
          oauthScopes: { type: "string" },
        },
        required: ["id", "url"],
        additionalProperties: false,
      }),
      permission(input) {
        const id = systemString(input, "id", { required: true, maximum: 128 })!;
        return { id: "mcp.add-server", effect: "system-write", resource: `mcp-server:${id}`, network: false };
      },
      execute(input) {
        const id = systemString(input, "id", { required: true, maximum: 128 })!;
        const url = systemString(input, "url", { required: true, maximum: 2_048 })!;
        const label = systemString(input, "label", { maximum: 256 });
        const credentialRef = systemString(input, "credentialRef", { maximum: 512 });
        const oauthClientId = systemString(input, "oauthClientId", { maximum: 512 });
        const oauthScopes = systemString(input, "oauthScopes", { maximum: 2_048 });
        return trusted.registerServer({
          id,
          url,
          authKind: systemAuthKind(input),
          ...(label === undefined ? {} : { label }),
          ...(credentialRef === undefined ? {} : { credentialRef }),
          ...(oauthClientId === undefined ? {} : { oauthClientId }),
          ...(oauthScopes === undefined ? {} : { oauthScopes }),
        });
      },
    });
    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.install",
      label: "Install MCP from link",
      description: "Install a user-provided remote MCP endpoint directly, or inspect a GitHub MCP repository and use feasibility-gated self-improvement when repository/local-process MCP support is missing.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          url: { type: "string" },
          id: { type: "string" },
          label: { type: "string" },
          authKind: { type: "string", enum: ["none", "bearer", "oauth"] },
        },
        required: ["url"],
        additionalProperties: false,
      }),
      permission(input) {
        const url = systemString(input, "url", { required: true, maximum: 2_048 })!;
        return { id: "mcp.install", effect: "external-read", resource: `mcp-source:${url}`, network: true };
      },
      async execute(input, context) {
        const url = installUrl(systemString(input, "url", { required: true, maximum: 2_048 })!);
        const requestedId = systemString(input, "id", { maximum: 128 });
        const id = requestedId ?? serverIdFromUrl(url);
        const label = systemString(input, "label", { maximum: 256 }) ?? id;
        const authKind = systemAuthKind(input);

        if (url.hostname.toLowerCase() !== "github.com") {
          await context.turn.reply([
            "MCP installation plan",
            `Server: ${id}`,
            `Endpoint: ${url.toString()}`,
            "Transport: Streamable HTTP",
            `Authentication: ${authKind}`,
          ].join("\n"));
          await permissions.authorize({
            mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
            workspace: process.cwd(),
            access: "write",
            action: { id: "mcp.install", effect: "system-write", resource: `mcp-server:${id}`, network: true },
            reason: `register user-provided MCP endpoint ${url.toString()}`,
          });
          let credentialRef: string | undefined;
          if (authKind === "bearer") {
            if (context.turn.principal.authority !== "channel") {
              throw new Error("Bearer MCP installation requires a channel-originated protected credential capture");
            }
            const channels = bootstrap.services.optional(CHANNELS_TRUSTED_CAPABILITY);
            if (!channels) throw new Error("Bearer MCP installation requires Channels trusted interaction support");
            const principal = channelPrincipal(context.turn);
            credentialRef = `vault://mcp/${id}/bearer`;
            const pending = channels.requestCredentialCapture({
              principal,
              ref: credentialRef,
              kind: "mcp-bearer",
              mode: vault.exists(credentialRef) ? "rotate" : "create",
              label: `${id} bearer token`,
              inputMode: "opaque-token",
              successMessage: `Bearer credential stored for MCP server ${id}. Continuing installation…`,
              failureMessage: "That value was not accepted as a standalone bearer token. Send only the token itself with no label, quotes, spaces, or code fences.",
            });
            await channels.send(principal, [
              `${id} requires a bearer credential.`,
              "Your NEXT message is intercepted before the AI router/model.",
              "Send ONLY the bearer token. Do not include 'token:', quotes, spaces, code fences, or other text.",
            ].join("\n"));
            const completion = await channels.waitForCredentialCapture(pending.id);
            if (completion.status !== "stored") throw new Error(`MCP bearer credential capture ${completion.status}`);
          }

          let registered: ReturnType<McpTrustedService["registerServer"]> | undefined;
          try {
            registered = trusted.registerServer({
              id,
              label,
              url: url.toString(),
              authKind,
              ...(credentialRef === undefined ? {} : { credentialRef }),
            });
            if (authKind === "oauth") {
              registered = await trusted.login(id, {
                ...oauthCallbacksForTurn(context.turn),
                ...(context.signal === undefined ? {} : { signal: context.signal }),
              });
            } else {
              await service.listTools(id, context.signal);
            }
            return { installed: true, verified: true, server: registered };
          } catch (error) {
            const rollbackFailures: unknown[] = [];
            if (registered) {
              try { await trusted.removeServer(id); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
            }
            if (credentialRef && vault.exists(credentialRef)) {
              try { vaultTrusted.remove(credentialRef); } catch (rollbackError) { rollbackFailures.push(rollbackError); }
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError([error, ...rollbackFailures], "MCP installation failed and rollback was incomplete");
            }
            throw error;
          }
        }

        const artifacts = bootstrap.services.optional(ARTIFACTS_CAPABILITY);
        const selfImprovement = bootstrap.services.optional(SELF_IMPROVEMENT_CAPABILITY);
        if (!artifacts || !selfImprovement) {
          throw new Error("GitHub MCP installation requires Artifacts and Self-Improvement capabilities");
        }
        await permissions.authorize({
          mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
          workspace: process.cwd(),
          access: "read",
          action: { id: "mcp.inspect-package", effect: "external-read", resource: url.toString(), network: true },
          reason: "inspect the user-provided MCP repository before presenting its installation/capability plan",
        });
        const stage = await artifacts.stagePackageSource({ url: url.toString(), ...(context.signal === undefined ? {} : { signal: context.signal }) });
        let packageHint = "repository MCP package";
        try {
          let packageText: string | undefined;
          try {
            packageText = await readFile(join(stage.sourceDir, "package.json"), "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (packageText !== undefined) {
            const packageJson = JSON.parse(packageText) as Record<string, unknown>;
            const name = typeof packageJson.name === "string" ? packageJson.name : undefined;
            const bin = packageJson.bin !== undefined;
            packageHint = `${name ?? basename(url.pathname).replace(/\.git$/i, "")}${bin ? " (executable package)" : ""}`;
          } else {
            try {
              await readFile(join(stage.sourceDir, "pyproject.toml"), "utf8");
              packageHint = `${basename(url.pathname).replace(/\.git$/i, "")} (Python package)`;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        } finally {
          await stage.dispose();
        }

        const provider = process.env.FRIDAY_MODEL_PROVIDER?.trim();
        const modelId = process.env.FRIDAY_MODEL_ID?.trim();
        if (!provider || !modelId) throw new Error("GitHub MCP capability extension requires a configured implementation model");
        let continuation: SelfImprovementContinuation | undefined;
        if (context.turn.principal.authority === "channel") {
          continuation = Object.freeze({
            id: `mcp-install-resume:${context.turn.id}`,
            principal: context.turn.principal,
            text: context.turn.text,
            ...(context.destinationId === undefined ? {} : { destinationId: context.destinationId }),
            timestamp: Date.now(),
            ...(context.turn.attachments?.length ? { attachments: context.turn.attachments } : {}),
          });
        }
        const ensured = await selfImprovement.ensureCapability({
          objective: `Add secure installation and execution support for user-provided local/stdio MCP repository packages. Preserve the existing Streamable HTTP MCP path. After implementation the original request must be able to install ${url.toString()} (${packageHint}) through the MCP plugin, with sandboxed package setup, typed Permissions authorization, Vault-backed credentials, bounded output, and tests.`,
          cwd: process.cwd(),
          provider,
          model: modelId,
          permissionMode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
          deferHandoff: true,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(continuation === undefined ? {} : { continuation }),
        }, {
          async onFeasible(feasibility) {
            await context.turn.reply([
              "Local/stdio MCP installation is not available yet. I checked feasibility and can build it now. Stay here.",
              "",
              "MCP installation plan",
              `Source: ${url.toString()}`,
              `Detected: ${packageHint}`,
              "Current gap: this FRIDAY generation can register remote Streamable HTTP MCP endpoints, but it does not yet install repository-local/stdio MCP packages.",
              `Feasibility: ${feasibility.reason}`,
              "After the new generation is ready, this original request will resume automatically.",
            ].join("\n"));
          },
          async authorize() {
            await permissions.authorize({
              mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
              workspace: process.cwd(),
              access: "write",
              action: { id: "mcp.install.extend", effect: "system-write", resource: `mcp-package:${url.toString()}`, network: false },
              reason: "build missing local/stdio MCP package support",
            });
          },
        });
        if (!ensured.result) return {
          installed: false,
          feasible: ensured.feasibility.feasible,
          placement: ensured.feasibility.placement,
          target: ensured.feasibility.target,
          requiresCode: ensured.feasibility.requiresCode,
          reason: ensured.feasibility.reason,
          nextStep: ensured.feasibility.objective,
        };
        context.deferAfterReply(async () => {
          await selfImprovement.finalizeHandoff(ensured.result!, {
            beforeHandoff: () => confirmRestartWithActiveWork(context, "MCP capability installation"),
          });
          process.kill(process.pid, "SIGTERM");
        }, {
          type: "self-improvement.handoff",
          payload: {
            candidateId: ensured.result.candidateId,
            generationId: ensured.result.generationId,
            commit: ensured.result.commit,
            restartRequestId: ensured.result.restartRequestId,
          },
        });
        return { installed: false, extended: true, generationId: ensured.result.generationId, message: "The missing MCP package capability was built. After this reply FRIDAY will perform a verified handoff and resume this installation automatically." };
      },
    });

    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.remove-server",
      label: "Remove MCP server",
      description: "Remove one configured MCP server and its non-secret registration metadata.",
      parameters: Object.freeze({
        type: "object",
        properties: { server: { type: "string" } },
        required: ["server"],
        additionalProperties: false,
      }),
      permission(input) {
        const server = systemString(input, "server", { required: true, maximum: 128 })!;
        return { id: "mcp.remove-server", effect: "system-write", resource: `mcp-server:${server}`, network: false };
      },
      async execute(input) {
        const server = systemString(input, "server", { required: true, maximum: 128 })!;
        return { server, removed: await trusted.removeServer(server) };
      },
    });
    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.disconnect",
      label: "Disconnect MCP",
      description: "Disconnect one MCP server or all current MCP transport sessions without deleting configuration.",
      parameters: Object.freeze({
        type: "object",
        properties: { server: { type: "string" } },
        additionalProperties: false,
      }),
      permission(input) {
        const server = systemString(input, "server", { maximum: 128 });
        return { id: "mcp.disconnect", effect: "system-write", resource: `mcp-connection:${server ?? "all"}`, network: false };
      },
      async execute(input) {
        const server = systemString(input, "server", { maximum: 128 });
        await service.disconnect(server);
        return { disconnected: server ?? "all" };
      },
    });
    bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "mcp.login",
      label: "Log in to MCP server",
      description: "Run the trusted OAuth login flow for a configured MCP server. Manual prompts require a local interactive terminal.",
      parameters: Object.freeze({
        type: "object",
        properties: { server: { type: "string" } },
        required: ["server"],
        additionalProperties: false,
      }),
      permission(input) {
        const server = systemString(input, "server", { required: true, maximum: 128 })!;
        return { id: "mcp.login", effect: "credential-write", resource: `mcp-server:${server}`, network: true };
      },
      async execute(input, context) {
        const server = systemString(input, "server", { required: true, maximum: 128 })!;
        const callbacks = oauthCallbacksForTurn(context.turn);
        return trusted.login(server, {
          ...callbacks,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      },
    });

  });
}

export default createMcpPlugin();
export * from "./contract.js";
export * from "./trusted-contract.js";
