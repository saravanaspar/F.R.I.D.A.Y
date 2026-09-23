# FRIDAY Activity Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-independent Codex-style activity stream so every active FRIDAY turn visibly reports lifecycle, tool, retry, wait, and public-summary progress without exposing hidden reasoning or feeding progress back into model history.

**Architecture:** Turn Loop owns canonical `TurnActivity` lifecycle state. Durable milestones are written to Events and therefore replay through the existing Client Gateway event stream; live-only deltas are emitted through a new Turn Runtime live-activity subscription and forwarded as `kind: "activity"` WebSocket messages. A host-owned `report_progress` tool gives every tool-callable model a safe public-summary mechanism, while provider-native reasoning summaries are opt-in enrichment only when the model adapter can prove the content is a public summary. Desktop renders the same activity inline and in the Activity panel; elapsed/"Still working" timers are local-only and consume no model tokens.

**Tech Stack:** TypeScript, Node 22, FRIDAY plugin capabilities/contributions, Events SQLite ledger, WebSocket Client Gateway, `@friday/client-protocol`, Electron desktop renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-activity-stream-desktop-first-design.md`

## Global Constraints

- A turn must never be visually silent while active.
- Do not expose raw chain-of-thought or generic provider `thinking_*` content.
- Do not persist token-level deltas, summary deltas, client-local timers, raw tool arguments/results, or hidden thinking.
- Activity rows are UI/runtime telemetry, not assistant conversation messages and must not be fed back into the model transcript.
- Desktop and Android must consume the same protocol; do not couple the wire schema to Electron.
- `report_progress` is milestone-based and user-visible by construction; it must not contain secrets, credentials, private scratchpad content, or raw tool output.
- Existing run/tool/token budgets and Computer loop guards remain authoritative.
- `stall.detected` emits once and must not itself create an unbounded retry loop.
- No site-specific Computer activity logic.

---

## File Structure

**Create**
- `plugins/turn-loop/activity.ts` — canonical runtime activity publisher, durable/live routing, redaction/bounds, per-turn terminal invariant.
- `plugins/turn-loop/activity-tool.ts` — host-owned `report_progress` Agent tool plus prompt guidance.

**Modify**
- `packages/client-protocol/src/index.ts` — shared `TurnActivity` wire types and `ClientActivityMessage` validation.
- `packages/client-protocol/test/protocol.test.ts` — activity encode/decode/validation tests.
- `plugins/turn-loop/contract.ts` — activity sink/subscription contracts and tool execution context activity port.
- `plugins/turn-loop/turn-loop.ts` — turn lifecycle milestones, terminal exactly-once handling, live activity subscription.
- `plugins/turn-loop/index.ts` — register activity tool/prompt contribution and expose runtime subscription.
- `plugins/turn-loop/agent-executor.ts` — map Agent events, waits, retries, assistant deltas, and tool progress to activity.
- `plugins/agent/runtime/src/model-types.ts` — add explicit public reasoning-summary stream events; leave generic thinking private.
- `plugins/model/runtime/src/types.ts` — mirror public reasoning-summary event type.
- `plugins/model/runtime/src/providers/openai-responses-shared.ts` — map OpenAI Responses reasoning-summary SSE events to the new public summary events instead of generic thinking events.
- `plugins/clients/contract.ts` — activity message subscription shape.
- `plugins/clients/index.ts` — subscribe authenticated connections to Turn Runtime live activity.
- `plugins/clients/transport.ts` — forward live activity over WebSocket without putting it in Events.
- `apps/desktop/src/gateway.ts` — accept `activity` messages in addition to durable `event` messages.
- `apps/desktop/src/core.ts` — activity reducer/state model and local elapsed/still-working derivation.
- `apps/desktop/src/main.ts` — render compact inline transcript and Activity panel timeline.
- `apps/desktop/src/styles.css` — activity transcript/panel states.

**Tests**
- `test/turn-loop.test.ts`
- `test/turn-loop-agent.test.ts`
- `test/client-gateway.test.ts`
- `test/desktop-client.test.ts`
- `test/desktop-client-infrastructure.test.ts`
- `plugins/agent/runtime/test/agent-loop.test.ts`
- provider tests covering OpenAI Responses summary mapping.

---

### Task 1: Define the shared activity protocol

**Files:**
- Modify: `packages/client-protocol/src/index.ts`
- Test: `packages/client-protocol/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `TurnActivityKind`
  - `TurnActivityPhase`
  - `TurnActivity`
  - `ClientActivityMessage`
  - `ClientProtocolMessage` including `ClientActivityMessage`

