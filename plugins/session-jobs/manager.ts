import { randomUUID } from "node:crypto";
import { reportOperationalError, sanitizeOperationalError } from "@friday/operational-errors";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EventsService } from "../events/contract.js";
import type {
  SessionJobFinalizerDescriptor,
  SessionJobDirective,
  SessionJobDirectiveMessage,
  SessionJobListOptions,
  SessionJobProgress,
  SessionJobRecord,
  SessionJobResumeRecord,
  SessionJobStartRequest,
  SessionJobTimelineEntry,
  SessionJobsService,
} from "./contract.js";
import { SessionJobStore } from "./store.js";

const STATE_SCHEMA = 1;
const MAX_RECORDS = 512;
const MAX_ACTIVE_JOBS = 128;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_TIMELINE = 64;
const MAX_PREVIEW = 320;
const MAX_REQUEST_TEXT = 128 * 1024;
const MAX_STATUS = 512;
const DEFAULT_PROGRESS_NOTIFY_MS = 30_000;
const DEFAULT_QUIESCE_TIMEOUT_MS = 20_000;

interface PendingNotification {
  text: string;
  delivered: boolean;
  requiresFinalization: boolean;
  finalizers: readonly SessionJobFinalizerDescriptor[];
}

type MutableJob = {
  id: string;
  sourceKey?: string;
  turnId?: string;
  destinationId: string;
  agentProfileId?: string;
  sessionId?: string;
  label: string;
  requestPreview: string;
  /** Private durable source text used only to reconstruct interrupted work after restart. */
  requestText?: string;
  origin: SessionJobRecord["origin"];
  status: SessionJobRecord["status"];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  currentStatus?: string;
  retryAttempt?: number;
  retryMax?: number;
  error?: string;
  resultPreview?: string;
  notification?: PendingNotification;
  timeline: SessionJobTimelineEntry[];
  directives: MutableDirective[];
};

type MutableDirective = {
  id: string;
  text: string;
  preview: string;
  status: SessionJobDirective["status"];
  createdAt: string;
  appliedAt?: string;
};

type PersistedState = { schema: 1; jobs: MutableJob[] };

interface ActiveRun {
  readonly controller: AbortController;
  readonly request: SessionJobStartRequest;
  readonly queueKey: string;
  readonly queueAliases: Map<string, Promise<void>>;
  settled: boolean;
  lastProgressNoticeAt: number;
  completion?: Promise<void>;
  readonly directiveListeners: Set<(directive: SessionJobDirectiveMessage) => void>;
}

export interface SessionJobManagerOptions {
  readonly stateDir: string;
  readonly events?: EventsService | undefined;
  readonly resolveLabel?: ((destinationId: string, text: string, origin: SessionJobRecord["origin"]) => Promise<string> | string) | undefined;
  readonly progressNotifyIntervalMs?: number | undefined;
  readonly quiesceTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly idFactory?: (() => string) | undefined;
  /** Successors inspect persisted state without mutating it until takeover release. */
  readonly recoverInterrupted?: boolean | undefined;
  readonly startSuspended?: boolean | undefined;
  readonly finalizeNotification?: ((job: SessionJobRecord, finalizers: readonly SessionJobFinalizerDescriptor[], context: { turnId: string; text: string }) => Promise<void>) | undefined;
}

