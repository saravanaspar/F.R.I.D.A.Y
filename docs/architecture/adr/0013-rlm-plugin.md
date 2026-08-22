# ADR 0013: RLM plugin

## Status

Accepted.

## Decision

FRIDAY keeps the model-facing recursive delegation protocol in the `rlm` plugin.

The plugin owns the `rlm.run`, `rlm.find_models`, `rlm.list_subagents`, and
`rlm.delete_subagent` host-request shapes, their input validation and stable wire
responses, plus the small Python module used inside an IPython kernel.

The Python side is intentionally a shim. It opens the generic `host.request`
comm, validates responses, exposes the callable `rlm` object, and never starts a
provider or child agent itself.

The TypeScript side adapts those requests to a parent-scoped subagent manager.
Model matching is injected from the `subagents` capability so RLM does not copy
child-model selection logic. Child admission, lifecycle, persistence,
cancellation, deletion, and runtime composition remain owned by `subagents`.

The tools plugin accepts generic kernel host handlers and forwards them to the
execution kernel. This is transport plumbing only: tools does not understand RLM
request types, and RLM does not own Jupyter transport.

## Boundary

`rlm` does not own:

- child-agent execution, registry persistence, depth policy, or cancellation;
- model/provider transport or authentication;
- Jupyter/ZeroMQ transport or process lifecycle;
- the IPython tool implementation;
- session storage or compaction;
- the agent loop, prompt composition, or skills;
- messaging, goals, scheduling, refinement, sandboxing, or permissions.

A consuming workflow may construct a parent subagent manager, install these host
handlers on that session's IPython tool, prepend the RLM Python package to the
kernel path, and inject the RLM guidance into the model prompt. That composition
is deliberately outside this plugin.
