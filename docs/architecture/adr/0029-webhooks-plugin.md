# ADR-0029: Webhooks Ingress Security Boundary

## Status

Accepted. Listener startup is integrated with graph-ready lifecycle when Webhooks is explicitly enabled.

## Context

FRIDAY needs inbound HTTP integrations whose senders are not human chat transports. A webhook is untrusted network input and must not directly invoke Agent, mutate sessions, or bypass durable event delivery. Authentication material must remain in Vault, and restart/retry behavior must not duplicate accepted occurrences.

## Decision

Add a top-level `webhooks` plugin. It owns HTTP ingress and the trust transition from an untrusted request to a validated Event.

The accepted pipeline is:

`HTTP limits -> route/method/content validation -> timestamp/nonce validation -> Vault-backed signature verification -> rate limit -> replay check -> JSON validation -> Events.publish -> durable nonce record`.

The first built-in route type is HMAC-SHA256. A trusted host registers a path, Event type/source, opaque Vault secret reference, bounded body/age/rate settings and header names. The signature covers `timestamp + "." + nonce + "." + raw body`. Secret bytes exist only inside `vault.trusted.consume`; signatures and secret material are never persisted or copied into Events.

Replay state and fixed-window rate counters live in plugin-owned SQLite with private permissions. A valid request publishes through Events using the verified nonce as the source-scoped dedupe key before the nonce is recorded. This ordering deliberately relies on Events' durable producer deduplication to close the crash window: if FRIDAY crashes after Event publication but before nonce persistence, a retry can only resolve to the same Event rather than create a duplicate. Once nonce state is durable, subsequent valid replays are rejected.

The public `webhooks` capability exposes only route metadata and server status. Listener control, route registration and direct ingress belong to `webhooks.trusted`. The listener is opt-in rather than implicitly enabled: the default production plugin starts it only when `FRIDAY_WEBHOOKS_ENABLED` is explicitly enabled, and then uses Kernel graph-ready startup so downstream consumers are ready before ingress begins. Binding defaults to loopback; externally reachable binding is an explicit trusted host choice.

Provider-specific schemes such as GitHub, Stripe, Slack or vendor JWT validation can be added later as trusted route authenticators/adapters without moving HTTP trust policy into Agent, MCP, Channels, Scheduler or Events.

## Consequences

Webhooks owns **how untrusted HTTP becomes a trusted occurrence**. Events owns persistence/delivery after acceptance. Scheduler continues to own time. Channels continues to own human communication transports, including platform-specific chat ingress. Webhooks never calls Agent directly.

At-least-once provider retries are safe because accepted requests have both webhook replay protection and Events producer deduplication. Rate limiting is persisted across restart. Invalid signatures, stale timestamps, malformed nonces, oversized bodies, unsupported media types and malformed JSON are rejected before Event publication.
