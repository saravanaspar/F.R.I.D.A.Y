import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FridayPlugin } from "../../src/plugin.js";
import { definePlugin } from "../capabilities/protocol.js";
import { CHANNEL_TURN_ENRICHER_CONTRIBUTION, type ChannelTurnEnrichment, type ChannelTurnIngressContext } from "../channels/contract.js";
import { AGENT_PROFILES_CAPABILITY, type AgentProfile, type AgentProfilesService } from "../agent-profiles/contract.js";
import { EVENTS_CAPABILITY, type EventsService } from "../events/contract.js";
import { conversationScope } from "../principal-scope.js";
import { SESSION_JOBS_CAPABILITY, type SessionJobsService } from "../session-jobs/contract.js";
import { SESSIONS_CAPABILITY, type SessionsService } from "../sessions/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION, SYSTEM_STATUS_CONTRIBUTION, type SystemJsonObject } from "../system/contract.js";
import { CONVERSATIONS_CAPABILITY, type ChannelConversationBinding, type ChannelConversationBindingInput, type ChannelConversationLookup, type Conversation, type ConversationCreateInput, type ConversationHandoff, type ConversationHandoffInput, type ConversationMentions, type ConversationParticipant, type ConversationParticipantKind, type ConversationUpdateInput, type ConversationsService, type HandoffExecution, type HandoffStatus, type Reaction, type Thread } from "./contract.js";

const MAX_CONVERSATIONS = 2_048;
const MAX_THREADS = 100_000;
const MAX_REACTIONS = 100_000;
const MAX_HANDOFFS = 100_000;
const MAX_PARTICIPANTS = 2_048;

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
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PARTICIPANTS) throw new Error(`a conversation needs between 1 and ${MAX_PARTICIPANTS} participants`);
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
  const type = conversationType(raw.type);
  const participants = participantList(raw.participants as readonly ConversationParticipant[]);
  if (type === "direct" && participants.length !== 2) throw new Error("direct conversations must have exactly two participants");
  return Object.freeze({
    id: identifier(raw.id, "conversation id"),
    type,
    title: text(raw.title, "conversation title", 256),
    sessionId: sessionIdentifier(raw.sessionId),
    participants,
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

function sessionJobHandoffStatus(value: ReturnType<SessionJobsService["get"]>): HandoffStatus {
  if (!value) return "queued";
  if (value.status === "queued") return "queued";
  if (value.status === "running" || value.status === "retrying") return "running";
  if (value.status === "completed" || value.status === "resumed") return "completed";
  return "error";
}

function currentHandoff(handoff: ConversationHandoff, jobs: SessionJobsService | undefined): ConversationHandoff {
  if (!handoff.jobId || !jobs) return handoff;
  const job = jobs.get(handoff.jobId);
  if (!job) return handoff;
  const status = sessionJobHandoffStatus(job);
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


function bindingMode(value: unknown): "general" | "sticky" | "auto" {
  if (value !== "general" && value !== "sticky" && value !== "auto") throw new Error("invalid channel conversation mode");
  return value;
}

function parseBinding(value: unknown): ChannelConversationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid channel conversation binding");
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    id: identifier(raw.id, "binding id"),
    channel: text(raw.channel, "binding channel", 64),
    accountId: identifier(raw.accountId, "binding accountId"),
    externalConversationId: identifier(raw.externalConversationId, "binding externalConversationId"),
    ...(raw.externalThreadId === undefined ? {} : { externalThreadId: identifier(raw.externalThreadId, "binding externalThreadId") }),
    conversationId: identifier(raw.conversationId, "binding conversationId"),
    mode: bindingMode(raw.mode),
    ...(raw.defaultAgentProfileId === undefined ? {} : { defaultAgentProfileId: identifier(raw.defaultAgentProfileId, "binding defaultAgentProfileId") }),
    createdAt: text(raw.createdAt, "createdAt", 64),
    updatedAt: text(raw.updatedAt, "updatedAt", 64),
  });
}

