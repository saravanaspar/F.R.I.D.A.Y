# ADR-0045: Resilient Personal-Agent Runtime

## Status

Accepted.

## Context

FRIDAY runs unattended, often through remote channels. A useful personal agent
must retain preferences without bloating prompts, expose attributable provider
usage, survive restarts without overlapping work, recover encrypted state, and
make every operational failure visible. Detached network work also cannot depend
on discovering a missing allowlist entry only after an expensive run fails.

## Decision

### Detached work keeps outbound network availability

Sandboxed model work and persistent kernels receive outbound network access by
default. FRIDAY does not impose a default egress allowlist or interpret a tool's
`network: false` metadata as a request to disable networking. Explicit callers
may request a network-disabled execution, but ordinary detached work remains
unrestricted. Permissions continues to authorize the action and use of
credentials. Rootless Podman, narrow mounts, resource/PID/file ceilings, a
read-only container root, dropped capabilities, and a pinned locally built image
remain the host boundary.

This supersedes the default network-off wording in ADR-0011 and ADR-0023. Those
records remain useful history, but they are not the current availability policy.

### Memory is a bounded relationship graph

Memory records normalized subject/relation/object facts with confidence,
frequency and timestamps. Retrieval is query-driven and injects only a bounded
relevant slice into a turn. Preferences can be listed and explicitly deleted;
secret-shaped keys are rejected. This supports recurring choices such as “the
usual” without replaying complete histories or sending the entire store to a
model.

### Usage separates measured billing from estimates

Observability persists provider response usage by session, root/parent agent,
subagent and detached job. Input, output, cache-read/cache-write tokens, cache hit
rates, provider-reported cost and currency are queryable through System from any
trusted channel. Provider-reported cost is authoritative actual data. Catalog
pricing may produce a separately labelled estimate and must never be represented
as a provider charge.

### Operational telemetry and authority audit remain distinct

Audit is the tamper-evident, non-retained authority ledger. Observability is the
bounded operational log/metric/trace/usage store. Failures in best-effort paths
must be reported to the redacting operational-error sink; a safe stderr fallback
exists until Observability is ready or if its sink fails. Silently swallowed
operational failures are prohibited and checked in CI.

### Replacement and recovery are coordinated

Session Jobs uses transactional SQLite state. A successor starts suspended,
quiesces the predecessor, then activates only after the authenticated handoff;
the predecessor is retired after final reply delivery. Runtime leases reject
accidental duplicate normal processes. Full-state backup/restore requires a
stopped runtime, verifies content hashes, and restores through atomic staging.
Vault additionally provides a passphrase-encrypted recovery kit for the master
key; recovery validates existing records before replacing a key.

### Distribution is host-native

The release builder produces one Node SEA executable per operating system/CPU,
embedding FRIDAY code, native ZeroMQ support and required runtime assets. Podman,
Python environments and integration-specific services remain explicit host
dependencies because silently installing privileged system software would break
the authorization boundary.

## Consequences

Remote detached tasks retain broad internet utility while host isolation and
credential authorization remain explicit. Prompt cost scales with relevant
memory rather than database size. Operators can attribute usage and distinguish
real provider charges from estimates. Crashes and failed handoffs remain visible,
state is recoverable, and a single host-native FRIDAY executable is releaseable.
