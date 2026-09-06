import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../plugins/channels/trusted-contract.js";
import { EVENTS_CAPABILITY, type EventInput, type EventsService } from "../plugins/events/contract.js";
import { createEventsService } from "../plugins/events/events.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobOrigin } from "../plugins/session-jobs/contract.js";
import { createSessionJobsPlugin } from "../plugins/session-jobs/index.js";
import { SessionJobManager } from "../plugins/session-jobs/manager.js";
import { SESSIONS_CAPABILITY } from "../plugins/sessions/contract.js";
import { TURN_FINALIZER_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const managers: SessionJobManager[] = [];
const origin: SessionJobOrigin = { authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat", senderId: "alice", threadId: "thread" };

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "friday-delivery-test-"));
  roots.push(root);
  return root;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Delivery condition did not settle");
}

function captureEvents(inputs: EventInput[]): EventsService {
  return { publish: (input: EventInput) => { inputs.push(input); return {}; } } as EventsService;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  uninstallCapabilityRegistry();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable background result delivery", () => {
  it("waits for an in-flight send before releasing ownership during shutdown", async () => {
    const stateDir = await temp();
    const manager = await SessionJobManager.open({ stateDir, quiesceTimeoutMs: 1_000 });
    managers.push(manager);
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const job = await manager.start({
      destinationId: "session:test", text: "request", timestamp: Date.now(), origin,
      run: async () => ({ text: "result" }),
      notify: async () => { started = true; await sending; },
    });
    await waitUntil(() => started);
    let stopped = false;
    const stop = manager.quiesce().then(() => { stopped = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
    } finally {
      release();
      await stop;
    }
    expect(manager.get(job.id)?.deliveryStatus).toBe("pending");
  });

  it("leaves schema-1 state unchanged while suspended and upgrades it only on a job write", async () => {
    const stateDir = await temp();
    const original = await SessionJobManager.open({ stateDir });
    await original.close();
    const readVersion = () => {
      const db = new DatabaseSync(join(stateDir, "jobs.sqlite"));
      try { return db.prepare("PRAGMA user_version").get()?.user_version; } finally { db.close(); }
    };
    expect(readVersion()).toBe(1);
    const successor = await SessionJobManager.open({ stateDir, startSuspended: true, recoverInterrupted: false });
    managers.push(successor);
    expect(readVersion()).toBe(1);
    await successor.activate();
    const job = await successor.start({
      destinationId: "session:test", text: "request", timestamp: Date.now(), origin,
      run: async () => ({ text: "result" }), notify: async () => undefined,
    });
    await waitUntil(() => successor.get(job.id)?.status === "completed" && successor.get(job.id)?.deliveryStatus === undefined);
    expect(readVersion()).toBe(2);
  });

  it("keeps the complete reply private and retries concurrent requests once before running the callback", async () => {
    const stateDir = await temp();
    const events: EventInput[] = [];
    const manager = await SessionJobManager.open({ stateDir, events: captureEvents(events) });
    managers.push(manager);
    let continuations = 0;
    let attempts = 0;
    const report = "complete report\n".repeat(500);
    const job = await manager.start({
      destinationId: "session:test", text: "do the work", timestamp: Date.now(), origin,
      run: async () => ({ text: report, afterNotify: () => { continuations++; } }),
      notify: async () => { attempts++; throw new Error("channel offline"); },
    });
    await waitUntil(() => events.some((event) => event.type === "session-job.delivery-requested"));
    expect(attempts).toBe(1);
    expect(continuations).toBe(0);
    expect(manager.get(job.id)).toMatchObject({ status: "completed", deliveryStatus: "pending" });
    expect(manager.get(job.id)).not.toHaveProperty("notification");
    expect(JSON.stringify(events)).not.toContain("complete report");
    const db = new DatabaseSync(join(stateDir, "jobs.sqlite"));
    try { expect(db.prepare("SELECT active FROM jobs WHERE id = ?").get(job.id)?.active).toBe(1); } finally { db.close(); }
    const sent: string[] = [];
    const notify = async (text: string) => { sent.push(text); };
    await Promise.all([manager.deliverPending(job.id, notify), manager.deliverPending(job.id, notify)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(report.trim());
    expect(continuations).toBe(1);
    expect(manager.pendingDeliveries()).toEqual([]);
  });

  it("reopens an undelivered result without rerunning work and restores its required finalizer", async () => {
    const stateDir = await temp();
    const events: EventInput[] = [];
    const first = await SessionJobManager.open({ stateDir, events: captureEvents(events) });
    managers.push(first);
    const job = await first.start({
      turnId: "original-turn", destinationId: "session:test", text: "original request", timestamp: Date.now(), origin,
      run: async () => ({ text: "durable result", afterNotify: () => { throw new Error("must not run before delivery"); }, afterNotifyFinalizers: [{ type: "test.finalizer", payload: { marker: "saved" } }] }),
      notify: async () => { throw new Error("offline"); },
    });
    await waitUntil(() => events.some((event) => event.type === "session-job.delivery-requested"));
    await first.close();
    const steps: string[] = [];
    const reopened = await SessionJobManager.open({
      stateDir,
      finalizeNotification: async (record, descriptors, context) => {
        expect(record.origin).toEqual(origin);
        expect(descriptors).toEqual([{ type: "test.finalizer", payload: { marker: "saved" } }]);
        expect(context).toEqual({ turnId: "original-turn", text: "original request" });
        steps.push("finalize");
      },
    });
    managers.push(reopened);
    expect(reopened.resumable()).toEqual([]);
    await reopened.deliverPending(job.id, async (text) => { expect(text).toContain("durable result"); steps.push("send"); });
    expect(steps).toEqual(["send", "finalize"]);
    expect(reopened.pendingDeliveries()).toEqual([]);
  });

  it("does not resend an acknowledged reply when finalization is retried after restart", async () => {
    const stateDir = await temp();
    const events: EventInput[] = [];
    const first = await SessionJobManager.open({ stateDir, events: captureEvents(events) });
    managers.push(first);
    const job = await first.start({
      destinationId: "session:test", text: "request", timestamp: Date.now(), origin,
      run: async () => ({ text: "result", afterNotify: () => { throw new Error("continuation unavailable"); }, afterNotifyFinalizers: [{ type: "test.finalizer", payload: null }] }),
      notify: async () => undefined,
    });
    await waitUntil(() => events.some((event) => event.type === "session-job.delivery-requested"));
    expect(first.get(job.id)?.deliveryStatus).toBe("finalizing");
    await first.close();
    let finalized = false;
    const reopened = await SessionJobManager.open({ stateDir, finalizeNotification: async () => { finalized = true; } });
    managers.push(reopened);
    await reopened.deliverPending(job.id, async () => { throw new Error("reply must not be sent twice"); });
    expect(finalized).toBe(true);
    expect(reopened.pendingDeliveries()).toEqual([]);
  });

  it("retries failed jobs' failure reports without making execution resumable", async () => {
    const stateDir = await temp();
    const events: EventInput[] = [];
    const manager = await SessionJobManager.open({ stateDir, events: captureEvents(events) });
    managers.push(manager);
    const job = await manager.start({
      destinationId: "session:test", text: "request", timestamp: Date.now(), origin,
      run: async () => { throw new Error("tool failed"); }, notify: async () => { throw new Error("offline"); },
    });
    await waitUntil(() => events.some((event) => event.type === "session-job.delivery-requested"));
    expect(manager.get(job.id)).toMatchObject({ status: "error", deliveryStatus: "pending" });
    await manager.deliverPending(job.id, async (text) => { expect(text).toContain("tool failed"); });
    expect(manager.resumable()).toEqual([]);
    expect(manager.pendingDeliveries()).toEqual([]);
  });

  it("wires persisted delivery into Events retries after bootstrap with the original channel and finalizer context", async () => {
    const home = await temp();
    const captured: EventInput[] = [];
    const first = await SessionJobManager.open({ stateDir: join(home, "session-jobs"), events: captureEvents(captured) });
    managers.push(first);
    const job = await first.start({
      turnId: "source-turn", destinationId: "session:test", text: "full original request", timestamp: Date.now(), origin,
      run: async () => ({ text: "restart result", afterNotifyFinalizers: [{ type: "test.recovered", payload: { id: "descriptor" } }] }),
      notify: async () => { throw new Error("offline"); },
    });
    await waitUntil(() => captured.some((event) => event.type === "session-job.delivery-requested"));
    await first.close();
    let eventTime = Date.now();
    const events = createEventsService({ stateDir: join(home, "events"), now: () => new Date(eventTime) });
    const host = new PluginTestHost();
    let online = false;
    let finalized = false;
    const delivered: string[] = [];
    try {
      await host.activatePlugin(capabilitiesPlugin);
      await host.activatePlugin(definePlugin({ id: "delivery-dependencies", provides: [EVENTS_CAPABILITY, SESSIONS_CAPABILITY, CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
        ctx.services.provide(EVENTS_CAPABILITY, events);
        ctx.services.provide(SESSIONS_CAPABILITY, { SessionManager: { listAll: async () => [] } } as never);
        ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, {
          send: async (target: unknown, text: string) => {
            expect(target).toEqual({ channel: "telegram", accountId: "main", conversationId: "chat", threadId: "thread" });
            if (!online) throw new Error("still offline");
            delivered.push(text);
          },
        } as never);
        ctx.contribute(TURN_FINALIZER_CONTRIBUTION, {
          type: "test.recovered",
          async finalize(payload, context) {
            expect(payload).toEqual({ id: "descriptor" });
            expect(context.turn).toMatchObject({ id: "source-turn", text: "full original request", principal: origin });
            await events.stopWorker();
            finalized = true;
          },
        });
      }), { defer: true });
      await host.activatePlugin(createSessionJobsPlugin({ home }), { defer: true });
      await host.completePluginBootstrap();
      const failed = await events.runPending();
      expect(failed.some((result) => result.status === "error")).toBe(true);
      expect(finalized).toBe(false);
      online = true;
      eventTime += 2_000;
      events.startWorker({ pollIntervalMs: 5 });
      await waitUntil(() => finalized && requireCapability(SESSION_JOBS_CAPABILITY).get(job.id)?.deliveryStatus === undefined);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("restart result");
      expect(finalized).toBe(true);
      expect(requireCapability(SESSION_JOBS_CAPABILITY).get(job.id)?.deliveryStatus).toBeUndefined();
    } finally {
      await host.dispose();
      await events.close();
    }
  });
});
