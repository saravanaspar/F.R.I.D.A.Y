import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { createVaultPlugin } from "../plugins/vault/index.js";
import { VAULT_CAPABILITY } from "../plugins/vault/contract.js";
import { VAULT_TRUSTED_CAPABILITY } from "../plugins/vault/trusted-contract.js";
import { createChannelsPlugin } from "../plugins/channels/index.js";
import { CHANNELS_CAPABILITY } from "../plugins/channels/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../plugins/channels/trusted-contract.js";
import { EVENTS_CAPABILITY } from "../plugins/events/contract.js";
import { createEventsService } from "../plugins/events/events.js";
import { SCHEDULED_ACTION_CONTRIBUTION } from "../plugins/scheduler/contract.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";
import { TURN_INGRESS_HOOK } from "../plugins/turn-loop/contract.js";

const dirs: string[] = [];

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "friday-channels-root-"));
  dirs.push(path);
  return path;
}

afterEach(() => {
  uninstallCapabilityRegistry();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function activate(turns?: InboundTurn[]) {
  const home = temp();
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

describe("channels plugin", () => {
  it("captures a credential before publication and never emits it into conversational ingress", async () => {
    const turns: InboundTurn[] = [];
    await activate(turns);
    const safe = requireCapability(CHANNELS_CAPABILITY);
    const channels = requireCapability(CHANNELS_TRUSTED_CAPABILITY);
    const vault = requireCapability(VAULT_CAPABILITY);
    const trustedVault = requireCapability(VAULT_TRUSTED_CAPABILITY);
    const observed: string[] = [];
    expect(Object.keys(safe).sort()).toEqual(["list", "subscribe"]);
    expect(safe).not.toHaveProperty("send");
    expect(safe.list()).toEqual([{ channel: "cli", accountId: "local", state: "stopped" }]);
    safe.subscribe((message) => { observed.push(message.text); });

    const ref = "vault://channels/telegram/default/bot-token";
    const sentinel = "CHANNEL_CAPTURE_SECRET_SENTINEL_7419";
    channels.requestCredentialCapture({
      principal: {
        channel: "cli",
        accountId: "local",
        conversationId: "terminal",
        senderId: "local-user",
      },
      ref,
      kind: "bot-token",
      mode: "create",
      label: "Telegram bot token",
    });

    const result = await channels.ingestLocal(sentinel);
    expect(result.classification).toBe("credential-captured");
    expect(result.text).toBe("[credential supplied for Telegram bot token]");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(observed)).not.toContain(sentinel);
    expect(turns).toEqual([]);
    expect(vault.exists(ref)).toBe(true);

    let consumed = "";
    await trustedVault.consume(ref, (secret) => { consumed = Buffer.from(secret).toString("utf8"); });
    expect(consumed).toBe(sentinel);
  });

  it("sanitizes ordinary inbound text and emits one generic local turn without knowing the Turn Loop", async () => {
    const turns: InboundTurn[] = [];
    await activate(turns);
    const safe = requireCapability(CHANNELS_CAPABILITY);
    const channels = requireCapability(CHANNELS_TRUSTED_CAPABILITY);
    const observed: string[] = [];
    safe.subscribe((message) => { observed.push(message.text); });

    const result = await channels.ingestLocal("use api_key=sk-supersecretvalue123456 for this");
    await requireCapability(EVENTS_CAPABILITY).runPending({ maxDeliveries: 10 });
    expect(result.classification).toBe("message");
    expect(result.text).toContain("api_key=[REDACTED]");
    expect(result.text).not.toContain("supersecretvalue123456");
    expect(observed).toEqual([result.text]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: result.id,
      text: result.text,
      principal: {
        authority: "local",
        channel: "cli",
        accountId: "local",
        conversationId: "terminal",
        senderId: "local-user",
      },
    });
    expect(typeof turns[0]?.reply).toBe("function");
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
});
