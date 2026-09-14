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
  type ComputerBoundingBox,
  type ComputerBrowserAction,
  type ComputerBrowserActionResult,
  type ComputerExecutionBinding,
  type ComputerNodeAdapter,
  type ComputerObservation,
  type ComputerObservationRequest,
  type ComputerService,
  type ComputerVisualProbeRequest,
} from "./contract.js";
import { createComputerService, type ComputerServiceOptions } from "./service.js";
import { configuredComputerAdapters } from "./providers/index.js";
import { TOOLS_CAPABILITY } from "../tools/contract.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { coreHostExecutionTarget } from "@friday/execution-targets";

export interface ComputerPluginOptions {
  /** Provider adapters injected by an embedding host; when omitted, the configured built-in provider is used. */
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


function agentSemanticRef(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string): string {
  const ref = agentText(input, name, 256);
  if (!/^obs-\d+:e\d+$/.test(ref)) throw new Error(`${name} must be a current semantic ref from computer_observe`);
  return ref;
}

function optionalAgentSemanticRef(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string): string | undefined {
  const ref = agentOptionalText(input, name, 256);
  if (ref !== undefined && !/^obs-\d+:e\d+$/.test(ref)) throw new Error(`${name} must be a current semantic ref from computer_observe`);
  return ref;
}

function agentOptionalText(input: Readonly<Record<string, AgentExtensionJsonValue>>, name: string, maximum = 16_384): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function agentNumber(
  input: Readonly<Record<string, AgentExtensionJsonValue>>,
  name: string,
  minimum: number,
  maximum: number,
  required = false,
): number | undefined {
  const value = input[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} must be a number`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function observationRequest(input: Readonly<Record<string, AgentExtensionJsonValue>>): ComputerObservationRequest {
  const scope = input.scope ?? "interactive";
  if (scope !== "interactive" && scope !== "all") throw new Error("scope must be interactive or all");
  const maxElements = agentNumber(input, "maxElements", 1, 256);
  if (maxElements !== undefined && !Number.isSafeInteger(maxElements)) throw new Error("maxElements must be an integer");
  const query = agentOptionalText(input, "query", 512);
  const near = optionalAgentSemanticRef(input, "near");
  return Object.freeze({
    scope,
    ...(query === undefined ? {} : { query }),
    ...(near === undefined ? {} : { near }),
    ...(maxElements === undefined ? {} : { maxElements }),
  });
}

function visualProbeRequest(
  input: Readonly<Record<string, AgentExtensionJsonValue>>,
): Omit<ComputerVisualProbeRequest, "screenId" | "controlGeneration" | "signal"> {
  const ref = optionalAgentSemanticRef(input, "ref");
  const rawBbox = input.bbox;
  let bbox: ComputerBoundingBox | undefined;
  if (rawBbox !== undefined && rawBbox !== null) {
    if (typeof rawBbox !== "object" || Array.isArray(rawBbox)) throw new Error("bbox must be an object");
    const value = rawBbox as Readonly<Record<string, AgentExtensionJsonValue>>;
    const left = agentNumber(value, "left", -1_000_000, 1_000_000, true)!;
    const top = agentNumber(value, "top", -1_000_000, 1_000_000, true)!;
    const right = agentNumber(value, "right", -1_000_000, 1_000_000, true)!;
    const bottom = agentNumber(value, "bottom", -1_000_000, 1_000_000, true)!;
    if (right < left || bottom < top) throw new Error("bbox has inverted bounds");
    bbox = Object.freeze({ left, top, right, bottom });
  }
  if ((ref === undefined) === (bbox === undefined)) throw new Error("visual probe requires exactly one of ref or bbox");
  const size = input.size ?? "small";
  if (size !== "tiny" && size !== "small" && size !== "medium" && size !== "window" && size !== "full") {
    throw new Error("size must be tiny, small, medium, window, or full");
  }
  const returnMode = input.return ?? "text";
  if (returnMode !== "text" && returnMode !== "image") throw new Error("return must be text or image");
  const maxSide = agentNumber(input, "maxSide", 64, 2_048);
  if (maxSide !== undefined && !Number.isSafeInteger(maxSide)) throw new Error("maxSide must be an integer");
  const includeContext = input.includeContext;
  if (includeContext !== undefined && typeof includeContext !== "boolean") throw new Error("includeContext must be a boolean");
  const purpose = agentOptionalText(input, "purpose", 512);
  return Object.freeze({
    ...(ref === undefined ? {} : { ref }),
    ...(bbox === undefined ? {} : { bbox }),
    size,
    ...(maxSide === undefined ? {} : { maxSide }),
    ...(includeContext === undefined ? {} : { includeContext }),
    ...(purpose === undefined ? {} : { purpose }),
    return: returnMode,
  });
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

function agentObservationOutput(observation: ComputerObservation): AgentExtensionJsonValue {
  return {
    observedAt: observation.observedAt,
    screenId: observation.screenId,
    ...(observation.observationId === undefined ? {} : { observationId: observation.observationId }),
    ...(observation.url === undefined ? {} : { url: observation.url }),
    tabs: observation.tabs as unknown as AgentExtensionJsonValue,
    ...(observation.elements === undefined ? {} : { elements: observation.elements as unknown as AgentExtensionJsonValue }),
    ...(observation.delta === undefined ? {} : { delta: observation.delta as unknown as AgentExtensionJsonValue }),
  } as AgentExtensionJsonValue;
}

function agentBrowserActionOutput(result: ComputerBrowserActionResult): AgentExtensionJsonValue {
  return {
    mode: result.mode,
    ...(result.performed === undefined ? {} : { performed: result.performed }),
    ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
    ...(result.visualProbeRequired === undefined ? {} : { visualProbeRequired: result.visualProbeRequired as unknown as AgentExtensionJsonValue }),
    ...(result.verification === undefined ? {} : { verification: result.verification as unknown as AgentExtensionJsonValue }),
    observation: agentObservationOutput(result.observation),
  } as AgentExtensionJsonValue;
}

function resumedAfterHumanTakeover(resume: Extract<ComputerAgentControlResume, { resumedAfterTakeover: true }>): AgentExtensionJsonValue {
  return {
    resumedAfterHumanTakeover: true,
    staleActionReplayed: false,
    controlGeneration: resume.controlLease.generation,
    observation: agentObservationOutput(resume.observation),
  };
}

function browserAction(input: Readonly<Record<string, AgentExtensionJsonValue>>): ComputerBrowserAction {
  const kind = input.action;
  const visualProbeToken = agentOptionalText(input, "probeToken", 256);
  if (kind === "navigate") return { kind, url: agentText(input, "url", 4_096) };
  if (kind === "click") return { kind, target: agentSemanticRef(input, "target"), ...(visualProbeToken === undefined ? {} : { visualProbeToken }) };
  if (kind === "press") {
    const key = agentText(input, "key", 128);
    const target = optionalAgentSemanticRef(input, "target");
    if (/^(enter|numpadenter|space|spacebar)$/i.test(key) && target === undefined) {
      throw new Error("activation key presses require target to be a current semantic ref from computer_observe");
    }
    return { kind, key, ...(target === undefined ? {} : { target }), ...(visualProbeToken === undefined ? {} : { visualProbeToken }) };
  }
  if (kind === "type") {
    if (input.sensitive === true) throw new Error("sensitive browser input requires human takeover or a dedicated protected-credential flow");
    if (input.sensitive !== undefined && input.sensitive !== false) throw new Error("sensitive must be a boolean");
    return {
      kind,
      target: agentSemanticRef(input, "target"),
      text: agentText(input, "text", 16_384),
      sensitive: false,
      ...(visualProbeToken === undefined ? {} : { visualProbeToken }),
    };
  }
  if (kind === "scroll") {
    const deltaY = agentNumber(input, "deltaY", -100_000, 100_000, true)!;
    const deltaX = agentNumber(input, "deltaX", -100_000, 100_000);
    const target = optionalAgentSemanticRef(input, "target");
    return {
      kind,
      deltaY,
      ...(deltaX === undefined ? {} : { deltaX }),
      ...(target === undefined ? {} : { target }),
      ...(visualProbeToken === undefined ? {} : { visualProbeToken }),
    };
  }
  throw new Error("action must be navigate, click, type, press, or scroll");
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
  kind: "observe" | "visual" | "browser",
): Promise<void> {
  await permissions.authorize({
    mode: context.permissionMode ?? permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE),
    workspace: context.cwd,
    access: kind === "browser" ? "write" : "read",
    action: {
      id: kind === "observe" ? "computer.observe" : kind === "visual" ? "computer.visual.probe" : "computer.browser.action",
      effect: kind === "browser" ? "external-write" : "private-read",
      resource: `computer:${binding.nodeId}:screen:${binding.screenId}`,
      network: true,
    },
    reason: kind === "observe"
      ? `observe leased Computer screen ${binding.nodeId}:${binding.screenId}`
      : kind === "visual"
        ? `inspect a bounded visual crop on leased Computer screen ${binding.nodeId}:${binding.screenId}`
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
        "Computer-control strategy: prefer structured computer_observe results over pixels. Query/filter the UI instead of requesting broad content. Element refs are observation-scoped: after any new observation, use its new obs-N:eM ref. A delta may preserve the local eM identity for continuity, but the older full ref is still stale.",
        "Use semantic refs (for example obs-12:e7) for click/type/scroll. Elements may advertise toggle/select/expand semantics; invoke those browser controls with click on the same ref, then re-observe state. If computer_browser returns performed=false with visualProbeRequired, call computer_visual_probe for that exact ref, starting with the recommended tiny/small crop, then retry the same action once with the returned probeToken.",
        "Request return=image only when the active model can use pixels and structured data is insufficient. Escalate crop size progressively: tiny -> small -> medium -> window -> full. Never jump to full-screen vision for a normal control.",
        "After actions, use the returned structural delta and verification before requesting more vision. Re-observe when refs are stale. Use computer_browser only for non-secret input. Passwords, OTPs, CAPTCHAs, and other sensitive input require human takeover; never place those values in tool arguments.",
        "If a Computer tool reports resumedAfterHumanTakeover=true, the interrupted action was not replayed. Treat the attached fresh observation as the new source of truth and replan before acting again.",
        "</friday_computer_context>",
      ].join("\n");
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "computer-observe",
    sourcePluginId: "computer",
    name: "computer_observe",
    label: "Inspect Computer UI",
    description: "Inspect the active leased Computer UI as bounded structured semantic elements. Prefer query/scope filters. Returns observation-scoped refs, element state, and structural deltas without requiring screenshots.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        scope: { type: "string", enum: ["interactive", "all"] },
        query: { type: "string" },
        near: { type: "string" },
        maxElements: { type: "integer", minimum: 1, maximum: 256 },
      },
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      const context = executionContext;
      const binding = currentComputerBinding(service, context);
      await authorizeAgentComputer(permissions, context!, binding, "observe");
      try {
        return {
          output: agentObservationOutput(await service.observeScreen(binding.screenLeaseId, binding.ownerId, binding.generation, signal, observationRequest(input))),
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
    description: "Navigate, click, type non-secret text, press a key, or scroll on the active leased Computer browser. Model-facing element targets must be current semantic refs from computer_observe; activation key presses also require a semantic target. Low-confidence/high-impact semantic actions are deferred until a matching visual probe token is supplied. Sensitive input must use human takeover.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "press", "scroll"] },
        url: { type: "string" },
        target: { type: "string" },
        text: { type: "string" },
        key: { type: "string" },
        sensitive: { type: "boolean" },
        deltaX: { type: "number", minimum: -100000, maximum: 100000 },
        deltaY: { type: "number", minimum: -100000, maximum: 100000 },
        probeToken: { type: "string" },
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
        return { output: agentBrowserActionOutput(result) };
      } catch (error) {
        const resume = await resumeAgentComputerAfterTakeover(service, initialBinding, error, signal);
        if (!resume.resumedAfterTakeover) throw error;
        return { output: resumedAfterHumanTakeover(resume) };
      }
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "computer-visual-probe",
    sourcePluginId: "computer",
    name: "computer_visual_probe",
    label: "Probe Computer visual region",
    description: "Inspect the smallest bounded crop needed to resolve UI ambiguity. Use ref for a current semantic target or bbox for an explicit region. Text mode returns safe nearby visible text/target verification; image mode returns the bounded PNG directly to a vision-capable model. Protected/challenge regions are refused.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        ref: { type: "string" },
        bbox: {
          type: "object",
          properties: {
            left: { type: "number" },
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
          },
          required: ["left", "top", "right", "bottom"],
          additionalProperties: false,
        },
        size: { type: "string", enum: ["tiny", "small", "medium", "window", "full"] },
        maxSide: { type: "integer", minimum: 64, maximum: 2048 },
        includeContext: { type: "boolean" },
        purpose: { type: "string" },
        return: { type: "string", enum: ["text", "image"] },
      },
      additionalProperties: false,
    }),
    async execute(input, signal, executionContext) {
      const context = executionContext;
      const initialBinding = currentComputerBinding(service, context);
      const request = visualProbeRequest(input);
      await authorizeAgentComputer(permissions, context!, initialBinding, "visual");
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
        const result = await service.visualProbe(binding.screenLeaseId, binding.ownerId, binding.generation, request, signal);
        const { image, ...metadata } = result;
        if (!image) return { output: metadata as unknown as AgentExtensionJsonValue };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(metadata) },
            { type: "image" as const, data: image.data, mimeType: image.mimeType },
          ],
        };
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
    optional: [PERMISSIONS_CAPABILITY, TOOLS_CAPABILITY, EXECUTION_CAPABILITY],
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

    const tools = ctx.services.optional(TOOLS_CAPABILITY);
    const execution = ctx.services.optional(EXECUTION_CAPABILITY);
    const providerHooks = tools && execution ? {
      runTool: async (request: import("./contract.js").ComputerNodeToolExecutionRequest): Promise<import("./contract.js").ComputerToolExecutionResult> => {
        const tool = tools.createTool(request.tool, request.workspace, {
          permissionMode: "full",
          executionTarget: coreHostExecutionTarget(),
        });
        const result = await tool.execute(`computer:${request.runId}:${request.tool}`, request.input as never, request.signal);
        return {
          content: result.content,
          ...(result.details === undefined ? {} : { details: result.details }),
          ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
        };
      },
      cleanupRunProcesses: async (request: import("./contract.js").ComputerRunProcessCleanupRequest): Promise<void> => {
        for (const process of execution.processes.list().filter((entry) => entry.runId === request.runId && entry.state === "running")) {
          await execution.processes.stop(process.id, "Computer run settled");
        }
      },
    } satisfies Pick<import("./providers/linux-sway.js").LinuxSwayComputerAdapterOptions, "runTool" | "cleanupRunProcesses"> : {};

    for (const adapter of options.adapters ?? configuredComputerAdapters(process.env, process.platform, providerHooks)) await service.registerNode(adapter);

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
export { configuredComputerAdapters, configuredComputerProviderId, inspectConfiguredComputerProvider, createLinuxSwayComputerAdapter } from "./providers/index.js";