- [ ] **Step 1: Write the failing protocol tests**

Add tests that construct and decode a valid live activity message and reject malformed kinds, blank IDs/titles, invalid protocol versions, negative elapsed time, and raw unbounded objects in places where only the fixed schema is allowed.

Use this representative message:

```ts
const activity = {
  version: 1 as const,
  turnId: "turn-1",
  sessionId: "session-1",
  activityId: "activity-1",
  kind: "tool.started" as const,
  phase: "execute" as const,
  title: "Running tests",
  tool: { callId: "call-1", name: "bash", displayName: "Shell" },
  startedAt: "2026-09-17T17:00:00.000Z",
  occurredAt: "2026-09-17T17:00:01.000Z",
  elapsedMs: 1_000,
};

const message = {
  kind: "activity" as const,
  protocolVersion: 1 as const,
  requestId: "req-1",
  activity,
};
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
npm --prefix packages/client-protocol test -- --runInBand
```

Expected: FAIL because `ClientActivityMessage` and activity decoding do not exist.

- [ ] **Step 3: Add the protocol types and strict decoder branch**

Use these exact unions:

```ts
export type TurnActivityKind =
  | "turn.started"
  | "phase.changed"
  | "summary.added"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "approval.waiting"
  | "approval.resolved"
  | "computer.waiting"
  | "retry.scheduled"
  | "stall.detected"
  | "assistant.delta"
  | "summary.delta"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled";

export type TurnActivityPhase =
  | "routing"
  | "preparing-context"
  | "calling-model"
  | "reasoning"
  | "waiting-for-tool"
  | "running-tool"
  | "waiting-for-approval"
  | "waiting-for-computer"
  | "retrying"
  | "verifying"
  | "finalizing";

export interface TurnActivity {
  readonly version: 1;
  readonly turnId: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly conversationId?: string;
  readonly agentProfileId?: string;
  readonly parentAgentProfileId?: string;
  readonly sequence?: number;
  readonly activityId: string;
  readonly kind: TurnActivityKind;
  readonly phase?: TurnActivityPhase;
  readonly title: string;
  readonly detail?: string;
  readonly tool?: Readonly<{ callId: string; name: string; displayName?: string }>;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly startedAt: string;
  readonly occurredAt: string;
  readonly elapsedMs?: number;
  readonly terminal?: boolean;
}

export interface ClientActivityMessage {
  readonly kind: "activity";
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly activity: TurnActivity;
}
```

Bound user-visible text to 1,000 characters for `title`, 4,000 for `detail`, and IDs to the same bounded opaque limits already used by the client protocol. Do not add generic `Record<string, unknown>` metadata to this activity envelope.

- [ ] **Step 4: Run protocol tests and verify GREEN**

Run:

```bash
npm --prefix packages/client-protocol test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client-protocol/src/index.ts packages/client-protocol/test/protocol.test.ts
git commit -m "feat(activity): define client activity protocol"
```

---

### Task 2: Add a host-owned Turn Activity publisher

**Files:**
- Create: `plugins/turn-loop/activity.ts`
- Modify: `plugins/turn-loop/contract.ts`
- Test: `test/turn-loop.test.ts`

**Interfaces:**
- Consumes: `TurnActivity` from `@friday/client-protocol`, `EventsService`.
- Produces:

