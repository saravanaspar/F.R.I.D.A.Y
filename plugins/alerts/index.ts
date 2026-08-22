import { randomUUID } from "node:crypto";
import { reportOperationalError } from "@friday/operational-errors";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { EVENTS_CAPABILITY, type EventRecord } from "../events/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../permissions/trusted-contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { ALERTS_CAPABILITY, type AlertRule, type AlertsService } from "./contract.js";

interface AlertState { readonly schema: 1; readonly rules: readonly AlertRule[]; }
const MAX_RULES = 128;
const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

function rootDir(): string {
  const configured = process.env.FRIDAY_HOME?.trim() || process.env.FRIDAY_STATE_DIR?.trim();
  const root = configured ? (isAbsolute(configured) ? configured : resolve(configured)) : join(homedir(), ".friday");
  return join(root, "alerts");
}
function statePath(): string { return join(rootDir(), "alerts.json"); }
async function assertPrivateRoot(root: string, create: boolean): Promise<void> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Alert state directory must be a private directory: ${root}`);
    if ((info.mode & 0o077) !== 0) throw new Error(`Alert state directory permissions are too broad: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
      throw new Error(`Alert state directory could not be made private: ${root}`);
    }
  }
}
function bounded(value: unknown, label: string, maximum = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maximum || /[\r\n\0]/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}
function parseRule(value: unknown): AlertRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("alert rule is malformed");
  const raw = value as Record<string, unknown>;
  const id = bounded(raw.id, "alert id", 128);
  const target = raw.target;
  if (!id || !target || typeof target !== "object" || Array.isArray(target)) throw new Error("alert rule is malformed");
  const t = target as Record<string, unknown>;
  const channel = bounded(t.channel, "alert channel", 64);
  const accountId = bounded(t.accountId, "alert account", 128);
  const conversationId = bounded(t.conversationId, "alert conversation", 256);
  if (!channel || !accountId || !conversationId) throw new Error("alert target is malformed");
  const cooldownSeconds = Number(raw.cooldownSeconds);
  if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) throw new Error("alert cooldown is invalid");
  const createdAt = bounded(raw.createdAt, "alert createdAt", 64);
  if (!createdAt) throw new Error("alert createdAt is invalid");
  return Object.freeze({
    id,
    ...(bounded(raw.type, "alert type") === undefined ? {} : { type: bounded(raw.type, "alert type") }),
    ...(bounded(raw.source, "alert source") === undefined ? {} : { source: bounded(raw.source, "alert source") }),
    ...(bounded(raw.subject, "alert subject") === undefined ? {} : { subject: bounded(raw.subject, "alert subject") }),
    cooldownSeconds,
    target: Object.freeze({ channel, accountId, conversationId, ...(bounded(t.threadId, "alert thread", 256) === undefined ? {} : { threadId: bounded(t.threadId, "alert thread", 256) }) }),
    createdAt,
  });
}
async function readState(): Promise<AlertState> {
  const root = rootDir();
  await assertPrivateRoot(root, false);
  const path = statePath();
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("alert state is not a regular file");
    if ((info.mode & 0o077) !== 0) throw new Error("alert state permissions are too broad");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.rules)) throw new Error("alert state schema is unsupported");
    const rules = parsed.rules.map(parseRule);
    if (rules.length > MAX_RULES) throw new Error("alert state exceeds rule limit");
    return Object.freeze({ schema: 1, rules: Object.freeze(rules) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ schema: 1, rules: Object.freeze([]) });
    throw error;
  }
}
async function saveState(rules: readonly AlertRule[]): Promise<void> {
  const dir = rootDir();
  const path = statePath();
  await assertPrivateRoot(dir, true);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ schema: 1, rules } satisfies AlertState, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        reportOperationalError({ component: "alerts", operation: "remove temporary rules file", error });
      }
    });
  }
}
function matches(rule: AlertRule, event: EventRecord): boolean {
  return (!rule.type || rule.type === event.type) && (!rule.source || rule.source === event.source) && (!rule.subject || rule.subject === event.subject);
}
function eventMessage(event: EventRecord): string {
  return [
    "FRIDAY alert",
    `Type: ${event.type}`,
    `Source: ${event.source}`,
    ...(event.subject ? [`Subject: ${event.subject}`] : []),
    `Occurred: ${event.occurredAt}`,
    `Event: ${event.id}`,
  ].join("\n");
}

