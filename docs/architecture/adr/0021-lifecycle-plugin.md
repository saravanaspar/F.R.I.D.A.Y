# ADR 0021: Lifecycle plugin

## Status

Accepted and extended with two-phase takeover. Host-entrypoint wording amended by ADR-0038.

## Context

FRIDAY can now promote a verified candidate, publish an accepted generation, and persist a self-contained objective handoff for that generation. The remaining gap is process replacement: the running generation needs a safe way to launch a successor and know that the successor has actually started before the predecessor is allowed to stop.

This responsibility must not move into the non-plugin runtime host or `self-improvement`. The runtime host remains limited to generic plugin bootstrap, shutdown waiting, and disposal (ADR-0038). `self-improvement` owns candidate and handoff policy, not process transport. `execution` already owns low-level child-process primitives and is therefore the correct source of detached spawning and process-liveness checks.

The lifecycle boundary earns a top-level plugin because it has an independent capability contract, is reusable outside self-improvement (updates, reloads, recovery, future service supervision), creates an important process-safety boundary, and has substantial independent restart coordination behavior.

## Decision

Add a plain `lifecycle` plugin.

The first slice owns only generic process-replacement transport:

- derive a restart launch spec for the current Node/TSX runtime entrypoint;
- preserve TSX project discovery for restarted development processes;
- create private restart status records with collision-resistant request IDs and secret-token verification;
- launch a detached successor through the injected `execution` capability;
- pass restart metadata only through scoped environment variables;
- require the successor to explicitly acknowledge readiness;
- handle acknowledgement races where the successor becomes ready before the predecessor records its PID;
- reject wrong request IDs, tokens, and successor PIDs;
- detect spawn failure, early successor exit, timeout, cancellation, and concurrent restart attempts;
- preserve restart evidence on disk for diagnosis/recovery.

The plugin does **not** own generation IDs, candidate policy, evaluation, sessions, agent orchestration, scheduling, updates, rollback, or objective continuation.

Lifecycle now uses a two-phase handoff. The successor first authenticates and acknowledges **readiness** only after the complete configured plugin graph and durable restart preflight succeed. The predecessor then remains alive while the successor runs post-restart verification and finishes the durable owning-workflow handoff. Only after the successor acknowledges **takeover** may the predecessor return through normal runtime shutdown.

If the successor exits, times out, or explicitly rejects takeover after readiness, the waiting predecessor receives a durable failure record and remains available to execute known-good rollback. If the predecessor is already gone, the successor may launch the recovered known-good generation instead. Lifecycle owns only this generic process handshake; generation rollback policy remains outside it.

`execution` gains one narrow generic primitive, `launchDetachedProcess`, rather than duplicating `node:child_process` transport inside `lifecycle`.

## Consequences

A caller can safely distinguish process spawn, full-graph readiness, and final takeover. The old process no longer disappears during the dangerous window between successor bootstrap and post-restart verification. Self-improvement or another lifecycle consumer can therefore rollback in the still-running known-good predecessor when takeover fails, while lifecycle remains reusable outside self-improvement.
