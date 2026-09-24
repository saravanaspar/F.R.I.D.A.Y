import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupFridayUserService } from "../src/user-service-setup.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("binary-owned user-service setup", () => {
  it("installs the bundled user unit and enables it without needing a source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-service-setup-")); roots.push(root);
    const home = join(root, "home");
    const bundled = join(root, "bundle");
    await mkdir(join(bundled, "systemd"), { recursive: true });
    await writeFile(join(bundled, "systemd", "friday.service"), "[Service]\nExecStart=/usr/bin/env friday\n", "utf8");
    const calls: string[] = [];
    const target = await setupFridayUserService({
      environment: { HOME: home, FRIDAY_BUNDLED_ROOT: bundled },
      platform: "linux",
      run: async (command, args) => { calls.push(`${command} ${args.join(" ")}`); },
    });
    expect(target).toBe(join(home, ".config", "systemd", "user", "friday.service"));
    expect(await readFile(target, "utf8")).toContain("ExecStart=/usr/bin/env friday");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable friday.service",
      "systemctl --user restart friday.service",
    ]);
  });

  it("installs a startup script on windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "friday-service-setup-win-")); roots.push(root);
    const appData = join(root, "appdata");
    const target = await setupFridayUserService({
      environment: { APPDATA: appData },
      platform: "win32",
    });
    expect(target).toBe(join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "FRIDAY.cmd"));
    expect(await readFile(target, "utf8")).toContain("@echo off");
  });
});
