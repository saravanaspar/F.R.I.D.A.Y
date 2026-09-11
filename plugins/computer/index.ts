import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemActionExecutionContext,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  COMPUTER_CAPABILITY,
  type ComputerNodeAdapter,
  type ComputerService,
} from "./contract.js";
import { createComputerService, type ComputerServiceOptions } from "./service.js";

export interface ComputerPluginOptions {
  /** Provider adapters injected by the embedding host. Linux/Windows providers arrive in later phases. */
  readonly adapters?: readonly ComputerNodeAdapter[] | undefined;
  readonly service?: Omit<ComputerServiceOptions, "publishEvent"> | undefined;
}

function requiredText(input: Readonly<SystemJsonObject>, name: string, maximum = 256): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function optionalHandBack(input: Readonly<SystemJsonObject>): number | null | undefined {
  const value = input.handBackAfterMs;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 5_000) throw new Error("handBackAfterMs must be at least 5000 or null for manual-only");
  return value as number;
}

function principalOwner(context: SystemActionExecutionContext): string {
  const principal = context.turn.principal;
  return [principal.authority, principal.channel, principal.accountId, principal.senderId]
    .map((value) => value.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 96))
    .join(":")
    .slice(0, 160);
}

function statusSnapshot(service: ComputerService) {
  const leases = service.screenLeases();
  const nodes = service.nodes();
  return {
    nodes: nodes.length,
    online: nodes.filter((node) => node.availability === "online").length,
    degraded: nodes.filter((node) => node.availability === "degraded").length,
    offline: nodes.filter((node) => node.availability === "offline").length,
    activeScreenLeases: leases.length,
    humanTakeovers: leases.filter((lease) => service.controlLease(lease.id)?.holder === "human").length,
    nodeStatus: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      platform: node.platform,
      availability: node.availability,
      agentScreens: node.screens.filter((screen) => screen.kind === "agent").length,
      leasedScreens: leases.filter((lease) => lease.nodeId === node.id).length,
      browser: node.browser === undefined ? { available: node.capabilities.browser, running: false } : {
        available: node.capabilities.browser,
        running: node.browser.running,
        persistentProfile: node.browser.persistentProfile,
        windows: node.browser.windows.length,
        tabs: node.browser.tabs.length,
      },
      resources: node.resources,
    })),
  };
}

function activeLeaseSnapshot(service: ComputerService) {
  return service.screenLeases().map((lease) => {
    const control = service.controlLease(lease.id);
    return {
      screenLeaseId: lease.id,
      nodeId: lease.nodeId,
      screenId: lease.screenId,
      ownerId: lease.ownerId,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      ...(control === undefined ? {} : {
        control: {
          holder: control.holder,
          generation: control.generation,
          acquiredAt: control.acquiredAt,
          lastActivityAt: control.lastActivityAt,
          handBackAfterMs: control.handBackAfterMs,
          transcriptPolicy: control.transcriptPolicy,
        },
      }),
    };
  });
}

