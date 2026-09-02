# ADR 0027: Channels and credential capture

## Status

Accepted. Ingress/transport lifecycle was integrated with graph-ready startup by ADR-0038.

## Decision

FRIDAY has one `channels` plugin for human communication transports. The supported transport set is Telegram, WhatsApp, Discord, Slack, Microsoft Teams, Google Chat, Signal, Email, and SMS. A transport chat is an ingress/egress address, not a FRIDAY session. Routing is an independent capability. The runtime intentionally has no conversational CLI transport; terminal interaction is limited to fixed setup, onboarding compatibility, doctor, and bounded stopped-runtime maintenance.

Channels is also the trusted credential-capture boundary because it is the last host-owned layer that sees inbound human input before routing, model, Session, or Memory consumers. A capture request is scoped to the exact channel/account/conversation/sender/thread principal and expires quickly. The matching next text payload is written directly through `vault.trusted`; subscribers receive only a sanitized marker and Vault reference metadata. Failed captures never forward the attempted value. Ordinary messages and outbound messages are sanitized for recognizable credential patterns before publication/delivery.

The ordinary `channels` capability exposes transport status and sanitized inbound subscription only. `channels.trusted` owns lifecycle, sending, and credential-capture requests. Model-facing plugins may not import the trusted capability. In the current composition, enabled transports start through the Kernel graph-ready lifecycle only after the complete plugin graph and ingress consumers are installed; lifecycle handoff preserves deterministic predecessor/successor startup and shutdown ordering.

Network adapters default-deny unless an explicit sender/chat allowlist or explicit allow-all development setting is configured. Transport credentials are opaque Vault references rather than plaintext configuration.

Provider acknowledgements and durable transport checkpoints occur only after the normalized message is admitted by the host, or intentionally filtered. Providers without implemented media retrieval emit a text notice and an empty attachment list; they never expose a download handle that the Artifacts boundary cannot resolve.

Transport-specific boundaries:

- Telegram uses Bot API long polling with topic/thread normalization, retrievable media, and inline approval buttons whose callback is acknowledged only after protected-action admission.
- WhatsApp uses a localhost-only authenticated Baileys sidecar with private session storage outside the model workspace, bounded durable ingress queues, reconnect backoff, a filtered child environment, and text-code approvals. Media currently produces an explicit unsupported-retrieval notice.
- Discord uses the Gateway WebSocket for inbound events and REST for outbound messages and approval buttons. Admitted Gateway sequence/session state is privately checkpointed so reconnect and process restart resume after the last durable message rather than the last merely received dispatch. Message Content intent must be enabled for ordinary message text.
- Slack uses Socket Mode for inbound Events API/interactive envelopes and the Web API for outbound messages and Block Kit approval buttons. ACK is withheld until durable admission. The app-level Socket Mode token and bot token are separate Vault refs; file shares produce an explicit unsupported-retrieval notice.
- Signal connects only to a loopback `signal-cli daemon --http` endpoint, consuming `/api/v1/events` SSE and `/api/v1/rpc` JSON-RPC. Approval is text-code based and media produces an explicit unsupported-retrieval notice.
- Email polls IMAP and sends SMTP through a short-lived Python 3.11 stdlib bridge. The password is provided over stdin to each bridge invocation, never argv or environment, and historical mailbox contents are not replayed on initial startup. UID checkpoints are bound to mailbox configuration and IMAP `UIDVALIDITY`, and advance only after admitted batches. Approval is text-code based and attachments produce an explicit unsupported-retrieval notice. Parsed `From` identity is not a substitute for upstream SPF/DKIM/DMARC enforcement.
- Microsoft Teams accepts Bot Framework Activity callbacks on a loopback-by-default HTTP listener, validates Bot Framework RS256 JWTs against OpenID/JWKS metadata, verifies tenant identity, learns only signed `serviceUrl` values, and uses client-credential OAuth for outbound activities and Adaptive Card approvals. Signed routes are privately persisted with tenant/client fingerprinting, a seven-day TTL, and a bounded entry count; attachments produce an explicit unsupported-retrieval notice.
- Google Chat accepts Google-authenticated HTTP message/card callbacks on a loopback-by-default listener, verifies the bearer token audience plus the documented Google Chat caller identity before publication, and uses a Vault-backed service-account credential for `chat.bot` REST sends and Cards v2 approval buttons. Attachments produce an explicit unsupported-retrieval notice.
- SMS uses Twilio's signed inbound webhook format and REST Message API with text-code approvals. The public webhook URL is explicit because it is part of Twilio signature validation; the local listener remains loopback by default for reverse-proxy deployment, and MMS produces an explicit unsupported-retrieval notice.

Webhook-based channel listeners are intentionally platform-specific adapters, not FRIDAY's generic `webhooks` plugin (ADR-0029). The `webhooks` capability handles authenticated arbitrary external events that emit into the Events system rather than human messaging transports.

## Provenance

The channel transport design is adapted from the MIT-licensed Hermes Agent gateway patterns, especially normalized platform events, allowlist-first network ingress, pluginized platform adapters, Email IMAP/SMTP polling, Teams Bot Framework messaging, Google Chat authenticated callbacks, Signal's signal-cli daemon integration, Twilio SMS, and the separation of WhatsApp transport mechanics from shared behavior. FRIDAY's implementation is written for its own TypeScript plugin/capability architecture; the Nous Research MIT notice is retained in the root LICENSE.
