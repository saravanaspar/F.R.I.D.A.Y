import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";

export type EventJsonPrimitive = string | number | boolean | null;
export type EventJsonValue = EventJsonPrimitive | EventJsonValue[] | { [key: string]: EventJsonValue };
export type EventMetadata = { [key: string]: EventJsonValue };

export interface EventInput {
  id?: string | undefined;
  type: string;
  source: string;
  subject?: string | undefined;
  occurredAt?: string | undefined;
  data?: EventJsonValue | undefined;
  metadata?: EventMetadata | undefined;
  dedupeKey?: string | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export interface EventRecord {
  sequence: number;
  id: string;
  type: string;
  source: string;
  subject?: string | undefined;
  occurredAt: string;
  publishedAt: string;
  data: EventJsonValue;
  metadata: EventMetadata;
  dedupeKey?: string | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export interface EventReplayOptions {
  afterSequence?: number | undefined;
  beforeSequence?: number | undefined;
  types?: readonly string[] | undefined;
  source?: string | undefined;
  limit?: number | undefined;
  order?: "asc" | "desc" | undefined;
}

export interface EventSubscriptionOptions {
  types?: readonly string[] | undefined;
  source?: string | undefined;
}

export type EventSubscriber = (event: EventRecord) => void;

export interface EventRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export interface EventConsumerInput {
  id: string;
  types?: readonly string[] | undefined;
  startAt?: "beginning" | "latest" | undefined;
  retry?: Partial<EventRetryPolicy> | undefined;
}

export interface EventConsumer {
  id: string;
  types: readonly string[];
  cursorSequence: number;
  retry: EventRetryPolicy;
  createdAt: string;
  updatedAt: string;
  retryNotBefore?: string | undefined;
  lease?: EventConsumerLease | undefined;
}

export interface EventConsumerLease {
  id: string;
  eventSequence: number;
  claimedAt: string;
  expiresAt: string;
}

export type EventDeliveryStatus = "running" | "success" | "error" | "cancelled" | "abandoned" | "dead-letter";

export interface EventDeliveryRecord {
  deliveryId: string;
  consumerId: string;
  eventId: string;
  eventSequence: number;
  idempotencyKey: string;
  attempt: number;
  startedAt: string;
  completedAt?: string | undefined;
  status: EventDeliveryStatus;
  error?: string | undefined;
}

export interface EventDelivery {
  consumer: EventConsumer;
  event: EventRecord;
  delivery: EventDeliveryRecord;
  signal?: AbortSignal | undefined;
}

export type EventConsumerHandler = (delivery: EventDelivery) => Promise<void>;

export interface EventRunOptions {
  now?: Date | undefined;
  maxDeliveries?: number | undefined;
  maxConcurrent?: number | undefined;
  leaseMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface EventRunResult {
  consumerId: string;
  eventId: string;
  status: "success" | "error" | "cancelled" | "dead-letter";
  error?: string | undefined;
}

export interface EventDeliveryHistoryOptions {
  consumerId?: string | undefined;
  eventId?: string | undefined;
  status?: EventDeliveryStatus | undefined;
  limit?: number | undefined;
}

export interface EventWorkerOptions {
  pollIntervalMs?: number | undefined;
  maxDeliveriesPerTick?: number | undefined;
  maxConcurrent?: number | undefined;
  leaseMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface EventWorkerStatus {
  running: boolean;
  startedAt?: string | undefined;
  lastTickAt?: string | undefined;
  lastError?: string | undefined;
}

export interface EventsService {
  publish(input: EventInput): EventRecord;
  get(eventId: string): EventRecord | undefined;
  replay(options?: EventReplayOptions): readonly EventRecord[];
  subscribe(subscriber: EventSubscriber, options?: EventSubscriptionOptions): () => void;
  registerConsumer(input: EventConsumerInput, handler: EventConsumerHandler): () => void;
  consumer(consumerId: string): EventConsumer | undefined;
  consumers(): readonly EventConsumer[];
  rewindConsumer(consumerId: string, afterSequence?: number): EventConsumer;
  deliveryHistory(options?: EventDeliveryHistoryOptions): readonly EventDeliveryRecord[];
  runPending(options?: EventRunOptions): Promise<readonly EventRunResult[]>;
  startWorker(options?: EventWorkerOptions): void;
  stopWorker(): Promise<void>;
  workerStatus(): EventWorkerStatus;
  close(): Promise<void>;
}

export const EVENTS_CAPABILITY: Capability<EventsService> = defineCapability<EventsService>("events");
