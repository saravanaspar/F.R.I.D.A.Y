# ADR-0039: Protected Channel Interactions and Typed Runtime Settings

## Status

Accepted.

## Context

After ADR-0038 removed the runtime command registry, operator actions moved to
typed plugin capabilities and `system.action`. Two user interactions still must
not pass through Routing or an LLM: approval responses and secret values.
Configuration also needs to be editable after onboarding without granting the
model arbitrary filesystem/environment mutation.

## Decision

Channels owns a pre-routing protected-interaction boundary keyed by the exact
`(channel, accountId, conversationId, senderId, threadId)` principal. At most one
credential/approval/prompt interaction may be pending for that principal.
Cancellation is a separate bounded watcher for an already-running operation.

- Permission approvals are sent back to the originating channel. Approval/deny
  replies are intercepted before `turn.ingress`; wrong principals cannot satisfy
  them. Local operations retain the terminal approver.
- Secret capture is one field at a time. In opaque-token mode the next message
  must contain only the token: labels, surrounding whitespace, prose and code
  fences are rejected rather than parsed. A trusted validator may test the
  value before Vault create/rotation. Secret plaintext is never returned to the
  model-facing turn path.
- Generic protected prompts support non-secret structured setup values (for
  example a custom model endpoint or OAuth manual value) without routing the
  answer through an LLM.
- Long-running operations may register an exact-principal cancel code which is
  intercepted before Routing.

`runtime-settings` is a normal plugin. It owns typed read/update operations for
main model, optional dedicated routing model and permission mode. The model can
request only those typed fields; it cannot write arbitrary environment keys.
A restart-required update is transactional: persist candidate settings, launch
a successor with explicit settings overrides removed, require full graph
readiness/takeover, then stop the predecessor only after the initiating reply is
delivered. On startup failure the previous settings are restored.

The onboarding CLI becomes a rerunnable configuration manager rather than a
one-shot installer. `runtime.env` remains non-secret and contains only bounded
runtime defaults. Custom OpenAI-compatible endpoint metadata and channel
non-secret transport settings are persisted in their owning private stores;
credentials are always Vault-owned.

## Consequences

Channel `ask` mode now has an actual conversational approval UX instead of
failing merely because no TTY is attached. Approval and credential replies
cannot accidentally be classified as normal requests. Runtime changes from
Telegram/Discord/etc. have the same validation and persistence path as
onboarding and remain rollback-safe.

The interaction layer remains deliberately non-semantic: it matches exact
pending state and fixed response forms. Natural language interpretation remains
in Routing/System/Agent.
