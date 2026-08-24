import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SchedulerService } from "../plugins/scheduler/contract.js";
import { nextCronOccurrence } from "../plugins/scheduler/cron.js";
import { createSchedulerService, type SchedulerServiceOptions } from "../plugins/scheduler/scheduler.js";
import { getSchedulerDatabasePath, getSchedulerStatePath } from "../plugins/scheduler/store.js";

const temporaryDirectories: string[] = [];
const services: SchedulerService[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "friday-scheduler-"));
  temporaryDirectories.push(directory);
  return directory;
}

function scheduler(options: SchedulerServiceOptions): SchedulerService {
  const service = createSchedulerService(options);
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
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("scheduler plugin", () => {
  it("persists tasks in private SQLite state and reopens them", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T00:00:00.000Z");
    const first = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory() });

    first.schedule({
      id: "report-once",
      taskType: "report.generate",
      payload: { project: "friday" },
      schedule: { kind: "once", at: "2026-08-18T13:00:00Z" },
    });
    first.schedule({
      id: "daily-local",
      taskType: "report.daily",
      schedule: { kind: "cron", expression: "0 9 * * MON-FRI", timezone: "Asia/Kolkata" },
    });

    expect(first.get("report-once")?.payload).toEqual({ project: "friday" });
    expect(first.get("daily-local")?.nextRunAt).toBe("2026-08-18T03:30:00.000Z");
    expect((await stat(getSchedulerDatabasePath(stateDir))).mode & 0o777).toBe(0o600);

    await first.close();
    services.splice(services.indexOf(first), 1);
    const reopened = scheduler({ stateDir });
    expect(reopened.list().map((task) => task.id)).toEqual(["daily-local", "report-once"]);
  });

  it("imports the legacy JSON foundation into SQLite without deleting the legacy file", async () => {
    const stateDir = await tempDir();
    const legacyPath = getSchedulerStatePath(stateDir);
    await writeFile(legacyPath, JSON.stringify({
      schema: 1,
      tasks: {
        legacy: {
          id: "legacy",
          name: "legacy",
          taskType: "legacy.task",
          payload: null,
          schedule: { kind: "interval", everyMs: 60_000, startAt: "2026-08-18T12:00:00.000Z" },
          enabled: true,
          nextRunAt: "2026-08-18T12:00:00.000Z",
          createdAt: "2026-08-18T11:00:00.000Z",
          updatedAt: "2026-08-18T11:00:00.000Z",
        },
      },
    }), { mode: 0o600 });
    await chmod(legacyPath, 0o600);

    const service = scheduler({ stateDir });
    expect(service.get("legacy")?.missedRunPolicy).toBe("coalesce");
    expect(service.get("legacy")?.retry.maxAttempts).toBe(5);
    expect(await readFile(legacyPath, "utf8")).toContain('"legacy"');
    expect((await stat(getSchedulerDatabasePath(stateDir))).isFile()).toBe(true);
  });

  it("executes due one-shot and interval work with stable run metadata", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("run") });
    service.schedule({ id: "once", taskType: "test.once", schedule: { kind: "once", at: current.toISOString() } });
    service.schedule({ id: "repeat", taskType: "test.repeat", schedule: { kind: "interval", everyMs: 1_000, startAt: current.toISOString() } });
    const calls: Array<{ id: string; key: string }> = [];
    service.registerExecutor("test.once", async ({ task, run }) => {
      calls.push({ id: task.id, key: run.idempotencyKey });
      current = new Date("2026-08-18T12:00:00.500Z");
    });
    service.registerExecutor("test.repeat", async ({ task, run }) => {
      calls.push({ id: task.id, key: run.idempotencyKey });
      current = new Date("2026-08-18T12:00:02.200Z");
    });

    const results = await service.runDue({ now: new Date("2026-08-18T12:00:00.000Z") });

    expect(results).toEqual([
      { taskId: "once", status: "success" },
      { taskId: "repeat", status: "success" },
    ]);
    expect(calls.map((call) => call.id)).toEqual(["once", "repeat"]);
    expect(calls[0]?.key).toBe("scheduler:once:2026-08-18T12:00:00.000Z");
    expect(service.get("once")?.enabled).toBe(false);
    expect(service.get("repeat")?.nextRunAt).toBe("2026-08-18T12:00:03.000Z");
    expect(service.history({ limit: 10 }).map((run) => run.status)).toEqual(["success", "success"]);
  });

  it("does not claim a due task until its executor exists", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory() });
    service.schedule({ id: "waiting", taskType: "missing.executor", schedule: { kind: "once", at: current.toISOString() } });

    await expect(service.runDue({ now: current })).resolves.toEqual([
      {
        taskId: "waiting",
        status: "missing-executor",
        error: "No scheduler executor is registered for task type missing.executor; retrying after 2026-08-18T12:01:00.000Z",
      },
    ]);
    expect(service.get("waiting")?.lease).toBeUndefined();
    expect(service.get("waiting")?.nextRunAt).toBe("2026-08-18T12:01:00.000Z");
    expect(service.get("waiting")?.retryScheduledFor).toBe("2026-08-18T12:00:00.000Z");
    expect(service.history()).toEqual([]);
  });

  it("preserves recurring wall-clock phase while waiting for a missing executor", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("phase") });
    service.schedule({
      id: "hourly",
      taskType: "late.executor",
      schedule: { kind: "interval", everyMs: 60 * 60_000, startAt: current.toISOString() },
    });

    await service.runDue({ now: current });
    expect(service.get("hourly")?.nextRunAt).toBe("2026-08-18T12:01:00.000Z");
    expect(service.get("hourly")?.retryScheduledFor).toBe("2026-08-18T12:00:00.000Z");

    service.registerExecutor("late.executor", async () => undefined);
    current = new Date("2026-08-18T12:01:00.000Z");
    await expect(service.runDue({ now: current })).resolves.toEqual([{ taskId: "hourly", status: "success" }]);
    expect(service.get("hourly")?.nextRunAt).toBe("2026-08-18T13:00:00.000Z");
    expect(service.get("hourly")?.retryScheduledFor).toBeUndefined();
    expect(service.history({ taskId: "hourly" })[0]?.scheduledFor).toBe("2026-08-18T12:00:00.000Z");
  });

  it("uses bounded exponential retry and stops a one-shot after its attempt budget", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("retry") });
    service.schedule({
      id: "retry",
      taskType: "test.fail",
      schedule: { kind: "once", at: current.toISOString() },
      retry: { maxAttempts: 2, initialDelayMs: 30_000, multiplier: 2, maxDelayMs: 60_000 },
    });
    service.registerExecutor("test.fail", async () => {
      current = new Date(current.getTime() + 1_000);
      throw new Error("temporary failure");
    });

    await expect(service.runDue({ now: new Date("2026-08-18T12:00:00.000Z") })).resolves.toEqual([
      { taskId: "retry", status: "error", error: "temporary failure" },
    ]);
    expect(service.get("retry")?.nextRunAt).toBe("2026-08-18T12:00:31.000Z");
    expect(service.get("retry")?.retryScheduledFor).toBe("2026-08-18T12:00:00.000Z");

    current = new Date("2026-08-18T12:00:31.000Z");
    await service.runDue({ now: current });
    expect(service.get("retry")?.enabled).toBe(false);
    const history = service.history({ taskId: "retry" });
    expect(history.map((run) => run.attempt)).toEqual([2, 1]);
    expect(new Set(history.map((run) => run.idempotencyKey)).size).toBe(1);
  });

  it("evaluates five-field cron expressions in IANA timezones including DST gaps", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T00:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current });
    const task = service.schedule({
      id: "india-business-hours",
      taskType: "test.cron",
      schedule: { kind: "cron", expression: "0 9 * * MON-FRI", timezone: "Asia/Kolkata" },
    });
    expect(task.nextRunAt).toBe("2026-08-18T03:30:00.000Z");
    expect(nextCronOccurrence("30 2 * * *", "Europe/Berlin", new Date("2026-03-28T02:00:00.000Z")))
      .toBe("2026-03-30T00:30:00.000Z");
  });

  it("coalesces missed recurring occurrences by default", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-18T12:00:03.500Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory() });
    service.schedule({
      id: "coalesce",
      taskType: "test.coalesce",
      schedule: { kind: "interval", everyMs: 1_000, startAt: "2026-08-18T12:00:00.000Z" },
    });
    let calls = 0;
    service.registerExecutor("test.coalesce", async () => { calls += 1; });

    await service.runDue({ now: current });
    expect(calls).toBe(1);
    expect(service.get("coalesce")?.nextRunAt).toBe("2026-08-18T12:00:04.000Z");
  });

  it("bounds catch-up work per task while preserving each scheduled occurrence", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:03.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("catch") });
    service.schedule({
      id: "catch-up",
      taskType: "test.catch",
      schedule: { kind: "interval", everyMs: 1_000, startAt: "2026-08-18T12:00:00.000Z" },
      missedRunPolicy: "catch-up",
      maxCatchUpRuns: 3,
    });
    const scheduledFor: string[] = [];
    service.registerExecutor("test.catch", async ({ run }) => { scheduledFor.push(run.scheduledFor); });

    const results = await service.runDue({ now: current });
    expect(results).toHaveLength(3);
    expect(scheduledFor).toEqual([
      "2026-08-18T12:00:00.000Z",
      "2026-08-18T12:00:01.000Z",
      "2026-08-18T12:00:02.000Z",
    ]);
    expect(service.get("catch-up")?.nextRunAt).toBe("2026-08-18T12:00:03.000Z");
  });

  it("applies skip-on-restart policy before the durable worker begins claiming", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:05.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory() });
    service.schedule({
      id: "skip-old",
      taskType: "test.skip",
      schedule: { kind: "interval", everyMs: 1_000, startAt: "2026-08-18T12:00:00.000Z" },
      missedRunPolicy: "skip",
    });
    let calls = 0;
    service.registerExecutor("test.skip", async () => { calls += 1; });

    service.startWorker({ pollIntervalMs: 5 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    await service.stopWorker();

    expect(calls).toBe(0);
    expect(service.get("skip-old")?.nextRunAt).toBe("2026-08-18T12:00:06.000Z");
    expect(service.workerStatus().running).toBe(false);
  });

  it("aborts a cooperative active task before close waits for the worker", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("close") });
    service.schedule({ id: "close-me", taskType: "test.close", schedule: { kind: "once", at: current.toISOString() } });
    let started = false;
    let aborted = false;
    service.registerExecutor("test.close", async ({ signal }) => {
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
    service.startWorker({ pollIntervalMs: 5, leaseMs: 300 });
    await waitFor(() => started);
    await service.close();
    expect(aborted).toBe(true);
    expect(service.workerStatus().running).toBe(false);
  });

  it("uses SQLite leases so concurrent scheduler instances claim a task only once", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:00.000Z");
    const first = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("first") });
    const second = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("second") });
    first.schedule({ id: "single", taskType: "test.single", schedule: { kind: "once", at: current.toISOString() } });
    let calls = 0;
    const executor = async (): Promise<void> => {
      calls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    };
    first.registerExecutor("test.single", executor);
    second.registerExecutor("test.single", executor);

    const [left, right] = await Promise.all([
      first.runDue({ now: current }),
      second.runDue({ now: current }),
    ]);
    expect(calls).toBe(1);
    expect([...left, ...right].filter((result) => result.status === "success")).toHaveLength(1);
  });

  it("renews leases while long-running executors are active", async () => {
    const stateDir = await tempDir();
    let current = new Date("2026-08-18T12:00:00.000Z");
    const first = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("heartbeat-a") });
    const second = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("heartbeat-b") });
    first.schedule({ id: "long", taskType: "test.long", schedule: { kind: "once", at: current.toISOString() } });
    let release: (() => void) | undefined;
    let started = false;
    first.registerExecutor("test.long", async () => {
      started = true;
      await new Promise<void>((resolveRun) => { release = resolveRun; });
    });
    second.registerExecutor("test.long", async () => { throw new Error("duplicate claim"); });

    const running = first.runDue({ now: current, leaseMs: 300 });
    await waitFor(() => started);
    current = new Date("2026-08-18T12:00:00.200Z");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    current = new Date("2026-08-18T12:00:00.400Z");

    await expect(second.runDue({ now: current, leaseMs: 300 })).resolves.toEqual([]);
    release?.();
    await expect(running).resolves.toEqual([{ taskId: "long", status: "success" }]);
  });

  it("recovers an expired lease with the same idempotency key and a new attempt", async () => {
    const stateDir = await tempDir();
    let firstRelease: (() => void) | undefined;
    let firstStarted = false;
    const firstNow = new Date("2026-08-18T12:00:00.000Z");
    const first = scheduler({ stateDir, now: () => firstNow, idFactory: sequenceFactory("a") });
    first.schedule({ id: "recover", taskType: "test.recover", schedule: { kind: "once", at: firstNow.toISOString() } });
    let firstKey = "";
    first.registerExecutor("test.recover", async ({ run }) => {
      firstKey = run.idempotencyKey;
      firstStarted = true;
      await new Promise<void>((resolveRun) => { firstRelease = resolveRun; });
    });
    const firstRun = first.runDue({ now: firstNow, leaseMs: 1_000 });
    await waitFor(() => firstStarted);

    const recoveredNow = new Date("2026-08-18T12:00:02.000Z");
    const second = scheduler({ stateDir, now: () => recoveredNow, idFactory: sequenceFactory("b") });
    let secondKey = "";
    second.registerExecutor("test.recover", async ({ run }) => { secondKey = run.idempotencyKey; });
    await expect(second.runDue({ now: recoveredNow, leaseMs: 1_000 })).resolves.toEqual([
      { taskId: "recover", status: "success" },
    ]);

    expect(secondKey).toBe(firstKey);
    expect(second.history({ taskId: "recover" }).map((run) => run.status)).toEqual(["success", "abandoned"]);
    expect(second.history({ taskId: "recover" }).map((run) => run.attempt)).toEqual([2, 1]);

    firstRelease?.();
    await expect(firstRun).rejects.toThrow(/lease changed while executing/);
  });

  it("cancels an in-process execution through its AbortSignal and records it", async () => {
    const stateDir = await tempDir();
    const current = new Date("2026-08-18T12:00:00.000Z");
    const service = scheduler({ stateDir, now: () => current, idFactory: sequenceFactory("cancel") });
    service.schedule({ id: "cancel-me", taskType: "test.cancel", schedule: { kind: "once", at: current.toISOString() } });
    let started = false;
    service.registerExecutor("test.cancel", async ({ signal }) => {
      started = true;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    const running = service.runDue({ now: current });
    await waitFor(() => started);
    service.cancel("cancel-me");
    await expect(running).resolves.toEqual([{ taskId: "cancel-me", status: "cancelled" }]);
    expect(service.get("cancel-me")?.enabled).toBe(false);
    expect(service.history({ taskId: "cancel-me" })[0]?.status).toBe("cancelled");
  });

  it("fails closed on a corrupt legacy scheduler state during first migration", async () => {
    const stateDir = await tempDir();
    const path = getSchedulerStatePath(stateDir);
    await writeFile(path, "{broken", { mode: 0o600 });
    await chmod(path, 0o600);

    expect(() => createSchedulerService({ stateDir })).toThrow(/Unable to parse scheduler state/);
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});
