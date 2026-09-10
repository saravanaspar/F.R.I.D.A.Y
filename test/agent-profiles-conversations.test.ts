import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import agentProfilesPlugin from "../plugins/agent-profiles/index.js";
import { AGENT_PROFILES_CAPABILITY } from "../plugins/agent-profiles/contract.js";
import conversationsPlugin from "../plugins/conversations/index.js";
import { CONVERSATIONS_CAPABILITY } from "../plugins/conversations/contract.js";
import { createEventsPlugin } from "../plugins/events/index.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import { createSessionJobsPlugin } from "../plugins/session-jobs/index.js";
import { SESSION_JOBS_CAPABILITY } from "../plugins/session-jobs/contract.js";
import { AGENT_PROMPT_SECTION_CONTRIBUTION } from "../plugins/turn-loop/contract.js";
import { CHANNEL_TURN_ENRICHER_CONTRIBUTION, type ChannelTurnIngressContext } from "../plugins/channels/contract.js";
import { collectContributions } from "../plugins/capabilities/protocol.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalStateDir = process.env.FRIDAY_STATE_DIR;

afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = originalStateDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function activate(stateDir: string): Promise<PluginTestHost> {
  process.env.FRIDAY_STATE_DIR = stateDir;
  const host = new PluginTestHost();
  await host.activatePlugin(capabilitiesPlugin);
  await host.activatePlugin(createEventsPlugin({ autoStartWorker: false }));
  await host.activatePlugin(sessionsPlugin);
  await host.activatePlugin(createSessionJobsPlugin({ home: stateDir }));
  await host.activatePlugin(agentProfilesPlugin);
  await host.activatePlugin(conversationsPlugin);
  await host.completePluginBootstrap();
  return host;
}



