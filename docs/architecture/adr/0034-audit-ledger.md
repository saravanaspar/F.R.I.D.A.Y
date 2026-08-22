# ADR-0034: Tamper-evident audit ledger

## Status

Accepted. Operator-interface wording amended by ADR-0038.

## Context

FRIDAY now performs privileged workspace, external-service, credential, and system actions through action-aware Permissions. Observability records useful operational telemetry, but it is intentionally best-effort: rows are bounded, retention-trimmed, and telemetry failures must not alter business outcomes. Those semantics are unsuitable for security and authority history.

A security ledger must answer which trusted principal attempted a host-owned action, whether policy or the user allowed it, and when trusted channel authority changed. It must not trust model prose, expose secret values, silently drop required records, or share Observability's retention policy.

The top-level plugin boundary is justified because Audit has an independent capability contract, can be reused by future privileged subsystems, is an explicit integrity/safety boundary, and owns substantial storage, verification, query, and failure semantics.

## Decision

Add an independent `audit` plugin loaded after Lifecycle and before Permissions.

Audit owns private global state under `FRIDAY_HOME/audit`; it deliberately ignores mission-scoped `FRIDAY_STATE_DIR`. The state directory must not overlap the model workspace. The SQLite database, a separate 256-bit HMAC key, and an authenticated head anchor use private permissions. Existing state with a missing ledger/key/anchor, broad permissions, symlinks at protected files, database corruption, chain mismatch, or a ledger truncated behind its authenticated head fails closed.

Each append-only record contains a monotonic sequence, stable record ID and timestamp, category, stable host-owned action ID, outcome, compact actor identity, and bounded authority metadata such as effect/resource/network/mode/access/approval source. Free-form Permission `reason` prose is not persisted. Secret-shaped detail fields and inline bearer/credential values are redacted.

Records form an HMAC-SHA256 chain over canonical record content plus the previous record hash. A separate HMAC-authenticated head anchor stores the most recently durable sequence/hash so deleting a valid suffix of the SQLite ledger is detectable. The chain and anchor are verified on startup and again around each append. If SQLite committed a valid row but the process crashed before the head-anchor rename, startup may safely fast-forward the anchor only when the complete valid chain still contains the previously authenticated head. There is no retention trimming, clear, delete, or rewrite API.

The ordinary `audit` capability is read-only (`records`, `verify`, `status`). Mutation is isolated behind `audit.trusted.append`, and model-facing plugins are forbidden from importing that trusted capability.

Permissions remains the policy owner. Its implementation receives an injected audit sink rather than importing Audit. The composition entry requires `audit.trusted`. Authorization decisions are committed to Audit before an allowed decision is returned; if Audit cannot append, authorization fails closed. Denials and approval errors are also recorded. Trusted identity trust/revoke operations record an intent before mutation and a committed change afterward; a failure to append the committed change rolls identity state back when possible.

Audit's authoritative scope is the security/authority boundary: authorization attempts/decisions and trusted-identity authority changes. It does not claim to be execution-result history. Tool/MCP/integration completion, errors, timings, and domain outcomes remain with Sessions, Events, and Observability as appropriate. This keeps Permissions from becoming an executor and keeps `audit.trusted` out of model-facing plugin composition.

## Consequences

Security history survives ordinary telemetry rotation and process restarts. Operators can verify the full chain with the `audit.verify` System action and query bounded records with `audit.records`.

Audit increases authorization latency because chain verification occurs before each append. This is accepted for the current single-host scale in exchange for stronger tamper evidence and fail-closed semantics. If the ledger grows enough for full-chain verification to become material, checkpoint/anchor optimization can be introduced without weakening the contract.

The local HMAC key plus authenticated head anchor protect against database-only row mutation, replacement, and suffix truncation. They do not protect against an attacker who can replace the ledger, key, and anchor together with the FRIDAY user's filesystem authority. Stronger external anchoring or hardware-backed keys can be added later without merging Audit into Vault or Observability.
