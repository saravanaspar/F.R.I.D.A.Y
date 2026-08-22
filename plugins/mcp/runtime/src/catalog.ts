// Built-in MCP integrations we ship a skill package for. User servers go in the `mcpServers` setting instead.

import { getAuthAccess } from "./auth-access.js";
import { createMcpOAuthProvider, type McpOAuthConfig } from "./oauth.js";

export interface McpCatalogEntry {
	/** Matches the skill package import name. OAuth credentials are stored by opaque Vault reference. */
	server: string;
	label: string;
	url: string;
	oauth?: Omit<McpOAuthConfig, "server" | "url"> & { kind: "oauth" };
}

export const BUILTIN_MCP_CATALOG: readonly McpCatalogEntry[] = [
	{
		server: "linear",
		label: "Linear",
		url: "https://mcp.linear.app/mcp",
		oauth: { kind: "oauth", label: "Linear" },
	},
	{
		server: "notion",
		label: "Notion",
		url: "https://mcp.notion.com/mcp",
		oauth: { kind: "oauth", label: "Notion" },
	},
];

export function getCatalogEntry(server: string): McpCatalogEntry | undefined {
	return BUILTIN_MCP_CATALOG.find((entry) => entry.server === server);
}

/**
 * Register the built-in catalog's OAuth providers. Idempotent. Must be called
 * after any resetOAuthProviders() (e.g. ModelRegistry.refresh) since reset drops
 * everything but the model-provider built-ins.
 */
export function registerBuiltinMcpOAuthProviders(): void {
	const auth = getAuthAccess();
	for (const entry of BUILTIN_MCP_CATALOG) {
		if (entry.oauth?.kind !== "oauth") continue;
		const id = `mcp:${entry.server}`;
		if (auth.getOAuthProvider(id)) continue;
		auth.registerOAuthProvider(
			createMcpOAuthProvider({
				server: entry.server,
				label: entry.label,
				url: entry.url,
				scopes: entry.oauth.scopes,
				clientId: entry.oauth.clientId,
			}),
		);
	}
}
