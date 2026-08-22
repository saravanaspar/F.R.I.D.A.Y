# ADR-005: Model, Authentication, MCP, and Session Resources Are Separate Plugins

## Status

Accepted. Host-boundary wording amended by ADR-0038.

## Decision

Model discovery, provider configuration, streaming, reasoning, tool-call transport,
completion helpers, token/cost handling, and provider protocol behavior live inside
the `model` plugin.

Authentication flows and the OAuth provider registry live in `auth`.
MCP catalog/authentication integration lives in `mcp`. Session-scoped cleanup lives
in `session-resources`.

The non-plugin host has no knowledge of any of these subsystems.

Cross-plugin dependencies are resolved through FRIDAY capability contracts at plugin
activation time. The implementation packages do not import sibling FRIDAY packages directly.
Small dependency ports let plugin adapters inject capability-backed services without
rewriting the underlying behavior.

Provider/protocol identifiers required for interoperability remain inside the implementation;
they are not FRIDAY plugin identities.

## Dependency Graph

```text
session-resources
      |
      v
model
      |
      v
auth
      |
      v
mcp
```

The arrows represent capability requirements, not package imports.

## Test Boundary

FRIDAY's default test suite runs deterministic project and integration tests only.
Provider E2E/reference tests that require network access, credentials, or external
services are not part of the default promotion gate.

A deterministic boundary test rejects sibling `@friday/*` dependencies/imports from
implementation packages so this separation cannot silently regress.
