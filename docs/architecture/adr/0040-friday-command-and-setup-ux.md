# ADR 0040: `friday` Runtime Command and Rerunnable `friday setup`

Status: Accepted

## Context

FRIDAY previously exposed onboarding as a visible first-class command even though
onboarding was only a fixed host bootstrap utility. That made installation feel
like a development repository rather than a normal installed agent and encouraged
users to think of setup as a one-time phase.

The runtime also already owns a CLI Channel transport, but ordinary installed UX
should not require a separate host command dispatcher for plugin operations.

## Decision

The installed command surface is:

- `friday` starts the long-lived runtime in the foreground;
- `friday run` remains a compatibility alias;
- `friday setup` is the rerunnable fixed setup/configuration surface;
- `friday onboard` is a deprecated compatibility alias for `friday setup`;
- stopped-runtime backup and Vault recovery commands remain fixed host operations.

On the first `friday setup`, the main model, any required provider credential,
the user's IANA wall-clock timezone, and at least one enabled ingress channel are
required. Runtime defaults are not published until that channel invariant is
satisfied. Routing reuses the main model and permission mode defaults to `ask`;
sandbox/Python and additional channel/bridge setup remain optional. Later
`friday setup` runs the full configuration manager and may keep existing values.

Runtime-owned operations such as MCP and skill installation are not copied into
the setup host. When `friday` owns an interactive TTY, the Channels-owned CLI
transport reads terminal lines as ordinary trusted local ingress. Protected
credential capture switches that transport into hidden-input mode until capture
settles. Under a service manager there is no TTY reader, so configured network
channels remain the ingress surface.

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
continue to use the same typed runtime contracts regardless of whether the user
talks through the local terminal, Telegram, Discord, or another channel.

A container image is not the default deployment because FRIDAY already uses
rootless Podman as the sandbox boundary for model-generated processes. A future
container deployment must explicitly define how that sandbox boundary is
provided rather than relying on privileged nested containers.
