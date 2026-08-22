import * as evaluation from "@friday/evaluation";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import { EVALUATION_CAPABILITY, type EvaluationService } from "./contract.js";

function boundedAppend(current: string, chunk: string, maxChars: number): { text: string; truncated: boolean } {
  const remaining = Math.max(0, maxChars - current.length);
  return {
    text: current + chunk.slice(0, remaining),
    truncated: chunk.length > remaining,
  };
}

const evaluationPlugin: FridayPlugin = definePlugin({ id: "evaluation", requires: [EXECUTION_CAPABILITY, SANDBOX_CAPABILITY], provides: [EVALUATION_CAPABILITY] }, (ctx) => {
  const execution = ctx.services.require(EXECUTION_CAPABILITY);
  const sandbox = ctx.services.require(SANDBOX_CAPABILITY);
  const shell = execution.api.createLocalShellOperations();

  evaluation.installExecutionAccess({
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
            access: "write",
            network: options.network === true,
            env: { ...process.env, ...(options.env ?? {}) },
          });
          const result = await shell.exec(context.command, context.cwd, {
            onData(data) {
              const next = boundedAppend(stdout, data.toString("utf8"), maxChars);
              stdout = next.text;
              outputTruncated ||= next.truncated;
            },
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs / 1000 }),
            env: context.env,
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

      const result = await execution.api.execCommand(command, args, cwd, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
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

  const service: EvaluationService = Object.freeze({ api: evaluation });
  ctx.services.provide(EVALUATION_CAPABILITY, service);
});

export default evaluationPlugin;
