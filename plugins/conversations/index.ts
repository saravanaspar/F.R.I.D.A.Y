import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { AGENT_PROFILES_CAPABILITY, type AgentProfilesService } from "../agent-profiles/contract.js";
import { EVENTS_CAPABILITY, type EventsService } from "../events/contract.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobsService } from "../session-jobs/contract.js";
import { SESSIONS_CAPABILITY, type SessionsService } from "../sessions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { CONVERSATIONS_CAPABILITY, type Conversation, type ConversationCreateInput, type ConversationHandoff, type ConversationHandoffInput, type ConversationMentions, type ConversationParticipant, type ConversationParticipantKind, type ConversationUpdateInput, type ConversationsService, type HandoffExecution, type HandoffStatus, type Reaction, type Thread } from "./contract.js";

const MAX_CONVERSATIONS = 2_048;
const MAX_THREADS = 100_000;
const MAX_REACTIONS = 100_000;
const MAX_HANDOFFS = 100_000;

function stateRoot(): string {
  return resolve(process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"), "conversations");
}

function fridayRoot(): string {
  return resolve(process.env.FRIDAY_STATE_DIR?.trim() || process.env.FRIDAY_HOME?.trim() || join(homedir(), ".friday"));
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const normalized = value.normalize("NFKC").replaceAll("\u0000", "\ufffd").trim();
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return normalized;
}

function identifier(value: unknown, label: string): string {
  return text(value, label, 256);
}

function sessionIdentifier(value: unknown): string {
  const normalized = identifier(value, "sessionId");
  if (normalized.length > 256 || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..") || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("sessionId is invalid");
  return normalized;
}

function participant(value: unknown): ConversationParticipant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("participant must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "user" && raw.kind !== "agent") throw new Error("participant kind must be user or agent");
  return Object.freeze({ kind: raw.kind as ConversationParticipantKind, id: identifier(raw.id, "participant id") });
}

function participantList(values: readonly ConversationParticipant[]): readonly ConversationParticipant[] {
  if (!Array.isArray(values) || values.length < 2 || values.length > 128) throw new Error("a conversation needs between 2 and 128 participants");
  const normalized = values.map(participant);
  const keys = new Set<string>();
  for (const entry of normalized) {
    const key = `${entry.kind}:${entry.id}`;
    if (keys.has(key)) throw new Error(`duplicate conversation participant: ${key}`);
    keys.add(key);
  }
  return Object.freeze(normalized);
}

function conversationType(value: unknown): "direct" | "group" {
  if (value !== "direct" && value !== "group") throw new Error("conversation type must be direct or group");
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function parseConversation(value: unknown): Conversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid conversation record");
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    id: identifier(raw.id, "conversation id"),
    type: conversationType(raw.type),
    title: text(raw.title, "conversation title", 256),
    sessionId: sessionIdentifier(raw.sessionId),
    participants: participantList(raw.participants as readonly ConversationParticipant[]),
    pinned: raw.pinned === true,
    hidden: raw.hidden === true,
    notificationsEnabled: raw.notificationsEnabled !== false,
    lastReadSequence: nonNegativeInteger(raw.lastReadSequence, "lastReadSequence"),
    createdAt: text(raw.createdAt, "createdAt", 64),
    updatedAt: text(raw.updatedAt, "updatedAt", 64),
  });
}

function parseThread(value: unknown): Thread {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid thread record");
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    id: identifier(raw.id, "thread id"),
    conversationId: identifier(raw.conversationId, "conversationId"),
    rootMessageId: identifier(raw.rootMessageId, "rootMessageId"),
    replyCount: nonNegativeInteger(raw.replyCount, "replyCount"),
    ...(raw.lastReplyAt === undefined ? {} : { lastReplyAt: text(raw.lastReplyAt, "lastReplyAt", 64) }),
    createdAt: text(raw.createdAt, "createdAt", 64),
  });
}

