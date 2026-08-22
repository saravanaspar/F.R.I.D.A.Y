# ADR-0030: AI Routing Boundary

## Status

Accepted

## Context

FRIDAY receives human messages from Channels, but an external chat thread is not itself a FRIDAY session. A message may belong to an existing persistent project session, start a new persistent session, be a transient utility/action, describe scheduled work, or request a FRIDAY system action. Natural-language selection among those destinations requires semantic classification, but the classifier must not become an execution or mutation boundary.

## Decision

Add a top-level `routing` plugin. Routing owns **WHERE an inbound human message should go** and publishes a separate execution profile describing **HOW the downstream owner should handle it**. Routing does not execute the request.

Every normal human message is classified by one disposable model call with no tools. The model receives only a sanitized current message and trusted Channel principal, a bounded in-memory tail from the same external conversation/thread, bounded read-only session candidates, and compact read-only global Memory matches. The router has no durable private store and does not write Memory or Sessions.

An external conversation is deliberately not pinned to one FRIDAY session. Each message is routed independently while recent channel context provides conversational continuity.

Session destinations are host-generated candidates. Existing sessions are exposed to the model with opaque `session:<id>` route IDs plus bounded labels/summaries; `session:new` is an explicit host-provided candidate for durable work that does not fit an existing session. The model may not invent a session ID. Other host-provided destinations are `transient:utility`, `scheduler`, and `system`.

The routing result separates destination from execution profile:

```text
destination:
  kind: session
  id: session:<opaque-id>
execution:
  profile: agent
confidence: 0.97
```

The host validates the exact destination/profile pair and confidence range before accepting the result. Malformed JSON, hallucinated destinations, mismatched execution profiles, provider failures, aborts and truncated responses fail closed.

Routing subscribes only to sanitized ordinary Channel messages. Credential-capture marker messages are ignored. Successful decisions are recorded as `routing.message.routed` Events containing message/principal identifiers, destination, execution profile and confidence but **not conversation text**. Failures publish a generic `routing.message.failed` occurrence without provider error text. Events therefore provide operational history without becoming a duplicate chat transcript.

Routing model selection uses `FRIDAY_ROUTING_PROVIDER` / `FRIDAY_ROUTING_MODEL_ID` when configured and otherwise falls back to the ordinary `FRIDAY_MODEL_PROVIDER` / `FRIDAY_MODEL_ID`. Bootstrap does not require model credentials; classification resolves model configuration lazily when an actual message arrives.

## Safety boundary

Routing has no Agent, Tools, Vault, Webhooks trusted API, MCP mutation, Permissions mutation, shell, edit, IPython, Scheduler mutation or Session mutation capability. It cannot satisfy the request it classifies. User text, prior channel text, session summaries and Memory snippets are untrusted model input, not instructions to the router host.

The classifier has no model tools. Read-only retrieval happens in trusted host code before the model request. Global Memory search is lexical-only in Routing so classification never creates or refreshes embedding records.

## Consequences

Channels continues to own transport trust and sanitization. Sessions owns durable conversation state. Memory owns durable reusable knowledge. Model owns provider transport. Events owns occurrence history. Scheduler continues to own WHEN work executes. Routing owns semantic destination selection only.

A later dispatch/orchestration slice can subscribe to the Routing capability's in-process routed-message stream and hand the original sanitized message to the selected session, transient utility, Scheduler or system-action owner. That later slice must preserve the destination/execution split rather than turning Routing into a god plugin.
