import type { Capability, Contribution, Hook } from "../capabilities/protocol.js";
import { defineCapability, defineContribution, defineHook } from "../capabilities/protocol.js";
import type { RoutingDecision } from "../routing/contract.js";

export type TurnPrincipalAuthority = "local" | "channel";

export interface TurnPrincipal {
  /** Host-owned authority classification supplied by the ingress adapter. */
  readonly authority: TurnPrincipalAuthority;
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly threadId?: string | undefined;
}


export interface TurnAttachment {
  readonly kind: "image" | "audio" | "video" | "document" | "sticker" | "other";
  readonly externalId: string;
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
  readonly sizeBytes?: number | undefined;
  /** Transport-owned retrieval metadata. Consumers must use the owning channel capability, never this as a filesystem path. */
  readonly downloadUrl?: string | undefined;
  /** Durable host artifact reference used when a turn is resumed after restart. */
  readonly artifactRef?: string | undefined;
}

export interface InboundTurn {
  readonly id: string;
  readonly principal: TurnPrincipal;
  readonly text: string;
  readonly attachments?: readonly TurnAttachment[] | undefined;
  readonly timestamp: number;
  /** Host-owned destination override used only for durable restart resumption. */
  readonly resumeDestinationId?: string | undefined;
  /** Host-owned predecessor job id when reconstructing interrupted work. */
  readonly resumedJobId?: string | undefined;
  /** Host-owned reply port supplied by the ingress adapter. */
  readonly reply: (text: string) => Promise<void>;
}

export type AgentExtensionJsonPrimitive = string | number | boolean | null;
export type AgentExtensionJsonValue =
  | AgentExtensionJsonPrimitive
  | AgentExtensionJsonValue[]
  | { [key: string]: AgentExtensionJsonValue };

export interface AgentToolContributionResult {
  /** JSON-safe result rendered back to the model as bounded tool-result text. */
  readonly output: AgentExtensionJsonValue;
  /** Throwing is preferred; this flag adapts protocols such as MCP that return errors as values. */
  readonly isError?: boolean | undefined;
  readonly terminate?: boolean | undefined;
}

/** Generic run context shared with Turn Loop extensions without importing Agent implementation contracts. */
export interface AgentToolExecutionContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionArtifactDir?: string | undefined;
  readonly turn?: InboundTurn | undefined;
  /** Durable Session Jobs attribution for restart-aware system/tool actions. */
  readonly jobId?: string | undefined;
  deferAfterReply(callback: () => void | Promise<void>): void;
  deferOnFailure(callback: (error: unknown) => void | Promise<void>): void;
}

export interface AgentPreparedImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface AgentPreparedMount {
  /** Host path registered read-only into every sandbox used for this run. */
  readonly source: string;
}

