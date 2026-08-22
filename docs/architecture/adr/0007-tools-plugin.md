# ADR-0007: Tools Plugin

## Status

Accepted for GEN-0.

## Decision

Coding tools are a separate plugin. The tools plugin owns tool schemas,
argument preparation, output truncation, file-edit semantics and the high-level
bash/IPython facades used by the agent loop.

Low-level process and Jupyter kernel transport remain in `execution`.
The tools runtime receives those facilities through an injected execution port.
The FRIDAY-facing adapter composes independent permission and sandbox capabilities
around bash, edit, and IPython without moving either policy into the runtime.

The initial tool set is:

- `bash` - streamed shell execution with cancellation, timeout and bounded output
- `edit` - exact/fuzzy multi-replacement file edits with atomic application
- `ipython` - persistent Python scratchpad calls using the execution kernel

## Boundary

The tools runtime does not own skills, RLM, durable sessions, MCP, OAuth,
agent orchestration, sandboxing or permission policy. Those remain separate
plugins. The top-level tools adapter consumes permissions and sandbox only to
compose secured tool instances.

## Consequences

Tool behavior can evolve independently from kernel/process transport. Policy
plugins can later authorize tool calls without rewriting tool implementations,
and the agent plugin remains generic because tools are passed to it through its
existing structural tool interface.