function channelContext(overrides: Partial<ChannelTurnIngressContext> = {}): ChannelTurnIngressContext {
  return {
    id: "telegram-message-1",
    principal: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-100123",
      senderId: "alice",
      threadId: "42",
    },
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    chatType: "group",
    senderName: "Alice",
    conversationName: "Engineering",
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("Phase 2 Agent Profiles and Conversations", () => {
  it("persists named profiles and isolates their declared memory scopes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-agent-profiles-"));
    roots.push(stateDir);
    let host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    const developer = await profiles.create({ name: "Developer", title: "Build teammate", roleInstructions: "Work on implementation tasks." });
    const research = await profiles.create({ name: "Research", memoryScope: "agent:research", roleInstructions: "Verify claims and sources." });
    expect(developer.id).toBe("developer");
    expect(developer.memoryScope).toBe("agent:developer");
    expect(research.memoryScope).toBe("agent:research");
    await host.dispose();

    host = await activate(stateDir);
    expect(requireCapability(AGENT_PROFILES_CAPABILITY).list().map((profile) => profile.id)).toEqual(["developer", "research"]);
    await host.dispose();
  });

  it("persists group metadata, collaboration state, and a Session Job handoff", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-conversations-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer" });
    await profiles.create({ name: "Research" });
    const conversations = requireCapability(CONVERSATIONS_CAPABILITY);
    const conversation = await conversations.create({
      id: "launch-room",
      type: "group",
      title: "Website Launch",
      sessionId: "session-launch",
      participants: [{ kind: "user", id: "operator" }, { kind: "agent", id: "developer" }, { kind: "agent", id: "research" }],
    });
    const thread = await conversations.createThread(conversation.id, "message-root");
    const repliedThread = await conversations.recordThreadReply(thread.id);
    const reaction = await conversations.addReaction("message-root", "operator", "✅");
    const read = await conversations.markRead(conversation.id, 12);
    expect(repliedThread.replyCount).toBe(1);
    expect(conversations.resolveMentions(conversation.id, "@Developer please ask @Research; @everyone should see this.")).toEqual({ agentIds: ["developer", "research"], includesEveryone: true });
    const jobs = requireCapability(SESSION_JOBS_CAPABILITY);
    const handoff = await conversations.createHandoff({ conversationId: conversation.id, fromAgentId: "developer", toAgentId: "research", text: "Verify the launch claims.", sessionId: conversation.sessionId }, {
      run: async () => ({ text: "Research queued", sessionId: conversation.sessionId }),
      notify: async () => undefined,
    });

    expect(thread.conversationId).toBe(conversation.id);
    expect(reaction.emoji).toBe("✅");
    expect(read.lastReadSequence).toBe(12);
    expect(handoff.jobId).toBeTypeOf("string");
    expect(jobs.get(handoff.jobId!)).toMatchObject({ agentProfileId: "research", destinationId: "session:session-launch" });
    await waitUntil(() => conversations.listHandoffs(conversation.id)[0]?.status === "completed", "handoff completion");
    expect(conversations.listHandoffs(conversation.id)).toHaveLength(1);
    expect(conversations.listThreads(conversation.id)).toHaveLength(1);
    expect(conversations.listReactions("message-root")).toHaveLength(1);
    await host.dispose();

    const reopened = await activate(stateDir);
    const restored = requireCapability(CONVERSATIONS_CAPABILITY).get(conversation.id);
    expect(restored).toMatchObject({ title: "Website Launch", lastReadSequence: 12, pinned: false, hidden: false });
    expect(requireCapability(CONVERSATIONS_CAPABILITY).listHandoffs(conversation.id)).toHaveLength(1);
    await reopened.dispose();
  });

  it("renders the selected persistent profile through the shared Turn Loop prompt seam", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-agent-profile-prompt-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer", title: "Build teammate", roleInstructions: "Prefer small tested changes." });
    const contribution = collectContributions(AGENT_PROMPT_SECTION_CONTRIBUTION).find((entry) => entry.id === "agent-profile-identity");
    expect(contribution?.render({
      cwd: stateDir,
      sessionId: "session-profile",
      agentProfileId: "developer",
      deferAfterReply() {},
      deferOnFailure() {},
    })).toContain("Prefer small tested changes.");
    await host.dispose();
  });

  it("binds channel topics to shared Conversations and keeps authorization identity per sender", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-conversation-"));
    roots.push(stateDir);
    let host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer", description: "implementation code build", roleInstructions: "Implement and test code." });
    await profiles.create({ name: "Research", description: "research sources verify", roleInstructions: "Verify evidence and sources." });
    const enricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context");
    expect(enricher).toBeDefined();

    const sticky = await enricher!.enrich(channelContext({ text: "/agent developer" }));
    expect(sticky).toMatchObject({ handled: true });
    expect(sticky?.replyText).toContain("sticky");

    const alice = await enricher!.enrich(channelContext({ id: "m-alice", text: "fix the login bug" }));
    expect(alice).toMatchObject({ agentProfileId: "developer" });
    expect(alice?.sharedConversationId).toBeTypeOf("string");
    expect(alice?.sessionAffinityId).toBeTypeOf("string");

    const bob = await enricher!.enrich(channelContext({
      id: "m-bob",
      principal: { channel: "telegram", accountId: "default", conversationId: "-100123", senderId: "bob", threadId: "42" },
      senderName: "Bob",
      text: "what did we change?",
    }));
    expect(bob).toMatchObject({
      agentProfileId: "developer",
      sharedConversationId: alice?.sharedConversationId,
      sessionAffinityId: alice?.sessionAffinityId,
    });

    const conversations = requireCapability(CONVERSATIONS_CAPABILITY);
    const shared = conversations.get(alice!.sharedConversationId!);
    expect(shared?.participants.filter((entry) => entry.kind === "user")).toHaveLength(2);
    expect(shared?.participants.some((entry) => entry.kind === "agent" && entry.id === "developer")).toBe(true);

    const otherTopic = await enricher!.enrich(channelContext({
      id: "m-other-topic",
      principal: { channel: "telegram", accountId: "default", conversationId: "-100123", senderId: "alice", threadId: "99" },
      text: "plain message",
    }));
    expect(otherTopic?.agentProfileId).toBeUndefined();
    expect(otherTopic?.sharedConversationId).toBeTypeOf("string");
    expect(otherTopic?.sharedConversationId).not.toBe(alice?.sharedConversationId);
    expect(otherTopic?.sessionAffinityId).not.toBe(alice?.sessionAffinityId);

    await host.dispose();
    host = await activate(stateDir);
    const restoredEnricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context");
    const restored = await restoredEnricher!.enrich(channelContext({ id: "m-restored", text: "continue" }));
    expect(restored).toMatchObject({
      agentProfileId: "developer",
      sharedConversationId: alice?.sharedConversationId,
      sessionAffinityId: alice?.sessionAffinityId,
    });
    await host.dispose();
  });

  it("supports explicit mentions, auto mode, @everyone fan-out, limits, and reply threads", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-agents-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer", description: "code implementation build", roleInstructions: "Implement software." });
    await profiles.create({ name: "Research", description: "research sources evidence", roleInstructions: "Research and verify sources." });
    await profiles.create({ name: "Writer", description: "writing editing prose", roleInstructions: "Write polished prose." });
    await profiles.create({ name: "Reviewer", description: "review quality tests", roleInstructions: "Review work." });
    const enricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context")!;

    const agents = await enricher.enrich(channelContext({ text: "/agents" }));
    expect(agents).toMatchObject({ handled: true });
    expect(agents?.replyText).toContain("@developer");
    expect(agents?.replyText).toContain("@research");

    expect(await enricher.enrich(channelContext({ text: "/agent auto" }))).toMatchObject({ handled: true });
    const explicit = await enricher.enrich(channelContext({ text: "@Research verify these sources" }));
    expect(explicit).toMatchObject({ agentProfileId: "research", text: "verify these sources" });

    const auto = await enricher.enrich(channelContext({ text: "please implement and build the code" }));
    expect(auto?.agentProfileId).toBe("developer");

    const everyone = await enricher.enrich(channelContext({ text: "@Developer @Research @Writer @Reviewer assess this", replyToMessageId: "provider-root-7" }));
    expect(everyone?.agentProfileId).toBe("developer");
    expect(everyone?.collaboratingAgents?.map((entry) => entry.id)).toEqual(["research", "writer", "reviewer"]);
    expect(everyone?.internalThreadId).toBeTypeOf("string");
    const conversations = requireCapability(CONVERSATIONS_CAPABILITY);
    expect(conversations.listThreads(everyone!.sharedConversationId!)[0]).toMatchObject({ rootMessageId: "provider-root-7", replyCount: 1 });

    const all = await enricher.enrich(channelContext({ text: "@everyone review this" }));
    expect(all?.agentProfileId).toBe("reviewer");
    expect(all?.collaboratingAgents).toHaveLength(3);

    await profiles.create({ name: "Planner", description: "planning roadmap", roleInstructions: "Plan work." });
    await enricher.enrich(channelContext({ text: "/agent auto" }));
    const tooMany = await enricher.enrich(channelContext({ text: "@Developer @Research @Writer @Reviewer @Planner assess this" }));
    expect(tooMany).toMatchObject({ handled: true });
    expect(tooMany?.replyText).toContain("fan-out limit is 4");

    const allTooMany = await enricher.enrich(channelContext({ text: "@everyone review this" }));
    expect(allTooMany).toMatchObject({ handled: true });
    expect(allTooMany?.replyText).toContain("fan-out limit is 4");

    await host.dispose();
  });

  it("auto-binds plain shared channel surfaces and shares continuity across senders", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-auto-group-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer" });
    await profiles.create({ name: "Research" });
    const enricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context")!;

    const alice = await enricher.enrich(channelContext({ id: "plain-alice", text: "hello team" }));
    const bob = await enricher.enrich(channelContext({
      id: "plain-bob",
      principal: { channel: "telegram", accountId: "default", conversationId: "-100123", senderId: "bob", threadId: "42" },
      senderName: "Bob",
      text: "what did Alice ask?",
    }));
    expect(alice?.agentProfileId).toBeUndefined();
    expect(bob?.agentProfileId).toBeUndefined();
    expect(bob?.sharedConversationId).toBe(alice?.sharedConversationId);
    expect(bob?.sessionAffinityId).toBe(alice?.sessionAffinityId);
    const conversation = requireCapability(CONVERSATIONS_CAPABILITY).get(alice!.sharedConversationId!);
    expect(conversation?.participants.filter((entry) => entry.kind === "user")).toHaveLength(2);
    expect(conversation?.participants.filter((entry) => entry.kind === "agent").map((entry) => entry.id).sort()).toEqual(["developer", "research"]);
    await host.dispose();
  });

  it("rejects Agent mentions outside a manually restricted Conversation until admitted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-agent-membership-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer" });
    await profiles.create({ name: "Research" });
    const conversations = requireCapability(CONVERSATIONS_CAPABILITY);
    const restricted = await conversations.create({
      id: "restricted-engineering",
      type: "group",
      title: "Restricted Engineering",
      sessionId: "restricted-engineering-session",
      participants: [{ kind: "agent", id: "developer" }],
    });
    await conversations.bindChannel({
      channel: "telegram", accountId: "default", externalConversationId: "-100123", externalThreadId: "42",
      conversationId: restricted.id, mode: "general",
    });
    const enricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context")!;

    const rejected = await enricher.enrich(channelContext({ text: "@Research check this" }));
    expect(rejected).toMatchObject({ handled: true });
    expect(rejected?.replyText).toContain("not a participant");

    const stickyRejected = await enricher.enrich(channelContext({ text: "/agent research" }));
    expect(stickyRejected).toMatchObject({ handled: true });
    expect(stickyRejected?.replyText).toContain("administratively bound");

    await conversations.ensureParticipant(restricted.id, { kind: "agent", id: "research" });
    const stickyAllowed = await enricher.enrich(channelContext({ text: "/agent research" }));
    expect(stickyAllowed).toMatchObject({ handled: true });
    expect(stickyAllowed?.replyText).toContain("sticky");
    const accepted = await enricher.enrich(channelContext({ text: "@Developer pair with @Research on this" }));
    expect(accepted?.agentProfileId).toBe("developer");
    expect(accepted?.collaboratingAgents?.map((entry) => entry.id)).toEqual(["research"]);
    await host.dispose();
  });

  it("inherits chat-level Agent defaults into isolated topic Conversations", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-topic-inheritance-"));
    roots.push(stateDir);
    const host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({ name: "Developer" });
    await profiles.create({ name: "Research" });
    const enricher = collectContributions(CHANNEL_TURN_ENRICHER_CONTRIBUTION).find((entry) => entry.id === "conversations.channel-context")!;

    const chatPrincipal = { channel: "telegram", accountId: "default", conversationId: "-100123", senderId: "alice" } as const;
    const topicPrincipal = { ...chatPrincipal, threadId: "777" } as const;
    const sticky = await enricher.enrich(channelContext({ principal: chatPrincipal, text: "/agent developer" }));
    expect(sticky).toMatchObject({ handled: true });

    const parent = await enricher.enrich(channelContext({ id: "parent-normal", principal: chatPrincipal, text: "hello from the parent chat" }));
    const topic = await enricher.enrich(channelContext({ id: "topic-normal", principal: topicPrincipal, text: "hello from the topic" }));
    expect(parent?.agentProfileId).toBe("developer");
    expect(topic?.agentProfileId).toBe("developer");
    expect(topic?.sharedConversationId).not.toBe(parent?.sharedConversationId);
    expect(topic?.sessionAffinityId).not.toBe(parent?.sessionAffinityId);

    const topicStatus = await enricher.enrich(channelContext({ principal: topicPrincipal, text: "/agent" }));
    expect(topicStatus?.replyText).toContain("sticky @developer");
    await host.dispose();
  });

  it("persists and validates all operational Agent Profile policy fields", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-agent-profile-policy-"));
    roots.push(stateDir);
    let host = await activate(stateDir);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    const developer = await profiles.create({
      name: "Developer",
      enabledSkills: ["typescript", "testing"],
      enabledPlugins: ["tools", "skills", "mcp"],
      defaultProjectId: "friday",
      defaultComputerScreen: "main",
      notificationPreference: "muted",
      approvalPolicy: "ask",
    });
    expect(developer).toMatchObject({
      enabledSkills: ["typescript", "testing"],
      enabledPlugins: ["tools", "skills", "mcp"],
      defaultProjectId: "friday",
      defaultComputerScreen: "main",
      notificationPreference: "muted",
      approvalPolicy: "ask",
    });
    await expect(profiles.create({ id: "bad-policy", name: "Bad Policy", approvalPolicy: "never" as never })).rejects.toThrow(/approvalPolicy/);
    await host.dispose();

    host = await activate(stateDir);
    expect(requireCapability(AGENT_PROFILES_CAPABILITY).get("developer")).toMatchObject({
      enabledSkills: ["typescript", "testing"],
      enabledPlugins: ["tools", "skills", "mcp"],
      defaultComputerScreen: "main",
      notificationPreference: "muted",
      approvalPolicy: "ask",
    });
    await host.dispose();
  });

});
