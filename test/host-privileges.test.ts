import { afterEach, describe, expect, it } from "vitest";
import { PluginTestHost } from "./helpers/plugin-host.js";
import capabilitiesPlugin from "../plugins/capabilities/index.js";
import { definePlugin, requireCapability, uninstallCapabilityRegistry } from "../plugins/capabilities/protocol.js";
import { HOST_PRIVILEGES_CAPABILITY } from "../plugins/host-privileges/contract.js";
import hostPrivilegesPlugin from "../plugins/host-privileges/index.js";
import { fridaySudoersTarget, privilegeBrokerMetadataIsSecure, privilegedProcessEnv } from "../plugins/host-privileges/privileged.js";
import { RUNTIME_SETTINGS_CAPABILITY, type RuntimeSettingsService } from "../plugins/runtime-settings/contract.js";

afterEach(() => uninstallCapabilityRegistry());

describe("host privilege boundary", () => {
  it("uses an includedir-safe deterministic sudoers filename even for dotted usernames", () => {
    const target = fridaySudoersTarget("john.smith");
    const filename = target.split("/").at(-1)!;
    expect(target.startsWith("/etc/sudoers.d/friday-user-")).toBe(true);
    expect(filename).not.toContain(".");
    expect(fridaySudoersTarget("john.smith")).toBe(target);
    expect(fridaySudoersTarget("john_smith")).not.toBe(target);
  });

  it("requires the installed broker to be root-owned, non-symlinked, and paired with a safe sudoers file", () => {
    const metadata = (options: { mode: number; uid?: number; gid?: number; symlink?: boolean; file?: boolean }) => ({
      mode: options.mode,
      uid: options.uid ?? 0,
      gid: options.gid ?? 0,
      isSymbolicLink: () => options.symlink ?? false,
      isFile: () => options.file ?? true,
    });
    const helper = metadata({ mode: 0o100755 });
    const sudoers = metadata({ mode: 0o100440 });
    expect(privilegeBrokerMetadataIsSecure(helper, sudoers)).toBe(true);
    expect(privilegeBrokerMetadataIsSecure(metadata({ mode: 0o100777 }), sudoers)).toBe(false);
    expect(privilegeBrokerMetadataIsSecure(metadata({ mode: 0o100755, uid: 1000 }), sudoers)).toBe(false);
    expect(privilegeBrokerMetadataIsSecure(metadata({ mode: 0o120755, symlink: true }), sudoers)).toBe(false);
    expect(privilegeBrokerMetadataIsSecure(helper, metadata({ mode: 0o100644 }))).toBe(false);
    expect(privilegeBrokerMetadataIsSecure(helper, metadata({ mode: 0o100440, gid: 1000 }))).toBe(false);
  });

  it("scrubs model/channel credentials before invoking privileged helper subprocesses", () => {
    const env = privilegedProcessEnv({
      PATH: "/custom/bin",
      HOME: "/home/test",
      HTTPS_PROXY: "http://proxy.example",
      OPENAI_API_KEY: "HOST_TOOLING_SECRET",
      FRIDAY_MODEL_PROVIDER: "openai",
      FRIDAY_CHANNEL_TOKEN: "CHANNEL_SECRET",
    });
    expect(env.PATH).toContain("/custom/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.FRIDAY_MODEL_PROVIDER).toBeUndefined();
    expect(env.FRIDAY_CHANNEL_TOKEN).toBeUndefined();
  });

  it("fails closed before sudo when the mandatory local policy is none", async () => {
    const friday = new PluginTestHost();
    await friday.activatePlugin(capabilitiesPlugin);
    const runtime: RuntimeSettingsService = {
      async read() {
        return { routingProvider: "openai", routingModelId: "router", permissionMode: "full", hostPrivilegeMode: "none", timezone: "UTC" };
      },
      async update() { throw new Error("not used"); },
      async onboarding() { return undefined; },
      async markOnboardingStep() { throw new Error("not used"); },
    };
    await friday.activatePlugin(definePlugin({ id: "test-runtime-settings", provides: [RUNTIME_SETTINGS_CAPABILITY] }, (ctx) => {
      ctx.services.provide(RUNTIME_SETTINGS_CAPABILITY, runtime);
    }));
    await friday.activatePlugin(hostPrivilegesPlugin);

    const hostPrivileges = requireCapability(HOST_PRIVILEGES_CAPABILITY);
    await expect(hostPrivileges.status()).resolves.toMatchObject({ privilegeMode: "none", ready: true });
    await expect(hostPrivileges.installApprovedVoiceDependencies()).rejects.toThrow(/disabled by the mandatory local host privilege policy/i);
  });
});
