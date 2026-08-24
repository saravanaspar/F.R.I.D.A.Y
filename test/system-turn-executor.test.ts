import { describe, expect, it } from "vitest";
import type { PermissionsService } from "../plugins/permissions/contract.js";
import type { SystemActionContribution } from "../plugins/system/contract.js";
import {
  createSystemActionsAction,
  createSystemStatusAction,
  createSystemTurnExecutor,
} from "../plugins/system/executor.js";
import type { TurnExecutionContext } from "../plugins/turn-loop/contract.js";

function context(text = "change a setting"): TurnExecutionContext {
  return {
    turn: {
      id: "message-1",
      principal: {
        authority: "local",
        channel: "local-test",
        accountId: "local",
        conversationId: "terminal",
        senderId: "local-user",
      },
      text,
      timestamp: Date.now(),
      async reply() {},
    },
    decision: {
      messageId: "message-1",
      destination: { kind: "system", id: "system" },
      execution: { profile: "system" },
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

function actionContext() {
  return {
    turn: context().turn,
    deferAfterReply() {},
  };
}

describe("system turn executor", () => {
  it("selects only contributed actions and authorizes host-declared system mutations", async () => {
    const authorized: string[] = [];
    const executed: unknown[] = [];
    const action: SystemActionContribution = {
      id: "demo.write",
      label: "Demo write",
      description: "Mutate a demo setting.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      permission(input) {
        return {
          id: "demo.write",
          effect: "system-write",
          resource: `demo:${String(input.value)}`,
          network: false,
        };
      },
      execute(input) {
        executed.push(input);
        return { changed: true, value: input.value };
      },
    };
    const executor = createSystemTurnExecutor({
      permissions: permissions(authorized),
      actions: () => [action],
      planner: async () => ({ actionId: "demo.write", input: { value: "on" } }),
    });

    expect(executor.canHandle(context().decision)).toBe(true);
    await expect(executor.execute(context())).resolves.toMatchObject({ metadata: { actionId: "demo.write" } });
    expect(authorized).toEqual(["demo.write:demo:on"]);
    expect(executed).toEqual([{ value: "on" }]);
  });

  it("aggregates plugin-owned status and exposes the installed action surface without importing owners", async () => {
    const status = createSystemStatusAction(() => [
      { id: "scheduler", label: "Scheduler", snapshot: () => ({ running: true }) },
      { id: "turn-loop", label: "Turn Loop", snapshot: () => ({ activeTurns: 0 }) },
    ]);
    const actions = createSystemActionsAction(() => [status]);

    await expect(status.execute({}, actionContext())).resolves.toEqual({
      scheduler: { label: "Scheduler", snapshot: { running: true } },
      "turn-loop": { label: "Turn Loop", snapshot: { activeTurns: 0 } },
    });
    expect(actions.execute({}, actionContext())).toEqual([
      { id: "system.status", label: "FRIDAY status", description: expect.any(String) },
    ]);
  });

  it("honors explicit log counts as one logical raw response and only analyzes when explicitly requested", async () => {
    const seenInputs: unknown[] = [];
    const logs: SystemActionContribution = {
      id: "observability.logs",
      label: "Observability logs",
      description: "Read logs",
      parameters: { type: "object", properties: { limit: { type: "integer" } } },
      execute(input) {
        seenInputs.push(input);
        const limit = Number(input.limit ?? 10);
        return Array.from({ length: limit }, (_, index) => ({ sequence: index + 1, message: `log-${index + 1}` }));
      },
    };
    const raw = createSystemTurnExecutor({
      permissions: permissions([]), actions: () => [logs],
      planner: async () => ({ actionId: "observability.logs", input: { limit: 50 }, presentation: "raw" }),
      presenter: async () => { throw new Error("raw log request must not invoke presenter"); },
    });
    const rawResult = await raw.execute(context("send me the last 50 logs"));
    expect(seenInputs).toEqual([{ limit: 50 }]);
    expect(rawResult.text).toContain("log-1");
    expect(rawResult.text).toContain("log-50");
    expect(rawResult.metadata).toEqual({ actionId: "observability.logs", presentation: "raw" });

    const analyzed = createSystemTurnExecutor({
      permissions: permissions([]), actions: () => [logs],
      planner: async () => ({ actionId: "observability.logs", input: { limit: 50 }, presentation: "analyze" }),
      presenter: async (request) => {
        expect((request.output as unknown[])).toHaveLength(50);
        return "The 50 sanitized logs show one recurring routing warning.";
      },
    });
    await expect(analyzed.execute(context("analyze the last 50 logs"))).resolves.toMatchObject({
      text: "The 50 sanitized logs show one recurring routing warning.",
      metadata: { actionId: "observability.logs", presentation: "analyze" },
    });
  });

  it("fails closed on unknown and duplicate system actions", async () => {
    const base: SystemActionContribution = {
      id: "same",
      label: "same",
      description: "same",
      parameters: {},
      execute: () => null,
    };
    const unknown = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [base],
      planner: async () => ({ actionId: "missing", input: {} }),
    });
    await expect(unknown.execute(context())).rejects.toThrow("unavailable action");

    const duplicate = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [base, base],
      planner: async () => ({ actionId: "same", input: {} }),
    });
    await expect(duplicate.execute(context())).rejects.toThrow("Duplicate system action contribution");
  });

  it("runs registered compensation for presentation and downstream delivery failures exactly once", async () => {
    const failures: string[] = [];
    const action: SystemActionContribution = {
      id: "restart",
      label: "Restart",
      description: "Launch a replacement",
      parameters: {},
      execute(_input, executionContext) {
        executionContext.deferOnFailure?.((error) => { failures.push((error as Error).message); });
        return { launched: true };
      },
    };
    const presentationFailure = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [action],
      planner: async () => ({ actionId: "restart", input: {}, presentation: "analyze" }),
      presenter: async () => { throw new Error("presentation failed"); },
    });
    await expect(presentationFailure.execute(context())).rejects.toThrow("presentation failed");
    expect(failures).toEqual(["presentation failed"]);

    const downstreamFailure = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [action],
      planner: async () => ({ actionId: "restart", input: {}, presentation: "raw" }),
    });
    const result = await downstreamFailure.execute(context());
    await result.afterFailure?.(new Error("reply failed"));
    await result.afterFailure?.(new Error("published twice"));
    expect(failures).toEqual(["presentation failed", "reply failed"]);
  });
});
