# ADR-0042: Channel-Bound Operational Alerts

## Status

Accepted.

## Context

Audit and Observability already support bounded on-demand System queries. Sending
every log line to Telegram/Discord would be noisy, expensive and potentially
leak unnecessary operational metadata. Users still need proactive notification
for meaningful conditions.

## Decision

Add an independent `alerts` plugin over durable Events metadata. A subscription
is created from a channel turn and is host-bound to that exact conversation. It
may filter event type/source/subject and has a bounded cooldown. Creation shows
the plan and uses Permissions before persistence.

Alerts registers a durable Events consumer and delivers only event id/type/
source/subject/timestamp metadata; it never forwards Event payload/data fields.
Delivery runs under the trusted `system:alerts` principal and remains an
explicit external-write action. Rules are privately persisted and bounded.

Raw Audit/Observability records remain query-on-demand through System. The
conversational default is the latest 10 records; explicit bounded limits are
honored. A request to analyze records may use the System presentation model over
the sanitized action result. Channels receives one logical response and owns
platform-aware message chunking.

## Consequences

Users can use normal channels as an operational console without turning them
into a raw log firehose. Alert policy remains replaceable and separate from
Events persistence, Observability telemetry and Audit integrity authority.