const alertsPlugin: FridayPlugin = definePlugin({
  id: "alerts",
  requires: [CHANNELS_TRUSTED_CAPABILITY, EVENTS_CAPABILITY, PERMISSIONS_CAPABILITY, PERMISSIONS_TRUSTED_CAPABILITY],
  provides: [ALERTS_CAPABILITY],
}, async (ctx) => {
  const channels = ctx.services.require(CHANNELS_TRUSTED_CAPABILITY);
  const events = ctx.services.require(EVENTS_CAPABILITY);
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const trustedPermissions = ctx.services.require(PERMISSIONS_TRUSTED_CAPABILITY);
  let rules = [...(await readState()).rules];
  const lastSent = new Map<string, number>();
  let mutationTail: Promise<void> = Promise.resolve();
  function serializeMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  const service: AlertsService = Object.freeze({
    rules: () => Object.freeze(rules.map((rule) => Object.freeze({ ...rule, target: Object.freeze({ ...rule.target }) }))),
    remove: (id: string) => serializeMutation(async () => {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index < 0) return false;
      const next = rules.filter((rule) => rule.id !== id);
      await saveState(next);
      rules = next;
      lastSent.delete(id);
      return true;
    }),
  });
  ctx.services.provide(ALERTS_CAPABILITY, service);

  ctx.effect(events.registerConsumer({
    id: "alerts.delivery",
    startAt: "latest",
    retry: { maxAttempts: 5, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 60_000 },
  }, async ({ event, signal }) => {
    signal?.throwIfAborted();
    for (const rule of rules) {
      if (!matches(rule, event)) continue;
      const now = Date.now();
      const previous = lastSent.get(rule.id) ?? 0;
      if (now - previous < rule.cooldownSeconds * 1_000) continue;
      await trustedPermissions.runAsSystem("alerts", async () => {
        await permissions.authorize({
          mode: "full",
          workspace: process.cwd(),
          access: "write",
          action: { id: "alerts.deliver", effect: "external-write", resource: `channel:${rule.target.channel}:${rule.target.accountId}:${rule.target.conversationId}`, network: rule.target.channel !== "cli" },
          reason: `deliver pre-authorized alert rule ${rule.id}`,
        });
        await channels.send(rule.target, eventMessage(event));
      });
      lastSent.set(rule.id, now);
    }
  }));

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "alerts", label: "Alerts", snapshot: () => ({ rules: rules.length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "alerts.list",
    label: "Alert subscriptions",
    description: "List channel-bound event alert subscriptions.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    execute: () => service.rules(),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "alerts.subscribe",
    label: "Subscribe to alert",
    description: "Create an event alert bound to the exact originating channel conversation. At least one of type, source, or subject is required.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        type: { type: "string" }, source: { type: "string" }, subject: { type: "string" },
        cooldownSeconds: { type: "integer", minimum: 0, maximum: MAX_COOLDOWN_SECONDS },
      },
      additionalProperties: false,
    }),
    async execute(input, context) {
      if (context.turn.principal.authority !== "channel") throw new Error("Alert subscriptions must originate from the channel that will receive them");
      const type = bounded(input.type, "event type");
      const source = bounded(input.source, "event source");
      const subject = bounded(input.subject, "event subject");
      if (!type && !source && !subject) throw new Error("alerts.subscribe requires at least one of type, source, or subject");
      const cooldownSeconds = input.cooldownSeconds === undefined ? DEFAULT_COOLDOWN_SECONDS : Number(input.cooldownSeconds);
      if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > MAX_COOLDOWN_SECONDS) throw new Error("cooldownSeconds is invalid");
      const target = Object.freeze({
        channel: context.turn.principal.channel,
        accountId: context.turn.principal.accountId,
        conversationId: context.turn.principal.conversationId,
        ...(context.turn.principal.threadId === undefined ? {} : { threadId: context.turn.principal.threadId }),
      });
      await context.turn.reply(["Alert subscription plan", `Type: ${type ?? "*"}`, `Source: ${source ?? "*"}`, `Subject: ${subject ?? "*"}`, `Cooldown: ${cooldownSeconds}s`, "Destination: this conversation"].join("\n"));
      await permissions.authorize({
        mode: permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE), workspace: process.cwd(), access: "write",
        action: { id: "alerts.subscribe", effect: "external-write", resource: `channel:${target.channel}:${target.accountId}:${target.conversationId}`, network: target.channel !== "cli" },
        reason: "create channel-bound event alert subscription",
      });
      return serializeMutation(async () => {
        if (rules.length >= MAX_RULES) throw new Error(`At most ${MAX_RULES} alert rules are supported`);
        const rule: AlertRule = Object.freeze({ id: randomUUID(), ...(type ? { type } : {}), ...(source ? { source } : {}), ...(subject ? { subject } : {}), cooldownSeconds, target, createdAt: new Date().toISOString() });
        const next = [...rules, rule];
        await saveState(next);
        rules = next;
        return rule;
      });
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "alerts.remove", label: "Remove alert", description: "Remove one event alert subscription by id.",
    parameters: Object.freeze({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }),
    permission(input) {
      const id = bounded(input.id, "alert id", 128) ?? "";
      return { id: "alerts.remove", effect: "system-write", resource: `alert:${id}`, network: false };
    },
    execute: async (input) => ({ removed: await service.remove(bounded(input.id, "alert id", 128) ?? "") }),
  });
});

export default alertsPlugin;
