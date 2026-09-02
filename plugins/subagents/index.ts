import * as subagents from "@friday/subagents";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SUBAGENTS_CAPABILITY, type SubagentsService } from "./contract.js";

const subagentsPlugin: FridayPlugin = definePlugin({ id: "subagents", provides: [SUBAGENTS_CAPABILITY] }, (ctx) => {
  const service: SubagentsService = Object.freeze({
    SubagentManager: subagents.SubagentManager,
    createSessionSubagentRegistryStore: subagents.createSessionSubagentRegistryStore,
    findSubagentModelMatches: subagents.findSubagentModelMatches,
  });
  ctx.services.provide(SUBAGENTS_CAPABILITY, service);
});

export default subagentsPlugin;