function parseReaction(value: unknown): Reaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid reaction record");
  const raw = value as Record<string, unknown>;
  return Object.freeze({ messageId: identifier(raw.messageId, "messageId"), actorId: identifier(raw.actorId, "actorId"), emoji: text(raw.emoji, "emoji", 32), createdAt: text(raw.createdAt, "createdAt", 64) });
}

function handoffStatus(value: unknown): HandoffStatus {
  if (value !== "queued" && value !== "running" && value !== "completed" && value !== "error") throw new Error("invalid handoff status");
  return value;
}

function currentHandoff(handoff: ConversationHandoff, jobs: SessionJobsService | undefined): ConversationHandoff {
  if (!handoff.jobId || !jobs) return handoff;
  const job = jobs.get(handoff.jobId);
  if (!job) return handoff;
  const status: HandoffStatus = job.status === "queued" ? "queued"
    : job.status === "running" || job.status === "retrying" ? "running"
      : job.status === "completed" || job.status === "resumed" ? "completed"
        : "error";
  return status === handoff.status ? handoff : Object.freeze({ ...handoff, status, updatedAt: job.updatedAt });
}

function parseHandoff(value: unknown): ConversationHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid handoff record");
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    id: identifier(raw.id, "handoff id"), conversationId: identifier(raw.conversationId, "conversationId"),
    fromAgentId: identifier(raw.fromAgentId, "fromAgentId"), toAgentId: identifier(raw.toAgentId, "toAgentId"),
    text: text(raw.text, "handoff text", 24_000),
    ...(raw.jobId === undefined ? {} : { jobId: identifier(raw.jobId, "jobId") }),
    sessionId: sessionIdentifier(raw.sessionId), status: handoffStatus(raw.status),
    createdAt: text(raw.createdAt, "createdAt", 64), updatedAt: text(raw.updatedAt, "updatedAt", 64),
  });
}

interface StateFile {
  readonly schema: 1;
  readonly conversations: readonly Conversation[];
  readonly threads: readonly Thread[];
  readonly reactions: readonly Reaction[];
  readonly handoffs: readonly ConversationHandoff[];
}

function emptyState(): StateFile {
  return { schema: 1, conversations: [], threads: [], reactions: [], handoffs: [] };
}