function clip(value: string, maximum: number): string {
  const normalized = String(value ?? "").replaceAll("\u0000", "\ufffd").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}\u2026`;
}

function cloneMutable(job: MutableJob): MutableJob {
  return {
    ...job,
    ...(job.notification ? { notification: structuredClone(job.notification) } : {}),
    origin: { ...job.origin },
    timeline: job.timeline.map((entry) => ({ ...entry })),
    directives: job.directives.map((entry) => ({ ...entry })),
  };
}

function clone(job: MutableJob): SessionJobRecord {
  const snapshot = cloneMutable(job);
  const { requestText: _privateRequestText, notification, turnId: _turnId, directives, ...publicSnapshot } = snapshot;
  return Object.freeze({
    ...publicSnapshot,
    ...(notification ? { deliveryStatus: notification.delivered ? "finalizing" as const : "pending" as const } : {}),
    origin: Object.freeze(publicSnapshot.origin),
    timeline: Object.freeze(publicSnapshot.timeline.map((entry) => Object.freeze(entry))),
    directives: Object.freeze(directives.map(({ text: _privateText, ...entry }) => Object.freeze(entry))),
  });
}

function isActive(status: SessionJobRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "retrying";
}

function needsRetention(job: MutableJob): boolean {
  return isActive(job.status) || job.notification !== undefined;
}

function parseNotification(value: unknown): PendingNotification {
  const raw = record(value);
  if (!raw || typeof raw.delivered !== "boolean" || typeof raw.requiresFinalization !== "boolean"
    || !Array.isArray(raw.finalizers) || raw.finalizers.length > 64) throw new Error("Session-job notification is invalid");
  const text = persistedString(raw, "text", 128_000)!;
  const finalizers = raw.finalizers.map((value) => {
    const descriptor = record(value);
    if (!descriptor || typeof descriptor.type !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(descriptor.type)
      || !("payload" in descriptor)) throw new Error("Session-job notification finalizer is invalid");
    // Round-trip only bounded, JSON-safe descriptors; the owning finalizer validates its payload.
    const payload = JSON.parse(JSON.stringify(descriptor.payload)) as SessionJobFinalizerDescriptor["payload"];
    return { type: descriptor.type, payload };
  });
  return { text, delivered: raw.delivered, requiresFinalization: raw.requiresFinalization, finalizers };
}

function selectorText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(?:please|can|you|cancel|stop|abort|the|a|an|current|running|session|job|task|work)\b/g, " ")
    .replace(/[^\p{L}\p{N}_:-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SESSION_JOB_STATUSES = new Set<SessionJobRecord["status"]>([
  "queued",
  "running",
  "retrying",
  "completed",
  "resumed",
  "error",
  "cancelled",
]);
const PROGRESS_KINDS = new Set<SessionJobProgress["kind"]>(["status", "tool", "retry"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function persistedString(raw: Record<string, unknown>, field: string, maximum: number, optional = false): string | undefined {
  const value = raw[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`Session-jobs field ${field} is invalid`);
  }
  return value;
}

function persistedTimestamp(raw: Record<string, unknown>, field: string, optional = false): string | undefined {
  const value = persistedString(raw, field, 64, optional);
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) throw new Error(`Session-jobs field ${field} is not a timestamp`);
  return value;
}

function persistedPositiveInteger(raw: Record<string, unknown>, field: string): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
    throw new Error(`Session-jobs field ${field} is invalid`);
  }
  return value as number;
}

function parseOrigin(value: unknown): MutableJob["origin"] {
  const raw = record(value);
  if (!raw) throw new Error("Session-jobs origin is invalid");
  const authority = persistedString(raw, "authority", 16);
  if (authority !== "local" && authority !== "channel") throw new Error("Session-jobs origin authority is invalid");
  return {
    authority,
    channel: persistedString(raw, "channel", 64)!,
    accountId: persistedString(raw, "accountId", 256)!,
    conversationId: persistedString(raw, "conversationId", 256)!,
    senderId: persistedString(raw, "senderId", 256)!,
    ...(raw.threadId === undefined ? {} : { threadId: persistedString(raw, "threadId", 256)! }),
    ...(raw.sharedConversationId === undefined ? {} : { sharedConversationId: persistedString(raw, "sharedConversationId", 256)! }),
    ...(raw.projectId === undefined ? {} : { projectId: persistedString(raw, "projectId", 96)! }),
    ...(raw.projectTargetId === undefined ? {} : { projectTargetId: persistedString(raw, "projectTargetId", 128)! }),
  };
}

function parseTimeline(value: unknown): SessionJobTimelineEntry[] {
  if (!Array.isArray(value) || value.length > MAX_TIMELINE) throw new Error("Session-jobs timeline is invalid");
  return value.map((entry) => {
    const raw = record(entry);
    if (!raw) throw new Error("Session-jobs timeline entry is invalid");
    const kind = persistedString(raw, "kind", 16) as SessionJobProgress["kind"];
    if (!PROGRESS_KINDS.has(kind)) throw new Error("Session-jobs timeline kind is invalid");
    return {
      at: persistedTimestamp(raw, "at")!,
      kind,
      message: persistedString(raw, "message", MAX_STATUS)!,
      ...(raw.attempt === undefined ? {} : { attempt: persistedPositiveInteger(raw, "attempt")! }),
      ...(raw.maxRetries === undefined ? {} : { maxRetries: persistedPositiveInteger(raw, "maxRetries")! }),
      ...(raw.delayMs === undefined ? {} : { delayMs: persistedPositiveInteger(raw, "delayMs")! }),
    };
  });
}

function parseDirectives(value: unknown): MutableDirective[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error("Session-jobs directives are invalid");
  return value.map((entry) => {
    const raw = record(entry);
    if (!raw) throw new Error("Session-jobs directive is invalid");
    const status = persistedString(raw, "status", 16);
    if (status !== "pending" && status !== "applied") throw new Error("Session-jobs directive status is invalid");
    return {
      id: persistedString(raw, "id", 96)!,
      text: persistedString(raw, "text", MAX_REQUEST_TEXT)!,
      preview: persistedString(raw, "preview", MAX_PREVIEW)!,
      status,
      createdAt: persistedTimestamp(raw, "createdAt")!,
      ...(raw.appliedAt === undefined ? {} : { appliedAt: persistedTimestamp(raw, "appliedAt")! }),
    };
  });
}

function parsePersistedJob(value: unknown): MutableJob {
  const raw = record(value);
  if (!raw) throw new Error("Session-jobs record is invalid");
  const status = persistedString(raw, "status", 32) as SessionJobRecord["status"];
  if (!SESSION_JOB_STATUSES.has(status)) throw new Error(`Session-jobs status is invalid: ${status}`);
  return {
    id: persistedString(raw, "id", 96)!,
    ...(raw.sourceKey === undefined ? {} : { sourceKey: persistedString(raw, "sourceKey", 256)! }),
    ...(raw.turnId === undefined ? {} : { turnId: persistedString(raw, "turnId", 256)! }),
    destinationId: persistedString(raw, "destinationId", 256)!,
    ...(raw.agentProfileId === undefined ? {} : { agentProfileId: persistedString(raw, "agentProfileId", 96)! }),
    ...(raw.sessionId === undefined ? {} : { sessionId: persistedString(raw, "sessionId", 256)! }),
    label: persistedString(raw, "label", 160)!,
    requestPreview: persistedString(raw, "requestPreview", MAX_PREVIEW)!,
    ...(raw.requestText === undefined ? {} : { requestText: persistedString(raw, "requestText", MAX_REQUEST_TEXT)! }),
    origin: parseOrigin(raw.origin),
    status,
    createdAt: persistedTimestamp(raw, "createdAt")!,
    updatedAt: persistedTimestamp(raw, "updatedAt")!,
    ...(raw.startedAt === undefined ? {} : { startedAt: persistedTimestamp(raw, "startedAt")! }),
    ...(raw.completedAt === undefined ? {} : { completedAt: persistedTimestamp(raw, "completedAt")! }),
    ...(raw.currentStatus === undefined ? {} : { currentStatus: persistedString(raw, "currentStatus", MAX_STATUS)! }),
    ...(raw.retryAttempt === undefined ? {} : { retryAttempt: persistedPositiveInteger(raw, "retryAttempt")! }),
    ...(raw.retryMax === undefined ? {} : { retryMax: persistedPositiveInteger(raw, "retryMax")! }),
    ...(raw.error === undefined ? {} : { error: persistedString(raw, "error", MAX_STATUS)! }),
    ...(raw.resultPreview === undefined ? {} : { resultPreview: persistedString(raw, "resultPreview", MAX_PREVIEW)! }),
    ...(raw.notification === undefined ? {} : { notification: parseNotification(raw.notification) }),
    timeline: parseTimeline(raw.timeline),
    directives: parseDirectives(raw.directives),
  };
}

async function assertPrivateFile(path: string, allowMissing: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Session-jobs state must be a regular file: ${path}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Session-jobs state permissions are too broad: ${path}`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function loadLegacyState(path: string): Promise<PersistedState> {
  await assertPrivateFile(path, false);
  const info = await lstat(path);
  if (info.size > MAX_STATE_BYTES) throw new Error(`Session-jobs state is too large: ${path}`);
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Session-jobs state is corrupt: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Session-jobs state is invalid: ${path}`);
  const record = parsed as Record<string, unknown>;
  if (record.schema !== STATE_SCHEMA || !Array.isArray(record.jobs) || record.jobs.length > MAX_RECORDS) {
    throw new Error(`Session-jobs state schema is invalid: ${path}`);
  }
  try {
    const jobs = record.jobs.map(parsePersistedJob);
    const ids = new Set<string>();
    for (const job of jobs) {
      if (ids.has(job.id)) throw new Error(`duplicate job id ${job.id}`);
      ids.add(job.id);
    }
    return { schema: STATE_SCHEMA, jobs };
  } catch (error) {
    throw new Error(`Session-jobs state schema is invalid: ${path}: ${errorMessage(error)}`);
  }
}

function queueSerial<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const barrier = current.then(() => undefined, () => undefined);
  queues.set(key, barrier);
  return current.finally(() => {
    if (queues.get(key) === barrier) queues.delete(key);
  });
}

function errorMessage(error: unknown): string {
  return clip(sanitizeOperationalError(error).safeMessage, MAX_STATUS);
}

function defaultLabel(destinationId: string, text: string): string {
  if (destinationId !== "session:new") return destinationId.replace(/^session:/, "session ");
  return clip(text, 80) || "new session";
}

export class SessionJobManager implements SessionJobsService {
  private readonly options: {
    readonly stateDir: string;
    readonly events?: EventsService | undefined;
    readonly resolveLabel?: ((destinationId: string, text: string, origin: SessionJobRecord["origin"]) => Promise<string> | string) | undefined;
    readonly progressNotifyIntervalMs: number;
    readonly quiesceTimeoutMs: number;
    readonly now: () => number;
    readonly idFactory: () => string;
    readonly finalizeNotification?: SessionJobManagerOptions["finalizeNotification"];
  };
  private readonly jobs = new Map<string, MutableJob>();
  private readonly store: SessionJobStore<MutableJob>;
  private readonly active = new Map<string, ActiveRun>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private readonly notificationSends = new Set<Promise<void>>();
  private readonly notificationFinalizers = new Map<string, () => void | Promise<void>>();
  private readonly deferredFinalizers = new Map<string, NodeJS.Immediate>();
  private persistTail: Promise<void> = Promise.resolve();
  private admissionTail: Promise<void> = Promise.resolve();
  private closed = false;
  private databaseClosed = false;
  private suspendedForTakeover = false;

  private constructor(options: SessionJobManagerOptions, store: SessionJobStore<MutableJob>) {
    const progressNotifyIntervalMs = options.progressNotifyIntervalMs ?? DEFAULT_PROGRESS_NOTIFY_MS;
    if (!Number.isFinite(progressNotifyIntervalMs) || progressNotifyIntervalMs < 0 || progressNotifyIntervalMs > 3_600_000) {
      throw new Error("progressNotifyIntervalMs must be between 0 and 3600000");
    }
    const quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
    if (!Number.isFinite(quiesceTimeoutMs) || quiesceTimeoutMs < 1 || quiesceTimeoutMs > 120_000) {
      throw new Error("quiesceTimeoutMs must be between 1 and 120000");
    }
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      idFactory: options.idFactory ?? (() => `job-${randomUUID().slice(0, 8)}`),
      progressNotifyIntervalMs,
      quiesceTimeoutMs,
      stateDir: resolve(options.stateDir),
    };
    this.store = store;
    this.closed = options.startSuspended === true;
    this.suspendedForTakeover = options.startSuspended === true;
  }

  static async open(options: SessionJobManagerOptions): Promise<SessionJobManager> {
    if (options.startSuspended === true && options.recoverInterrupted !== false) {
      throw new Error("A suspended session-jobs successor must defer interrupted-job recovery until activation");
    }
    const stateDir = resolve(options.stateDir);
    const store = await SessionJobStore.open<MutableJob>({
      stateDir,
      maxRecords: MAX_RECORDS,
      maxActiveRecords: MAX_ACTIVE_JOBS,
      isActive: needsRetention,
      parse: parsePersistedJob,
      loadLegacy: async (path) => (await loadLegacyState(path)).jobs,
    });
    const manager = new SessionJobManager(options, store);
    const state = { schema: STATE_SCHEMA, jobs: store.load() } satisfies PersistedState;
    const now = new Date(manager.options.now()).toISOString();
    const recovered: MutableJob[] = [];
    for (const persisted of state.jobs) {
      const job: MutableJob = { ...persisted, origin: { ...persisted.origin }, timeline: [...persisted.timeline] };
      if (options.recoverInterrupted !== false && isActive(job.status)) {
        if (job.requestText) {
          job.status = "queued";
          delete job.error;
          delete job.completedAt;
          delete job.retryAttempt;
          delete job.retryMax;
          job.currentStatus = "Paused by FRIDAY restart; automatic resume pending";
        } else {
          job.status = "error";
          job.error = "FRIDAY restarted before this legacy background job completed and its full request was not persisted";
          job.currentStatus = "Interrupted by FRIDAY restart; automatic resume unavailable";
          job.completedAt = now;
        }
        job.updatedAt = now;
        recovered.push(job);
      }
      manager.jobs.set(job.id, job);
    }
    if (recovered.length > 0) await manager.persist(recovered);
    return manager;
  }

  async start(request: SessionJobStartRequest): Promise<SessionJobRecord> {
    // Serialize admission so concurrent retries carrying the same sourceKey cannot
    // both observe "missing" and create duplicate durable jobs. Lifecycle overlap
    // keeps the successor suspended, so this process-local gate covers all writers.
    const previous = this.admissionTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    this.admissionTail = previous.then(() => gate);
    await previous;
    try {
      return await this.startAdmitted(request);
    } finally {
      release();
    }
  }

  private async startAdmitted(request: SessionJobStartRequest): Promise<SessionJobRecord> {
    if (this.closed) throw new Error("session-jobs manager is closed");
    const sourceKey = request.sourceKey === undefined ? undefined : clip(request.sourceKey, 256);
    if (request.sourceKey !== undefined && !sourceKey) throw new Error("session job sourceKey must not be empty");
    if (sourceKey !== undefined) {
      const existing = [...this.jobs.values()].find((job) => job.sourceKey === sourceKey);
      if (existing) return clone(existing);
    }
    const activeCount = [...this.jobs.values()].filter(needsRetention).length;
    if (activeCount >= MAX_ACTIVE_JOBS) {
      throw new Error(`session-jobs active job limit reached (${MAX_ACTIVE_JOBS})`);
    }
    const destinationId = clip(request.destinationId, 256);
    if (!destinationId) throw new Error("session job destinationId is required");
    const id = clip(this.options.idFactory(), 96);
    if (!id || this.jobs.has(id)) throw new Error(`session job id is unavailable: ${id || "empty"}`);
    const createdAt = new Date(Number.isFinite(request.timestamp) ? request.timestamp : this.options.now()).toISOString();
    const label = clip(await this.options.resolveLabel?.(destinationId, request.text, request.origin) ?? defaultLabel(destinationId, request.text), 160);
    const activeAfterLabelResolution = [...this.jobs.values()].filter(needsRetention).length;
    if (activeAfterLabelResolution >= MAX_ACTIVE_JOBS) {
      throw new Error(`session-jobs active job limit reached (${MAX_ACTIVE_JOBS})`);
    }
    const queueKey = destinationId === "session:new" ? id : destinationId;
    const queuedBehindExisting = this.queues.has(queueKey);
    const job: MutableJob = {
      id,
      ...(sourceKey === undefined ? {} : { sourceKey }),
      ...(request.turnId === undefined ? {} : { turnId: clip(request.turnId, 256) }),
      destinationId,
      ...(request.agentProfileId === undefined ? {} : { agentProfileId: clip(request.agentProfileId, 96) }),
      ...(destinationId.startsWith("session:") && destinationId !== "session:new"
        ? { sessionId: destinationId.slice("session:".length) }
        : {}),
      label,
      requestPreview: clip(request.text, MAX_PREVIEW),
      requestText: clip(request.text, MAX_REQUEST_TEXT),
      origin: { ...request.origin },
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      currentStatus: queuedBehindExisting ? "Queued behind existing work in this session" : "Accepted for background execution",
      timeline: [],
      directives: [],
    };
    this.jobs.set(id, job);
    const run: ActiveRun = {
      controller: new AbortController(),
      request,
      queueKey,
      queueAliases: new Map(),
      settled: false,
      lastProgressNoticeAt: 0,
      directiveListeners: new Set(),
    };
    this.active.set(id, run);
    try {
      await this.persist([job]);
    } catch (error) {
      this.active.delete(id);
      this.jobs.delete(id);
      throw error;
    }
    this.publish("session-job.queued", job);
    const completion = queueSerial(this.queues, queueKey, () => this.runDetached(job, run));
    run.completion = completion;
    void completion.catch((error: unknown) => {
      reportOperationalError({
        component: "session-jobs",
        operation: `execute detached job ${job.id}`,
        error,
      });
    });
    return clone(job);
  }

  list(options: SessionJobListOptions = {}): readonly SessionJobRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("session job list limit must be between 1 and 500");
    return Object.freeze([...this.jobs.values()]
      .filter((job) => options.activeOnly === true ? isActive(job.status) : true)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(clone));
  }

  get(jobId: string): SessionJobRecord | undefined {
    const job = this.jobs.get(jobId.trim());
    return job ? clone(job) : undefined;
  }

  find(query: string, options: { activeOnly?: boolean | undefined } = {}): readonly SessionJobRecord[] {
    const raw = query.trim().toLowerCase();
    const selector = selectorText(query);
    if (!raw) return [];
    const terms = selector ? selector.split(" ").filter(Boolean) : [raw];
    const scored = [...this.jobs.values()]
      .filter((job) => options.activeOnly === true ? isActive(job.status) : true)
      .map((job) => {
        const haystacks = [job.id, job.destinationId, job.sessionId ?? "", job.label, job.requestPreview].map((value) => value.toLowerCase());
        let score = haystacks.some((value) => value === raw || value === selector) ? 100 : 0;
        for (const term of terms) if (haystacks.some((value) => value.includes(term))) score += 10;
        return { job, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.job.updatedAt.localeCompare(left.job.updatedAt));
    return Object.freeze(scored.map((entry) => clone(entry.job)));
  }

  async cancel(jobId: string, reason = "Cancelled by user"): Promise<SessionJobRecord> {
    const job = this.jobs.get(jobId.trim());
    if (!job) throw new Error(`Unknown session job: ${jobId}`);
    if (!isActive(job.status)) return clone(job);
    const completedAt = new Date(this.options.now()).toISOString();
    const cancelled = cloneMutable(job);
    cancelled.status = "cancelled";
    cancelled.error = errorMessage(new Error(reason));
    cancelled.currentStatus = "Cancellation requested";
    cancelled.completedAt = completedAt;
    cancelled.updatedAt = completedAt;
    delete cancelled.requestText;
    await this.persist([cancelled]);
    Object.assign(job, cancelled);
    delete job.requestText;
    const run = this.active.get(job.id);
    run?.controller.abort(job.error);
    this.publish("session-job.cancelled", job);
    if (run) await this.safeNotify(run.request.notify, `Cancelled ${job.label} (${job.id}).`);
    return clone(job);
  }

  async redirect(jobId: string, text: string): Promise<SessionJobDirective> {
    if (this.closed) throw new Error("session-jobs manager is closed");
    const job = this.jobs.get(jobId.trim());
    if (!job) throw new Error(`Unknown session job: ${jobId}`);
    if (!isActive(job.status)) throw new Error(`Session job is no longer active: ${job.id}`);
    const normalized = clip(text, MAX_REQUEST_TEXT);
    if (!normalized) throw new Error("job directive text is required");
    const createdAt = new Date(this.options.now()).toISOString();
    const directive: MutableDirective = {
      id: `directive-${randomUUID().slice(0, 12)}`,
      text: normalized,
      preview: clip(normalized, MAX_PREVIEW),
      status: "pending",
      createdAt,
    };
    const updated = cloneMutable(job);
    updated.directives.push(directive);
    if (updated.directives.length > 64) updated.directives.splice(0, updated.directives.length - 64);
    updated.currentStatus = `New direction received: ${directive.preview}`;
    updated.updatedAt = createdAt;
    await this.persist([updated]);
    Object.assign(job, updated);
    this.publish("session-job.directive.requested", job, undefined, directive.id);
    await this.applyPendingDirectives(job, this.active.get(job.id));
    return clone(job).directives.find((entry) => entry.id === directive.id)!;
  }

  /** Stop admission and durably pause resumable work before restart ownership changes. */
  async quiesce(): Promise<void> {
    if (this.databaseClosed || this.suspendedForTakeover) return;
    if (this.closed) {
      await this.persistTail;
      return;
    }
    this.closed = true;
    for (const handle of this.deferredFinalizers.values()) clearImmediate(handle);
    this.deferredFinalizers.clear();
    const changed: MutableJob[] = [];
    for (const [id, run] of this.active) {
      if (!run.settled) run.controller.abort("FRIDAY session-jobs manager is shutting down");
      const job = this.jobs.get(id);
      if (job && isActive(job.status)) {
        const pausedAt = new Date(this.options.now()).toISOString();
        if (job.requestText) {
          job.status = "queued";
          delete job.error;
          delete job.completedAt;
          delete job.retryAttempt;
          delete job.retryMax;
          job.currentStatus = "Paused for FRIDAY restart; automatic resume pending";
        } else {
          job.status = "error";
          job.error = "FRIDAY shut down before this legacy background job completed and its full request was not persisted";
          job.currentStatus = "Interrupted by shutdown; automatic resume unavailable";
          job.completedAt = pausedAt;
        }
        job.updatedAt = pausedAt;
        changed.push(job);
      }
    }
    if (changed.length > 0) await this.persist(changed);

    const completions = [...this.active.values()]
      .map((run) => run.completion)
      .filter((completion): completion is Promise<void> => completion !== undefined);
    completions.push(...this.notificationSends);
    if (completions.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(completions),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `session-jobs quiesce timed out with ${this.active.size} active run(s)`,
            )), this.options.quiesceTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await this.persistTail;
    if (this.active.size > 0) {
      throw new Error(`session-jobs quiesce did not settle ${this.active.size} active run(s)`);
    }
  }

  /** Reload the durable registry only after the predecessor has released ownership. */
  async activate(): Promise<void> {
    if (this.databaseClosed) throw new Error("session-jobs database is closed");
    if (!this.closed && !this.suspendedForTakeover) return;
    await this.persistTail;
    const now = new Date(this.options.now()).toISOString();
    const recovered: MutableJob[] = [];
    const loaded = this.store.load();
    this.jobs.clear();
    for (const persisted of loaded) {
      const job: MutableJob = { ...persisted, origin: { ...persisted.origin }, timeline: [...persisted.timeline] };
      if (isActive(job.status)) {
        if (job.requestText) {
          job.status = "queued";
          delete job.error;
          delete job.completedAt;
          delete job.retryAttempt;
          delete job.retryMax;
          job.currentStatus = "Paused by FRIDAY restart; automatic resume pending";
        } else {
          job.status = "error";
          job.error = "FRIDAY restarted before this legacy background job completed and its full request was not persisted";
          job.currentStatus = "Interrupted by FRIDAY restart; automatic resume unavailable";
          job.completedAt = now;
        }
        job.updatedAt = now;
        recovered.push(job);
      }
      this.jobs.set(job.id, job);
    }
    if (recovered.length > 0) await this.persist(recovered);
    this.suspendedForTakeover = false;
    this.closed = false;
  }

  resumable(): readonly SessionJobResumeRecord[] {
    return Object.freeze([...this.jobs.values()]
      .filter((job) => isActive(job.status) && !this.active.has(job.id) && Boolean(job.requestText))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => Object.freeze({
        id: job.id,
        destinationId: job.destinationId,
        ...(job.agentProfileId === undefined ? {} : { agentProfileId: job.agentProfileId }),
        requestText: job.requestText!,
        timestamp: Date.parse(job.createdAt),
        origin: Object.freeze({ ...job.origin }),
        directives: Object.freeze(job.directives.filter((directive) => directive.status === "pending").map((directive) => Object.freeze({ id: directive.id, text: directive.text }))),
      })));
  }

  async markResumed(jobId: string, resumedTurnId: string): Promise<SessionJobRecord> {
    const job = this.jobs.get(jobId.trim());
    if (!job) throw new Error(`Unknown session job: ${jobId}`);
    if (!isActive(job.status)) return clone(job);
    if (this.active.has(job.id)) throw new Error(`Cannot mark active process-local session job as resumed: ${job.id}`);
    const completedAt = new Date(this.options.now()).toISOString();
    const resumed = cloneMutable(job);
    resumed.status = "resumed";
    resumed.currentStatus = `Resumed after restart as turn ${clip(resumedTurnId, 160)}`;
    resumed.resultPreview = "Interrupted work was reconstructed from its durable transcript and original user request.";
    resumed.completedAt = completedAt;
    resumed.updatedAt = completedAt;
    delete resumed.error;
    delete resumed.requestText;
    await this.persist([resumed]);
    Object.assign(job, resumed);
    delete job.requestText;
    this.publish("session-job.resumed", job);
    return clone(job);
  }

  /** Host-only outbox access. Reply bodies never enter public job lists or Events. */
  pendingDeliveries(): readonly SessionJobRecord[] {
    return Object.freeze([...this.jobs.values()].filter((job) => job.notification !== undefined).map(clone));
  }

  async deliverPending(jobId: string, notify: (text: string) => Promise<void>, deferFinalization = false): Promise<void> {
    return queueSerial(this.deliveryQueues, jobId, async () => {
      if (this.closed || this.databaseClosed) throw new Error("session-jobs delivery is suspended");
      const job = this.jobs.get(jobId);
      if (!job?.notification) return;
      if (!job.notification.delivered) {
        const text = job.notification.text;
        const sending = Promise.resolve().then(() => notify(text));
        this.notificationSends.add(sending);
        try {
          await sending;
        } finally {
          this.notificationSends.delete(sending);
        }
        if (this.closed || this.databaseClosed) throw new Error("session-jobs delivery suspended before acknowledgement");
        const delivered = cloneMutable(job);
        delivered.notification!.delivered = true;
        await this.persist([delivered]);
        Object.assign(job, delivered);
      }
      if (job.notification!.requiresFinalization) {
        if (deferFinalization) {
          // Release the Events delivery before a handoff can quiesce Events itself.
          // The acknowledged reply and unfinished continuation remain durable.
          if (!this.deferredFinalizers.has(jobId)) {
            this.deferredFinalizers.set(jobId, setImmediate(() => {
              this.deferredFinalizers.delete(jobId);
              if (this.closed) return;
              void this.deliverPending(jobId, notify).catch((error: unknown) => {
                reportOperationalError({ component: "session-jobs", operation: `finalize delivered background job ${jobId}`, error });
              });
            }));
          }
          return;
        }
        const callback = this.notificationFinalizers.get(jobId);
        if (callback) await callback();
        else {
          if (!this.options.finalizeNotification || job.notification!.finalizers.length === 0) {
            throw new Error("Required background-job continuation cannot be reconstructed after restart");
          }
          await this.options.finalizeNotification(clone(job), structuredClone(job.notification!.finalizers), {
            turnId: job.turnId ?? job.id,
            text: job.requestText ?? job.requestPreview,
          });
        }
      }
      const finalized = cloneMutable(job);
      delete finalized.notification;
      delete finalized.requestText;
      await this.persist([finalized]);
      Object.assign(job, finalized);
      delete job.notification;
      delete job.requestText;
      this.notificationFinalizers.delete(jobId);
    });
  }

  async close(): Promise<void> {
    if (this.databaseClosed) return;
    const errors: Error[] = [];
    if (!this.suspendedForTakeover) {
      try {
        await this.quiesce();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await this.persistTail;
      this.store.close();
      this.databaseClosed = true;
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Session-jobs shutdown was incomplete");
  }

  private async runDetached(job: MutableJob, run: ActiveRun): Promise<void> {
    if (run.controller.signal.aborted || job.status === "cancelled") {
      run.settled = true;
      this.active.delete(job.id);
      return;
    }
    let notificationReady = false;
    try {
      const wasQueued = job.currentStatus?.startsWith("Queued") === true;
      const startedAt = new Date(this.options.now()).toISOString();
      const running = cloneMutable(job);
      running.status = "running";
      running.startedAt = startedAt;
      running.updatedAt = startedAt;
      running.currentStatus = "Running";
      await this.persist([running]);
      Object.assign(job, running);
      this.publish("session-job.started", job);
      if (wasQueued) await this.safeNotify(run.request.notify, `Now starting ${job.label} (${job.id}).`);

      const result = await run.request.run(
        run.controller.signal,
        async (progress) => this.report(job, run, progress),
        Object.freeze({
          jobId: job.id,
          onDirective: async (listener: (directive: SessionJobDirectiveMessage) => void) => {
            run.directiveListeners.add(listener);
            await this.applyPendingDirectives(job, run);
            return () => run.directiveListeners.delete(listener);
          },
        }),
      );
      if (run.controller.signal.aborted || !isActive(job.status)) return;
      if (result.sessionId !== undefined) this.bindSession(job, run, result.sessionId);
      const completedAt = new Date(this.options.now()).toISOString();
      const completed = cloneMutable(job);
      completed.status = "completed";
      completed.currentStatus = "Completed";
      completed.resultPreview = clip(result.text, MAX_PREVIEW);
      completed.completedAt = completedAt;
      completed.updatedAt = completedAt;
      completed.notification = parseNotification({
        text: clip([`Completed ${job.label} (${job.id}).`, "", result.text].join("\n"), 128_000),
        delivered: false,
        requiresFinalization: result.afterNotify !== undefined || (result.afterNotifyFinalizers?.length ?? 0) > 0,
        finalizers: result.afterNotifyFinalizers ?? [],
      });
      if (!completed.notification.requiresFinalization) delete completed.requestText;
      await this.persist([completed]);
      Object.assign(job, completed);
      if (completed.requestText === undefined) delete job.requestText;
      if (result.afterNotify) this.notificationFinalizers.set(job.id, result.afterNotify);
      notificationReady = true;
      this.publish("session-job.completed", job);
    } catch (error) {
      if (run.controller.signal.aborted || !isActive(job.status)) return;
      const completedAt = new Date(this.options.now()).toISOString();
      const failed = cloneMutable(job);
      failed.status = "error";
      failed.error = errorMessage(error);
      failed.currentStatus = "Failed";
      failed.completedAt = completedAt;
      failed.updatedAt = completedAt;
      delete failed.requestText;
      failed.notification = {
        text: [`${job.label} (${job.id}) failed.`, `Reason: ${failed.error}`, "The session and any work already persisted are preserved."].join("\n"),
        delivered: false,
        requiresFinalization: false,
        finalizers: [],
      };
      let terminalPersistenceError: unknown;
      try {
        await this.persist([failed]);
        Object.assign(job, failed);
        delete job.requestText;
        notificationReady = true;
      } catch (persistError) {
        terminalPersistenceError = persistError;
        // Reflect that execution has stopped without pretending the terminal state is
        // durable. Recovery on restart will still detect the old active row.
        Object.assign(job, failed, { currentStatus: "Failed; terminal persistence unavailable" });
      }
      this.publish("session-job.failed", job);
      if (terminalPersistenceError !== undefined) await this.safeNotify(run.request.notify, [
        `${job.label} (${job.id}) failed.`,
        `Reason: ${job.error}`,
        ...(terminalPersistenceError === undefined ? [] : ["The terminal job record could not be persisted; the failure was logged and restart recovery will reconcile the durable record."]),
        "The session and any work already persisted are preserved.",
      ].join("\n"));
      if (terminalPersistenceError !== undefined) throw terminalPersistenceError;
    } finally {
      run.settled = true;
      this.active.delete(job.id);
      for (const [alias, barrier] of run.queueAliases) {
        if (this.queues.get(alias) === barrier) this.queues.delete(alias);
      }
    }

    // A post-notify continuation (notably verified self-improvement handoff) may
    // quiesce Session Jobs itself. Release this job's active ownership first so
    // the continuation can never deadlock waiting for the run that invoked it.
    if (notificationReady) {
      try {
        await this.deliverPending(job.id, run.request.notify);
      } catch (error) {
        reportOperationalError({ component: "session-jobs", operation: `deliver background-job result or continuation for ${job.id}`, error });
        if (job.notification?.delivered) await this.safeNotify(
          run.request.notify,
          `${job.label} (${job.id}) completed, but its post-completion continuation failed: ${errorMessage(error)}`,
        );
        this.publish("session-job.delivery-requested", job);
      }
    }
  }

  private bindSession(job: MutableJob, run: ActiveRun, rawSessionId: string): void {
    const sessionId = rawSessionId.trim();
    if (!sessionId || sessionId.length > 256 || sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..") || /[\u0000-\u001f\u007f]/.test(sessionId)) {
      throw new Error(`Background job returned an invalid session id: ${JSON.stringify(rawSessionId)}`);
    }
    if (job.sessionId !== undefined && job.sessionId !== sessionId) {
      throw new Error(`Background job changed sessions from ${job.sessionId} to ${sessionId}`);
    }
    const destinationId = `session:${sessionId}`;
    if (job.destinationId !== "session:new" && job.destinationId !== destinationId) {
      throw new Error(`Background job destination ${job.destinationId} does not match runtime session ${destinationId}`);
    }
    job.sessionId = sessionId;
    job.destinationId = destinationId;
    if (run.queueKey === destinationId || run.queueAliases.has(destinationId)) return;
    const barrier = this.queues.get(run.queueKey);
    if (!barrier) return;
    const existing = this.queues.get(destinationId);
    if (existing !== undefined && existing !== barrier) {
      throw new Error(`Background session queue already exists for ${destinationId}`);
    }
    this.queues.set(destinationId, barrier);
    run.queueAliases.set(destinationId, barrier);
  }

  private async report(job: MutableJob, run: ActiveRun, progress: SessionJobProgress): Promise<void> {
    run.controller.signal.throwIfAborted();
    if (!isActive(job.status)) return;
    const nowMs = progress.timestamp ?? this.options.now();
    const at = new Date(nowMs).toISOString();
    if (progress.sessionId !== undefined) this.bindSession(job, run, progress.sessionId);
    const message = clip(progress.message, MAX_STATUS);
    const timeline: SessionJobTimelineEntry = {
      at,
      kind: progress.kind,
      message,
      ...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
      ...(progress.maxRetries === undefined ? {} : { maxRetries: progress.maxRetries }),
      ...(progress.delayMs === undefined ? {} : { delayMs: progress.delayMs }),
    };
    job.timeline.push(timeline);
    if (job.timeline.length > MAX_TIMELINE) job.timeline.splice(0, job.timeline.length - MAX_TIMELINE);
    job.currentStatus = message;
    job.updatedAt = at;
    if (progress.kind === "retry") {
      job.status = "retrying";
      if (progress.attempt === undefined) delete job.retryAttempt;
      else job.retryAttempt = progress.attempt;
      if (progress.maxRetries === undefined) delete job.retryMax;
      else job.retryMax = progress.maxRetries;
    } else if (job.status === "retrying") {
      job.status = "running";
    }
    await this.persist([job]);
    run.controller.signal.throwIfAborted();
    if (!isActive(job.status)) return;
    this.publish("session-job.progress", job, progress);

    const shouldNotify = progress.notify !== false && (
      progress.kind === "retry"
      || this.options.progressNotifyIntervalMs === 0
      || nowMs - run.lastProgressNoticeAt >= this.options.progressNotifyIntervalMs
    );
    if (shouldNotify) {
      run.lastProgressNoticeAt = nowMs;
      const retry = progress.kind === "retry" && progress.attempt !== undefined
        ? `Retry ${progress.attempt}/${progress.maxRetries ?? "?"}: `
        : "";
      await this.safeNotify(run.request.notify, `${job.label} (${job.id}) — ${retry}${message}`);
    }
    run.controller.signal.throwIfAborted();
  }

  private async applyPendingDirectives(job: MutableJob, run: ActiveRun | undefined): Promise<void> {
    if (!run || run.settled || run.directiveListeners.size === 0) return;
    const pending = job.directives.filter((entry) => entry.status === "pending");
    for (const directive of pending) {
      const message = Object.freeze({ id: directive.id, text: directive.text });
      for (const listener of run.directiveListeners) listener(message);
      directive.status = "applied";
      directive.appliedAt = new Date(this.options.now()).toISOString();
      job.updatedAt = directive.appliedAt;
      job.currentStatus = `Direction applied: ${directive.preview}`;
      await this.persist([job]);
      this.publish("session-job.directive.applied", job, undefined, directive.id);
    }
  }

  private publish(type: string, job: MutableJob, progress?: SessionJobProgress, directiveId?: string): void {
    try {
      this.options.events?.publish({
        type,
        source: "session-jobs",
        subject: `job:${job.id}`,
        data: {
          jobId: job.id,
          destinationId: job.destinationId,
          label: job.label,
          status: job.status,
          ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
          ...(progress?.kind === undefined ? {} : { progressKind: progress.kind }),
          ...(progress?.attempt === undefined ? {} : { retryAttempt: progress.attempt }),
          ...(directiveId === undefined ? {} : { directiveId }),
        },
      });
    } catch (error) {
      reportOperationalError({ component: "session-jobs", operation: `publish ${type}`, error });
    }
  }

  private persist(records?: readonly MutableJob[]): Promise<void> {
    // Capture the exact state requested by the caller now. Reading the mutable map
    // later, after waiting behind persistTail, can otherwise write a newer in-memory
    // state and make a failed transition appear durable when it never was.
    const source = records === undefined ? [...this.jobs.values()] : records;
    const snapshots = [...new Map(source.map((record) => [record.id, cloneMutable(record)])).values()];
    const operation = this.persistTail.then(() => this.persistRecords(snapshots));
    this.persistTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private persistRecords(updates: readonly MutableJob[]): void {
    if (this.databaseClosed) throw new Error("session-jobs database is closed");
    const retained = this.store.save(updates);
    for (const [id, job] of this.jobs) {
      if (!retained.has(id) && !isActive(job.status) && !this.active.has(id)) this.jobs.delete(id);
    }
  }

  private async safeNotify(notify: (text: string) => Promise<void>, text: string): Promise<void> {
    try {
      await notify(clip(text, 128_000));
    } catch (error) {
      reportOperationalError({ component: "session-jobs", operation: "deliver background-job notification", error });
    }
  }
}
