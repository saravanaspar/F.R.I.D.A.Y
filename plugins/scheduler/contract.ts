import type { Capability, Contribution } from "../capabilities/protocol.js";
import { defineCapability, defineContribution } from "../capabilities/protocol.js";
import type { PermissionAction } from "../permissions/contract.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ScheduleSpec =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; startAt?: string | undefined }
  | { kind: "cron"; expression: string; timezone: string };

export type MissedRunPolicy = "coalesce" | "catch-up" | "skip";

export interface ScheduledRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export interface ScheduledTaskInput {
  id?: string | undefined;
  name?: string | undefined;
  taskType: string;
  payload?: JsonValue | undefined;
  schedule: ScheduleSpec;
  enabled?: boolean | undefined;
  missedRunPolicy?: MissedRunPolicy | undefined;
  maxCatchUpRuns?: number | undefined;
  retry?: Partial<ScheduledRetryPolicy> | undefined;
}

export interface ScheduledRunRecord {
  runId: string;
  taskId: string;
  scheduledFor: string;
  idempotencyKey: string;
  attempt: number;
  startedAt: string;
  completedAt?: string | undefined;
  status: "running" | "success" | "error" | "cancelled" | "abandoned";
  error?: string | undefined;
}

export interface ScheduledTaskLease {
  id: string;
  claimedAt: string;
  expiresAt: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  taskType: string;
  payload: JsonValue;
  schedule: ScheduleSpec;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  missedRunPolicy: MissedRunPolicy;
  maxCatchUpRuns: number;
  retry: ScheduledRetryPolicy;
  consecutiveFailures: number;
  retryScheduledFor?: string | undefined;
  lastRun?: ScheduledRunRecord | undefined;
  lease?: ScheduledTaskLease | undefined;
}

export interface ScheduledTaskExecution {
  task: ScheduledTask;
  run: ScheduledRunRecord;
  signal?: AbortSignal | undefined;
}

export type ScheduledTaskExecutor = (execution: ScheduledTaskExecution) => Promise<void>;

export interface SchedulerRunResult {
  taskId: string;
  status: "success" | "error" | "cancelled" | "missing-executor";
  error?: string | undefined;
}

export interface SchedulerRunOptions {
  now?: Date | undefined;
  maxTasks?: number | undefined;
  maxConcurrent?: number | undefined;
  leaseMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface SchedulerHistoryOptions {
  taskId?: string | undefined;
  limit?: number | undefined;
}

export interface SchedulerWorkerOptions {
  pollIntervalMs?: number | undefined;
  maxTasksPerTick?: number | undefined;
  maxConcurrent?: number | undefined;
  leaseMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface SchedulerWorkerStatus {
  running: boolean;
  startedAt?: string | undefined;
  lastTickAt?: string | undefined;
  lastError?: string | undefined;
}

export interface SchedulerService {
  schedule(input: ScheduledTaskInput): ScheduledTask;
  cancel(taskId: string): ScheduledTask;
  remove(taskId: string): boolean;
  get(taskId: string): ScheduledTask | undefined;
  list(): readonly ScheduledTask[];
  history(options?: SchedulerHistoryOptions): readonly ScheduledRunRecord[];
  registerExecutor(taskType: string, executor: ScheduledTaskExecutor): () => void;
  runDue(options?: SchedulerRunOptions): Promise<readonly SchedulerRunResult[]>;
  startWorker(options?: SchedulerWorkerOptions): void;
  stopWorker(): Promise<void>;
  workerStatus(): SchedulerWorkerStatus;
  close(): Promise<void>;
}

export interface ScheduledActionOrigin {
  readonly authority: "local" | "channel";
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}

export interface ScheduledActionPrepareContext {
  readonly origin: ScheduledActionOrigin;
  readonly requestText: string;
  readonly now: string;
  readonly timezone: string;
}

export interface ScheduledActionExecutionContext {
  readonly task: ScheduledTask;
  readonly run: ScheduledRunRecord;
  readonly signal?: AbortSignal | undefined;
}

/**
 * A plugin-owned action that Scheduler can persist and execute later without
 * learning the implementation identity. `prepare` converts model-selected
 * JSON into a host-owned durable payload; this is where contributors bind
 * security-sensitive fields such as the destination conversation.
 */
export interface ScheduledActionContribution {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<JsonObject>;
  prepare(input: Readonly<JsonObject>, context: ScheduledActionPrepareContext): JsonValue;
  permission?(payload: JsonValue, context: ScheduledActionPrepareContext): PermissionAction | undefined;
  execute(payload: JsonValue, context: ScheduledActionExecutionContext): void | Promise<void>;
}

export const SCHEDULED_ACTION_TASK_TYPE = "friday.scheduled-action";

export const SCHEDULED_ACTION_CONTRIBUTION: Contribution<ScheduledActionContribution> =
  defineContribution<ScheduledActionContribution>("scheduler.action");

export const SCHEDULER_CAPABILITY: Capability<SchedulerService> =
  defineCapability<SchedulerService>("scheduler");
