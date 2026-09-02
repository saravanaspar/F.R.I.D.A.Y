import { join } from "node:path";
import { reportOperationalError } from "@friday/operational-errors";
import type { FridayPlugin } from "../../src/plugin.js";
import {
  normalizeCustomModelEndpoint,
  normalizeCustomProvider,
  readCustomModels,
  removeCustomModel,
  toCustomModelDescriptor,
  upsertCustomModel,
  type CustomModelRecord,
} from "./custom-models.js";
import {
  getFridayHome,
  readRuntimeSettings,
  saveRuntimeSettings,
  updateRuntimeSettings,
  type RuntimePermissionMode,
  type RuntimeSettings,
  type RuntimeSettingsPatch,
} from "./runtime-env.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { lifecycleHandoff, LIFECYCLE_CAPABILITY } from "../lifecycle/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_ACTIVE_WORK_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  summarizeSystemActiveWork,
  type SystemActionExecutionContext,
  type SystemJsonObject,
} from "../system/contract.js";
import { RUNTIME_SETTINGS_CAPABILITY, type RuntimeSettingsService } from "./contract.js";
import { TURN_FINALIZER_CONTRIBUTION, type AgentExtensionJsonValue } from "../turn-loop/contract.js";
import { registerPersonaExtensions } from "./personas.js";

const RESTART_MARKER = "FRIDAY_RUNTIME_SETTINGS_RESTART";
const RESTART_TIMEOUT_MS = 30_000;
const TAKEOVER_TIMEOUT_MS = 30_000;
const SETTINGS_ENV_KEYS = [
  "FRIDAY_MODEL_PROVIDER",
  "FRIDAY_MODEL_ID",
  "FRIDAY_ROUTING_PROVIDER",
  "FRIDAY_ROUTING_MODEL_ID",
  "FRIDAY_PERMISSION_MODE",
  "FRIDAY_TIMEZONE",
  "FRIDAY_WORKSPACE",
  "FRIDAY_SELF_REPOSITORY",
] as const;

export interface RuntimeSettingsPluginOptions {
  readonly home?: string | undefined;
  readonly stopPredecessor?: (() => void | Promise<void>) | undefined;
}

function optionalString(input: Readonly<SystemJsonObject>, name: string, maximum = 256): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  if (/[\r\n\0]/.test(normalized)) throw new Error(`${name} contains unsupported control characters`);
  return normalized;
}

function optionalBoolean(input: Readonly<SystemJsonObject>, name: string): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalInteger(input: Readonly<SystemJsonObject>, name: string, minimum: number, maximum: number): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function permissionMode(input: Readonly<SystemJsonObject>): RuntimePermissionMode | undefined {
  const value = optionalString(input, "permissionMode", 16);
  if (value === undefined) return undefined;
  if (value === "ask" || value === "auto" || value === "full") return value;
  throw new Error("permissionMode must be ask, auto, or full");
}

function assertKnownModel(model: typeof import("@friday/model"), provider: string, modelId: string, label: string): void {
  const knownProvider = model.getProviders().find((candidate) => candidate === provider);
  if (!knownProvider) throw new Error(`Unknown ${label} provider: ${provider}`);
  if (!model.getModels(knownProvider).some((candidate) => candidate.id === modelId)) {
    throw new Error(`Unknown ${label} model: ${provider}/${modelId}`);
  }
}

function validateSettings(model: typeof import("@friday/model"), settings: RuntimeSettings): void {
  assertKnownModel(model, settings.modelProvider, settings.modelId, "main");
  if (settings.routingProvider && settings.routingModelId) {
    assertKnownModel(model, settings.routingProvider, settings.routingModelId, "routing");
  }
}

