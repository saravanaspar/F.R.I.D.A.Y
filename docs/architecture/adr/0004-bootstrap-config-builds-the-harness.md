# ADR-004: Bootstrap Config Builds the Harness

## Status

Accepted, with ordered activation superseded by ADR-0035 and host bootstrap mechanics superseded by ADR-0038.

## Decision

`friday.config.json` contains the list of plugin entrypoints that build a FRIDAY
harness. ADR-0035 later removed list position as the functional dependency
mechanism for declarative plugins.

The fundamental bootstrap reads only the `plugins` field, imports each
entrypoint, and activates it through the existing minimal plugin protocol.
Unknown fields are ignored by bootstrap so richer configuration can later be
owned by plugins rather than becoming host-bootstrap semantics.

Plugin entrypoints may be relative/absolute file paths, file URLs, or package
specifiers.

The bootstrap does not resolve capabilities, dependencies, lifecycle, model
configuration, permissions, or other plugin-owned concepts.
