import * as rlm from "@friday/rlm";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SUBAGENTS_CAPABILITY } from "../subagents/contract.js";
import { RLM_CAPABILITY, type RlmService } from "./contract.js";

const rlmPlugin: FridayPlugin = definePlugin({ id: "rlm", requires: [SUBAGENTS_CAPABILITY], provides: [RLM_CAPABILITY] }, (ctx) => {
  const subagents = ctx.services.require(SUBAGENTS_CAPABILITY);
  rlm.installSubagentAccess({
    findModelMatches: subagents.findSubagentModelMatches,
  });

  const service: RlmService = Object.freeze({
    createRlmHostHandlers: rlm.createRlmHostHandlers,
    getRlmPythonPath: rlm.getRlmPythonPath,
  });
  ctx.services.provide(RLM_CAPABILITY, service);
});

export default rlmPlugin;
