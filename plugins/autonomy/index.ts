import * as autonomy from "@friday/autonomy";
import type { FridayPlugin } from "../../src/plugin.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVALUATION_CAPABILITY } from "../evaluation/contract.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import {
  AUTONOMY_CAPABILITY,
  type AutonomousRunOptions,
  type AutonomyService,
} from "./contract.js";
import { runAutonomousObjective } from "./runner.js";
import { AGENT_CAPABILITY } from "../agent/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PROMPTS_CAPABILITY } from "../prompts/contract.js";
import { SESSION_RESOURCES_CAPABILITY } from "../session-resources/contract.js";
import { SESSIONS_CAPABILITY } from "../sessions/contract.js";
import { TOOLS_CAPABILITY } from "../tools/contract.js";

function systemString(
  input: Readonly<SystemJsonObject>,
  name: string,
  options: { readonly required?: boolean; readonly maximum?: number } = {},
): string | undefined {
  const value = input[name];
  if (value === undefined && options.required !== true) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized) {
    if (options.required === true) throw new Error(`${name} must not be empty`);
    return undefined;
  }
  const maximum = options.maximum ?? 16_000;
  if (normalized.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return normalized;
}

function systemPositiveInteger(input: Readonly<SystemJsonObject>, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function systemGates(input: Readonly<SystemJsonObject>): readonly { id: string; command: string }[] | undefined {
  const value = input.gates;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("gates must be an array of command strings");
  if (value.length > 32) throw new Error("gates may contain at most 32 commands");
  return Object.freeze(value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`gates[${index}] must be a non-empty string`);
    if (entry.length > 4_096) throw new Error(`gates[${index}] exceeds 4096 characters`);
    return Object.freeze({ id: `gate-${index + 1}`, command: entry.trim() });
  }));
}

function boundedAppend(current: string, chunk: string, maxChars: number): { text: string; truncated: boolean } {
  const remaining = Math.max(0, maxChars - current.length);
  return {
    text: current + chunk.slice(0, remaining),
    truncated: chunk.length > remaining,
  };
}

