# FRIDAY Activity Stream and Desktop-First Runtime Design

Date: 2026-09-17
Status: Proposed for implementation
Scope: Phase 6 foundation; activity/progress first, channel removal second, desktop product wiring third

## Context

FRIDAY already has the core pieces needed for a Codex-style live work experience:

- `AgentEvent` exposes agent/turn/message/tool lifecycle and model retry events.
- `TurnProgressUpdate` already carries a small public progress stream.
- Events are durable, sequenced, replayable, and already flow through the Client Gateway WebSocket.
- Session Jobs persist background work and can survive client disconnects.
- Desktop Phase 6 is explicitly in progress and the roadmap calls for streaming conversation with tool activity, approvals, jobs, artifacts, and a right-side Activity/Computer/Files/Terminal/Diff surface.

The missing piece is a provider-independent public activity protocol and UI state model. Today progress is sparse, model/provider behavior is inconsistent, and a long tool/model wait can look like silence.

The design follows the architecture used by Codex conceptually: host-owned turn/item lifecycle events drive the UI; optional provider-native public summaries enrich the stream; the UI keeps a visible Working state even when no new model text arrives.

## Goals

1. A turn is never visually silent while it is active.
2. Every tool-callable model can provide useful intermediate public summaries.
3. The guarantee does not depend on hidden chain-of-thought or provider-specific reasoning APIs.
4. Progress does not become part of ordinary conversation history unless explicitly represented as a final assistant message.
5. Progress survives reconnect through durable milestones while high-frequency deltas remain lightweight.
6. Desktop and Android consume the same protocol.
7. Long/stuck runs surface a clear stalled state and stop under existing runtime budgets rather than silently burning tokens.
8. Agent handoffs and group conversations can display nested per-agent activity without new orchestration semantics.

## Non-goals

- Do not expose raw chain-of-thought.
- Do not persist every token/delta/heartbeat.
- Do not create a second job queue or second conversation system.
- Do not add site-specific Computer progress logic.
- Do not couple the protocol to Electron; Android must be able to reuse it.

## Core architecture

### 1. Host-owned activity lifecycle

Turn Loop owns the canonical public lifecycle. It translates existing runtime events into typed `TurnActivity` records.

Durable milestone kinds:

- `turn.started`
- `phase.changed`
- `summary.added`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `approval.waiting`
- `approval.resolved`
- `computer.waiting`
- `retry.scheduled`
- `stall.detected`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`

Live-only kinds:

- `assistant.delta`
- `summary.delta`
- `tool.progress`

The existing Events store remains the replay source for durable milestones. Live-only activity is sent through the Client Gateway connection but is not written to durable Events storage.

### 2. Public activity envelope

```ts
interface TurnActivity {
  version: 1;
  turnId: string;
  sessionId?: string;
  jobId?: string;
  conversationId?: string;
  agentProfileId?: string;
  parentAgentProfileId?: string;
  sequence?: number;          // durable server event sequence when persisted
  activityId: string;
  kind: TurnActivityKind;
  phase?: TurnActivityPhase;
  title: string;
  detail?: string;
  tool?: {
    callId: string;
    name: string;
    displayName?: string;
  };
  attempt?: number;
  maxAttempts?: number;
  startedAt: string;
  occurredAt: string;
  elapsedMs?: number;
  terminal?: boolean;
}
```

No raw tool argument object is included by default. Tool-specific safe presentation can be contributed explicitly later.

### 3. Provider-independent summaries for all tool-callable models

FRIDAY adds a host-owned internal Agent tool named `report_progress` (final name can be `activity_update` if preferred). It is available to general tool-capable Agent runs and accepts only public, user-facing text:

```ts
{
  summary: string;       // one short public sentence
  next?: string;         // optional next action
  phase?: "inspect" | "plan" | "execute" | "verify" | "wait";
}
```

The tool:

- performs no external action;
- requires no user permission;
- emits `summary.added` activity;
- returns a tiny acknowledgement to the Agent;
- does not add the summary as an ordinary assistant conversation message;
- must never contain hidden reasoning, secrets, credentials, raw tool output, or private scratchpad content.

Agent instructions require a progress update at meaningful boundaries, not before every tool call:

- before the first substantial tool batch;
- after a meaningful discovery that changes the plan;
- before a long-running operation;
- when blocked/waiting/retrying;
- before verification/finalization if the run has been long.

This is the cross-provider equivalent of Codex/Claude-style commentary. It works anywhere tool calling works.

### 4. Provider-native public reasoning summaries

Provider-native summaries are optional enrichment, never the baseline guarantee.

The Model layer must distinguish public reasoning summaries from generic thinking content. Raw `thinking_delta` is not automatically client-visible.

Only providers that explicitly expose a user-displayable reasoning summary map it to a new model event such as:

- `reasoning_summary_start`
- `reasoning_summary_delta`
- `reasoning_summary_end`

Turn Loop maps those to live `summary.delta` plus a final durable `summary.added` milestone.

Providers without such an API continue to use `report_progress` and host lifecycle statuses.

### 5. Never-silent UI guarantee

The server does not need to emit periodic token-consuming messages.

Desktop/Android derive a local status clock from the latest active turn state:

- immediately on `turn.started`: `Working`;
- model request active: `Waiting for model · 7s`;
- tool active: `Running tests · 12s`;
- approval: `Waiting for approval`;
- Computer admission: `Waiting for Computer`;
- no new activity for a display interval: `Still working · 42s`;
- disconnected while active: `Connection lost · work may still be running`.

The elapsed indicator is client-local and costs zero model tokens and zero event-store growth.

The host additionally has a stall watchdog. A genuine lack of observable progress beyond runtime policy emits one `stall.detected` milestone and lets the existing bounded-run/loop-guard policy abort or recover. It is not a periodic heartbeat.

### 6. Tool activity presentation

Existing `AgentEvent` mappings expand from only start/end to:

- tool start;
- tool partial progress (`tool_execution_update`);
- tool completion/failure;
- model retry;
- turn lifecycle;
- assistant output start/delta/end;
- approval/wait transitions supplied by host capabilities.

Generic fallback labels are safe and concise:

- `Running Computer`
- `Reading files`
- `Running tests`
- `Waiting for approval`

Tools may later contribute a safe public activity formatter, but raw arguments are never rendered automatically.

### 7. Client Gateway protocol

The Client Gateway keeps the existing sequenced durable `event` envelope and adds a typed live activity message for non-durable deltas:

```ts
{
  kind: "activity";
  protocolVersion: 1;
  requestId: string;
  activity: TurnActivity;
}
```

Reconnect behavior:

1. client reconnects with its last durable event sequence;
2. gateway replays durable turn/activity milestones from Events;
3. client reconstructs active activity cards;
4. new live deltas resume without requiring historical delta replay.

The durable final state is always authoritative.

### 8. Desktop rendering

Phase 6 desktop uses the same activity twice:

- inline under the active user request as a compact Codex-style work transcript;
- mirrored in the right-side Activity panel as a richer timeline.

Inline example:

```text
You
Fix authentication and run the tests

