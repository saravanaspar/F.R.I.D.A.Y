import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const FRIDAY_PRIVILEGED_HELPER = "/usr/local/libexec/friday-privileged";
const FRIDAY_SUDOERS_PREFIX = "/etc/sudoers.d/friday-";
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const POSIX_SYSTEM_PATHS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const PRIVILEGED_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "WINDIR",
] as const);

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

export function privilegedProcessEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PRIVILEGED_ENV_ALLOWLIST) {
    const value = environment[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.platform !== "win32") {
    const current = environment.PATH?.trim();
    env.PATH = [...new Set([...(current ? current.split(":") : []), ...POSIX_SYSTEM_PATHS].filter(Boolean))].join(":");
  }
  return env;
}

async function run(command: string, args: readonly string[], interactive: boolean): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      env: privilegedProcessEnv(),
    });
    let tail = "";
    if (!interactive && child.stdout && child.stderr) {
      const capture = (chunk: Buffer, target: NodeJS.WriteStream): void => {
        target.write(chunk);
        tail = `${tail}${String(chunk)}`.slice(-8_000);
      };
      child.stdout.on("data", (chunk: Buffer) => capture(chunk, process.stdout));
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, process.stderr));
    }
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) { resolveRun(); return; }
      rejectRun(new Error([
        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
        tail.trim() ? `Recent subprocess output:\n${tail.trim()}` : "",
      ].filter(Boolean).join("\n")));
    });
  });
}

function currentUser(): string {
  const username = userInfo().username;
  if (!SAFE_USER.test(username)) throw new Error(`Current username cannot be represented safely in sudoers: ${JSON.stringify(username)}`);
  return username;
}

export function fridaySudoersTarget(username: string): string {
  if (!SAFE_USER.test(username)) throw new Error(`Username cannot be represented safely in sudoers: ${JSON.stringify(username)}`);
  const digest = createHash("sha256").update(username, "utf8").digest("hex");
  return `${FRIDAY_SUDOERS_PREFIX}user-${digest}`;
}

function legacyFridaySudoersTarget(username: string): string | undefined {
  // @includedir skips filenames containing '.', so dotted usernames never had a valid legacy target.
  return username.includes(".") ? undefined : `${FRIDAY_SUDOERS_PREFIX}${username}`;
}

type BrokerFileMetadata = Pick<Stats, "mode" | "uid" | "gid" | "isFile" | "isSymbolicLink">;

export function privilegeBrokerMetadataIsSecure(helper: BrokerFileMetadata, sudoers: BrokerFileMetadata): boolean {
  const helperMode = helper.mode & 0o777;
  const sudoersMode = sudoers.mode & 0o777;
  return !helper.isSymbolicLink()
    && helper.isFile()
    && helper.uid === 0
    && helper.gid === 0
    && (helperMode & 0o100) !== 0
    && (helperMode & 0o022) === 0
    && !sudoers.isSymbolicLink()
    && sudoers.isFile()
    && sudoers.uid === 0
    && sudoers.gid === 0
    && sudoersMode === 0o440;
}

export async function hasFridayPrivilegedHelper(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const username = currentUser();
  const targets = [fridaySudoersTarget(username), legacyFridaySudoersTarget(username)].filter(
    (value): value is string => value !== undefined,
  );
  for (const sudoersTarget of targets) {
    try {
      const [helper, sudoers] = await Promise.all([lstat(FRIDAY_PRIVILEGED_HELPER), lstat(sudoersTarget)]);
      if (privilegeBrokerMetadataIsSecure(helper, sudoers)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function installFridayPrivilegeBroker(): Promise<void> {
  if (process.platform !== "linux") throw new Error("FRIDAY's privileged setup broker is currently supported on Linux hosts only");
  const username = currentUser();
  const scratch = await mkdtemp(join(tmpdir(), "friday-privileged-"));
  const helperSource = join(scratch, "friday-privileged");
  const sudoersSource = join(scratch, "sudoers");
  const sudoersTarget = fridaySudoersTarget(username);
  const sudoers = `${username} ALL=(root) NOPASSWD: ${FRIDAY_PRIVILEGED_HELPER} voice-deps\n`;
  try {
    await writeFile(helperSource, HELPER, { mode: 0o700 });
    await writeFile(sudoersSource, sudoers, { mode: 0o600 });
    await run("sudo", ["install", "-d", "-o", "root", "-g", "root", "-m", "0755", "/usr/local/libexec"], true);
    await run("sudo", ["install", "-o", "root", "-g", "root", "-m", "0755", helperSource, FRIDAY_PRIVILEGED_HELPER], true);
    await run("sudo", ["visudo", "-cf", sudoersSource], true);
    await run("sudo", ["install", "-o", "root", "-g", "root", "-m", "0440", sudoersSource, sudoersTarget], true);
    await run("sudo", ["visudo", "-cf", sudoersTarget], true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function installVoiceHostDependencies(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Automatic host voice dependency installation is currently supported on Linux only");
  if (!(await hasFridayPrivilegedHelper())) {
    throw new Error("FRIDAY privileged helper is not installed; run `friday setup privileges broker` locally first");
  }
  await run("sudo", ["-n", FRIDAY_PRIVILEGED_HELPER, "voice-deps"], false);
}