```ts
export type TurnActivityListener = (activity: TurnActivity) => void;

export interface TurnActivityPublisher {
  emit(input: Omit<TurnActivity, "version" | "activityId" | "startedAt" | "occurredAt"> & {
    readonly activityId?: string;
    readonly startedAt?: string;
    readonly occurredAt?: string;
    readonly durable?: boolean;
  }): TurnActivity;
  subscribe(listener: TurnActivityListener): () => void;
}
```

Extend `TurnRuntimeService` with:

```ts
subscribeActivity(listener: TurnActivityListener): () => void;
```

Extend `TurnExecutionContext` with:

```ts
readonly activity?: ((activity: TurnActivity) => Promise<void>) | undefined;
```

- [ ] **Step 1: Write failing publisher/lifecycle tests**

Add tests proving:
- `turn.started` is published before executor/model work;
- durable activity is stored as `turn.activity` Events data containing the public activity envelope;
- live-only activity is delivered to subscribers but absent from Events replay;
- a completed turn emits exactly one terminal `turn.completed` activity;
- an exception emits exactly one terminal `turn.failed` activity;
- abort emits exactly one terminal `turn.cancelled` activity;
- terminal activity cannot be emitted twice for the same turn.

- [ ] **Step 2: Run targeted test and verify RED**

```bash
npx vitest run test/turn-loop.test.ts
```

Expected: FAIL because Turn Runtime has no activity publisher/subscription.

- [ ] **Step 3: Implement `plugins/turn-loop/activity.ts`**

Use `randomUUID()` for activity IDs, an in-memory listener set for live delivery, and `EventsService.publish()` only when `durable !== false`.

Durable event format:

```ts
events.publish({
  type: "turn.activity",
  source: "turn-loop",
  subject: `turn:${activity.turnId}`,
  data: activity as unknown as EventJsonValue,
  correlationId: activity.turnId,
});
```

Maintain one terminal flag per active turn in Turn Loop rather than in a global permanent map. Terminal kinds are `turn.completed`, `turn.failed`, and `turn.cancelled`; attempting a second terminal emission is ignored and reported as an operational warning, not thrown into the user turn.

- [ ] **Step 4: Wire lifecycle emission in `plugins/turn-loop/turn-loop.ts`**

Emit:
- `turn.started` immediately after normalization/admission and before routing;
- `phase.changed` at routing, execution, reply/finalization boundaries only when the phase materially changes;
- terminal activity from the same success/failure/abort branches that already publish `turn.completed`/`turn.failed`.

Do not replace existing durable `turn.received`, `turn.executed`, `turn.delivered`, or `turn.completed` Events; activity is a public presentation layer over the existing authoritative execution ledger.

- [ ] **Step 5: Run targeted test and verify GREEN**

```bash
npx vitest run test/turn-loop.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/turn-loop/activity.ts plugins/turn-loop/contract.ts plugins/turn-loop/turn-loop.ts test/turn-loop.test.ts
git commit -m "feat(activity): publish turn lifecycle milestones"
```

---

### Task 3: Add the provider-independent `report_progress` tool

**Files:**
- Create: `plugins/turn-loop/activity-tool.ts`
- Modify: `plugins/turn-loop/contract.ts`
- Modify: `plugins/turn-loop/index.ts`
- Test: `test/turn-loop-agent.test.ts`

**Interfaces:**
- Extend `AgentToolExecutionContext` with:

```ts
readonly reportActivity?: ((activity: Readonly<{
  summary: string;
  next?: string;
  phase?: "inspect" | "plan" | "execute" | "verify" | "wait";
}>) => Promise<void>) | undefined;
```

- Tool schema:

```ts
{
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 500 },
    next: { type: "string", minLength: 1, maxLength: 500 },
    phase: { type: "string", enum: ["inspect", "plan", "execute", "verify", "wait"] },
  },
  required: ["summary"],
  additionalProperties: false,
}
```

- [ ] **Step 1: Write failing tests**

