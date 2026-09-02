# ADR-0033: Bounded Operational Observability

## Status

Accepted. Operator-interface wording was amended by ADR-0038; the separate Audit integrity boundary was subsequently delivered by ADR-0034.

## Context

FRIDAY now has durable Events, external network boundaries, autonomous execution, model providers, MCP, scheduling, and action-aware Permissions. Operational failures can cross several of these subsystems, but the repository has no common place to inspect structured logs, aggregate lightweight metrics, or correlate asynchronous work with traces.

Two existing mechanisms should be reused instead of duplicated. Events already records durable domain facts, and the Model runtime already exposes an injectable structured log sink. Neither is itself a general telemetry store: Events intentionally owns business occurrences and delivery semantics, while the Model logger is only a producer-side logging primitive.

Observability must also remain distinct from the Audit boundary (ADR-0034). Operational telemetry is volume-bounded and best-effort; security/audit evidence has separate integrity and retention semantics.

## Decision

Introduce `observability` as an independent top-level plugin loaded after Events and before Model. It exposes an `observability` capability plus bounded `system.status`/`system.action` contributions, but owns no execution, authorization, routing, scheduling, secrets, or business policy.

The plugin stores local telemetry in `observability/observability.sqlite` beneath the mission-scoped FRIDAY state root. The state directory is mode `0700` and the database is mode `0600`. Database corruption at startup fails closed rather than silently resetting telemetry.

The initial production telemetry surface is:

- structured `debug`/`info`/`warn`/`error` logs with bounded messages and fields;
- persistent counters and gauges;
- persistent distribution summaries (`count`, `sum`, `min`, `max`, average) rather than unbounded raw samples;
- completed spans with trace id, span id, parent relation, status, duration and bounded attributes;
- AsyncLocalStorage-backed trace context for nested synchronous or asynchronous host work;
- bounded log/span retention and a hard cap on distinct metric series.

Telemetry field sanitization is mandatory at the Observability boundary. Secret-shaped field names (authorization, cookies, passwords, secrets, tokens, API keys, credentials, private keys and client secrets) are redacted. Bearer values and common inline credential assignments are also redacted from string values. Errors record bounded name/message only and omit stacks by default.

Observability subscribes to the Events live stream and records only Event envelope metadata (`id`, sequence, type/source/subject and correlation/causation ids). Event `data` is deliberately excluded so Observability cannot become a second copy of potentially sensitive domain payloads. Event-derived counters are best-effort live telemetry; Observability does not register a durable Events consumer because missed telemetry during downtime is acceptable and must not add backpressure to business delivery.

The Model composition plugin reuses the existing `@friday/model` `setLogSink` hook when the Observability capability is present. The Model runtime package remains sibling-independent; focused hosts that compose Model without Observability reset the sink to its existing default behavior.

Runtime write failures in logging/metrics/spans do not fail the business operation. They increment in-process dropped-telemetry counters reported by `observability status`. Query methods and startup initialization still surface explicit errors. This asymmetry keeps telemetry from becoming an availability dependency while making startup corruption visible.

## Consequences

FRIDAY gains one coherent local operational surface for recent logs, aggregate metrics and trace correlation without introducing an external collector dependency. Existing Events and Model logging are reused rather than copied.

Retention means Observability is intentionally unsuitable as a compliance/security ledger. Audit is a separate integrity-sensitive boundary (ADR-0034). More producers can adopt the capability incrementally without changing the non-plugin host or importing an Observability implementation package.