export interface AgentPreparedInput {
  /** Host-authored data/instructions exposed only to the current model call. */
  readonly context?: string | undefined;
  readonly images?: readonly AgentPreparedImage[] | undefined;
  readonly mounts?: readonly AgentPreparedMount[] | undefined;
  /** Bounded host context retained in a hidden session message for later turns. */
  readonly persistedContext?: string | undefined;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

/** Generic inbound-input preparation seam owned by Turn Loop orchestration. */
export interface AgentInputContribution {
  readonly id: string;
  /** Prepare runtime-lifetime resources before lazy tools such as IPython can start. */
  prepareRuntime?(context: AgentToolExecutionContext): Promise<AgentPreparedInput | undefined>;
  prepare(context: AgentToolExecutionContext): Promise<AgentPreparedInput | undefined>;
}

/** Plugins can layer dynamic host-owned policy/persona sections into the system prompt. */
export interface AgentPromptSectionContribution {
  readonly id: string;
  render(context: AgentToolExecutionContext): string | undefined;
}

export interface AgentAfterTurnContext extends AgentToolExecutionContext {
  readonly userText: string;
  readonly assistantText: string;
  readonly usedTools: readonly string[];
}

/** Conservative learning/refinement hooks run only after the user-visible turn succeeds. */
export interface AgentAfterTurnContribution {
  readonly id: string;
  afterTurn(context: AgentAfterTurnContext, signal?: AbortSignal): void | Promise<void>;
}

/**
 * Model-facing tool contribution. Plugins contribute tools through Turn Loop's
 * generic extension seam without depending on the Agent implementation package.
 */
export interface AgentToolContribution {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, AgentExtensionJsonValue>>;
  readonly executionMode?: "sequential" | "parallel" | undefined;
  execute(
    input: Readonly<Record<string, AgentExtensionJsonValue>>,
    signal?: AbortSignal,
    context?: AgentToolExecutionContext,
  ): Promise<AgentToolContributionResult>;
}

export const AGENT_TOOL_CONTRIBUTION: Contribution<AgentToolContribution> =
  defineContribution<AgentToolContribution>("agent.tool");

export const AGENT_INPUT_CONTRIBUTION: Contribution<AgentInputContribution> =
  defineContribution<AgentInputContribution>("agent.input");

export const AGENT_PROMPT_SECTION_CONTRIBUTION: Contribution<AgentPromptSectionContribution> =
  defineContribution<AgentPromptSectionContribution>("agent.prompt-section");

export const AGENT_AFTER_TURN_CONTRIBUTION: Contribution<AgentAfterTurnContribution> =
  defineContribution<AgentAfterTurnContribution>("agent.after-turn");

export interface TurnSubmitOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface TurnExecutionContext {
  readonly turn: InboundTurn;
  readonly decision: RoutingDecision;
  readonly signal?: AbortSignal | undefined;
  /** Host-owned public progress channel. Never use this for hidden chain-of-thought. */
  readonly progress?: ((update: TurnProgressUpdate) => Promise<void>) | undefined;
  /** Durable detached-job attribution when execution was admitted by Session Jobs. */
  readonly jobId?: string | undefined;
}

export interface TurnProgressUpdate {
  readonly kind: "status" | "tool" | "retry";
  readonly message: string;
  readonly timestamp?: number | undefined;
  readonly attempt?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly notify?: boolean | undefined;
}

export interface TurnExecutionResult {
  readonly text: string;
  readonly sessionId?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  /** Host-only finalizer run after the reply and durable completion record succeed. */
  readonly afterReply?: (() => void | Promise<void>) | undefined;
  /** Host-only compensation run when the turn fails before or during finalization. */
  readonly afterFailure?: ((error: unknown) => void | Promise<void>) | undefined;
}

/**
 * Execution implementations are contributions rather than hard-coded branches in
 * the Turn Loop. A plugin can add a new execution profile without editing the loop.
 */
export interface TurnExecutor {
  readonly id: string;
  /** Higher priority intentionally overrides a lower-priority matching executor. */
  readonly priority?: number | undefined;
  canHandle(decision: RoutingDecision): boolean;
  execute(context: TurnExecutionContext): Promise<TurnExecutionResult>;
}

export type TurnResultStatus = "completed" | "duplicate";

export interface TurnResult {
  readonly status: TurnResultStatus;
  readonly messageId: string;
  readonly decision?: RoutingDecision | undefined;
  readonly executorId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface TurnRuntimeStatus {
  readonly activeTurns: number;
  readonly queuedConversations: number;
  readonly lockedSessions: number;
  readonly completedInProcess: number;
}

export interface TurnRuntimeService {
  submit(turn: InboundTurn, options?: TurnSubmitOptions): Promise<TurnResult>;
  status(): TurnRuntimeStatus;
}

export const TURN_EXECUTOR_CONTRIBUTION: Contribution<TurnExecutor> =
  defineContribution<TurnExecutor>("turn.executor");

/** Generic ingress seam used by Channels, Voice, and future conversational adapters. */
export const TURN_INGRESS_HOOK: Hook<InboundTurn> =
  defineHook<InboundTurn>("turn.ingress");

export const TURN_LOOP_CAPABILITY: Capability<TurnRuntimeService> =
  defineCapability<TurnRuntimeService>("turn-runtime");
