import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import type {
  EventConsumer,
  EventConsumerHandler,
  EventConsumerInput,
  EventDeliveryHistoryOptions,
  EventDeliveryRecord,
  EventInput,
  EventJsonValue,
  EventMetadata,
  EventRecord,
  EventReplayOptions,
  EventRetryPolicy,
  EventRunOptions,
  EventRunResult,
  EventsService,
  EventSubscriber,
  EventSubscriptionOptions,
  EventWorkerOptions,
  EventWorkerStatus,
} from "./contract.js";
import { EventsDatabase, getEventsStateDir } from "./store.js";

const DEFAULT_RETRY: EventRetryPolicy = {
  maxAttempts: 8,
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
};
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

export interface EventsServiceOptions {
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  maxEventBytes?: number | undefined;
}

interface LiveSubscription {
  subscriber: EventSubscriber;
  types: readonly string[];
  source?: string | undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function assertJsonValue(value: unknown, path = "data"): asserts value is EventJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must contain only JSON-safe values`);
}

function cloneJson<T extends EventJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneMetadata(value: EventMetadata): EventMetadata {
  return cloneJson(value) as EventMetadata;
}

function cloneEvent(event: EventRecord): EventRecord {
  return { ...event, data: cloneJson(event.data), metadata: cloneMetadata(event.metadata) };
}

function cloneDelivery(delivery: EventDeliveryRecord): EventDeliveryRecord {
  return { ...delivery };
}

function cloneConsumer(consumer: EventConsumer): EventConsumer {
  return {
    ...consumer,
    types: [...consumer.types],
    retry: { ...consumer.retry },
    ...(consumer.lease ? { lease: { ...consumer.lease } } : {}),
  };
}

function normalizeIdentifier(value: string, label: string, maximum = 128): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeOpaque(value: string | undefined, label: string, maximum = 512): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeTimestamp(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function normalizeSequence(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) throw new Error(`${label} must be a non-negative integer`);
  return normalized;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

function normalizeLeaseMs(value: number | undefined, fallback: number, label: string): number {
  const normalized = normalizePositiveInteger(value, fallback, label);
  if (normalized < 300) throw new Error(`${label} must be at least 300ms so the lease can be renewed safely`);
  return normalized;
}

function normalizeRetry(input: Partial<EventRetryPolicy> | undefined): EventRetryPolicy {
  const maxAttempts = normalizePositiveInteger(input?.maxAttempts, DEFAULT_RETRY.maxAttempts, "retry.maxAttempts", 100);
  const initialDelayMs = normalizePositiveInteger(input?.initialDelayMs, DEFAULT_RETRY.initialDelayMs, "retry.initialDelayMs");
  const maxDelayMs = normalizePositiveInteger(input?.maxDelayMs, DEFAULT_RETRY.maxDelayMs, "retry.maxDelayMs");
  const multiplier = input?.multiplier ?? DEFAULT_RETRY.multiplier;
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) {
    throw new Error("retry.multiplier must be a finite number between 1 and 100");
  }
  if (maxDelayMs < initialDelayMs) throw new Error("retry.maxDelayMs must be greater than or equal to retry.initialDelayMs");
  return { maxAttempts, initialDelayMs, multiplier, maxDelayMs };
}

function retryDelay(policy: EventRetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1)));
}

function normalizeTypes(types: readonly string[] | undefined): string[] {
  if (!types || types.length === 0) return [];
  if (types.length > 64) throw new Error("event type filter cannot contain more than 64 types");
  return [...new Set(types.map((type) => normalizeIdentifier(type, "event type")))].sort();
}

function normalizeMetadata(value: EventMetadata | undefined): EventMetadata {
  if (value === undefined) return {};
  assertJsonValue(value, "metadata");
  const record = objectRecord(value);
  if (!record) throw new Error("metadata must be a JSON object");
  return cloneMetadata(value);
}

function stableJson(value: EventJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as Record<string, EventJsonValue>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`).join(",")}}`;
}

function compatibleDuplicate(existing: EventRecord, input: EventInput, normalized: Omit<EventRecord, "sequence">): boolean {
  if (input.id !== undefined && existing.id !== normalized.id) return false;
  if (existing.type !== normalized.type || existing.source !== normalized.source) return false;
  if (existing.subject !== normalized.subject) return false;
  if (existing.dedupeKey !== normalized.dedupeKey) return false;
  if (existing.correlationId !== normalized.correlationId || existing.causationId !== normalized.causationId) return false;
  if (input.occurredAt !== undefined && existing.occurredAt !== normalized.occurredAt) return false;
  return stableJson(existing.data) === stableJson(normalized.data) && stableJson(existing.metadata) === stableJson(normalized.metadata);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", listener));
  }
  return { signal: controller.signal, cleanup: () => cleanups.forEach((cleanup) => cleanup()) };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolveDelay();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createEventsService(options: EventsServiceOptions = {}): EventsService {
  const stateDir = options.stateDir ?? getEventsStateDir();
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const maxEventBytes = normalizePositiveInteger(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, "maxEventBytes", 64 * 1024 * 1024);
  const database = new EventsDatabase({ stateDir });
  const subscribers = new Set<LiveSubscription>();
  const handlers = new Map<string, EventConsumerHandler>();
  const activeControllers = new Map<string, AbortController>();
  let closed = false;
  let workerController: AbortController | undefined;
  let workerPromise: Promise<void> | undefined;
  let workerStartedAt: string | undefined;
  let workerLastTickAt: string | undefined;
  let workerLastError: string | undefined;

  const assertOpen = (): void => {
    if (closed) throw new Error("events service is closed");
  };

  const executeConsumer = async (
    consumerId: string,
    current: Date,
    leaseMs: number,
    outerSignal?: AbortSignal,
  ): Promise<EventRunResult | undefined> => {
    const handler = handlers.get(consumerId);
    if (!handler) return undefined;
    const leaseId = idFactory();
    const deliveryId = idFactory();
    const claimed = database.claimDelivery(consumerId, current.toISOString(), leaseMs, leaseId, deliveryId);
    if (!claimed) return undefined;

    const localController = new AbortController();
    activeControllers.set(consumerId, localController);
    const combined = combineSignals([outerSignal, localController.signal]);
    const heartbeatMs = Math.max(50, Math.floor(leaseMs / 3));
    const heartbeat = setInterval(() => {
      if (localController.signal.aborted) return;
      try {
        const renewed = database.renewLease(consumerId, leaseId, now().toISOString(), leaseMs);
        if (!renewed) localController.abort(new Error(`Event consumer lease was lost while delivering: ${consumerId}`));
      } catch (error) {
        localController.abort(error);
      }
    }, heartbeatMs);
    heartbeat.unref();

    let failure: string | undefined;
    let cancelled = false;
    try {
      await handler({
        consumer: cloneConsumer(claimed.consumer),
        event: cloneEvent(claimed.event),
        delivery: cloneDelivery(claimed.delivery),
        signal: combined.signal,
      });
      cancelled = combined.signal.aborted;
    } catch (error) {
      cancelled = combined.signal.aborted || isAbortError(error);
      if (!cancelled) failure = errorMessage(error);
    } finally {
      clearInterval(heartbeat);
      combined.cleanup();
      if (activeControllers.get(consumerId) === localController) activeControllers.delete(consumerId);
    }

    const observedCompletion = now();
    const completed = observedCompletion.getTime() < current.getTime() ? current : observedCompletion;
    if (cancelled) {
      database.completeDelivery({
        consumerId,
        leaseId,
        deliveryId,
        eventSequence: claimed.event.sequence,
        completedAt: completed.toISOString(),
        status: "cancelled",
      });
      return { consumerId, eventId: claimed.event.id, status: "cancelled" };
    }
    if (failure !== undefined) {
      const exhausted = claimed.delivery.attempt >= claimed.consumer.retry.maxAttempts;
      const retryNotBefore = exhausted
        ? undefined
        : new Date(completed.getTime() + retryDelay(claimed.consumer.retry, claimed.delivery.attempt)).toISOString();
      database.completeDelivery({
        consumerId,
        leaseId,
        deliveryId,
        eventSequence: claimed.event.sequence,
        completedAt: completed.toISOString(),
        status: exhausted ? "dead-letter" : "error",
        error: failure,
        ...(retryNotBefore ? { retryNotBefore } : {}),
      });
      return {
        consumerId,
        eventId: claimed.event.id,
        status: exhausted ? "dead-letter" : "error",
        error: failure,
      };
    }
    database.completeDelivery({
      consumerId,
      leaseId,
      deliveryId,
      eventSequence: claimed.event.sequence,
      completedAt: completed.toISOString(),
      status: "success",
    });
    return { consumerId, eventId: claimed.event.id, status: "success" };
  };

  const service: EventsService = {
    publish(input: EventInput): EventRecord {
      assertOpen();
      const current = now();
      const data = input.data ?? null;
      assertJsonValue(data);
      const metadata = normalizeMetadata(input.metadata);
      const normalized: Omit<EventRecord, "sequence"> = {
        id: normalizeIdentifier(input.id ?? idFactory(), "event id"),
        type: normalizeIdentifier(input.type, "event type"),
        source: normalizeIdentifier(input.source, "event source"),
        ...(normalizeOpaque(input.subject, "event subject", 1_024) ? { subject: normalizeOpaque(input.subject, "event subject", 1_024)! } : {}),
        occurredAt: input.occurredAt ? normalizeTimestamp(input.occurredAt, "occurredAt") : current.toISOString(),
        publishedAt: current.toISOString(),
        data: cloneJson(data),
        metadata,
        ...(normalizeOpaque(input.dedupeKey, "dedupeKey") ? { dedupeKey: normalizeOpaque(input.dedupeKey, "dedupeKey")! } : {}),
        ...(input.correlationId ? { correlationId: normalizeIdentifier(input.correlationId, "correlationId") } : {}),
        ...(input.causationId ? { causationId: normalizeIdentifier(input.causationId, "causationId") } : {}),
      };
      const encodedBytes = Buffer.byteLength(`${stableJson(normalized.data)}${stableJson(normalized.metadata)}`, "utf8");
      if (encodedBytes > maxEventBytes) throw new Error(`event payload exceeds maximum size of ${maxEventBytes} bytes`);
      const persisted = database.persistEvent(normalized);
      if (persisted.duplicate) {
        if (!compatibleDuplicate(persisted.event, input, normalized)) {
          throw new Error(`Event dedupe collision contains conflicting content: ${persisted.event.id}`);
        }
        return cloneEvent(persisted.event);
      }
      const event = cloneEvent(persisted.event);
      for (const subscription of subscribers) {
        if (subscription.source && subscription.source !== event.source) continue;
        if (subscription.types.length > 0 && !subscription.types.includes(event.type)) continue;
        try {
          subscription.subscriber(cloneEvent(event));
        } catch (error) {
          reportOperationalError({ component: "events", operation: `notify live subscriber for ${event.type}`, error });
        }
      }
      return event;
    },

    get(eventId: string) {
      assertOpen();
      const event = database.getEvent(normalizeIdentifier(eventId, "event id"));
      return event ? cloneEvent(event) : undefined;
    },

    replay(replayOptions: EventReplayOptions = {}) {
      assertOpen();
      const afterSequence = replayOptions.afterSequence === undefined
        ? undefined
        : normalizeSequence(replayOptions.afterSequence, 0, "afterSequence");
      const beforeSequence = replayOptions.beforeSequence === undefined
        ? undefined
        : normalizeSequence(replayOptions.beforeSequence, 0, "beforeSequence");
      if (afterSequence !== undefined && beforeSequence !== undefined && beforeSequence <= afterSequence) {
        return [];
      }
      const types = normalizeTypes(replayOptions.types);
      const source = replayOptions.source === undefined ? undefined : normalizeIdentifier(replayOptions.source, "event source");
      const limit = normalizePositiveInteger(replayOptions.limit, 100, "replay.limit", 10_000);
      const order = replayOptions.order ?? "asc";
      if (order !== "asc" && order !== "desc") throw new Error("replay.order must be asc or desc");
      return database.replay({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
        ...(types.length === 0 ? {} : { types }),
        ...(source === undefined ? {} : { source }),
        limit,
        order,
      }).map(cloneEvent);
    },

    subscribe(subscriber: EventSubscriber, subscriptionOptions: EventSubscriptionOptions = {}) {
      assertOpen();
      const subscription: LiveSubscription = {
        subscriber,
        types: normalizeTypes(subscriptionOptions.types),
        ...(subscriptionOptions.source ? { source: normalizeIdentifier(subscriptionOptions.source, "event source") } : {}),
      };
      subscribers.add(subscription);
      return () => subscribers.delete(subscription);
    },

    registerConsumer(input: EventConsumerInput, handler: EventConsumerHandler) {
      assertOpen();
      const id = normalizeIdentifier(input.id, "event consumer id");
      if (handlers.has(id)) throw new Error(`Event consumer handler already registered: ${id}`);
      const current = now().toISOString();
      database.ensureConsumer({
        id,
        types: normalizeTypes(input.types),
        retry: normalizeRetry(input.retry),
        startAt: input.startAt ?? "latest",
        nowIso: current,
      });
      handlers.set(id, handler);
      return () => {
        if (handlers.get(id) === handler) handlers.delete(id);
      };
    },

    consumer(consumerId: string) {
      assertOpen();
      const consumer = database.getConsumer(normalizeIdentifier(consumerId, "event consumer id"));
      return consumer ? cloneConsumer(consumer) : undefined;
    },

    consumers() {
      assertOpen();
      return database.listConsumers().map(cloneConsumer);
    },

    rewindConsumer(consumerId: string, afterSequence = 0) {
      assertOpen();
      const id = normalizeIdentifier(consumerId, "event consumer id");
      const sequence = normalizeSequence(afterSequence, 0, "afterSequence");
      return cloneConsumer(database.rewindConsumer(id, sequence, now().toISOString()));
    },

    deliveryHistory(historyOptions: EventDeliveryHistoryOptions = {}) {
      assertOpen();
      const limit = normalizePositiveInteger(historyOptions.limit, 100, "history.limit", 10_000);
      return database.deliveryHistory({
        ...(historyOptions.consumerId ? { consumerId: normalizeIdentifier(historyOptions.consumerId, "event consumer id") } : {}),
        ...(historyOptions.eventId ? { eventId: normalizeIdentifier(historyOptions.eventId, "event id") } : {}),
        ...(historyOptions.status ? { status: historyOptions.status } : {}),
        limit,
      }).map(cloneDelivery);
    },

    async runPending(runOptions: EventRunOptions = {}) {
      assertOpen();
      const maxDeliveries = normalizePositiveInteger(runOptions.maxDeliveries, 100, "maxDeliveries", 10_000);
      const maxConcurrent = normalizePositiveInteger(runOptions.maxConcurrent, 8, "maxConcurrent", 1_000);
      const leaseMs = normalizeLeaseMs(runOptions.leaseMs, 5 * 60_000, "leaseMs");
      runOptions.signal?.throwIfAborted();
      const ids = [...handlers.keys()].sort();
      if (ids.length === 0) return [];
      const results: EventRunResult[] = [];
      while (results.length < maxDeliveries) {
        runOptions.signal?.throwIfAborted();
        let progress = false;
        for (let index = 0; index < ids.length && results.length < maxDeliveries; index += maxConcurrent) {
          const remaining = maxDeliveries - results.length;
          const batch = ids.slice(index, index + Math.min(maxConcurrent, remaining));
          const current = runOptions.now ?? now();
          const batchResults = await Promise.all(batch.map((id) => executeConsumer(id, current, leaseMs, runOptions.signal)));
          for (const result of batchResults) {
            if (!result) continue;
            results.push(result);
            progress = true;
          }
          if (runOptions.signal?.aborted) break;
        }
        if (runOptions.signal?.aborted || !progress) break;
      }
      return results;
    },

    startWorker(workerOptions: EventWorkerOptions = {}) {
      assertOpen();
      if (workerPromise) throw new Error("events worker is already running");
      const pollIntervalMs = normalizePositiveInteger(workerOptions.pollIntervalMs, 1_000, "worker.pollIntervalMs");
      const maxDeliveriesPerTick = normalizePositiveInteger(workerOptions.maxDeliveriesPerTick, 100, "worker.maxDeliveriesPerTick", 10_000);
      const maxConcurrent = normalizePositiveInteger(workerOptions.maxConcurrent, 8, "worker.maxConcurrent", 1_000);
      const leaseMs = normalizeLeaseMs(workerOptions.leaseMs, 5 * 60_000, "worker.leaseMs");
      const controller = new AbortController();
      workerController = controller;
      workerStartedAt = now().toISOString();
      workerLastTickAt = undefined;
      workerLastError = undefined;
      const onExternalAbort = (): void => controller.abort(workerOptions.signal?.reason);
      if (workerOptions.signal) {
        if (workerOptions.signal.aborted) controller.abort(workerOptions.signal.reason);
        else workerOptions.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
      const pending = (async () => {
        try {
          while (!controller.signal.aborted) {
            workerLastTickAt = now().toISOString();
            try {
              await service.runPending({ maxDeliveries: maxDeliveriesPerTick, maxConcurrent, leaseMs, signal: controller.signal });
              workerLastError = undefined;
            } catch (error) {
              if (controller.signal.aborted) break;
              workerLastError = errorMessage(error);
              reportOperationalError({ component: "events", operation: "run durable delivery worker tick", error });
            }
            if (controller.signal.aborted) break;
            await delay(pollIntervalMs, controller.signal).catch((error: unknown) => {
              if (!controller.signal.aborted) reportOperationalError({ component: "events", operation: "wait for durable delivery worker tick", error });
            });
          }
        } finally {
          workerOptions.signal?.removeEventListener("abort", onExternalAbort);
        }
      })();
      workerPromise = pending;
      void pending.finally(() => {
        if (workerPromise === pending) {
          workerPromise = undefined;
          workerController = undefined;
          workerStartedAt = undefined;
        }
      });
    },

    async stopWorker() {
      if (!workerPromise) return;
      workerController?.abort();
      const pending = workerPromise;
      await pending;
      if (workerPromise === pending) {
        workerPromise = undefined;
        workerController = undefined;
        workerStartedAt = undefined;
      }
    },

    workerStatus(): EventWorkerStatus {
      return {
        running: workerPromise !== undefined,
        ...(workerStartedAt ? { startedAt: workerStartedAt } : {}),
        ...(workerLastTickAt ? { lastTickAt: workerLastTickAt } : {}),
        ...(workerLastError ? { lastError: workerLastError } : {}),
      };
    },

    async close() {
      if (closed) return;
      // Abort active handlers before waiting for the worker. The worker passes
      // this signal into each delivery so cooperative handlers can unwind.
      for (const controller of activeControllers.values()) controller.abort(new Error("events service closed"));
      await service.stopWorker();
      activeControllers.clear();
      subscribers.clear();
      handlers.clear();
      database.close();
      closed = true;
    },
  };

  return Object.freeze(service);
}
