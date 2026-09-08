import { describe, expect, it } from "vitest";
import * as modelApi from "@friday/model";
import type { ModelService } from "../plugins/model/contract.js";
import type { PermissionsService } from "../plugins/permissions/contract.js";
import type { SystemActionContribution } from "../plugins/system/contract.js";
import {
  createSystemActionInputValidator,
  createSystemActionsAction,
  createSystemModelPlanner,
  createSystemModelPresenter,
  createOperatorDashboardAction,
  createSystemStatusAction,
  createSystemTurnExecutor,
} from "../plugins/system/executor.js";
import type { TurnExecutionContext } from "../plugins/turn-loop/contract.js";

const validateInput = createSystemActionInputValidator({
  validateToolArguments: modelApi.validateToolArguments,
});

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
  it("uses the cheap routing model for action planning unless a System model is explicitly configured", async () => {
    const names = [
      "FRIDAY_MODEL_PROVIDER",
      "FRIDAY_MODEL_ID",
      "FRIDAY_ROUTING_PROVIDER",
      "FRIDAY_ROUTING_MODEL_ID",
      "FRIDAY_SYSTEM_PROVIDER",
      "FRIDAY_SYSTEM_MODEL_ID",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const selected: Array<{ provider: string; id: string }> = [];
    const models = {
      getModel(provider: string, id: string) {
          selected.push({ provider, id });
          return { provider, id };
        },
        async completeSimple() {
          return {
            content: [{ type: "text", text: JSON.stringify({ actionId: "system.actions", input: {} }) }],
            stopReason: "stop",
          };
        },
      parseJsonWithRepair(value: string) { return JSON.parse(value) as unknown; },
    } as unknown as ModelService;
    try {
      process.env.FRIDAY_MODEL_PROVIDER = "main-provider";
      process.env.FRIDAY_MODEL_ID = "expensive-coding-model";
      process.env.FRIDAY_ROUTING_PROVIDER = "routing-provider";
      process.env.FRIDAY_ROUTING_MODEL_ID = "cheap-router";
      delete process.env.FRIDAY_SYSTEM_PROVIDER;
      delete process.env.FRIDAY_SYSTEM_MODEL_ID;

      await createSystemModelPlanner(models)({ text: "create a conditional hook", actions: [] });
      expect(selected).toEqual([{ provider: "routing-provider", id: "cheap-router" }]);

      delete process.env.FRIDAY_MODEL_PROVIDER;
      delete process.env.FRIDAY_MODEL_ID;
      await createSystemModelPlanner(models)({ text: "continue setup", actions: [] });
      expect(selected.at(-1)).toEqual({ provider: "routing-provider", id: "cheap-router" });

      process.env.FRIDAY_SYSTEM_PROVIDER = "system-provider";
      process.env.FRIDAY_SYSTEM_MODEL_ID = "dedicated-system-model";
      await createSystemModelPlanner(models)({ text: "show status", actions: [] });
      expect(selected.at(-1)).toEqual({ provider: "system-provider", id: "dedicated-system-model" });
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("uses the control model only for bounded presentation and the main model for substantive analysis", async () => {
    const names = [
      "FRIDAY_MODEL_PROVIDER",
      "FRIDAY_MODEL_ID",
      "FRIDAY_ROUTING_PROVIDER",
      "FRIDAY_ROUTING_MODEL_ID",
      "FRIDAY_SYSTEM_PROVIDER",
      "FRIDAY_SYSTEM_MODEL_ID",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const selected: Array<{ provider: string; id: string }> = [];
    const prompts: string[] = [];
    const models = {
      getModel(provider: string, id: string) {
        selected.push({ provider, id });
        return { provider, id };
      },
      async completeSimple(_model: unknown, request: { systemPrompt: string }) {
        prompts.push(request.systemPrompt);
        return { content: [{ type: "text", text: "Formatted result" }], stopReason: "stop" };
      },
      parseJsonWithRepair(value: string) { return JSON.parse(value) as unknown; },
    } as unknown as ModelService;

    try {
      process.env.FRIDAY_MODEL_PROVIDER = "main-provider";
      process.env.FRIDAY_MODEL_ID = "reasoning-model";
      process.env.FRIDAY_ROUTING_PROVIDER = "routing-provider";
      process.env.FRIDAY_ROUTING_MODEL_ID = "router-model";
      delete process.env.FRIDAY_SYSTEM_PROVIDER;
      delete process.env.FRIDAY_SYSTEM_MODEL_ID;

      const presenter = createSystemModelPresenter(models);
      const action = { id: "diagnostics.doctor", label: "Doctor", description: "Run Doctor", parameters: {} };
      await expect(presenter({ mode: "present", userText: "run doctor", action, output: { status: "ready" } })).resolves.toBe("Formatted result");
      expect(selected.at(-1)).toEqual({ provider: "routing-provider", id: "router-model" });
      expect(prompts.at(-1)).toContain("bounded control-plane response presenter");
      expect(prompts.at(-1)).toContain("Do not perform root-cause analysis");

      await expect(presenter({ mode: "analyze", userText: "why is voice broken?", action, output: { status: "needs-attention" } })).resolves.toBe("Formatted result");
      expect(selected.at(-1)).toEqual({ provider: "main-provider", id: "reasoning-model" });
      expect(prompts.at(-1)).toContain("main reasoning model analyzing bounded, sanitized system evidence");

      delete process.env.FRIDAY_MODEL_PROVIDER;
      delete process.env.FRIDAY_MODEL_ID;
      await expect(presenter({ mode: "analyze", userText: "explain this", action, output: {} })).rejects.toThrow("Main reasoning model is required");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

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
      validateInput,
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

  it("builds one timestamped operator dashboard from plugin-owned status sections", async () => {
    const dashboard = createOperatorDashboardAction(() => [
      { id: "session-jobs", label: "Jobs", snapshot: () => ({ activeJobs: [{ jobId: "job-1", status: "running" }] }) },
      { id: "channels", label: "Channels", snapshot: () => ({ pendingInteractions: { approvals: [{ requestId: "approval-1", jobId: "job-1" }] } }) },
    ]);
    const result = await dashboard.execute({}, actionContext()) as { generatedAt: string; sections: Record<string, unknown> };
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
    expect(result.sections).toMatchObject({
      "session-jobs": { snapshot: { activeJobs: [{ jobId: "job-1" }] } },
      channels: { snapshot: { pendingInteractions: { approvals: [{ requestId: "approval-1", jobId: "job-1" }] } } },
    });
  });

  it("honors explicit log counts as one logical raw response and only analyzes when explicitly requested", async () => {
    const seenInputs: unknown[] = [];
    const logs: SystemActionContribution = {
      id: "observability.logs",
      label: "Observability logs",
      description: "Read logs",
      parameters: { type: "object", properties: { limit: { type: "integer" } } },
      permission: () => ({ id: "observability.logs", effect: "global-operational-read", resource: "observability:logs", network: false }),
      execute(input) {
        seenInputs.push(input);
        const limit = Number(input.limit ?? 10);
        return Array.from({ length: limit }, (_, index) => ({ sequence: index + 1, message: `log-${index + 1}` }));
      },
    };
    const raw = createSystemTurnExecutor({
      permissions: permissions([]), actions: () => [logs],
      planner: async () => ({ actionId: "observability.logs", input: { limit: 50 }, presentation: "raw" }),
      validateInput,
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
      validateInput,
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
      permission: () => ({ id: "same", effect: "global-operational-read", resource: "test", network: false }),
      execute: () => null,
    };
    const unknown = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [base],
      planner: async () => ({ actionId: "missing", input: {} }),
      validateInput,
    });
    await expect(unknown.execute(context())).rejects.toThrow("unavailable action");

    const duplicate = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [base, base],
      planner: async () => ({ actionId: "same", input: {} }),
      validateInput,
    });
    await expect(duplicate.execute(context())).rejects.toThrow("Duplicate system action contribution");

    const missingPermission = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [{ ...base, permission: undefined } as unknown as SystemActionContribution],
      planner: async () => ({ actionId: "same", input: {} }),
      validateInput,
    });
    await expect(missingPermission.execute(context())).rejects.toThrow("no explicit permission declaration");

    const emptyPermission = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [{ ...base, permission: () => undefined } as unknown as SystemActionContribution],
      planner: async () => ({ actionId: "same", input: {} }),
      validateInput,
    });
    await expect(emptyPermission.execute(context())).rejects.toThrow("returned no permission declaration");
  });

  it("runs registered compensation for presentation and downstream delivery failures exactly once", async () => {
    const failures: string[] = [];
    const action: SystemActionContribution = {
      id: "restart",
      label: "Restart",
      description: "Launch a replacement",
      parameters: {},
      permission: () => ({ id: "restart", effect: "system-write", resource: "test", network: false }),
      execute(_input, executionContext) {
        executionContext.deferOnFailure?.((error) => { failures.push((error as Error).message); });
        return { launched: true };
      },
    };
    const presentationFailure = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [action],
      planner: async () => ({ actionId: "restart", input: {}, presentation: "analyze" }),
      validateInput,
      presenter: async () => { throw new Error("presentation failed"); },
    });
    await expect(presentationFailure.execute(context())).rejects.toThrow("presentation failed");
    expect(failures).toEqual(["presentation failed"]);

    const downstreamFailure = createSystemTurnExecutor({
      permissions: permissions([]),
      actions: () => [action],
      planner: async () => ({ actionId: "restart", input: {}, presentation: "raw" }),
      validateInput,
    });
    const result = await downstreamFailure.execute(context());
    await result.afterFailure?.(new Error("reply failed"));
    await result.afterFailure?.(new Error("published twice"));
    expect(failures).toEqual(["presentation failed", "reply failed"]);
  });

  it("validates and canonicalizes system action input before permission or execution", async () => {
    const authorized: string[] = [];
    const executed: unknown[] = [];
    const action: SystemActionContribution = {
      id: "demo.validated",
      label: "Validated demo",
      description: "Require one bounded integer.",
      parameters: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1, maximum: 10 } },
        required: ["count"],
        additionalProperties: false,
      },
      permission(input) {
        authorized.push(`permission:${String(input.count)}`);
        return { id: "demo.validated", effect: "system-write", resource: `count:${String(input.count)}`, network: false };
      },
      execute(input) {
        executed.push(input);
        return { count: input.count };
      },
    };

    const invalid = createSystemTurnExecutor({
      permissions: permissions(authorized),
      actions: () => [action],
      planner: async () => ({ actionId: "demo.validated", input: { count: 2, injected: true } }),
      validateInput,
    });
    await expect(invalid.execute(context())).rejects.toThrow(/Validation failed for tool "demo\.validated"/);
    expect(authorized).toEqual([]);
    expect(executed).toEqual([]);

    const canonical = createSystemTurnExecutor({
      permissions: permissions(authorized),
      actions: () => [action],
      planner: async () => ({ actionId: "demo.validated", input: { count: "3" } }),
      validateInput,
    });
    await expect(canonical.execute(context())).resolves.toMatchObject({ metadata: { actionId: "demo.validated" } });
    expect(authorized).toEqual(["permission:3", "demo.validated:count:3"]);
    expect(executed).toEqual([{ count: 3 }]);
    expect(Object.isFrozen(executed[0])).toBe(true);
  });
});