async function readState(): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(stateRoot(), "state.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid conversation state");
    const raw = parsed as Record<string, unknown>;
    if (raw.schema !== 1 || !Array.isArray(raw.conversations) || !Array.isArray(raw.threads) || !Array.isArray(raw.reactions) || !Array.isArray(raw.handoffs)) throw new Error("unsupported conversation state");
    if (raw.conversations.length > MAX_CONVERSATIONS || raw.threads.length > MAX_THREADS || raw.reactions.length > MAX_REACTIONS || raw.handoffs.length > MAX_HANDOFFS) throw new Error("conversation state exceeds limits");
    return { schema: 1, conversations: Object.freeze(raw.conversations.map(parseConversation)), threads: Object.freeze(raw.threads.map(parseThread)), reactions: Object.freeze(raw.reactions.map(parseReaction)), handoffs: Object.freeze(raw.handoffs.map(parseHandoff)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(state: StateFile): Promise<void> {
  const root = stateRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, "state.json");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function makeConversation(input: ConversationCreateInput): Conversation {
  const participants = participantList(input.participants);
  const type = conversationType(input.type);
  if (type === "direct" && participants.length !== 2) throw new Error("direct conversations must have exactly two participants");
  const now = new Date().toISOString();
  return Object.freeze({ id: identifier(input.id ?? randomUUID(), "conversation id"), type, title: text(input.title ?? "Conversation", "conversation title", 256), sessionId: sessionIdentifier(input.sessionId ?? randomUUID()), participants, pinned: false, hidden: false, notificationsEnabled: true, lastReadSequence: 0, createdAt: now, updatedAt: now });
}

const conversationsPlugin: FridayPlugin = definePlugin({
  id: "conversations",
  requires: [AGENT_PROFILES_CAPABILITY, EVENTS_CAPABILITY],
  optional: [SESSION_JOBS_CAPABILITY, SESSIONS_CAPABILITY],
  provides: [CONVERSATIONS_CAPABILITY],
}, async (ctx) => {
  const events = ctx.services.require(EVENTS_CAPABILITY);
  const profiles = ctx.services.require(AGENT_PROFILES_CAPABILITY);
  const jobs = ctx.services.optional(SESSION_JOBS_CAPABILITY);
  const sessions = ctx.services.optional(SESSIONS_CAPABILITY);
  let state = emptyState();
  let loaded = false;
  let mutationTail: Promise<void> = Promise.resolve();
  const load = async (): Promise<void> => { if (!loaded) { state = await readState(); loaded = true; } };
  await load();
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const persist = async (): Promise<void> => { await writeState(state); };
  const service: ConversationsService = Object.freeze({
    create: (input: ConversationCreateInput) => mutate(async () => {
      await load();
      const conversation = makeConversation(input);
      if (state.conversations.some((entry) => entry.id === conversation.id)) throw new Error(`conversation already exists: ${conversation.id}`);
      if (state.conversations.length >= MAX_CONVERSATIONS) throw new Error("conversation limit reached");
      state = { ...state, conversations: Object.freeze([...state.conversations, conversation]) };
      await persist();
      events.publish({ type: "conversation.created", source: "conversations", subject: `conversation:${conversation.id}`, data: { conversationId: conversation.id, sessionId: conversation.sessionId, type: conversation.type } });
      return conversation;
    }),
    get: (id: string) => state.conversations.find((entry) => entry.id === id),
    list: () => Object.freeze([...state.conversations]),
    update: (id: string, input: ConversationUpdateInput) => mutate(async () => {
      await load();
      const current = state.conversations.find((entry) => entry.id === identifier(id, "conversation id"));
      if (!current) throw new Error("conversation not found");
      const updated = Object.freeze({ ...current, ...(input.title === undefined ? {} : { title: text(input.title, "conversation title", 256) }), ...(input.pinned === undefined ? {} : { pinned: input.pinned }), ...(input.hidden === undefined ? {} : { hidden: input.hidden }), ...(input.notificationsEnabled === undefined ? {} : { notificationsEnabled: input.notificationsEnabled }), updatedAt: new Date().toISOString() });
      state = { ...state, conversations: Object.freeze(state.conversations.map((entry) => entry.id === current.id ? updated : entry)) };
      await persist();
      events.publish({ type: "conversation.updated", source: "conversations", subject: `conversation:${current.id}`, data: { conversationId: current.id, pinned: updated.pinned, hidden: updated.hidden } });
      return updated;
    }),
    markRead: (id: string, sequence: number) => mutate(async () => {
      await load();
      const current = state.conversations.find((entry) => entry.id === identifier(id, "conversation id"));
      if (!current) throw new Error("conversation not found");
      const updated = Object.freeze({ ...current, lastReadSequence: Math.max(current.lastReadSequence, nonNegativeInteger(sequence, "sequence")), updatedAt: new Date().toISOString() });
      state = { ...state, conversations: Object.freeze(state.conversations.map((entry) => entry.id === current.id ? updated : entry)) };
      await persist();
      events.publish({ type: "conversation.read", source: "conversations", subject: `conversation:${current.id}`, data: { conversationId: current.id, sequence: updated.lastReadSequence } });
      return updated;
    }),
    createThread: (conversationId: string, rootMessageId: string) => mutate(async () => {
      await load();
      const id = identifier(conversationId, "conversationId");
      if (!state.conversations.some((entry) => entry.id === id)) throw new Error("conversation not found");
      if (state.threads.length >= MAX_THREADS) throw new Error("thread limit reached");
      const thread: Thread = Object.freeze({ id: randomUUID(), conversationId: id, rootMessageId: identifier(rootMessageId, "rootMessageId"), replyCount: 0, createdAt: new Date().toISOString() });
      state = { ...state, threads: Object.freeze([...state.threads, thread]) };
      await persist();
      events.publish({ type: "conversation.thread.created", source: "conversations", subject: `conversation:${id}`, data: { conversationId: id, threadId: thread.id, rootMessageId: thread.rootMessageId } });
      return thread;
    }),
    recordThreadReply: (threadId: string) => mutate(async () => {
      await load();
      const id = identifier(threadId, "threadId");
      const current = state.threads.find((entry) => entry.id === id);
      if (!current) throw new Error("thread not found");
      const updated: Thread = Object.freeze({ ...current, replyCount: current.replyCount + 1, lastReplyAt: new Date().toISOString() });
      state = { ...state, threads: Object.freeze(state.threads.map((entry) => entry.id === id ? updated : entry)) };
      await persist();
      events.publish({ type: "conversation.thread.reply-recorded", source: "conversations", subject: `conversation:${current.conversationId}`, data: { conversationId: current.conversationId, threadId: id, replyCount: updated.replyCount } });
      return updated;
    }),
    listThreads: (conversationId: string) => Object.freeze(state.threads.filter((entry) => entry.conversationId === conversationId)),
    resolveMentions: (conversationId: string, messageText: string): ConversationMentions => {
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) throw new Error("conversation not found");
      const names = [...messageText.matchAll(/@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gi)].map((match) => match[1]!.toLowerCase());
      const includesEveryone = names.includes("everyone");
      const participantIds = new Set(conversation.participants.filter((entry) => entry.kind === "agent").map((entry) => entry.id));
      const agentIds = Object.freeze([...new Set(names.filter((name) => name !== "everyone" && participantIds.has(name)))]);
      return Object.freeze({ agentIds, includesEveryone });
    },
    addReaction: (messageId: string, actorId: string, emoji: string) => mutate(async () => {
      await load();
      const reaction: Reaction = Object.freeze({ messageId: identifier(messageId, "messageId"), actorId: identifier(actorId, "actorId"), emoji: text(emoji, "emoji", 32), createdAt: new Date().toISOString() });
      if (state.reactions.some((entry) => entry.messageId === reaction.messageId && entry.actorId === reaction.actorId && entry.emoji === reaction.emoji)) return state.reactions.find((entry) => entry.messageId === reaction.messageId && entry.actorId === reaction.actorId && entry.emoji === reaction.emoji)!;
      if (state.reactions.length >= MAX_REACTIONS) throw new Error("reaction limit reached");
      state = { ...state, reactions: Object.freeze([...state.reactions, reaction]) };
      await persist();
      events.publish({ type: "conversation.reaction.added", source: "conversations", subject: `message:${reaction.messageId}`, data: { messageId: reaction.messageId, actorId: reaction.actorId, emoji: reaction.emoji } });
      return reaction;
    }),
    removeReaction: (messageId: string, actorId: string, emoji: string) => mutate(async () => {
      await load();
      const m = identifier(messageId, "messageId"); const a = identifier(actorId, "actorId"); const e = text(emoji, "emoji", 32);
      const before = state.reactions.length;
      state = { ...state, reactions: Object.freeze(state.reactions.filter((entry) => !(entry.messageId === m && entry.actorId === a && entry.emoji === e))) };
      if (before === state.reactions.length) return false;
      await persist();
      events.publish({ type: "conversation.reaction.removed", source: "conversations", subject: `message:${m}`, data: { messageId: m, actorId: a, emoji: e } });
      return true;
    }),
    listReactions: (messageId: string) => Object.freeze(state.reactions.filter((entry) => entry.messageId === messageId)),
    createHandoff: (input: ConversationHandoffInput, execution?: HandoffExecution) => mutate(async () => {
      await load();
      const conversationId = identifier(input.conversationId, "conversationId");
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) throw new Error("conversation not found");
      const fromAgentId = identifier(input.fromAgentId, "fromAgentId");
      const toAgentId = identifier(input.toAgentId, "toAgentId");
      if (!profiles.get(fromAgentId) || !profiles.get(toAgentId)) throw new Error("handoff agents must be existing Agent Profiles");
      if (!conversation.participants.some((entry) => entry.kind === "agent" && entry.id === fromAgentId) || !conversation.participants.some((entry) => entry.kind === "agent" && entry.id === toAgentId)) throw new Error("handoff agents must participate in the conversation");
      const now = new Date().toISOString();
      let jobId: string | undefined;
      let status: HandoffStatus = "queued";
      const sessionId = sessionIdentifier(input.sessionId ?? conversation.sessionId);
      if (jobs && execution) {
        const job = await jobs.start({ sourceKey: `handoff:${randomUUID()}`, destinationId: `session:${sessionId}`, agentProfileId: toAgentId, text: input.text, timestamp: Date.now(), origin: execution.origin ?? { authority: "local", channel: "local", accountId: "operator", conversationId, senderId: fromAgentId }, run: execution.run, notify: execution.notify ?? (async () => undefined) });
        jobId = job.id;
        status = job.status === "running" ? "running" : "queued";
      }
      const handoff: ConversationHandoff = Object.freeze({ id: randomUUID(), conversationId, fromAgentId, toAgentId, text: text(input.text, "handoff text", 24_000), ...(jobId === undefined ? {} : { jobId }), sessionId, status, createdAt: now, updatedAt: now });
      if (state.handoffs.length >= MAX_HANDOFFS) throw new Error("handoff limit reached");
      state = { ...state, handoffs: Object.freeze([...state.handoffs, handoff]) };
      await persist();
      if (sessions) {
        const sessionsDir = join(fridayRoot(), "sessions");
        const sessionInfo = (await sessions.SessionManager.listAll(undefined, sessionsDir)).find((entry) => entry.id === sessionId);
        if (sessionInfo) {
          const session = sessions.SessionManager.open(sessionInfo.path, sessionsDir);
          session.appendCustomEntry("conversation.handoff", {
            handoffId: handoff.id,
            conversationId,
            fromAgentId,
            toAgentId,
            text: handoff.text,
            ...(jobId === undefined ? {} : { jobId }),
          });
          session.flushNow();
        }
      }
      events.publish({ type: "conversation.handoff.created", source: "conversations", subject: `conversation:${conversationId}`, data: { handoffId: handoff.id, fromAgentId, toAgentId, ...(jobId === undefined ? {} : { jobId }), sessionId, status } });
      return handoff;
    }),
    listHandoffs: (conversationId?: string) => Object.freeze(state.handoffs.filter((entry) => conversationId === undefined || entry.conversationId === conversationId).map((entry) => currentHandoff(entry, jobs))),
  });
  ctx.services.provide(CONVERSATIONS_CAPABILITY, service);
  ctx.contribute(SYSTEM_STATUS_CONTRIBUTION, { id: "conversations", label: "Conversations", snapshot: () => ({ conversations: service.list().length, handoffs: service.listHandoffs().length }) });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "conversations.list", label: "List Conversations", description: "List direct and group conversation metadata linked to durable Sessions.",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    permission: () => ({ id: "conversations.list", effect: "private-read", resource: "conversations", network: false }),
    execute: async () => { await load(); return service.list(); },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "conversations.create", label: "Create Conversation", description: "Create a direct or group Conversation metadata record over a durable Session.",
    parameters: Object.freeze({ type: "object", properties: { type: { type: "string", enum: ["direct", "group"] }, title: { type: "string" }, sessionId: { type: "string" }, participants: { type: "array" } }, required: ["type", "participants"], additionalProperties: false }),
    permission: () => ({ id: "conversations.create", effect: "system-write", resource: "conversations", network: false }),
    execute: async (input: Readonly<SystemJsonObject>) => service.create({ type: input.type as "direct" | "group", ...(input.title === undefined ? {} : { title: text(input.title, "title", 256) }), ...(input.sessionId === undefined ? {} : { sessionId: text(input.sessionId, "sessionId", 256) }), participants: input.participants as readonly ConversationParticipant[] }),
  });
  ctx.effect(() => { loaded = false; state = emptyState(); });
});

export default conversationsPlugin;
export * from "./contract.js";