Add tests proving:
- every normal Agent run includes a `report_progress` tool;
- invoking it emits one durable `summary.added` activity and returns a tiny acknowledgement;
- the summary is not appended as an assistant/user/tool-visible conversation message beyond the ordinary tool result acknowledgement;
- summaries over 500 chars or containing control characters are rejected;
- a muted Agent notification preference may suppress proactive delivery policy but does not alter the activity data model for direct first-party client turns.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/turn-loop-agent.test.ts -t "report_progress"
```

Expected: FAIL because the tool does not exist.

- [ ] **Step 3: Implement the tool and prompt section**

Register one host-owned tool contribution named `report_progress`. Its execution must call only `context.reportActivity` and return:

```ts
{
  output: { accepted: true },
  content: [{ type: "text", text: "Progress update recorded." }],
}
```

Add a host-policy prompt section that says, in substance:
- report at meaningful boundaries only;
- report before the first substantial tool batch, after plan-changing discoveries, before long operations, while blocked/retrying, and before long-run verification;
- write only concise public user-facing summaries;
- never include hidden reasoning, credentials, secrets, raw tool output, or private scratchpad material.

Map the five tool phases to public phases:
- inspect → `preparing-context`
- plan → `routing`
- execute → `running-tool`
- verify → `verifying`
- wait → preserve the current waiting phase if known, otherwise `calling-model`

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/turn-loop-agent.test.ts -t "report_progress"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/turn-loop/activity-tool.ts plugins/turn-loop/contract.ts plugins/turn-loop/index.ts test/turn-loop-agent.test.ts
git commit -m "feat(activity): add public progress reporting tool"
```

---

### Task 4: Map Agent lifecycle and tool progress to activity

**Files:**
- Modify: `plugins/turn-loop/agent-executor.ts`
- Test: `test/turn-loop-agent.test.ts`

**Interfaces:**
- Consumes `TurnExecutionContext.activity` and existing `AgentEvent`.
- Produces only safe, bounded `TurnActivity` messages.

- [ ] **Step 1: Write failing mapping tests**

Cover this exact mapping:

```text
model request / assistant stream begins -> phase.changed(calling-model)
tool_execution_start                -> tool.started
tool_execution_update               -> tool.progress (live-only)
tool_execution_end success          -> tool.completed
tool_execution_end error            -> tool.failed
model_retry                          -> retry.scheduled
Computer wait callback               -> computer.waiting
```

Assert that raw `args` and raw `result` never appear in emitted activity.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/turn-loop-agent.test.ts -t "activity"
```

Expected: FAIL because executor emits only legacy `TurnProgressUpdate`.

- [ ] **Step 3: Implement the mapping**

Keep existing `TurnProgressUpdate` delivery for Session Jobs compatibility during this task. Add activity in parallel and derive generic safe labels from tool names with a small formatter:

```ts
function toolDisplayName(name: string): string {
  if (name.startsWith("computer_")) return "Computer";
  if (name === "bash" || name === "process") return "Shell";
  if (name.includes("test")) return "Tests";
  return name.replaceAll("_", " ");
}
```

Do not inspect tool arguments to build the label.

`tool.progress` details may include only bounded text already explicitly emitted by the tool progress callback; if the partial result is not a short string/public status object, emit only the generic title with no detail.

- [ ] **Step 4: Emit wait and stall milestones from existing policy points**

Reuse the existing Computer wait callback for `computer.waiting`. Reuse the existing generic tool-turn ceiling and Computer no-progress loop guard to emit one durable `stall.detected` immediately before their existing terminal failure response. The activity event must not trigger another model request.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run test/turn-loop-agent.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/turn-loop/agent-executor.ts test/turn-loop-agent.test.ts
git commit -m "feat(activity): map agent and tool lifecycle"
```

---

### Task 5: Separate public reasoning summaries from private thinking

**Files:**
- Modify: `plugins/agent/runtime/src/model-types.ts`
- Modify: `plugins/model/runtime/src/types.ts`
- Modify: `plugins/model/runtime/src/providers/openai-responses-shared.ts`
- Modify: `plugins/agent/runtime/src/agent-loop.ts`
- Test: provider test covering OpenAI Responses shared parsing
- Test: `plugins/agent/runtime/test/agent-loop.test.ts`
- Test: `test/turn-loop-agent.test.ts`