const autonomyPlugin: FridayPlugin = definePlugin({ id: "autonomy", requires: [AGENT_CAPABILITY, EVALUATION_CAPABILITY, EXECUTION_CAPABILITY, MODEL_CAPABILITY, PERMISSIONS_CAPABILITY, PROMPTS_CAPABILITY, SANDBOX_CAPABILITY, SESSION_RESOURCES_CAPABILITY, SESSIONS_CAPABILITY, TOOLS_CAPABILITY], optional: [MODEL_CREDENTIALS_CAPABILITY], provides: [AUTONOMY_CAPABILITY] }, (bootstrap) => {
  const agent = bootstrap.services.require(AGENT_CAPABILITY);
  const evaluation = bootstrap.services.require(EVALUATION_CAPABILITY);
  const execution = bootstrap.services.require(EXECUTION_CAPABILITY);
  const model = bootstrap.services.require(MODEL_CAPABILITY);
  const permissions = bootstrap.services.require(PERMISSIONS_CAPABILITY);
  const prompts = bootstrap.services.require(PROMPTS_CAPABILITY);
  const sandbox = bootstrap.services.require(SANDBOX_CAPABILITY);
  const sessionResources = bootstrap.services.require(SESSION_RESOURCES_CAPABILITY);
  const sessions = bootstrap.services.require(SESSIONS_CAPABILITY);
  const tools = bootstrap.services.require(TOOLS_CAPABILITY);
  const shell = execution.api.createLocalShellOperations();

  autonomy.installEvaluationAccess({
    async evaluateCommand(command, options = {}) {
      const result = await evaluation.api.runCommandEvaluation(
        {
          command,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }),
        },
        options.signal,
      );
      return {
        passed: result.status === "pass",
        exitText: result.exitText,
        output: result.output,
        outputTruncated: result.outputTruncated,
      };
    },
  });

  autonomy.installExecutionAccess({
    async runProcess(command, args, options = {}) {
      options.signal?.throwIfAborted();
      const maxChars = options.maxOutputChars ?? 1024 * 1024;
      const cwd = options.cwd ?? process.cwd();

      if (options.shell === true) {
        let stdout = "";
        let outputTruncated = false;
        try {
          const shellCommand = args.length > 0 ? [command, ...args].join(" ") : command;
          const context = sandbox.sandboxShell({
            command: shellCommand,
            cwd,
            workspace: cwd,
            access: "read",
            network: sandbox.networkMode === "unrestricted",
            env: process.env,
          });
          const result = await shell.exec(context.command, context.cwd, {
            onData(data) {
              const next = boundedAppend(stdout, data.toString("utf8"), maxChars);
              stdout = next.text;
              outputTruncated ||= next.truncated;
            },
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs / 1000 }),
          });
          options.signal?.throwIfAborted();
          return {
            status: result.exitCode,
            signal: null,
            stdout,
            stderr: "",
            outputTruncated,
          };
        } catch (error) {
          options.signal?.throwIfAborted();
          const normalized = error instanceof Error ? error : new Error(String(error));
          const timedOut = normalized.message.startsWith("timeout:");
          return {
            status: null,
            signal: null,
            stdout,
            stderr: "",
            ...(timedOut ? { timedOut: true } : { error: normalized }),
            outputTruncated,
          };
        }
      }

      const context = sandbox.sandboxProcess({
        command,
        args,
        cwd,
        workspace: cwd,
        access: "read",
        network: sandbox.networkMode === "unrestricted",
        env: process.env,
      });
      const result = await execution.api.execCommand(context.command, context.args, context.cwd, {
        env: context.env,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      });
      options.signal?.throwIfAborted();
      const stdout = result.stdout.slice(0, maxChars);
      const stderr = result.stderr.slice(0, maxChars);
      const timedOut = result.killed && !options.signal?.aborted;
      return {
        status: result.code,
        signal: null,
        stdout,
        stderr,
        ...(timedOut ? { timedOut: true } : {}),
        outputTruncated: result.stdout.length > maxChars || result.stderr.length > maxChars,
      };
    },
  });

  const service: AutonomyService = Object.freeze({
    api: autonomy,
    runObjective(options: AutonomousRunOptions) {
      return runAutonomousObjective(
        autonomy,
        { agent, model, prompts, sessionResources, sessions, tools, credentials: () => bootstrap.services.optional(MODEL_CREDENTIALS_CAPABILITY) },
        options,
      );
    },
  });
  bootstrap.services.provide(AUTONOMY_CAPABILITY, service);

  bootstrap.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "autonomy.run",
    label: "Run autonomous objective",
    description: "Run a bounded autonomous FRIDAY objective with optional evaluation gates.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        objective: { type: "string" },
        cwd: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        gates: { type: "array", items: { type: "string" }, maxItems: 32 },
        maxContinuations: { type: "integer", minimum: 1 },
        maxTurns: { type: "integer", minimum: 1 },
        maxTokens: { type: "integer", minimum: 1 },
        timeoutMs: { type: "integer", minimum: 1 },
        permissionMode: { type: "string", enum: ["ask", "auto", "full"] },
      },
      required: ["objective"],
      additionalProperties: false,
    }),
    permission() {
      return { id: "autonomy.run", effect: "system-write", resource: "autonomy", network: sandbox.networkMode === "unrestricted" };
    },
    async execute(input) {
      const objective = systemString(input, "objective", { required: true })!;
      const cwd = systemString(input, "cwd", { maximum: 4_096 }) ?? process.cwd();
      const provider = systemString(input, "provider") ?? process.env.FRIDAY_MODEL_PROVIDER?.trim();
      const modelId = systemString(input, "model") ?? process.env.FRIDAY_MODEL_ID?.trim();
      if (!provider || !modelId) throw new Error("autonomy.run requires configured model provider and model id");
      const permissionMode = permissions.normalizeMode(
        systemString(input, "permissionMode", { maximum: 16 }) ?? process.env.FRIDAY_PERMISSION_MODE,
      );
      const gates = systemGates(input);
      const maxContinuations = systemPositiveInteger(input, "maxContinuations");
      const maxTurns = systemPositiveInteger(input, "maxTurns");
      const maxTokens = systemPositiveInteger(input, "maxTokens");
      const timeoutMs = systemPositiveInteger(input, "timeoutMs");
      return service.runObjective({
        objective,
        cwd,
        provider,
        model: modelId,
        permissionMode,
        ...(gates === undefined ? {} : { gates }),
        ...(maxContinuations === undefined ? {} : { maxContinuations }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
  });
});

export default autonomyPlugin;
