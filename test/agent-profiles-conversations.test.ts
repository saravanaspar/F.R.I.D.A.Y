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
    expect(jobs.get(handoff.jobId!)).toBeDefined();
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
});
