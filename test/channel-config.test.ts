import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChannelsConfigPath, readSavedChannels, updateSavedChannel } from "../plugins/channels/config.js";

const roots: string[] = [];
async function temp(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "friday-channel-config-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("saved channel configuration", () => {
  it("persists only non-secret settings and Vault references with private permissions", async () => {
    const home = await temp();
    await updateSavedChannel("telegram", {
      enabled: true,
      accountId: "main",
      allowedSenderIds: ["123"],
      settings: { pollTimeoutSeconds: 20 },
      secretRefs: { botToken: "vault://channels/telegram/main/bot-token" },
    }, home);
    const path = getChannelsConfigPath(home);
    expect((await stat(path)).mode & 0o077).toBe(0);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("vault://channels/telegram/main/bot-token");
    expect(raw).not.toMatch(/(?:TOKEN|PASSWORD|SECRET)\s*[:=]\s*["']?(?!vault:\/\/)/i);
    expect(await readSavedChannels(home)).toMatchObject({ channels: { telegram: { enabled: true, accountId: "main" } } });
  });

  it("rejects broad or symlinked channel configuration directories", async () => {
    const broadHome = await temp();
    await updateSavedChannel("telegram", { enabled: false }, broadHome);
    await chmod(join(broadHome, "channels"), 0o755);
    await expect(readSavedChannels(broadHome)).rejects.toThrow("channel config directory permissions are too broad");

    const targetHome = await temp();
    const linkedHome = await temp();
    await symlink(join(targetHome, "channels"), join(linkedHome, "channels"));
    await expect(readSavedChannels(linkedHome)).rejects.toThrow("channel config directory must be a private directory");
  });
});
