import { resolve } from "node:path";
import * as selfImprovement from "@friday/self-improvement";
import type { FridayPlugin } from "../../src/plugin.js";
import { AGENT_TOOL_CONTRIBUTION, type AgentExtensionJsonValue } from "../turn-loop/contract.js";
import { definePlugin, type PluginContext } from "../capabilities/protocol.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { ARTIFACTS_CAPABILITY } from "../artifacts/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../channels/trusted-contract.js";
import { EVALUATION_CAPABILITY } from "../evaluation/contract.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { GENERATIONS_CAPABILITY } from "../generations/contract.js";
import { lifecycleHandoff, LIFECYCLE_CAPABILITY } from "../lifecycle/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { WORKTREES_CAPABILITY } from "../worktrees/contract.js";
import {
  SELF_IMPROVEMENT_CAPABILITY,
  type SelfImproveRunOptions,
  type SelfImprovementContinuation,
  type SelfImprovementFeasibility,
  type SelfImprovementService,
} from "./contract.js";
import { createSelfImprovementRunner, getSelfImprovementMissionDir, getSelfImprovementStateRoot } from "./runner.js";

const SUCCESSOR_TAKEOVER_TIMEOUT_MS = 30 * 60_000;
import { SelfImprovementMissionStore } from "./mission-state.js";
import { AUTONOMY_CAPABILITY } from "../autonomy/contract.js";
import { SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import { TURN_INGRESS_HOOK, type TurnAttachment } from "../turn-loop/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_ACTIVE_WORK_CONTRIBUTION,
  summarizeSystemActiveWork,
  type SystemJsonObject,
} from "../system/contract.js";

interface StartupArgs {
  readonly stateDir?: string | undefined;
  readonly permissionMode?: string | undefined;
  readonly resumeGeneration?: string | undefined;
  readonly rollbackRecovered?: string | undefined;
}

function startupArgs(args: readonly string[]): StartupArgs {
  const values = new Map<string, string>();
  const allowed = new Set(["state-dir", "permission", "resume-generation", "rollback-recovered"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (!allowed.has(name)) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    values.set(name, value);
    index += 1;
  }
  return Object.freeze({
    stateDir: values.get("state-dir"),
    permissionMode: values.get("permission"),
    resumeGeneration: values.get("resume-generation"),
    rollbackRecovered: values.get("rollback-recovered"),
  });
}


function configuredSelfRepository(): string {
  const configured = process.env.FRIDAY_SELF_REPOSITORY?.trim();
  if (configured) return resolve(configured);
  throw new Error("Self-improvement source repository is not configured. Run `friday setup self-repository <path>` or set FRIDAY_SELF_REPOSITORY.");
}

function systemString(
  input: Readonly<SystemJsonObject>,
  name: string,
  options: { required?: boolean; maximum?: number } = {},
): string | undefined {
  const value = input[name];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  const maximum = options.maximum ?? 512;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemPositiveInteger(input: Readonly<SystemJsonObject>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function systemGates(input: Readonly<SystemJsonObject>): readonly { id: string; command: string }[] | undefined {
  const value = input.gates;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error("gates must be an array with at most 32 commands");
  return Object.freeze(value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`gates[${index}] must be a string`);
    const command = entry.trim();
    if (!command) throw new Error(`gates[${index}] must not be empty`);
    if (command.length > 4_096) throw new Error(`gates[${index}] exceeds 4096 characters`);
    return Object.freeze({ id: `gate-${index + 1}`, command });
  }));
}

