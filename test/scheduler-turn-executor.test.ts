import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionsService } from "../plugins/permissions/contract.js";
import type { PermissionsTrustedService } from "../plugins/permissions/trusted-contract.js";
import { principalScope } from "../plugins/principal-scope.js";
import {
  type JsonValue,
  type ScheduledActionContribution,
} from "../plugins/scheduler/contract.js";
import { createSchedulerService } from "../plugins/scheduler/scheduler.js";
import {
  createSchedulerTurnExecutor,
  installScheduledActionDispatcher,
  type SchedulerTurnPlan,
} from "../plugins/scheduler/turn-executor.js";
import type { TurnExecutionContext } from "../plugins/turn-loop/contract.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "friday-scheduler-turn-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(text = "remind me in a minute", senderId = "user-9"): TurnExecutionContext {
  return {
    turn: {
      id: "message-1",
      principal: {
        authority: "channel",
        channel: "telegram",
        accountId: "main",
        conversationId: "chat-7",
        senderId,
      },
      text,
      timestamp: Date.now(),
      async reply() {},
    },
    decision: {
      messageId: "message-1",
      destination: { kind: "scheduler", id: "scheduler" },
      execution: { profile: "scheduler" },
      confidence: 1,
    },
  };
}

function permissions(log: string[]): PermissionsService {
  return {
    normalizeMode: () => "full",
    async authorize(request) {
      log.push(`${request.action.id}:${request.action.resource}`);
      return { allowed: true, approvedBy: "policy" };
    },
    assertWorkspacePath: (_workspace, path) => path,
  };
}

function trustedPermissions(systemRuns: string[]): PermissionsTrustedService {
  return {
    identities: () => [],
    trustChannelIdentity() { throw new Error("not used"); },
    revokeChannelIdentity() { throw new Error("not used"); },
    runAsLocal: (operation) => operation(),
    runAsChannel: (_selector, operation) => operation(),
    runAsSystem(service, operation) {
      systemRuns.push(service);
      return operation();
    },
  };
}