function channelBindingKey(input: ChannelConversationLookup): string {
  return createHash("sha256").update(JSON.stringify([
    text(input.channel, "channel", 64).toLowerCase(),
    identifier(input.accountId, "accountId"),
    identifier(input.externalConversationId, "externalConversationId"),
    input.externalThreadId === undefined ? "" : identifier(input.externalThreadId, "externalThreadId"),
  ])).digest("hex").slice(0, 32);
}

function channelUserId(context: Pick<ChannelTurnIngressContext, "principal">): string {
  const p = context.principal;
  const digest = createHash("sha256").update(JSON.stringify([p.channel, p.accountId, p.senderId])).digest("hex").slice(0, 32);
  return `channel-user:${digest}`;
}

function profileLabel(profile: AgentProfile): string {
  return profile.title.trim() || profile.name.trim() || profile.id;
}

function selectionTokens(value: string): readonly string[] {
  return Object.freeze([...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 64));
}

function autoSelectProfile(messageText: string, candidates: readonly AgentProfile[]): AgentProfile | undefined {
  const query = selectionTokens(messageText);
  if (query.length === 0) return undefined;
  return candidates
    .map((profile) => {
      const haystack = `${profile.id} ${profile.name} ${profile.title} ${profile.description} ${profile.roleInstructions}`.toLowerCase();
      const score = query.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { profile, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id))[0]?.profile;
}

function stripInternalMentions(value: string, agentIds: readonly string[], everyone: boolean): string {
  const names = new Set(agentIds.map((entry) => entry.toLowerCase()));
  return value.replace(/@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gi, (match, raw: string) => {
    const name = raw.toLowerCase();
    return names.has(name) || (everyone && name === "everyone") ? "" : match;
  }).replace(/[ \t]{2,}/g, " ").trim();
}

async function ensureSharedSession(sessions: SessionsService | undefined, conversation: Conversation): Promise<void> {
  if (!sessions) return;
  const sessionsDir = join(fridayRoot(), "sessions");
  const sessionPath = join(sessionsDir, `${conversation.sessionId}.jsonl`);
  const expectedOwner = conversationScope(conversation.id);
  if (existsSync(sessionPath)) {
    const owner = sessions.readSessionOwnerScope(sessionPath);
    if (owner !== expectedOwner) throw new Error(`conversation session ${conversation.sessionId} is not owned by the shared Conversation`);
    return;
  }
  const session = sessions.SessionManager.create(process.cwd(), sessionsDir, {
    id: conversation.sessionId,
    ownerScope: expectedOwner,
  });
  session.appendCustomEntry("conversation.created", { conversationId: conversation.id, type: conversation.type, title: conversation.title });
  session.flushNow();
}

interface StateFile {
  readonly schema: 2;
  readonly conversations: readonly Conversation[];
  readonly threads: readonly Thread[];
  readonly reactions: readonly Reaction[];
  readonly handoffs: readonly ConversationHandoff[];
  readonly bindings: readonly ChannelConversationBinding[];
}

function emptyState(): StateFile {
  return { schema: 2, conversations: [], threads: [], reactions: [], handoffs: [], bindings: [] };
}

async function readState(): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(join(stateRoot(), "state.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid conversation state");
    const raw = parsed as Record<string, unknown>;
    if ((raw.schema !== 1 && raw.schema !== 2) || !Array.isArray(raw.conversations) || !Array.isArray(raw.threads) || !Array.isArray(raw.reactions) || !Array.isArray(raw.handoffs)) throw new Error("unsupported conversation state");
    const rawBindings = raw.schema === 2 ? raw.bindings : [];
    if (!Array.isArray(rawBindings)) throw new Error("unsupported conversation bindings state");
    if (raw.conversations.length > MAX_CONVERSATIONS || raw.threads.length > MAX_THREADS || raw.reactions.length > MAX_REACTIONS || raw.handoffs.length > MAX_HANDOFFS || rawBindings.length > MAX_CONVERSATIONS * 8) throw new Error("conversation state exceeds limits");
    return { schema: 2, conversations: Object.freeze(raw.conversations.map(parseConversation)), threads: Object.freeze(raw.threads.map(parseThread)), reactions: Object.freeze(raw.reactions.map(parseReaction)), handoffs: Object.freeze(raw.handoffs.map(parseHandoff)), bindings: Object.freeze(rawBindings.map(parseBinding)) };
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
      await ensureSharedSession(sessions, conversation);
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
    ensureParticipant: (id: string, inputParticipant: ConversationParticipant) => mutate(async () => {
      await load();
      const conversationId = identifier(id, "conversation id");
      const current = state.conversations.find((entry) => entry.id === conversationId);
      if (!current) throw new Error("conversation not found");
      const normalized = participant(inputParticipant);
      if (current.participants.some((entry) => entry.kind === normalized.kind && entry.id === normalized.id)) return current;
      if (current.type === "direct") throw new Error("direct conversations cannot add participants; bind channels to a group Conversation when participant enrollment is required");
      if (current.participants.length >= MAX_PARTICIPANTS) throw new Error("conversation participant limit reached");
      const updated: Conversation = Object.freeze({ ...current, participants: Object.freeze([...current.participants, normalized]), updatedAt: new Date().toISOString() });
      state = { ...state, conversations: Object.freeze(state.conversations.map((entry) => entry.id === current.id ? updated : entry)) };
      await persist();
      events.publish({ type: "conversation.participant.added", source: "conversations", subject: `conversation:${current.id}`, data: { conversationId: current.id, kind: normalized.kind, participantId: normalized.id } });
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
    bindChannel: (input: ChannelConversationBindingInput) => mutate(async () => {
      await load();
      const lookup: ChannelConversationLookup = {
        channel: text(input.channel, "channel", 64).toLowerCase(),
        accountId: identifier(input.accountId, "accountId"),
        externalConversationId: identifier(input.externalConversationId, "externalConversationId"),
        ...(input.externalThreadId === undefined ? {} : { externalThreadId: identifier(input.externalThreadId, "externalThreadId") }),
      };
      const conversationId = identifier(input.conversationId, "conversationId");
      const conversation = state.conversations.find((entry) => entry.id === conversationId);
      if (!conversation) throw new Error("conversation not found");
      await ensureSharedSession(sessions, conversation);
      const mode = bindingMode(input.mode);
      const defaultAgentProfileId = input.defaultAgentProfileId === undefined ? undefined : identifier(input.defaultAgentProfileId, "defaultAgentProfileId");
      if (mode === "sticky" && !defaultAgentProfileId) throw new Error("sticky channel bindings require a default Agent Profile");
      if (defaultAgentProfileId) {
        if (!profiles.get(defaultAgentProfileId)) throw new Error(`Agent Profile not found: ${defaultAgentProfileId}`);
        if (!conversation.participants.some((entry) => entry.kind === "agent" && entry.id === defaultAgentProfileId)) throw new Error("default Agent Profile must participate in the conversation");
      }
      const now = new Date().toISOString();
      const id = channelBindingKey(lookup);
      const existing = state.bindings.find((entry) => entry.id === id);
      const binding: ChannelConversationBinding = Object.freeze({ id, ...lookup, conversationId, mode, ...(defaultAgentProfileId === undefined ? {} : { defaultAgentProfileId }), createdAt: existing?.createdAt ?? now, updatedAt: now });
      state = { ...state, bindings: Object.freeze([...state.bindings.filter((entry) => entry.id !== id), binding]) };
      await persist();
      events.publish({ type: "conversation.channel-bound", source: "conversations", subject: `conversation:${conversationId}`, data: { conversationId, bindingId: id, channel: lookup.channel, mode } });
      return binding;
    }),
    resolveChannelBinding: (input: ChannelConversationLookup) => {
      const exactId = channelBindingKey(input);
      const exact = state.bindings.find((entry) => entry.id === exactId);
      if (exact) return exact;
      if (input.externalThreadId === undefined) return undefined;
      const fallbackId = channelBindingKey({ channel: input.channel, accountId: input.accountId, externalConversationId: input.externalConversationId });
      return state.bindings.find((entry) => entry.id === fallbackId);
    },
    listChannelBindings: (conversationId?: string) => Object.freeze(state.bindings.filter((entry) => conversationId === undefined || entry.conversationId === conversationId)),
    removeChannelBinding: (input: ChannelConversationLookup) => mutate(async () => {
      await load();
      const id = channelBindingKey(input);
      const existing = state.bindings.find((entry) => entry.id === id);
      if (!existing) return false;
      state = { ...state, bindings: Object.freeze(state.bindings.filter((entry) => entry.id !== id)) };
      await persist();
      events.publish({ type: "conversation.channel-unbound", source: "conversations", subject: `conversation:${existing.conversationId}`, data: { conversationId: existing.conversationId, bindingId: id } });
      return true;
    }),
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
      if (!profiles.get(toAgentId)) throw new Error("handoff target must be an existing Agent Profile");
      if (fromAgentId !== "friday" && !profiles.get(fromAgentId)) throw new Error("handoff source must be FRIDAY or an existing Agent Profile");
      if ((fromAgentId !== "friday" && !conversation.participants.some((entry) => entry.kind === "agent" && entry.id === fromAgentId)) || !conversation.participants.some((entry) => entry.kind === "agent" && entry.id === toAgentId)) throw new Error("handoff agents must participate in the conversation");
      const now = new Date().toISOString();
      let jobId: string | undefined = input.jobId === undefined ? undefined : identifier(input.jobId, "jobId");
      let status: HandoffStatus = sessionJobHandoffStatus(jobId ? jobs?.get(jobId) : undefined);
      const sessionId = sessionIdentifier(input.sessionId ?? conversation.sessionId);
      if (jobs && execution) {
        const job = await jobs.start({
          sourceKey: execution.sourceKey ?? `handoff:${randomUUID()}`,
          destinationId: `session:${sessionId}`,
          agentProfileId: toAgentId,
          text: input.text,
          timestamp: Date.now(),
          origin: execution.origin ?? { authority: "local", channel: "local", accountId: "operator", conversationId, senderId: fromAgentId, sharedConversationId: conversationId },
          run: execution.run,
          notify: execution.notify ?? (async () => undefined),
        });
        jobId = job.id;
        status = sessionJobHandoffStatus(job);
      }
      const handoff: ConversationHandoff = Object.freeze({ id: randomUUID(), conversationId, fromAgentId, toAgentId, text: text(input.text, "handoff text", 24_000), ...(jobId === undefined ? {} : { jobId }), sessionId, status, createdAt: now, updatedAt: now });
      if (state.handoffs.length >= MAX_HANDOFFS) throw new Error("handoff limit reached");
      state = { ...state, handoffs: Object.freeze([...state.handoffs, handoff]) };
      await persist();
      if (sessions) {
        const sessionsDir = join(fridayRoot(), "sessions");
        const sessionInfo = (await sessions.SessionManager.listAll(undefined, sessionsDir)).find((entry: { readonly id: string; readonly path: string }) => entry.id === sessionId);
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

  ctx.contribute(CHANNEL_TURN_ENRICHER_CONTRIBUTION, {
    id: "conversations.channel-context",
    priority: 100,
    async enrich(context: ChannelTurnIngressContext): Promise<ChannelTurnEnrichment | undefined> {
      await load();
      const lookup: ChannelConversationLookup = {
        channel: context.principal.channel,
        accountId: context.principal.accountId,
        externalConversationId: context.principal.conversationId,
        ...(context.principal.threadId === undefined ? {} : { externalThreadId: context.principal.threadId }),
      };
      const userParticipant: ConversationParticipant = { kind: "user", id: channelUserId(context) };
      const exactBindingId = channelBindingKey(lookup);
      let binding = service.listChannelBindings().find((entry) => entry.id === exactBindingId);
      const inheritedBinding = binding === undefined && lookup.externalThreadId !== undefined
        ? service.resolveChannelBinding(lookup)
        : undefined;
      const allProfiles = profiles.list().slice().sort((left, right) => left.id.localeCompare(right.id));
      const command = context.text.trim().match(/^\/agent(?:@\w+)?(?:\s+(.+))?$/i);
      const listCommand = /^\/agents(?:@\w+)?\s*$/i.test(context.text.trim());

      const createBoundConversation = async (agentIds: readonly string[], mode: "general" | "sticky" | "auto", defaultAgentProfileId?: string): Promise<ChannelConversationBinding> => {
        const participantIds = [...new Set(agentIds)].slice(0, MAX_PARTICIPANTS - 1);
        const conversationId = `channel-${channelBindingKey(lookup)}`;
        let conversation = service.get(conversationId);
        if (!conversation) {
          conversation = await service.create({
            id: conversationId,
            type: "group",
            title: context.conversationName?.trim() || `${context.principal.channel} conversation`,
            participants: [userParticipant, ...participantIds.map((id) => ({ kind: "agent" as const, id }))],
          });
        } else {
          await service.ensureParticipant(conversation.id, userParticipant);
          for (const id of participantIds) await service.ensureParticipant(conversation.id, { kind: "agent", id });
        }
        return service.bindChannel({ ...lookup, conversationId: conversation.id, mode, ...(defaultAgentProfileId === undefined ? {} : { defaultAgentProfileId }) });
      };
      const agentIdsForBinding = (candidate: ChannelConversationBinding | undefined): readonly string[] => {
        if (!candidate) return Object.freeze([]);
        const conversation = service.get(candidate.conversationId);
        if (!conversation) return Object.freeze([]);
        return Object.freeze(conversation.participants
          .filter((entry) => entry.kind === "agent" && profiles.get(entry.id) !== undefined)
          .map((entry) => entry.id));
      };
      const bindingIsManaged = (candidate: ChannelConversationBinding, conversation: Conversation): boolean =>
        conversation.id === `channel-${candidate.id}`;

      if (listCommand) {
        const lines = allProfiles.map((profile) => `@${profile.id} — ${profileLabel(profile)}${profile.description.trim() ? `: ${profile.description.trim()}` : ""}`);
        return Object.freeze({ handled: true, replyText: lines.length === 0 ? "No named Agent Profiles are configured." : `Available Agents:
${lines.join("\n")}

Use @agent-id for one turn, /agent agent-id to make it sticky here, /agent auto for automatic selection, or /agent general for FRIDAY.` });
      }

      if (command) {
        const requested = command[1]?.trim().toLowerCase();
        if (!requested) {
          const effective = binding ?? inheritedBinding;
          if (!effective) return Object.freeze({ handled: true, replyText: "This chat/topic currently uses general FRIDAY. Use /agents to list profiles, /agent <id> for sticky routing, or /agent auto." });
          const current = effective.mode === "sticky" ? `sticky @${effective.defaultAgentProfileId}` : effective.mode;
          return Object.freeze({
            handled: true,
            replyText: binding
              ? `This chat/topic is bound to Conversation ${effective.conversationId} using ${current} routing.`
              : `This topic currently inherits ${current} routing from its parent chat. Its first normal turn or explicit /agent choice will create topic-specific shared Conversation continuity.`,
          });
        }
        if (requested === "reset" || requested === "off") {
          const removed = await service.removeChannelBinding(lookup);
          if (removed) {
            const inherited = service.resolveChannelBinding(lookup);
            return Object.freeze({
              handled: true,
              replyText: inherited
                ? `This topic-specific binding was removed. It now inherits ${inherited.mode === "sticky" ? `sticky @${inherited.defaultAgentProfileId}` : inherited.mode} routing from the parent chat.`
                : "This chat/topic binding was removed. General FRIDAY routing is active again.",
            });
          }
          if (inheritedBinding) {
            return Object.freeze({ handled: true, replyText: `No topic-specific binding was present. This topic inherits ${inheritedBinding.mode === "sticky" ? `sticky @${inheritedBinding.defaultAgentProfileId}` : inheritedBinding.mode} routing from the parent chat; use /agent general to override it here.` });
          }
          return Object.freeze({ handled: true, replyText: "No chat/topic binding was present. General FRIDAY routing is already active." });
        }
        if (requested === "general") {
          if (!binding) {
            const allowed = inheritedBinding ? agentIdsForBinding(inheritedBinding) : allProfiles.map((profile) => profile.id);
            binding = await createBoundConversation(allowed, "general");
          } else {
            binding = await service.bindChannel({ ...lookup, conversationId: binding.conversationId, mode: "general" });
          }
          await service.ensureParticipant(binding.conversationId, userParticipant);
          return Object.freeze({ handled: true, replyText: "General FRIDAY is now the default for this chat/topic. Named @Agent mentions still override it for one turn." });
        }
        if (requested === "auto") {
          if (!binding) {
            const allowed = inheritedBinding ? agentIdsForBinding(inheritedBinding) : allProfiles.map((profile) => profile.id);
            if (allowed.length === 0) return Object.freeze({ handled: true, replyText: "Auto routing needs at least one Agent Profile allowed in this Conversation." });
            binding = await createBoundConversation(allowed, "auto");
          } else {
            const conversation = service.get(binding.conversationId);
            if (!conversation) return Object.freeze({ handled: true, replyText: "This channel binding points to a missing F.R.I.D.A.Y Conversation. Use /agent reset and bind it again." });
            if (bindingIsManaged(binding, conversation)) {
              for (const profile of allProfiles) await service.ensureParticipant(conversation.id, { kind: "agent", id: profile.id });
            }
            if (agentIdsForBinding(binding).length === 0) return Object.freeze({ handled: true, replyText: "Auto routing needs at least one Agent Profile allowed in this Conversation." });
            binding = await service.bindChannel({ ...lookup, conversationId: binding.conversationId, mode: "auto" });
          }
          await service.ensureParticipant(binding.conversationId, userParticipant);
          return Object.freeze({ handled: true, replyText: "Automatic Agent Profile selection is now enabled for this chat/topic. Explicit @Agent mentions still take precedence." });
        }
        const requestedProfile = profiles.get(requested);
        if (!requestedProfile) return Object.freeze({ handled: true, replyText: `Agent Profile @${requested} does not exist. Use /agents to list available profiles.` });
        if (!binding) {
          if (inheritedBinding) {
            const allowed = agentIdsForBinding(inheritedBinding);
            if (!allowed.includes(requestedProfile.id)) {
              return Object.freeze({ handled: true, replyText: `@${requestedProfile.id} is not allowed in the parent Conversation for this topic.` });
            }
            binding = await createBoundConversation(allowed, "sticky", requestedProfile.id);
          } else {
            binding = await createBoundConversation([requestedProfile.id], "sticky", requestedProfile.id);
          }
        } else {
          const conversation = service.get(binding.conversationId);
          if (!conversation) return Object.freeze({ handled: true, replyText: "This channel binding points to a missing F.R.I.D.A.Y Conversation. Use /agent reset and bind it again." });
          const alreadyAllowed = conversation.participants.some((entry) => entry.kind === "agent" && entry.id === requestedProfile.id);
          if (!alreadyAllowed && !bindingIsManaged(binding, conversation)) {
            return Object.freeze({ handled: true, replyText: `@${requestedProfile.id} is not a participant in this administratively bound Conversation.` });
          }
          if (!alreadyAllowed) await service.ensureParticipant(conversation.id, { kind: "agent", id: requestedProfile.id });
          binding = await service.bindChannel({ ...lookup, conversationId: binding.conversationId, mode: "sticky", defaultAgentProfileId: requestedProfile.id });
        }
        await service.ensureParticipant(binding.conversationId, userParticipant);
        return Object.freeze({ handled: true, replyText: `${profileLabel(requestedProfile)} (@${requestedProfile.id}) is now sticky for this chat/topic. Use /agent general to return to FRIDAY or /agent auto for automatic selection.` });
      }

      const rawMentionNames = [...context.text.matchAll(/@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gi)].map((match) => match[1]!.toLowerCase());
      const rawProfileMentions = [...new Set(rawMentionNames.filter((name) => name !== "everyone" && profiles.get(name) !== undefined))];
      const wantsEveryone = rawMentionNames.includes("everyone");
      const sharedSurface = context.chatType === "group" || context.chatType === "channel" || context.chatType === "thread";

      if (!binding && inheritedBinding) {
        const inheritedAgentIds = agentIdsForBinding(inheritedBinding);
        const inheritedDefaultAgentProfileId = inheritedBinding.defaultAgentProfileId !== undefined
          && inheritedAgentIds.includes(inheritedBinding.defaultAgentProfileId)
          ? inheritedBinding.defaultAgentProfileId
          : undefined;
        const inheritedMode = inheritedBinding.mode === "sticky" && inheritedDefaultAgentProfileId === undefined
          ? "general"
          : inheritedBinding.mode;
        binding = await createBoundConversation(inheritedAgentIds, inheritedMode, inheritedDefaultAgentProfileId);
      } else if (!binding && sharedSurface) {
        if (wantsEveryone && allProfiles.length === 0) {
          return Object.freeze({ handled: true, replyText: "@everyone cannot fan out because no named Agent Profiles are configured." });
        }
        binding = await createBoundConversation(allProfiles.map((profile) => profile.id), "general");
      } else if (!binding && rawProfileMentions.length > 0) {
        binding = await createBoundConversation(rawProfileMentions, "general");
      } else if (!binding && wantsEveryone) {
        return Object.freeze({ handled: true, replyText: "@everyone needs a bound F.R.I.D.A.Y Conversation. Use /agent auto (or /agent <id>) in this chat/topic first." });
      } else if (!binding) {
        return undefined;
      }

      let conversation = service.get(binding.conversationId);
      if (!conversation) return Object.freeze({ handled: true, replyText: "This channel binding points to a missing F.R.I.D.A.Y Conversation. Use /agent reset and bind it again." });
      conversation = await service.ensureParticipant(conversation.id, userParticipant);
      if (bindingIsManaged(binding, conversation)) {
        for (const id of rawProfileMentions) conversation = await service.ensureParticipant(conversation.id, { kind: "agent", id });
      }
      const allowedAgentIds = new Set(conversation.participants.filter((entry) => entry.kind === "agent").map((entry) => entry.id));
      const disallowedMention = rawProfileMentions.find((id) => !allowedAgentIds.has(id));
      if (disallowedMention) {
        return Object.freeze({ handled: true, replyText: `@${disallowedMention} is a valid Agent Profile but is not a participant in this Conversation. Use /agent ${disallowedMention} to add/select it here.` });
      }

      const mentions = service.resolveMentions(conversation.id, context.text);
      const explicitIds = [...mentions.agentIds];
      const participantProfiles = conversation.participants
        .filter((entry) => entry.kind === "agent")
        .flatMap((entry) => { const profile = profiles.get(entry.id); return profile ? [profile] : []; });
      if (mentions.includesEveryone && participantProfiles.length === 0) {
        return Object.freeze({ handled: true, replyText: "@everyone cannot fan out because this Conversation has no named Agent Profiles." });
      }
      let selected: AgentProfile | undefined = explicitIds.length > 0 ? profiles.get(explicitIds[0]!) : undefined;
      if (!selected && binding.mode === "sticky" && binding.defaultAgentProfileId) selected = profiles.get(binding.defaultAgentProfileId);
      if (!selected && binding.mode === "auto") selected = autoSelectProfile(context.text, participantProfiles);

      const targetIds = new Set<string>();
      for (const id of explicitIds.slice(selected ? 1 : 0)) targetIds.add(id);
      if (mentions.includesEveryone) for (const profile of participantProfiles) if (profile.id !== selected?.id) targetIds.add(profile.id);
      const totalNamedAgents = targetIds.size + (selected ? 1 : 0);
      if (totalNamedAgents > 4) return Object.freeze({ handled: true, replyText: `This message targets ${totalNamedAgents} Agents. The channel fan-out limit is 4; mention a smaller set.` });

      let internalThreadId: string | undefined;
      if (context.replyToMessageId) {
        let thread = service.listThreads(conversation.id).find((entry) => entry.rootMessageId === context.replyToMessageId);
        if (!thread) thread = await service.createThread(conversation.id, context.replyToMessageId);
        thread = await service.recordThreadReply(thread.id);
        internalThreadId = thread.id;
      }

      const collaboratingAgents = [...targetIds].flatMap((id) => {
        const profile = profiles.get(id);
        return profile ? [{ id: profile.id, label: profileLabel(profile), notificationPreference: profile.notificationPreference }] : [];
      });
      const cleaned = stripInternalMentions(context.text, [...explicitIds, ...targetIds], mentions.includesEveryone);
      return Object.freeze({
        text: cleaned || "Please respond and ask how you can help.",
        sharedConversationId: conversation.id,
        sessionAffinityId: conversation.sessionId,
        ...(selected === undefined ? {} : { agentProfileId: selected.id, agentProfileLabel: profileLabel(selected), agentNotificationPreference: selected.notificationPreference }),
        ...(collaboratingAgents.length === 0 ? {} : { collaboratingAgents: Object.freeze(collaboratingAgents) }),
        ...(internalThreadId === undefined ? {} : { internalThreadId }),
      });
    },
  });

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
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "conversations.channel-bindings", label: "List Channel Bindings", description: "List persisted external channel/chat/topic bindings to internal Conversations.",
    parameters: Object.freeze({ type: "object", properties: { conversationId: { type: "string" } }, additionalProperties: false }),
    permission: () => ({ id: "conversations.channel-bindings", effect: "private-read", resource: "conversations", network: false }),
    execute: async (input: Readonly<SystemJsonObject>) => {
      await load();
      return service.listChannelBindings(input.conversationId === undefined ? undefined : text(input.conversationId, "conversationId", 256));
    },
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "conversations.bind-channel", label: "Bind Channel Conversation", description: "Bind an external channel chat/topic to an existing internal Conversation and choose general, sticky, or auto Agent routing.",
    parameters: Object.freeze({ type: "object", properties: { channel: { type: "string" }, accountId: { type: "string" }, externalConversationId: { type: "string" }, externalThreadId: { type: "string" }, conversationId: { type: "string" }, mode: { type: "string", enum: ["general", "sticky", "auto"] }, defaultAgentProfileId: { type: "string" } }, required: ["channel", "accountId", "externalConversationId", "conversationId", "mode"], additionalProperties: false }),
    permission: () => ({ id: "conversations.bind-channel", effect: "system-write", resource: "conversations", network: false }),
    execute: async (input: Readonly<SystemJsonObject>) => service.bindChannel({
      channel: text(input.channel, "channel", 64),
      accountId: text(input.accountId, "accountId", 256),
      externalConversationId: text(input.externalConversationId, "externalConversationId", 256),
      ...(input.externalThreadId === undefined ? {} : { externalThreadId: text(input.externalThreadId, "externalThreadId", 256) }),
      conversationId: text(input.conversationId, "conversationId", 256),
      mode: bindingMode(input.mode),
      ...(input.defaultAgentProfileId === undefined ? {} : { defaultAgentProfileId: text(input.defaultAgentProfileId, "defaultAgentProfileId", 96).toLowerCase() }),
    }),
  });
  ctx.contribute(SYSTEM_ACTION_CONTRIBUTION, {
    id: "conversations.unbind-channel", label: "Unbind Channel Conversation", description: "Remove an external channel chat/topic binding and restore ordinary FRIDAY routing for that surface.",
    parameters: Object.freeze({ type: "object", properties: { channel: { type: "string" }, accountId: { type: "string" }, externalConversationId: { type: "string" }, externalThreadId: { type: "string" } }, required: ["channel", "accountId", "externalConversationId"], additionalProperties: false }),
    permission: () => ({ id: "conversations.unbind-channel", effect: "system-write", resource: "conversations", network: false }),
    execute: async (input: Readonly<SystemJsonObject>) => service.removeChannelBinding({
      channel: text(input.channel, "channel", 64),
      accountId: text(input.accountId, "accountId", 256),
      externalConversationId: text(input.externalConversationId, "externalConversationId", 256),
      ...(input.externalThreadId === undefined ? {} : { externalThreadId: text(input.externalThreadId, "externalThreadId", 256) }),
    }),
  });
  ctx.effect(() => { loaded = false; state = emptyState(); });
});

export default conversationsPlugin;
export * from "./contract.js";
