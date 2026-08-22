import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import alertsPlugin from "../plugins/alerts/index.js";
import { ALERTS_CAPABILITY } from "../plugins/alerts/contract.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { CHANNELS_TRUSTED_CAPABILITY, type ChannelsTrustedService } from "../plugins/channels/trusted-contract.js";
import { EVENTS_CAPABILITY, type EventConsumerHandler, type EventsService } from "../plugins/events/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../plugins/permissions/trusted-contract.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import type { InboundTurn } from "../plugins/turn-loop/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
const originalHome = process.env.FRIDAY_HOME;
afterEach(async () => {
  uninstallCapabilityRegistry();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assemble() {
  const home = await mkdtemp(join(tmpdir(), "friday-alerts-home-")); roots.push(home); await chmod(home, 0o700); process.env.FRIDAY_HOME = home;
  let handler: EventConsumerHandler | undefined;
  const sent: string[] = [];
  const authorizations: unknown[] = [];
  const events = {
    registerConsumer(_input: unknown, next: EventConsumerHandler) { handler = next; return () => { handler = undefined; }; },
  } as unknown as EventsService;
  const channels = { async send(_target: unknown, text: string) { sent.push(text); } } as unknown as ChannelsTrustedService;
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(definePlugin({ id: "test-alert-channels", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, channels)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-alert-events", provides: [EVENTS_CAPABILITY] }, (ctx) => ctx.services.provide(EVENTS_CAPABILITY, events)), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-alert-permissions", provides: [PERMISSIONS_CAPABILITY, PERMISSIONS_TRUSTED_CAPABILITY] }, (ctx) => {
    ctx.services.provide(PERMISSIONS_CAPABILITY, { normalizeMode: () => "ask", async authorize(request: unknown) { authorizations.push(request); return { allowed: true, approvedBy: "user" }; }, assertWorkspacePath: (_w: string, p: string) => p } as never);
    ctx.services.provide(PERMISSIONS_TRUSTED_CAPABILITY, { runAsSystem: (_service: string, operation: () => unknown) => operation() } as never);
  }), { defer: true });
  await friday.activatePlugin(alertsPlugin, { defer: true });
  await friday.completePluginBootstrap();
  return { home, handler: () => handler!, sent, authorizations, service: requireCapability(ALERTS_CAPABILITY) };
}

function turn(replies: string[]): InboundTurn {
  return Object.freeze({
    id: "turn-1",
    principal: Object.freeze({ authority: "channel", channel: "telegram", accountId: "main", conversationId: "chat-9", senderId: "user-7" }),
    text: "alert me on audit failures",
    timestamp: Date.now(),
    reply: async (text: string) => { replies.push(text); },
  });
}

describe("Alerts", () => {
  it("binds subscriptions to the originating conversation and delivers metadata-only event alerts with cooldown", async () => {
    const { handler, sent, service } = await assemble();
    const subscribe = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "alerts.subscribe")!;
    const replies: string[] = [];
    await subscribe.execute({ type: "audit.integrity-failed", cooldownSeconds: 60 }, { turn: turn(replies), deferAfterReply: () => undefined });
    expect(replies[0]).toContain("Destination: this conversation");
    expect(service.rules()[0]?.target).toEqual({ channel: "telegram", accountId: "main", conversationId: "chat-9" });

    const event = {
      sequence: 1, id: "evt-1", type: "audit.integrity-failed", source: "audit", subject: "ledger", occurredAt: "2026-08-19T12:00:00.000Z", publishedAt: "2026-08-19T12:00:00.000Z",
      data: { secret: "MUST_NOT_LEAK" }, metadata: { private: "MUST_NOT_LEAK_EITHER" },
    } as const;
    await handler()({ consumer: {} as never, event: event as never, delivery: {} as never });
    await handler()({ consumer: {} as never, event: { ...event, id: "evt-2", sequence: 2 } as never, delivery: {} as never });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("audit.integrity-failed");
    expect(sent[0]).not.toContain("MUST_NOT_LEAK");
  });

  it("fails closed when its persisted state directory permissions become broad", async () => {
    const { home, service } = await assemble();
    const subscribe = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "alerts.subscribe")!;
    await subscribe.execute({ source: "routing" }, { turn: turn([]), deferAfterReply: () => undefined });
    await chmod(join(home, "alerts"), 0o755);
    await expect(service.remove(service.rules()[0]!.id)).rejects.toThrow("Alert state directory permissions are too broad");
  });

  it("serializes concurrent subscription mutations without dropping either rule", async () => {
    const { service } = await assemble();
    const subscribe = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((action) => action.id === "alerts.subscribe")!;
    await Promise.all([
      subscribe.execute({ type: "audit.first" }, { turn: turn([]), deferAfterReply: () => undefined }),
      subscribe.execute({ source: "routing.second" }, { turn: turn([]), deferAfterReply: () => undefined }),
    ]);

    expect(service.rules()).toHaveLength(2);
    expect(service.rules().map((rule) => rule.type ?? rule.source).sort()).toEqual(["audit.first", "routing.second"]);
  });
});
