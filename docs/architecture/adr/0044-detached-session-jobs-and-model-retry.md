# ADR-0044: Detached Session Jobs and Model-Request Retry

## Status

Accepted.

## Context

FRIDAY deliberately allows one external conversation (for example one Telegram
chat) to route each message independently to different persistent project
sessions, transient utilities, Scheduler, or System. The original Turn Loop
serialized the whole external conversation through completion. That prevented
context races, but a long Agent turn also blocked unrelated work from the same
human conversation and gave the user no durable notion of what was currently
running.

The required product behavior is multitasking without session corruption:

- acknowledge long-running project work immediately after it is durably accepted;
- allow different persistent sessions to execute concurrently;
- keep one persistent session serialized;
- route contextual follow-ups back to the right running session;
- list queued/running/retrying work;
- publish useful progress/retry/final status to the originating channel;
- cancel natural-language-selected work only after disambiguation and exact
  confirmation, without deleting the session;
- expose visible session/job transcripts without exposing hidden reasoning; and
- recover automatically from transient model-provider/network failures.

Existing FRIDAY primitives already cover most of the mechanics: Agent has safe
steering/follow-up queues, Subagents has a detached lifecycle registry, Scheduler
has bounded retry/state patterns, Channels has exact protected prompt/approval
interception, Sessions owns durable transcript/compaction state, Events owns
operational occurrences, and System owns generic conversational control.

For model retries, the ingested OpenCode donor provides a proven classifier and
backoff implementation in `packages/opencode/src/session/retry.ts` (MIT). It
retries rate limits, selected provider/server/network failures, honors
`retry-after-ms` / `Retry-After`, and otherwise uses jittered exponential backoff.
Its snapshot uses five retries. FRIDAY intentionally raises the request-level
ceiling to ten for unattended background work.

## Decision

### Add a Session Jobs capability, not a second session system

`session-jobs` owns durable execution lifecycle records (`queued`, `running`,
`retrying`, `completed`, `error`, `cancelled`) and per-persistent-session queues.
It requires Sessions and Events and optionally uses trusted Channels for protected
control. Sessions remains the sole transcript/compaction owner.

A job records only bounded identifiers, origin metadata, request/result previews,
current public status, retry counters and a bounded public progress timeline. The
runtime caps concurrently active jobs at 128 and retains up to 512 durable job
records, always retaining active work before pruning old terminal history.
The private registry is stored under stable `FRIDAY_HOME/session-jobs` in a
private `0700` directory and `0600` SQLite database. Each job transition is a
transaction, WAL recovery protects concurrent session queues, and retention is
pruned without rewriting unrelated records. The legacy JSON registry is imported
once and archived. Malformed, symlinked, broad-permission, or identity-mismatched
persisted state fails closed.

### Detach only persistent Agent work after durable admission

Turn Loop continues to serialize one external conversation through identity,
routing, executor selection, admission and immediate reply. When Session Jobs is
available and Routing selects `session/* + agent`, Turn Loop persists a job and
returns a started/queued acknowledgement instead of awaiting the Agent turn.
Session Jobs then invokes the already-selected executor asynchronously.

Different session queues may run concurrently. The same session queue is strictly
serial. For `session:new`, the Agent executor reports its concrete persistent
Session ID before the model call; Session Jobs binds that ID as a queue alias so
a follow-up routed to the newly visible session cannot race its first job.

If Session Jobs is absent, Turn Loop retains the previous synchronous
persistent-session behavior. Session Jobs therefore remains removable and Turn
Loop remains replaceable.

### Make active work read-only routing context

Routing may optionally read active Session Job metadata for host-generated
session candidates. It receives only bounded label/status/request-preview data
associated with a real Session ID. Routing cannot mutate/cancel jobs and still
cannot invent destination IDs. This improves phrases such as “also benchmark it”
while work is in progress without pinning the external chat to a session.

### Expose job control through System and protected Channels

Session Jobs contributes:

- `session.jobs.list` for current/recent work;
- `session.jobs.cancel` for natural-language active-job selection; and
- `session.transcript` for bounded visible user/assistant/progress history.

If cancellation matches multiple jobs, the exact originating channel principal is
asked to choose a numbered/job-id/unique-label candidate. The resulting exact job
is then confirmed through a bound protected approval before its AbortSignal is
triggered. Cancellation never deletes or archives the Session.

Transcript views include user text, assistant text, and explicit public progress
or retry entries. Individual transcript entries are bounded before presentation.
Assistant thinking/reasoning internals are not returned.

### Adapt OpenCode retry behavior at the model-request boundary

Agent model requests use an OpenCode-derived retry classifier and delay policy:

- retry HTTP 429 and transient 5xx/provider overload failures;
- retry common fetch/network/DNS/socket/timeout failures;
- honor `retry-after-ms` and `Retry-After` (seconds or HTTP-date);
- otherwise use 2s exponential backoff, factor 2, up to 25% jitter, capped at
  30s when no provider delay is supplied; and
- never retry context-window overflow or ordinary non-retryable client errors.

FRIDAY allows ten retries (one initial request plus up to ten retries). The wait
is AbortSignal-aware. Failed partial assistant attempts are removed from Agent
context and never persisted as completed transcript messages. Retry events are
public operational progress and feed Session Job status.

The retry loop wraps only the model request/stream that precedes a successful
assistant turn. Tool execution happens afterward, so this policy never blindly
replays a mutating tool that already completed.

## Consequences

A user can start PSCLS work, immediately start unrelated Project T work in the
same Telegram conversation, query both tasks, and continue sending messages.
FRIDAY keeps cross-session concurrency while preserving same-session ordering.
Users receive immediate admission certainty, meaningful retry/failure/final
notifications and inspectable visible transcripts.

The feature adds a small durable job registry and another asynchronous lifecycle,
so shutdown/restart state must fail closed rather than pretend interrupted work
completed. The current implementation marks interrupted active jobs as errors on
reopen; automatic whole-job resume is deliberately not attempted because prior
side effects may not be safely replayable.

The OpenCode retry implementation is adapted rather than copied wholesale: its
error classification/backoff semantics are reused, while FRIDAY owns the higher
ten-retry ceiling, AbortSignal integration, Agent event contract and Session Job
progress reporting.
