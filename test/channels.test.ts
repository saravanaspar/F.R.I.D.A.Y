import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { createVaultPlugin } from "../plugins/vault/index.js";
import { createChannelsPlugin } from "../plugins/channels/index.js";
import { readSavedChannels } from "../plugins/channels/config.js";
import { CHANNELS_CAPABILITY } from "../plugins/channels/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../plugins/channels/trusted-contract.js";
import { EVENTS_CAPABILITY } from "../plugins/events/contract.js";
import { ROUTING_CAPABILITY, type RoutingDecision, type RoutingMessage, type RoutingService } from "../plugins/routing/contract.js";
import { createEventsService } from "../plugins/events/events.js";
import sessionsPlugin from "../plugins/sessions/index.js";
import agentProfilesPlugin from "../plugins/agent-profiles/index.js";
import { AGENT_PROFILES_CAPABILITY } from "../plugins/agent-profiles/contract.js";
import conversationsPlugin from "../plugins/conversations/index.js";
import { SCHEDULED_ACTION_CONTRIBUTION } from "../plugins/scheduler/contract.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";
import { TURN_INGRESS_HOOK } from "../plugins/turn-loop/contract.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import { getPermissionsStateDir, loadTrustedIdentities } from "../plugins/permissions/identity-store.js";

const dirs: string[] = [];
const originalFridayHome = process.env.FRIDAY_HOME;

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "friday-channels-root-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  if (originalFridayHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalFridayHome;
  uninstallCapabilityRegistry();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function activate(turns?: InboundTurn[]) {
  const home = temp();
  process.env.FRIDAY_HOME = home;
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
    const events = createEventsService({ stateDir: join(home, "events") });
    ctx.services.provide(EVENTS_CAPABILITY, events);
    ctx.effect(() => events.close());
  }));
  if (turns) {
    await friday.activatePlugin(definePlugin({ id: "turn-ingress-test" }, (ctx) => {
      ctx.on(TURN_INGRESS_HOOK, (turn) => { turns.push(turn); });
    }));
  }
  await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }));
  await friday.activatePlugin(createChannelsPlugin({ autoStart: false }));
  return friday;
}

async function activateConversationAwareChannels(turns: InboundTurn[]) {
  const home = temp();
  process.env.FRIDAY_HOME = home;
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
    const events = createEventsService({ stateDir: join(home, "events") });
    ctx.services.provide(EVENTS_CAPABILITY, events);
    ctx.effect(() => events.close());
  }));
  await friday.activatePlugin(sessionsPlugin);
  await friday.activatePlugin(agentProfilesPlugin);
  await friday.activatePlugin(conversationsPlugin);
  await friday.activatePlugin(definePlugin({ id: "turn-ingress-test" }, (ctx) => {
    ctx.on(TURN_INGRESS_HOOK, (turn) => { turns.push(turn); });
  }));
  await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }));
  await friday.activatePlugin(createChannelsPlugin({ autoStart: false }));
  await friday.completePluginBootstrap();
  return friday;
}

function channelTurnForSystem(): InboundTurn {
  return {
    id: "system-channel-1",
    principal: {
      authority: "channel",
      channel: "telegram",
      accountId: "main",
      conversationId: "chat-1",
      senderId: "operator-1",
    },
    text: "configure telegram",
    timestamp: Date.now(),
    async reply() {},
  };
}