FRIDAY
● Inspecting authentication flow                         4s
├ Read 6 files
├ Found token refresh path bypassing validation
├ Editing token validation
├ Running auth tests                                    9s
└ Verifying the fix

FRIDAY
Final answer...
```

Activity rows are not assistant chat messages and are not fed back into the model transcript.

For group chats, activity includes the Agent Profile identity so the UI can render:

```text
Developer  ● Running tests
Researcher ✓ Compared upstream behavior
Friday     ● Synthesizing results
```

This reuses existing Agent Profiles, Conversations, handoffs, and Session Jobs.

## Token and runaway protection

The activity feature must make runaway behavior cheaper, not more expensive.

Rules:

1. Client-local elapsed/`Still working` status uses zero model tokens.
2. `report_progress` is milestone-based, not per-tool-call chatter.
3. Repeated/no-progress Computer actions remain governed by the generic loop guard.
4. Turn Loop exposes current tool/model call counts and elapsed time to the activity surface.
5. Existing configured run/tool/token budgets remain authoritative.
6. `stall.detected` cannot itself trigger another model retry indefinitely.
7. A terminal no-progress condition produces one final failure activity and releases resources.

## Persistence and privacy

Persist:

- turn lifecycle milestones;
- final progress summaries;
- tool start/completion/failure metadata with safe names only;
- approval/wait state transitions;
- terminal errors in bounded/redacted form.

Do not persist by default:

- token-level assistant deltas;
- partial summary deltas;
- local elapsed timers;
- raw tool arguments/results;
- screenshots/pixels beyond current Computer policy;
- hidden thinking/chain-of-thought.

## Channel removal sequence

External Channels are removed only after client-first interaction ports replace the remaining `channels.trusted` dependencies.

Current channel-specific responsibilities still used by other plugins include:

- protected prompts/approvals;
- Session Job result delivery/resume;
- MCP OAuth/protected interaction callbacks;
- Self-Improvement approval/cancellation messaging;
- operational alerts/reminders;
- diagnostics presentation.

These must move behind a transport-neutral first-party interaction capability owned by the Client Gateway / Conversations boundary before deleting `plugins/channels`.

Target authority terminology becomes `client`/`device` rather than pretending first-party apps are messaging channels. The existing generic principal hashing can be migrated separately to avoid mixing security-identity migration with transport deletion.

## Roadmap order

1. Activity Stream / never-silent runtime (this design).
2. Client interaction port for approvals/questions/job delivery.
3. Remove external Channels and onboarding-channel code.
4. Finish Phase 6 production desktop wiring.
5. Agents / Groups / Conversations UI.
6. Inline activity transcript + Activity panel.
7. Approvals / Jobs / Artifacts.
8. Computer / takeover.
9. Terminal / Diff / Monaco / WebRTC / updater.
10. Stabilize shared protocol, then Phase 7 Android.

This remains aligned with the existing roadmap: Phase 6 is already the desktop client and explicitly targets replacement of normal messaging-channel use.

## Acceptance tests

### Runtime

- Every submitted client turn produces `turn.started` before model output.
- Every terminal path produces exactly one completed/failed/cancelled event.
- Tool start/update/end appear in order and carry no raw secrets.
- `report_progress` produces a public summary for any tool-callable provider.
- A provider with no reasoning-summary support still has useful progress.
- Generic thinking events are not leaked as summaries.
- A stalled run yields one stall milestone and terminates/recoveries under policy without indefinite model calls.

### Client Gateway

- Durable activity replays after disconnect from event sequence N.
- Live deltas are not duplicated into durable history.
- Reconnect reconstructs one active turn correctly.

### Desktop

- `Working` appears immediately after send.
- Elapsed/Still working continues locally with no network/model activity.
- Tool activity and summaries render inline and in Activity panel.
- Final answer replaces the active working state while preserving collapsed activity history.
- Group activity labels the correct Agent Profile.

### Privacy

- No hidden reasoning is exposed.
- No raw credentials/tool secret arguments are emitted.
- Progress summaries are user-visible/public by construction.

## Migration note

The repository snapshot used for this design has no `.git` metadata in the review environment, so this specification can be written here but cannot be committed from this environment. Apply it to the real checkout before implementation planning/commits.
