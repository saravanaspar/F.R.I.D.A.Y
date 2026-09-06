import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { PERMISSIONS_CAPABILITY, permissionEffectAccess } from "../permissions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION, type AgentModelRequestContext } from "../turn-loop/contract.js";
import { SPENDING_POLICY_CAPABILITY, type SpendingPolicyService } from "./contract.js";
import { SpendingPolicyStore } from "./store.js";

function stateRoot(): string {
  const configured = process.env.FRIDAY_HOME?.trim() || process.env.FRIDAY_STATE_DIR?.trim();
  return configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
}

export function spendingProjectKey(cwd: string): string {
  const path = resolve(cwd);
  const label = basename(path).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `${label}-${createHash("sha256").update(path).digest("hex").slice(0, 10)}`;
}

function utcDay(at = new Date()): { key: string; since: string } {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  return { key: start.toISOString().slice(0, 10), since: start.toISOString() };
}

function scopeValue(input: Readonly<SystemJsonObject>): "daily" | "project" {
  if (input.scope === "daily" || input.scope === "project") return input.scope;
  throw new Error("scope must be daily or project");
}

function requestedProjectKey(input: Readonly<SystemJsonObject>): string {
  const value = input.project;
  if (value === undefined) return spendingProjectKey(process.cwd());
  if (typeof value !== "string" || !value.trim()) throw new Error("project must be a non-empty path or project key");
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9-]{1,100}$/i.test(normalized) ? normalized : spendingProjectKey(normalized);
}

const spendingPlugin: FridayPlugin = definePlugin({
  id: "spending",
  requires: [OBSERVABILITY_CAPABILITY, PERMISSIONS_CAPABILITY],
  provides: [SPENDING_POLICY_CAPABILITY],
}, (ctx) => {
  const observability = ctx.services.require(OBSERVABILITY_CAPABILITY);
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const store = new SpendingPolicyStore(join(stateRoot(), "spending"));
  const service: SpendingPolicyService = Object.freeze({
    limits: () => store.limits(),
    setLimit: (scope: "daily" | "project", amount: number, key?: string) => store.setLimit(scope, amount, key),
    clearLimit: (scope: "daily" | "project", key?: string) => store.clearLimit(scope, key),
    approvals: () => store.approvals(),
  });
  ctx.services.provide(SPENDING_POLICY_CAPABILITY, service);

  const usage = (since: string, rootSessionId?: string) => {
    if (!observability.usageSummary) throw new Error("Persistent spending limits require an observability provider with usage accounting");
    return observability.usageSummary({ since, ...(rootSessionId === undefined ? {} : { rootSessionId }) }).totals;
  };

  ctx.contribute(AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION, {
    id: "spending.enforcement",
    async beforeRequest(context: AgentModelRequestContext, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const limits = store.limits();
      const day = utcDay();
      const key = spendingProjectKey(context.cwd);
      store.registerSessionProject(context.rootSessionId, key);
      const daily = usage(day.since);
      const projectSpent = store.projectSessions(key).reduce((sum, rootSessionId) => sum + usage(day.since, rootSessionId).billableCost, 0);
      const checks = [
        ...(limits.dailyLimit === undefined ? [] : [{ scope: "daily" as const, key: day.key, spent: daily.billableCost, limit: limits.dailyLimit }]),
        ...(limits.projectLimits[key] === undefined ? [] : [{ scope: "project" as const, key, spent: projectSpent, limit: limits.projectLimits[key]! }]),
      ];
      const warnings = checks.filter((check) => check.spent < check.limit && check.spent >= check.limit * limits.warningRatio);
      for (const warning of warnings) {
        const warningKey = `${day.key}:${warning.scope}:${warning.key}`;
        if (!store.shouldWarn(warningKey)) continue;
        await context.turn?.reply([
          `Spending warning${context.jobId ? ` · Job ${context.jobId}` : ""}`,
          `${warning.scope === "daily" ? "Daily" : `Project ${warning.key}`} usage is $${warning.spent.toFixed(4)} of the $${warning.limit.toFixed(4)} USD limit (${Math.round((warning.spent / warning.limit) * 100)}%).`,
        ].join("\n"));
        store.markWarned(warningKey);
      }
      const exceeded = checks.filter((check) => check.spent >= check.limit);
      if (exceeded.length === 0) return;
      const resource = exceeded.map((check) => `${check.scope}:${check.key}`).join(",");
      const reason = exceeded.map((check) => `${check.scope} spending $${check.spent.toFixed(4)} reached $${check.limit.toFixed(4)} USD`).join("; ");
      const action = { id: "spending.continue", effect: "system-write" as const, resource: `spending:${resource}`, network: false };
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
        workspace: context.cwd,
        access: permissionEffectAccess(action.effect),
        action,
        reason: `${reason}. Approve exactly one additional model request for ${context.agentName}.`,
        ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
      });
      for (const check of exceeded) store.recordApproval({
        at: new Date().toISOString(),
        scope: check.scope,
        key: check.key,
        spent: check.spent,
        limit: check.limit,
        rootSessionId: context.rootSessionId,
        ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
      });
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "spending.limits",
    label: "Spending limits",
    description: "Show persistent daily and per-project model spending limits and recent continuation approvals.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() { return { id: "spending.limits", effect: "global-operational-read", resource: "spending:limits", network: false }; },
    execute() { return { limits: store.limits(), recentApprovals: store.approvals().slice(-25) }; },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "spending.limit.set",
    label: "Set spending limit",
    description: "Persist a USD daily limit or a limit for the current/specified project.",
    parameters: Object.freeze({
      type: "object",
      properties: { scope: { type: "string", enum: ["daily", "project"] }, amount: { type: "number", exclusiveMinimum: 0 }, project: { type: "string" } },
      required: ["scope", "amount"],
      additionalProperties: false,
    }),
    permission(input) { return { id: "spending.limit.set", effect: "system-write", resource: `spending:${scopeValue(input)}`, network: false }; },
    execute(input) {
      if (typeof input.amount !== "number") throw new Error("amount must be a number");
      const scope = scopeValue(input);
      return store.setLimit(scope, input.amount, scope === "project" ? requestedProjectKey(input) : undefined);
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "spending.limit.clear",
    label: "Clear spending limit",
    description: "Remove a persistent daily or per-project spending limit.",
    parameters: Object.freeze({ type: "object", properties: { scope: { type: "string", enum: ["daily", "project"] }, project: { type: "string" } }, required: ["scope"], additionalProperties: false }),
    permission(input) { return { id: "spending.limit.clear", effect: "system-write", resource: `spending:${scopeValue(input)}`, network: false }; },
    execute(input) {
      const scope = scopeValue(input);
      return store.clearLimit(scope, scope === "project" ? requestedProjectKey(input) : undefined);
    },
  });
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "spending",
    label: "Spending policy",
    snapshot() {
      const day = utcDay();
      return { limits: store.limits(), today: usage(day.since), recentContinuationApprovals: store.approvals().slice(-10) };
    },
  });
});

export default spendingPlugin;
export * from "./contract.js";
