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
import {
  onboardingNextSteps,
  readOnboardingState,
  updateOnboardingStep,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "./onboarding-state.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { lifecycleHandoff, LIFECYCLE_CAPABILITY } from "../lifecycle/contract.js";
import {
  MODEL_CAPABILITY,
  MODEL_REGISTRY_CAPABILITY,
  type ModelService,
} from "../model/contract.js";
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
  "FRIDAY_HOST_PRIVILEGE_MODE",
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

function assertKnownModel(model: ModelService, provider: string, modelId: string, label: string): void {
  const knownProvider = model.getProviders().find((candidate) => candidate === provider);
  if (!knownProvider) throw new Error(`Unknown ${label} provider: ${provider}`);
  if (!model.getModels(knownProvider).some((candidate) => candidate.id === modelId)) {
    throw new Error(`Unknown ${label} model: ${provider}/${modelId}`);
  }
}

function validateSettings(model: ModelService, settings: RuntimeSettings): void {
  if (settings.modelProvider && settings.modelId) {
    assertKnownModel(model, settings.modelProvider, settings.modelId, "main");
  }
  if (!settings.routingProvider || !settings.routingModelId) {
    throw new Error("A routing model is required even when the main reasoning model is not configured");
  }
  assertKnownModel(model, settings.routingProvider, settings.routingModelId, "routing");
}

function patchFromInput(input: Readonly<SystemJsonObject>): RuntimeSettingsPatch {
  const useMain = optionalBoolean(input, "useMainForRouting");
  const clearMain = optionalBoolean(input, "clearMainModel") === true;
  const modelProvider = optionalString(input, "modelProvider");
  const modelId = optionalString(input, "modelId");
  const routingProvider = optionalString(input, "routingProvider");
  const routingModelId = optionalString(input, "routingModelId");
  if (clearMain && (modelProvider !== undefined || modelId !== undefined)) {
    throw new Error("clearMainModel cannot be combined with modelProvider/modelId");
  }
  if (useMain === true && (routingProvider !== undefined || routingModelId !== undefined)) {
    throw new Error("useMainForRouting cannot be combined with explicit routingProvider/routingModelId");
  }
  return Object.freeze({
    ...(clearMain ? { modelProvider: null, modelId: null } : {
      ...(modelProvider === undefined ? {} : { modelProvider }),
      ...(modelId === undefined ? {} : { modelId }),
    }),
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
  const mainConfigured = Boolean(settings.modelProvider && settings.modelId);
  return {
    configured: true,
    routerOnly: !mainConfigured,
    mainModel: mainConfigured ? { provider: settings.modelProvider, modelId: settings.modelId } : null,
    routingModel: settings.routingProvider && settings.routingModelId
      ? {
          provider: settings.routingProvider,
          modelId: settings.routingModelId,
          dedicated: !mainConfigured || settings.routingProvider !== settings.modelProvider || settings.routingModelId !== settings.modelId,
        }
      : null,
    permissionMode: settings.permissionMode,
    hostPrivilegeMode: settings.hostPrivilegeMode ?? "none",
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
    requires: [MODEL_CAPABILITY, MODEL_REGISTRY_CAPABILITY, LIFECYCLE_CAPABILITY, PERMISSIONS_CAPABILITY],
    optional: [CHANNELS_TRUSTED_CAPABILITY, MODEL_CREDENTIALS_CAPABILITY],
    provides: [RUNTIME_SETTINGS_CAPABILITY],
  }, async (ctx) => {
    const model = ctx.services.require(MODEL_CAPABILITY);
    const modelRegistry = ctx.services.require(MODEL_REGISTRY_CAPABILITY);
    const lifecycleService = ctx.services.require(LIFECYCLE_CAPABILITY);
    const lifecycle = lifecycleService;
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
      modelRegistry.registerModel(toCustomModelDescriptor(custom) as never, { replace: true });
      ctx.effect(() => { modelRegistry.unregisterModel(custom.provider, custom.modelId); });
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
      onboarding: () => readOnboardingState(home),
      markOnboardingStep: (step: OnboardingStepId, status: OnboardingStepStatus) => updateOnboardingStep(step, status, home),
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
      snapshot: async () => {
        const onboarding = await service.onboarding();
        return ({
        ...publicSettings(await service.read()),
        onboarding: onboarding ? { ...onboarding, nextSteps: onboardingNextSteps(onboarding) } : null,
        customModels: (await readCustomModels(home)).map((entry) => ({
          provider: entry.provider,
          modelId: entry.modelId,
          name: entry.name,
          baseUrl: entry.baseUrl,
        })),
      });
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "onboarding.status",
      label: "Onboarding status",
      description: "Show persistent Quick/Custom onboarding progress, including mandatory local bootstrap completion and optional steps that can be continued from a trusted channel.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "onboarding.status", effect: "global-operational-read", resource: "onboarding:status", network: false };
      },
      async execute() {
        const state = await service.onboarding();
        const settings = await service.read();
        return {
          state: state ? { ...state, nextSteps: onboardingNextSteps(state) } : null,
          settings: publicSettings(settings),
          message: !state
            ? "Onboarding state is not initialized; run `friday setup` locally."
            : state.phase === "operational"
              ? "All onboarding steps are complete or intentionally skipped."
              : "Continue any pending optional step from this trusted channel, or mark an optional step skipped.",
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "onboarding.continue",
      label: "Continue onboarding",
      description: "Resume persistent onboarding from a trusted channel. Returns pending steps and the typed FRIDAY actions that configure them; mandatory router/channel/privilege bootstrap remains local-only.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "onboarding.continue", effect: "global-operational-read", resource: "onboarding:continue", network: false };
      },
      async execute() {
        const state = await service.onboarding();
        if (!state) return { ready: false, message: "Run `friday setup` locally first." };
        const pending = onboardingNextSteps(state);
        return {
          ready: state.phase !== "local-bootstrap",
          mode: state.mode,
          phase: state.phase,
          pending,
          actions: {
            mainModel: ["onboarding.main-model.setup", "runtime.custom-model.configure", "runtime.settings.update", "auth.model-credential", "auth.oauth-login"],
            permissions: ["runtime.settings.update"],
            timezone: ["runtime.settings.update"],
            voice: ["voice.setup"],
            sandbox: ["sandbox.setup"],
            executionPython: ["execution.python.setup"],
            mcp: ["mcp.servers", "mcp.add-server", "mcp.install"],
            skills: ["skills.install"],
            selfRepository: ["runtime.settings.update"],
          },
          message: pending.length === 0
            ? "Onboarding is complete."
            : `Pending optional steps: ${pending.join(", ")}. You can configure or skip them from this trusted channel.`,
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "onboarding.step",
      label: "Mark onboarding step",
      description: "Skip an optional onboarding step or reset it to pending. Successful owning setup actions mark their own steps complete; remote callers cannot claim completion without running them. Mandatory router/operator-channel/privilege steps cannot be changed remotely.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          step: { type: "string", enum: ["mainModel", "permissions", "timezone", "voice", "sandbox", "executionPython", "mcp", "skills", "selfRepository"] },
          status: { type: "string", enum: ["skipped", "pending"] },
        },
        required: ["step", "status"],
        additionalProperties: false,
      }),
      permission() {
        return { id: "onboarding.step", effect: "system-write", resource: "onboarding:state", network: false };
      },
      async execute(input) {
        const step = optionalString(input, "step", 64) as OnboardingStepId | undefined;
        const status = optionalString(input, "status", 16) as OnboardingStepStatus | undefined;
        if (!step || !status) throw new Error("step and status are required");
        if (status === "complete") throw new Error("Onboarding completion is recorded only by the owning successful setup action; use skipped or pending here");
        if (status !== "skipped" && status !== "pending") throw new Error("status must be skipped or pending");
        const state = await service.markOnboardingStep(step, status);
        return { updated: true, state: { ...state, nextSteps: onboardingNextSteps(state) } };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.settings",
      label: "Runtime settings",
      description: "Show the current non-secret main/routing models, router-only state, agent permission defaults, and local-only host privilege policy.",
      parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
      permission() {
        return { id: "runtime.settings", effect: "global-operational-read", resource: "runtime:settings", network: false };
      },
      execute: async () => publicSettings(await service.read()),
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "onboarding.main-model.setup",
      label: "Configure main reasoning model",
      description: "Interactively configure the optional main reasoning model from the originating trusted channel. Missing provider/model fields use protected prompts; API-key and supported OAuth providers persist credentials directly into Vault before settings are published.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          provider: { type: "string" },
          modelId: { type: "string" },
          persistCredential: { type: "boolean", description: "Capture a durable Vault credential when one is not already stored. Defaults to true." },
          credentialMethod: { type: "string", enum: ["api-key", "oauth"], description: "Optional credential method when the provider supports more than one. If omitted, FRIDAY asks on the trusted channel when needed." },
          restart: { type: "boolean" },
        },
        additionalProperties: false,
      }),
      permission() {
        return { id: "onboarding.main-model.setup", effect: "system-write", resource: "runtime:main-model", network: true };
      },
      async execute(input, context) {
        if (context.turn.principal.authority !== "channel") {
          throw new Error("Main-model onboarding requires an originating trusted channel");
        }
        const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
        if (!channels) throw new Error("Trusted Channels support is unavailable");
        const credentials = ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY);
        const principal = channelPrincipal(context.turn);

        let provider = optionalString(input, "provider", 128);
        if (!provider) {
          const providers = model.getProviders().map(String).sort((left, right) => left.localeCompare(right));
          provider = (await channels.requestPrompt({
            principal,
            title: "Main model provider",
            message: "Choose the provider for FRIDAY's main reasoning model.",
            notes: `Available provider ids: ${providers.join(", ").slice(0, 1_800)}`,
            options: providers.slice(0, 5).map((value) => ({ label: value, value })),
            allowCustom: true,
            placeholder: "provider id",
            maxLength: 128,
            ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
          })).trim();
        }
        const knownProvider = model.getProviders().find((candidate) => candidate === provider);
        if (!knownProvider) throw new Error(`Unknown main model provider: ${provider}`);

        let modelId = optionalString(input, "modelId", 160);
        if (!modelId) {
          const available = model.getModels(knownProvider)
            .slice()
            .sort((left, right) => Number(Boolean(right.featured)) - Number(Boolean(left.featured)) || String(left.id).localeCompare(String(right.id)));
          if (available.length === 0) throw new Error(`No models are registered for provider ${provider}`);
          modelId = (await channels.requestPrompt({
            principal,
            title: "Main reasoning model",
            message: `Choose a model from ${provider}.`,
            notes: `Known model ids: ${available.slice(0, 20).map((entry) => String(entry.id)).join(", ").slice(0, 1_800)}`,
            options: available.slice(0, 5).map((entry) => ({
              label: String(entry.name || entry.id),
              value: String(entry.id),
              ...(entry.featured ? { description: "featured" } : {}),
            })),
            allowCustom: true,
            placeholder: "model id",
            maxLength: 160,
            ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
          })).trim();
        }
        assertKnownModel(model, provider, modelId, "main");

        const persistCredential = optionalBoolean(input, "persistCredential") ?? true;
        if (!credentials) throw new Error("Model credential service is unavailable");
        if (persistCredential && !credentials.has(provider)) {
          const supportsApiKey = credentials.typicallyNeedsApiKey(provider);
          const supportsOAuth = credentials.supportsOAuth(provider);
          let credentialMethod = optionalString(input, "credentialMethod", 16);
          if (credentialMethod !== undefined && credentialMethod !== "api-key" && credentialMethod !== "oauth") {
            throw new Error("credentialMethod must be api-key or oauth");
          }
          if (credentialMethod === "api-key" && !supportsApiKey) {
            throw new Error(`${provider} does not use FRIDAY's API-key credential flow`);
          }
          if (credentialMethod === "oauth" && !supportsOAuth) {
            throw new Error(`${provider} does not expose a supported OAuth flow`);
          }
          if (!credentialMethod && supportsApiKey && supportsOAuth) {
            credentialMethod = (await channels.requestPrompt({
              principal,
              title: "Credential method",
              message: `${provider} supports more than one credential flow. Choose how FRIDAY should authenticate.`,
              options: [
                { label: "API key", value: "api-key", description: "Capture the secret directly into Vault; the model never sees it." },
                { label: "OAuth", value: "oauth", description: "Complete the provider authorization flow from this trusted channel." },
              ],
              allowCustom: false,
              maxLength: 16,
              ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
            })).trim().toLowerCase();
          }
          if (!credentialMethod) credentialMethod = supportsApiKey ? "api-key" : supportsOAuth ? "oauth" : undefined;
          if (credentialMethod === "api-key") {
            await credentials.captureApiKey({ principal, provider });
          } else if (credentialMethod === "oauth") {
            await credentials.captureOAuth({ principal, provider, ...(context.signal === undefined ? {} : { signal: context.signal }) });
          }
        }

        const restart = optionalBoolean(input, "restart") ?? true;
        const previousOnboarding = await service.onboarding();
        const updated = await service.update({ modelProvider: provider, modelId }, {
          restart,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(restart ? { beforeRestart: () => confirmRestartWithActiveWork(context, "Main model onboarding") } : {}),
          afterReply: context.deferAfterReply,
          onFailure: context.deferOnFailure,
        });
        await service.markOnboardingStep("mainModel", "complete");
        if (previousOnboarding && context.deferOnFailure) {
          context.deferOnFailure(() => service.markOnboardingStep("mainModel", previousOnboarding.steps.mainModel).then(() => undefined));
        }
        return {
          configured: true,
          restart,
          mainModel: { provider: updated.modelProvider, modelId: updated.modelId },
          message: restart
            ? "Main reasoning model configured. FRIDAY will perform the verified runtime handoff after this reply."
            : "Main reasoning model configured. Restart FRIDAY to use it for new reasoning turns.",
        };
      },
    });

    ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
      id: "runtime.settings.update",
      label: "Update runtime settings",
      description: "Change typed non-secret main/routing model, permission defaults, wall-clock timezone, or the canonical self-improvement source checkout, then safely restart FRIDAY. The main model is optional; routing remains required. Host privilege mode is deliberately local-only.",
      parameters: Object.freeze({
        type: "object",
        properties: {
          modelProvider: { type: "string" },
          modelId: { type: "string" },
          clearMainModel: { type: "boolean" },
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
        const patch = patchFromInput(input);
        const previousOnboarding = await service.onboarding();
        const updated = await service.update(patch, {
          restart,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(restart ? { beforeRestart: () => confirmRestartWithActiveWork(context, "Runtime settings update") } : {}),
          afterReply: context.deferAfterReply,
          onFailure: context.deferOnFailure,
        });
        const touched: OnboardingStepId[] = [];
        if (patch.modelProvider !== undefined || patch.modelId !== undefined) touched.push("mainModel");
        if (patch.permissionMode !== undefined) touched.push("permissions");
        if (patch.timezone !== undefined) touched.push("timezone");
        if (patch.selfRepository !== undefined) touched.push("selfRepository");
        for (const step of touched) {
          await service.markOnboardingStep(step, step === "mainModel" && !updated.modelProvider ? "pending" : "complete");
        }
        if (previousOnboarding && touched.length > 0 && context.deferOnFailure) {
          context.deferOnFailure(async () => {
            for (const step of touched) await service.markOnboardingStep(step, previousOnboarding.steps[step]);
          });
        }
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
          modelRegistry.registerModel(toCustomModelDescriptor(configured) as never, { replace: true });

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
            if (useFor === "main") await service.markOnboardingStep("mainModel", "complete");
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
              modelRegistry.registerModel(toCustomModelDescriptor(existing) as never, { replace: true });
            } else {
              try {
                await removeCustomModel(provider, modelId, home);
              } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "Custom-model setup failed and persisted-model rollback also failed");
              }
              modelRegistry.unregisterModel(provider, modelId);
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
        if (removed) modelRegistry.unregisterModel(provider, modelId);
        return { removed, provider, modelId };
      },
    });
  });
}

export default createRuntimeSettingsPlugin();
