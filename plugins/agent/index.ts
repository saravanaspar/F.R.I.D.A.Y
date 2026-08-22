import * as agent from "@friday/agent";
import { installModelAccess, type ModelAccess } from "@friday/agent/model-access";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { AGENT_CAPABILITY, type AgentService } from "./contract.js";

/** Exposes the agent subsystem while resolving model services through capabilities. */
const agentPlugin: FridayPlugin = definePlugin({ id: "agent", requires: [MODEL_CAPABILITY], provides: [AGENT_CAPABILITY] }, (ctx) => {
  const model = ctx.services.require(MODEL_CAPABILITY);

  const modelAccess: ModelAccess = {
    streamSimple: model.api.streamSimple as ModelAccess["streamSimple"],
    validateToolArguments: model.api.validateToolArguments as ModelAccess["validateToolArguments"],
    createAssistantMessageDiagnostic:
      model.api.createAssistantMessageDiagnostic as ModelAccess["createAssistantMessageDiagnostic"],
  };
  installModelAccess(modelAccess);

  const service: AgentService = Object.freeze({ api: agent });
  ctx.services.provide(AGENT_CAPABILITY, service);
});

export default agentPlugin;
