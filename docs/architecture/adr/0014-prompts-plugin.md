# ADR 0014: Prompts plugin

## Status

Accepted.

## Decision

FRIDAY keeps model-facing system-prompt composition in the `prompts` plugin.

The plugin owns the pure formatting and ordering rules that turn already-resolved
host facts into a model system prompt: the working directory and conversation
log location, recursive-agent doctrine, installed-skill summaries, project
context files, supplemental host-owned sections, and additional guidance.

Skill discovery stays in `skills`; this plugin accepts structural skill records
and formats the model-visible XML section. Recursive child admission stays in
`subagents`/`rlm`; this plugin only renders the corresponding usage doctrine.
Execution environment provisioning stays in `execution`; the prompt advertises
kernel packages only when the host explicitly supplies that metadata.

The plugin does not discover files, mutate sessions, call models, run tools, or
own persistent memory. A later application/session composition layer gathers
those capabilities and passes their resolved state into `buildSystemPrompt()`.

## Boundary

`prompts` does not own:

- skill discovery, frontmatter parsing, or Python package preparation;
- RLM host-request handling or child-agent lifecycle;
- model/provider transport, authentication, or tool execution;
- session persistence, compaction, memory, or refinement;
- scheduling, sandboxing, permissions, or CLI orchestration.
