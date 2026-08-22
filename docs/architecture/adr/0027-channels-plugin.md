# ADR 0027: Channels and credential capture

## Status

Accepted.

## Decision

FRIDAY has one `channels` plugin for human communication transports. The supported transport set is CLI, Telegram, WhatsApp, Discord, Slack, Microsoft Teams, Google Chat, Signal, Email, and SMS. A transport chat is an ingress/egress address, not a FRIDAY session. Routing remains a later independent capability.

Channels is also the trusted credential-capture boundary because it is the last host-owned layer that sees inbound human input before any future router, model, Session, or Memory consumer. A capture request is scoped to the exact channel/account/conversation/sender/thread principal and expires quickly. The matching next text payload is written directly through `vault.trusted`; subscribers receive only a sanitized marker and Vault reference metadata. Failed captures never forward the attempted value. Ordinary messages and outbound messages are sanitized for recognizable credential patterns before publication/delivery.

The ordinary `channels` capability exposes transport status and sanitized inbound subscription only. `channels.trusted` owns lifecycle, sending, credential-capture requests, and trusted local ingress. Model-facing plugins may not import the trusted capability. Channel transports are not auto-started by the foundation plugin; the later routing host will subscribe first and then start them, preventing inbound messages from being consumed before a destination exists.

Network adapters default-deny unless an explicit sender/chat allowlist or explicit allow-all development setting is configured. Transport credentials are opaque Vault references rather than plaintext configuration.

Transport-specific boundaries:

- Telegram uses Bot API long polling with topic/thread normalization and bounded idle yielding.
- WhatsApp uses a localhost-only authenticated Baileys sidecar with private session storage outside the model workspace, bounded ingress queues, reconnect backoff, and a filtered child environment.
- Discord uses the Gateway WebSocket for inbound events and REST for outbound messages. Message Content intent must be enabled for ordinary message text.
- Slack uses Socket Mode for inbound Events API envelopes and the Web API for outbound messages. The app-level Socket Mode token and bot token are separate Vault refs.
- Signal connects only to a loopback `signal-cli daemon --http` endpoint, consuming `/api/v1/events` SSE and `/api/v1/rpc` JSON-RPC.
- Email polls IMAP and sends SMTP through a short-lived Python 3.11 stdlib bridge. The password is provided over stdin to each bridge invocation, never argv or environment, and historical mailbox contents are not replayed on initial startup.
- Microsoft Teams accepts Bot Framework Activity callbacks on a loopback-by-default HTTP listener, validates Bot Framework RS256 JWTs against OpenID/JWKS metadata, verifies tenant identity, learns only signed `serviceUrl` values, and uses client-credential OAuth for outbound activities.
- Google Chat accepts Google-authenticated HTTP message callbacks on a loopback-by-default listener, verifies the bearer token audience plus the documented Google Chat caller identity before publication, and uses a Vault-backed service-account credential for `chat.bot` REST sends.
- SMS uses Twilio's signed inbound webhook format and REST Message API. The public webhook URL is explicit because it is part of Twilio signature validation; the local listener remains loopback by default for reverse-proxy deployment.

Webhook-based channel listeners are intentionally platform-specific adapters, not FRIDAY's future generic `webhooks` plugin. The future `webhooks` capability remains for authenticated arbitrary external events that emit into the Events system rather than for human messaging transports.

## Provenance

The channel transport design is adapted from the MIT-licensed Hermes Agent gateway patterns, especially normalized platform events, allowlist-first network ingress, pluginized platform adapters, Email IMAP/SMTP polling, Teams Bot Framework messaging, Google Chat authenticated callbacks, Signal's signal-cli daemon integration, Twilio SMS, and the separation of WhatsApp transport mechanics from shared behavior. FRIDAY's implementation is written for its own TypeScript plugin/capability architecture; the Nous Research MIT notice is retained in the root LICENSE.
