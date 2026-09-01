import { randomUUID } from "node:crypto";
import { reportOperationalError, sanitizeOperationalError } from "@friday/operational-errors";
import type {
  JsonValue,
  MissedRunPolicy,
  ScheduledRetryPolicy,
  ScheduledRunRecord,
  ScheduledTask,
  ScheduledTaskExecutor,
  ScheduledTaskInput,
  SchedulerRunOptions,
  SchedulerRunResult,
  SchedulerService,
  SchedulerWorkerOptions,
  SchedulerWorkerStatus,
} from "./contract.js";
import { nextFutureOccurrence, nextScheduleOccurrence, normalizeSchedule } from "./cron.js";
import { getSchedulerStateDir, SchedulerDatabase } from "./store.js";

const DEFAULT_RETRY: ScheduledRetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 60_000,
  multiplier: 2,
  maxDelayMs: 15 * 60_000,
};
const MISSING_EXECUTOR_RETRY_MS = 60_000;

export interface SchedulerServiceOptions {
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
  migrateLegacy?: boolean | undefined;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRun(run: ScheduledRunRecord): ScheduledRunRecord {
  return { ...run };
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    payload: cloneJson(task.payload),
    schedule: { ...task.schedule },
    retry: { ...task.retry },
    ...(task.lastRun ? { lastRun: cloneRun(task.lastRun) } : {}),
    ...(task.lease ? { lease: { ...task.lease } } : {}),
  };
}

