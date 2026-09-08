# ADR-0047: `friday` Runtime Command and Rerunnable `friday setup`

## Status

Accepted.

## Context

FRIDAY previously exposed onboarding as a visible first-class command even though
onboarding was only a fixed host bootstrap utility. That made installation feel
like a development repository rather than a normal installed agent and encouraged
users to think of setup as a one-time phase.

The runtime is a foreground daemon and must not double as a terminal chat client.
Human conversation belongs to authenticated Channels transports; local terminal
interaction is reserved for bounded setup and diagnostic operations.

## Decision

The installed command surface is:

- `friday` starts the long-lived runtime in the foreground;
- `friday run` remains a compatibility alias;
- `friday setup` is the rerunnable fixed setup/configuration surface;
- `friday onboard` is a deprecated compatibility alias for `friday setup`;
- stopped-runtime backup and Vault recovery commands remain fixed host operations.

On the first `friday setup`, the main model, any required provider credential,
the user's IANA wall-clock timezone, and at least one enabled ingress channel are
required. One exact sender on an enabled channel must also be explicitly confirmed
and persisted as the initial operator; `allowAll` never grants operator authority
implicitly. Runtime defaults are not published until those channel invariants are
satisfied. Routing reuses the main model and permission mode defaults to `ask`;
sandbox/Python and additional channel/bridge setup remain optional. Later
`friday setup` runs the full configuration manager and may keep existing values.

Runtime-owned operations such as MCP and skill installation are not copied into
the setup host. `friday` never reads terminal lines as conversational ingress,
whether it owns an interactive TTY or runs under a service manager. Configured
network channels are the only runtime human-ingress surface. `friday doctor`
provides bounded local diagnostics, while setup owns explicitly requested
configuration and provisioning.

Always-on execution is delegated to the host process manager. Linux systemd user
services are the recommended default. Because FRIDAY performs a two-process
replacement handoff, the supported unit follows the whole service cgroup; naive
single-main-process PM2 autorestart is not considered safe without an adapter
that understands FRIDAY runtime leases and handoffs.
FRIDAY does not add an internal daemon mode.

## Consequences

The common user flow becomes `install -> friday setup -> friday`. First setup is
still bounded, but it establishes a durable wall-clock timezone and at least one
real ingress path before the runtime is considered configured. Plugin operations
use the same typed runtime contracts through Telegram, Discord, or another
configured network channel; no local conversational channel exists.

A container image is not the default deployment because FRIDAY already uses
a pluggable SandboxProvider boundary for model-generated processes. A future
container deployment must explicitly define how the configured provider is
made available rather than relying on privileged nested containers.
