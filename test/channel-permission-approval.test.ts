import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { AUDIT_TRUSTED_CAPABILITY } from "../plugins/audit/trusted-contract.js";
import { CHANNELS_TRUSTED_CAPABILITY, type ChannelsTrustedService } from "../plugins/channels/trusted-contract.js";
import { createPermissionsPlugin } from "../plugins/permissions/index.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { PERMISSIONS_TRUSTED_CAPABILITY } from "../plugins/permissions/trusted-contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
afterEach(async () => {
  uninstallCapabilityRegistry();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("channel-native permission approval", () => {
  it("asks the exact originating channel principal and resumes only after approval", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-approval-"));
    roots.push(stateDir);
    const approvals: Array<Record<string, unknown>> = [];
    const channels = {
      async requestApproval(request: Record<string, unknown>) {
        approvals.push(request);
        return true;
      },
    } as unknown as ChannelsTrustedService;

    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(definePlugin({ id: "test-audit", provides: [AUDIT_TRUSTED_CAPABILITY] }, (ctx) => {
      ctx.services.provide(AUDIT_TRUSTED_CAPABILITY, { append: () => ({}) as never });
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-channels", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
      ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, channels);
    }), { defer: true });
    await friday.activatePlugin(createPermissionsPlugin({ stateDir }), { defer: true });
    await friday.completePluginBootstrap();

    const trusted = requireCapability(PERMISSIONS_TRUSTED_CAPABILITY);
    trusted.runAsLocal(() => {
      trusted.trustChannelIdentity({ channel: "telegram", accountId: "main", senderId: "42", role: "operator" });
    });
    const permissions = requireCapability(PERMISSIONS_CAPABILITY);
    const decision = await trusted.runAsChannel({
      channel: "telegram",
      accountId: "main",
      senderId: "42",
      conversationId: "chat-77",
      threadId: "topic-3",
    }, () => permissions.authorize({
      mode: "ask",
      workspace: process.cwd(),
      access: "write",
      action: { id: "runtime.settings.update", effect: "system-write", resource: "runtime-settings", network: false },
      reason: "change routing model",
    }));

    expect(decision).toEqual({ allowed: true, approvedBy: "user" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      principal: { channel: "telegram", accountId: "main", senderId: "42", conversationId: "chat-77", threadId: "topic-3" },
      actionId: "runtime.settings.update",
      effect: "system-write",
      resource: "runtime-settings",
    });
  });

  it("requires originating-channel approval for an otherwise read-only action that requests network", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "friday-channel-network-approval-"));
    roots.push(stateDir);
    const approvals: Array<Record<string, unknown>> = [];
    const channels = {
      async requestApproval(request: Record<string, unknown>) {
        approvals.push(request);
        return true;
      },
    } as unknown as ChannelsTrustedService;

    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(definePlugin({ id: "test-audit", provides: [AUDIT_TRUSTED_CAPABILITY] }, (ctx) => {
      ctx.services.provide(AUDIT_TRUSTED_CAPABILITY, { append: () => ({}) as never });
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-channels", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
      ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, channels);
    }), { defer: true });
    await friday.activatePlugin(createPermissionsPlugin({ stateDir }), { defer: true });
    await friday.completePluginBootstrap();

    const trusted = requireCapability(PERMISSIONS_TRUSTED_CAPABILITY);
    trusted.runAsLocal(() => {
      trusted.trustChannelIdentity({ channel: "telegram", accountId: "main", senderId: "42", role: "operator" });
    });
    const permissions = requireCapability(PERMISSIONS_CAPABILITY);
    const decision = await trusted.runAsChannel({
      channel: "telegram",
      accountId: "main",
      senderId: "42",
      conversationId: "chat-network",
    }, () => permissions.authorize({
      mode: "full",
      workspace: process.cwd(),
      access: "read",
      action: { id: "web.fetch", effect: "workspace-read", resource: "https://example.test", network: true },
      reason: "fetch documentation",
    }));

    expect(decision).toEqual({ allowed: true, approvedBy: "user" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      principal: { channel: "telegram", accountId: "main", senderId: "42", conversationId: "chat-network" },
      actionId: "web.fetch",
      effect: "workspace-read",
      resource: "https://example.test",
      network: true,
    });
  });

});
