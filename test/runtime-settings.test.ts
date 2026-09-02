import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import modelPlugin from "../plugins/model/index.js";
import { MODEL_CAPABILITY } from "../plugins/model/contract.js";
import sessionResourcesPlugin from "../plugins/session-resources/index.js";
import { LIFECYCLE_CAPABILITY } from "../plugins/lifecycle/contract.js";
import { PERMISSIONS_CAPABILITY } from "../plugins/permissions/contract.js";
import { createPermissionsService } from "../plugins/permissions/policy.js";
import { createRuntimeSettingsPlugin } from "../plugins/runtime-settings/index.js";
import { RUNTIME_SETTINGS_CAPABILITY } from "../plugins/runtime-settings/contract.js";
import { readRuntimeSettings, saveRuntimeSettings, updateRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";
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
) {
  const friday = new PluginTestHost();
  await friday.activatePlugin(capabilitiesPlugin);
  await friday.activatePlugin(sessionResourcesPlugin, { defer: true });
  await friday.activatePlugin(modelPlugin, { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-lifecycle", provides: [LIFECYCLE_CAPABILITY] }, (ctx) => {
    ctx.services.provide(LIFECYCLE_CAPABILITY, {
      api: {
        createLifecycleManager: () => ({ launchReplacement, waitForTakeover: async () => undefined, retireReplacement }),
      },
    } as never);
  }), { defer: true });
  await friday.activatePlugin(definePlugin({ id: "test-permissions", provides: [PERMISSIONS_CAPABILITY] }, (ctx) => {
    ctx.services.provide(PERMISSIONS_CAPABILITY, createPermissionsService({ approve: async () => true }));
  }), { defer: true });
  await friday.activatePlugin(createRuntimeSettingsPlugin({ home, stopPredecessor }), { defer: true });
  await friday.completePluginBootstrap();
  return friday;
}

describe("runtime settings", () => {

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
    const model = requireCapability(MODEL_CAPABILITY).api;
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
    const model = requireCapability(MODEL_CAPABILITY).api;
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
    const model = requireCapability(MODEL_CAPABILITY).api;
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
