import * as execution from "@friday/execution";
import {
  configureSessionResourceAccess,
  type SessionResourceAccess,
} from "@friday/execution/resource-access";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SESSION_RESOURCES_CAPABILITY } from "../session-resources/contract.js";
import { EXECUTION_CAPABILITY, type ExecutionService } from "./contract.js";

/** Exposes persistent execution while resolving lifecycle cleanup through capabilities. */
const executionPlugin: FridayPlugin = definePlugin({ id: "execution", requires: [SESSION_RESOURCES_CAPABILITY], provides: [EXECUTION_CAPABILITY] }, (ctx) => {
  const sessionResources = ctx.services.require(SESSION_RESOURCES_CAPABILITY);
  const resourceAccess: SessionResourceAccess = {
    registerSessionResourceCleanup: sessionResources.api.registerSessionResourceCleanup,
  };
  configureSessionResourceAccess(resourceAccess);

  const processes = new execution.ManagedProcessSupervisor();
  ctx.effect(() => processes.close());
  const service: ExecutionService = Object.freeze({ api: execution, processes });
  ctx.services.provide(EXECUTION_CAPABILITY, service);
});

export default executionPlugin;
