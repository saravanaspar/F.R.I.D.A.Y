import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemJsonObject,
} from "../system/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../vault/trusted-contract.js";
import { WEBHOOKS_CAPABILITY } from "./contract.js";
import { WEBHOOKS_TRUSTED_CAPABILITY } from "./trusted-contract.js";
import { createWebhooksService } from "./webhooks.js";
import {
  isLifecycleRestartEnvironment,
  LIFECYCLE_HANDOFF_CONTRIBUTION,
} from "../lifecycle/contract.js";

function systemString(input: Readonly<SystemJsonObject>, name: string, maximum = 512): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemPort(input: Readonly<SystemJsonObject>): number | undefined {
  const value = input.port;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  return value as number;
}

export interface WebhooksPluginOptions {
  readonly autoStart?: boolean | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function envPort(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535`);
  }
  return port;
}

export function createWebhooksPlugin(options: WebhooksPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "webhooks",
    requires: [EVENTS_CAPABILITY, VAULT_TRUSTED_CAPABILITY],
    provides: [WEBHOOKS_CAPABILITY, WEBHOOKS_TRUSTED_CAPABILITY],
  }, async (ctx) => {
    const events = ctx.services.require(EVENTS_CAPABILITY);
    const vault = ctx.services.require(VAULT_TRUSTED_CAPABILITY);
    const services = createWebhooksService({
      events,
      consumeSecret: (ref, consumer) => vault.consume(ref, consumer),
    });
    ctx.services.provide(WEBHOOKS_CAPABILITY, services.public);
    ctx.services.provide(WEBHOOKS_TRUSTED_CAPABILITY, services.trusted);
    ctx.effect(() => services.trusted.close());

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "webhooks",
      label: "Webhooks",
      snapshot: () => services.public.status(),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "webhooks.routes",
      label: "Webhook routes",
      description: "List configured non-secret webhook route metadata.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      execute: () => services.public.routes(),
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "webhooks.start",
      label: "Start webhook listener",
      description: "Start the configured webhook HTTP listener. Binding network interfaces is permission-gated.",
      parameters: Object.freeze({
        type: "object",
        properties: { host: { type: "string" }, port: { type: "integer", minimum: 0, maximum: 65535 } },
        additionalProperties: false,
      }),
      permission() {
        return { id: "webhooks.start", effect: "system-write", resource: "webhooks-listener", network: true };
      },
      execute(input) {
        const host = systemString(input, "host", 256);
        const port = systemPort(input);
        return services.trusted.start({
          ...(host === undefined ? {} : { host }),
          ...(port === undefined ? {} : { port }),
        });
      },
    });
    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "webhooks.stop",
      label: "Stop webhook listener",
      description: "Stop the running webhook HTTP listener without removing route configuration.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "webhooks.stop", effect: "system-write", resource: "webhooks-listener", network: false };
      },
      async execute() {
        await services.trusted.stop();
        return services.public.status();
      },
    });

    if (options.autoStart === true) {
      const start = () => services.trusted.start({
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
      });
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "webhooks.listener",
        activate: async () => { await start(); },
        quiesce: () => services.trusted.stop(),
      });
    }
    if (options.autoStart === true && !isLifecycleRestartEnvironment()) {
      ctx.afterReady(async () => {
        await services.trusted.start({
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.port === undefined ? {} : { port: options.port }),
        });
      });
    }
  });
}

export default createWebhooksPlugin({
  autoStart: envFlag("FRIDAY_WEBHOOKS_ENABLED"),
  ...(process.env.FRIDAY_WEBHOOKS_HOST?.trim() ? { host: process.env.FRIDAY_WEBHOOKS_HOST.trim() } : {}),
  ...(envPort("FRIDAY_WEBHOOKS_PORT") === undefined ? {} : { port: envPort("FRIDAY_WEBHOOKS_PORT")! }),
});
export * from "./contract.js";
export * from "./trusted-contract.js";
export { createWebhooksService, type WebhooksServiceOptions } from "./webhooks.js";
export { WEBHOOKS_DATABASE_FILE_NAME, getWebhooksDatabasePath, getWebhooksStateDir } from "./store.js";
