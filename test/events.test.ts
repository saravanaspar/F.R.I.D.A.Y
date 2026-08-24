import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventsService } from "../plugins/events/contract.js";
import { createEventsService, type EventsServiceOptions } from "../plugins/events/events.js";
import { getEventsDatabasePath } from "../plugins/events/store.js";

const temporaryDirectories: string[] = [];
const services: EventsService[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-events-"));
  temporaryDirectories.push(directory);
  return directory;
}

function events(options: EventsServiceOptions): EventsService {
  const service = createEventsService(options);
  services.push(service);
  return service;
}

function sequenceFactory(prefix = "generated"): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("events plugin", () => {
  it("persists immutable events and replays them with bounded filters", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-19T04:00:00.000Z");
    const first = events({ stateDir, now: () => current, idFactory: sequenceFactory("event") });
    const payload = { text: "hello", nested: { count: 1 } };
    first.publish({ type: "channel.message.received", source: "channels", data: payload });
    first.publish({ type: "scheduler.job.completed", source: "scheduler", data: { taskId: "daily" } });
    first.publish({ type: "channel.message.received", source: "channels", data: { text: "again" } });
    payload.nested.count = 99;

    expect(first.replay().map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(first.replay({ types: ["channel.message.received"] }).map((event) => event.sequence)).toEqual([1, 3]);
    expect(first.replay({ source: "scheduler" }).map((event) => event.sequence)).toEqual([2]);
    expect(first.replay({ order: "desc", limit: 2 }).map((event) => event.sequence)).toEqual([3, 2]);
    expect((first.get("event-1")?.data as { nested: { count: number } }).nested.count).toBe(1);

    await first.close();
    const second = events({ stateDir, now: () => current, idFactory: sequenceFactory("reopened") });
    expect(second.replay().map((event) => event.id)).toEqual(["event-1", "event-2", "event-3"]);
    expect((await stat(getEventsDatabasePath(stateDir))).mode & 0o777).toBe(0o600);
  });

  it("deduplicates producer retries without re-notifying live subscribers and rejects collisions", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("event") });
    const observed: string[] = [];
    service.subscribe((event) => observed.push(event.id));

    const first = service.publish({
      type: "webhook.github.push",
      source: "webhooks.github",
      dedupeKey: "delivery-42",
      data: { b: 2, a: 1 },
    });
    const duplicate = service.publish({
      type: "webhook.github.push",
      source: "webhooks.github",
      dedupeKey: "delivery-42",
      data: { a: 1, b: 2 },
    });

    expect(duplicate.id).toBe(first.id);
    expect(service.replay()).toHaveLength(1);
    expect(observed).toEqual([first.id]);
    expect(() => service.publish({
      type: "webhook.github.push",
      source: "webhooks.github",
      dedupeKey: "delivery-42",
      data: { a: 999 },
    })).toThrow(/dedupe collision/);

    const explicit = service.publish({ id: "upstream-1", type: "vault.credential.rotated", source: "vault", data: null });
    expect(service.publish({ id: "upstream-1", type: "vault.credential.rotated", source: "vault", data: null }).id).toBe(explicit.id);
  });

  it("isolates live subscriber failures and applies exact live filters", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("event") });
    const observed: string[] = [];
    service.subscribe(() => { throw new Error("subscriber failed"); });
    service.subscribe((event) => observed.push(event.type), { types: ["channel.message.received"], source: "channels" });

    expect(() => service.publish({ type: "channel.message.received", source: "channels", data: "safe" })).not.toThrow();
    service.publish({ type: "scheduler.job.completed", source: "scheduler", data: null });

    expect(observed).toEqual(["channel.message.received"]);
    expect(service.replay()).toHaveLength(2);
  });

  it("starts new durable consumers at latest by default and resumes their cursor after restart", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-19T05:00:00.000Z");
    const first = events({ stateDir, now: () => current, idFactory: sequenceFactory("first") });
    first.publish({ id: "old", type: "channel.message.received", source: "channels", data: null });
    const seen: string[] = [];
    const unregister = first.registerConsumer({ id: "router" }, async ({ event }) => { seen.push(event.id); });
    first.publish({ id: "new", type: "channel.message.received", source: "channels", data: null });
    await expect(first.runPending()).resolves.toEqual([{ consumerId: "router", eventId: "new", status: "success" }]);
    expect(seen).toEqual(["new"]);
    unregister();
    await first.close();

    const second = events({ stateDir, now: () => current, idFactory: sequenceFactory("second") });
    second.registerConsumer({ id: "router" }, async ({ event }) => { seen.push(event.id); });
    second.publish({ id: "newer", type: "channel.message.received", source: "channels", data: null });
    await expect(second.runPending()).resolves.toEqual([{ consumerId: "router", eventId: "newer", status: "success" }]);
    expect(seen).toEqual(["new", "newer"]);
  });

  it("delivers beginning consumers in order while skipping non-matching event types", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("event") });
    service.publish({ id: "a1", type: "channel.message.received", source: "channels", data: null });
    service.publish({ id: "skip", type: "scheduler.job.completed", source: "scheduler", data: null });
    service.publish({ id: "a2", type: "channel.message.received", source: "channels", data: null });
    const seen: string[] = [];
    service.registerConsumer({ id: "router", types: ["channel.message.received"], startAt: "beginning" }, async ({ event }) => {
      seen.push(event.id);
    });

    const results = await service.runPending({ maxDeliveries: 10 });
    expect(results).toEqual([
      { consumerId: "router", eventId: "a1", status: "success" },
      { consumerId: "router", eventId: "a2", status: "success" },
    ]);
    expect(seen).toEqual(["a1", "a2"]);
    expect(service.consumer("router")?.cursorSequence).toBe(3);
    expect(() => service.registerConsumer({ id: "router", types: ["scheduler.job.completed"] }, async () => {})).toThrow(/handler already registered|type filter is immutable/);
  });

  it("retries a failed durable delivery with the same idempotency key", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-19T06:00:00.000Z");
    const service = events({ stateDir, now: () => current, idFactory: sequenceFactory("retry") });
    service.publish({ id: "evt", type: "test.retry", source: "test", data: null });
    const keys: string[] = [];
    let attempts = 0;
    service.registerConsumer({
      id: "consumer",
      types: ["test.retry"],
      startAt: "beginning",
      retry: { maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 5_000 },
    }, async ({ delivery }) => {
      keys.push(delivery.idempotencyKey);
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
    });

    await expect(service.runPending()).resolves.toEqual([{ consumerId: "consumer", eventId: "evt", status: "error", error: "temporary" }]);
    current = new Date("2026-08-19T06:00:00.500Z");
    await expect(service.runPending()).resolves.toEqual([]);
    current = new Date("2026-08-19T06:00:01.000Z");
    await expect(service.runPending()).resolves.toEqual([{ consumerId: "consumer", eventId: "evt", status: "success" }]);

    expect(keys).toEqual(["events:consumer:evt", "events:consumer:evt"]);
    expect(service.deliveryHistory({ consumerId: "consumer" }).map((delivery) => delivery.attempt)).toEqual([2, 1]);
    expect(service.deliveryHistory({ consumerId: "consumer" }).map((delivery) => delivery.status)).toEqual(["success", "error"]);
  });

  it("dead-letters poison events after bounded retries and continues with later events", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-19T07:00:00.000Z");
    const service = events({ stateDir, now: () => current, idFactory: sequenceFactory("dead") });
    service.publish({ id: "poison", type: "test.event", source: "test", data: null });
    service.publish({ id: "good", type: "test.event", source: "test", data: null });
    service.registerConsumer({
      id: "consumer",
      types: ["test.event"],
      startAt: "beginning",
      retry: { maxAttempts: 2, initialDelayMs: 1, multiplier: 1, maxDelayMs: 1 },
    }, async ({ event }) => {
      if (event.id === "poison") throw new Error("poison");
    });

    await expect(service.runPending()).resolves.toEqual([{ consumerId: "consumer", eventId: "poison", status: "error", error: "poison" }]);
    current = new Date("2026-08-19T07:00:00.001Z");
    await expect(service.runPending({ maxDeliveries: 10 })).resolves.toEqual([
      { consumerId: "consumer", eventId: "poison", status: "dead-letter", error: "poison" },
      { consumerId: "consumer", eventId: "good", status: "success" },
    ]);
    expect(service.consumer("consumer")?.cursorSequence).toBe(2);
    expect(service.deliveryHistory({ status: "dead-letter" })).toHaveLength(1);
  });

  it("prevents two processes from claiming the same consumer event", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-19T08:00:00.000Z");
    const first = events({ stateDir, now: () => current, idFactory: sequenceFactory("first") });
    first.publish({ id: "evt", type: "test.concurrent", source: "test", data: null });
    const second = events({ stateDir, now: () => current, idFactory: sequenceFactory("second") });
    let calls = 0;
    const handler = async (): Promise<void> => {
      calls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    };
    first.registerConsumer({ id: "consumer", types: ["test.concurrent"], startAt: "beginning" }, handler);
    second.registerConsumer({ id: "consumer", types: ["test.concurrent"] }, handler);

    const [left, right] = await Promise.all([
      first.runPending({ leaseMs: 300 }),
      second.runPending({ leaseMs: 300 }),
    ]);
    expect(calls).toBe(1);
    expect([...left, ...right].filter((result) => result.status === "success")).toHaveLength(1);
  });

  it("renews delivery leases while long-running consumers are active", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-19T09:00:00.000Z");
    const first = events({ stateDir, now: () => current, idFactory: sequenceFactory("heartbeat-a") });
    first.publish({ id: "evt", type: "test.long", source: "test", data: null });
    const second = events({ stateDir, now: () => current, idFactory: sequenceFactory("heartbeat-b") });
    let release: (() => void) | undefined;
    let started = false;
    first.registerConsumer({ id: "consumer", types: ["test.long"], startAt: "beginning" }, async () => {
      started = true;
      await new Promise<void>((resolveRun) => { release = resolveRun; });
    });
    second.registerConsumer({ id: "consumer", types: ["test.long"] }, async () => { throw new Error("duplicate claim"); });

    const running = first.runPending({ leaseMs: 300 });
    await waitFor(() => started);
    current = new Date("2026-08-19T09:00:00.200Z");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    current = new Date("2026-08-19T09:00:00.400Z");
    await expect(second.runPending({ leaseMs: 300 })).resolves.toEqual([]);
    release?.();
    await expect(running).resolves.toEqual([{ consumerId: "consumer", eventId: "evt", status: "success" }]);
  });

  it("recovers expired delivery leases with the same idempotency key and a higher attempt", async () => {
    const stateDir = await tempDir();
    const firstNow = new Date("2026-08-19T10:00:00.000Z");
    const first = events({ stateDir, now: () => firstNow, idFactory: sequenceFactory("first") });
    first.publish({ id: "evt", type: "test.recover", source: "test", data: null });
    let firstRelease: (() => void) | undefined;
    let firstStarted = false;
    let firstKey = "";
    first.registerConsumer({ id: "consumer", types: ["test.recover"], startAt: "beginning" }, async ({ delivery }) => {
      firstKey = delivery.idempotencyKey;
      firstStarted = true;
      await new Promise<void>((resolveRun) => { firstRelease = resolveRun; });
    });
    const firstRun = first.runPending({ leaseMs: 300 });
    await waitFor(() => firstStarted);

    const recoveredNow = new Date("2026-08-19T10:00:01.000Z");
    const second = events({ stateDir, now: () => recoveredNow, idFactory: sequenceFactory("second") });
    let secondKey = "";
    second.registerConsumer({ id: "consumer", types: ["test.recover"] }, async ({ delivery }) => { secondKey = delivery.idempotencyKey; });
    await expect(second.runPending({ leaseMs: 300 })).resolves.toEqual([{ consumerId: "consumer", eventId: "evt", status: "success" }]);
    expect(secondKey).toBe(firstKey);
    expect(second.deliveryHistory({ consumerId: "consumer" }).map((delivery) => delivery.status)).toEqual(["success", "abandoned"]);
    expect(second.deliveryHistory({ consumerId: "consumer" }).map((delivery) => delivery.attempt)).toEqual([2, 1]);

    firstRelease?.();
    await expect(firstRun).rejects.toThrow(/lease changed while delivering/);
  });

  it("records cancellation without advancing the durable consumer cursor", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("cancel") });
    service.publish({ id: "evt", type: "test.cancel", source: "test", data: null });
    let started = false;
    service.registerConsumer({ id: "consumer", types: ["test.cancel"], startAt: "beginning" }, async ({ signal }) => {
      started = true;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const running = service.runPending({ signal: controller.signal });
    await waitFor(() => started);
    controller.abort();
    await expect(running).resolves.toEqual([{ consumerId: "consumer", eventId: "evt", status: "cancelled" }]);
    expect(service.consumer("consumer")?.cursorSequence).toBe(0);
    expect(service.deliveryHistory({ consumerId: "consumer" })[0]?.status).toBe("cancelled");
  });

  it("rewinds durable consumers for replay while preserving the consumer-event idempotency key", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("rewind") });
    service.publish({ id: "one", type: "test.replay", source: "test", data: null });
    service.publish({ id: "two", type: "test.replay", source: "test", data: null });
    const keys: string[] = [];
    service.registerConsumer({ id: "consumer", types: ["test.replay"], startAt: "beginning" }, async ({ delivery }) => {
      keys.push(delivery.idempotencyKey);
    });
    await service.runPending({ maxDeliveries: 10 });
    expect(service.consumer("consumer")?.cursorSequence).toBe(2);
    expect(service.rewindConsumer("consumer", 0).cursorSequence).toBe(0);
    await service.runPending({ maxDeliveries: 10 });
    expect(keys).toEqual([
      "events:consumer:one", "events:consumer:two",
      "events:consumer:one", "events:consumer:two",
    ]);
  });

  it("runs an explicit delivery worker and stops it gracefully", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("worker") });
    let delivered = false;
    service.registerConsumer({ id: "consumer", types: ["test.worker"], startAt: "beginning" }, async () => { delivered = true; });
    service.publish({ id: "evt", type: "test.worker", source: "test", data: null });
    service.startWorker({ pollIntervalMs: 5, leaseMs: 300 });
    await waitFor(() => delivered);
    await service.stopWorker();
    expect(service.workerStatus().running).toBe(false);
    expect(service.deliveryHistory({ consumerId: "consumer" })[0]?.status).toBe("success");
  });

  it("aborts a cooperative active delivery before close waits for the worker", async () => {
    const stateDir = await tempDir();
    const service = events({ stateDir, idFactory: sequenceFactory("close") });
    let started = false;
    let aborted = false;
    service.registerConsumer({ id: "consumer", types: ["test.close"], startAt: "beginning" }, async ({ signal }) => {
      started = true;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("closed");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    service.publish({ id: "evt", type: "test.close", source: "test", data: null });
    service.startWorker({ pollIntervalMs: 5, leaseMs: 300 });
    await waitFor(() => started);
    await service.close();
    expect(aborted).toBe(true);
    expect(service.workerStatus().running).toBe(false);
  });

  it("fails closed when the event database is corrupt", async () => {
    const stateDir = await tempDir();
    await mkdir(stateDir, { recursive: true });
    await writeFile(getEventsDatabasePath(stateDir), "not-a-sqlite-database", { mode: 0o600 });
    expect(() => createEventsService({ stateDir })).toThrow();
  });
});