**Interfaces:**
- Add these model events:

```ts
| { type: "reasoning_summary_start"; contentIndex: number; partial: AssistantMessage }
| { type: "reasoning_summary_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "reasoning_summary_end"; contentIndex: number; content: string; partial: AssistantMessage }
```

- [ ] **Step 1: Write privacy regression tests**

Prove that:
- generic `thinking_delta` never emits client activity;
- `reasoning_summary_delta` emits live `summary.delta`;
- `reasoning_summary_end` emits one durable `summary.added`;
- OpenAI Responses `response.reasoning_summary_text.delta` maps to `reasoning_summary_delta`, not generic `thinking_delta`.

- [ ] **Step 2: Run RED**

Run the provider-specific test plus:

```bash
npm --prefix plugins/agent/runtime test
npx vitest run test/turn-loop-agent.test.ts -t "reasoning summary"
```

Expected: FAIL because no public-summary event type exists.

- [ ] **Step 3: Implement event separation**

In `openai-responses-shared.ts`, the SSE events named `response.reasoning_summary_*` are explicit public summaries. Emit the new `reasoning_summary_*` events for those. Do not change providers that only expose generic hidden thinking.

Update Agent loop forwarding so the new events are carried in `message_update`, but do not automatically convert generic `thinking_*` to summary activity.

- [ ] **Step 4: Map public summary events in Agent Executor**

Accumulate bounded public summary text per content index. Emit `summary.delta` live-only for deltas and one final durable `summary.added` when the summary ends. Cap a single persisted summary at 4,000 chars.

- [ ] **Step 5: Run GREEN**

```bash
npm --prefix plugins/agent/runtime test
npx vitest run test/turn-loop-agent.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/agent/runtime/src/model-types.ts plugins/model/runtime/src/types.ts plugins/model/runtime/src/providers/openai-responses-shared.ts plugins/agent/runtime/src/agent-loop.ts plugins/agent/runtime/test test/turn-loop-agent.test.ts
git commit -m "feat(activity): expose only public reasoning summaries"
```

---

### Task 6: Stream live activity through Client Gateway

**Files:**
- Modify: `plugins/clients/contract.ts`
- Modify: `plugins/clients/index.ts`
- Modify: `plugins/clients/transport.ts`
- Test: `test/client-gateway.test.ts`

**Interfaces:**
- Consumes `TurnRuntimeService.subscribeActivity`.
- Produces WebSocket `ClientActivityMessage` live-only messages.

- [ ] **Step 1: Write failing gateway tests**

Prove:
- an authenticated WebSocket receives `kind: "activity"` after `client.ready`;
- the message is visible only to authenticated clients;
- a live `summary.delta` is not written to Events replay;
- a durable `summary.added` arrives via the existing `kind: "event"` replay path as `turn.activity` and is not duplicated as historical live activity;
- reconnect from sequence N reconstructs durable milestones and receives only future live deltas.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/client-gateway.test.ts
```

Expected: FAIL because the gateway only forwards Events and WebRTC messages.

- [ ] **Step 3: Wire connection-scoped activity forwarding**

Subscribe each authenticated gateway connection to `turnRuntime.subscribeActivity`. Send only live activity where `sequence === undefined`; durable activity continues through Events. Unsubscribe during the existing socket cleanup path.

Use a fresh server request ID for each pushed activity message; do not reuse the device authentication request ID.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run test/client-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/clients/contract.ts plugins/clients/index.ts plugins/clients/transport.ts test/client-gateway.test.ts
git commit -m "feat(activity): stream live client activity"
```

---

### Task 7: Render never-silent activity in Desktop

**Files:**
- Modify: `apps/desktop/src/gateway.ts`
- Modify: `apps/desktop/src/core.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/styles.css`
- Test: `test/desktop-client.test.ts`
- Test: `test/desktop-client-infrastructure.test.ts`

