import { createHash } from "node:crypto";
import type { FridayPlugin } from "../../src/plugin.js";
import { AGENT_CAPABILITY } from "../agent/contract.js";
import { AGENT_PROFILES_CAPABILITY } from "../agent-profiles/contract.js";
import { CONVERSATIONS_CAPABILITY } from "../conversations/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../auth/contract.js";
import { definePlugin } from "../capabilities/protocol.js";
import { EVENTS_CAPABILITY } from "../events/contract.js";
import { MEMORY_CAPABILITY } from "../memory/contract.js";
import { MODEL_CAPABILITY } from "../model/contract.js";
import { OBSERVABILITY_CAPABILITY } from "../observability/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../permissions/trusted-contract.js";
import { PROMPTS_CAPABILITY } from "../prompts/contract.js";
import { PROJECTS_CAPABILITY } from "../projects/contract.js";
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
  AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION,
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
    AGENT_PROFILES_CAPABILITY,
    CONVERSATIONS_CAPABILITY,
    PROJECTS_CAPABILITY,
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
    modelRequestPolicyContributions: () => ctx.collect(AGENT_MODEL_REQUEST_POLICY_CONTRIBUTION),
    optional: {
      credentials: () => ctx.services.optional(MODEL_CREDENTIALS_CAPABILITY),
      memory: () => ctx.services.optional(MEMORY_CAPABILITY),
      observability: () => ctx.services.optional(OBSERVABILITY_CAPABILITY),
      skills: () => ctx.services.optional(SKILLS_CAPABILITY),
      rlm: () => ctx.services.optional(RLM_CAPABILITY),
      subagents: () => ctx.services.optional(SUBAGENTS_CAPABILITY),
      sandbox: () => ctx.services.optional(SANDBOX_CAPABILITY),
      profiles: () => ctx.services.optional(AGENT_PROFILES_CAPABILITY),
      projects: () => ctx.services.optional(PROJECTS_CAPABILITY),
    },
  });
  ctx.effect(() => executor.dispose());
  ctx.contribute(TURN_EXECUTOR_CONTRIBUTION, executor);

  const trustedPermissions = ctx.services.require(PERMISSIONS_TRUSTED_CAPABILITY);

  const replyOutbox = new SqliteTurnReplyOutbox();
  ctx.effect(() => replyOutbox.close());
  const runtime = createTurnRuntime({
    routing: ctx.services.require(ROUTING_CAPABILITY),
    permissions: trustedPermissions,
    events: ctx.services.require(EVENTS_CAPABILITY),
    executors: () => ctx.collect(TURN_EXECUTOR_CONTRIBUTION),
    observability: () => ctx.services.optional(OBSERVABILITY_CAPABILITY),
    sessionJobs: () => ctx.services.optional(SESSION_JOBS_CAPABILITY),
    replyOutbox,
    finalizers: () => ctx.collect(TURN_FINALIZER_CONTRIBUTION),
    recordHandoff: async (input) => {
      const conversations = ctx.services.optional(CONVERSATIONS_CAPABILITY);
      if (!conversations) return;
      await conversations.createHandoff({
        conversationId: input.conversationId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        text: input.text,
        sessionId: input.sessionId,
        jobId: input.jobId,
      });
    },
  });
  ctx.services.provide(TURN_LOOP_CAPABILITY, runtime);

  ctx.contribute(AGENT_TOOL_CONTRIBUTION, {
    sourcePluginId: "turn-loop",
    id: "turn-loop-delegate-agent",
    name: "delegate_to_agent",
    label: "Delegate to named Agent",
    description: "Delegate bounded work to another Agent Profile participating in the current shared Conversation. The delegated work runs as a durable Session Job and reports back to this conversation.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        agentId: { type: "string", description: "Target Agent Profile id, for example developer or research" },
        text: { type: "string", description: "Specific task to delegate" },
      },
      required: ["agentId", "text"],
      additionalProperties: false,
    }),
    async execute(input, _signal, executionContext) {
      const turn = executionContext?.turn;
      const sharedConversationId = turn?.principal.sharedConversationId;
      if (!turn || !sharedConversationId) throw new Error("delegate_to_agent requires a shared Conversation turn");
      if ((turn.delegationDepth ?? 0) >= 3) throw new Error("Agent delegation depth limit reached (3)");
      const conversations = ctx.services.optional(CONVERSATIONS_CAPABILITY);
      const profiles = ctx.services.optional(AGENT_PROFILES_CAPABILITY);
      const sessionJobs = ctx.services.optional(SESSION_JOBS_CAPABILITY);
      if (!conversations || !profiles || !sessionJobs) throw new Error("Agent delegation capabilities are unavailable");
      const conversation = conversations.get(sharedConversationId);
      if (!conversation) throw new Error("shared Conversation not found");
      const agentId = typeof input.agentId === "string" ? input.agentId.trim().toLowerCase() : "";
      const delegatedText = typeof input.text === "string" ? input.text.trim() : "";
      if (!agentId || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agentId)) throw new Error("agentId is invalid");
      if (!delegatedText || delegatedText.length > 128_000) throw new Error("delegated text is invalid");
      const target = profiles.get(agentId);
      if (!target) throw new Error(`Agent Profile not found: ${agentId}`);
      if (!conversation.participants.some((participant) => participant.kind === "agent" && participant.id === agentId)) {
        throw new Error(`Agent @${agentId} is not a participant in this Conversation`);
      }
      if (executionContext.agentProfileId === agentId) throw new Error("an Agent cannot delegate the same task to itself");
      const label = target.title.trim() || target.name.trim() || target.id;
      const sourceKey = `agent-handoff:${createHash("sha256").update(JSON.stringify([
        executionContext.jobId ?? turn.id,
        sharedConversationId,
        executionContext.agentProfileId ?? "friday",
        agentId,
        delegatedText,
      ])).digest("hex").slice(0, 40)}`;
      const delegatedTurn = Object.freeze({
        ...turn,
        id: `${turn.id}:handoff:${sourceKey.slice(-16)}`,
        principal: Object.freeze({ ...turn.principal, agentProfileId: agentId, sharedConversationId }),
        text: delegatedText,
        timestamp: Date.now(),
        agentProfileId: agentId,
        agentProfileLabel: label,
        agentNotificationPreference: target.notificationPreference,
        sessionAffinityId: conversation.sessionId,
        collaboratingAgents: Object.freeze([]),
        delegationDepth: (turn.delegationDepth ?? 0) + 1,
        destinationId: `session:${conversation.sessionId}`,
      });
      const handoff = await conversations.createHandoff({
        conversationId: sharedConversationId,
        fromAgentId: executionContext.agentProfileId ?? "friday",
        toAgentId: agentId,
        text: delegatedText,
        sessionId: conversation.sessionId,
      }, {
        sourceKey,
        origin: {
          authority: turn.principal.authority,
          channel: turn.principal.channel,
          accountId: turn.principal.accountId,
          conversationId: turn.principal.conversationId,
          senderId: turn.principal.senderId,
          ...(turn.principal.threadId === undefined ? {} : { threadId: turn.principal.threadId }),
          sharedConversationId,
          ...(turn.projectId === undefined ? {} : { projectId: turn.projectId }),
          ...(turn.projectTargetId === undefined ? {} : { projectTargetId: turn.projectTargetId }),
        },
        notify: target.notificationPreference === "muted"
          ? async () => undefined
          : async (text) => turn.reply(`${label} · ${text}`),
        run: async (signal, report, jobContext) => {
          const decision = Object.freeze({
            messageId: delegatedTurn.id,
            destination: Object.freeze({ kind: "session" as const, id: `session:${conversation.sessionId}` }),
            execution: Object.freeze({ profile: "agent" as const }),
            confidence: 1,
          });
          const executeDelegated = () => executor.execute({
            turn: delegatedTurn,
            decision,
            signal,
            progress: target.notificationPreference === "all"
              ? report
              : async (update) => report({ ...update, notify: false }),
            ...(jobContext?.jobId === undefined ? {} : { jobId: jobContext.jobId }),
            ...(jobContext?.onDirective === undefined ? {} : { onDirective: jobContext.onDirective }),
          });
          const result = jobContext?.jobId === undefined || trustedPermissions.runAsJob === undefined
            ? await executeDelegated()
            : await trustedPermissions.runAsJob(jobContext.jobId, executeDelegated);
          return {
            text: result.text,
            ...(result.sessionId === undefined ? { sessionId: conversation.sessionId } : { sessionId: result.sessionId }),
            ...(result.afterReply === undefined ? {} : { afterNotify: result.afterReply }),
            ...(result.afterReplyFinalizers === undefined ? {} : { afterNotifyFinalizers: result.afterReplyFinalizers }),
          };
        },
      });
      return {
        output: {
          handoffId: handoff.id,
          jobId: handoff.jobId ?? null,
          status: handoff.status,
          agentId,
          label,
        },
      };
    },
  });

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