function patchFromInput(input: Readonly<SystemJsonObject>): RuntimeSettingsPatch {
  const useMain = optionalBoolean(input, "useMainForRouting");
  const routingProvider = optionalString(input, "routingProvider");
  const routingModelId = optionalString(input, "routingModelId");
  if (useMain === true && (routingProvider !== undefined || routingModelId !== undefined)) {
    throw new Error("useMainForRouting cannot be combined with explicit routingProvider/routingModelId");
  }
  return Object.freeze({
    ...(optionalString(input, "modelProvider") === undefined ? {} : { modelProvider: optionalString(input, "modelProvider") }),
    ...(optionalString(input, "modelId") === undefined ? {} : { modelId: optionalString(input, "modelId") }),
    ...(useMain === true
      ? { routingProvider: null, routingModelId: null }
      : {
          ...(routingProvider === undefined ? {} : { routingProvider }),
          ...(routingModelId === undefined ? {} : { routingModelId }),
        }),
    ...(permissionMode(input) === undefined ? {} : { permissionMode: permissionMode(input) }),
    ...(optionalString(input, "timezone", 128) === undefined ? {} : { timezone: optionalString(input, "timezone", 128) }),
    ...(optionalString(input, "selfRepository", 4_096) === undefined ? {} : { selfRepository: optionalString(input, "selfRepository", 4_096) }),
  });
}

function publicSettings(settings: RuntimeSettings | undefined): Record<string, unknown> {
  if (!settings) return { configured: false };
  return {
    configured: true,
    mainModel: { provider: settings.modelProvider, modelId: settings.modelId },
    routingModel: settings.routingProvider && settings.routingModelId
      ? { provider: settings.routingProvider, modelId: settings.routingModelId, dedicated: true }
      : { provider: settings.modelProvider, modelId: settings.modelId, dedicated: false },
    permissionMode: settings.permissionMode,
    timezone: settings.timezone,
    workspaceRoot: settings.workspaceRoot ?? null,
    selfRepository: settings.selfRepository ?? null,
  };
}

function channelPrincipal(turn: SystemActionExecutionContext["turn"]) {
  if (turn.principal.authority !== "channel") {
    throw new Error("This interactive configuration flow requires a channel-originated turn");
  }
  return Object.freeze({
    channel: turn.principal.channel,
    accountId: turn.principal.accountId,
    conversationId: turn.principal.conversationId,
    senderId: turn.principal.senderId,
    ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
  });
}

function systemMode(settings: RuntimeSettings | undefined): RuntimePermissionMode {
  return settings?.permissionMode ?? "ask";
}

