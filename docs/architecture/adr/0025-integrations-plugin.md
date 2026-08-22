# ADR 0025: Integrations Plugin

## Status

Accepted. Host-boundary wording amended by ADR-0038..

## Decision

External services use one generic `integrations` capability. It owns adapter registration, non-secret connection metadata, connection lifecycle, action discovery, and permission-gated action invocation.

Provider-specific APIs are adapters, not additions to the non-plugin host and not hardcoded into the generic integration contract. Gmail, Slack, Google Calendar, Microsoft services, and future services can therefore be added independently.

Durable integration settings must not contain plaintext secrets. Connections store an opaque `credentialRef`; credential storage/resolution is intentionally outside this plugin.

## Rationale

External-service access is independently replaceable and reusable, has a meaningful network/security boundary, and has substantial provider/action lifecycle behavior. Keeping provider code outside the generic core prevents one service from shaping every integration.
