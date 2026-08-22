import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../permissions/trusted-contract.js";
import { SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { TURN_EXECUTOR_CONTRIBUTION } from "../turn-loop/contract.js";
import {
  SCHEDULED_ACTION_CONTRIBUTION,
  SCHEDULER_CAPABILITY,
  type SchedulerWorkerOptions,
} from "./contract.js";
import { createSchedulerService } from "./scheduler.js";
import {
  createSchedulerModelPlanner,
  createSchedulerTurnExecutor,
  installScheduledActionDispatcher,
} from "./turn-executor.js";
import {
  isLifecycleRestartEnvironment,
  LIFECYCLE_HANDOFF_CONTRIBUTION,
} from "../lifecycle/contract.js";

export interface SchedulerPluginOptions {
  readonly autoStartWorker?: boolean | undefined;
  readonly worker?: SchedulerWorkerOptions | undefined;
}

export function createSchedulerPlugin(options: SchedulerPluginOptions = {}): FridayPlugin {
  return definePlugin({
    id: "scheduler",
    requires: [MODEL_CAPABILITY, PERMISSIONS_CAPABILITY, PERMISSIONS_TRUSTED_CAPABILITY],
    provides: [SCHEDULER_CAPABILITY],
  }, (ctx) => {
    const scheduler = createSchedulerService();
    const permissions = ctx.services.require(PERMISSIONS_CAPABILITY);
    const trustedPermissions = ctx.services.require(PERMISSIONS_TRUSTED_CAPABILITY);
    ctx.services.provide(SCHEDULER_CAPABILITY, scheduler);
    ctx.effect(installScheduledActionDispatcher({
      scheduler,
      permissions: trustedPermissions,
      actions: () => ctx.collect(SCHEDULED_ACTION_CONTRIBUTION),
    }));
    ctx.contribute(TURN_EXECUTOR_CONTRIBUTION, createSchedulerTurnExecutor({
      scheduler,
      permissions,
      actions: () => ctx.collect(SCHEDULED_ACTION_CONTRIBUTION),
      planner: createSchedulerModelPlanner(ctx.services.require(MODEL_CAPABILITY)),
    }));
    ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
      id: "scheduler",
      label: "Scheduler",
      snapshot: () => ({
        worker: scheduler.workerStatus(),
        taskCount: scheduler.list().length,
        enabledTaskCount: scheduler.list().filter((task) => task.enabled).length,
      }),
    });
    ctx.effect(() => scheduler.close());

    if (options.autoStartWorker === true) {
      ctx.contribute(LIFECYCLE_HANDOFF_CONTRIBUTION, {
        id: "scheduler.worker",
        activate: () => scheduler.startWorker(options.worker),
        quiesce: () => scheduler.stopWorker(),
      });
    }
    if (options.autoStartWorker === true && !isLifecycleRestartEnvironment()) {
      ctx.afterReady(() => scheduler.startWorker(options.worker));
    }
  });
}

export default createSchedulerPlugin({ autoStartWorker: true });
export * from "./contract.js";
export { createSchedulerService, type SchedulerServiceOptions } from "./scheduler.js";
export {
  createSchedulerModelPlanner,
  createSchedulerTurnExecutor,
  installScheduledActionDispatcher,
  type SchedulerPlannerAction,
  type SchedulerPlannerRequest,
  type SchedulerPlannerTask,
  type SchedulerTurnExecutorOptions,
  type SchedulerTurnPlan,
  type SchedulerTurnPlanner,
} from "./turn-executor.js";
