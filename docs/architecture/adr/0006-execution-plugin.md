# ADR 0006: Execution is a separate plugin

## Status

Accepted.

## Decision

Persistent Python/Jupyter execution and low-level child-process lifecycle live in
`execution`. The implementation is adapted
only at FRIDAY boundaries.

The plugin owns Jupyter wire transport, persistent kernel lifecycle, cell execution,
stdout/stderr streaming, raw `display_data`, namespace snapshot/restore, process
execution, cancellation, TCP/IPC Jupyter transports, host-owned kernel launch
plumbing, and fork-server acceleration.

It does not own tool definitions, skill loading, durable sessions, RLM behavior,
agent orchestration, MCP, authentication, sandboxing or permissions. A higher-level
launcher may place the kernel inside an isolation backend without making execution
own that policy. Higher-level
MIME payload interpretation remains outside this plugin; it returns raw display
bundles instead.

Session-scoped cleanup is injected through the `session.resources` capability. Its implementation package does not import another FRIDAY package.
