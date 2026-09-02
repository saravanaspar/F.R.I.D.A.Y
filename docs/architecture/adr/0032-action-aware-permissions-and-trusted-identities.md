# ADR-0032: Action-Aware Permissions and Trusted Identities

## Status

Accepted. Operator-interface wording was amended by ADR-0038; network-prompt semantics are amended by ADR-0050.

## Context

The first Permissions slice authorized broad workspace read/write and network flags. That was sufficient to harden shell/edit execution, but it did not give policy a stable description of the concrete host operation being authorized. Human-readable `reason` text could not safely fill that role because model-controlled commands can influence it.

Channels also authenticate platform ingress and enforce sender/chat allowlists, but admission to a FRIDAY conversation is not the same security decision as authority to mutate a workspace, credentials, or an external service. A remote sender therefore needs an explicit authorization identity independent from Channel admission.

## Decision

Permissions remains one top-level plugin. No separate identity plugin is introduced.

Every authorization request now carries a host-owned action with a stable action id, an explicit effect (`workspace-read`, `workspace-write`, `external-read`, `external-write`, `credential-write`, or `system-write`), a bounded resource identifier, and an explicit network bit. `reason` remains explanatory UI text only and is never used to classify authority. The declared effect must agree with the requested read/write workspace access or the request fails closed.

The existing modes keep their workspace meaning while sensitive effects become explicit:

- `ask`: workspace reads are automatic; all mutations, external reads, credential changes, system writes, and network use require approval.
- `auto`: workspace writes may proceed automatically, but external reads/writes, credential changes, system writes, and network use still require approval.
- `full`: an operator identity may proceed without prompts for non-network operations, while the workspace containment boundary still applies; explicit network use always requires approval (ADR-0050).

Permissions also owns a private trusted-channel-identity registry under the stable FRIDAY home at `permissions/trusted_identities.json`; mission-scoped `FRIDAY_STATE_DIR` overrides are deliberately ignored for this authorization state. Records are keyed by the authenticated transport tuple `(channel, accountId, senderId)`; conversation and thread ids are deliberately excluded because they identify request context, not a person. State is atomically replaced and kept at mode `0600`; malformed state fails closed.

Trusted channel identities have either `read-only` or `operator` role. A `read-only` identity can never authorize a mutating effect, including in `full` mode. An unregistered channel identity cannot enter privileged authorization context. The local host operator and named host system services have host-issued identities.

Identity propagation uses host-owned `AsyncLocalStorage` through the separate `permissions.trusted` capability. Callers may enter local, named-system, or registered-channel context, but the public authorization request contains no principal field. Extra/model-supplied principal-shaped data therefore cannot replace the active host identity. Host-local ingress defaults to the local operator; remote conversational ingress must wrap work in `permissions.trusted.runAsChannel(...)` before invoking privileged capabilities.

`permissions` contributes explicit bounded System actions for trusted channel identities:

- `permissions.identities`
- `permissions.trust-channel`
- `permissions.revoke-channel`

The System executor selects these actions, while Permissions remains the authority and Audit-backed mutation owner.

MCP, Integrations, Bash, Edit, and IPython map their concrete operations to stable permission actions in host composition code. MCP tool calls remain conservatively classified as `external-write`; remote tool annotations are not trusted to reduce authority.

## Consequences

Permission policy can distinguish actual operations without parsing model prose. Channel access allowlists remain an ingress policy rather than an implicit privilege grant. Remote principals can be revoked or constrained to read-only authority independently of transport configuration.

The identity context is intentionally process-local while the trust registry is durable. Durable jobs that execute later must establish an appropriate named system or trusted user context at execution time rather than serializing an opaque runtime principal.
