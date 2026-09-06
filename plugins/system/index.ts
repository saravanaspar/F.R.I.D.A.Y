import type { FridayPlugin } from "../../src/plugin.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { PERMISSIONS_CAPABILITY } from "../permissions/contract.js";
import { TURN_EXECUTOR_CONTRIBUTION } from "../turn-loop/contract.js";
import {
  SYSTEM_ACTION_CONTRIBUTION,
  SYSTEM_STATUS_CONTRIBUTION,
  type SystemActionContribution,
} from "./contract.js";
import {
  createSystemActionInputValidator,
  createSystemActionsAction,
  createSystemModelPlanner,
  createSystemModelPresenter,
  createOperatorDashboardAction,
  createSystemStatusAction,
  createSystemTurnExecutor,
} from "./executor.js";

const systemPlugin: FridayPlugin = definePlugin({
  id: "system",
  requires: [MODEL_CAPABILITY, PERMISSIONS_CAPABILITY],
  optional: [MODEL_CREDENTIALS_CAPABILITY],
}, (ctx) => {
  const models = ctx.services.require(MODEL_CAPABILITY);
  const contributedActions = (): readonly SystemActionContribution[] => ctx.collect(SYSTEM_ACTION_CONTRIBUTION);
  const statusAction = createSystemStatusAction(() => ctx.collect(SYSTEM_STATUS_CONTRIBUTION));
  const dashboardAction = createOperatorDashboardAction(() => ctx.collect(SYSTEM_STATUS_CONTRIBUTION));
  const actionsAction = createSystemActionsAction(() => [statusAction, dashboardAction, ...contributedActions()]);
  const allActions = (): readonly SystemActionContribution[] => [statusAction, dashboardAction, actionsAction, ...contributedActions()];

  ctx.contribute(TURN_EXECUTOR_CONTRIBUTION, createSystemTurnExecutor({
    permissions: ctx.services.require(PERMISSIONS_CAPABILITY),
    actions: allActions,
    planner: createSystemModelPlanner(models, () => ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY)),
    validateInput: createSystemActionInputValidator(models),
    presenter: createSystemModelPresenter(models, () => ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY)),
  }));
});

export default systemPlugin;
export * from "./contract.js";
export {
  createSystemActionInputValidator,
  createSystemActionsAction,
  createSystemModelPlanner,
  createSystemModelPresenter,
  createOperatorDashboardAction,
  createSystemStatusAction,
  createSystemTurnExecutor,
  type SystemPlannerRequest,
  type SystemTurnExecutorOptions,
  type SystemTurnPlan,
  type SystemTurnPlanner,
} from "./executor.js";
