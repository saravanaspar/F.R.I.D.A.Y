# ADR-001: Command Handler Is the Only Fundamental Component

## Status

Superseded by ADR-0038.

## Context

FRIDAY is a plugin-composed autonomous assistant and self-hosting agent harness.
Putting models, tools, lifecycle, memory, permissions, execution, sessions,
or orchestration into a central runtime would make those choices permanent.

## Decision

FRIDAY has exactly one fundamental component: the Command Handler.

The Command Handler performs minimal bootstrap and CLI dispatch only.

Everything else is implemented through plugins.

## Consequences

Positive:
- major behaviors remain replaceable
- self-improvement can evolve subsystems independently
- config can construct different harnesses
- external architecture does not become foundational

Negative:
- plugin composition is harder
- dependency/failure boundaries must be carefully designed
- badly designed plugins can create hidden coupling

## Guardrail

Any proposed expansion of Command Handler responsibilities requires explicit
architectural justification showing why the behavior cannot reasonably exist
as a plugin.