export function createRuntimeSettingsPlugin(options: RuntimeSettingsPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "runtime-settings",
    requires: [MODEL_CAPABILITY, LIFECYCLE_CAPABILITY, PERMISSIONS_CAPABILITY],
    optional: [CHANNELS_TRUSTED_CAPABILITY, MODEL_CREDENTIALS_CAPABILITY],
    provides: [RUNTIME_SETTINGS_CAPABILITY],
  }, async (ctx) => {
    const model = ctx.services.require(MODEL_CAPABILITY).api;
    const lifecycleService = ctx.services.require(LIFECYCLE_CAPABILITY);
    const lifecycle = lifecycleService.api;
    const handoff = lifecycleHandoff(lifecycleService);
    const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
    const home = options.home ?? getFridayHome();
    await registerPersonaExtensions(ctx, permissions, home);
    const stopPredecessor = options.stopPredecessor ?? (() => { process.kill(process.pid, "SIGTERM"); });

    async function confirmRestartWithActiveWork(context: SystemActionExecutionContext, reason: string): Promise<void> {
      const active = summarizeSystemActiveWork(ctx.collect(SYSTEM_ACTIVE_WORK_CONTRIBUTION), {
        ...(context.jobId === undefined ? {} : { excludeJobId: context.jobId }),
        excludeForegroundTurns: context.jobId === undefined ? 1 : 0,
      });
      if (active.backgroundSessions === 0 && active.foregroundTurns === 0) return;
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) {
        throw new Error(`Restart blocked because ${active.backgroundSessions} other background session(s) and ${active.foregroundTurns} other foreground turn(s) are active and the trusted channel approval service is unavailable.`);
      }
      const approved = await channels.requestApproval({
        principal: context.turn.principal,
        actionId: "lifecycle.restart-with-active-sessions",
        effect: "system-write",
        resource: "runtime-restart",
        reason: [
          `${reason} requires restarting FRIDAY while ${active.backgroundSessions} other background session(s) and ${active.foregroundTurns} other foreground turn(s) are active.`,
          "If you continue, FRIDAY will pause them and resume them after verified restart from their last durable transcript and original user request.",
          "Content and tool outputs already recorded in the transcript remain available. Private model thinking that has not yet been recorded can be lost.",
          "Approve stopping the active work temporarily and resuming it after restart?",
        ].join(" "),
      });
      if (!approved) throw new Error("Restart cancelled; active background sessions were left running.");
    }

    for (const custom of await readCustomModels(home)) {
      model.registerModel(toCustomModelDescriptor(custom) as never, { replace: true });
      ctx.effect(() => { model.unregisterModel(custom.provider, custom.modelId); });
    }

    let updateTail: Promise<void> = Promise.resolve();
    async function acquireUpdateLock(): Promise<() => void> {
      const previous = updateTail;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
      updateTail = previous.then(() => gate);
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseGate();
      };
    }

    const service: RuntimeSettingsService = Object.freeze({
      read: () => readRuntimeSettings(home),
      async update(patch: RuntimeSettingsPatch, updateOptions: Parameters<RuntimeSettingsService["update"]>[1] = {}) {
        const release = await acquireUpdateLock();
        let previous: RuntimeSettings | undefined;
        let manager: ReturnType<typeof lifecycle.createLifecycleManager> | undefined;
        let restartRequestId: string | undefined;
        let outcome: "pending" | "succeeded" | "failed" = "pending";
        let resourcesQuiesced = false;
        let takeoverAccepted = false;

        const settleFailure = async (primaryError: unknown): Promise<void> => {
          if (outcome !== "pending") return;
          outcome = "failed";
          const cleanupErrors: unknown[] = [];
          if (resourcesQuiesced && !takeoverAccepted) {
            try {
              await handoff.resume();
              resourcesQuiesced = false;
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          if (manager && restartRequestId && !takeoverAccepted) {
            try {
              await manager.retireReplacement(restartRequestId, `Runtime-settings handoff failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          if (previous && !takeoverAccepted) {
            try {
              await saveRuntimeSettings(previous, home);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          release();
          if (cleanupErrors.length > 0) {
            throw new AggregateError([primaryError, ...cleanupErrors], "Runtime-settings handoff failed and compensation was incomplete");
          }
        };

        try {
          previous = await readRuntimeSettings(home);
          if (!previous) throw new Error("FRIDAY runtime settings are not configured; run `friday setup` first");
          const candidate = await updateRuntimeSettings(patch, home);
          validateSettings(model, candidate);
          if (updateOptions.restart === false) {
            outcome = "succeeded";
            release();
            return candidate;
          }

          manager = lifecycle.createLifecycleManager({ stateDir: join(home, "lifecycle") });
          const env: Record<string, string | undefined> = { [RESTART_MARKER]: "1" };
          for (const key of SETTINGS_ENV_KEYS) env[key] = undefined;
          const restart = await manager.launchReplacement({
            env,
            timeoutMs: RESTART_TIMEOUT_MS,
            ...(updateOptions.signal === undefined ? {} : { signal: updateOptions.signal }),
          });
          restartRequestId = restart.requestId;
          if (!updateOptions.afterReply || !updateOptions.onFailure) {
            throw new Error("A runtime restart requires both success and failure handoff finalizers");
          }
          const settleSuccess = async (): Promise<void> => {
            if (outcome !== "pending") return;
            try {
              // The candidate successor may have been waiting while other session
              // work changed. Re-check immediately before ownership transfer.
              await updateOptions.beforeRestart?.();
              if (restart.phase === "accepted") {
                takeoverAccepted = true;
              } else {
                await handoff.quiesce();
                resourcesQuiesced = true;
                manager!.releaseForTakeover(restart.requestId);
                await manager!.waitForTakeover(restart.requestId, {
                  timeoutMs: TAKEOVER_TIMEOUT_MS,
                  ...(updateOptions.signal === undefined ? {} : { signal: updateOptions.signal }),
                });
                takeoverAccepted = true;
              }
              await stopPredecessor();
            } catch (error) {
              if (takeoverAccepted) {
                outcome = "succeeded";
                release();
                throw new Error("The verified successor owns all runtime resources, but the quiesced predecessor could not terminate", { cause: error });
              }
              await settleFailure(error);
              throw error;
            }
            outcome = "succeeded";
            release();
          };
          updateOptions.afterReply!(settleSuccess, {
            type: "runtime-settings.handoff",
            payload: { restartRequestId: restart.requestId, home },
          });
          updateOptions.onFailure!(settleFailure);
          return candidate;
        } catch (error) {
          await settleFailure(error);
          throw error;
        }
      },
    });
    ctx.services.provide(RUNTIME_SETTINGS_CAPABILITY, service);
    ctx.contribute(TURN_FINALIZER_CONTRIBUTION, {
      type: "runtime-settings.handoff",
      async finalize(payload: AgentExtensionJsonValue, finalizerContext) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Runtime-settings handoff finalizer payload is invalid");
        }
        const restartRequestId = (payload as Record<string, AgentExtensionJsonValue>).restartRequestId;
        const payloadHome = (payload as Record<string, AgentExtensionJsonValue>).home;
        if (typeof restartRequestId !== "string" || !restartRequestId.trim() || payloadHome !== home) {
          throw new Error("Runtime-settings handoff finalizer does not match this runtime");
        }
        const manager = lifecycle.createLifecycleManager({ stateDir: join(home, "lifecycle") });
        let quiesced = false;
        let takeoverAccepted = false;
        try {
          await confirmRestartWithActiveWork({
            turn: finalizerContext.turn,
            ...(finalizerContext.signal === undefined ? {} : { signal: finalizerContext.signal }),
            deferAfterReply() {},
          }, "Runtime settings handoff recovery");
          await handoff.quiesce();
          quiesced = true;
          manager.releaseForTakeover(restartRequestId);
          await manager.waitForTakeover(restartRequestId, {
            timeoutMs: TAKEOVER_TIMEOUT_MS,
            ...(finalizerContext.signal === undefined ? {} : { signal: finalizerContext.signal }),
          });
          takeoverAccepted = true;
          await stopPredecessor();
        } catch (error) {
          if (!takeoverAccepted) {
            try {
              await manager.retireReplacement(restartRequestId, "Recovered runtime-settings handoff failed");
            } catch (cleanupError) {
              reportOperationalError({
                component: "runtime-settings",
                operation: "retire replacement after recovered handoff failure",
                operationCode: "replacement-retire",
                error: cleanupError,
                severity: "warn",
                outcome: "degraded",
                correlationId: restartRequestId,
              });
            }
            if (quiesced) await handoff.resume();
          }
          throw error;
        }
      },
    });

    // A runtime-settings successor validates the candidate before declaring itself ready.
    if (process.env[RESTART_MARKER] === "1") {
      ctx.afterReady(async () => {
        try {
          const settings = await service.read();
          if (!settings) throw new Error("Runtime-settings successor has no persisted settings");
          validateSettings(model, settings);
          lifecycle.acknowledgeRestartFromEnvironment();
          await lifecycle.waitForTakeoverReleaseFromEnvironment({ timeoutMs: TAKEOVER_TIMEOUT_MS });
          await handoff.activate();
          lifecycle.acknowledgeTakeoverFromEnvironment();
        } catch (error) {
          try {
            await handoff.quiesce();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Runtime-settings successor failed and resource cleanup was incomplete");
          }
          lifecycle.rejectTakeoverFromEnvironment({ error });
          throw error;
        }
      });
    }

    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "runtime-settings",
      label: "Runtime settings",
      snapshot: async () => ({
        ...publicSettings(await service.read()),
        customModels: (await readCustomModels(home)).map((entry) => ({
          provider: entry.provider,
          modelId: entry.modelId,
          name: entry.name,
          baseUrl: entry.baseUrl,
        })),
      }),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.settings",
      label: "Runtime settings",
      description: "Show the current non-secret main model, routing model, and permission defaults.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "runtime.settings", effect: "global-operational-read", resource: "runtime:settings", network: false };
      },
      execute: async () => publicSettings(await service.read()),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.settings.update",
      label: "Update runtime settings",
      description: "Change typed non-secret main/routing model, permission defaults, wall-clock timezone, or the canonical self-improvement source checkout, then safely restart FRIDAY. Use useMainForRouting=true to remove a dedicated routing model.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          modelProvider: { type: "string" },
          modelId: { type: "string" },
          routingProvider: { type: "string" },
          routingModelId: { type: "string" },
          useMainForRouting: { type: "boolean" },
          permissionMode: { type: "string", enum: ["ask", "auto", "full"] },
          timezone: { type: "string", description: "IANA timezone such as Asia/Kolkata or America/New_York" },
          selfRepository: { type: "string", description: "Absolute or relative path to the canonical FRIDAY source checkout used for self-improvement" },
          restart: { type: "boolean" },
        },
        additionalProperties: false,
      }),
      permission() {
        return { id: "runtime.settings.update", effect: "system-write", resource: "runtime-settings", network: false };
      },
      async execute(input, context) {
        const restart = optionalBoolean(input, "restart") ?? true;
        const updated = await service.update(patchFromInput(input), {
          restart,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(restart ? { beforeRestart: () => confirmRestartWithActiveWork(context, "Runtime settings update") } : {}),
          afterReply: context.deferAfterReply,
          onFailure: context.deferOnFailure,
        });
        return {
          updated: true,
          restart,
          settings: publicSettings(updated),
          message: restart
            ? "Runtime settings updated. A verified successor is ready; after this reply FRIDAY will re-check active work, perform the handoff, and exit."
            : "Runtime settings updated. Restart FRIDAY to apply the saved defaults.",
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.custom-model.configure",
      label: "Configure custom model endpoint",
      description: "Configure an OpenAI-compatible custom model. For channel requests FRIDAY can ask for the endpoint first, then model id, then capture only the API key directly into Vault and optionally select the model.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          baseUrl: { type: "string" },
          provider: { type: "string" },
          modelId: { type: "string" },
          name: { type: "string" },
          contextWindow: { type: "integer" },
          maxTokens: { type: "integer" },
          requireApiKey: { type: "boolean" },
          useFor: { type: "string", enum: ["none", "main", "routing"] },
          restart: { type: "boolean" },
        },
        additionalProperties: false,
      }),
      permission() {
        return { id: "runtime.custom-model.configure", effect: "system-write", resource: "runtime:custom-models", network: false };
      },
      async execute(input, context) {
        const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
        const credentials = ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY);
        const principal = context.turn.principal.authority === "channel" ? channelPrincipal(context.turn) : undefined;

        let baseUrl = optionalString(input, "baseUrl", 2_048);
        if (!baseUrl) {
          if (!channels || !principal) throw new Error("baseUrl is required outside an interactive channel flow");
          baseUrl = await channels.requestPrompt({
            principal,
            message: "Custom model setup — send the OpenAI-compatible API endpoint first.",
            placeholder: "https://models.example.com/v1",
            maxLength: 2_048,
          });
        }
        baseUrl = normalizeCustomModelEndpoint(baseUrl);

        let modelId = optionalString(input, "modelId", 160);
        if (!modelId) {
          if (!channels || !principal) throw new Error("modelId is required outside an interactive channel flow");
          modelId = await channels.requestPrompt({
            principal,
            message: "Endpoint accepted. Now send the exact model id exposed by that endpoint.",
            placeholder: "model-name",
            maxLength: 160,
          });
        }
        const provider = normalizeCustomProvider(optionalString(input, "provider", 128) ?? new URL(baseUrl).hostname);
        const name = optionalString(input, "name", 240) ?? modelId;
        const contextWindow = optionalInteger(input, "contextWindow", 1_024, 10_000_000);
        const maxTokens = optionalInteger(input, "maxTokens", 1, 10_000_000);
        const requireApiKey = optionalBoolean(input, "requireApiKey") ?? true;
        const useFor = optionalString(input, "useFor", 16) ?? "none";
        if (useFor !== "none" && useFor !== "main" && useFor !== "routing") throw new Error("useFor must be none, main, or routing");
        const restart = optionalBoolean(input, "restart") ?? true;

        const plan = [
          "Custom model configuration plan",
          `Endpoint: ${baseUrl}`,
          `Provider: ${provider}`,
          `Model: ${modelId}`,
          `Authentication: ${requireApiKey ? "API key → Vault" : "none"}`,
          `Use for: ${useFor}`,
        ].join("\n");
        await context.turn.reply(plan);
        const current = await service.read();
        await permissions.authorize({
          mode: systemMode(current),
          workspace: process.cwd(),
          access: "write",
          action: { id: "runtime.custom-model.configure", effect: "system-write", resource: `model:${provider}/${modelId}`, network: true },
          reason: `Configure custom model ${provider}/${modelId} at ${baseUrl}`,
        });

        const existing = (await readCustomModels(home)).find((entry) => entry.provider === provider && entry.modelId === modelId);
        let configured: CustomModelRecord | undefined;
        try {
          configured = await upsertCustomModel({
            provider,
            modelId,
            name,
            baseUrl,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
          }, home);
          model.registerModel(toCustomModelDescriptor(configured) as never, { replace: true });

          if (requireApiKey) {
            if (!credentials) throw new Error("Model credential service is unavailable");
            if (!principal) {
              throw new Error("Custom model API-key capture requires a channel-originated turn; configure the credential from a trusted channel or `friday setup`");
            }
            await credentials.captureApiKey({ principal, provider });
          }

          if (useFor !== "none") {
            const patch: RuntimeSettingsPatch = useFor === "main"
              ? { modelProvider: provider, modelId }
              : { routingProvider: provider, routingModelId: modelId };
            await service.update(patch, {
              restart,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
              ...(restart ? { beforeRestart: () => confirmRestartWithActiveWork(context, "Custom model activation") } : {}),
              afterReply: context.deferAfterReply,
              onFailure: context.deferOnFailure,
            });
          }
          return {
            configured: true,
            provider,
            modelId,
            baseUrl,
            credential: requireApiKey ? "verified-vault" : "none",
            useFor,
            restart: useFor === "none" ? false : restart,
          };
        } catch (error) {
          if (configured) {
            if (existing) {
              await upsertCustomModel({
                provider: existing.provider,
                modelId: existing.modelId,
                name: existing.name,
                baseUrl: existing.baseUrl,
                contextWindow: existing.contextWindow,
                maxTokens: existing.maxTokens,
              }, home);
              model.registerModel(toCustomModelDescriptor(existing) as never, { replace: true });
            } else {
              try {
                await removeCustomModel(provider, modelId, home);
              } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Custom-model setup failed and persisted-model rollback also failed");
              }
              model.unregisterModel(provider, modelId);
            }
          }
          throw error;
        }
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.custom-models",
      label: "Custom models",
      description: "List configured non-secret custom model endpoints.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "runtime.custom-models", effect: "global-operational-read", resource: "runtime:custom-models", network: false };
      },
      execute: async () => (await readCustomModels(home)).map((entry) => ({
        provider: entry.provider,
        modelId: entry.modelId,
        name: entry.name,
        baseUrl: entry.baseUrl,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
      })),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.custom-model.remove",
      label: "Remove custom model",
      description: "Remove a custom model descriptor after ensuring it is not the active main or routing model.",
      parameters: Object.freeze({
        type: "object",
        properties: { provider: { type: "string" }, modelId: { type: "string" } },
        required: ["provider", "modelId"],
        additionalProperties: false,
      }),
      permission(input) {
        const provider = normalizeCustomProvider(optionalString(input, "provider", 128) ?? "");
        const modelId = optionalString(input, "modelId", 160) ?? "";
        return { id: "runtime.custom-model.remove", effect: "system-write", resource: `model:${provider}/${modelId}`, network: false };
      },
      async execute(input) {
        const provider = normalizeCustomProvider(optionalString(input, "provider", 128) ?? "");
        const modelId = optionalString(input, "modelId", 160) ?? "";
        const current = await service.read();
        if (current && ((current.modelProvider === provider && current.modelId === modelId)
          || (current.routingProvider === provider && current.routingModelId === modelId))) {
          throw new Error("Cannot remove a custom model while it is selected as the main or routing model");
        }
        const removed = await removeCustomModel(provider, modelId, home);
        if (removed) model.unregisterModel(provider, modelId);
        return { removed, provider, modelId };
      },
    });
  });
}

export default createRuntimeSettingsPlugin();
