# ADR-003: Capability Composition Is Plugin-Owned

## Status

Accepted. Host-boundary wording amended by ADR-0038.

## Decision

The non-plugin host does not provide, resolve, or understand capabilities.

Capability composition is implemented by a normal FRIDAY plugin. Providers and
consumers share typed capability contracts, while implementations remain
replaceable.

A consumer may depend on a provider's contract/token, but must not import the
provider implementation solely to obtain behavior.

## Initial Implementation

Phase 5 uses an in-memory map registry installed by `plugins/capabilities`.
This implementation is intentionally small and replaceable.

The hard-coded activation list in `src/cli.ts` remains temporary and will be
replaced by config-driven plugin loading in Phase 6.
