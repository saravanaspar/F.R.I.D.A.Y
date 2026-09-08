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
import { createEventsService } from "../plugins/events/events.js";
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

});
