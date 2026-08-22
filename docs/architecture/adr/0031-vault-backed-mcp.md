# ADR-0031: Vault-Backed MCP Client Boundary

## Status

Accepted

## Context

FRIDAY already had an MCP catalog and OAuth-provider registration, but it could not connect to an MCP endpoint, discover remote tools, or invoke them. External-service credentials must not enter model-visible configuration or durable plaintext state, and remote tool calls must not bypass the host authorization boundary. MCP also evolves independently from Agent, Routing, Scheduler, Channels and Webhooks, so protocol transport belongs inside the MCP plugin rather than in a generic application orchestrator.

## Decision

Upgrade the existing `mcp` plugin rather than creating another integration plugin. MCP owns remote MCP server configuration, Streamable HTTP client lifecycle, MCP-specific OAuth discovery/login/refresh, tool discovery and remote tool invocation.

The ordinary `mcp` capability is secret-free. It exposes bounded server status, tool discovery, tool invocation and connection teardown. A separate `mcp.trusted` capability owns custom server registration/removal, OAuth login and opaque credential-reference lookup. Model-facing plugins must not receive `mcp.trusted`.

Built-in Linear and Notion servers are represented as immutable catalog entries. Custom server metadata is persisted in plugin-owned state. Durable MCP state may contain endpoint URLs, labels, auth mode, OAuth client identifiers/scopes and opaque `vault://` references, but never bearer tokens, access tokens or refresh tokens. Corrupt persisted MCP state fails closed.

Bearer secrets are consumed only inside a Vault trusted callback while preparing an authenticated request. OAuth access/refresh credentials are serialized as one Vault secret record; login creates or rotates that record, and token refresh rotates it in place. Public MCP status reports only whether a credential is configured, never the Vault reference or plaintext.

MCP uses bounded HTTP requests/responses, rejects redirects and unsafe remote HTTP endpoints, accepts loopback HTTP only for local non-production servers, supports JSON and Streamable HTTP SSE response bodies, bounds pagination/tool counts, and auto-negotiates the current stateless 2026-07-28 protocol era before falling back to the established initialize/session era only on definitive legacy signals. Legacy sessions reconnect once after expiry. Modern requests carry the protocol/client metadata envelope and method/name routing headers; multi-round-trip `input_required` results fail explicitly until FRIDAY gains a trusted user-input continuation owner. MCP-specific OAuth uses protected-resource metadata followed by authorization-server metadata, PKCE S256, resource binding, issuer validation, and dynamic client registration when a pre-registered client id is unavailable.

All MCP network activity passes through Permissions. The subsequent action-aware Permissions layer maps login to `credential-write`, discovery to `external-read`, and tool invocation to `external-write`. Every remote MCP tool call remains deliberately classified as potentially mutating external state; FRIDAY does not trust a remote server's tool annotations to weaken host authorization. This is conservative by design.

After a tool call completes, MCP publishes an `mcp.tool.called` Event containing only server id, tool name and error status. Tool arguments, tool results and credentials are not copied into Events. MCP does not invoke Agent directly and does not decide routing or scheduling.

## Consequences

External service operations now have a concrete MCP transport instead of only catalog metadata. Vault remains the only owner of secret-at-rest storage, Permissions remains the authorization owner, Events remains the occurrence-history owner, and Auth remains reusable OAuth infrastructure.

The generic historical `integrations` foundation is not extended for MCP protocol state. Human communication remains in Channels; arbitrary authenticated inbound HTTP remains in Webhooks; MCP owns outbound MCP protocol behavior.

The conservative tool-call authorization may prompt more often than necessary. Action-aware Permissions can distinguish MCP login, discovery and invocation without changing MCP transport ownership; reducing an individual tool below `external-write` would require separate host-trusted policy rather than remote annotations.
