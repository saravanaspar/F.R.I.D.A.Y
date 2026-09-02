# ADR 0015: Persistent continual state belongs to the memory plugin

## Status

Accepted. Host-boundary wording amended by ADR-0038; public capability shape amended by ADR-0049.

## Decision

FRIDAY keeps durable reusable assistant knowledge in the dedicated `memory`
plugin. SQLite is the source of truth for file-backed memory. The plugin owns
its schema, transactional persistence, CRUD/versioning, local/global scope,
legacy JSON migration, passive refinement-event records, and lexical/vector retrieval indexes.

SQLite FTS5 provides local lexical retrieval over memory titles, content, paths,
and sources. The same SQLite database stores versioned local embedding vectors.
Search combines lexical and vector evidence into bounded hybrid results, while
callers that require deterministic lexical-only retrieval can disable the
embedding provider.

The default embedding provider is a zero-dependency deterministic local
token/subword vectorizer so memory never requires a remote embedding service.
The embedding boundary is injectable: a stronger local neural encoder can
replace that provider later without changing SQLite, the Memory capability, or
non-plugin host. The database keeps provider/version identity with each vector
and lazily backfills missing or stale embeddings after schema upgrades.

Existing `memory_state.json` data is imported automatically when `memory.sqlite`
does not yet exist. The legacy file is preserved as a backup after successful
migration. Corrupt SQLite or malformed legacy state fails closed rather than
silently replacing durable memory with an empty state.

The stored entry kinds remain generic: prompt notes, memories, reusable
Python-skill descriptions, and reusable subagent specifications. These records
are data only. They do not execute skills or subagents and do not change the
base system prompt.

## Boundaries

`memory` does not:

- own session transcripts or session compaction;
- store Vault credential values;
- call a model or decide when a memory should be created;
- generate, validate, or apply refinement proposals;
- compose the system prompt;
- own routing, scheduling, channels, tools, execution, or permissions.

Consumers use the Memory capability. Storage and retrieval implementation
remain private to the plugin.
