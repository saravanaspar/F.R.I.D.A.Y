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

On first-run bootstrap, the routing/system model is mandatory while the main
reasoning model may be configured later. For providers that require an API key and
expose a supported model-list endpoint, setup establishes the credential before
model selection, asks the provider for the models visible to that credential, and
intersects those ids with FRIDAY's generated runtime descriptor catalog. The
provider is authoritative for current availability; FRIDAY remains authoritative
for execution metadata/capabilities. A stale descriptor that the credential can no
longer access is therefore not offered, and an explicitly supplied unavailable id
fails closed. Providers without a safe discovery adapter retain catalog selection.

The user's IANA wall-clock timezone and at least one enabled ingress channel are
also required. One exact sender on an enabled channel must be explicitly confirmed
and persisted as the initial operator; `allowAll` never grants operator authority
implicitly. Runtime defaults are not published until the mandatory router/channel
invariants are satisfied. Permission mode defaults to `ask`; sandbox/Python and
additional channel/bridge setup remain optional. Later `friday setup` runs the full
configuration manager and may keep existing values.

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
still bounded, but it establishes a usable routing model, a durable wall-clock
timezone and at least one real ingress path before the runtime is considered
configured. When live model discovery is supported, credential capture precedes
model choice so provider retirements/ACLs are reflected during setup rather than
first appearing as runtime 404/authorization failures. Plugin operations
use the same typed runtime contracts through Telegram, Discord, or another
configured network channel; no local conversational channel exists.

A container image is not the default deployment because FRIDAY already uses
a pluggable SandboxProvider boundary for model-generated processes. A future
container deployment must explicitly define how the configured provider is
made available rather than relying on privileged nested containers.
