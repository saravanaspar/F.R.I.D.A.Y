import type { Capability } from "../capabilities/protocol.js";
import { defineCapability } from "../capabilities/protocol.js";
import type { SessionJobOrigin, SessionJobRunResult, SessionJobProgress } from "../session-jobs/contract.js";

export type ConversationType = "direct" | "group";
export type ConversationParticipantKind = "user" | "agent";
export type HandoffStatus = "queued" | "running" | "completed" | "error";

export interface ConversationParticipant {
  readonly kind: ConversationParticipantKind;
  readonly id: string;
}

export interface Conversation {
  readonly id: string;
  readonly type: ConversationType;
  readonly title: string;
  readonly sessionId: string;
  readonly participants: readonly ConversationParticipant[];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly notificationsEnabled: boolean;
  readonly lastReadSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Thread {
  readonly id: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly replyCount: number;
  readonly lastReplyAt?: string | undefined;
  readonly createdAt: string;
}

export interface ConversationMentions {
  readonly agentIds: readonly string[];
  readonly includesEveryone: boolean;
}

export interface Reaction {
  readonly messageId: string;
  readonly actorId: string;
  readonly emoji: string;
  readonly createdAt: string;
}

export interface ConversationHandoff {
  readonly id: string;
  readonly conversationId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly text: string;
  readonly jobId?: string | undefined;
  readonly sessionId: string;
  readonly status: HandoffStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationCreateInput {
  readonly id?: string | undefined;
  readonly type: ConversationType;
  readonly title?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly participants: readonly ConversationParticipant[];
}

export interface ConversationUpdateInput {
  readonly title?: string | undefined;
  readonly pinned?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly notificationsEnabled?: boolean | undefined;
}

export interface HandoffExecution {
  readonly run: (
    signal: AbortSignal,
    report: (progress: SessionJobProgress) => Promise<void>,
    context?: Readonly<{ jobId: string }> | undefined,
  ) => Promise<SessionJobRunResult>;
  readonly notify?: ((text: string) => Promise<void>) | undefined;
  readonly origin?: SessionJobOrigin | undefined;
}

export interface ConversationHandoffInput {
  readonly conversationId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly text: string;
  readonly sessionId?: string | undefined;
}

export interface ConversationsService {
  create(input: ConversationCreateInput): Promise<Conversation>;
  get(id: string): Conversation | undefined;
  list(): readonly Conversation[];
  update(id: string, input: ConversationUpdateInput): Promise<Conversation>;
  markRead(id: string, sequence: number): Promise<Conversation>;
  createThread(conversationId: string, rootMessageId: string): Promise<Thread>;
  recordThreadReply(threadId: string): Promise<Thread>;
  listThreads(conversationId: string): readonly Thread[];
  resolveMentions(conversationId: string, text: string): ConversationMentions;
  addReaction(messageId: string, actorId: string, emoji: string): Promise<Reaction>;
  removeReaction(messageId: string, actorId: string, emoji: string): Promise<boolean>;
  listReactions(messageId: string): readonly Reaction[];
  createHandoff(input: ConversationHandoffInput, execution?: HandoffExecution): Promise<ConversationHandoff>;
  listHandoffs(conversationId?: string): readonly ConversationHandoff[];
}

export const CONVERSATIONS_CAPABILITY: Capability<ConversationsService> =
  defineCapability<ConversationsService>("conversations");
