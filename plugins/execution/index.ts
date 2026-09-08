import * as execution from "@friday/execution";
import {
  configureSessionResourceAccess,
  type SessionResourceAccess,
} from "@friday/execution/resource-access";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { SESSION_RESOURCES_CAPABILITY } from "../session-resources/contract.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../runtime-settings/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { EXECUTION_CAPABILITY, type ExecutionService } from "./contract.js";
import { executionPythonPath, setupExecutionPython } from "./setup.js";
import { existsSync } from "node:fs";

/** Exposes persistent execution while resolving lifecycle cleanup through capabilities. */
const executionPlugin: FridayPlugin = definePlugin({ id: "execution", requires: [SESSION_RESOURCES_CAPABILITY], optional: [RUNTIME_SETTINGS_CAPABILITY], provides: [EXECUTION_CAPABILITY] }, (ctx) => {
  const sessionResources = ctx.services.require(SESSION_RESOURCES_CAPABILITY);
  const resourceAccess: SessionResourceAccess = {
    registerSessionResourceCleanup: sessionResources.registerSessionResourceCleanup,
  };
  configureSessionResourceAccess(resourceAccess);

  const processes = new execution.ManagedProcessSupervisor();
  ctx.effect(() => processes.close());
  const service: ExecutionService = Object.freeze({
    KernelManager: execution.KernelManager,
    execCommand: execution.execCommand,
    defaultKernelPythonPath: execution.defaultKernelPythonPath,
    createLocalShellOperations: execution.createLocalShellOperations,
    launchDetachedProcess: execution.launchDetachedProcess,
    isProcessAlive: execution.isProcessAlive,
    signalProcessGroupOrProcess: execution.signalProcessGroupOrProcess,
    processes,
  });
  ctx.services.provide(EXECUTION_CAPABILITY, service);

  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "execution",
    label: "Execution",
    snapshot: () => ({ ready: existsSync(executionPythonPath()), pythonReady: existsSync(executionPythonPath()) }),
  });

  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "execution.python.setup",
    label: "Set up execution Python",
    description: "Provision FRIDAY's private Python 3.11 execution environment in user space. No sudo or privileged host access is used.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission() {
      return { id: "execution.python.setup", effect: "system-write", resource: "execution:python", network: true };
    },
    async execute() {
      const python = await setupExecutionPython();
      await ctx.services.optional(RUNTIME_SETTINGS_CAPABILITY)?.markOnboardingStep("executionPython", "complete");
      return { configured: true, python, message: "Private execution Python is ready." };
    },
  });
});

export default executionPlugin;
