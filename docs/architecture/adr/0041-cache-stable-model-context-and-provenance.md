# ADR-0041: Cache-Stable Model Context and Provider Runtime Provenance

## Status

Accepted.

## Context

FRIDAY combines stable instructions/tools/skills with volatile Memory and recent
turn context. Rebuilding the system prefix whenever Memory changes harms prompt
prefix reuse on providers that support caching. The model/provider subsystem
also has upstream open-source lineage that should be documented precisely rather
than described as either wholly copied from OpenCode or wholly original.

## Decision

Keep stable prompt material in the system prefix: base instructions, tool
selection, visible skill descriptions, project context and stable host doctrine.
Current Memory is injected ephemerally at model-call time into the first
host-prepended runtime-context block on the latest user turn. Memory content is
escaped as data, is not persisted as user transcript, and does not rewrite the
stable system prompt on every turn. User-authored later blocks with the same
name are not trusted as host context.

Keep the existing provider cache primitives: stable session IDs, provider cache
retention options/markers and normalized cache-read/cache-write token accounting.
Observability records input/output/cache-read/cache-write token counters and
model cost where provider usage reports them.

### Provenance

FRIDAY's Plugin Kernel, Turn Loop, Routing/Sessions/Memory composition, security
boundaries and system-action architecture are project-specific integration work.
The low-level model/provider transport has substantial lineage from Mario
Zechner's Pi AI provider design/code family; the repository's MIT LICENSE already
retains the Mario Zechner copyright notice. Pi's current public repository is
MIT licensed and exposes the same family of session-aware cache-retention and
provider abstractions.

OpenCode is used as a design/reference comparison, not as the source of FRIDAY's
Plugin Kernel or Turn Loop. Its current MIT-licensed LLM package documents
protocol-aware automatic cache placement over stable tools/system/latest-user
boundaries and normalized cache usage. FRIDAY adopts the compatible design
principle of keeping volatile contextual data out of the stable system prefix,
but does not replace the existing provider stack with OpenCode's LLM package.

## Consequences

Continual Memory may change every turn without needlessly changing the stable
system prompt. Provider caching remains protocol-owned, measurable and optional
rather than a home-grown response cache. Provenance is explicit enough to guide
future reuse/licensing decisions instead of relying on recollection.