export function createComputerPlugin(options: ComputerPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "computer",
    requires: [EVENTS_CAPABILITY],
    provides: [COMPUTER_CAPABILITY],
  }, async (ctx) => {
    const events = ctx.services.require(EVENTS_CAPABILITY);
    const service = createComputerService({
      ...options.service,
      publishEvent(type, subject, data) {
        events.publish({ type, source: "computer", subject, ...(data === undefined ? {} : { data }) });
      },
    });
    ctx.services.provide(COMPUTER_CAPABILITY, service);
    ctx.effect(() => service.close());

    for (const adapter of options.adapters ?? []) await service.registerNode(adapter);

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "computer",
      label: "Shared Agent Computer",
      async snapshot() {
        await service.refreshAll().catch(() => Object.freeze([]));
        return statusSnapshot(service);
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.status",
      label: "Computer status",
      description: "List Computer Nodes, safe resource summaries, browser readiness, and active screen/control leases without exposing browser content or secret input.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission: () => ({ id: "computer.status", effect: "private-read", resource: "computer", network: true }),
      async execute() {
        await service.refreshAll().catch(() => Object.freeze([]));
        return { ...statusSnapshot(service), leases: activeLeaseSnapshot(service) };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.doctor",
      label: "Computer doctor",
      description: "Run provider-neutral Computer Node health and admission checks without attempting hidden repair.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission: () => ({ id: "computer.doctor", effect: "global-operational-read", resource: "computer:doctor", network: true }),
      execute: () => service.doctor(),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.takeover",
      label: "Take over Computer screen",
      description: "Pause Agent control of an already-leased screen for human takeover. Human keystrokes, secrets, and sensitive screenshots are excluded from the model-visible transcript.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          screenLeaseId: { type: "string" },
          handBackAfterMs: { anyOf: [{ type: "integer", minimum: 5_000 }, { type: "null" }] },
        },
        required: ["screenLeaseId"],
        additionalProperties: false,
      }),
      permission: (input) => ({
        id: "computer.takeover",
        effect: "system-write",
        resource: `computer:control:${requiredText(input, "screenLeaseId", 128)}`,
        network: true,
      }),
      execute: (input, context) => service.takeOver(
        requiredText(input, "screenLeaseId", 128),
        principalOwner(context),
        optionalHandBack(input),
      ),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.human-activity",
      label: "Record Computer takeover activity",
      description: "Refresh the idle hand-back grace period for the current human takeover without recording keys, text, screenshots, passwords, OTPs, or CAPTCHA contents.",
      parameters: Object.freeze({
        type: "object",
        properties: { screenLeaseId: { type: "string" } },
        required: ["screenLeaseId"],
        additionalProperties: false,
      }),
      permission: (input) => ({
        id: "computer.human-activity",
        effect: "system-write",
        resource: `computer:control:${requiredText(input, "screenLeaseId", 128)}`,
        network: true,
      }),
      execute: (input, context) => service.recordHumanActivity(requiredText(input, "screenLeaseId", 128), principalOwner(context)),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.hand-back",
      label: "Return Computer screen to Agent",
      description: "End human takeover only after invalidating stale GUI actions and re-observing the current screen/browser/process state.",
      parameters: Object.freeze({
        type: "object",
        properties: { screenLeaseId: { type: "string" } },
        required: ["screenLeaseId"],
        additionalProperties: false,
      }),
      permission: (input) => ({
        id: "computer.hand-back",
        effect: "system-write",
        resource: `computer:control:${requiredText(input, "screenLeaseId", 128)}`,
        network: true,
      }),
      execute: (input, context) => service.handBack(requiredText(input, "screenLeaseId", 128), principalOwner(context), context.signal),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.node.refresh",
      label: "Refresh Computer Node",
      description: "Refresh one Computer Node's provider-reported health, screens, browser supervisor state, and resource telemetry.",
      parameters: Object.freeze({
        type: "object",
        properties: { nodeId: { type: "string" } },
        required: ["nodeId"],
        additionalProperties: false,
      }),
      permission: (input) => ({ id: "computer.node.refresh", effect: "global-operational-read", resource: `computer:${requiredText(input, "nodeId", 128)}`, network: true }),
      execute: (input, context) => service.refreshNode(requiredText(input, "nodeId", 128), context.signal),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.node.restart",
      label: "Restart Computer Node",
      description: "Request a provider-managed Computer Node restart only when it has no active screen leases.",
      parameters: Object.freeze({ type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"], additionalProperties: false }),
      permission: (input) => ({ id: "computer.node.restart", effect: "system-write", resource: `computer:${requiredText(input, "nodeId", 128)}:restart`, network: true }),
      execute: (input, context) => service.restartNode(requiredText(input, "nodeId", 128), context.signal),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.node.update",
      label: "Update Computer Node",
      description: "Request a provider-managed Computer Node software update only when it has no active screen leases.",
      parameters: Object.freeze({ type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"], additionalProperties: false }),
      permission: (input) => ({ id: "computer.node.update", effect: "system-write", resource: `computer:${requiredText(input, "nodeId", 128)}:update`, network: true }),
      execute: (input, context) => service.updateNode(requiredText(input, "nodeId", 128), context.signal),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.node.reset-managed",
      label: "Reset FRIDAY-managed Computer state",
      description: "Reset only FRIDAY-managed Agent state on a Computer Node. This action never means resetting the person's operating system.",
      parameters: Object.freeze({ type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"], additionalProperties: false }),
      permission: (input) => ({ id: "computer.node.reset-managed", effect: "system-write", resource: `computer:${requiredText(input, "nodeId", 128)}:managed-state`, network: true }),
      execute: (input, context) => service.resetManagedState(requiredText(input, "nodeId", 128), context.signal),
    });
  });
}

export default createComputerPlugin();
export * from "./contract.js";
export { createComputerService } from "./service.js";
