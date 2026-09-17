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
  it("keeps the source-tree shell helper as a thin compatibility wrapper around the installed binary setup", async () => {
    const script = await readFile("scripts/setup-linux-computer.sh", "utf8");
    expect(script).toContain('exec friday setup computer "$mode" "$screens"');
    expect(script).toContain('npm run --silent friday -- setup computer "$mode" "$screens"');
    expect(script).not.toContain("browser-profile");
    expect(script).not.toContain("environment.d");
    expect(script).not.toContain("cp deploy/systemd");
    expect(script).not.toContain("apt-get");
  });

  it("smokes native X11 desktop discovery and waits for loopback CDP readiness", async () => {
    const root = await temp("friday-linux-x11-smoke-");
    const bin = join(root, "bin");
    const curlCountFile = join(root, "curl-count");
    await mkdir(bin, { recursive: true });
    await stub(bin, "systemctl", 'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "FRIDAY_COMPUTER_PROVIDER=linux-x11\\nFRIDAY_COMPUTER_BROWSER_MODE=managed-cdp\\nFRIDAY_COMPUTER_X11_AGENT_DESKTOPS=1\\nFRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/\\nXDG_SESSION_TYPE=x11\\n"; fi\n');
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
    expect(result.stdout).toContain("BROWSER_MODE=managed-cdp");
    expect((await readFile(curlCountFile, "utf8")).trim()).toBe("3");
  });

  it("smokes shared-profile mode without requiring a CDP endpoint", async () => {
    const root = await temp("friday-linux-x11-shared-smoke-");
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await stub(bin, "systemctl", 'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "FRIDAY_COMPUTER_PROVIDER=linux-x11\\nFRIDAY_COMPUTER_BROWSER_MODE=shared\\nFRIDAY_COMPUTER_BROWSER_BIN=brave-browser-stable\\nFRIDAY_COMPUTER_X11_AGENT_DESKTOPS=1\\nXDG_SESSION_TYPE=x11\\n"; fi\n');
    await stub(bin, "wmctrl", 'if [ "$1" = "-d" ]; then printf "0 * DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 Desktop 1\\n1 - DG: 1920x1080 VP: 0,0 WA: 0,0 1920x1040 FRIDAY\\n"; exit 0; fi\nexit 1\n');
    await stub(bin, "xdotool");
    await stub(bin, "xprop");
    await stub(bin, "python3");
    await stub(bin, "brave-browser-stable");

    const result = await execFileAsync("sh", ["scripts/smoke-linux-computer.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        FRIDAY_COMPUTER_PROVIDER: "",
        FRIDAY_COMPUTER_BROWSER_MODE: "",
        FRIDAY_COMPUTER_BROWSER_BIN: "",
        FRIDAY_COMPUTER_X11_AGENT_DESKTOPS: "",
        XDG_SESSION_TYPE: "",
      },
    });

    expect(result.stdout).toContain("PASS: native X11 virtual desktops and shared browser prerequisites are healthy.");
    expect(result.stdout).toContain("BROWSER=brave-browser-stable");
    expect(result.stdout).toContain("BROWSER_MODE=shared");
    expect(result.stdout).not.toContain("CDP=");
  });

  it("does not route setup through any hidden-compositor or viewer fallback", async () => {
    const script = await readFile("scripts/setup-linux-computer.sh", "utf8");
    expect(script).not.toContain("sway");
    expect(script).not.toContain("wayvnc");
    expect(script).not.toContain("vnc");
    expect(script).not.toContain("headless");
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

  it("ships managed CDP only as an explicit binary-owned fallback service", async () => {
    const unit = await readFile("deploy/systemd/friday-computer-browser.service", "utf8");
    expect(unit).toContain("ExecStart=/usr/bin/env friday computer-browser-supervisor");
    expect(unit).not.toContain("FRIDAY_COMPUTER_BROWSER_BIN");
    expect(unit).not.toContain("--user-data-dir");
    expect(unit).not.toContain("brave-browser-stable");
    expect(unit).not.toContain("google-chrome-stable");

    const rootManifest = await readFile("friday.binary-assets.json", "utf8");
    expect(rootManifest).toContain("deploy/systemd/friday.service");
    expect(rootManifest).toContain("deploy/systemd/friday-computer-browser.service");
    const computerManifest = await readFile("plugins/computer/friday.binary-assets.json", "utf8");
    expect(computerManifest).toContain("runtime/atspi_browser.py");
  });
});
