import * as prompts from "@friday/prompts";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { PROMPTS_CAPABILITY, type PromptsService } from "./contract.js";

const promptsPlugin: FridayPlugin = definePlugin({ id: "prompts", provides: [PROMPTS_CAPABILITY] }, (ctx) => {
  const service: PromptsService = Object.freeze({ api: prompts });
  ctx.services.provide(PROMPTS_CAPABILITY, service);
});

export default promptsPlugin;
