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
- a bounded static trust scan over instruction-bearing Skill text/code before a
  discovered Skill is exposed to the model. The scan fails closed on prompt
  policy-override/exfiltration language, FRIDAY host-boundary tag forgery,
  symlinked roots/files/directories, destructive command/procedure primitives,
  and explicit secret exfiltration instructions. Discovery never follows a
  symlinked Skill path. Binary/static assets are not instruction-bearing and do
  not consume the bounded instruction-text scan budget. Safety guidance that
  explicitly says not to perform those actions remains valid.

`skills` does not own:

- system-prompt construction or skill prompt formatting;
- Python package installation or kernel preparation;
- agent/session orchestration;
- RLM/subagent behavior;
- durable session storage;
- tool execution, sandboxing, or permissions.

Default user/project skill directories are supplied by callers. The plugin does not own FRIDAY-wide configuration paths.

Passing the static trust scan does not turn a Skill into host policy. A visible
Skill is procedural user/project configuration: it may teach a repeatable
workflow, but core/host policy, Permissions, secret handling, tool contracts,
and the current user objective retain precedence. This permits trusted clean
project Skills without granting arbitrary repository text system-level
authority.

## Consequences

The skill implementation is reusable by the current Turn Loop/prompt/session/execution composition without making those subsystems part of skill discovery itself. Python skill metadata is preserved while actual Python environment preparation remains an execution/composition responsibility. Project/user Skills that fail trust scanning are diagnosed and omitted rather than advertised and then relying on the model to ignore them.
