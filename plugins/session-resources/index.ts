import * as sessionResources from "@friday/session-resources";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SESSION_RESOURCES_CAPABILITY, type SessionResourcesService } from "./contract.js";

const sessionResourcesPlugin: FridayPlugin = definePlugin({ id: "session-resources", provides: [SESSION_RESOURCES_CAPABILITY] }, (ctx) => {
  const service: SessionResourcesService = Object.freeze({
    registerSessionResourceCleanup: sessionResources.registerSessionResourceCleanup,
    cleanupSessionResources: sessionResources.cleanupSessionResources,
  });
  ctx.services.provide(SESSION_RESOURCES_CAPABILITY, service);
});

export default sessionResourcesPlugin;
