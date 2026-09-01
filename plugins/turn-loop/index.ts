import type { FridayPlugin } from "../../src/plugin.js";
import { AGENT_CAPABILITY } from "../agent/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { MEMORY_CAPABILITY } from "../memory/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../permissions/trusted-contract.js";
import { PROMPTS_CAPABILITY } from "../prompts/contract.js";
import { RLM_CAPABILITY } from "../rlm/contract.js";
import { ROUTING_CAPABILITY } from "../routing/contract.js";
import { SANDBOX_CAPABILITY } from "../sandbox/contract.js";
import { SESSION_RESOURCES_CAPABILITY } from "../session-resources/contract.js";
import { SESSION_JOBS_CAPABILITY } from "../session-jobs/contract.js";
import { SESSIONS_CAPABILITY } from "../sessions/contract.js";
import { SKILLS_CAPABILITY } from "../skills/contract.js";
import { SUBAGENTS_CAPABILITY } from "../subagents/contract.js";
import { SYSTEM_ACTIVE_WORK_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION } from "../system/contract.js";
import { TOOLS_CAPABILITY } from "../tools/contract.js";
import { createAgentTurnExecutor } from "./agent-executor.js";
import {
  AGENT_AFTER_TURN_CONTRIBUTION,
  AGENT_INPUT_CONTRIBUTION,
  AGENT_PROMPT_SECTION_CONTRIBUTION,
  AGENT_TOOL_CONTRIBUTION,
  TURN_EXECUTOR_CONTRIBUTION,
  TURN_FINALIZER_CONTRIBUTION,
  TURN_INGRESS_HOOK,
  TURN_LOOP_CAPABILITY,
} from "./contract.js";
import { createTurnRuntime } from "./turn-loop.js";
import { SqliteTurnReplyOutbox } from "./reply-outbox.js";

const turnLoopPlugin: FridayPlugin = definePlugin({
  id: "turn-loop",
  requires: [
    AGENT_CAPABILITY,
    EVENTS_CAPABILITY,
    MODEL_CAPABILITY,
    PERMISSIONS_TRUSTED_CAPABILITY,
    PROMPTS_CAPABILITY,
    ROUTING_CAPABILITY,
    SESSION_RESOURCES_CAPABILITY,
    SESSIONS_CAPABILITY,
    TOOLS_CAPABILITY,
  ],
  optional: [
    MODEL_CREDENTIALS_CAPABILITY,
    MEMORY_CAPABILITY,
    OBSERVABILITY_CAPABILITY,
    RLM_CAPABILITY,
    SANDBOX_CAPABILITY,
    SESSION_JOBS_CAPABILITY,
    SKILLS_CAPABILITY,
    SUBAGENTS_CAPABILITY,
  ],
  provides: [TURN_LOOP_CAPABILITY],
}, (ctx) => {
  const executor = createAgentTurnExecutor({
    agent: ctx.services.require(AGENT_CAPABILITY),
    model: ctx.services.require(MODEL_CAPABILITY),
    prompts: ctx.services.require(PROMPTS_CAPABILITY),
    sessionResources: ctx.services.require(SESSION_RESOURCES_CAPABILITY),
    sessions: ctx.services.require(SESSIONS_CAPABILITY),
    tools: ctx.services.require(TOOLS_CAPABILITY),
    toolContributions: () => ctx.collect(AGENT_TOOL_CONTRIBUTION),
    inputContributions: () => ctx.collect(AGENT_INPUT_CONTRIBUTION),
    promptSectionContributions: () => ctx.collect(AGENT_PROMPT_SECTION_CONTRIBUTION),
    afterTurnContributions: () => ctx.collect(AGENT_AFTER_TURN_CONTRIBUTION),
    optional: {
      credentials: () => ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY),
      memory: () => ctx.services.optional(MEMORY_CAPABILITY),
      observability: () => ctx.services.optional(OBSERVABILITY_CAPABILITY),
      skills: () => ctx.services.optional(SKILLS_CAPABILITY),
      rlm: () => ctx.services.optional(RLM_CAPABILITY),
      subagents: () => ctx.services.optional(SUBAGENTS_CAPABILITY),
      sandbox: () => ctx.services.optional(SANDBOX_CAPABILITY),
    },
  });
  ctx.effect(() => executor.dispose());
  ctx.contribute(TURN_EXECUTOR_CONTRIBUTION, executor);

  const replyOutbox = new SqliteTurnReplyOutbox();
  ctx.effect(() => replyOutbox.close());
  const runtime = createTurnRuntime({
    routing: ctx.services.require(ROUTING_CAPABILITY),
    permissions: ctx.services.require(PERMISSIONS_TRUSTED_CAPABILITY),
    events: ctx.services.require(EVENTS_CAPABILITY),
    executors: () => ctx.collect(TURN_EXECUTOR_CONTRIBUTION),
    observability: () => ctx.services.optional(OBSERVABILITY_CAPABILITY),
    sessionJobs: () => ctx.services.optional(SESSION_JOBS_CAPABILITY),
    replyOutbox,
    finalizers: () => ctx.collect(TURN_FINALIZER_CONTRIBUTION),
  });
  ctx.services.provide(TURN_LOOP_CAPABILITY, runtime);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, {
    id: "turn-loop",
    label: "Turn Loop",
    snapshot: () => runtime.status(),
  });
  ctx.contribute(SYSTEM_ACTIVE_WORK_CONTRIBUTION, {
    id: "turn-loop",
    snapshot: (query) => ({
      foregroundTurns: Math.max(0, runtime.status().activeTurns - Math.max(0, query.excludeForegroundTurns ?? 0)),
    }),
  });
  ctx.on(TURN_INGRESS_HOOK, async (turn) => {
    await runtime.submit(turn);
  });
});

export default turnLoopPlugin;
export * from "./contract.js";
export { createAgentTurnExecutor } from "./agent-executor.js";
export { createTurnRuntime } from "./turn-loop.js";