describe("channels plugin", () => {
  it("does not register a CLI channel or expose local conversational ingestion", async () => {
    await activate();
    const safe = requireCapability(CHANNELS_CAPABILITY);
    const trusted = requireCapability(CHANNELS_TRUSTED_CAPABILITY);
    expect(safe.list()).toEqual([]);
    expect(trusted).not.toHaveProperty("ingestLocal");
  });

  it("ignores pre-integration Telegram history but retries admitted post-integration work", async () => {
    const home = temp();
    process.env.FRIDAY_HOME = home;
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    let eventNow = new Date("2100-01-01T00:00:00.000Z");
    const events = createEventsService({ stateDir: join(home, "events"), now: () => eventNow });
    await friday.activatePlugin(definePlugin({ id: "test-events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(EVENTS_CAPABILITY, events);
      ctx.effect(() => events.close());
    }));

    const beforeIntegration = Date.now() - 60_000;
    const eventData = (id: string, text: string, timestamp: number) => ({
      id,
      principal: { channel: "telegram", accountId: "default", conversationId: "chat-1", senderId: "operator-1" },
      text,
      timestamp,
      attachments: [],
      chatType: "dm",
    });
    events.publish({
      id: "stale-before-integration",
      type: "channel.ingress.accepted",
      source: "channels",
      subject: "channel:telegram:default",
      occurredAt: new Date(beforeIntegration).toISOString(),
      data: eventData("telegram-old", "old prompt", beforeIntegration),
    });

    let failedOnce = false;
    const turns: string[] = [];
    await friday.activatePlugin(definePlugin({ id: "turn-ingress-integration-boundary-test" }, (ctx) => {
      ctx.on(TURN_INGRESS_HOOK, (turn) => {
        if (turn.text === "fail once" && !failedOnce) {
          failedOnce = true;
          throw new Error("simulated interactive turn failure");
        }
        turns.push(turn.text);
      });
    }));
    await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }));
    await friday.activatePlugin(createChannelsPlugin({
      autoStart: false,
      telegram: {
        credentialRef: "vault://channels/telegram/default/bot-token",
        allowedSenderIds: ["operator-1"],
      },
    }));

    const consumer = events.consumer("channels.turn-ingress.v1");
    expect(consumer?.retry.maxAttempts).toBe(3);
    await expect(events.runPending({ maxDeliveries: 10 })).resolves.toEqual([
      { consumerId: "channels.turn-ingress.v1", eventId: "stale-before-integration", status: "success" },
    ]);
    expect(turns).toEqual([]);

    const afterIntegration = Date.now() + 2_000;
    events.publish({
      id: "post-integration-failure",
      type: "channel.ingress.accepted",
      source: "channels",
      subject: "channel:telegram:default",
      occurredAt: new Date(afterIntegration).toISOString(),
      data: eventData("telegram-failed", "fail once", afterIntegration),
    });
    await expect(events.runPending({ maxDeliveries: 10 })).resolves.toEqual([
      expect.objectContaining({ consumerId: "channels.turn-ingress.v1", eventId: "post-integration-failure", status: "error" }),
    ]);
    expect(turns).toEqual([]);

    eventNow = new Date(eventNow.getTime() + 2_000);
    await expect(events.runPending({ maxDeliveries: 10 })).resolves.toEqual([
      { consumerId: "channels.turn-ingress.v1", eventId: "post-integration-failure", status: "success" },
    ]);
    expect(turns).toEqual(["fail once"]);
  });

  it("routes one same-conversation burst in one classifier batch and emits one aggregate Agent turn", async () => {
    const home = temp();
    process.env.FRIDAY_HOME = home;
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    const events = createEventsService({ stateDir: join(home, "events") });
    await friday.activatePlugin(definePlugin({ id: "test-events", provides: [EVENTS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(EVENTS_CAPABILITY, events);
      ctx.effect(() => events.close());
    }));
    const batches: string[][] = [];
    const routing: RoutingService = Object.freeze({
      async route(message: RoutingMessage): Promise<RoutingDecision> {
        return Object.freeze({
          messageId: message.id,
          destination: Object.freeze({ kind: "transient" as const, id: "transient:utility" }),
          execution: Object.freeze({ profile: "utility" as const, capabilityProfile: "none" as const }),
          confidence: 1,
        });
      },
      async routeBatch(messages: readonly RoutingMessage[]): Promise<readonly RoutingDecision[]> {
        batches.push(messages.map((message) => message.text));
        return Object.freeze(messages.map((message) => Object.freeze({
          messageId: message.id,
          destination: Object.freeze({ kind: "transient" as const, id: "transient:utility" }),
          execution: Object.freeze({ profile: "utility" as const, capabilityProfile: "none" as const }),
          confidence: 1,
        })));
      },
      subscribe() { return () => {}; },
      recentContext() { return Object.freeze([]); },
    });
    await friday.activatePlugin(definePlugin({ id: "test-routing", provides: [ROUTING_CAPABILITY] }, (ctx) => {
      ctx.services.provide(ROUTING_CAPABILITY, routing);
    }));
    const turns: InboundTurn[] = [];
    await friday.activatePlugin(definePlugin({ id: "turn-ingress-batch-test" }, (ctx) => {
      ctx.on(TURN_INGRESS_HOOK, (turn) => { turns.push(turn); });
    }));
    await friday.activatePlugin(createVaultPlugin({ stateDir: join(home, "vault"), workspaceRoot: process.cwd() }));
    await friday.activatePlugin(createChannelsPlugin({
      autoStart: false,
      telegram: {
        credentialRef: "vault://channels/telegram/default/bot-token",
        allowedSenderIds: ["operator-1"],
      },
    }));

    const base = Date.now() + 2_000;
    for (const [index, text] of ["hi", "what can you do?", "summarize our next step"].entries()) {
      events.publish({
        id: `burst-${index}`,
        type: "channel.ingress.accepted",
        source: "channels",
        subject: "channel:telegram:default",
        occurredAt: new Date(base + index).toISOString(),
        data: {
          id: `telegram-${index}`,
          principal: { channel: "telegram", accountId: "default", conversationId: "chat-1", senderId: "operator-1" },
          text,
          timestamp: base + index,
          attachments: [],
          chatType: "dm",
        },
      });
    }

    await events.runPending({ maxDeliveries: 10 });
    expect(batches).toEqual([["hi", "what can you do?", "summarize our next step"]]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain("hi");
    expect(turns[0]?.text).toContain("what can you do?");
    expect(turns[0]?.text).toContain("summarize our next step");
  });

  it("contributes a scheduled reminder whose destination is bound to the originating conversation", async () => {
    await activate();
    const reminder = collectContributions(SCHEDULED_ACTION_CONTRIBUTION)
      .find((action) => action.id === "channels.reminder");
    expect(reminder).toBeDefined();
    const payload = reminder!.prepare(
      { message: "Take a break" },
      {
        origin: {
          authority: "channel",
          channel: "telegram",
          accountId: "main",
          conversationId: "chat-42",
          senderId: "user-7",
          threadId: "thread-3",
        },
        requestText: "remind me to take a break",
        now: "2026-08-19T12:00:00.000Z",
        timezone: "Asia/Kolkata",
      },
    );
    expect(payload).toEqual({
      target: {
        channel: "telegram",
        accountId: "main",
        conversationId: "chat-42",
        threadId: "thread-3",
      },
      text: "Take a break",
    });
    expect(reminder!.permission?.(payload, {
      origin: {
        authority: "channel",
        channel: "telegram",
        accountId: "main",
        conversationId: "chat-42",
        senderId: "user-7",
        threadId: "thread-3",
      },
      requestText: "remind me to take a break",
      now: "2026-08-19T12:00:00.000Z",
      timezone: "Asia/Kolkata",
    })).toMatchObject({
      id: "channels.send.scheduled",
      effect: "external-write",
      resource: "channel:telegram:main:chat-42",
      network: true,
    });
  });
  it("keeps remote channel configuration non-secret and does not auto-trust configured senders", async () => {
    await activate();
    const configure = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "channels.configure");
    expect(configure).toBeDefined();
    await expect(configure!.execute({
      channelId: "telegram",
      allowedSenderIds: ["operator-1"],
      settings: { botToken: "must-not-be-stored-here" },
    }, { turn: channelTurnForSystem() } as never)).rejects.toThrow(/credential.*channels\.capture-credential/i);

    await expect(configure!.execute({
      channelId: "telegram",
      accountId: "main",
      allowedSenderIds: ["operator-1"],
      requireMention: true,
      settings: { pollingTimeoutMs: 30000 },
    }, { turn: channelTurnForSystem() } as never)).resolves.toMatchObject({ channelId: "telegram", enabled: true });
    const saved = await readSavedChannels();
    expect(saved.channels.telegram).toMatchObject({
      accountId: "main",
      allowedSenderIds: ["operator-1"],
      requireMention: true,
      settings: { pollingTimeoutMs: 30000 },
    });
    expect(JSON.stringify(saved.channels.telegram)).not.toContain("must-not-be-stored-here");
    expect(loadTrustedIdentities(getPermissionsStateDir(process.env))).toEqual([]);
  });

  it("enriches durable Telegram group ingress with shared Conversation and Agent Profile selection before Turn Loop", async () => {
    const turns: InboundTurn[] = [];
    await activateConversationAwareChannels(turns);
    const profiles = requireCapability(AGENT_PROFILES_CAPABILITY);
    await profiles.create({
      name: "Developer",
      description: "implementation code build",
      roleInstructions: "Implement and test code.",
    });

    const events = requireCapability(EVENTS_CAPABILITY);
    events.publish({
      id: "test-channel-ingress-telegram-group",
      type: "channel.ingress.accepted",
      source: "channels",
      subject: "channel:telegram:default",
      data: {
        id: "telegram-message-100",
        principal: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100123",
          senderId: "alice",
          threadId: "42",
        },
        text: "@Developer fix the login bug",
        timestamp: Date.now(),
        attachments: [],
        chatType: "group",
        senderName: "Alice",
        conversationName: "Engineering",
        replyToMessageId: "telegram-message-99",
      },
    });

    const deliveries = await events.runPending({ maxDeliveries: 20 });
    expect(deliveries.some((entry) => entry.consumerId === "channels.turn-ingress.v1" && entry.status === "success")).toBe(true);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "telegram-message-100",
      text: "fix the login bug",
      agentProfileId: "developer",
      principal: {
        authority: "channel",
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123",
        senderId: "alice",
        threadId: "42",
        agentProfileId: "developer",
      },
      channelContext: {
        chatType: "group",
        senderName: "Alice",
        conversationName: "Engineering",
        providerMessageId: "telegram-message-100",
        replyToMessageId: "telegram-message-99",
      },
    });
    expect(turns[0]?.principal.sharedConversationId).toBeTypeOf("string");
    expect(turns[0]?.sessionAffinityId).toBeTypeOf("string");
    expect(turns[0]?.channelContext?.internalConversationId).toBe(turns[0]?.principal.sharedConversationId);
    expect(turns[0]?.channelContext?.internalThreadId).toBeTypeOf("string");
  });

});
