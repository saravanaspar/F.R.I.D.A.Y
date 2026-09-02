# ADR 0028: Events Plugin

## Status

Accepted as the durable occurrence and delivery boundary. Worker lifecycle was integrated with graph-ready startup by ADR-0038.

## Decision

Events is an independent `events` capability. It owns the immutable record of **what happened** and the reliability semantics for delivering those records to consumers. It does not own when work runs, human transport, webhook authentication, routing, sessions, model execution, external-provider APIs or automation policy.

An event contains a stable ID, monotonic database sequence, type, source, occurrence timestamp, publication timestamp, JSON data/metadata and optional subject, correlation, causation and source-scoped dedupe key. Producers may supply their own event IDs. Re-publishing the same explicit ID or `(source, dedupeKey)` with compatible content returns the original event without notifying live subscribers again; conflicting reuse fails closed.

Event payloads are JSON-only and bounded before persistence. Events are persisted before any subscriber is notified.

## Durable state

Events owns `state/events/events.sqlite` under the configured FRIDAY state root. SQLite is used for the same reason as production Scheduler state: durable concurrent claims, replay cursors and execution history need transactional state transitions without introducing an external broker/database service.

The database uses foreign keys, a busy timeout, `synchronous=FULL` and WAL mode. The state directory is private (`0700`) and the database file is private (`0600`). Startup fails closed if the database cannot be opened or its schema is newer than the runtime understands.

The immutable event log is append-only at this layer. Consumer cursors and delivery attempts are separate mutable records; replay never rewrites the event itself.

## Subscription models

Events supports two distinct subscription modes:

- **Live subscriptions** are in-process, best-effort callbacks for already-persisted new events. Subscriber exceptions are isolated and never roll back publication. They have no replay or crash guarantee.
- **Durable consumers** have a stable consumer ID, immutable exact-type filter, persistent cursor and retry policy. Re-registering the same consumer after restart binds a handler to its existing cursor. New consumers explicitly choose `latest` (default) or `beginning` start position.

Keeping these modes separate avoids pretending a process-local callback is durable.

## Delivery and idempotency semantics

Durable delivery is **at least once**. Each consumer/event pair receives a stable idempotency key:

`events:<consumerId>:<eventId>`

The key is preserved across retries, lease expiry, process restart and deliberate consumer rewind. A consumer that performs external side effects must use that key (or an equivalent destination-specific dedupe mechanism). Events does not claim exactly-once external side effects.

A delivery is transactionally claimed with a lease. While the handler runs, the lease is renewed. If renewal fails or ownership changes, the local handler is aborted. If a process dies, the next claimant marks the expired running attempt `abandoned` and retries the same consumer/event with a higher attempt number and the same idempotency key.

Failures use bounded exponential retry. Once the configured attempt budget is exhausted, the delivery becomes `dead-letter` and the consumer cursor advances so one poison event cannot permanently block later events. Delivery history remains durable for diagnosis/redrive decisions.

Cancellation of an in-process handler records `cancelled` without advancing the cursor, so the event remains eligible for a later delivery.

## Replay

The immutable log can be replayed by sequence range, exact event type(s), source, order and bounded limit. A durable consumer can also be rewound to an earlier successfully-scanned sequence when no delivery lease is active. Replay preserves the original event ID and therefore the stable consumer/event idempotency key.

Durable consumer type filters are immutable after creation. This makes cursor semantics deterministic: an event intentionally skipped because it did not match the original filter cannot silently become newly eligible after a configuration change. A materially different filter should use a new consumer ID.

## Worker lifecycle

The plugin owns a bounded delivery worker with configurable polling, deliveries-per-tick, concurrency, and lease duration. In the default FRIDAY composition the worker registers graph-ready startup, so downstream consumers have installed their handlers before polling begins; focused/test compositions may disable automatic worker start. Shutdown stops polling through the plugin lifecycle rather than an operator worker subcommand.

Process supervision remains outside Events.

## Boundaries and integration

Events passes the top-level plugin rule: it has a reusable capability contract, many independent producers/consumers, substantial durable behavior and a strong reliability boundary.

Current producers/consumers include Channels, Webhooks, MCP, Routing, Session Jobs, Turn Loop, Observability, and Alerts according to their own contracts. Those plugins keep ownership of their domain behavior. Additional plugins may use Events when they need durable occurrences or delivery, but Events neither imports those implementations nor directly invokes an Agent.

Scheduler remains **WHEN** something becomes eligible to run. Events remains **WHAT happened**. Webhooks (ADR-0029) authenticates and validates arbitrary external HTTP input before publishing a validated event; that network/security boundary does not belong here.
