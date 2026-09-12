import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

describe("Phase 5 Linux Computer deployment", () => {
  it("installs compatibility-mode user units with Ubuntu Chromium Snap-safe defaults", async () => {
    const root = await temp("friday-linux-computer-setup-");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const systemctlLog = join(root, "systemctl.log");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });

    await stub(bin, "systemctl", 'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n');
    await stub(bin, "sway");
    await stub(bin, "swaymsg");
    await stub(bin, "curl");
    await stub(bin, "chromium-browser");
    await stub(bin, "snap", 'if [ "$1" = "list" ] && [ "$2" = "chromium" ]; then exit 0; fi\nexit 1\n');

    const result = await execFileAsync("sh", ["scripts/setup-linux-computer.sh", "compatibility"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        FRIDAY_HOME: join(home, ".friday"),
        PATH: `${bin}:/usr/bin:/bin`,
        SYSTEMCTL_LOG: systemctlLog,
        FRIDAY_CHROMIUM_BIN: "chromium-browser",
      },
    });

    expect(result.stdout).toContain("compatibility mode is installed and started");
    const environment = await readFile(join(home, ".config", "environment.d", "60-friday-computer.conf"), "utf8");
    expect(environment).toContain("FRIDAY_COMPUTER_SESSION_MODE=compatibility");
    expect(environment).toContain("FRIDAY_CHROMIUM_BIN=chromium-browser");
    expect(environment).toContain(`FRIDAY_COMPUTER_BROWSER_PROFILE_DIR=${join(home, "snap", "chromium", "common", "friday-computer-profile")}`);
    expect(await readFile(join(home, ".config", "systemd", "user", "friday-computer-headless.service"), "utf8")).toContain("WLR_BACKENDS=headless");

    const calls = await readFile(systemctlLog, "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user set-environment");
    expect(calls).toContain("--user enable --now friday-computer-headless.service");
  });

  it("smokes the compatibility compositor through the systemd-published Sway socket and waits for CDP readiness", async () => {
    const root = await temp("friday-linux-computer-smoke-");
    const bin = join(root, "bin");
    const socketPath = join(root, "sway-ipc.test.sock");
    const curlCountFile = join(root, "curl-count");
    await mkdir(bin, { recursive: true });

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await stub(bin, "systemctl", 'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "SWAYSOCK=%s\\nFRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/\\n" "$SOCKET_PATH"; exit 0; fi\nexit 0\n');
      await stub(bin, "swaymsg", 'printf "[{\\"name\\":\\"HEADLESS-1\\",\\"active\\":true}]\\n"\n');
      await stub(bin, "sleep");
      await stub(bin, "curl", 'count=0\nif [ -f "$CURL_COUNT_FILE" ]; then count=$(cat "$CURL_COUNT_FILE"); fi\ncount=$((count + 1))\nprintf "%s\\n" "$count" > "$CURL_COUNT_FILE"\nif [ "$count" -lt 3 ]; then exit 7; fi\nprintf "{\\"Browser\\":\\"Chromium\\"}\\n"\n');

      const result = await execFileAsync("sh", ["scripts/smoke-linux-computer.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          SOCKET_PATH: socketPath,
          CURL_COUNT_FILE: curlCountFile,
          SWAYSOCK: "",
          FRIDAY_COMPUTER_SWAYSOCK: "",
          FRIDAY_COMPUTER_CDP_URL: "",
          FRIDAY_COMPUTER_SMOKE_ATTEMPTS: "4",
        },
      });

      expect(result.stdout).toContain("PASS: Sway Agent output and loopback Chromium CDP are healthy.");
      expect((await readFile(curlCountFile, "utf8")).trim()).toBe("3");
      expect(result.stdout).toContain(`SWAYSOCK=${socketPath}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recovers from a stale systemd-published Sway socket after a compositor restart", async () => {
    const root = await temp("friday-linux-computer-stale-socket-");
    const bin = join(root, "bin");
    const runtime = join(root, "runtime");
    const liveSocket = join(runtime, "sway-ipc.1000.2.sock");
    const staleSocket = join(runtime, "sway-ipc.1000.1.sock");
    await mkdir(bin, { recursive: true });
    await mkdir(runtime, { recursive: true });

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(liveSocket, resolve);
    });

    try {
      await stub(bin, "systemctl", `if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "SWAYSOCK=${staleSocket}\\nFRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/\\n"; exit 0; fi\nexit 0\n`);
      await stub(bin, "swaymsg", 'printf "[{\\"name\\":\\"HEADLESS-1\\",\\"active\\":true}]\\n"\n');
      await stub(bin, "curl", "exit 0\n");
      await stub(bin, "sleep");

      const result = await execFileAsync("sh", ["scripts/smoke-linux-computer.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          XDG_RUNTIME_DIR: runtime,
          SWAYSOCK: "",
          FRIDAY_COMPUTER_SWAYSOCK: "",
          FRIDAY_COMPUTER_CDP_URL: "",
          FRIDAY_COMPUTER_SMOKE_ATTEMPTS: "2",
        },
      });

      expect(result.stdout).toContain(`SWAYSOCK=${liveSocket}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when Chromium never reaches CDP readiness", async () => {
    const root = await temp("friday-linux-computer-cdp-timeout-");
    const bin = join(root, "bin");
    const socketPath = join(root, "sway-ipc.test.sock");
    await mkdir(bin, { recursive: true });

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await stub(bin, "systemctl", 'if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf "SWAYSOCK=%s\\nFRIDAY_COMPUTER_CDP_URL=http://127.0.0.1:9222/\\n" "$SOCKET_PATH"; exit 0; fi\nexit 0\n');
      await stub(bin, "swaymsg", 'printf "[{\\"name\\":\\"HEADLESS-1\\",\\"active\\":true}]\\n"\n');
      await stub(bin, "curl", "exit 7\n");
      await stub(bin, "sleep");

      await expect(execFileAsync("sh", ["scripts/smoke-linux-computer.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          SOCKET_PATH: socketPath,
          SWAYSOCK: "",
          FRIDAY_COMPUTER_SWAYSOCK: "",
          FRIDAY_COMPUTER_CDP_URL: "",
          FRIDAY_COMPUTER_SMOKE_ATTEMPTS: "3",
        },
      })).rejects.toMatchObject({
        stderr: expect.stringContaining("Chromium CDP did not become reachable"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the browser user unit launcher-agnostic and Snap-aware", async () => {
    const unit = await readFile("deploy/systemd/friday-computer-browser.service", "utf8");
    expect(unit).not.toContain("Environment=FRIDAY_CHROMIUM_BIN=chromium");
    expect(unit).toContain("chromium-browser");
    expect(unit).toContain("/snap/bin");
    expect(unit).toContain("snap list chromium");
    expect(unit).toContain("--remote-debugging-address=127.0.0.1");
    expect(unit).not.toContain("${path#/snap/bin/}");
  });

  it("keeps compatibility Sway isolated from the Human desktop Xwayland socket", async () => {
    const config = await readFile("deploy/sway/friday-headless.conf", "utf8");
    expect(config).toContain("xwayland disable");
    expect(config).toContain("output * bg #000000 solid_color");
  });
});
