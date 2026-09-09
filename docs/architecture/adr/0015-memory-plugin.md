# ADR 0015: Persistent continual state belongs to the memory plugin

## Status

Accepted. Host-boundary wording amended by ADR-0038; public capability shape amended by ADR-0049. Retrieval and graph-storage details updated for v1.0.4.

## Decision

FRIDAY keeps durable reusable assistant knowledge in the dedicated `memory`
plugin. SQLite is the source of truth for file-backed memory. The plugin owns
its schema, transactional persistence, CRUD/versioning, local/global scope,
legacy JSON migration, passive refinement-event records, graph relations, and
lexical/vector retrieval indexes.

SQLite FTS5 provides local lexical retrieval over memory titles, content, paths,
and sources. Ordinary `MemoryStore.search()` is deterministic, lexical-only,
and side-effect-free. Routing and automatic Turn Loop memory context use this
path so recall cannot trigger neural inference or write maintenance state.

Explicit semantic recall uses the same SQLite database's versioned embedding
records. The default semantic provider is BGE-small-en-v1.5 INT8 ONNX, provisioned
explicitly with `friday setup memory` into private FRIDAY tooling. It produces
384-dimensional normalized vectors and runs offline at runtime. Missing or
unhealthy BGE tooling degrades explicit recall to lexical search; FRIDAY does
not silently switch to another embedding space. The legacy deterministic
`local-subword-v1` provider remains an injectable bootstrap/test provider rather
than the normal semantic backend.

Neural inference is not part of the durable Memory transaction. Entry
create/update commits first; `refreshEmbedding()` / `refreshEmbeddings()` attach
vectors afterward only when the exact entry version still matches. Search never
backfills vectors. A warm BGE worker is shared across Memory stores for bursty
requests, unloads after bounded inactivity, and is disposed when the Memory
plugin shuts down.

File-backed read consumers can open Memory in read-only mode. Existing SQLite
state is opened with SQLite read-only/query-only semantics and is never migrated
or chmod'd by the read path. Missing state is represented as an empty in-memory
view without creating directories or database files. Schemas old enough to need
a read-shape migration fail closed and require a writable maintenance/open first.

Graph relation identity is the semantic `(scope, subject, predicate, object)`
edge. Observation context is provenance metadata, not identity. Schema 4 merges
legacy context-split duplicates while preserving bounded context and reinforcing
occurrence/confidence history.

Existing `memory_state.json` data is imported automatically when a writable
Memory store opens a scope that has no `memory.sqlite`. The legacy file is
preserved as a backup after successful migration. Corrupt SQLite or malformed
legacy state fails closed rather than silently replacing durable memory with an
empty state.

The stored entry kinds remain generic: prompt notes, memories, reusable
Python-skill descriptions, and reusable subagent specifications. These records
are data only. They do not execute skills or subagents and do not change the
base system prompt.

## Compatibility and rollback

A writable v1.0.4 Memory open upgrades relation storage to SQLite schema 4.
F.R.I.D.A.Y v1.0.3 only understands schema 3 and cannot open a database after
that upgrade. Operators who need binary rollback must stop FRIDAY and back up
its state before first opening real Memory state with v1.0.4. Rolling the binary
back without restoring the pre-upgrade Memory database is not supported.

Read-only opens never perform this migration. A schema-3 database can therefore
be inspected through the v1.0.4 read-only path without changing it, while a
writable open remains the explicit migration boundary.

## Boundaries

`memory` does not:

- own session transcripts or session compaction;
- store Vault credential values;
- call the main reasoning model or decide when a memory should be created;
- generate, validate, or apply refinement proposals;
- compose the system prompt;
- own routing, scheduling, channels, tools, execution, or permissions.

Consumers use the Memory capability. Storage, embedding maintenance, and
retrieval implementation remain private to the plugin. System/Doctor surfaces
may expose bounded health and maintenance actions, but they do not gain access
to arbitrary Memory storage implementation details.