describe("scheduler turn executor", () => {
  it("creates a host-bound scheduled action and executes it later as the Scheduler system principal", async () => {
    let current = new Date("2026-08-19T12:00:00.000Z");
    const ids = ["task-1", "lease-1", "run-1"];
    const scheduler = createSchedulerService({
      stateDir: tempRoot(),
      now: () => current,
      idFactory: () => ids.shift() ?? `id-${Date.now()}`,
    });
    const authorizations: string[] = [];
    const systemRuns: string[] = [];
    const executions: JsonValue[] = [];
    const action: ScheduledActionContribution = {
      id: "test.reminder",
      label: "Test reminder",
      description: "Deliver a test reminder to the bound origin.",
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      prepare(input, prepareContext) {
        return {
          message: input.message as string,
          conversationId: prepareContext.origin.conversationId,
        };
      },
      permission(payload) {
        const value = payload as { conversationId: string };
        return {
          id: "test.reminder.send",
          effect: "external-write",
          resource: `conversation:${value.conversationId}`,
          network: true,
        };
      },
      execute(payload) {
        executions.push(payload);
      },
    };
    const actions = () => [action];
    const dispose = installScheduledActionDispatcher({
      scheduler,
      permissions: trustedPermissions(systemRuns),
      actions,
    });
    const plan: SchedulerTurnPlan = {
      operation: "create",
      actionId: action.id,
      input: { message: "Stand up" },
      schedule: { kind: "once", at: "2026-08-19T12:01:00.000Z" },
      name: "stand-up-reminder",
    };
    const executor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions(authorizations),
      actions,
      planner: async () => plan,
      now: () => current,
      timezone: () => "UTC",
    });

    expect(executor.canHandle(context().decision)).toBe(true);
    const result = await executor.execute(context());
    expect(result.text).toContain("Scheduled stand-up-reminder (task-1)");
    expect(authorizations).toEqual([
      "test.reminder.send:conversation:chat-7",
      "scheduler.task.create:scheduler:test.reminder",
    ]);
    expect(scheduler.list()[0]).toMatchObject({
      id: "task-1",
      name: "stand-up-reminder",
      taskType: "friday.scheduled-action",
      payload: {
        version: 2,
        ownerScope: principalScope(context().turn.principal),
        actionId: "test.reminder",
        payload: { message: "Stand up", conversationId: "chat-7" },
      },
    });

    current = new Date("2026-08-19T12:01:01.000Z");
    await expect(scheduler.runDue({ now: current })).resolves.toEqual([{ taskId: "task-1", status: "success" }]);
    expect(systemRuns).toEqual(["scheduler"]);
    expect(executions).toEqual([{ message: "Stand up", conversationId: "chat-7" }]);

    dispose();
    await scheduler.close();
  });

  it("uses scheduler management operations instead of hard-coded Turn Loop branches", async () => {
    let currentPlan: SchedulerTurnPlan = { operation: "list" };
    const scheduler = createSchedulerService({ stateDir: tempRoot(), idFactory: () => "managed" });
    scheduler.schedule({
      id: "managed",
      name: "managed-task",
      taskType: "friday.scheduled-action",
      payload: {
        version: 2,
        ownerScope: principalScope(context().turn.principal),
        actionId: "test.none",
        payload: {},
      },
      schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
    });
    const authorizations: string[] = [];
    const executor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions(authorizations),
      actions: () => [],
      planner: async () => currentPlan,
      timezone: () => "UTC",
    });

    await expect(executor.execute(context("list my schedules"))).resolves.toMatchObject({ metadata: { operation: "list" } });
    currentPlan = { operation: "cancel", taskId: "managed" };
    await expect(executor.execute(context("cancel it"))).resolves.toMatchObject({ metadata: { operation: "cancel", taskId: "managed" } });
    expect(authorizations).toEqual(["scheduler.task.cancel:scheduler:managed"]);

    currentPlan = { operation: "remove", taskId: "managed" };
    await expect(executor.execute(context("remove it"))).resolves.toMatchObject({ metadata: { operation: "remove", taskId: "managed" } });
    expect(scheduler.get("managed")).toBeUndefined();
    expect(authorizations.at(-1)).toBe("scheduler.task.remove:scheduler:managed");
    await scheduler.close();
  });

  it("keeps task discovery and mutations scoped to the exact originating principal", async () => {
    let currentPlan: SchedulerTurnPlan = { operation: "list" };
    let plannerTaskIds: readonly string[] = [];
    const scheduler = createSchedulerService({ stateDir: tempRoot() });
    const future = new Date(Date.now() + 60_000).toISOString();
    const alice = context("list my schedules", "alice").turn.principal;
    const bob = context("list my schedules", "bob").turn.principal;
    for (const [id, name, ownerScope] of [
      ["alice-task", "Alice private reminder", principalScope(alice)],
      ["bob-task", "Bob private reminder", principalScope(bob)],
    ] as const) {
      scheduler.schedule({
        id,
        name,
        taskType: "friday.scheduled-action",
        payload: { version: 2, ownerScope, actionId: "test.none", payload: {} },
        schedule: { kind: "once", at: future },
      });
    }
    const authorizations: string[] = [];
    const executor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions(authorizations),
      actions: () => [],
      planner: async (request) => {
        plannerTaskIds = request.tasks.map((task) => task.id);
        return currentPlan;
      },
    });

    const listed = await executor.execute(context("list my schedules", "alice"));
    expect(plannerTaskIds).toEqual(["alice-task"]);
    expect(listed.text).toContain("Alice private reminder");
    expect(listed.text).not.toContain("Bob private reminder");

    currentPlan = { operation: "cancel", taskId: "bob-task" };
    await expect(executor.execute(context("cancel Bob's task", "alice"))).rejects.toThrow("Unknown scheduled task");
    expect(scheduler.get("bob-task")?.enabled).toBe(true);
    expect(authorizations).toEqual([]);
    await scheduler.close();
  });

  it("uses the configured user timezone as the authoritative wall-clock zone for cron schedules", async () => {
    const scheduler = createSchedulerService({ stateDir: tempRoot(), idFactory: () => "timezone-task" });
    const action: ScheduledActionContribution = {
      id: "test.timezone",
      label: "Timezone test",
      description: "Test timezone binding",
      parameters: {},
      prepare: () => ({}),
      permission: () => ({ id: "test.timezone", effect: "system-write", resource: "test:timezone", network: false }),
      execute() {},
    };
    let plannerZone = "";
    const executor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions([]),
      actions: () => [action],
      timezone: () => "Asia/Kolkata",
      planner: async (request) => {
        plannerZone = request.timezone;
        return {
          operation: "create",
          actionId: action.id,
          input: {},
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "America/Los_Angeles" },
        };
      },
    });

    await executor.execute(context("every day at 9"));
    expect(plannerZone).toBe("Asia/Kolkata");
    expect(scheduler.get("timezone-task")?.schedule).toEqual({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Asia/Kolkata",
    });
    await scheduler.close();
  });

  it("fails closed when a planner selects an uninstalled or duplicate scheduled action", async () => {
    const scheduler = createSchedulerService({ stateDir: tempRoot() });
    const plan: SchedulerTurnPlan = {
      operation: "create",
      actionId: "missing",
      input: {},
      schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
    };
    const executor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions([]),
      actions: () => [],
      planner: async () => plan,
    });
    await expect(executor.execute(context())).rejects.toThrow("unavailable action");

    const duplicate: ScheduledActionContribution = {
      id: "same",
      label: "same",
      description: "same",
      parameters: {},
      prepare: () => null,
      permission: () => ({ id: "same", effect: "system-write", resource: "test:same", network: false }),
      execute() {},
    };
    const duplicateExecutor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions([]),
      actions: () => [duplicate, duplicate],
      planner: async () => ({ operation: "list" }),
    });
    await expect(duplicateExecutor.execute(context())).rejects.toThrow("Duplicate scheduled action contribution");

    const missingPermissionExecutor = createSchedulerTurnExecutor({
      scheduler,
      permissions: permissions([]),
      actions: () => [{ ...duplicate, id: "missing-permission", permission: undefined } as unknown as ScheduledActionContribution],
      planner: async () => ({ operation: "list" }),
    });
    await expect(missingPermissionExecutor.execute(context())).rejects.toThrow("no explicit permission declaration");
    await scheduler.close();
  });
});