function assertJsonValue(value: unknown, path = "payload"): asserts value is JsonValue {
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

function normalizeId(value: string, label = "task id"): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeTaskType(value: string): string {
  return normalizeId(value, "task type");
}

function normalizeMissedRunPolicy(value: MissedRunPolicy | undefined): MissedRunPolicy {
  return value ?? "coalesce";
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

function normalizeRetry(input: Partial<ScheduledRetryPolicy> | undefined): ScheduledRetryPolicy {
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

function retryDelay(policy: ScheduledRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * policy.multiplier ** exponent));
}

function errorMessage(error: unknown): string {
  return sanitizeOperationalError(error).safeMessage;
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

function successNextRun(task: ScheduledTask, run: ScheduledRunRecord, completed: Date): { enabled: boolean; nextRunAt: string } {
  if (task.schedule.kind === "once") return { enabled: false, nextRunAt: task.nextRunAt };
  if (task.missedRunPolicy === "catch-up") {
    return {
      enabled: true,
      nextRunAt: nextScheduleOccurrence(task.schedule, new Date(run.scheduledFor))!,
    };
  }
  return {
    enabled: true,
    nextRunAt: nextFutureOccurrence(task.schedule, run.scheduledFor, completed)!,
  };
}

export function createSchedulerService(options: SchedulerServiceOptions = {}): SchedulerService {
  const stateDir = options.stateDir ?? getSchedulerStateDir();
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const database = new SchedulerDatabase({ stateDir, migrateLegacy: options.migrateLegacy });
  const executors = new Map<string, ScheduledTaskExecutor>();
  const activeControllers = new Map<string, AbortController>();
  let closed = false;
  let workerController: AbortController | undefined;
  let workerPromise: Promise<void> | undefined;
  let workerStartedAt: string | undefined;
  let workerLastTickAt: string | undefined;
  let workerLastError: string | undefined;
  let workerLastFailureAt: string | undefined;
  let workerAttemptFailures = 0;
  let workerFailedOccurrences = 0;

  const assertOpen = (): void => {
    if (closed) throw new Error("scheduler service is closed");
  };

  const executeClaim = async (
    taskId: string,
    current: Date,
    leaseMs: number,
    outerSignal?: AbortSignal,
  ): Promise<SchedulerRunResult | undefined> => {
    const beforeClaim = database.getTask(taskId);
    const executor = executors.get(beforeClaim?.taskType ?? "");
    if (!executor) {
      const nextRunAt = new Date(current.getTime() + MISSING_EXECUTOR_RETRY_MS).toISOString();
      // Defer availability checks without changing the task's wall-clock phase. The
      // original due occurrence remains the run/idempotency anchor, so an interval
      // scheduled for :00 does not permanently drift to :01 just because its
      // executor was temporarily unavailable.
      database.updateMissedTask(
        taskId,
        nextRunAt,
        true,
        current.toISOString(),
        beforeClaim?.retryScheduledFor ?? beforeClaim?.nextRunAt,
      );
      return {
        taskId,
        status: "missing-executor",
        error: `No scheduler executor is registered for task type ${beforeClaim?.taskType ?? "unknown"}; retrying after ${nextRunAt}`,
      };
    }
    const leaseId = idFactory();
    const runId = idFactory();
    const claimed = database.claimTask(taskId, current.toISOString(), leaseMs, leaseId, runId);
    if (!claimed) return undefined;

    const localController = new AbortController();
    activeControllers.set(taskId, localController);
    const combined = combineSignals([outerSignal, localController.signal]);
    const heartbeatMs = Math.max(50, Math.floor(leaseMs / 3));
    const heartbeat = setInterval(() => {
      if (localController.signal.aborted) return;
      try {
        const renewed = database.renewLease(taskId, leaseId, now().toISOString(), leaseMs);
        if (!renewed) localController.abort(new Error(`Scheduled task lease was lost while executing: ${taskId}`));
      } catch (error) {
        localController.abort(error);
      }
    }, heartbeatMs);
    heartbeat.unref();
    let failure: string | undefined;
    let cancelled = false;
    try {
      await executor({ task: cloneTask(claimed.task), run: cloneRun(claimed.run), signal: combined.signal });
      cancelled = combined.signal.aborted;
    } catch (error) {
      cancelled = combined.signal.aborted || isAbortError(error);
      if (!cancelled) failure = errorMessage(error);
    } finally {
      clearInterval(heartbeat);
      combined.cleanup();
      if (activeControllers.get(taskId) === localController) activeControllers.delete(taskId);
    }

    const observedCompletion = now();
    const completed = observedCompletion.getTime() < current.getTime() ? current : observedCompletion;
    const task = claimed.task;
    if (cancelled) {
      database.completeClaim({
        taskId,
        leaseId,
        runId,
        completedAt: completed.toISOString(),
        status: "cancelled",
        enabled: task.enabled,
        nextRunAt: task.nextRunAt,
        ...(task.retryScheduledFor ? { retryScheduledFor: task.retryScheduledFor } : {}),
        consecutiveFailures: task.consecutiveFailures,
        consecutiveFailedOccurrences: task.consecutiveFailedOccurrences,
      });
      return { taskId, status: "cancelled" };
    }

    if (failure) {
      const exhausted = claimed.run.attempt >= task.retry.maxAttempts;
      if (!exhausted) {
        const nextRunAt = new Date(completed.getTime() + retryDelay(task.retry, claimed.run.attempt)).toISOString();
        database.completeClaim({
          taskId,
          leaseId,
          runId,
          completedAt: completed.toISOString(),
          status: "error",
          error: failure,
          enabled: true,
          nextRunAt,
          retryScheduledFor: claimed.run.scheduledFor,
          consecutiveFailures: task.consecutiveFailures + 1,
          consecutiveFailedOccurrences: task.consecutiveFailedOccurrences,
        });
      } else {
        const next = successNextRun(task, claimed.run, completed);
        database.completeClaim({
          taskId,
          leaseId,
          runId,
          completedAt: completed.toISOString(),
          status: "error",
          error: failure,
          enabled: next.enabled,
          nextRunAt: next.nextRunAt,
          consecutiveFailures: task.consecutiveFailures + 1,
          consecutiveFailedOccurrences: task.consecutiveFailedOccurrences + 1,
        });
      }
      return { taskId, status: "error", error: failure, occurrenceExhausted: exhausted };
    }

    const next = successNextRun(task, claimed.run, completed);
    database.completeClaim({
      taskId,
      leaseId,
      runId,
      completedAt: completed.toISOString(),
      status: "success",
      enabled: next.enabled,
      nextRunAt: next.nextRunAt,
      consecutiveFailures: 0,
      consecutiveFailedOccurrences: 0,
    });
    return { taskId, status: "success" };
  };

  const runTask = async (
    id: string,
    current: Date,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<SchedulerRunResult[]> => {
    const results: SchedulerRunResult[] = [];
    const initial = database.getTask(id);
    if (!initial) return results;
    const maximumRuns = initial.missedRunPolicy === "catch-up" ? initial.maxCatchUpRuns : 1;
    for (let count = 0; count < maximumRuns; count += 1) {
      signal?.throwIfAborted();
      const before = database.getTask(id);
      if (!before || !before.enabled || Date.parse(before.nextRunAt) > current.getTime()) break;
      const result = await executeClaim(id, current, leaseMs, signal);
      if (!result) break;
      results.push(result);
      if (result.status === "missing-executor" || result.status === "error" || result.status === "cancelled") break;
      const after = database.getTask(id);
      if (!after || after.missedRunPolicy !== "catch-up" || Date.parse(after.nextRunAt) > current.getTime()) break;
    }
    return results;
  };

  const applyRestartMissedPolicies = (startedAt: Date): void => {
    const startedIso = startedAt.toISOString();
    database.abandonExpiredLeases(startedIso);
    for (const task of database.listTasks()) {
      if (!task.enabled || task.missedRunPolicy !== "skip" || task.lease || Date.parse(task.nextRunAt) >= startedAt.getTime()) continue;
      if (task.schedule.kind === "once") {
        database.updateMissedTask(task.id, task.nextRunAt, false, startedIso);
        continue;
      }
      database.updateMissedTask(task.id, nextFutureOccurrence(task.schedule, task.nextRunAt, startedAt)!, true, startedIso);
    }
  };

  const service: SchedulerService = {
    schedule(input: ScheduledTaskInput) {
      assertOpen();
      const current = now();
      const id = normalizeId(input.id ?? idFactory());
      const taskType = normalizeTaskType(input.taskType);
      const payload = input.payload ?? null;
      assertJsonValue(payload);
      const normalized = normalizeSchedule(input.schedule, current);
      if (database.getTask(id)) throw new Error(`Scheduled task already exists: ${id}`);
      const timestamp = current.toISOString();
      const task: ScheduledTask = {
        id,
        name: input.name?.trim() || id,
        taskType,
        payload: cloneJson(payload),
        schedule: normalized.schedule,
        enabled: input.enabled ?? true,
        nextRunAt: normalized.nextRunAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        missedRunPolicy: normalizeMissedRunPolicy(input.missedRunPolicy),
        maxCatchUpRuns: normalizePositiveInteger(input.maxCatchUpRuns, 10, "maxCatchUpRuns", 1000),
        retry: normalizeRetry(input.retry),
        consecutiveFailures: 0,
        consecutiveFailedOccurrences: 0,
      };
      return cloneTask(database.createTask(task));
    },

    cancel(taskId) {
      assertOpen();
      const id = normalizeId(taskId);
      const task = database.cancelTask(id, now().toISOString());
      if (!task) throw new Error(`Unknown scheduled task: ${id}`);
      activeControllers.get(id)?.abort(new Error(`Scheduled task cancelled: ${id}`));
      return cloneTask(task);
    },

    remove(taskId) {
      assertOpen();
      return database.removeTask(normalizeId(taskId), now().toISOString());
    },

    get(taskId) {
      assertOpen();
      const task = database.getTask(normalizeId(taskId));
      return task ? cloneTask(task) : undefined;
    },

    list() {
      assertOpen();
      return database.listTasks().map(cloneTask);
    },

    history(historyOptions = {}) {
      assertOpen();
      const limit = normalizePositiveInteger(historyOptions.limit, 100, "history.limit", 10_000);
      const taskId = historyOptions.taskId ? normalizeId(historyOptions.taskId) : undefined;
      return database.history(taskId, limit).map(cloneRun);
    },

    registerExecutor(taskType, executor) {
      assertOpen();
      const normalized = normalizeTaskType(taskType);
      if (executors.has(normalized)) throw new Error(`Scheduler executor already registered: ${normalized}`);
      executors.set(normalized, executor);
      return () => {
        if (executors.get(normalized) === executor) executors.delete(normalized);
      };
    },

    async runDue(runOptions: SchedulerRunOptions = {}) {
      assertOpen();
      const current = runOptions.now ?? now();
      const maxTasks = normalizePositiveInteger(runOptions.maxTasks, 100, "maxTasks", 10_000);
      const maxConcurrent = normalizePositiveInteger(runOptions.maxConcurrent, 4, "maxConcurrent", 1000);
      const leaseMs = normalizeLeaseMs(runOptions.leaseMs, 5 * 60_000, "leaseMs");
      runOptions.signal?.throwIfAborted();
      database.abandonExpiredLeases(current.toISOString());
      const dueIds = database.listDueTaskIds(current.toISOString(), maxTasks);
      const results: SchedulerRunResult[] = [];
      for (let index = 0; index < dueIds.length; index += maxConcurrent) {
        runOptions.signal?.throwIfAborted();
        const batch = dueIds.slice(index, index + maxConcurrent);
        const batchResults = await Promise.all(batch.map((id) => runTask(id, current, leaseMs, runOptions.signal)));
        results.push(...batchResults.flat());
      }
      return results;
    },

    startWorker(workerOptions: SchedulerWorkerOptions = {}) {
      assertOpen();
      if (workerPromise) throw new Error("scheduler worker is already running");
      const pollIntervalMs = normalizePositiveInteger(workerOptions.pollIntervalMs, 1_000, "worker.pollIntervalMs");
      const maxTasksPerTick = normalizePositiveInteger(workerOptions.maxTasksPerTick, 100, "worker.maxTasksPerTick", 10_000);
      const maxConcurrent = normalizePositiveInteger(workerOptions.maxConcurrent, 4, "worker.maxConcurrent", 1000);
      const leaseMs = normalizeLeaseMs(workerOptions.leaseMs, 5 * 60_000, "worker.leaseMs");
      const started = now();
      applyRestartMissedPolicies(started);
      workerStartedAt = started.toISOString();
      workerLastTickAt = undefined;
      workerLastError = undefined;
      workerLastFailureAt = undefined;
      workerAttemptFailures = 0;
      workerFailedOccurrences = 0;
      const controller = new AbortController();
      workerController = controller;
      const onExternalAbort = (): void => controller.abort(workerOptions.signal?.reason);
      if (workerOptions.signal) {
        if (workerOptions.signal.aborted) controller.abort(workerOptions.signal.reason);
        else workerOptions.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
      const pending = (async () => {
        try {
          while (!controller.signal.aborted) {
            const tick = now();
            workerLastTickAt = tick.toISOString();
            try {
              const results = await service.runDue({ now: tick, maxTasks: maxTasksPerTick, maxConcurrent, leaseMs, signal: controller.signal });
              const missing = results.find((result) => result.status === "missing-executor");
              const failures = results.filter((result) => result.status === "error");
              workerAttemptFailures += failures.length;
              workerFailedOccurrences += failures.filter((result) => result.occurrenceExhausted === true).length;
              const latestFailure = [...results].reverse().find((result) => result.error);
              if (latestFailure?.error) {
                workerLastError = latestFailure.error;
                workerLastFailureAt = tick.toISOString();
              }
              if (missing?.error) {
                reportOperationalError({ component: "scheduler", operation: "defer task with missing executor", error: new Error(missing.error), severity: "warn" });
              }
            } catch (error) {
              if (controller.signal.aborted) break;
              workerLastError = errorMessage(error);
              workerLastFailureAt = tick.toISOString();
              workerAttemptFailures += 1;
              reportOperationalError({ component: "scheduler", operation: "run durable scheduler tick", error });
            }
            if (controller.signal.aborted) break;
            await delay(pollIntervalMs, controller.signal).catch((error: unknown) => {
              if (!controller.signal.aborted) reportOperationalError({ component: "scheduler", operation: "wait for durable scheduler tick", error });
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

    workerStatus(): SchedulerWorkerStatus {
      return {
        running: workerPromise !== undefined,
        ...(workerStartedAt ? { startedAt: workerStartedAt } : {}),
        ...(workerLastTickAt ? { lastTickAt: workerLastTickAt } : {}),
        ...(workerLastError ? { lastError: workerLastError } : {}),
        ...(workerLastFailureAt ? { lastFailureAt: workerLastFailureAt } : {}),
        attemptFailures: workerAttemptFailures,
        failedOccurrences: workerFailedOccurrences,
      };
    },

    async close() {
      if (closed) return;
      for (const controller of activeControllers.values()) controller.abort(new Error("scheduler service closed"));
      await service.stopWorker();
      activeControllers.clear();
      database.close();
      closed = true;
    },
  };

  return Object.freeze(service);
}
