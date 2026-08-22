# ADR-0008: Skills Plugin

## Status

Accepted for the current bootstrap generation.

## Context

Skill discovery and invocation are independently replaceable from prompt construction, agent orchestration, execution, sessions, and recursive-agent behavior. The existing implementation already provides mature filesystem discovery, ignore-file handling, frontmatter validation, Python-backed skill metadata, collision handling, skill-block parsing, and explicit skill-command expansion.

## Decision

Place those responsibilities in `skills` and expose them through the `skills` capability.

`skills` owns:

- recursive skill discovery and ignore-file handling;
- `SKILL.md` frontmatter parsing and validation;
- Markdown versus Python-backed skill classification;
- Python package/import metadata discovery;
- source metadata and collision diagnostics;
- skill-block parsing;
- explicit `/skill:<name>` expansion.

`skills` does not own:

- system-prompt construction or skill prompt formatting;
- Python package installation or kernel preparation;
- agent/session orchestration;
- RLM/subagent behavior;
- durable session storage;
- tool execution, sandboxing, or permissions.

Default user/project skill directories are supplied by callers. The plugin does not own FRIDAY-wide configuration paths.

## Consequences

The skill implementation can be reused by future prompt, session, and execution composition plugins without making those subsystems part of skill discovery itself. Python skill metadata is preserved while actual Python environment preparation remains an execution/composition responsibility.
