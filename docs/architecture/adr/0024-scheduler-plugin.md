# ADR 0024: Scheduler Plugin

## Status

Accepted and upgraded to the production scheduler boundary. Worker ownership amended by ADR-0038.

## Decision

Scheduling is an independent `scheduler` capability. It owns durable time-based task registration and execution policy: exact one-shot timestamps, fixed intervals, five-field cron expressions, IANA timezones, deterministic due ordering, retry/backoff, missed-run policy, execution leases, durable execution history, bounded concurrency, restart/crash recovery, cancellation state and an explicit in-process worker.

The scheduler does not own task implementations. Other plugins register typed task executors. Every claimed occurrence receives a stable idempotency key derived from the task and scheduled occurrence so an executor can make external side effects idempotent across lease expiry or process restart.

The scheduler also does not own generic Events, agent orchestration, provider APIs, sessions, self-improvement policy, or process-replacement transport. Scheduler answers **when** work is eligible to run; Events will separately answer **what happened**.

## Durable state

Scheduler state is plugin-owned at `state/scheduler/scheduler.sqlite` (or the configured FRIDAY state root). SQLite is used because production lease claims, concurrent workers and execution history require transactional state transitions that the initial JSON foundation could not provide safely.

The database uses foreign keys, a busy timeout, `synchronous=FULL` and WAL mode. The database file remains private (`0600`) inside the private scheduler state directory. On first open, an existing `scheduler_state.json` foundation is imported when no Scheduler database exists; the legacy file is retained so migration is non-destructive.

## Schedule semantics

Supported schedule kinds are:

- `once`: an exact timestamp.
- `interval`: fixed elapsed-time cadence, optionally anchored by `startAt`.
- `cron`: standard five-field `minute hour day-of-month month day-of-week` expressions evaluated in an explicit IANA timezone.

Cron matching is timezone-aware through the platform `Intl` timezone database. DST gaps naturally do not create nonexistent local-time executions; repeated local times can represent distinct UTC occurrences.

Recurring tasks choose one restart/missed-run policy:

- `coalesce` (default): execute one overdue occurrence, then advance to the next future cadence point.
- `catch-up`: replay missed occurrences in cadence order, bounded by `maxCatchUpRuns` per due-task pass.
- `skip`: when a worker starts, discard occurrences missed while it was not running and advance to the next future occurrence. A missed one-shot with `skip` is disabled.

## Reliability semantics

A task occurrence is claimed transactionally with a lease. A second Scheduler instance cannot claim the same task while the lease is valid. While an executor is active, Scheduler heartbeats the lease; if renewal fails or ownership is lost, the local executor is aborted rather than allowed to continue beside a competing claimant. If a process dies, heartbeats stop and the next worker marks the expired running attempt `abandoned` before reclaiming the same scheduled occurrence.

The reclaim receives the same idempotency key and a higher attempt number. This deliberately provides **at-least-once execution with a stable idempotency key**, not an impossible claim of exactly-once external side effects. Executors that mutate external systems must use the supplied idempotency key where the destination supports it, or implement an equivalent deduplication boundary.

Failures use bounded exponential retry. Retry attempts preserve the original occurrence identity. When an occurrence exhausts its retry budget, a one-shot is disabled and a recurring task advances according to its cadence/missed-run policy.

Cancellation disables future execution and aborts an active executor running in the same process through its `AbortSignal`. Removing a task with an active unexpired lease is rejected so durable execution history cannot be silently orphaned mid-run.

## Worker lifecycle

The plugin exposes an explicit in-process durable worker with bounded polling, tasks-per-tick, concurrency and lease duration. In the default FRIDAY composition, Scheduler registers a generic kernel graph-ready callback so the worker starts only after the complete configured plugin graph is ready, and registers kernel-owned cleanup so shutdown stops it deterministically. Focused tests or embedded compositions may construct the Scheduler plugin with worker auto-start disabled. There is no host `schedule worker` command (ADR-0038).

Stopping the worker stops new polling and waits for the current due-task pass, preserving graceful shutdown semantics. Expired leases and missed-run policy are reconciled when the worker starts.

## Rationale and trade-offs

The Scheduler passes the top-level plugin rule: it has an independent capability contract, is reusable/replaceable, owns a safety/reliability boundary, and has substantial independent state and behavior.

SQLite increases implementation complexity over the original JSON file, but it removes unsafe read-modify-write races and gives FRIDAY durable leases/history without introducing an external database service. Five-field cron is intentionally implemented inside the Scheduler boundary with no new dependency; this keeps deployment reproducible and is sufficient for the agreed scheduling requirements. Generic event triggers remain out of scope and belong to the separate Events plugin.
