# ADR-0038: Remove Command Handler and Keep a Fixed Onboarding CLI

## Status

Accepted. Supersedes ADR-0001's Command Handler decision and the Command Handler
portions of ADR-0004 and ADR-0035.

## Context

FRIDAY originally kept a small `CommandHandler` as the only fundamental
component. Over time it accumulated two unrelated responsibilities:

1. startup transport: import configured plugin entrypoints and trigger generic
   graph finalization; and
2. a dynamic operator command registry used by plugins for `run`, scheduling,
   audit/observability queries, permissions management, MCP management,
   self-improvement, sandbox setup, and other operations.

Kernel v2, Turn Loop, Scheduler/System executors, and typed contribution points
now provide the runtime composition and operational-control mechanisms that did
not exist when ADR-0001 was written. Keeping a permanent command registry would
create a second application surface parallel to `turn.ingress`, `turn.executor`,
`system.action`, and plugin-owned capabilities. It would also require long-lived
workers to be started manually by terminal commands instead of being owned by
plugin lifecycle.

FRIDAY still needs a small first-run experience for non-secret defaults and
explicit host setup, but onboarding is not runtime orchestration.

## Decision

Delete `src/command-handler.ts` and its dynamic command registry.

The non-plugin host consists only of:

- `src/cli.ts`: a fixed onboarding utility;
- `src/runtime-env.ts`: bounded persistence/loading of non-secret runtime defaults;
- `src/onboarding.ts`: fixed first-run prompts plus explicit approved sandbox-image setup;
- `src/runtime.ts`: the long-lived process shell that loads runtime defaults,
  starts configured plugins, waits for SIGINT/SIGTERM, and disposes them; and
- `src/bootstrap.ts`: an ephemeral plugin-discovery session exposing only
  symbol-keyed finalizer/disposer/deferred-discovery hooks.

The bootstrap API has no string-keyed methods and no command registration.
`PluginContext` likewise has no command API. The capabilities plugin registers
Kernel v2 graph finalization and reverse shutdown through the generic bootstrap
hooks.

`npm run friday` and `npm run dev` launch `src/runtime.ts`. `npm run onboard`
launches the fixed onboarding CLI.

### Onboarding data

Onboarding may persist only non-secret defaults under `FRIDAY_HOME/runtime.env`:

- `FRIDAY_MODEL_PROVIDER`;
- `FRIDAY_MODEL_ID`;
- optional `FRIDAY_ROUTING_PROVIDER` + `FRIDAY_ROUTING_MODEL_ID`; and
- `FRIDAY_PERMISSION_MODE`.

The file is private and loaded before dynamic plugin import. Explicit process
environment values take precedence. Rerunning onboarding edits the same typed
defaults rather than creating a second configuration format. Unknown persisted keys fail closed. Secrets,
tokens, passwords, and OAuth credentials remain Vault-owned and must not be
written to `runtime.env`.

If the approved sandbox image is missing, onboarding may build it only after an
explicit interactive or command-line approval. It must not install privileged
host packages silently.

### Runtime operation migration

Removing the command registry must not remove subsystem behavior.

- Autonomy contributes `autonomy.run` through `system.action`.
- Self-improvement contributes `self-improvement.run` through `system.action`.
- Audit and Observability expose bounded diagnostic queries through their own
  `system.action` contributions.
- Permissions, Integrations, MCP, Sandbox, Events, Webhooks, Scheduler, Channels,
  and other owners expose only the bounded action/status surface appropriate to
  their contracts.
- Model-facing MCP/Integration operations remain `agent.tool` contributions.
- Scheduler, Events, configured Channels, and opt-in Webhooks own their
  long-lived worker/transport lifecycle. They start through the kernel's generic
  graph-ready lifecycle callback only after the complete graph is ready, and
  stop through kernel effects rather than terminal worker commands.

The System plugin remains only the replaceable selector/authorization boundary.
It cannot execute arbitrary host commands or import action-owner implementations.

### Self-improvement restart protocol

Lifecycle replacement previously relaunched the current entrypoint with a
literal `self-improve` positional so Command Handler could redispatch the
workflow. Replacement launches now pass only private process-handoff flags such
as `--resume-generation` or `--rollback-recovered`. The last-stage
self-improvement plugin validates those flags after normal graph activation and
registers successor readiness acknowledgement as its graph-ready callback, so
the predecessor is not told the successor is ready until earlier worker/transport
graph-ready callbacks have succeeded. These flags are not public onboarding
options or runtime commands.

## Consequences

Positive:

- FRIDAY has no permanent central command/application dispatcher.
- Runtime extension happens through typed plugin contracts instead of a second
  CLI registry.
- plugin workers/transports have one lifecycle owner and deterministic cleanup;
- the host cannot accidentally gain model/routing/scheduler/security semantics;
- onboarding remains small and can be removed after setup without affecting the
  running architecture; and
- self-hosted successors relaunch the actual runtime entrypoint rather than a
  terminal command dispatcher.

Costs:

- old terminal subcommands disappear;
- operator diagnostics/configuration must have explicit typed System actions or
  another plugin-owned UI/transport; and
- tests that formerly used Command Handler as a convenient assembly harness need
  a test-only bootstrap wrapper.

The test wrapper is not production API and intentionally exposes only plugin
activation/finalization/disposal.

## Alternatives rejected

### Rename Command Handler to Runtime

Rejected. Keeping the dynamic registry under another class name preserves the
same second orchestration surface and does not simplify the architecture.

### Move every old command into the onboarding CLI

Rejected. Onboarding would immediately become the new god CLI. It is limited to
first-run non-secret configuration and explicitly approved host setup.

### Put all operations directly in System

Rejected. System would become a central owner. Action implementation and
validation remain in the plugin that owns the capability; System only selects
and authorizes contributed actions.

### Keep worker commands for Scheduler/Events/Channels

Rejected for the default runtime. A running FRIDAY should own the lifecycle of
its enabled long-lived services. Starting them through an unrelated command
registry creates split ownership and fragile restarts.