async function confirmRestartWithActiveWork(
  ctx: PluginContext,
  turn: import("../turn-loop/contract.js").InboundTurn,
  currentJobId: string | undefined,
  reason: string,
): Promise<void> {
  const active = summarizeSystemActiveWork(ctx.collect(SYSTEM_ACTIVE_WORK_CONTRIBUTION), {
    ...(currentJobId === undefined ? {} : { excludeJobId: currentJobId }),
    excludeForegroundTurns: currentJobId === undefined ? 1 : 0,
  });
  if (active.backgroundSessions === 0 && active.foregroundTurns === 0) return;
  const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
  if (!channels) {
    throw new Error(`Restart blocked because ${active.backgroundSessions} other background session(s) and ${active.foregroundTurns} other foreground turn(s) are active and the trusted channel approval service is unavailable.`);
  }
  const approved = await channels.requestApproval({
    principal: turn.principal,
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

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const forward = () => target.abort(source.reason ?? new Error("Operation cancelled"));
  if (source.aborted) forward();
  else source.addEventListener("abort", forward, { once: true });
  return () => source.removeEventListener("abort", forward);
}


const selfImprovementPlugin: FridayPlugin = definePlugin({
  id: "self-improvement",
  requires: [
    AUTONOMY_CAPABILITY,
    EVALUATION_CAPABILITY,
    EXECUTION_CAPABILITY,
    GENERATIONS_CAPABILITY,
    LIFECYCLE_CAPABILITY,
    MODEL_CAPABILITY,
    PERMISSIONS_CAPABILITY,
    SANDBOX_CAPABILITY,
    WORKTREES_CAPABILITY,
  ],
  optional: [ARTIFACTS_CAPABILITY, CHANNELS_TRUSTED_CAPABILITY, MODEL_CREDENTIALS_CAPABILITY],
  provides: [SELF_IMPROVEMENT_CAPABILITY],
  activation: "last",
}, async (ctx) => {
  const autonomy = ctx.services.require(AUTONOMY_CAPABILITY);
  const evaluation = ctx.services.require(EVALUATION_CAPABILITY);
  const execution = ctx.services.require(EXECUTION_CAPABILITY);
  const generations = ctx.services.require(GENERATIONS_CAPABILITY);
  const lifecycle = ctx.services.require(LIFECYCLE_CAPABILITY);
  const handoffCoordinator = lifecycleHandoff(lifecycle);
  const modelService = ctx.services.require(MODEL_CAPABILITY);
  const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
  const sandbox = ctx.services.require(SANDBOX_CAPABILITY);
  const worktrees = ctx.services.require(WORKTREES_CAPABILITY);

  selfImprovement.installWorktreesAccess({
    createWorktree(options) {
      return worktrees.api.createWorktree(options);
    },
    inspectWorktree(options) {
      return worktrees.api.inspectWorktree(options);
    },
    removeWorktree(options) {
      return worktrees.api.removeWorktree(options);
    },
  });

  selfImprovement.installGenerationsAccess({
    openManager(options) {
      const manager = generations.api.createGenerationsManager(options);
      return {
        getActiveGeneration() {
          return manager.getActiveGeneration();
        },
        checkpointCurrent(checkpointOptions) {
          return manager.checkpointCurrent(checkpointOptions);
        },
        activateDescendant(activationOptions) {
          return manager.activateDescendant(activationOptions);
        },
        planRollback(rollbackOptions) {
          return manager.planRollback(rollbackOptions);
        },
        executeRollback(rollbackOptions) {
          return manager.executeRollback(rollbackOptions);
        },
      };
    },
  });

  selfImprovement.installEvaluationAccess({
    async runCommandEvaluationSuite(specs, signal) {
      return evaluation.api.runCommandEvaluationSuite(
        specs.map((spec) => ({
          ...(spec.id === undefined ? {} : { id: spec.id }),
          command: spec.command,
          cwd: spec.cwd,
          ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
          ...(spec.maxOutputChars === undefined ? {} : { maxOutputChars: spec.maxOutputChars }),
        })),
        signal,
      );
    },
  });

  const runner = createSelfImprovementRunner(selfImprovement, {
    autonomy,
    evaluation,
    execution,
    generations,
    lifecycle,
    sandbox,
    worktrees,
  });
  async function assessFeasibility(options: SelfImproveRunOptions): Promise<SelfImprovementFeasibility> {
    const repository = resolve(options.cwd);
    try {
      sandbox.assertAvailable();
      const primary = await worktrees.api.inspectWorktree({ repository, directory: repository });
      if (!primary.clean) {
        return Object.freeze({ feasible: false, reason: "The primary checkout is dirty; self-improvement will not modify a dirty baseline.", objective: options.objective });
      }
      const model = modelService.api.getModel(options.provider as never, options.model as never);
      if (!model) {
        return Object.freeze({ feasible: false, reason: `The configured implementation model ${options.provider}/${options.model} is not installed.`, objective: options.objective });
      }
      const credential = await ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY)?.getApiKey(options.provider);
      const response = await modelService.api.completeSimple(
        model as never,
        {
          systemPrompt: [
            "You are FRIDAY's software capability feasibility reviewer.",
            "Decide whether the requested capability is realistically implementable by editing and testing the current FRIDAY repository with its existing sandbox/worktree/self-improvement machinery.",
            "Return one JSON object only: {feasible:boolean, reason:string, objective:string}.",
            "Do not claim feasibility if the request fundamentally requires unavailable hardware, inaccessible private systems, or an impossible external guarantee.",
            "If it is an ordinary software feature that can be implemented locally, mark it feasible and turn it into a concise implementation objective.",
          ].join("\n"),
          messages: [{ role: "user", content: JSON.stringify({ requestedCapability: options.objective, repository }), timestamp: Date.now() }],
        },
        { temperature: 0, maxTokens: 256, ...(credential ? { apiKey: credential } : {}) },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return Object.freeze({ feasible: false, reason: `Feasibility analysis could not run: ${response.errorMessage || response.stopReason}`, objective: options.objective });
      }
      const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
      const parsed = modelService.api.parseJsonWithRepair<Record<string, unknown>>(text);
      const feasible = parsed.feasible === true;
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 2_000) : (feasible ? "The requested capability can be implemented in the current repository." : "The requested capability is not feasible with the current environment.");
      const objective = typeof parsed.objective === "string" && parsed.objective.trim() ? parsed.objective.trim().slice(0, 8_192) : options.objective;
      return Object.freeze({ feasible, reason, objective });
    } catch (error) {
      return Object.freeze({ feasible: false, reason: error instanceof Error ? error.message : String(error), objective: options.objective });
    }
  }

  let activeRun: { controller: AbortController; objective: string; startedAt: string; detach?: (() => void) | undefined } | undefined;

  async function runSelfImprove(options: SelfImproveRunOptions) {
    if (activeRun) throw new Error(`Self-improvement is already running: ${activeRun.objective}`);
    const controller = new AbortController();
    let detach: (() => void) | undefined;
    if (options.signal) {
      const forward = () => controller.abort(options.signal?.reason ?? new Error("Self-improvement cancelled"));
      if (options.signal.aborted) forward();
      else {
        options.signal.addEventListener("abort", forward, { once: true });
        detach = () => options.signal?.removeEventListener("abort", forward);
      }
    }
    activeRun = { controller, objective: options.objective, startedAt: new Date().toISOString(), ...(detach ? { detach } : {}) };
    try {
      const result = await runner.selfImprove({ ...options, signal: controller.signal });
      if (!options.deferHandoff) {
        await runner.finalizeHandoff(result, {
          ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
          ...(options.takeoverTimeoutMs === undefined ? {} : { takeoverTimeoutMs: options.takeoverTimeoutMs }),
          signal: controller.signal,
        });
      }
      return result;
    } finally {
      activeRun?.detach?.();
      activeRun = undefined;
    }
  }

  const service: SelfImprovementService = Object.freeze({
    api: selfImprovement,
    ...runner,
    selfImprove: runSelfImprove,
    assessFeasibility,
    async ensureCapability(options: SelfImproveRunOptions, hooks: Parameters<SelfImprovementService["ensureCapability"]>[1]) {
      const feasibility = await assessFeasibility(options);
      if (!feasibility.feasible) return Object.freeze({ feasibility });
      await hooks.onFeasible(feasibility);
      await hooks.authorize(feasibility);
      const result = await runSelfImprove({ ...options, objective: feasibility.objective });
      return Object.freeze({ feasibility, result });
    },
    activeRun: () => activeRun ? Object.freeze({ objective: activeRun.objective, startedAt: activeRun.startedAt }) : undefined,
    cancelActive(reason = "Self-improvement cancelled by operator") {
      if (!activeRun) return false;
      activeRun.controller.abort(new Error(reason));
      return true;
    },
    missions(stateDir?: string) {
      const root = getSelfImprovementStateRoot(stateDir);
      return Object.freeze(new SelfImprovementMissionStore(getSelfImprovementMissionDir(root)).list().map((mission) => Object.freeze({
        id: mission.id,
        objective: mission.objective,
        status: mission.status,
        candidateId: mission.candidateId,
        generationId: mission.targetGenerationId,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
        ...(mission.lastError ? { lastError: mission.lastError } : {}),
      })));
    },
  });
  ctx.services.provide(SELF_IMPROVEMENT_CAPABILITY, service);

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "self-improvement.run",
    label: "Run self-improvement",
    description: "Create, evaluate, promote, and hand off a bounded self-improvement candidate.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        objective: { type: "string" },
        repository: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        gates: { type: "array", items: { type: "string" }, maxItems: 32 },
        stateDir: { type: "string" },
        worktreeRoot: { type: "string" },
        maxContinuations: { type: "integer", minimum: 1 },
        maxTurns: { type: "integer", minimum: 1 },
        maxTokens: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 1 },
        restartTimeoutMs: { type: "integer", minimum: 1 },
        takeoverTimeoutMs: { type: "integer", minimum: 1 },
        permissionMode: { type: "string", enum: ["ask", "auto", "full"] },
      },
      required: ["objective"],
      additionalProperties: false,
    }),
    permission() {
      return {
        id: "self-improvement.run",
        effect: "system-write",
        resource: "self-improvement",
        network: true,
      };
    },
    async execute(input, context) {
      const objective = systemString(input, "objective", { required: true, maximum: 8_192 })!;
      const repository = systemString(input, "repository", { maximum: 4_096 }) ?? configuredSelfRepository();
      const provider = systemString(input, "provider") ?? process.env.FRIDAY_MODEL_PROVIDER?.trim();
      const model = systemString(input, "model") ?? process.env.FRIDAY_MODEL_ID?.trim();
      if (!provider || !model) throw new Error("self-improvement.run requires configured model provider and model id");
      const permissionMode = permissions.normalizeMode(
        systemString(input, "permissionMode", { maximum: 16 }) ?? process.env.FRIDAY_PERMISSION_MODE,
      );
      const stateDir = systemString(input, "stateDir", { maximum: 4_096 });
      const worktreeRoot = systemString(input, "worktreeRoot", { maximum: 4_096 });
      const gates = systemGates(input);
      const maxContinuations = systemPositiveInteger(input, "maxContinuations");
      const maxTurns = systemPositiveInteger(input, "maxTurns");
      const maxTokens = systemPositiveInteger(input, "maxTokens");
      const timeoutMs = systemPositiveInteger(input, "timeoutMs");
      const restartTimeoutMs = systemPositiveInteger(input, "restartTimeoutMs");
      const takeoverTimeoutMs = systemPositiveInteger(input, "takeoverTimeoutMs");
      const operation = new AbortController();
      const detachTurnAbort = forwardAbort(context.signal, operation);
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      const cancellation = context.turn.principal.authority === "channel" && channels
        ? await channels.watchCancellation({
            principal: context.turn.principal,
            label: "self-improvement",
            ttlMs: timeoutMs ?? 60 * 60_000,
          })
        : undefined;
      const detachChannelAbort = forwardAbort(cancellation?.signal, operation);
      try {
        const result = await service.selfImprove({
          objective,
          cwd: repository,
          provider,
          model,
          permissionMode,
          deferHandoff: true,
          signal: operation.signal,
          ...(gates === undefined ? {} : { gates }),
          ...(stateDir === undefined ? {} : { stateDir }),
          ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
          ...(maxContinuations === undefined ? {} : { maxContinuations }),
          ...(maxTurns === undefined ? {} : { maxTurns }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(restartTimeoutMs === undefined ? {} : { restartTimeoutMs }),
          ...(takeoverTimeoutMs === undefined ? {} : { takeoverTimeoutMs }),
        });
        context.deferAfterReply(async () => {
          await service.finalizeHandoff(result, {
            ...(stateDir === undefined ? {} : { stateDir }),
            ...(takeoverTimeoutMs === undefined ? {} : { takeoverTimeoutMs }),
            beforeHandoff: () => confirmRestartWithActiveWork(ctx, context.turn, context.jobId, "Self-improvement handoff"),
          });
          process.kill(process.pid, "SIGTERM");
        });
        return result;
      } finally {
        detachTurnAbort();
        detachChannelAbort();
        cancellation?.dispose();
      }
    },
  });

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    id: "self-improvement-capability-ensure",
    name: "capability_ensure",
    label: "Build a missing FRIDAY capability",
    description: [
      "Use only when the user's original objective is blocked because FRIDAY itself lacks a reusable software capability such as a connector, transport, protocol integration, or host primitive.",
      "Do not use for ordinary coding in the user's repository, one-off scripts, missing project dependencies, or work that existing tools/Skills can perform.",
      "The host feasibility-checks the gap, asks authorization, implements it in an isolated worktree, runs strict deterministic gates, promotes only a verified generation, preserves the original channel request and attachments, restarts FRIDAY, then automatically resumes that original request.",
      "A successful tool result means the prerequisite capability is ready for verified takeover; it does not mean the user's original objective is finished.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        feature: { type: "string", description: "Stable reusable capability name, e.g. github-private-repositories" },
        implementationObjective: { type: "string", description: "Concrete implementation objective for FRIDAY itself, including required auth/config/tool surface and tests" },
      },
      required: ["feature", "implementationObjective"],
      additionalProperties: false,
    },
    async execute(input, signal, agentContext) {
      if (!agentContext?.turn) throw new Error("capability_ensure requires an originating user turn");
      if (agentContext.turn.principal.authority !== "channel") throw new Error("capability_ensure only supports durable channel-originated requests");
      const feature = systemString(input as Readonly<SystemJsonObject>, "feature", { required: true, maximum: 240 })!;
      const requestedImplementationObjective = systemString({ objective: input.implementationObjective } as Readonly<SystemJsonObject>, "objective", { required: true, maximum: 8_192 })!;
      const implementationObjective = [
        `Build the missing reusable FRIDAY capability: ${feature}.`,
        requestedImplementationObjective,
        "Implementation requirements: keep the feature plugin-owned and expose explicit capability/contribution boundaries rather than hidden src/ domain logic; add deterministic feature, failure, security, unconfigured-startup, and lifecycle-cleanup tests; preserve existing architecture boundaries; never weaken unrelated tests or gates; use trusted credential/Vault/OAuth flows for secrets and user authorization; the new plugin must activate safely without credentials and expose an explicit unconfigured/auth-required state so OAuth, pairing, or credential capture can happen only after the verified successor is running; make configuration/status discoverable through the appropriate plugin surface; and ensure the resulting capability can be used by the original resumed channel request after verified restart.",
      ].join("\n\n");
      const repository = configuredSelfRepository();
      const provider = process.env.FRIDAY_MODEL_PROVIDER?.trim();
      const model = process.env.FRIDAY_MODEL_ID?.trim();
      if (!provider || !model) throw new Error("Capability feasibility analysis requires a configured main model");
      const permissionMode = permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE);
      const operation = new AbortController();
      const detachSignal = forwardAbort(signal, operation);
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) throw new Error("capability_ensure requires trusted Channels support so the original request can resume after restart");
      const artifacts = ctx.services.optional(ARTIFACTS_CAPABILITY);
      const persisted: TurnAttachment[] = [];
      for (const attachment of agentContext.turn.attachments ?? []) {
        if (attachment.artifactRef) {
          persisted.push(attachment as TurnAttachment);
          continue;
        }
        if (!artifacts) throw new Error("Artifacts support is required to resume a capability-building request containing attachments");
        const record = await artifacts.ingestChannelAttachment(agentContext.turn.principal, attachment);
        persisted.push(Object.freeze({
          kind: attachment.kind,
          externalId: attachment.externalId,
          ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
          fileName: record.fileName,
          sizeBytes: record.sizeBytes,
          artifactRef: record.ref,
        }));
      }
      const continuation: SelfImprovementContinuation = Object.freeze({
        id: `self-improvement-resume:${agentContext.turn.id}`,
        principal: agentContext.turn.principal,
        text: agentContext.turn.text,
        destinationId: `session:${agentContext.sessionId}`,
        timestamp: Date.now(),
        ...(persisted.length === 0 ? {} : { attachments: Object.freeze(persisted) }),
      });
      let cancellation: { readonly signal: AbortSignal; dispose(): void } | undefined;
      let detachChannelAbort: () => void = () => undefined;
      try {
        const ensured = await service.ensureCapability({
          objective: implementationObjective,
          cwd: repository,
          provider,
          model,
          permissionMode,
          signal: operation.signal,
          deferHandoff: true,
          continuation,
        }, {
          async onFeasible(feasibility) {
            await agentContext.turn!.reply(`FRIDAY is missing ${feature}. I verified that I can add it safely, so I can build the prerequisite and then resume your original request.\n\n${feasibility.reason}`);
          },
          async authorize() {
            await permissions.authorize({
              mode: permissionMode,
              workspace: repository,
              access: "write",
              action: { id: "self-improvement.ensure-capability", effect: "system-write", resource: `capability:${feature}`, network: true },
              reason: `build missing reusable FRIDAY capability: ${feature}`,
            });
            const handle = await channels.watchCancellation({ principal: agentContext.turn!.principal, label: `building ${feature}` });
            cancellation = handle;
            detachChannelAbort = forwardAbort(handle.signal, operation);
          },
        });
        if (!ensured.result) {
          return { output: { feasible: false, feature, reason: ensured.feasibility.reason } as unknown as AgentExtensionJsonValue, isError: true };
        }
        agentContext.deferAfterReply(async () => {
          await service.finalizeHandoff(ensured.result!, {
            beforeHandoff: () => confirmRestartWithActiveWork(ctx, agentContext.turn!, agentContext.jobId, `Installing ${feature}`),
          });
          process.kill(process.pid, "SIGTERM");
        });
        return {
          output: {
            feasible: true,
            feature,
            generationId: ensured.result.generationId,
            message: "The capability passed strict evaluation and the verified successor is ready. After this reply, FRIDAY will hand off and automatically resume the original user request with its attachments.",
          } as unknown as AgentExtensionJsonValue,
        };
      } finally {
        detachSignal();
        detachChannelAbort();
        cancellation?.dispose();
      }
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "self-improvement.ensure-capability",
    label: "Build a missing capability",
    description: "Analyze whether a missing FRIDAY software capability is feasible. Only when feasible, explain that it can be built, request authorization, self-improve, restart, and resume the original channel request.",
    parameters: Object.freeze({
      type: "object",
      properties: { feature: { type: "string" }, objective: { type: "string" }, repository: { type: "string" } },
      required: ["feature", "objective"],
      additionalProperties: false,
    }),
    async execute(input, context) {
      const feature = systemString(input, "feature", { required: true, maximum: 240 })!;
      const requestedObjective = systemString(input, "objective", { required: true, maximum: 8_192 })!;
      const implementationObjective = [
        `Build the missing reusable FRIDAY capability: ${feature}.`,
        requestedObjective,
        "Implementation requirements: keep the feature plugin-owned with explicit boundaries; add deterministic feature/failure/security/unconfigured-startup/lifecycle tests; preserve architecture guards; never weaken unrelated gates; keep secrets in trusted credential/Vault/OAuth paths; activate safely without credentials and expose an unconfigured/auth-required state so authorization happens only after the verified successor is running; and make the capability usable by the resumed original request after verified restart.",
      ].join("\n\n");
      const repository = systemString(input, "repository", { maximum: 4_096 }) ?? configuredSelfRepository();
      const provider = process.env.FRIDAY_MODEL_PROVIDER?.trim();
      const model = process.env.FRIDAY_MODEL_ID?.trim();
      if (!provider || !model) throw new Error("Capability feasibility analysis requires a configured main model");
      const permissionMode = permissions.normalizeMode(process.env.FRIDAY_PERMISSION_MODE);
      const operation = new AbortController();
      const detachTurnAbort = forwardAbort(context.signal, operation);
      const base: SelfImproveRunOptions = { objective: implementationObjective, cwd: repository, provider, model, permissionMode, signal: operation.signal, deferHandoff: true };
      let continuation: SelfImprovementContinuation | undefined;
      let cancellation: { readonly signal: AbortSignal; dispose(): void } | undefined;
      let detachChannelAbort: () => void = () => {};
      if (context.turn.principal.authority === "channel") {
        const artifacts = ctx.services.optional(ARTIFACTS_CAPABILITY);
        const persisted: TurnAttachment[] = [];
        for (const attachment of context.turn.attachments ?? []) {
          if (attachment.artifactRef) {
            persisted.push(attachment);
            continue;
          }
          if (!artifacts) throw new Error("A durable Artifacts capability is required to resume a request containing attachments after self-improvement");
          const record = await artifacts.ingestChannelAttachment(context.turn.principal, attachment);
          persisted.push(Object.freeze({
            kind: attachment.kind,
            externalId: attachment.externalId,
            ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
            fileName: record.fileName,
            sizeBytes: record.sizeBytes,
            artifactRef: record.ref,
          }));
        }
        continuation = Object.freeze({
          id: `self-improvement-resume:${context.turn.id}`,
          principal: context.turn.principal,
          text: context.turn.text,
          ...(context.destinationId === undefined ? {} : { destinationId: context.destinationId }),
          timestamp: Date.now(),
          ...(persisted.length === 0 ? {} : { attachments: Object.freeze(persisted) }),
        });
      }

      try {
        const ensured = await service.ensureCapability({ ...base, ...(continuation === undefined ? {} : { continuation }) }, {
          async onFeasible(feasibility) {
            await context.turn.reply(`${feature} is not available yet. I checked feasibility and can build it safely, then resume the original request.\n\n${feasibility.reason}`);
          },
          async authorize() {
            await permissions.authorize({
              mode: permissionMode,
              workspace: repository,
              access: "write",
              action: { id: "self-improvement.ensure-capability", effect: "system-write", resource: `capability:${feature}`, network: true },
              reason: `build missing capability: ${feature}`,
            });
            const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
            if (context.turn.principal.authority === "channel" && channels) {
              const handle = await channels.watchCancellation({ principal: context.turn.principal, label: `building ${feature}` });
              cancellation = handle;
              detachChannelAbort = forwardAbort(handle.signal, operation);
            }
          },
        });
        if (!ensured.result) return { feasible: false, feature, reason: ensured.feasibility.reason };
        context.deferAfterReply(async () => {
          await service.finalizeHandoff(ensured.result!, {
            beforeHandoff: () => confirmRestartWithActiveWork(ctx, context.turn, context.jobId, `Installing ${feature}`),
          });
          process.kill(process.pid, "SIGTERM");
        });
        return { feasible: true, feature, reason: ensured.feasibility.reason, generationId: ensured.result.generationId, message: `${feature} was implemented and the verified successor is ready. The original request will resume automatically after this reply.` };
      } finally {
        detachTurnAbort();
        detachChannelAbort();
        cancellation?.dispose();
      }
    },
  });


  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "self-improvement.status",
    label: "Self-improvement status",
    description: "Show the active self-improvement operation and the latest durable mission records.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    execute() {
      return { active: service.activeRun() ?? null, missions: service.missions().slice(0, 10) };
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "self-improvement.history",
    label: "Self-improvement history",
    description: "Show bounded durable self-improvement mission history. Defaults to the latest 10 missions.",
    parameters: Object.freeze({
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    }),
    execute(input) {
      const limit = systemPositiveInteger(input, "limit") ?? 10;
      if (limit > 100) throw new Error("limit must be <= 100");
      return service.missions().slice(0, limit);
    },
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "self-improvement.cancel",
    label: "Cancel self-improvement",
    description: "Cancel the currently running self-improvement operation. Same-channel users may also use the protected cancel code shown while it runs.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "self-improvement.cancel", effect: "system-write", resource: "self-improvement", network: false };
    },
    execute() {
      const active = service.activeRun();
      if (!active) return { cancelled: false, message: "No self-improvement operation is currently running." };
      return { cancelled: service.cancelActive(), objective: active.objective };
    },
  });

  // This plugin declares last-stage activation in its manifest. The restart flags
  // below are private process-handoff metadata, not operator commands. A successor
  // validates its durable mission only after the normal plugin graph is ready.
  const startup = startupArgs(process.argv.slice(2));
  if (startup.stateDir) process.env.FRIDAY_STATE_DIR = resolve(startup.stateDir);
  const startupPermissionMode = permissions.normalizeMode(
    startup.permissionMode ?? process.env.FRIDAY_PERMISSION_MODE,
  );
  process.env.FRIDAY_PERMISSION_MODE = startupPermissionMode;
  if (startup.resumeGeneration) {
    await service.preflightGenerationResume(startup.resumeGeneration, startup.stateDir);
  }
  if (startup.rollbackRecovered) {
    await service.preflightRollbackRecovery(startup.rollbackRecovered, startup.stateDir);
  }
  ctx.afterReady(async () => {
    if (!startup.resumeGeneration && !startup.rollbackRecovered) return;
    lifecycle.api.acknowledgeRestartFromEnvironment();
    try {
      await lifecycle.api.waitForTakeoverReleaseFromEnvironment({ timeoutMs: SUCCESSOR_TAKEOVER_TIMEOUT_MS });
      let continuation: SelfImprovementContinuation | undefined;
      if (startup.resumeGeneration) {
        continuation = await service.resumeGeneration(startup.resumeGeneration);
      } else if (startup.rollbackRecovered) {
        await service.reportRollbackRecovery(startup.rollbackRecovered);
      }
      await handoffCoordinator.activate();
      lifecycle.api.acknowledgeTakeoverFromEnvironment();

      if (!continuation) return;
      const channels = ctx.services.optional(CHANNELS_TRUSTED_CAPABILITY);
      if (!channels) return;
      try {
        await ctx.emit(TURN_INGRESS_HOOK, Object.freeze({
          id: continuation.id,
          principal: continuation.principal,
          text: continuation.text,
          ...(continuation.attachments === undefined ? {} : { attachments: continuation.attachments }),
          ...(continuation.destinationId === undefined ? {} : { resumeDestinationId: continuation.destinationId }),
          timestamp: continuation.timestamp,
          reply: async (text: string) => {
            await channels.send({
              channel: continuation.principal.channel,
              accountId: continuation.principal.accountId,
              conversationId: continuation.principal.conversationId,
              ...(continuation.principal.threadId === undefined ? {} : { threadId: continuation.principal.threadId }),
            }, text);
          },
        }));
      } catch (error) {
        await channels.send({
          channel: continuation.principal.channel,
          accountId: continuation.principal.accountId,
          conversationId: continuation.principal.conversationId,
          ...(continuation.principal.threadId === undefined ? {} : { threadId: continuation.principal.threadId }),
        }, `The new capability is ready, but I could not automatically resume the original request: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        await handoffCoordinator.quiesce();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        lifecycle.api.rejectTakeoverFromEnvironment({ error });
      } catch (rejectionError) {
        errors.push(rejectionError);
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Self-improvement successor failed and cleanup was incomplete");
      }
      throw error;
    }
  });
});

export default selfImprovementPlugin;
