import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { collectContributions, definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import { MODEL_CREDENTIALS_CAPABILITY } from "../plugins/auth/contract.js";
import { CHANNELS_TRUSTED_CAPABILITY } from "../plugins/channels/trusted-contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { LIFECYCLE_CAPABILITY } from "../plugins/lifecycle/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { createPermissionsService } from "../plugins/permissions/policy.js";
import { createRuntimeSettingsPlugin } from "../plugins/runtime-settings/index.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../plugins/runtime-settings/contract.js";
import { readRuntimeSettings, saveRuntimeSettings, updateRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
import { initializeOnboardingState, updateOnboardingStep } from "../plugins/runtime-settings/onboarding-state.js";
import { SYSTEM_ACTION_CONTRIBUTION } from "../plugins/system/contract.js";
import { PluginTestHost } from "./helpers/plugin-host.js";

const roots: string[] = [];
afterEach(async () => {
  uninstallCapabilityRegistry();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assemble(
  home: string,
  launchReplacement: () => Promise<unknown>,
  stopPredecessor: () => void,
  retireReplacement: (requestId: string) => Promise<unknown> = async () => undefined,
  remote?: { readonly promptAnswers: string[]; readonly captures: string[] },
) {
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(sessionResourcesPlugin, { defer: true });
  await friday.activatePlugin(modelPlugin, { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-lifecycle", provides: [LIFECYCLE_CAPABILITY] }, (ctx) => {
    ctx.services.provide(LIFECYCLE_CAPABILITY, {
      createLifecycleManager: () => ({ launchReplacement, waitForTakeover: async () => undefined, retireReplacement }),
    } as never);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => {
    ctx.services.provide(PERMISSIONS_CAPABILITY, createPermissionsService({ approve: async () => true }));
  }), { defer: true });
  if (remote) {
    await friday.activatePlugin(definePlugin({ id: "test-channels-trusted", provides: [CHANNELS_TRUSTED_CAPABILITY] }, (ctx) => {
      ctx.services.provide(CHANNELS_TRUSTED_CAPABILITY, {
        requestPrompt: async () => {
          const value = remote.promptAnswers.shift();
          if (!value) throw new Error("unexpected onboarding prompt");
          return value;
        },
      } as never);
    }), { defer: true });
    await friday.activatePlugin(definePlugin({ id: "test-model-credentials", provides: [MODEL_CREDENTIALS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(MODEL_CREDENTIALS_CAPABILITY, {
        ref: (provider: string) => `vault://models/${provider}/api-key`,
        oauthRef: (provider: string) => `vault://models/${provider}/oauth`,
        has: () => false,
        hasOAuth: () => false,
        supportsOAuth: () => false,
        typicallyNeedsApiKey: () => true,
        getApiKey: async () => undefined,
        requestApiKeyCapture: async ({ provider }: { provider: string }) => { remote.captures.push(provider); return { id: "capture-1" }; },
        captureApiKey: async ({ provider }: { provider: string }) => { remote.captures.push(provider); return { id: "capture-1" }; },
        captureOAuth: async ({ provider }: { provider: string }) => { remote.captures.push(`oauth:${provider}`); return { id: "oauth-capture-1" }; },
      });
    }), { defer: true });
  }
  await friday.activatePlugin(createRuntimeSettingsPlugin({ home, stopPredecessor }), { defer: true });
  await friday.completePluginBootstrap();
  return friday;
}

describe("runtime settings", () => {


  it("persists router-only bootstrap settings without inventing a main model", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-router-only-")); roots.push(home);
    await saveRuntimeSettings({
      routingProvider: "openai",
      routingModelId: "gpt-router",
      permissionMode: "ask",
      hostPrivilegeMode: "none",
      timezone: "UTC",
    }, home);
    const settings = await readRuntimeSettings(home);
    expect(settings).toMatchObject({
      routingProvider: "openai",
      routingModelId: "gpt-router",
      permissionMode: "ask",
      hostPrivilegeMode: "none",
    });
    expect(settings?.modelProvider).toBeUndefined();
    expect(settings?.modelId).toBeUndefined();
    const persisted = await readFile(join(home, "runtime.env"), "utf8");
    expect(persisted).not.toContain("FRIDAY_MODEL_PROVIDER=");
    expect(persisted).toContain('FRIDAY_ROUTING_PROVIDER="openai"');
    expect(persisted).toContain('FRIDAY_HOST_PRIVILEGE_MODE="none"');
  });

  it("configures the optional main model interactively from a trusted channel with protected credential capture", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-remote-main-")); roots.push(home);
    const remote = { promptAnswers: [] as string[], captures: [] as string[] };
    await assemble(home, async () => ({ phase: "accepted", requestId: "unused" }), () => undefined, async () => undefined, remote);
    const model = requireCapability(MODEL_CAPABILITY);
    const provider = String(model.getProviders()[0]!);
    const descriptor = model.getModels(provider as never)[0]!;
    const modelId = String(descriptor.id);
    remote.promptAnswers.push(provider, modelId);
    await saveRuntimeSettings({
      routingProvider: provider,
      routingModelId: modelId,
      permissionMode: "ask",
      hostPrivilegeMode: "none",
      timezone: "UTC",
    }, home);
    await initializeOnboardingState("quick", home);
    for (const step of ["router", "operatorChannel", "privilegePolicy"] as const) await updateOnboardingStep(step, "complete", home);

    const action = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((entry) => entry.id === "onboarding.main-model.setup");
    expect(action).toBeDefined();
    const result = await action!.execute({ restart: false }, {
      turn: {
        id: "remote-main-1",
        text: "configure main model",
        timestamp: Date.now(),
        principal: { authority: "channel", channel: "telegram", accountId: "default", conversationId: "chat-1", senderId: "operator-1" },
        reply: async () => undefined,
      },
      deferAfterReply: () => undefined,
      deferOnFailure: () => undefined,
    } as never);

    expect(result).toMatchObject({ configured: true, restart: false, mainModel: { provider, modelId } });
    expect(remote.captures).toEqual([provider]);
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ modelProvider: provider, modelId });
    await expect(requireCapability(RUNTIME_SETTINGS_CAPABILITY).onboarding()).resolves.toMatchObject({ steps: { mainModel: "complete" } });
  });

  it("does not let a generic remote state edit falsely claim an optional setup step completed", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-onboarding-step-")); roots.push(home);
    await assemble(home, async () => ({ phase: "accepted", requestId: "unused" }), () => undefined);
    await initializeOnboardingState("quick", home);
    const action = collectContributions(SYSTEM_ACTION_CONTRIBUTION).find((entry) => entry.id === "onboarding.step");
    expect(action).toBeDefined();
    await expect(action!.execute({ step: "voice", status: "complete" }, {} as never))
      .rejects.toThrow("recorded only by the owning successful setup action");
    await expect(action!.execute({ step: "voice", status: "skipped" }, {} as never))
      .resolves.toMatchObject({ state: { steps: { voice: "skipped" } } });
    await expect(action!.execute({ step: "voice", status: "pending" }, {} as never))
      .resolves.toMatchObject({ state: { steps: { voice: "pending" } } });
  });

  it("upgrades legacy main-only runtime defaults by deriving the routing model and failing closed on host privilege", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-legacy-")); roots.push(home);
    await writeFile(join(home, "runtime.env"), [
      'FRIDAY_MODEL_PROVIDER="openai"',
      'FRIDAY_MODEL_ID="gpt-legacy"',
      'FRIDAY_PERMISSION_MODE="ask"',
      'FRIDAY_TIMEZONE="UTC"',
      '',
    ].join("\n"), { mode: 0o600 });
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({
      modelProvider: "openai",
      modelId: "gpt-legacy",
      routingProvider: "openai",
      routingModelId: "gpt-legacy",
      hostPrivilegeMode: "none",
    });
  });
  it("persists a dedicated workspace default outside FRIDAY state", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-settings-workspace-")); roots.push(home);
    await saveRuntimeSettings({
      modelProvider: "openai",
      modelId: "gpt-5",
      permissionMode: "ask",
      timezone: "UTC",
    }, home);
    const expectedWorkspace = join(dirname(home), "FRIDAY-workspace");
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ workspaceRoot: expectedWorkspace });
    const persisted = await readFile(join(home, "runtime.env"), "utf8");
    expect(persisted).toContain(`FRIDAY_WORKSPACE=${JSON.stringify(expectedWorkspace)}`);
  });
  it("keeps the predecessor alive until a successful change has been replied to", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-settings-")); roots.push(home);
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin, { defer: true });
    await friday.activatePlugin(modelPlugin, { defer: true });
    await friday.completePluginBootstrap();
    const model = requireCapability(MODEL_CAPABILITY);
    const provider = model.getProviders()[0]!;
    const descriptor = model.getModels(provider as never)[0]!;
    await friday.dispose();
    uninstallCapabilityRegistry();
    await saveRuntimeSettings({ modelProvider: String(descriptor.provider), modelId: String(descriptor.id), permissionMode: "ask", timezone: "UTC" }, home);

    let stops = 0;
    let finalizer: (() => void | Promise<void>) | undefined;
    let failureFinalizer: ((error: unknown) => void | Promise<void>) | undefined;
    await assemble(home, async () => ({ phase: "accepted", requestId: "restart-1" }), () => { stops += 1; });
    const service = requireCapability(RUNTIME_SETTINGS_CAPABILITY);
    await expect(service.update({ permissionMode: "auto" }, {
      afterReply: (callback) => { finalizer = callback; },
      onFailure: (callback) => { failureFinalizer = callback; },
    }))
      .resolves.toMatchObject({ permissionMode: "auto" });
    expect(stops).toBe(0);
    expect(finalizer).toBeTypeOf("function");
    expect(failureFinalizer).toBeTypeOf("function");
    await finalizer!();
    expect(stops).toBe(1);
  });

  it("restores the previous settings when the successor cannot start", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-settings-")); roots.push(home);
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin, { defer: true });
    await friday.activatePlugin(modelPlugin, { defer: true });
    await friday.completePluginBootstrap();
    const model = requireCapability(MODEL_CAPABILITY);
    const provider = model.getProviders()[0]!;
    const descriptor = model.getModels(provider as never)[0]!;
    await friday.dispose();
    uninstallCapabilityRegistry();
    await saveRuntimeSettings({ modelProvider: String(descriptor.provider), modelId: String(descriptor.id), permissionMode: "ask", timezone: "UTC" }, home);

    await assemble(home, async () => { throw new Error("successor failed"); }, () => undefined);
    const service = requireCapability(RUNTIME_SETTINGS_CAPABILITY);
    await expect(service.update({ permissionMode: "full" })).rejects.toThrow("successor failed");
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ permissionMode: "ask" });

    await Promise.all([
      service.update({ permissionMode: "auto" }, { restart: false }),
      service.update({ routingProvider: String(descriptor.provider), routingModelId: String(descriptor.id) }, { restart: false }),
    ]);
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({
      permissionMode: "auto",
      routingProvider: String(descriptor.provider),
      routingModelId: String(descriptor.id),
    });
  });

  it("persists and clears the canonical self-improvement source repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-settings-self-repository-")); roots.push(home);
    await saveRuntimeSettings({
      modelProvider: "test",
      modelId: "model",
      permissionMode: "ask",
      timezone: "UTC",
      selfRepository: "/srv/friday-source",
    }, home);
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ selfRepository: "/srv/friday-source" });

    await updateRuntimeSettings({ selfRepository: null }, home);
    const cleared = await readRuntimeSettings(home);
    expect(cleared?.selfRepository).toBeUndefined();
  });

  it("retires an accepted successor and restores settings when final delivery fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "friday-runtime-settings-")); roots.push(home);
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    await friday.activatePlugin(sessionResourcesPlugin, { defer: true });
    await friday.activatePlugin(modelPlugin, { defer: true });
    await friday.completePluginBootstrap();
    const model = requireCapability(MODEL_CAPABILITY);
    const provider = model.getProviders()[0]!;
    const descriptor = model.getModels(provider as never)[0]!;
    await friday.dispose();
    uninstallCapabilityRegistry();
    await saveRuntimeSettings({ modelProvider: String(descriptor.provider), modelId: String(descriptor.id), permissionMode: "ask", timezone: "UTC" }, home);

    const retired: string[] = [];
    let failureFinalizer: ((error: unknown) => void | Promise<void>) | undefined;
    let stops = 0;
    await assemble(
      home,
      async () => ({ phase: "accepted", requestId: "restart-failed-reply" }),
      () => { stops += 1; },
      async (requestId) => { retired.push(requestId); },
    );
    const service = requireCapability(RUNTIME_SETTINGS_CAPABILITY);
    await service.update({ permissionMode: "full" }, {
      afterReply: () => undefined,
      onFailure: (callback) => { failureFinalizer = callback; },
    });

    await failureFinalizer!(new Error("reply delivery failed"));

    expect(retired).toEqual(["restart-failed-reply"]);
    expect(stops).toBe(0);
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ permissionMode: "ask" });

    await expect(service.update({ permissionMode: "auto" })).rejects.toThrow("requires both success and failure handoff finalizers");
    expect(retired).toEqual(["restart-failed-reply", "restart-failed-reply"]);
    await expect(readRuntimeSettings(home)).resolves.toMatchObject({ permissionMode: "ask" });
  });
});
