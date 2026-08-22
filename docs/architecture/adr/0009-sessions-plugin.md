# ADR 0009: Sessions plugin

## Status

Accepted.

## Decision

FRIDAY owns durable conversation/session state through the `sessions` plugin.
The plugin preserves the existing append-only JSONL tree model: every entry has
an id and parent id, the active leaf selects the current branch, and branching
moves the leaf without rewriting abandoned history.

The plugin owns:

- durable JSONL session files and reopening after process restart;
- session ids, headers, cwd metadata and session naming/lifecycle state;
- append-only message/settings/custom entries;
- tree traversal, labels and branch extraction;
- passive storage/projection of branch and compaction summaries;
- session listing/search metadata and session file/artifact deletion.

The plugin does not generate compaction summaries, run agents, dispatch queued
turns, schedule work, execute tools, load skills, or manage recursive/subagent
work. Those behaviors remain independently replaceable plugins.

The implementation package has no direct dependency on sibling FRIDAY packages.
Its FRIDAY adapter only publishes the `sessions` capability.
