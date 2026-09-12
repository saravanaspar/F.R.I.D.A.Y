import { describe, expect, it } from "vitest";
import { createDesktopState, reduceDesktopState } from "../apps/desktop/src/core.js";

describe("Phase 6 desktop client", () => {
  it("models chat to approval to artifact without owning durable execution", () => {
    let state = createDesktopState("conversation-1");
    state = reduceDesktopState(state, { type: "send-message", text: "Prepare a release checklist", now: "2026-01-01T00:00:00.000Z", messageId: "message-1", jobId: "job-1" });
    expect(state.messages[0]?.text).toBe("Prepare a release checklist");
    expect(state.jobs[0]?.status).toBe("queued");

    state = reduceDesktopState(state, { type: "job-update", jobId: "job-1", status: "awaiting-approval", progress: 48, approvalLabel: "Create release checklist" });
    expect(state.jobs[0]?.approvalLabel).toBe("Create release checklist");

    state = reduceDesktopState(state, { type: "job-update", jobId: "job-1", status: "completed", progress: 100, artifactId: "artifact-1" });
    state = reduceDesktopState(state, { type: "artifact-added", artifact: { id: "artifact-1", name: "release-checklist.md", kind: "document", summary: "Reviewed checklist", createdAt: "2026-01-01T00:01:00.000Z" } });
    expect(state.jobs[0]?.artifactId).toBe("artifact-1");
    expect(state.artifacts).toHaveLength(1);
  });

  it("deduplicates replayed gateway events and keeps the latest sequence", () => {
    let state = createDesktopState();
    state = reduceDesktopState(state, { type: "gateway-events", events: [
      { sequence: 2, type: "conversation.message.created", data: { messageId: "m2", text: "second" } },
      { sequence: 1, type: "conversation.message.created", data: { messageId: "m1", text: "first" } },
    ] });
    state = reduceDesktopState(state, { type: "gateway-events", events: [
      { sequence: 2, type: "conversation.message.created", data: { messageId: "m2", text: "second" } },
      { sequence: 3, type: "conversation.message.created", data: { messageId: "m3", text: "third" } },
    ] });
    expect(state.lastSequence).toBe(3);
    expect(state.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("makes computer takeover explicit and hands control back to the Agent", () => {
    let state = createDesktopState();
    state = reduceDesktopState(state, { type: "computer-takeover" });
    expect(state.computer.open).toBe(true);
    expect(state.computer.control).toBe("human");
    state = reduceDesktopState(state, { type: "computer-hand-back" });
    expect(state.computer.control).toBe("agent");
  });
});
