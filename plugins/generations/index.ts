import * as generations from "@friday/generations";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EXECUTION_CAPABILITY } from "../execution/contract.js";
import { GENERATIONS_CAPABILITY, type GenerationsService } from "./contract.js";

const generationsPlugin: FridayPlugin = definePlugin({ id: "generations", requires: [EXECUTION_CAPABILITY], provides: [GENERATIONS_CAPABILITY] }, (ctx) => {
  const execution = ctx.services.require(EXECUTION_CAPABILITY);

  generations.installExecutionAccess({
    async runProcess(command, args, options) {
      options.signal?.throwIfAborted();
      try {
        const result = await execution.execCommand(command, args, options.cwd, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        });
        options.signal?.throwIfAborted();
        return {
          status: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          killed: result.killed,
        };
      } catch (error) {
        options.signal?.throwIfAborted();
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  });

  const service: GenerationsService = Object.freeze({ createGenerationsManager: generations.createGenerationsManager });
  ctx.services.provide(GENERATIONS_CAPABILITY, service);
});

export default generationsPlugin;
