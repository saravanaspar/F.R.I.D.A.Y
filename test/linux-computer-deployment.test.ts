import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function stub(binDir: string, name: string, body = "exit 0\n"): Promise<void> {
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native Linux Computer deployment", () => {
  it("installs real X11 virtual-desktop control, selects the default Brave browser, and purges the retired hidden-compositor deployment", async () => {
    const root = await temp("friday-linux-x11-setup-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const systemctlLog = join(root, "systemctl.log");
    const desktopCount = join(root, "desktop-count");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(desktopCount, "1\n");

    await stub(bin, "systemctl", 'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n');
    await stub(bin, "curl");
    await stub(bin, "xdg-settings", 'printf "com.brave.Browser.desktop\\n"\n');
    await stub(bin, "brave-browser-stable");
    await stub(bin, "sleep");
    await stub(bin, "wmctrl", `if [ "$1" = "-n" ]; then printf "%s\\n" "$2" > "$DESKTOP_COUNT"; exit 0; fi\nif [ "$1" = "-d" ]; then count=$(cat "$DESKTOP_COUNT"); i=0; while [ "$i" -lt "$count" ]; do mark=-; [ "$i" -eq 0 ] && mark='*'; printf "%s %s DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop %s\\n" "$i" "$mark" "$((i + 1))"; i=$((i + 1)); done; exit 0; fi\nexit 1\n`);

    const result = await execFileAsync("sh", ["scripts/setup-linux-computer.sh", "native"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        FRIDAY_HOME: join(home, ".friday"),
        PATH: `${bin}:/usr/bin:/bin`,
        SYSTEMCTL_LOG: systemctlLog,
        DESKTOP_COUNT: desktopCount,
        XDG_SESSION_TYPE: "x11",
        XDG_CURRENT_DESKTOP: "KDE",
        DISPLAY: ":0",
        XAUTHORITY: join(home, ".Xauthority"),
        FRIDAY_COMPUTER_BROWSER_PROFILE_DIR: "",
        FRIDAY_COMPUTER_BROWSER_BIN: "",
        FRIDAY_CHROMIUM_BIN: "",
      },
    });

    expect(result.stdout).toContain("Native X11 Computer is installed and started.");
    expect(result.stdout).toContain("Retired hidden-compositor/viewer services and configs were removed");
    expect(result.stdout).toContain("Sign into the FRIDAY browser profile once");
    const environment = await readFile(join(home, ".config", "environment.d", "60-friday-computer.conf"), "utf8");
    expect(environment).toContain("FRIDAY_COMPUTER_PROVIDER=linux-x11");
    expect(environment).toContain("FRIDAY_COMPUTER_SESSION_MODE=native-x11");
    expect(environment).toContain("FRIDAY_COMPUTER_X11_AGENT_DESKTOPS=1");
    expect(environment).toContain("FRIDAY_COMPUTER_BROWSER_BIN=brave-browser-stable");
    expect(environment).toContain(`FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=${join(home, ".friday", "computer", "browser-profile")}`);

    const calls = await readFile(systemctlLog, "utf8");
    expect(calls).toContain("--user disable --now friday-computer-headless.service");
    expect(calls).toContain("--user enable --now friday-computer-browser.service");
    await expect(readFile(join(home, ".config", "systemd", "user", "friday-computer-headless.service"), "utf8")).rejects.toThrow();
  });

  it("smokes native X11 desktop discovery and waits for loopback CDP readiness", async () => {
    const root = await temp("friday-linux-x11-smoke-");
    const bin = join(root, "bin");
    const curlCountFile = join(root, "curl-count");
    await mkdir(bin, { recursive: true });
    await stub(bin, "systemctl", 'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "FRIDAY_COMPUTER_PROVIDER=linux-x11\\nFRIDAY_COMPUTER_X11_AGENT_DESKTOPS=1\\nFRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/\\nXDG_SESSION_TYPE=x11\\n"; fi\n');
    await stub(bin, "wmctrl", 'if [ "$1" = "-d" ]; then printf "0 * DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop 1\\n1 - DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 FRIDAY\\n"; exit 0; fi\nexit 1\n');
    await stub(bin, "sleep");
    await stub(bin, "curl", 'count=0\n[ -f "$CURL_COUNT_FILE" ] && count=$(cat "$CURL_COUNT_FILE")\ncount=$((count + 1))\nprintf "%s\\n" "$count" > "$CURL_COUNT_FILE"\n[ "$count" -lt 3 ] && exit 7\nprintf "{\\"Browser\\":\\"Brave\\"}\\n"\n');

    const result = await execFileAsync("sh", ["scripts/smoke-linux-computer.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        CURL_COUNT_FILE: curlCountFile,
        FRIDAY_COMPUTER_PROVIDER: "",
        FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "",
        FRIDAY_COMPUTER_CDP_URL: "",
        XDG_SESSION_TYPE: "",
        FRIDAY_COMPUTER_SMOKE_ATTEMPTS: "4",
      },
    });

    expect(result.stdout).toContain("PASS: native X11 virtual desktops and loopback browser CDP are healthy.");
    expect(result.stdout).toContain("AGENT_DESKTOPS=1");
    expect(result.stdout).toContain("PRESENTATION=native-x11");
    expect((await readFile(curlCountFile, "utf8")).trim()).toBe("3");
  });

  it("fails closed on Wayland instead of installing a hidden compositor fallback", async () => {
    const root = await temp("friday-linux-wayland-setup-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    for (const command of ["systemctl", "wmctrl", "curl", "xdg-settings"]) await stub(bin, command);

    await expect(execFileAsync("sh", ["scripts/setup-linux-computer.sh", "native"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
    })).rejects.toMatchObject({ stderr: expect.stringContaining("No hidden-compositor/viewer fallback will be installed") });
  });

  it("does not ship retired hidden-compositor/viewer runtime artifacts", async () => {
    const retired = [
      "deploy/systemd/friday-computer-headless.service",
      "deploy/sway/friday-headless.conf",
      "deploy/sway/friday.conf",
      "plugins/computer/providers/linux-shared-screen.ts",
      "plugins/computer/providers/linux-sway.ts",
      "test/computer-linux-shared-screen.test.ts",
      "test/computer-linux-sway.test.ts",
    ];
    for (const path of retired) await expect(readFile(path, "utf8")).rejects.toThrow();

    const providerIndex = await readFile("plugins/computer/providers/index.ts", "utf8");
    expect(providerIndex).not.toContain("linux-sway");
    expect(providerIndex).not.toContain("linux-shared-screen");
  });

  it("launches the persistent browser directly on X11 without a startup viewer window", async () => {
    const unit = await readFile("deploy/systemd/friday-computer-browser.service", "utf8");
    expect(unit).toContain("FRIDAY_COMPUTER_BROWSER_BIN");
    expect(unit).toContain("brave-browser-stable");
    expect(unit).toContain("google-chrome-stable");
    expect(unit).toContain("--ozone-platform=x11");
    expect(unit).toContain("--no-startup-window");
    expect(unit).toContain("--remote-debugging-address=127.0.0.1");
    expect(unit).not.toContain("--ozone-platform=wayland");
    expect(unit).not.toContain("about:blank'");
  });
});
