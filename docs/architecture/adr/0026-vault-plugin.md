# ADR-0026: Vault Plugin and Secret-Consumption Boundary

## Status

Accepted. Trusted-consumer and credential-capture integrations were subsequently delivered by Channels, Auth, MCP, Webhooks, Voice, and the fixed setup surfaces.

## Context

FRIDAY needs long-lived credentials for model providers, MCP services, human
channels, webhooks, and other external systems. Those credentials must not be
stored in session history, continual memory, integration settings, prompts,
tool output, or model-readable files. A model may request that a credential be
added or rotated, but it must not be able to read a stored credential back.

This is both a reusable capability and a security boundary, so it belongs in a
separate top-level plugin rather than in Auth, MCP, Channels, or the Command
Handler.

## Decision

FRIDAY provides a `vault` plugin loaded after the sandbox boundary and before
credential-consuming plugins.

The plugin intentionally exposes two different capability objects:

- `vault` is metadata-only and safe for model-adjacent composition. It can
  normalize a `vault://...` reference, check existence, inspect metadata, and
  list metadata. It has no secret write or secret consumption methods at
  runtime.
- `vault.trusted` is host-only. It can create, rotate, delete, and consume a
  secret. There is deliberately no `getSecret`, `readSecret`, or equivalent
  method. Secret bytes are borrowed only inside a trusted callback and the
  mutable plaintext buffer is zeroed immediately after the callback completes
  or throws.

References use a bounded path-like form such as
`vault://gmail/account-1/oauth`. They are identifiers, not secret values.
Metadata is restricted to the reference, a bounded kind identifier, version,
and timestamps so an arbitrary metadata field cannot accidentally become a
second secret store.

The initial local backend stores an AES-256-GCM encrypted state file and a
random 256-bit master key in the Vault directory. The directory is mode `0700`;
the key and encrypted state files are mode `0600`. Existing files with broader
permissions, corrupt state, malformed records, authentication failures, or
symlinked key/state paths fail closed. Encrypted record authentication binds
identity, kind, version, and timestamps as associated data.

Vault state must not overlap the selected model workspace. Existing symlink
ancestors are resolved when checking that boundary, and the boundary is
revalidated before every filesystem operation so a mutable path cannot be
retargeted into the model workspace after store construction. This prevents a
model-controlled workspace mount from directly exposing Vault files. The
sandbox remains the OS isolation boundary; Vault does not mount credentials
into Bash or IPython containers.

`FRIDAY_HOME` determines the stable Vault root (`$FRIDAY_HOME/vault` or
`~/.friday/vault`). Mission-specific `FRIDAY_STATE_DIR` does not relocate the
Vault because credentials must not silently move with a self-improvement or
scheduled-task state directory.

## Consequences

A copied `vault.json` does not contain plaintext credentials. The local master
key is stored on the same host under private filesystem permissions, so this
backend is **not** protection against compromise of the same trusted OS user or
root. A future backend may use an OS keyring, hardware-backed key, or external
secret manager without changing the capability boundary.

Auth, MCP, Channels, Webhooks, and Voice consume Vault-backed credentials through
trusted host composition rather than exposing plaintext to model-facing code.
Model-facing routing and tools receive only ordinary metadata-safe capability
surfaces. Plugin-boundary tests prevent model-facing subsystems from importing
trusted Vault authority.

Credential capture is implemented through protected channel/setup interactions:
secret payloads are intercepted before model, Session, or Memory persistence and
replaced with sanitized markers or opaque Vault references. Ordinary
model-visible conversation input is still not a secret-entry surface.
