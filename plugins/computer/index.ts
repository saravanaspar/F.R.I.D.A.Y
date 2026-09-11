import { reportOperationalError } from "@friday/operational-errors";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin, type PluginContext } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { PERMISSIONS_CAPABILITY, type PermissionsService } from "../permissions/contract.js";
import {
  AGENT_PROMPT_SECTION_CONTRIBUTION,
  AGENT_TOOL_CONTRIBUTION,
  type AgentExtensionJsonValue,
  type AgentToolExecutionContext,
} from "../turn-loop/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemActionExecutionContext,
  type SystemJsonObject,
} from "../system/contract.js";
import {
  COMPUTER_CAPABILITY,
  type ComputerAgentControlResume,
  type ComputerBrowserAction,
  type ComputerExecutionBinding,
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

function agentText(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string, maximum = 16_384): string {
  const value = input[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function activeComputerBinding(context?: AgentToolExecutionContext): ComputerExecutionBinding {
  const binding = context?.computerExecution;
  if (!context || !binding) throw new Error("Computer tool requires an active leased Computer screen");
  return binding;
}

function currentComputerBinding(service: ComputerService, context?: AgentToolExecutionContext): ComputerExecutionBinding {
  const binding = activeComputerBinding(context);
  const control = service.controlLease(binding.screenLeaseId);
  if (!control) throw new Error("Computer tool requires an active leased Computer screen");
  if (control.nodeId !== binding.nodeId || control.screenId !== binding.screenId || control.agentOwnerId !== binding.ownerId) {
    throw new Error("Computer control lease does not match the active Agent binding");
  }
  if (control.holder === "agent" && control.holderId === binding.ownerId && control.generation >= binding.generation) {
    if (control.generation === binding.generation) return binding;
    return Object.freeze({ ...binding, generation: control.generation });
  }
  return binding;
}

async function resumeAgentComputerAfterTakeover(
  service: ComputerService,
  binding: ComputerExecutionBinding,
  error: unknown,
  signal?: AbortSignal,
): Promise<ComputerAgentControlResume> {
  const control = service.controlLease(binding.screenLeaseId);
  if (!control
    || control.nodeId !== binding.nodeId
    || control.screenId !== binding.screenId
    || control.agentOwnerId !== binding.ownerId
    || control.generation <= binding.generation) {
    throw error;
  }
  const resume = await service.waitForAgentControl(binding.screenLeaseId, binding.ownerId, binding.generation, signal);
  if (!resume.resumedAfterTakeover) throw error;
  return resume;
}

function resumedAfterHumanTakeover(resume: Extract<ComputerAgentControlResume, { resumedAfterTakeover: true }>): AgentExtensionJsonValue {
  return {
    resumedAfterHumanTakeover: true,
    staleActionReplayed: false,
    controlGeneration: resume.controlLease.generation,
    observation: resume.observation as unknown as AgentExtensionJsonValue,
  };
}

function browserAction(input: Readonly<Record<string, AgentExtensionJsonValue>>): ComputerBrowserAction {
  const kind = input.action;
  if (kind === "navigate") return { kind, url: agentText(input, "url", 4_096) };
  if (kind === "click") return { kind, target: agentText(input, "target", 4_096) };
  if (kind === "press") return { kind, key: agentText(input, "key", 128) };
  if (kind === "type") {
    if (input.sensitive === true) throw new Error("sensitive browser input requires human takeover or a dedicated protected-credential flow");
    if (input.sensitive !== undefined && input.sensitive !== false) throw new Error("sensitive must be a boolean");
    return { kind, target: agentText(input, "target", 4_096), text: agentText(input, "text", 16_384), sensitive: false };
  }
  throw new Error("action must be navigate, click, type, or press");
}

async function waitForAgentBrowserAdmission(
  service: ComputerService,
  context: AgentToolExecutionContext,
  binding: ComputerExecutionBinding,
  signal?: AbortSignal,
): Promise<ComputerExecutionBinding> {
  let waited = false;
  const grant = await service.waitForScreen({
    ownerId: binding.ownerId,
    preferredNodeId: binding.nodeId,
    preferredScreenId: binding.screenId,
    requireBrowser: true,
    ...(binding.admission?.demand === undefined ? {} : { demand: binding.admission.demand }),
  }, signal, async (waiting) => {
    waited = true;
    await context.reportProgress?.({
      kind: "status",
      message: `Waiting for Computer ${binding.nodeId} browser: ${waiting.reasons.join(", ")}`,
      jobStatus: "waiting-for-computer",
      computerWait: { code: waiting.code, nodeId: binding.nodeId, reasons: waiting.reasons },
    });
  });
  if (waited) {
    await context.reportProgress?.({
      kind: "status",
      message: `Computer ${binding.nodeId} browser is ready; resuming work`,
      jobStatus: "running",
      notify: false,
    });
  }
  return grant.controlLease.generation === binding.generation
    ? binding
    : Object.freeze({ ...binding, generation: grant.controlLease.generation });
}

async function authorizeAgentComputer(
  permissions: PermissionsService,
  context: AgentToolExecutionContext,
  binding: ComputerExecutionBinding,
  kind: "observe" | "browser",
): Promise<void> {
  await permissions.authorize({
    mode: context.permissionMode ?? permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
    workspace: context.cwd,
    access: kind === "observe" ? "read" : "write",
    action: {
      id: kind === "observe" ? "computer.observe" : "computer.browser.action",
      effect: kind === "observe" ? "private-read" : "external-write",
      resource: `computer:${binding.nodeId}:screen:${binding.screenId}`,
      network: true,
    },
    reason: kind === "observe"
      ? `observe leased Computer screen ${binding.nodeId}:${binding.screenId}`
      : `control browser on leased Computer screen ${binding.nodeId}:${binding.screenId}`,
    ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
  });
}

function registerAgentComputerTools(ctx: PluginContext, service: ComputerService, permissions: PermissionsService): void {
  ctx.contribute(AGENT_PROMPT_SECTION_CONTRIBUTION, {
    id: "computer-active-screen",
    render(context) {
      const binding = context.computerExecution;
      if (!binding) return undefined;
      return [
        "<friday_computer_context>",
        `Computer node: ${binding.nodeId}`,
        `Leased screen: ${binding.screenId}`,
        `Initial control generation: ${binding.generation}`,
        "Use computer_observe before visual/browser decisions and after any human takeover. Use computer_browser only for non-secret input. Passwords, OTPs, CAPTCHAs, and other sensitive input require human takeover; never place those values in tool arguments.",
        "If a Computer tool reports resumedAfterHumanTakeover=true, the interrupted action was not replayed. Treat the attached fresh observation as the new source of truth and replan before acting again.",
        "</friday_computer_context>",
      ].join("\n");
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "computer-observe",
    sourcePluginId: "computer",
    name: "computer_observe",
    label: "Observe Computer screen",
    description: "Re-observe the active leased Computer screen and browser state using the current control generation. Returns only provider-redacted bounded metadata and screenshot artifact references, never raw secret input.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    async execute(_input, signal, executionContext) {
      const context = executionContext;
      const binding = currentComputerBinding(service, context);
      await authorizeAgentComputer(permissions, context!, binding, "observe");
      try {
        return {
          output: await service.observeScreen(binding.screenLeaseId, binding.ownerId, binding.generation, signal) as unknown as AgentExtensionJsonValue,
        };
      } catch (error) {
        const resume = await resumeAgentComputerAfterTakeover(service, binding, error, signal);
        if (!resume.resumedAfterTakeover) throw error;
        return { output: resumedAfterHumanTakeover(resume) };
      }
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "computer-browser",
    sourcePluginId: "computer",
    name: "computer_browser",
    label: "Control Computer browser",
    description: "Navigate, click, type non-secret text, or press a key on the active leased Computer browser. The provider uses Playwright DOM, accessibility, CDP, then visual control and returns a fresh observation. Sensitive input must use human takeover.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "press"] },
        url: { type: "string" },
        target: { type: "string" },
        text: { type: "string" },
        key: { type: "string" },
        sensitive: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      const context = executionContext;
      const initialBinding = currentComputerBinding(service, context);
      const action = browserAction(input);
      await authorizeAgentComputer(permissions, context!, initialBinding, "browser");
      const binding = await waitForAgentBrowserAdmission(service, context!, initialBinding, signal);
      if (binding.generation !== initialBinding.generation) {
        const resume = await service.waitForAgentControl(
          initialBinding.screenLeaseId,
          initialBinding.ownerId,
          initialBinding.generation,
          signal,
        );
        if (resume.resumedAfterTakeover) return { output: resumedAfterHumanTakeover(resume) };
      }
      try {
        const result = await service.runBrowserAction(binding.screenLeaseId, binding.ownerId, binding.generation, action, signal);
        return { output: result as unknown as AgentExtensionJsonValue };
      } catch (error) {
        const resume = await resumeAgentComputerAfterTakeover(service, initialBinding, error, signal);
        if (!resume.resumedAfterTakeover) throw error;
        return { output: resumedAfterHumanTakeover(resume) };
      }
    },
  });
}

export function createComputerPlugin(options: ComputerPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "computer",
    requires: [EVENTS_CAPABILITY],
    optional: [PERMISSIONS_CAPABILITY],
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

    const permissions = ctx.services.optional(PERMISSIONS_CAPABILITY);
    if (permissions) registerAgentComputerTools(ctx, service, permissions);

    for (const adapter of options.adapters ?? []) await service.registerNode(adapter);

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "computer",
      label: "Shared Agent Computer",
      async snapshot() {
        await service.refreshAll().catch((error: unknown) => {
          reportOperationalError({ component: "computer", operation: "refresh nodes for Computer status", error, severity: "warn" });
          return Object.freeze([]);
        });
        return service.status();
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "computer.status",
      label: "Computer status",
      description: "List Computer Nodes, safe resource summaries, browser readiness, and active screen/control leases without exposing browser content or secret input.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission: () => ({ id: "computer.status", effect: "private-read", resource: "computer", network: true }),
      async execute() {
        await service.refreshAll().catch((error: unknown) => {
          reportOperationalError({ component: "computer", operation: "refresh nodes for Computer status", error, severity: "warn" });
          return Object.freeze([]);
        });
        return { ...service.status(), leases: service.leaseStatus() };
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
