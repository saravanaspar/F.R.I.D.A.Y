import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectComputerBrowser, setupComputer } from "../src/computer-setup.js";
import { readRuntimeSettings, saveRuntimeSettings } from "../plugins/runtime-settings/runtime-env.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function computerHome(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const home = join(root, "home");
  const fridayHome = join(home, ".friday");
  await mkdir(home, { recursive: true });
  await saveRuntimeSettings({
    routingProvider: "openai",
    routingModelId: "router",
    permissionMode: "ask",
    hostPrivilegeMode: "none",
    timezone: "UTC",
  }, fridayHome);
  return { root, home, fridayHome };
}

function desktopOutput(count: number, active = 0): string {
  return Array.from({ length: count }, (_, index) => `${index} ${index === active ? "*" : "-"} DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop ${index + 1}`).join("\n") + "\n";
}

describe("binary-owned Computer setup", () => {
  it("detects direct Brave and persists shared-profile window mode without a managed profile", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-setup-");
    let desktopCount = 1;
    const calls: string[] = [];
    const run = async (command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "xdg-settings") return "com.brave.Browser.desktop\n";
      if (command === "wmctrl" && args[0] === "-d") return desktopOutput(desktopCount);
      if (command === "wmctrl" && args[0] === "-n") { desktopCount = Number(args[1]); return ""; }
      if (command === "systemctl") return "";
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const required = new Set(["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable"]);
    const result = await setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, PATH: "/usr/bin:/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE" },
      platform: "linux",
      uid: 1000,
      run,
      commandAvailable: (command) => required.has(command),
      accessibilityAvailable: () => true,
    });

    expect(result).toMatchObject({
      provider: "linux-x11",
      sessionMode: "native-x11",
      browserMode: "shared",
      browserBin: "brave-browser-stable",
      agentScreens: 1,
      x11AgentDesktops: [1],
    });
    expect(result.browserProfileDir).toBeUndefined();
    expect(result.cdpUrl).toBeUndefined();
    await expect(readRuntimeSettings(fridayHome)).resolves.toMatchObject({ computer: result });
    const persisted = await readFile(join(fridayHome, "runtime.env"), "utf8");
    expect(persisted).toContain('FRIDAY_COMPUTER_BROWSER_MODE="shared"');
    expect(persisted).not.toContain("FRIDAY_COMPUTER_BROWSER_PROFILE_DIR");
    expect(calls).toContain("systemctl --user import-environment DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP");
    expect(calls).toContain("systemctl --user disable --now friday-computer-browser.service");
    expect(calls).not.toContain("systemctl --user enable --now friday-computer-browser.service");
  });

  it("migrates legacy desktop ownership while ignoring stale old browser/profile environment", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-migration-");
    await mkdir(join(home, ".config", "environment.d"), { recursive: true });
    await writeFile(join(home, ".config", "environment.d", "60-friday-computer.conf"), "FRIDAY_COMPUTER_PROVIDER=linux-sway\n", "utf8");
    let desktopCount = 3;
    const calls: string[] = [];
    const required = new Set(["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable", "chromium"]);
    const result = await setupComputer({
      environment: {
        HOME: home,
        FRIDAY_HOME: fridayHome,
        PATH: "/usr/bin:/bin",
        DISPLAY: ":0",
        XDG_SESSION_TYPE: "x11",
        XDG_CURRENT_DESKTOP: "KDE",
        FRIDAY_COMPUTER_PROVIDER: "linux-sway",
        FRIDAY_COMPUTER_BROWSER_MODE: "managed-cdp",
        FRIDAY_COMPUTER_BROWSER_BIN: "chromium",
        FRIDAY_COMPUTER_BROWSER_ARGS: '["--user-data-dir=/old-profile"]',
        FRIDAY_COMPUTER_AGENT_SCREENS: "2",
        FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "1,2",
        FRIDAY_CHROMIUM_BIN: "chromium",
      },
      platform: "linux",
      uid: 1000,
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xdg-settings") return "com.brave.Browser.desktop\n";
        if (command === "wmctrl" && args[0] === "-d") return desktopOutput(desktopCount);
        if (command === "wmctrl" && args[0] === "-n") { desktopCount = Number(args[1]); return ""; }
        if (command === "systemctl") return "";
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
      commandAvailable: (command) => required.has(command),
      accessibilityAvailable: () => true,
    });

    expect(result).toMatchObject({ browserMode: "shared", browserBin: "brave-browser-stable", agentScreens: 2, x11AgentDesktops: [1, 2] });
    expect(result.browserArgs).toBeUndefined();
    expect(calls.some((call) => call.startsWith("wmctrl -n "))).toBe(false);
    expect(calls.some((call) => call.startsWith("systemctl --user unset-environment "))).toBe(true);
    await expect(readFile(join(home, ".config", "environment.d", "60-friday-computer.conf"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds only missing Agent desktops when part of the persisted mapping is still valid", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-partial-desktops-");
    const current = await readRuntimeSettings(fridayHome);
    await saveRuntimeSettings({
      ...current!,
      computer: {
        provider: "linux-x11",
        sessionMode: "native-x11",
        browserMode: "shared",
        browserBin: "brave-browser-stable",
        agentScreens: 2,
        x11AgentDesktops: [1, 99],
      },
    }, fridayHome);
    let desktopCount = 3;
    const resizeTargets: number[] = [];
    const required = new Set(["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable"]);
    const result = await setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, PATH: "/usr/bin:/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      platform: "linux",
      uid: 1000,
      run: async (command, args) => {
        if (command === "xdg-settings") return "brave-browser.desktop\n";
        if (command === "wmctrl" && args[0] === "-d") return desktopOutput(desktopCount);
        if (command === "wmctrl" && args[0] === "-n") { desktopCount = Number(args[1]); resizeTargets.push(desktopCount); return ""; }
        if (command === "systemctl") return "";
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
      commandAvailable: (command) => required.has(command),
      accessibilityAvailable: () => true,
    });
    expect(resizeTargets).toEqual([4]);
    expect(result.x11AgentDesktops).toEqual([1, 3]);
  });

  it("honors a default Flatpak Brave browser even when another Chromium-family browser is installed", async () => {
    const available = new Set(["xdg-settings", "flatpak", "google-chrome-stable"]);
    const browser = await detectComputerBrowser({}, async (command, args) => {
      if (command === "xdg-settings") return "com.brave.Browser.desktop\n";
      if (command === "flatpak" && args.join(" ") === "info com.brave.Browser") return "Brave";
      throw new Error("not installed");
    }, (command) => available.has(command));
    expect(browser).toEqual({ bin: "flatpak", args: ["run", "com.brave.Browser"], label: "com.brave.Browser" });
  });

  it("detects the Snap-style Brave launcher exposed as `brave` on PATH", async () => {
    const browser = await detectComputerBrowser({}, async () => "", (command) => command === "brave");
    expect(browser).toEqual({ bin: "brave", args: [], label: "brave" });
  });

  it("fails closed when Computer dependencies are missing and privileged host operations were disabled", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-missing-");
    await expect(setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      platform: "linux",
      uid: 1000,
      commandAvailable: (command) => command === "python3",
      accessibilityAvailable: () => false,
      run: async () => "",
    })).rejects.toThrow(/Enable the restricted broker.*friday setup privileges broker/i);
  });

  it("uses the restricted broker to provision missing Computer host dependencies without a source-tree script", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-auto-deps-");
    const current = await readRuntimeSettings(fridayHome);
    await saveRuntimeSettings({ ...current!, hostPrivilegeMode: "broker" }, fridayHome);
    let installed = false;
    let brokerInstallations = 0;
    let dependencyInstallations = 0;
    let desktopCount = 1;
    const commandAvailable = (command: string) => installed
      ? ["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable"].includes(command)
      : command === "python3";
    await setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      platform: "linux",
      uid: 1000,
      commandAvailable,
      accessibilityAvailable: () => installed,
      hasPrivilegeHelper: async () => false,
      installPrivilegeBroker: async () => { brokerInstallations += 1; },
      installDependencies: async () => { dependencyInstallations += 1; installed = true; },
      run: async (command, args) => {
        if (command === "xdg-settings") return "com.brave.Browser.desktop\n";
        if (command === "wmctrl" && args[0] === "-d") return desktopOutput(desktopCount);
        if (command === "wmctrl" && args[0] === "-n") { desktopCount = Number(args[1]); return ""; }
        if (command === "systemctl") return "";
        throw new Error(`unexpected command ${command} ${args.join(" ")}`);
      },
    });
    expect(brokerInstallations).toBe(1);
    expect(dependencyInstallations).toBe(1);
  });

  it("installs and restarts the bundled managed-CDP fallback only when explicitly selected", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-managed-service-");
    let desktopCount = 1;
    const calls: string[] = [];
    const required = new Set(["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable"]);
    const result = await setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, PATH: "/usr/bin:/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      platform: "linux",
      uid: 1000,
      browserMode: "managed-cdp",
      commandAvailable: (command) => required.has(command),
      accessibilityAvailable: () => true,
      run: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xdg-settings") return "brave-browser.desktop\n";
        if (command === "wmctrl" && args[0] === "-d") return desktopOutput(desktopCount);
        if (command === "wmctrl" && args[0] === "-n") { desktopCount = Number(args[1]); return ""; }
        if (command === "systemctl") return "";
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(result).toMatchObject({ browserMode: "managed-cdp", cdpPort: 9222, browserProfileDir: join(fridayHome, "computer", "browser-profile") });
    expect(calls).toContain("systemctl --user enable friday-computer-browser.service");
    expect(calls).toContain("systemctl --user restart friday-computer-browser.service");
    expect(calls).not.toContain("systemctl --user enable --now friday-computer-browser.service");
    expect(await readFile(join(home, ".config", "systemd", "user", "friday-computer-browser.service"), "utf8")).toContain("computer-browser-supervisor");
  });

  it("preserves an explicitly persisted managed-CDP choice when setup is rerun without a mode argument", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-managed-rerun-");
    const current = await readRuntimeSettings(fridayHome);
    await saveRuntimeSettings({
      ...current!,
      computer: {
        provider: "linux-x11",
        sessionMode: "native-x11",
        browserMode: "managed-cdp",
        browserBin: "brave-browser-stable",
        agentScreens: 1,
        x11AgentDesktops: [1],
        cdpUrl: "http://127.0.0.1:9222/",
        cdpPort: 9222,
        browserProfileDir: join(fridayHome, "computer", "browser-profile"),
      },
    }, fridayHome);
    const required = new Set(["systemctl", "wmctrl", "xdotool", "xprop", "python3", "xdg-settings", "brave-browser-stable"]);
    const result = await setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, PATH: "/usr/bin:/bin", DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
      platform: "linux",
      uid: 1000,
      commandAvailable: (command) => required.has(command),
      accessibilityAvailable: () => true,
      run: async (command, args) => {
        if (command === "xdg-settings") return "brave-browser.desktop\n";
        if (command === "wmctrl" && args[0] === "-d") return desktopOutput(2);
        if (command === "systemctl") return "";
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(result.browserMode).toBe("managed-cdp");
  });

  it("fails closed on Wayland instead of installing another compositor/viewer stack", async () => {
    const { home, fridayHome } = await computerHome("friday-computer-wayland-");
    await expect(setupComputer({
      environment: { HOME: home, FRIDAY_HOME: fridayHome, DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" },
      platform: "linux",
      uid: 1000,
    })).rejects.toThrow(/requires an X11 desktop session/i);
  });
});