**Interfaces:**
- Desktop state adds:

```ts
interface DesktopTurnActivityState {
  readonly turnId: string;
  readonly active: boolean;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly terminalKind?: "turn.completed" | "turn.failed" | "turn.cancelled";
  readonly items: readonly TurnActivity[];
}
```

- [ ] **Step 1: Write failing reducer/UI tests**

Prove:
- sending a turn immediately renders `Working` before server/model output;
- `tool.started` changes the visible status to `Running <displayName>`;
- `summary.added` appears inline and in the Activity panel;
- a local clock renders `Waiting for model · Ns` / `Still working · Ns` without dispatching network messages;
- reconnect plus durable `turn.activity` events rebuilds one active activity transcript;
- final answer preserves collapsed activity history and removes the active spinner;
- group activity labels the correct Agent Profile when `agentProfileId` is present.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/desktop-client.test.ts test/desktop-client-infrastructure.test.ts
```

Expected: FAIL because Desktop has only demo jobs/events and no activity model.

- [ ] **Step 3: Parse live gateway activity**

Change `DesktopGatewayClient.stream` callback to accept a discriminated union of durable events and live activity, or add a dedicated `onActivity` callback. Prefer a discriminated union so ordering remains one stream:

```ts
type DesktopGatewayStreamItem =
  | { readonly kind: "event"; readonly event: DesktopEvent }
  | { readonly kind: "activity"; readonly activity: TurnActivity };
```

- [ ] **Step 4: Add reducer state and local timer derivation**

Do not store a timer tick in server state. Render elapsed seconds from `Date.now() - startedAt` using one UI interval while any turn is active. The interval only triggers local render; it must not write Events, call the gateway, or call a model.

- [ ] **Step 5: Render inline + Activity panel**

Inline under the active user request:

```text
● Working
├ Running Shell · 4s
├ Found token refresh path bypassing validation
├ Running tests · 9s
└ Verifying the fix
```

The right panel shows the same ordered activity with timestamps and Agent labels. Collapse completed transcripts by default but keep them expandable.

- [ ] **Step 6: Run GREEN**

```bash
npm run build:desktop
npx vitest run test/desktop-client.test.ts test/desktop-client-infrastructure.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/gateway.ts apps/desktop/src/core.ts apps/desktop/src/main.ts apps/desktop/src/styles.css test/desktop-client.test.ts test/desktop-client-infrastructure.test.ts
git commit -m "feat(desktop): render live turn activity"
```

---

### Task 8: Verify Activity Stream end-to-end

**Files:**
- Modify tests only if a discovered regression needs a minimal correction.

- [ ] **Step 1: Run focused suites**

```bash
npm --prefix packages/client-protocol test
npm --prefix plugins/agent/runtime test
npx vitest run test/turn-loop.test.ts test/turn-loop-agent.test.ts test/client-gateway.test.ts test/desktop-client.test.ts test/desktop-client-infrastructure.test.ts
npm run build:desktop
```

Expected: all PASS.

- [ ] **Step 2: Run full repository verification**

```bash
npm run verify:report
grep -E 'PASS:|FAIL:|FINAL SUMMARY|Passed stages|Failed stages' report.log
```

Expected:

```text
Passed stages: 9
Failed stages: 0
```

- [ ] **Step 3: Run privacy scans**

```bash
rg -n 'thinking_delta|thinking_start|thinking_end' plugins/turn-loop apps/desktop packages/client-protocol
rg -n 'raw.*args|tool.*args|tool.*result' apps/desktop/src packages/client-protocol/src
```

Expected: no code path exposes generic thinking or raw tool arguments/results in client activity.

- [ ] **Step 4: Commit verification-only adjustments if needed**

If no files changed, do not create an empty commit. If a test-only adjustment was necessary:

```bash
git add <changed-test-files>
git commit -m "test(activity): cover end-to-end activity stream"
```
