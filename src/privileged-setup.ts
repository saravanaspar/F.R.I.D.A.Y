import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const FRIDAY_PRIVILEGED_HELPER = "/usr/local/libexec/friday-privileged";
const FRIDAY_SUDOERS_PREFIX = "/etc/sudoers.d/friday-";
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const HELPER = `#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "friday-privileged: exactly one approved operation is required" >&2
  exit 64
fi
case "\${1:-}" in
  voice-deps)
    if [ ! -e /etc/debian_version ]; then
      echo "friday-privileged: voice-deps currently supports Debian/Ubuntu hosts only" >&2
      exit 64
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    exec apt-get install -y --no-install-recommends build-essential cmake curl git ffmpeg python3 python3-venv ca-certificates
    ;;
  *)
    echo "friday-privileged: unsupported operation" >&2
    exit 64
    ;;
esac
`;

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: process.env });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`));
    });
  });
}

function currentUser(): string {
  const username = userInfo().username;
  if (!SAFE_USER.test(username)) throw new Error(`Current username cannot be represented safely in sudoers: ${JSON.stringify(username)}`);
  return username;
}

export async function hasFridayPrivilegedHelper(): Promise<boolean> {
  try {
    await access(FRIDAY_PRIVILEGED_HELPER, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installFridayPrivilegeBroker(): Promise<void> {
  if (process.platform !== "linux") throw new Error("FRIDAY's privileged setup broker is currently supported on Linux hosts only");
  const username = currentUser();
  const scratch = await mkdtemp(join(tmpdir(), "friday-privileged-"));
  const helperSource = join(scratch, "friday-privileged");
  const sudoersSource = join(scratch, "sudoers");
  const sudoersTarget = `${FRIDAY_SUDOERS_PREFIX}${username}`;
  const sudoers = `${username} ALL=(root) NOPASSWD: ${FRIDAY_PRIVILEGED_HELPER} voice-deps\n`;
  try {
    await writeFile(helperSource, HELPER, { mode: 0o700 });
    await writeFile(sudoersSource, sudoers, { mode: 0o600 });
    await run("sudo", ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", "/usr/local/libexec"]);
    await run("sudo", ["install", "-o", "root", "-g", "root", "-m", "0755", helperSource, FRIDAY_PRIVILEGED_HELPER]);
    await run("sudo", ["visudo", "-cf", sudoersSource]);
    await run("sudo", ["install", "-o", "root", "-g", "root", "-m", "0440", sudoersSource, sudoersTarget]);
    await run("sudo", ["visudo", "-cf", sudoersTarget]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function installVoiceHostDependencies(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Automatic host voice dependency installation is currently supported on Linux only");
  if (!(await hasFridayPrivilegedHelper())) {
    throw new Error("FRIDAY privileged helper is not installed; run `friday setup privileges` first");
  }
  await run("sudo", ["-n", FRIDAY_PRIVILEGED_HELPER, "voice-deps"]);
}
