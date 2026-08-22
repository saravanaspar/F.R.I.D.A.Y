# ADR-0035: Declarative Plugin Kernel v2

## Status

Accepted. Command Handler/bootstrap portions are superseded by ADR-0038; ADR-0038 also extends the generic lifecycle with graph-ready callbacks.

## Context

FRIDAY already used plugins and typed capabilities, but `friday.config.json` also
encoded activation order. A plugin could call `requireCapability()` during
activation only because a human had placed its provider earlier in the config.
That makes the config file an implicit orchestrator and means adding or replacing
plugins can require editing unrelated ordering rules.

The architecture contract still requires Command Handler to remain the only
fundamental component and to stay ignorant of models, agents, dependency graphs,
capability resolution, routing, permissions, and every other subsystem.

## Decision

The existing `capabilities` plugin becomes FRIDAY's composition microkernel.
Command Handler still imports plugin entrypoints and dispatches commands only.
It gains one generic, symbol-keyed bootstrap-completion callback mechanism; it
does not inspect manifests or resolve dependencies.

All FRIDAY behavioral plugins use `definePlugin()` and declare:

- a stable plugin id;
- required service capabilities;
- optional service capabilities;
- provided service capabilities;
- an activation class (`normal` or the exceptional generic `last` stage).

Configured plugin discovery registers declarative plugins without executing their
functional activation. After discovery, the capabilities plugin validates the
complete graph and activates it according to capability dependencies. Config
position is not a dependency mechanism. The capabilities plugin itself remains
first because it installs the composition kernel; every later entry may be
ordered independently of its dependencies.

The kernel also owns generic extension mechanics:

- typed single-provider service capabilities;
- typed multi-provider contribution registries;
- typed hooks;
- plugin-scoped activation contexts;
- reversible effects and capability/contribution/hook cleanup;
- dependency-safe disposal with optional cascading;
- lifecycle states (`discovered`, `resolved`, `activating`, `ready`,
  `disposing`, `disposed`, `failed`);
- missing-provider, duplicate-provider, undeclared-provider and cycle detection.

Legacy function plugins remain executable for third-party compatibility, but
only declarative plugins receive graph resolution and ownership semantics. New
FRIDAY plugins must use the declarative protocol.

Declarative built-ins consume services through their plugin-scoped activation
context. Plugin-owned runtime helpers receive those dependencies by injection;
the global capability helpers remain legacy/test compatibility only.

`self-improvement` uses the generic `last` activation class. Its config position
is no longer special; this preserves the rule that successor readiness is
acknowledged only after the normal plugin graph is ready.

## Consequences

Adding a plugin that implements existing service/contribution/hook contracts
requires only the plugin and configuration entry. Existing consumers and a
central orchestrator do not change.

A genuinely new architectural extension type still requires defining its typed
contract once. Implementations after that can plug into the existing extension
point without editing the kernel.

Plugin activation failures roll back reversible effects from already activated
plugins in reverse activation order. A provider cannot be disposed while ready
dependents require it unless cascading disposal is explicitly requested.

The kernel remains an in-process trust boundary. Permissions, Vault, Audit and
sandbox rules continue to govern privileged behavior; declarative registration
does not grant authority by itself.

## Alternatives rejected

### Keep ordered configuration as orchestration

Simple, but every new dependency can force unrelated config-order edits and the
configuration remains a hidden application coordinator.

### Add a permanent application/orchestration plugin

Rejected because it would know the current plugin set and become a god plugin.
Orchestration/agent-loop behavior should itself be replaceable plugin behavior
composed from stable contracts.

### Move dependency resolution into Command Handler

Rejected because it violates the fundamental architecture rule. The Command
Handler executes a generic bootstrap completion callback without knowing that the
callback resolves a plugin graph.
